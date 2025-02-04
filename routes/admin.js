const express = require('express');
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const router = express.Router();
const prisma = new PrismaClient();

// Define uploads directory based on environment
const uploadsDir = process.env.NODE_ENV === 'production'
  ? path.join('/tmp', 'uploads')  // Use /tmp for Render's ephemeral storage
  : path.join(process.cwd(), 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for optimized resume upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'optimized-' + uniqueSuffix + path.extname(file.originalname));
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

// Get all submissions with pagination
router.get('/submissions', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    const type = req.query.type || 'all'; // 'all', 'paid', or 'free_ats_check'

    // Build where clause based on type filter
    const whereClause = type !== 'all' ? { type } : {};

    const [submissions, total] = await Promise.all([
      prisma.resume.findMany({
        skip,
        take: limit,
        where: whereClause,
        select: {
          id: true,
          originalFileName: true,
          fileName: true,
          optimizedResume: true,
          status: true,
          submittedAt: true,
          completedAt: true,
          feedback: true,
          plan: true,
          price: true,
          paymentStatus: true,
          paymentAmount: true,
          jobInterest: true,
          description: true,
          type: true,
          email: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true
            }
          }
        },
        orderBy: {
          submittedAt: 'desc'
        }
      }),
      prisma.resume.count({ where: whereClause })
    ]);

    // Get submission stats
    const stats = {
      total,
      paid: await prisma.resume.count({ where: { type: 'paid' } }),
      freeATS: await prisma.resume.count({ where: { type: 'free_ats_check' } })
    };

    // Log the first submission for debugging
    if (submissions.length > 0) {
      console.log('Sample submission data:', {
        id: submissions[0].id,
        jobInterest: submissions[0].jobInterest,
        description: submissions[0].description?.substring(0, 100) + '...'
      });
    }

    res.json({
      submissions,
      stats,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page
    });
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: 'Error fetching submissions' });
  }
});

// Download original resume
router.get('/submissions/:id/download-original', async (req, res) => {
  try {
    const resumeId = parseInt(req.params.id);
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId }
    });

    if (!resume) {
      console.error('Resume not found in database:', resumeId);
      return res.status(404).json({ 
        error: 'Resume not found',
        details: 'The requested resume does not exist'
      });
    }

    const filePath = path.join(uploadsDir, resume.fileName);
    console.log('Attempting to download file from:', filePath);
    
    if (!fs.existsSync(filePath)) {
      console.error('File not found at path:', filePath);
      return res.status(404).json({ 
        error: 'File not found',
        details: 'The resume file is no longer available'
      });
    }

    res.download(filePath, resume.originalFileName);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      error: 'Error downloading resume',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

// Download optimized resume
router.get('/submissions/:id/download-optimized', async (req, res) => {
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

// Update submission status and upload optimized resume
router.put('/submissions/:id', upload.single('optimizedResume'), async (req, res) => {
  try {
    const { status, feedback } = req.body;
    const resumeId = parseInt(req.params.id);
    const file = req.file;

    const updateData = {
      status,
      feedback,
      completedAt: status === 'completed' ? new Date() : null
    };

    if (file) {
      updateData.optimizedResume = file.filename;
    }

    const resume = await prisma.resume.update({
      where: { id: resumeId },
      data: updateData
    });

    res.json(resume);
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Error updating submission' });
  }
});

// Get enhanced statistics including payment info
router.get('/stats', async (req, res) => {
  try {
    const [
      totalSubmissions,
      pendingSubmissions,
      completedSubmissions,
      paidSubmissions,
      totalRevenue,
      avgResponseTime
    ] = await Promise.all([
      prisma.resume.count(),
      prisma.resume.count({ where: { status: 'pending' } }),
      prisma.resume.count({ where: { status: 'completed' } }),
      prisma.resume.count({ where: { paymentStatus: 'success' } }),
      prisma.resume.aggregate({
        _sum: {
          paymentAmount: true
        },
        where: {
          paymentStatus: 'success'
        }
      }),
      prisma.resume.findMany({
        where: {
          status: 'completed',
          completedAt: { not: null }
        },
        select: {
          submittedAt: true,
          completedAt: true
        }
      })
    ]);

    // Calculate average response time in hours
    const responseTime = avgResponseTime.reduce((acc, curr) => {
      const submitted = new Date(curr.submittedAt);
      const completed = new Date(curr.completedAt);
      return acc + (completed - submitted) / (1000 * 60 * 60);
    }, 0);

    const averageResponseTime = avgResponseTime.length > 0 
      ? Math.round(responseTime / avgResponseTime.length) 
      : 0;

    res.json({
      totalSubmissions,
      pendingSubmissions,
      completedSubmissions,
      paidSubmissions,
      totalRevenue: totalRevenue._sum.paymentAmount || 0,
      conversionRate: totalSubmissions ? (paidSubmissions / totalSubmissions * 100).toFixed(1) : 0,
      averageResponseTime
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Error fetching statistics' });
  }
});

module.exports = router; 