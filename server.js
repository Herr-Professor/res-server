require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Middleware
const allowedOrigins = [
  'https://resumeoptimizer.io',
  'https://www.resumeoptimizer.io',
  'https://res-server-12bn.onrender.com',
  'http://localhost:5173',  // For local development
  'http://localhost:3000'   // For local development
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      console.log('Blocked origin:', origin);
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Special handling for Stripe webhook
app.post('/api/payment/webhook', express.raw({type: 'application/json'}));

// Regular middleware for other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check endpoint for Render
app.get('/healthx', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/resumes/free-ats-check', resumeRoutes); // Free ATS check route without auth
app.use('/api/resumes', authenticateToken, resumeRoutes);
app.use('/api/admin', authenticateToken, isAdmin, adminRoutes);
app.use('/api/payment', paymentRoutes); // Mount payment routes at /api/payment

// 404 handler
app.use((req, res) => {
  console.log(`404 - Not Found: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Not Found' });
});

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
      console.log(`Client URL: ${process.env.CLIENT_URL || 'http://resumeoptimizer.io'}`);
      console.log(`Uploads directory: ${uploadsDir}`);
      
      // Log available routes
      console.log('\nAvailable routes:');
      console.log('- POST /api/payment/create-checkout-session');
      console.log('- POST /api/resumes');
      console.log('- POST /api/auth/login');
      console.log('- POST /api/auth/register');
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

startServer().catch(console.error); 