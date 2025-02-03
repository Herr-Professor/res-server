const express = require('express');
const { PrismaClient } = require('@prisma/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const router = express.Router();
const prisma = new PrismaClient();

// Discount codes configuration
const DISCOUNT_CODES = {
  'tonfans25': 0.5  // 50% off
};

// Test endpoint to verify Stripe configuration
router.get('/test-stripe', async (req, res) => {
  try {
    console.log('Testing Stripe connection...');
    console.log('Stripe key length:', process.env.STRIPE_SECRET_KEY?.length);
    console.log('Stripe key prefix:', process.env.STRIPE_SECRET_KEY?.substring(0, 7));
    
    const paymentMethods = await stripe.paymentMethods.list({
      limit: 1,
      type: 'card'
    });
    
    res.json({ 
      status: 'success',
      message: 'Stripe connection successful',
      keyPrefix: process.env.STRIPE_SECRET_KEY?.substring(0, 7)
    });
  } catch (error) {
    console.error('Stripe test error:', error);
    res.status(500).json({ 
      error: 'Stripe configuration error',
      message: error.message
    });
  }
});

// Create a checkout session
router.post('/create-checkout-session', async (req, res) => {
  try {
    console.log('Received checkout request:', req.body);
    const { plan, resumeId, discountCode } = req.body;
    
    if (!plan || !resumeId) {
      console.log('Missing required fields:', { plan, resumeId });
      return res.status(400).json({ error: 'Missing required fields: plan and resumeId' });
    }

    // Get the resume details
    const resume = await prisma.resume.findUnique({
      where: { id: parseInt(resumeId) },
      include: { user: true }
    });

    if (!resume) {
      console.log('Resume not found:', resumeId);
      return res.status(404).json({ error: 'Resume not found' });
    }

    // Set price based on plan
    const prices = {
      basic: 500,        // $5.00
      premium: 1000,     // $10.00
      urgent: 2500,      // $25.00
      jobApplication: 15000  // $150.00
    };

    const planTitles = {
      basic: 'Basic Resume Edit',
      premium: 'Premium Resume Edit',
      urgent: 'Urgent Resume Edit',
      jobApplication: 'Job Application Service'
    };

    if (!prices[plan]) {
      console.log('Invalid plan selected:', plan);
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    // Apply discount if valid code provided
    let finalPrice = prices[plan];
    let appliedDiscount = null;
    
    if (discountCode && DISCOUNT_CODES[discountCode]) {
      const discountMultiplier = DISCOUNT_CODES[discountCode];
      finalPrice = Math.round(finalPrice * (1 - discountMultiplier)); // Round to avoid floating point issues
      appliedDiscount = discountCode;
    }

    console.log('Creating checkout session for plan:', plan, 'price:', finalPrice, 'discount:', appliedDiscount);

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: planTitles[plan],
              description: `Resume optimization service - ${plan} plan${appliedDiscount ? ` (Discount: ${appliedDiscount})` : ''}`,
            },
            unit_amount: finalPrice,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.CLIENT_URL}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/upload?canceled=true`,
      metadata: {
        resumeId: resumeId.toString(),
        userId: resume.userId.toString(),
        plan: plan,
        appliedDiscount: appliedDiscount || ''
      }
    });

    console.log('Stripe session created:', session.id);
    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout session error:', error);
    res.status(500).json({ 
      error: 'Error creating checkout session',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Stripe webhook handler
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Only log minimal information in production
    console.log('Webhook request received:', new Date().toISOString());
    
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    // Log event type but not full event data in production
    console.log('Processing webhook event type:', event.type);

    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        const amount = session.amount_total / 100;
        const resumeId = parseInt(session.metadata.resumeId);
        
        console.log('Processing successful payment for resume:', resumeId);

        const updatedResume = await prisma.resume.update({
          where: { id: resumeId },
          data: {
            status: 'processing',
            paymentStatus: 'success',
            paymentAmount: amount,
            price: amount,
            stripePaymentIntentId: session.payment_intent
          }
        });

        console.log('Payment processed successfully for resume:', resumeId);
        break;
      
      case 'checkout.session.expired':
        const expiredSession = event.data.object;
        if (expiredSession.metadata?.resumeId) {
          await prisma.resume.update({
            where: { id: parseInt(expiredSession.metadata.resumeId) },
            data: {
              paymentStatus: 'expired',
              status: 'cancelled'
            }
          });
        }
        break;

      case 'payment_intent.payment_failed':
        const paymentIntent = event.data.object;
        if (paymentIntent.metadata?.resumeId) {
          await prisma.resume.update({
            where: { id: parseInt(paymentIntent.metadata.resumeId) },
            data: {
              paymentStatus: 'failed',
              status: 'cancelled'
            }
          });
        }
        break;
    }

    res.json({received: true});
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Check payment status
router.get('/check-payment/:sessionId', async (req, res) => {
  // Add CORS headers
  res.header('Access-Control-Allow-Origin', process.env.CLIENT_URL);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  try {
    const { sessionId } = req.params;
    console.log('Checking payment status for session:', sessionId);

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    console.log('Retrieved session details:', {
      id: session.id,
      status: session.payment_status,
      amount: session.amount_total,
      metadata: session.metadata,
      customer: session.customer
    });

    if (session.payment_status === 'paid') {
      // Update the resume if payment is successful
      const resumeId = parseInt(session.metadata.resumeId);
      const amount = session.amount_total / 100;

      console.log('Updating resume payment details:', {
        resumeId,
        amount,
        paymentStatus: 'success'
      });

      const updatedResume = await prisma.resume.update({
        where: { id: resumeId },
        data: {
          status: 'processing',
          paymentStatus: 'success',
          paymentAmount: amount,
          price: amount,
          stripePaymentIntentId: session.payment_intent
        }
      });

      console.log('Successfully updated resume:', {
        id: updatedResume.id,
        status: updatedResume.status,
        paymentStatus: updatedResume.paymentStatus,
        paymentAmount: updatedResume.paymentAmount
      });

      // Send a more detailed response
      return res.json({
        status: session.payment_status,
        amount: session.amount_total / 100,
        metadata: session.metadata,
        resumeStatus: updatedResume.status,
        paymentStatus: updatedResume.paymentStatus
      });
    }

    res.json({
      status: session.payment_status,
      amount: session.amount_total / 100,
      metadata: session.metadata
    });
  } catch (error) {
    console.error('Error checking payment status:', error);
    res.status(500).json({ error: 'Error checking payment status', details: error.message });
  }
});

module.exports = router; 