const express = require('express');
const multer = require('multer');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const fsPromises = require('fs').promises;
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { authenticateToken } = require('../middleware/auth');
const { put } = require('@vercel/blob');
const fetch = require('node-fetch');

const router = express.Router();
const freeATSRouter = express.Router();
const prisma = new PrismaClient();

// Configure multer for file upload using memory storage
const fileFilter = (req, file, cb) => {
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

// Use memoryStorage instead of diskStorage
const upload = multer({ 
  storage: multer.memoryStorage(),
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

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

// Helper functions
async function fetchBlobContent(fileUrl) {
  try {
    console.log(`Fetching file content from blob URL: ${fileUrl}`);
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch blob: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.buffer(); // Use .buffer() with node-fetch v2/v3
    console.log(`Successfully fetched blob content, size: ${buffer.length} bytes`);
    return buffer;
  } catch (error) {
    console.error(`Error fetching content from ${fileUrl}:`, error);
    throw new Error(`Failed to fetch file content from storage: ${error.message}`);
  }
}

async function extractTextFromFile(source, mimeType) {
  try {
    let dataBuffer;
    if (Buffer.isBuffer(source)) {
      console.log('Extracting text directly from buffer.');
      dataBuffer = source;
    } else if (typeof source === 'string' && source.startsWith('http')) {
      console.log('Source is a URL, fetching content first.');
      dataBuffer = await fetchBlobContent(source);
    } else {
      // Keep local file path logic only if absolutely needed elsewhere, 
      // otherwise, assume buffer or URL.
      // For Vercel, local paths are unlikely to be used post-upload.
      // console.log('Source is assumed to be a local path.');
      // dataBuffer = await fsPromises.readFile(source);
      throw new Error('Unsupported source type for text extraction. Expected buffer or URL.');
    }

    if (!mimeType) {
        // Attempt to infer mime type from URL if possible
        if (typeof source === 'string' && source.startsWith('http')) {
            const inferredMimeType = require('mime-types').lookup(source);
            if (inferredMimeType) {
                mimeType = inferredMimeType;
                console.log(`Inferred mime type from URL: ${mimeType}`);
            } else {
                 throw new Error('Cannot determine mime type for text extraction from URL.');
            }
        } else {
            throw new Error('Mime type is required for text extraction from buffer.');
        }
    }

    console.log(`Extracting text with mime type: ${mimeType}`);
    if (mimeType === 'application/pdf') {
      const data = await pdfParse(dataBuffer);
      return data.text;
    } else if (
      mimeType === 'application/msword' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const result = await mammoth.extractRawText({ buffer: dataBuffer });
      return result.value;
    } else {
      throw new Error('Unsupported file type for text extraction');
    }
  } catch (error) {
    console.error(`Error extracting text:`, error);
    throw new Error(`Failed to extract text: ${error.message}`);
  }
}

function performBasicAtsCheck(text) {
  let score = 0;
  const feedback = [];
  const MAX_SCORE = 100;

  const lowerCaseText = text.toLowerCase();

  const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/;
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
  let contactScore = 0;
  if (emailRegex.test(lowerCaseText)) {
    contactScore += 10;
    feedback.push({ type: 'positive', message: 'Email address found.' });
  } else {
    feedback.push({ type: 'negative', message: 'Consider adding a clear email address.' });
  }
  if (phoneRegex.test(text)) {
    contactScore += 10;
    feedback.push({ type: 'positive', message: 'Phone number found.' });
  } else {
    feedback.push({ type: 'negative', message: 'Consider adding a clear phone number.' });
  }
  score += contactScore;

  const sections = ['experience', 'education', 'skills', 'summary'];
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

  const actionVerbs = ['managed', 'developed', 'led', 'created', 'implemented', 'coordinated', 'analyzed', 'designed', 'achieved'];
  let actionVerbCount = 0;
  actionVerbs.forEach(verb => {
    if (lowerCaseText.includes(verb)) {
      actionVerbCount++;
    }
  });
  if (actionVerbCount >= 3) {
    score += 20;
    feedback.push({ type: 'positive', message: 'Good use of action verbs detected.' });
  } else {
    feedback.push({ type: 'negative', message: 'Enhance descriptions with strong action verbs (e.g., Managed, Developed, Implemented).' });
  }

  const wordCount = text.split(/\s+/).length;
  if (wordCount > 200 && wordCount < 1500) {
    score += 10;
    feedback.push({ type: 'positive', message: 'Resume length seems reasonable.' });
  } else if (wordCount <= 200) {
    feedback.push({ type: 'negative', message: 'Resume seems short. Consider elaborating on experience or skills.' });
  } else {
    feedback.push({ type: 'negative', message: 'Resume seems long. Consider summarizing or being more concise.' });
  }
  const specialChars = text.replace(/[a-zA-Z0-9\s.,@()-\/]/g, '').length;
  if (specialChars / text.length < 0.01) {
    score += 10;
    feedback.push({ type: 'positive', message: 'Simple formatting detected, generally good for ATS.' });
  } else {
    feedback.push({ type: 'negative', message: 'Potential complex formatting detected (e.g., excessive symbols, tables). Ensure ATS compatibility.' });
  }

  score = Math.max(0, Math.min(MAX_SCORE, Math.round(score)));
  feedback.sort((a, b) => (a.type === 'positive' ? -1 : 1));

  return { score, feedback };
}

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
                      .replace(/```json\n?/, '')
                      .replace(/\n?```/, '')
                      .trim();
    
    console.log('Received response from Gemini:', jsonText);
    const analysis = JSON.parse(jsonText);
    
    if (typeof analysis.atsScore !== 'number' || !Array.isArray(analysis.feedback)) {
      throw new Error('Invalid JSON structure received from AI.');
    }
    
    return analysis;
  } catch (error) {
    console.error('Error calling Gemini API or parsing response:', error);
    const errorMessage = error.response?.text ? await error.response.text() : error.message;
    throw new Error(`Gemini API Error: ${errorMessage}`);
  }
}

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
                      .replace(/```json\n?/, '')
                      .replace(/\n?```/, '')
                      .trim();
    
    console.log('Received response from Gemini:', jsonText);
    const analysis = JSON.parse(jsonText);
    
    if (typeof analysis.optimizationScore !== 'number' || 
        !analysis.keywordAnalysis || 
        !Array.isArray(analysis.keywordAnalysis.matchedKeywords) || 
        !Array.isArray(analysis.keywordAnalysis.missingKeywords) ||
        !Array.isArray(analysis.suggestions)) {
      console.error('Invalid JSON structure received from AI:', analysis);
      throw new Error('Invalid JSON structure received from AI.');
    }
    
    return analysis;
  } catch (error) {
    console.error('Error calling Gemini API or parsing response for Job Optimization:', error);
    const errorMessage = error.response?.text ? await error.response.text() : error.message;
    throw new Error(`Gemini API Error: ${errorMessage}`);
  }
}

