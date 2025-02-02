const express = require('express');
const multer = require('multer');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

const router = express.Router();
const prisma = new PrismaClient();

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
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