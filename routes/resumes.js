const express = require('express');
const multer = require('multer');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const fsPromises = require('fs').promises; // Import fs.promises
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Import Gemini SDK

const router = express.Router();
const freeATSRouter = express.Router(); // New router for free ATS check
const prisma = new PrismaClient();

// Define uploads directory based on environment
const uploadsDir = process.env.NODE_ENV === 'production'
  ? path.join('/tmp', 'uploads')  // Use /tmp for Render's ephemeral storage
  : path.join(process.cwd(), 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  // Accept PDF, DOC, and DOCX files
  const allowedMimeTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
  
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PDF, DOC, and DOCX files are allowed.'), false);
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        details: 'Maximum file size is 5MB'
      });
    }
    return res.status(400).json({
      error: 'File upload error',
      details: err.message
    });
  }
  if (err) {
    console.error('File upload error:', err);
    return res.status(400).json({
      error: 'Invalid file',
      details: err.message
    });
  }
  next();
};

// Initialize Google Generative AI
if (!process.env.GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY environment variable not set. AI features will not work.');
}
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const geminiModel = genAI ? genAI.getGenerativeModel({ model: "gemini-2.0-flash" }) : null;

// Helper function to extract text from resume file
async function extractTextFromFile(filePath, mimeType) {
  try {
    if (mimeType === 'application/pdf') {
      const dataBuffer = await fsPromises.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    } else if (
      mimeType === 'application/msword' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } else {
      throw new Error('Unsupported file type for text extraction');
    }
  } catch (error) {
    console.error(`Error extracting text from ${filePath}:`, error);
    throw new Error(`Failed to extract text: ${error.message}`);
  }
}

// Helper function for Basic Rule-Based ATS Check
function performBasicAtsCheck(text) {
  let score = 0;
  const feedback = [];
  const MAX_SCORE = 100;

  // Normalize text for easier checking
  const lowerCaseText = text.toLowerCase();

  // 1. Check for Contact Information (Email & Phone) - 20 points
  const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/;
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
  let contactScore = 0;
  if (emailRegex.test(lowerCaseText)) {
    contactScore += 10;
    feedback.push({ type: 'positive', message: 'Email address found.' });
  } else {
    feedback.push({ type: 'negative', message: 'Consider adding a clear email address.' });
  }
  if (phoneRegex.test(text)) { // Use original text for phone to avoid issues with spaced numbers
    contactScore += 10;
    feedback.push({ type: 'positive', message: 'Phone number found.' });
  } else {
    feedback.push({ type: 'negative', message: 'Consider adding a clear phone number.' });
  }
  score += contactScore;

  // 2. Check for Common Section Headers - 40 points (10 each)
  const sections = ['experience', 'education', 'skills', 'summary']; // Common sections
  let sectionScore = 0;
  sections.forEach(section => {
    if (lowerCaseText.includes(section)) {
      sectionScore += 10;
      feedback.push({ type: 'positive', message: `Section found: ${section.charAt(0).toUpperCase() + section.slice(1)}.` });
    } else {
      feedback.push({ type: 'negative', message: `Consider adding a standard '${section.charAt(0).toUpperCase() + section.slice(1)}' section.` });
    }
  });
  score += sectionScore;

  // 3. Check for Action Verbs (simple check) - 20 points
  const actionVerbs = ['managed', 'developed', 'led', 'created', 'implemented', 'coordinated', 'analyzed', 'designed', 'achieved'];
  let actionVerbCount = 0;
  actionVerbs.forEach(verb => {
    if (lowerCaseText.includes(verb)) {
      actionVerbCount++;
    }
  });
  if (actionVerbCount >= 3) { // Require at least 3 different common verbs
    score += 20;
    feedback.push({ type: 'positive', message: 'Good use of action verbs detected.' });
  } else {
    feedback.push({ type: 'negative', message: 'Enhance descriptions with strong action verbs (e.g., Managed, Developed, Implemented).' });
  }

  // 4. Basic Formatting/Length Check (very rough) - 20 points
  const wordCount = text.split(/\s+/).length;
  if (wordCount > 200 && wordCount < 1500) { // Arbitrary range for typical resumes
     score += 10;
     feedback.push({ type: 'positive', message: 'Resume length seems reasonable.' });
  } else if (wordCount <= 200) {
     feedback.push({ type: 'negative', message: 'Resume seems short. Consider elaborating on experience or skills.' });
  } else {
     feedback.push({ type: 'negative', message: 'Resume seems long. Consider summarizing or being more concise.' });
  }
  // Simple check for excessive special characters (can indicate complex formatting)
  const specialChars = text.replace(/[a-zA-Z0-9\s.,@()-\/]/g, '').length;
  if (specialChars / text.length < 0.01) { // Less than 1% special chars
    score += 10;
    feedback.push({ type: 'positive', message: 'Simple formatting detected, generally good for ATS.' });
  } else {
    feedback.push({ type: 'negative', message: 'Potential complex formatting detected (e.g., excessive symbols, tables). Ensure ATS compatibility.' });
  }

  // Ensure score is within 0-100 range
  score = Math.max(0, Math.min(MAX_SCORE, Math.round(score)));

  // Sort feedback: positive first
  feedback.sort((a, b) => (a.type === 'positive' ? -1 : 1));

  return { score, feedback };
}