// Routes - Specific routes first
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [
      resumes,
      reviewOrders,
      userProfile
    ] = await Promise.all([
      prisma.resume.findMany({
        where: { userId },
        select: {
          id: true,
          status: true
        }
      }),
      prisma.reviewOrder.findMany({
        where: { userId },
        select: {
          id: true,
          status: true
        }
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          ppuAtsCredits: true,
          ppuOptimizationCredits: true
        }
      })
    ]);
    
    const stats = {
      resumesUploaded: resumes.length,
      analysesCompleted: {
        basicAts: resumes.filter(r => r.status === 'basic_ats_complete' || r.status === 'detailed_ats_complete').length,
        detailedAts: resumes.filter(r => r.status === 'detailed_ats_complete').length,
        jobOpt: resumes.filter(r => r.status === 'job_opt_complete').length,
        review: resumes.filter(r => r.status === 'review_complete').length,
        total: resumes.filter(r => 
          r.status === 'basic_ats_complete' || 
          r.status === 'detailed_ats_complete' || 
          r.status === 'job_opt_complete' ||
          r.status === 'review_complete'
        ).length
      },
      pendingReviews: reviewOrders.filter(r => 
        r.status === 'requested' || 
        r.status === 'in_progress'
      ).length,
      completedReviews: reviewOrders.filter(r => 
        r.status === 'completed'
      ).length,
      atsCredits: userProfile.ppuAtsCredits,
      optimizationCredits: userProfile.ppuOptimizationCredits
    };
    
    res.json(stats);
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ 
      error: 'Error fetching user statistics',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

