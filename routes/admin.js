const express = require('express');
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { put } = require('@vercel/blob');

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

// Configure multer for optimized resume upload using MEMORY storage
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype === 'application/msword' || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, and DOCX files are allowed for optimized resumes!'), false);
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

// Download original resume (Admin)
router.get('/submissions/:id/download-original', async (req, res) => {
  try {
    const resumeId = parseInt(req.params.id);
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
      select: { fileUrl: true }
    });

    if (!resume || !resume.fileUrl) {
      return res.status(404).json({ 
        error: 'Original resume file URL not found',
        details: 'The URL for the original resume does not exist'
      });
    }

    console.log(`Admin downloading original resume ${resumeId}, redirecting to: ${resume.fileUrl}`);
    res.redirect(302, resume.fileUrl);

  } catch (error) {
    console.error('Admin Download Original error:', error);
    res.status(500).json({ 
      error: 'Error processing download for original resume',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

// Download optimized resume (Admin)
router.get('/submissions/:id/download-optimized', async (req, res) => {
  try {
    const resumeId = parseInt(req.params.id);
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
      select: { optimizedResume: true }
    });

    if (!resume || !resume.optimizedResume) {
      return res.status(404).json({ 
        error: 'Optimized resume URL not found',
        details: 'The URL for the optimized version of this resume is not available'
      });
    }

    if (typeof resume.optimizedResume === 'string' && resume.optimizedResume.startsWith('http')) {
        console.log(`Admin downloading optimized resume ${resumeId}, redirecting to: ${resume.optimizedResume}`);
        res.redirect(302, resume.optimizedResume);
    } else {
        console.error(`Admin Download Optimized Error: Field optimizedResume for resume ${resumeId} is not a valid URL: ${resume.optimizedResume}`);
        return res.status(500).json({ 
            error: 'Optimized file path is misconfigured',
            details: 'The stored path for the optimized file is not a valid URL.'
        });
    }

  } catch (error) {
    console.error('Admin Download Optimized error:', error);
    res.status(500).json({ 
      error: 'Error processing download for optimized resume',
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
      console.log(`Admin uploading optimized file: ${file.originalname} for resume ${resumeId}`);
      let optimizedBlobUrl = null;
      try {
        const blobFilename = `optimized-${resumeId}-${Date.now()}-${file.originalname}`;
        
        const blob = await put(blobFilename, file.buffer, {
          access: 'public',
          contentType: file.mimetype
        });
        optimizedBlobUrl = blob.url;
        updateData.optimizedResume = optimizedBlobUrl;
        console.log(`Optimized file uploaded to Vercel Blob: ${optimizedBlobUrl}`);
      } catch (uploadError) {
        console.error('Error uploading optimized file to Vercel Blob:', uploadError);
        return res.status(500).json({ error: 'Failed to upload optimized file to storage.' });
      }
    }

    const resume = await prisma.resume.update({
      where: { id: resumeId },
      data: updateData
    });

    res.json(resume);
  } catch (error) {
    console.error('Admin Update error:', error);
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

// --- Professional Review Management --- 

// GET /api/admin/reviews
router.get('/reviews', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const skip = (page - 1) * limit;
        const statusFilter = req.query.status; // e.g., 'requested', 'completed'

        const whereClause = {};
        if (statusFilter) {
            whereClause.status = statusFilter;
        }

        const [reviewOrders, total] = await Promise.all([
            prisma.reviewOrder.findMany({
                skip,
                take: limit,
                where: whereClause,
                include: {
                    user: {
                        select: { id: true, email: true, name: true }
                    },
                    resume: {
                        select: {
                            id: true,
                            originalFileName: true,
                            atsScore: true,
                            optimizationScore: true,
                            keywordAnalysis: true,
                            feedback: true,
                            jobDescription: true,
                            status: true,
                            submittedAt: true,
                            optimizedResume: true,
                            editedText: true
                        }
                    }
                },
                orderBy: {
                    submittedDate: 'asc'
                }
            }),
            prisma.reviewOrder.count({ where: whereClause })
        ]);

        res.json({
            reviewOrders,
            total,
            pages: Math.ceil(total / limit),
            currentPage: page
        });
    } catch (error) {
        console.error('Error fetching review orders:', error);
        const errorDetails = process.env.NODE_ENV === 'development' ? error.message : 'Internal server error';
        res.status(500).json({ error: 'Error fetching review orders', details: errorDetails });
    }
});

router.put('/reviews/:reviewOrderId', async (req, res) => {
    try {
        const reviewOrderId = parseInt(req.params.reviewOrderId);
        // Expecting status and optional reviewerFeedback in the body
        const { status, reviewerFeedback } = req.body; 

        // Validate status (add more valid statuses as needed)
        const validStatuses = ['requested', 'assigned', 'in_progress', 'completed', 'cancelled'];
        if (status && !validStatuses.includes(status)) { // Allow updating feedback without changing status
            return res.status(400).json({ error: `Invalid status provided. Valid statuses are: ${validStatuses.join(', ')}` });
        }

        const updateData = {};
        if (status) {
             updateData.status = status;
             if (status === 'completed') {
                 updateData.completedDate = new Date();
             } else {
                 // Clear completedDate if status is changed from completed?
                 // updateData.completedDate = null; 
             }
        }
        // Only update feedback if it's provided in the request body
        if (typeof reviewerFeedback === 'string') {
            updateData.reviewerFeedback = reviewerFeedback;
        }
        
        // Check if there is anything to update
        if (Object.keys(updateData).length === 0) {
             return res.status(400).json({ error: 'No update data provided (status or reviewerFeedback required).' });
        }

        const updatedReviewOrder = await prisma.reviewOrder.update({
            where: { id: reviewOrderId },
            data: updateData,
            include: { // Return updated order with user/resume info
                 user: { select: { id: true, email: true, name: true } },
                 resume: { select: { id: true, originalFileName: true } }
            }
        });

        // Optional: Update the corresponding Resume status as well?
        if (status === 'completed') {
             await prisma.resume.update({
                 where: { id: updatedReviewOrder.resumeId },
                 data: { status: 'review_complete' } 
             }).catch(err => console.error(`Admin: Failed to update related resume status for review ${reviewOrderId}`, err));
             console.log(`Admin updated review order ${reviewOrderId} status to ${status}`);
        }
        if (updateData.reviewerFeedback) {
             console.log(`Admin updated feedback for review order ${reviewOrderId}`);
             // Optionally, also update the main Resume feedback field?
             // await prisma.resume.update({
             //     where: { id: updatedReviewOrder.resumeId },
             //     data: { feedback: updateData.reviewerFeedback } 
             // }).catch(err => console.error(`Admin: Failed to update related resume feedback for review ${reviewOrderId}`, err));
        }
        
        res.json(updatedReviewOrder);

    } catch (error) {
        console.error(`Error updating review order ${req.params.reviewOrderId}:`, error);
        if (error.code === 'P2025') { // Prisma code for record not found
             return res.status(404).json({ error: 'Review order not found' });
        }
        res.status(500).json({ error: 'Error updating review order' });
    }
});

module.exports = router; 
