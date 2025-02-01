const express = require('express');
const multer = require('multer');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const cors = require('cors');

const router = express.Router();
const prisma = new PrismaClient();

// CORS configuration for file uploads
const corsOptions = {
  origin: ['https://resumeoptimizer.io', 'http://localhost:5173'],
  credentials: true,
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept'],
  maxAge: 600
};

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Created uploads directory at:', uploadsDir);
}

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Ensure directory exists before saving
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Get pricing
const getPriceForPlan = (plan) => {
  const prices = {
    basic: 5,
    premium: 10,
    urgent: 25,
    jobApplication: 150
  };
  return prices[plan] || prices.basic;
};

// Submit resume route with specific CORS handling
router.post('/', cors(corsOptions), upload.single('resume'), async (req, res) => {
  // Add CORS headers explicitly
  res.header('Access-Control-Allow-Origin', req.headers.origin);
  res.header('Access-Control-Allow-Credentials', true);

  try {
    console.log('Received resume submission request:', {
      body: req.body,
      file: req.file ? { ...req.file, buffer: undefined } : null
    });

    const { userId, plan, jobInterest, description } = req.body;
    const file = req.file;

    if (!file) {
      console.error('No file uploaded');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!userId) {
      console.error('No userId provided');
      return res.status(400).json({ error: 'User ID is required' });
    }

    const resume = await prisma.resume.create({
      data: {
        userId: parseInt(userId),
        fileName: file.filename,
        originalFileName: file.originalname,
        plan,
        jobInterest,
        description,
        price: getPriceForPlan(plan),
        paymentStatus: 'pending'
      }
    });

    console.log('Resume created successfully:', resume);

    res.status(201).json({
      message: 'Resume submitted successfully',
      resumeId: resume.id
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Error uploading resume',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get user submissions route
router.get('/user/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const submissions = await prisma.resume.findMany({
      where: { userId },
      orderBy: { submittedAt: 'desc' }
    });

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
      return res.status(404).json({ error: 'Optimized resume not found' });
    }

    const filePath = path.join(uploadsDir, resume.optimizedResume);
    console.log('Attempting to download optimized file from:', filePath);
    
    if (!fs.existsSync(filePath)) {
      console.error('File not found at path:', filePath);
      return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath, `optimized-${resume.originalFileName}`);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Error downloading optimized resume' });
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

module.exports = router; 