// Helper function to call Gemini for Detailed ATS Analysis
async function callGeminiForDetailedATS(resumeText) {
  if (!geminiModel) {
    throw new Error('Gemini AI model not initialized. Check API Key.');
  }

  const prompt = `
    Analyze the following resume text strictly for Applicant Tracking System (ATS) compatibility.
    Focus on structure, formatting, section clarity, and potential parsing issues.
    Do NOT evaluate the content quality, experience relevance, or suggest content changes.
    Provide feedback as a JSON object with two keys: "atsScore" (a number between 0 and 100, where 100 is perfectly ATS-compatible) and "feedback" (an array of objects, each with a "type" ['positive'|'negative'|'info'] and a "message" string explaining a specific ATS-related point, e.g., issues with columns, headers/footers, images, non-standard fonts, section clarity, date formatting, keyword presence).

    Resume Text:
    --- START ---
    ${resumeText}
    --- END ---

    JSON Output:
  `;

  try {
    console.log('Sending request to Gemini for Detailed ATS...');
    const result = await geminiModel.generateContent(prompt);
    const response = result.response;
    const jsonText = response.text()
                      .replace(/```json\n?/, '') // Remove markdown code block fences
                      .replace(/\n?```/, '')
                      .trim(); // Get the text content
    
    console.log('Received response from Gemini:', jsonText);
    // Attempt to parse the JSON response
    const analysis = JSON.parse(jsonText);
    
    // Basic validation of the returned structure
    if (typeof analysis.atsScore !== 'number' || !Array.isArray(analysis.feedback)) {
      throw new Error('Invalid JSON structure received from AI.');
    }
    
    return analysis; // Should contain { atsScore: number, feedback: array }

  } catch (error) {
    console.error('Error calling Gemini API or parsing response:', error);
    // Try to extract specific Gemini API error details if available
    const errorMessage = error.response?.text ? await error.response.text() : error.message;
    throw new Error(`Gemini API Error: ${errorMessage}`);
  }
}

// Helper function to call Gemini for Job-Specific Optimization Analysis
async function callGeminiForJobOptimization(resumeText, jobDescriptionText) {
  if (!geminiModel) {
    throw new Error('Gemini AI model not initialized. Check API Key.');
  }
  if (!jobDescriptionText || jobDescriptionText.trim() === '') {
    throw new Error('Job description text is required for optimization analysis.');
  }

  const prompt = `
    Analyze the following resume text in the context of the provided job description.
    
    Your goal is to help the user tailor their resume for this specific job.
    Provide feedback as a JSON object with three keys:
    1.  "optimizationScore": A number between 0 and 100 indicating how well the resume aligns with the job description keywords and requirements.
    2.  "keywordAnalysis": An object containing two arrays: "matchedKeywords" (keywords found in both resume and job description) and "missingKeywords" (important keywords from the job description not found in the resume).
    3.  "suggestions": An array of strings, providing specific, actionable recommendations for improving the resume content to better match the job description (e.g., "Highlight your experience with [specific skill mentioned in JD]", "Quantify achievements mentioned in the [relevant section] like in the job description").

    Resume Text:
    --- START RESUME ---
    ${resumeText}
    --- END RESUME ---

    Job Description Text:
    --- START JOB DESCRIPTION ---
    ${jobDescriptionText}
    --- END JOB DESCRIPTION ---

    JSON Output:
  `;

  try {
    console.log('Sending request to Gemini for Job Optimization...');
    const result = await geminiModel.generateContent(prompt);
    const response = result.response;
    const jsonText = response.text()
                      .replace(/```json\n?/, '') // Remove markdown code block fences
                      .replace(/\n?```/, '')
                      .trim();
    
    console.log('Received response from Gemini:', jsonText);
    const analysis = JSON.parse(jsonText);
    
    // Validate the structure
    if (typeof analysis.optimizationScore !== 'number' || 
        !analysis.keywordAnalysis || 
        !Array.isArray(analysis.keywordAnalysis.matchedKeywords) || 
        !Array.isArray(analysis.keywordAnalysis.missingKeywords) ||
        !Array.isArray(analysis.suggestions)) {
      console.error('Invalid JSON structure received from AI:', analysis);
      throw new Error('Invalid JSON structure received from AI.');
    }
    
    return analysis; // { optimizationScore, keywordAnalysis: { matchedKeywords, missingKeywords }, suggestions }

  } catch (error) {
    console.error('Error calling Gemini API or parsing response for Job Optimization:', error);
    const errorMessage = error.response?.text ? await error.response.text() : error.message;
    throw new Error(`Gemini API Error: ${errorMessage}`);
  }
}