router.get('/reviews', authenticateToken, async (req, res) => {
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

router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    
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

router.post('/', upload.single('resume'), handleMulterError, async (req, res) => {
  const userId = req.user.id;
  let resumeRecord = null;
  try {
    const { jobInterest, description } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // --- Vercel Blob Upload --- 
    let blobUrl = null;
    try {
      const blobFilename = `${userId}-${Date.now()}-${req.file.originalname}`;
      const blob = await put(blobFilename, req.file.buffer, {
        access: 'public', // Set to public to allow easy downloading later
        contentType: req.file.mimetype,
        addRandomSuffix: false, // Use our specific filename
        // Consider adding cache control if needed
        // cacheControlMaxAge: 3600, 
      });
      blobUrl = blob.url;
      console.log(`File uploaded to Vercel Blob: ${blobUrl}`);
    } catch (uploadError) {
      console.error('Error uploading to Vercel Blob:', uploadError);
      return res.status(500).json({ error: 'Failed to store uploaded file.' });
    }
    // --- End Vercel Blob Upload ---

    resumeRecord = await prisma.resume.create({
      data: {
        userId: userId,
        fileUrl: blobUrl, // <-- Save the Vercel Blob URL
        originalFileName: req.file.originalname,
        jobInterest,
        description,
        status: 'uploaded', // Set initial status, analysis will update it
        type: 'paid' // Assuming authenticated uploads are part of paid service
      }
    });
    console.log(`Created initial resume entry for user ${userId}: ${resumeRecord.id} with URL: ${resumeRecord.fileUrl}`);

    // --- Analysis needs the file content --- 
    // TODO: Update analysis logic later to fetch from blobUrl or use req.file.buffer
    let analysisResult = null;
    let finalResumeData = null;
    try {
      console.log(`Performing basic ATS check directly from buffer for resume: ${resumeRecord.id}`);
      // Directly pass the buffer and mimetype to the extraction function
      const resumeText = await extractTextFromFile(req.file.buffer, req.file.mimetype);
      console.log(`Text extracted successfully for resume: ${resumeRecord.id}, length: ${resumeText.length}`);
      
      analysisResult = performBasicAtsCheck(resumeText);
      console.log(`Basic ATS check completed for resume: ${resumeRecord.id}, score: ${analysisResult.score}`);

      finalResumeData = await prisma.resume.update({
        where: { id: resumeRecord.id },
        data: {
          atsScore: analysisResult.score,
          feedback: analysisResult.feedback,
          status: 'basic_ats_complete' // Update status after successful analysis
        }
      });
      console.log(`Updated resume record ${resumeRecord.id} with ATS results.`);
      
    } catch (analysisError) {
      console.error(`Error during initial ATS analysis for resume ${resumeRecord?.id}:`, analysisError);
      // Update status even if analysis fails
      finalResumeData = await prisma.resume.update({
        where: { id: resumeRecord.id },
        data: { status: 'basic_ats_failed' }
      });
      // Return the created record info but indicate analysis failed
      return res.status(201).json({ 
        ...finalResumeData, 
        analysisError: `Failed to perform initial ATS check: ${analysisError.message}` 
      });
    }
    // --- End Analysis --- 

    res.status(201).json(finalResumeData);

  } catch (error) {
    console.error('Authenticated upload error:', error);
    // No file to delete from local disk anymore
    // if (!resumeRecord && req.file && req.file.path) { ... }
    res.status(500).json({ error: 'Error uploading resume' });
  }
});

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

router.get('/download-original/:id', async (req, res) => {
  try {
    const resumeId = parseInt(req.params.id);
    // console.log(`[Download Original] Received request for ID: ${resumeId}`); // Keep logs just in case they appear later

    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
      select: { fileUrl: true, originalFileName: true } 
    });

    // console.log(`[Download Original] Prisma result for ID ${resumeId}:`, JSON.stringify(resume)); // Keep logs

    // --- Modified Check --- 
    if (!resume) {
      // console.log(`[Download Original] Resume record not found for ID ${resumeId}.`); // Keep logs
      // Return specific error if resume record itself wasn't found
      return res.status(404).json({ error: 'Resume record not found in database', requestedId: resumeId }); 
    }
    if (!resume.fileUrl) {
      // console.log(`[Download Original] fileUrl is null/empty for ID ${resumeId}.`); // Keep logs
      // Return specific error if resume was found BUT fileUrl is missing
      return res.status(404).json({ error: 'Resume record found, but fileUrl is missing', requestedId: resumeId }); 
    }
    // --- End Modified Check ---

    // console.log(`[Download Original] Redirecting download for original resume ${resumeId} to: ${resume.fileUrl}`); // Keep logs
    res.redirect(302, resume.fileUrl);

  } catch (error) {
    // console.error('Download error:', error); // Keep logs
    // Add error details to the 500 response if possible
    res.status(500).json({ 
      error: 'Error processing download for original resume', 
      details: error.message // Include error message
    });
  }
});

