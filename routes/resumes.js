const express = require('express');
const multer = require('multer');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

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

// Upload resume route
router.post('/', upload.single('resume'), async (req, res) => {
  try {
    const { userId, plan, jobInterest, description } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const resume = await prisma.resume.create({
      data: {
        userId: parseInt(userId),
        fileName: req.file.filename,
        originalFileName: req.file.originalname,
        plan,
        jobInterest,
        description,
        status: 'pending'
      }
    });

    res.json(resume);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Error uploading resume' });
  }
});

// Free ATS check route with error handling
freeATSRouter.post('/', upload.single('resume'), handleMulterError, async (req, res) => {
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
      return res.status(400).json({ error: 'Email is required' });
    }

    // Create a new resume entry for the free ATS check
    const resume = await prisma.resume.create({
      data: {
        fileName: req.file.filename,
        originalFileName: req.file.originalname,
        email: email,
        type: 'free_ats_check',
        status: 'pending',
        plan: 'free',
        submittedAt: new Date()
      }
    });

    console.log('Successfully created resume entry:', {
      id: resume.id,
      fileName: resume.fileName,
      email: resume.email
    });

    res.json({
      message: 'Resume received for ATS check',
      id: resume.id
    });
  } catch (error) {
    console.error('Free ATS check error:', error);
    console.error('Error stack:', error.stack);
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'A resume with this email already exists' });
    }
    res.status(500).json({ 
      error: 'Error processing free ATS check',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
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

// Get single resume route
router.get('/:id', async (req, res) => {
  try {
    const resumeId = parseInt(req.params.id);
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
      include: { user: true }
    });

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    res.json(resume);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: 'Error fetching resume' });
  }
});

module.exports = { router, freeATSRouter }; 