// Upload resume route for authenticated users
router.post('/', upload.single('resume'), handleMulterError, async (req, res) => {
  const userId = req.user.id; // Use authenticated user ID
  let resumeRecord = null;
  try {
    // Removed plan, userId from body - use req.user.id
    const { jobInterest, description } = req.body; 

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Create initial resume entry
    resumeRecord = await prisma.resume.create({
      data: {
        userId: userId, // Link to authenticated user
        fileName: req.file.filename,
        originalFileName: req.file.originalname,
        // plan: plan, // Removed deprecated field
        jobInterest,
        description,
        status: 'basic_ats_pending', // Start with pending basic check
        type: 'paid' // Assuming uploads by logged-in users are main 'paid' type flow
      }
    });
    console.log(`Created initial resume entry for user ${userId}: ${resumeRecord.id}`);

    // --- Perform Basic ATS Check --- 
    let analysisResult = null;
    let finalResumeData = null;
    try {
      console.log(`Extracting text from: ${req.file.path}`);
      const resumeText = await extractTextFromFile(req.file.path, req.file.mimetype);
      console.log(`Text extracted successfully for resume: ${resumeRecord.id}, length: ${resumeText.length}`);
      
      console.log(`Performing basic ATS check for resume: ${resumeRecord.id}`);
      analysisResult = performBasicAtsCheck(resumeText);
      console.log(`Basic ATS check completed for resume: ${resumeRecord.id}, score: ${analysisResult.score}`);

      // Update resume record with results
      finalResumeData = await prisma.resume.update({
        where: { id: resumeRecord.id },
        data: {
          atsScore: analysisResult.score,
          feedback: analysisResult.feedback, // Prisma handles JSON serialization
          status: 'basic_ats_complete'
        }
      });
      console.log(`Updated resume record ${resumeRecord.id} with ATS results.`);
      
    } catch (analysisError) {
      console.error(`Error during initial ATS analysis for resume ${resumeRecord?.id}:`, analysisError);
      // Update status to failed if analysis couldn't run but keep the record
      finalResumeData = await prisma.resume.update({
        where: { id: resumeRecord.id },
        data: { status: 'basic_ats_failed' }
      });
      // Don't throw error here, return the record with failed status
      // Include basic info in response but indicate failure
       return res.status(201).json({ 
         ...finalResumeData, 
         analysisError: `Failed to perform initial ATS check: ${analysisError.message}` 
       });
    }
    // --- End Basic ATS Check --- 

    // Return the created and analyzed resume record
    res.status(201).json(finalResumeData);

  } catch (error) {
    console.error('Authenticated upload error:', error);
    // Attempt to clean up file if DB save failed but file exists
    if (!resumeRecord && req.file && req.file.path) {
      await fsPromises.unlink(req.file.path).catch(err => console.error('Error deleting orphaned file on upload error:', err));
    }
    res.status(500).json({ error: 'Error uploading resume' });
  }
});

