require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const authRoutes = require('./routes/auth');
const resumeRoutes = require('./routes/resumes');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payments');
const { authenticateToken, isAdmin } = require('./middleware/auth');

const prisma = new PrismaClient({
  log: ['query', 'error', 'warn']
});
const app = express();
const PORT = process.env.PORT || 10000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log(`Created uploads directory at: ${uploadsDir}`);
}

// Middleware
app.use(cors({
  origin: ['https://resumeoptimizer.io', 'http://localhost:5173'],  // Allow main domain and local development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check endpoint for Render
app.get('/healthx', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Full health check endpoint
app.get('/health/full', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ 
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({ 
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Debug endpoint
app.get('/debug', async (req, res) => {
  try {
    let dbTest;
    try {
      dbTest = await prisma.$queryRaw`SELECT 1`;
    } catch (dbError) {
      console.error('Database test failed:', dbError);
      dbTest = null;
    }

    // Parse DATABASE_URL safely
    let dbUrlSafe = 'Not set';
    if (process.env.DATABASE_URL) {
      try {
        const url = new URL(process.env.DATABASE_URL);
        dbUrlSafe = `${url.protocol}//${url.hostname}:${url.port}${url.pathname}`;
      } catch (e) {
        dbUrlSafe = 'Invalid URL format';
      }
    }

    res.json({
      env: {
        nodeEnv: process.env.NODE_ENV,
        port: PORT,
        databaseUrl: dbUrlSafe,
        jwtSecret: process.env.JWT_SECRET ? 'Set' : 'Not set'
      },
      uploads: {
        directory: uploadsDir,
        exists: fs.existsSync(uploadsDir)
      },
      database: {
        connected: !!dbTest,
        test: dbTest
      }
    });
  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/resumes', authenticateToken, resumeRoutes);
app.use('/api/admin', authenticateToken, isAdmin, adminRoutes);
app.use('/api/payment', authenticateToken, paymentRoutes);

// Special route for Stripe webhook (needs raw body)
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), paymentRoutes);

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Something broke!',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Initialize server with retry logic
async function connectWithRetry(retries = 5, delay = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Attempting database connection (attempt ${i + 1}/${retries})...`);
      await prisma.$connect();
      console.log('Successfully connected to database');
      return true;
    } catch (error) {
      console.error(`Database connection attempt ${i + 1} failed:`, error);
      if (i < retries - 1) {
        console.log(`Retrying in ${delay/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  return false;
}

async function startServer() {
  try {
    // Test database connection with retry
    const connected = await connectWithRetry();
    if (!connected) {
      throw new Error('Failed to connect to database after multiple attempts');
    }

    // Start server
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV}`);
      console.log(`Uploads directory: ${uploadsDir}`);
    });

    // Handle server errors
    server.on('error', (error) => {
      console.error('Server error:', error);
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use`);
        process.exit(1);
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
    await prisma.$disconnect();
  process.exit(0);
  }); 

startServer().catch(console.error); 