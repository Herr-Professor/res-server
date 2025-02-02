const express = require('express');
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const router = express.Router();
const prisma = new PrismaClient();

// Configure multer for optimized resume upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
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

    const [submissions, total] = await Promise.all([
      prisma.resume.findMany({
        skip,
        take: limit,
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
      prisma.resume.count()
    ]);

    res.json({
      submissions,
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
      return res.status(404).json({ error: 'Resume not found' });
    }

    const filePath = path.join(process.cwd(), 'uploads', resume.fileName);
    console.log('Attempting to download file from:', filePath);
    
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

// Download optimized resume
router.get('/submissions/:id/download-optimized', async (req, res) => {
  try {
    const resumeId = parseInt(req.params.id);
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId }
    });

    if (!resume || !resume.optimizedResume) {
      return res.status(404).json({ error: 'Optimized resume not found' });
    }

    const filePath = path.join(process.cwd(), 'uploads', resume.optimizedResume);
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