// Free ATS check route with error handling
freeATSRouter.post('/', upload.single('resume'), handleMulterError, async (req, res) => {
  let resumeRecord = null; // Keep track of created record for cleanup/update
  try {
    console.log('Received free ATS check request:', {
      file: req.file ? {
        filename: req.file.filename,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      } : 'No file',
      email: req.body.email
    });

    const { email } = req.body;

    if (!req.file) {
      console.error('No file uploaded in request');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!email) {
      console.error('No email provided in request');
      // Clean up uploaded file if email is missing
      await fsPromises.unlink(req.file.path).catch(err => console.error('Error deleting orphaned file:', err));
      return res.status(400).json({ error: 'Email is required' });
    }

    // Create initial resume entry
    resumeRecord = await prisma.resume.create({
      data: {
        fileName: req.file.filename,
        originalFileName: req.file.originalname,
        email: email,
        type: 'free_ats_check',
        status: 'basic_ats_pending', // Initial status
        submittedAt: new Date()
        // Removed 'plan' as it's deprecated
      }
    });

    console.log('Created initial resume entry:', resumeRecord.id);

    // --- Perform Basic ATS Check --- 
    let analysisResult = null;
    try {
      console.log(`Extracting text from: ${req.file.path}`);
      const resumeText = await extractTextFromFile(req.file.path, req.file.mimetype);
      console.log(`Text extracted successfully for resume: ${resumeRecord.id}, length: ${resumeText.length}`);
      
      console.log(`Performing basic ATS check for resume: ${resumeRecord.id}`);
      analysisResult = performBasicAtsCheck(resumeText);
      console.log(`Basic ATS check completed for resume: ${resumeRecord.id}, score: ${analysisResult.score}`);

      // Update resume record with results
      const updatedResume = await prisma.resume.update({
        where: { id: resumeRecord.id },
        data: {
          atsScore: analysisResult.score,
          feedback: analysisResult.feedback, // Prisma handles JSON serialization
          status: 'basic_ats_complete'
        }
      });
      console.log(`Updated resume record ${resumeRecord.id} with ATS results.`);

      // Return results to user
      res.json({
        message: 'Basic ATS check completed.',
        resumeId: updatedResume.id,
        atsScore: updatedResume.atsScore,
        feedback: updatedResume.feedback // Return the feedback array
      });

    } catch (analysisError) {
      console.error(`Error during ATS analysis for resume ${resumeRecord?.id}:`, analysisError);
      // Update status to failed if analysis couldn't run
      if (resumeRecord) {
        await prisma.resume.update({
          where: { id: resumeRecord.id },
          data: { status: 'basic_ats_failed' }
        });
      }
      return res.status(500).json({ 
         error: 'Error processing resume for ATS check',
         details: analysisError.message 
      });
    }
    // --- End Basic ATS Check --- 

    // Optional: Clean up the uploaded file after successful processing
    // await fsPromises.unlink(req.file.path).catch(err => console.error('Error deleting processed file:', err));

  } catch (error) {
    console.error('Free ATS check route error:', error);
    // Attempt to clean up file if initial DB save failed but file exists
    if (!resumeRecord && req.file && req.file.path) {
      await fsPromises.unlink(req.file.path).catch(err => console.error('Error deleting orphaned file on route error:', err));
    }
    // Update status to failed if an error occurred after DB record creation but before analysis response
    else if (resumeRecord && !res.headersSent) { 
       try {
           await prisma.resume.update({
               where: { id: resumeRecord.id },
               data: { status: 'basic_ats_failed' } 
           });
       } catch (dbError) {
           console.error(`Failed to update resume status to failed for ${resumeRecord.id} after error:`, dbError);
       }
    }
    
    // Handle specific Prisma unique constraint error
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'A resume check request with this email might already be in progress or failed previously.' });
    }
    // Send generic error if headers haven't been sent yet
    if (!res.headersSent) {
        res.status(500).json({ 
            error: 'Error processing free ATS check request',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
  }
});

// Get user submissions route
router.get('/user/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    console.log('Fetching submissions for user:', userId);

    const submissions = await prisma.resume.findMany({
      where: { userId },
      orderBy: { submittedAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        originalFileName: true,
        optimizedResume: true,
        status: true,
        submittedAt: true,
        completedAt: true,
        feedback: true,
        plan: true,
        jobInterest: true,
        description: true,
        price: true,
        stripePaymentIntentId: true,
        paymentStatus: true,
        paymentAmount: true,
        user: {
          select: {
            email: true,
            name: true
          }
        }
      }
    });

    console.log('Found submissions:', submissions.length);
    console.log('Sample submission data:', JSON.stringify(submissions[0], null, 2));

    // Verify payment-related fields
    const paymentStats = submissions.map(s => ({
      id: s.id,
      paymentStatus: s.paymentStatus,
      paymentAmount: s.paymentAmount
    }));
    console.log('Payment stats:', paymentStats);

    res.json(submissions);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: 'Error fetching submissions' });
  }
});

// Download original resume route
router.get('/download-original/:id', async (req, res) => {
  try {
    const resumeId = parseInt(req.params.id);
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    const filePath = path.join(uploadsDir, resume.fileName);
    console.log('Attempting to download original file from:', filePath);
    
    if (!fs.existsSync(filePath)) {
      console.error('File not found at path:', filePath);
      return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath, resume.originalFileName);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Error downloading resume' });
  }
});