router.post('/:resumeId/detailed-ats-report', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id;
  let updatedResumeRecord = null;
  let usedPpuCredit = false;

  try {
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

    if (user.subscriptionStatus !== 'premium' && user.ppuAtsCredits <= 0) {
        return res.status(403).json({ error: 'Forbidden: Premium subscription or Detailed ATS credit required.' });
    }

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
    
    await prisma.resume.update({
        where: { id: resumeId },
        data: { status: 'detailed_ats_pending' }
    });

    if (!resume.fileUrl) {
        await prisma.resume.update({ where: { id: resumeId }, data: { status: 'detailed_ats_failed' } }); // Update status
        throw new Error('Resume file URL is missing.');
    }

    // Determine mime type (assuming originalFileName has correct extension)
    const fileMimeType = require('mime-types').lookup(resume.originalFileName) || 'application/octet-stream';
    
    // Fetch content from blob URL and extract text
    console.log(`Fetching resume content from ${resume.fileUrl} for detailed ATS.`);
    const resumeText = await extractTextFromFile(resume.fileUrl, fileMimeType);

    const analysisResult = await callGeminiForDetailedATS(resumeText);

    updatedResumeRecord = await prisma.resume.update({
      where: { id: resumeId },
      data: {
        atsScore: analysisResult.atsScore,
        feedback: analysisResult.feedback,
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
    
    if (usedPpuCredit) {
        try {
            await prisma.user.update({
                where: { id: userId },
                data: { ppuAtsCredits: { increment: 1 } }
            });
            console.log(`Rolled back PPU ATS credit for user ${userId} due to error.`);
        } catch (rollbackError) {
            console.error(`CRITICAL: Failed to roll back PPU credit for user ${userId} after error:`, rollbackError);
        }
    }

    try {
       if (resumeId) {
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

router.put('/:resumeId/job-description', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id;
  const { jobDescription } = req.body;

  if (typeof jobDescription !== 'string' || jobDescription.trim() === '') {
    return res.status(400).json({ error: 'Job description text is required.' });
  }

  try {
    const resume = await prisma.resume.findUnique({ 
        where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }

    const updatedResume = await prisma.resume.update({
      where: { id: resumeId },
      data: { 
          jobDescription: jobDescription,
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

router.post('/:resumeId/job-optimization', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id;
  let updatedResumeRecord = null;
  let usedPpuCredit = false;
  const PPU_CLICK_LIMIT = 5;

  try {
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

    if (user.subscriptionStatus !== 'premium' && user.ppuOptimizationCredits <= 0) {
        return res.status(403).json({ error: 'Forbidden: Premium subscription or Job Optimization credit required.' });
    }

    let ppuClicksRemaining = null;
    if (user.subscriptionStatus !== 'premium') {
        try {
           await prisma.$transaction(async (tx) => {
                await tx.user.update({
                    where: { id: userId },
                    data: { ppuOptimizationCredits: { decrement: 1 } }
                });
                await tx.resume.update({
                    where: { id: resumeId },
                    data: { ppuOptimizationClicksRemaining: PPU_CLICK_LIMIT }
                });
           });
           usedPpuCredit = true;
           ppuClicksRemaining = PPU_CLICK_LIMIT;
           console.log(`Decremented PPU Optimization credit for user ${userId}. Click limit set to ${PPU_CLICK_LIMIT} on resume ${resumeId}.`);
        } catch (error) {
            console.error(`Error processing PPU Optimization credit/click limit for user ${userId}:`, error);
            return res.status(500).json({ error: 'Failed to process PPU credit or set click limit.' });
        }
    }

    await prisma.resume.update({
        where: { id: resumeId },
        data: { status: 'job_opt_pending' }
    });

    if (!resume.fileUrl) {
        await prisma.resume.update({ where: { id: resumeId }, data: { status: 'job_opt_failed' } }); // Update status
        throw new Error('Resume file URL is missing.');
    }
    
    // Determine mime type
    const fileMimeType = require('mime-types').lookup(resume.originalFileName) || 'application/octet-stream';

    // Fetch content from blob URL and extract text
    console.log(`Fetching resume content from ${resume.fileUrl} for job optimization.`);
    const resumeText = await extractTextFromFile(resume.fileUrl, fileMimeType);

    const analysisResult = await callGeminiForJobOptimization(resumeText, resume.jobDescription);

    updatedResumeRecord = await prisma.resume.update({
      where: { id: resumeId },
      data: {
        optimizationScore: analysisResult.optimizationScore,
        keywordAnalysis: analysisResult.keywordAnalysis,
        feedback: analysisResult.suggestions,
        status: 'job_opt_complete',
        completedAt: new Date()
      }
    });

    res.json({
      message: 'Job-specific optimization analysis completed.',
      resumeId: updatedResumeRecord.id,
      optimizationScore: updatedResumeRecord.optimizationScore,
      keywordAnalysis: updatedResumeRecord.keywordAnalysis,
      suggestions: updatedResumeRecord.feedback,
      ppuClicksRemaining: ppuClicksRemaining
    });

  } catch (error) {
    console.error(`Error processing job optimization for resume ${resumeId}:`, error);
    
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

router.post('/:resumeId/analyze-changes', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id;
  const { editedResumeText } = req.body;
  let newClicksRemaining = null;

  if (typeof editedResumeText !== 'string') {
    return res.status(400).json({ error: 'Edited resume text is required.' });
  }

  try {
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
    
    if (!resume.jobDescription) {
        return res.status(400).json({ error: 'Cannot analyze changes: No job description associated with this resume for optimization.' });
    }

    if (user.subscriptionStatus !== 'premium') {
        if (resume.ppuOptimizationClicksRemaining === null || resume.ppuOptimizationClicksRemaining <= 0) {
            return res.status(403).json({ 
                error: 'Forbidden: No PPU analysis clicks remaining for this optimization session.',
                ppuClicksRemaining: 0 
            });
        }
        
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
    }

    const analysisResult = await callGeminiForJobOptimization(editedResumeText, resume.jobDescription);

    res.json({
      message: 'Analysis of changes completed.',
      resumeId: resume.id,
      optimizationScore: analysisResult.optimizationScore,
      keywordAnalysis: analysisResult.keywordAnalysis,
      suggestions: analysisResult.suggestions,
      ppuClicksRemaining: newClicksRemaining
    });

  } catch (error) {
    console.error(`Error analyzing changes for resume ${resumeId}:`, error);
    res.status(500).json({ 
      error: 'Failed to analyze changes', 
      details: error.message || 'An unexpected error occurred.'
    });
  }
});

router.get('/:resumeId/download-optimized', authenticateToken, async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id;

  try {
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
      select: { userId: true, optimizedResume: true, originalFileName: true } // Select needed fields
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }

    if (!resume.optimizedResume) {
      return res.status(404).json({ 
        error: 'Optimized resume not found',
        details: 'An optimized version of this resume is not available for download.'
      });
    }

    // --- Assuming optimizedResume field now stores a URL --- 
    // TODO: Confirm this assumption when updating admin routes
    if (typeof resume.optimizedResume === 'string' && resume.optimizedResume.startsWith('http')) {
      console.log(`Redirecting download for optimized resume ${resumeId} to: ${resume.optimizedResume}`);
      res.redirect(302, resume.optimizedResume);
    } else {
      // Handle case where optimizedResume might still be a filename (needs admin route update)
      console.error(`Optimized resume field for ${resumeId} is not a valid URL: ${resume.optimizedResume}`);
      return res.status(500).json({ error: 'Optimized file path is misconfigured.'});
    }

  } catch (error) {
    console.error(`Error downloading optimized resume ${resumeId} for user ${userId}:`, error);
    res.status(500).json({ 
      error: 'Error processing download for optimized resume',
      details: error.message || 'An unexpected error occurred.'
    });
  }
});

router.get('/:resumeId/text', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id;

  try {
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }

    let resumeText = resume.editedText;

    if (!resumeText) {
        console.log(`No edited text found for resume ${resumeId}, fetching from original file URL: ${resume.fileUrl}`);
        if (!resume.fileUrl) {
            throw new Error('Original resume file URL not found.');
        }
        const fileMimeType = require('mime-types').lookup(resume.originalFileName) || 'application/octet-stream';
        resumeText = await extractTextFromFile(resume.fileUrl, fileMimeType);
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

router.put('/:resumeId/text', async (req, res) => {
  const resumeId = parseInt(req.params.resumeId);
  const userId = req.user.id;
  const { editedText } = req.body;

  if (typeof editedText !== 'string') {
    return res.status(400).json({ error: 'Edited text content is required.' });
  }

  try {
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    if (resume.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this resume' });
    }

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

// Free ATS check route (unchanged)
freeATSRouter.post('/', upload.single('resume'), handleMulterError, async (req, res) => {
  let resumeRecord = null;
  let blobUrl = null; // Need blob URL for free check too
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
      await fsPromises.unlink(req.file.path).catch(err => console.error('Error deleting orphaned file:', err));
      return res.status(400).json({ error: 'Email is required' });
    }

    // --- Vercel Blob Upload --- 
    try {
      const blobFilename = `free-${Date.now()}-${req.file.originalname}`;
      const blob = await put(blobFilename, req.file.buffer, {
        access: 'public',
        contentType: req.file.mimetype,
        addRandomSuffix: false,
      });
      blobUrl = blob.url;
      console.log(`Free check file uploaded to Vercel Blob: ${blobUrl}`);
    } catch (uploadError) {
      console.error('Error uploading free check file to Vercel Blob:', uploadError);
      // Don't delete local file as it's in memory
      return res.status(500).json({ error: 'Failed to store uploaded file.' });
    }
    // --- End Vercel Blob Upload ---

    resumeRecord = await prisma.resume.create({
      data: {
        fileUrl: blobUrl, // Save blob URL
        originalFileName: req.file.originalname,
        email: email,
        type: 'free_ats_check',
        status: 'basic_ats_pending',
        submittedAt: new Date()
      }
    });

    console.log('Created initial resume entry:', resumeRecord.id);

    let analysisResult = null;
    try {
      console.log(`Extracting text from: ${req.file.path}`);
      const resumeText = await extractTextFromFile(req.file.path, req.file.mimetype);
      console.log(`Text extracted successfully for resume: ${resumeRecord.id}, length: ${resumeText.length}`);
      
      console.log(`Performing basic ATS check for resume: ${resumeRecord.id}`);
      analysisResult = performBasicAtsCheck(resumeText);
      console.log(`Basic ATS check completed for resume: ${resumeRecord.id}, score: ${analysisResult.score}`);

      const updatedResume = await prisma.resume.update({
        where: { id: resumeRecord.id },
        data: {
          atsScore: analysisResult.score,
          feedback: analysisResult.feedback,
          status: 'basic_ats_complete'
        }
      });
      console.log(`Updated resume record ${resumeRecord.id} with ATS results.`);

      res.json({
        message: 'Basic ATS check completed.',
        resumeId: updatedResume.id,
        atsScore: updatedResume.atsScore,
        feedback: updatedResume.feedback
      });

    } catch (analysisError) {
      console.error(`Error during ATS analysis for resume ${resumeRecord?.id}:`, analysisError);
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

  } catch (error) {
    console.error('Free ATS check route error:', error);
    if (!resumeRecord && req.file && req.file.path) {
      await fsPromises.unlink(req.file.path).catch(err => console.error('Error deleting orphaned file on route error:', err));
    }
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
    
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'A resume check request with this email might already be in progress or failed previously.' });
    }
    if (!res.headersSent) {
        res.status(500).json({ 
            error: 'Error processing free ATS check request',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
  }
});

// --- Define general /:id route LAST --- 
router.get('/:id', async (req, res) => {
  try {
    const resumeId = parseInt(req.params.id);
    if (isNaN(resumeId)) {
      return res.status(400).json({ error: 'Invalid resume ID' });
    }

    // Check if the user is authenticated (added manually since this might be hit unauthenticated now?)
    // Although authenticateToken is applied globally in server.js, let's be safe.
    if (!req.user) { 
       return res.status(401).json({ error: 'Authentication required to view resume details.'});
    }

    const resume = await prisma.resume.findUnique({
      where: {
        id: resumeId
      },
      include: {
        user: true // Include user details if needed
      }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    // Authorization check: Ensure the logged-in user owns the resume
    if (resume.userId !== req.user.id) {
       return res.status(403).json({ error: 'Forbidden: You do not own this resume.'});
    }

    // Optionally remove sensitive data before sending
    // delete resume.user.password;
    // delete resume.user.stripeSubscriptionId;

    res.json(resume);
  } catch (error) {
    console.error('Fetch error for /:id:', error);
    res.status(500).json({ 
      error: 'Error fetching resume',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

module.exports = { router, freeATSRouter };
