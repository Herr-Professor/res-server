const express = require('express');
const { PrismaClient } = require('@prisma/client');

// Load environment variables
require('dotenv').config();

// Log Stripe configuration
console.log('Stripe Configuration:', {
  secretKeyLength: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.length : 0,
  secretKeyPrefix: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.substring(0, 7) : 'Not set',
  secretKeyValid: process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') || process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_'),
  webhookSecretPresent: !!process.env.STRIPE_WEBHOOK_SECRET
});

// Initialize Stripe with detailed error handling
let stripe;
try {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set in environment variables');
  }
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('Stripe initialized successfully');
} catch (error) {
  console.error('Failed to initialize Stripe:', error);
  stripe = null;
}

const router = express.Router();
const prisma = new PrismaClient();

// Create a payment intent
router.post('/create-payment-intent', async (req, res) => {
  try {
    console.log('Creating payment intent with data:', {
      plan: req.body.plan,
      resumeId: req.body.resumeId,
      stripeKeyPrefix: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.substring(0, 8) + '...' : 'Not set',
      stripeInstance: !!stripe,
      environment: process.env.NODE_ENV
    });

    if (!stripe) {
      console.error('Stripe is not initialized');
      throw new Error('Stripe is not properly initialized. Check server logs for details.');
    }

    const { plan, resumeId } = req.body;
    console.log('Received request body:', req.body);

    if (!plan || !resumeId) {
      console.error('Missing required fields:', { plan, resumeId });
      throw new Error(`Missing required fields: ${!plan ? 'plan' : ''} ${!resumeId ? 'resumeId' : ''}`);
    }

    // Get price for the plan
    const prices = {
      basic: 500, // $5.00 in cents
      premium: 1000, // $10.00 in cents
      urgent: 2500, // $25.00 in cents
      jobApplication: 15000 // $150.00 in cents
    };

    const amount = prices[plan];
    
    if (!amount) {
      console.error('Invalid plan:', plan);
      throw new Error(`Invalid plan: ${plan}`);
    }

    console.log('Creating Stripe payment intent with:', {
      amount,
      currency: 'usd',
      metadata: { resumeId, plan }
    });

    // Create a PaymentIntent with the order amount and currency
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata: {
        resumeId: resumeId.toString(),
        plan
      },
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'always'
      },
      return_url: process.env.NODE_ENV === 'production' 
        ? 'https://resumer-frontend.onrender.com/dashboard'
        : 'http://localhost:3000/dashboard',
      cancel_url: process.env.NODE_ENV === 'production'
        ? 'https://resumer-frontend.onrender.com/upload'
        : 'http://localhost:3000/upload'
    }).catch(error => {
      console.error('Stripe API error:', {
        type: error.type,
        code: error.code,
        message: error.message,
        raw: error.raw
      });
      throw error;
    });

    console.log('Payment intent created successfully:', {
      id: paymentIntent.id,
      clientSecret: paymentIntent.client_secret ? 'Present' : 'Missing',
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency
    });

    // Update resume with payment intent id
    await prisma.resume.update({
      where: { id: parseInt(resumeId) },
      data: {
        stripePaymentIntentId: paymentIntent.id
      }
    });

    res.json({
      clientSecret: paymentIntent.client_secret
    });
  } catch (error) {
    console.error('Payment intent creation error details:', {
      error: error.message,
      stack: error.stack,
      code: error.code,
      type: error.type,
      raw: error.raw,
      stripeError: error.raw,
      stripeKeyPresent: !!process.env.STRIPE_SECRET_KEY,
      stripeKeyPrefix: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.substring(0, 8) : 'Not set'
    });

    // Send a more detailed error response in development
    res.status(500).json({ 
      error: 'Error creating payment intent',
      details: process.env.NODE_ENV === 'development' ? {
        message: error.message,
        type: error.type,
        code: error.code
      } : undefined
    });
  }
});

// Handle Stripe webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        const resumeId = parseInt(paymentIntent.metadata.resumeId);
        
        // Update resume payment status
        await prisma.resume.update({
          where: { id: resumeId },
          data: {
            paymentStatus: 'completed',
            status: 'pending' // Change status to pending after payment
          }
        });
        break;

      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        await prisma.resume.update({
          where: { id: parseInt(failedPayment.metadata.resumeId) },
          data: {
            paymentStatus: 'failed'
          }
        });
        break;
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router; 