// Download optimized resume route
router.get('/download-optimized/:id', async (req, res) => {
  try {
    const resumeId = parseInt(req.params.id);
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId }
    });

    if (!resume || !resume.optimizedResume) {
      console.error('Resume or optimized file not found in database:', resumeId);
      return res.status(404).json({ 
        error: 'Optimized resume not found',
        details: 'The optimized version of this resume is not available'
      });
    }

    const filePath = path.join(uploadsDir, resume.optimizedResume);
    console.log('Attempting to download optimized file from:', filePath);
    
    if (!fs.existsSync(filePath)) {
      console.error('File not found at path:', filePath);
      // Update the resume record if file is missing
      await prisma.resume.update({
        where: { id: resumeId },
        data: {
          optimizedResume: null
        }
      });
      return res.status(404).json({ 
        error: 'File not found',
        details: 'The optimized resume file is no longer available'
      });
    }

    res.download(filePath, `optimized-${resume.originalFileName}`);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      error: 'Error downloading optimized resume',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

router.get('/reviews', async (req, res) => {
  const userId = req.user.id;

  try {
    const reviewOrders = await prisma.reviewOrder.findMany({
      where: { userId: userId },
      include: {
        resume: {
          select: { id: true, originalFileName: true }
        }
      },
      orderBy: {
        submittedDate: 'desc'
      }
    });

    res.json(reviewOrders);
  } catch (error) {
    console.error(`Error fetching review orders for user ${userId}:`, error);
    res.status(500).json({ 
      error: 'Error fetching review orders',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

// Get single resume route
router.get('/:id', async (req, res) => {
  try {
    const resumeId = parseInt(req.params.id);
    if (isNaN(resumeId)) {
      return res.status(400).json({ error: 'Invalid resume ID' });
    }

    const resume = await prisma.resume.findUnique({
      where: {
        id: resumeId
      },
      include: {
        user: true
      }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    res.json(resume);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ 
      error: 'Error fetching resume',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

// NEW: Detailed ATS Report Route (Premium/PPU)
router.post('/:resumeId/detailed-ats-report', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id; // From authenticateToken middleware
  let updatedResumeRecord = null;
  let usedPpuCredit = false;

  try {
    // 1. Fetch User and Resume, verify ownership
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' }); // Should not happen if token is valid
    }

    const resume = await prisma.resume.findUnique({ 
        where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }

    // 2. Authorization Check (Premium or PPU)
    if (user.subscriptionStatus !== 'premium' && user.ppuAtsCredits <= 0) {
        return res.status(403).json({ error: 'Forbidden: Premium subscription or Detailed ATS credit required.' });
    }

    // 3. Decrement PPU credit if necessary
    if (user.subscriptionStatus !== 'premium') {
        try {
           await prisma.user.update({
                where: { id: userId },
                data: { ppuAtsCredits: { decrement: 1 } }
           });
           usedPpuCredit = true;
           console.log(`Decremented PPU ATS credit for user ${userId}.`);
        } catch (error) {
            console.error(`Error processing PPU ATS credit for user ${userId}:`, error);
            return res.status(500).json({ error: 'Failed to process PPU credit.' });
        }
    }
    
    // Update resume status to indicate processing
    await prisma.resume.update({
        where: { id: resumeId },
        data: { status: 'detailed_ats_pending' }
    });

    // 4. Extract Text
    const filePath = path.join(uploadsDir, resume.fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error('Resume file not found on server.');
    }
    const fileMimeType = require('mime-types').lookup(resume.fileName) || 'application/octet-stream';
    const resumeText = await extractTextFromFile(filePath, fileMimeType);

    // 5. Call Gemini Service
    const analysisResult = await callGeminiForDetailedATS(resumeText);

    // 6. Update DB & Respond
    updatedResumeRecord = await prisma.resume.update({
      where: { id: resumeId },
      data: {
        atsScore: analysisResult.atsScore, // Overwrite basic score with detailed one
        feedback: analysisResult.feedback, // Store detailed feedback
        status: 'detailed_ats_complete',
        completedAt: new Date() 
      }
    });

    res.json({
      message: 'Detailed ATS analysis completed.',
      resumeId: updatedResumeRecord.id,
      atsScore: updatedResumeRecord.atsScore,
      feedback: updatedResumeRecord.feedback
    });

  } catch (error) {
    console.error(`Error processing detailed ATS report for resume ${resumeId}:`, error);
    
    // Rollback PPU credit if it was decremented but process failed later
    if (usedPpuCredit) {
        try {
            await prisma.user.update({
                where: { id: userId },
                data: { ppuAtsCredits: { increment: 1 } }
            });
            console.log(`Rolled back PPU ATS credit for user ${userId} due to error.`);
        } catch (rollbackError) {
            console.error(`CRITICAL: Failed to roll back PPU credit for user ${userId} after error:`, rollbackError);
            // Log this critical failure for manual intervention
        }
    }

    // Update resume status to failed
    try {
       if (resumeId) { // Check if resumeId was successfully parsed
           await prisma.resume.update({
              where: { id: resumeId },
              data: { status: 'detailed_ats_failed' }
           });
       }
    } catch (dbError) {
       console.error(`Failed to update resume status to failed for ${resumeId} after error:`, dbError);
    }

    res.status(500).json({ 
      error: 'Failed to generate detailed ATS report', 
      details: error.message || 'An unexpected error occurred.'
    });
  }
});

// NEW: Add/Update Job Description for a Resume
router.put('/:resumeId/job-description', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id; // From authenticateToken middleware
  const { jobDescription } = req.body;

  if (typeof jobDescription !== 'string' || jobDescription.trim() === '') {
    return res.status(400).json({ error: 'Job description text is required.' });
  }

  try {
    // 1. Fetch Resume and verify ownership
    const resume = await prisma.resume.findUnique({ 
        where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }

    // 2. Update the job description
    const updatedResume = await prisma.resume.update({
      where: { id: resumeId },
      data: { 
          jobDescription: jobDescription,
          // Reset optimization score/analysis when JD changes?
          // optimizationScore: null, 
          // keywordAnalysis: null,
          // Optionally update status if needed
      }
    });

    console.log(`Job description updated for resume ${resumeId}`);
    res.json({ 
        message: 'Job description updated successfully.',
        resumeId: updatedResume.id
    });

  } catch (error) {
    console.error(`Error updating job description for resume ${resumeId}:`, error);
    res.status(500).json({ 
      error: 'Failed to update job description', 
      details: error.message || 'An unexpected error occurred.'
    });
  }
});

// NEW: Job-Specific Optimization Route (Premium/PPU)
router.post('/:resumeId/job-optimization', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id; // From authenticateToken middleware
  let updatedResumeRecord = null;
  let usedPpuCredit = false;
  const PPU_CLICK_LIMIT = 5; // Define the click limit for PPU users

  try {
    // 1. Fetch User and Resume, verify ownership
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const resume = await prisma.resume.findUnique({ 
        where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }
    if (!resume.jobDescription) {
        return res.status(400).json({ error: 'Job description is required. Please add it first.' });
    }

    // 2. Authorization Check (Premium or PPU)
    if (user.subscriptionStatus !== 'premium' && user.ppuOptimizationCredits <= 0) {
        return res.status(403).json({ error: 'Forbidden: Premium subscription or Job Optimization credit required.' });
    }

    // 3. Decrement PPU credit & set click limit if necessary
    let ppuClicksRemaining = null;
    if (user.subscriptionStatus !== 'premium') {
        try {
           // Use transaction to ensure credit decrement and click limit setting are atomic
           await prisma.$transaction(async (tx) => {
                await tx.user.update({
                    where: { id: userId },
                    data: { ppuOptimizationCredits: { decrement: 1 } }
                });
                // Set the click limit on the resume record for this PPU session
                await tx.resume.update({
                    where: { id: resumeId },
                    data: { ppuOptimizationClicksRemaining: PPU_CLICK_LIMIT }
                });
           });
           usedPpuCredit = true;
           ppuClicksRemaining = PPU_CLICK_LIMIT; // Set for response
           console.log(`Decremented PPU Optimization credit for user ${userId}. Click limit set to ${PPU_CLICK_LIMIT} on resume ${resumeId}.`);
        } catch (error) {
            console.error(`Error processing PPU Optimization credit/click limit for user ${userId}:`, error);
            return res.status(500).json({ error: 'Failed to process PPU credit or set click limit.' });
        }
    } // If premium, ppuClicksRemaining remains null (unlimited)

    // Update resume status to indicate processing
    await prisma.resume.update({
        where: { id: resumeId },
        data: { status: 'job_opt_pending' }
    });

    // 4. Extract Text (Resume only, JD is already text)
    const filePath = path.join(uploadsDir, resume.fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error('Resume file not found on server.');
    }
    const fileMimeType = require('mime-types').lookup(resume.fileName) || 'application/octet-stream';
    const resumeText = await extractTextFromFile(filePath, fileMimeType);

    // 5. Call Gemini Service
    const analysisResult = await callGeminiForJobOptimization(resumeText, resume.jobDescription);

    // 6. Update DB & Respond
    updatedResumeRecord = await prisma.resume.update({
      where: { id: resumeId },
      data: {
        optimizationScore: analysisResult.optimizationScore,
        keywordAnalysis: analysisResult.keywordAnalysis, // Store keyword analysis object
        feedback: analysisResult.suggestions, // Store suggestions in feedback field (or create a new field? Using feedback for now)
        status: 'job_opt_complete',
        completedAt: new Date()
        // Note: ppuOptimizationClicksRemaining was set earlier if PPU
      }
    });

    res.json({
      message: 'Job-specific optimization analysis completed.',
      resumeId: updatedResumeRecord.id,
      optimizationScore: updatedResumeRecord.optimizationScore,
      keywordAnalysis: updatedResumeRecord.keywordAnalysis,
      suggestions: updatedResumeRecord.feedback, // Assuming suggestions are stored in feedback
      ppuClicksRemaining: ppuClicksRemaining // Let frontend know clicks remaining if PPU
    });

  } catch (error) {
    console.error(`Error processing job optimization for resume ${resumeId}:`, error);
    
    // Rollback PPU credit if it was decremented but process failed
    // Note: Click limit on resume doesn't need rollback as a new purchase would reset it.
    if (usedPpuCredit) {
        try {
            await prisma.user.update({
                where: { id: userId },
                data: { ppuOptimizationCredits: { increment: 1 } }
            });
            console.log(`Rolled back PPU Optimization credit for user ${userId} due to error.`);
        } catch (rollbackError) {
            console.error(`CRITICAL: Failed to roll back PPU Optimization credit for user ${userId} after error:`, rollbackError);
        }
    }

    // Update resume status to failed
    try {
       if (resumeId) {
           await prisma.resume.update({
              where: { id: resumeId },
              data: { status: 'job_opt_failed' }
           });
       }
    } catch (dbError) {
       console.error(`Failed to update resume status to failed for ${resumeId} after error:`, dbError);
    }

    res.status(500).json({ 
      error: 'Failed to generate job optimization report', 
      details: error.message || 'An unexpected error occurred.'
    });
  }
});

// NEW: Analyze Changes from Editor (Premium/PPU with click limit)
router.post('/:resumeId/analyze-changes', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id; 
  const { editedResumeText } = req.body;
  let newClicksRemaining = null;

  if (typeof editedResumeText !== 'string') {
    return res.status(400).json({ error: 'Edited resume text is required.' });
  }

  try {
    // 1. Fetch User and Resume, verify ownership
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let resume = await prisma.resume.findUnique({ 
        where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }
    
    // This analysis is primarily for Job Optimization context
    if (!resume.jobDescription) {
        return res.status(400).json({ error: 'Cannot analyze changes: No job description associated with this resume for optimization.' });
    }

    // 2. Authorization & PPU Click Handling
    if (user.subscriptionStatus !== 'premium') {
        if (resume.ppuOptimizationClicksRemaining === null || resume.ppuOptimizationClicksRemaining <= 0) {
            return res.status(403).json({ 
                error: 'Forbidden: No PPU analysis clicks remaining for this optimization session.',
                ppuClicksRemaining: 0 
            });
        }
        
        // Decrement click count
        try {
            resume = await prisma.resume.update({
                where: { id: resumeId },
                data: { ppuOptimizationClicksRemaining: { decrement: 1 } }
            });
            newClicksRemaining = resume.ppuOptimizationClicksRemaining;
            console.log(`Decremented PPU analysis click for resume ${resumeId}. Remaining: ${newClicksRemaining}`);
        } catch (error) {
            console.error(`Error decrementing PPU click count for resume ${resumeId}:`, error);
            return res.status(500).json({ error: 'Failed to update PPU click count.' });
        }
    } // Premium users have unlimited clicks (newClicksRemaining stays null)

    // 3. Call Gemini Service for Job Optimization with *edited* text
    // Use the existing helper function, providing the new text
    const analysisResult = await callGeminiForJobOptimization(editedResumeText, resume.jobDescription);

    // 4. Respond with *new* analysis results
    // We don't update the main DB record fields here, just return the result for the editor UI
    res.json({
      message: 'Analysis of changes completed.',
      resumeId: resume.id,
      optimizationScore: analysisResult.optimizationScore,
      keywordAnalysis: analysisResult.keywordAnalysis,
      suggestions: analysisResult.suggestions,
      ppuClicksRemaining: newClicksRemaining // Send back updated count if PPU
    });

  } catch (error) {
    console.error(`Error analyzing changes for resume ${resumeId}:`, error);
    // Note: No PPU credit rollback needed here as we only decrement the click counter on the resume
    res.status(500).json({ 
      error: 'Failed to analyze changes', 
      details: error.message || 'An unexpected error occurred.'
    });
  }
});

// NEW: Download Optimized Resume Route (for users)
router.get('/:resumeId/download-optimized', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id;

  try {
    // Fetch resume and verify ownership
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }

    // Check if optimized file exists
    if (!resume.optimizedResume) {
      return res.status(404).json({ 
        error: 'Optimized resume not found',
        details: 'An optimized version of this resume is not available for download.'
      });
    }

    // Construct path and check existence
    const filePath = path.join(uploadsDir, resume.optimizedResume);
    if (!fs.existsSync(filePath)) {
      console.error(`Optimized file missing from disk: ${filePath} for resume ${resumeId}`);
      // Optionally update DB to clear the optimizedResume field if file is confirmed missing
      await prisma.resume.update({
          where: { id: resumeId },
          data: { optimizedResume: null }
      }).catch(err => console.error(`Failed to clear missing optimized file field for resume ${resumeId}`, err));
      
      return res.status(404).json({ 
        error: 'File not found',
        details: 'The optimized resume file is no longer available.'
      });
    }
    
    // Send the file
    // Try to determine a good download filename (e.g., optimized-originalName.pdf)
    const originalExt = path.extname(resume.originalFileName);
    const downloadName = `optimized-${path.basename(resume.originalFileName, originalExt)}${originalExt}`;

    console.log(`User ${userId} downloading optimized file: ${filePath} as ${downloadName}`);
    res.download(filePath, downloadName);

  } catch (error) {
    console.error(`Error downloading optimized resume ${resumeId} for user ${userId}:`, error);
    res.status(500).json({ 
      error: 'Error downloading optimized resume',
      details: error.message || 'An unexpected error occurred.'
    });
  }
});

// NEW: Get User's Review Orders
router.get('/reviews', async (req, res) => {
  const userId = req.user.id;

  try {
    const reviewOrders = await prisma.reviewOrder.findMany({
      where: { userId: userId },
      include: {
        resume: {
          select: { id: true, originalFileName: true }
        }
      },
      orderBy: {
        submittedDate: 'desc'
      }
    });

    res.json(reviewOrders);

  } catch (error) {
    console.error(`Error fetching review orders for user ${userId}:`, error);
    res.status(500).json({ 
      error: 'Error fetching review orders',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

// NEW: Get Resume Text Content (Prioritizes edited text)
router.get('/:resumeId/text', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id;

  try {
    // Fetch resume and verify ownership
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }

    let resumeText = resume.editedText; // Prioritize edited text

    // If no edited text, extract from original file
    if (!resumeText) {
        console.log(`No edited text found for resume ${resumeId}, extracting from original file.`);
        const filePath = path.join(uploadsDir, resume.fileName);
        if (!fs.existsSync(filePath)) {
          throw new Error('Original resume file not found on server.');
        }
        const fileMimeType = require('mime-types').lookup(resume.fileName) || 'application/octet-stream';
        resumeText = await extractTextFromFile(filePath, fileMimeType);
    }
    
    res.json({ resumeId: resume.id, text: resumeText });

  } catch (error) {
    console.error(`Error fetching text for resume ${resumeId}:`, error);
    res.status(500).json({ 
      error: 'Failed to get resume text content', 
      details: error.message || 'An unexpected error occurred.'
    });
  }
});

// NEW: Save Edited Resume Text
router.put('/:resumeId/text', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id;
  const { editedText } = req.body;

  if (typeof editedText !== 'string') {
    return res.status(400).json({ error: 'Edited text content is required.' });
  }

  try {
    // Fetch resume and verify ownership
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }

    // Update the edited text field
    await prisma.resume.update({
        where: { id: resumeId },
        data: { editedText: editedText }
    });

    console.log(`Saved edited text for resume ${resumeId}`);
    res.json({ message: 'Resume text saved successfully.', resumeId: resumeId });

  } catch (error) {
    console.error(`Error saving edited text for resume ${resumeId}:`, error);
    res.status(500).json({ 
      error: 'Failed to save resume text', 
      details: error.message || 'An unexpected error occurred.'
    });
  }
});

// Get all resumes for the current user
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id; // From authenticateToken middleware
    
    const resumes = await prisma.resume.findMany({
      where: { userId: userId },
      orderBy: { submittedAt: 'desc' }
    });

    res.json(resumes);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ 
      error: 'Error fetching resumes',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

module.exports = { router, freeATSRouter }; 