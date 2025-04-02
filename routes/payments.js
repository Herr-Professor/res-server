const express = require('express');
const { PrismaClient } = require('@prisma/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const router = express.Router();
const prisma = new PrismaClient();

// Service configuration with placeholder Stripe price IDs and pricing details
const serviceConfig = {
  subscription: {
    priceId: 'price_xxx', // Replace with actual Stripe price ID for $15/month
    description: 'Monthly Subscription (Unlimited Access)',
    recurring: true,
    amount: 1500 // $15.00 in cents (for reference, not used directly in subscription)
  },
  professionalReview: {
    priceId: 'price_yyy', // Replace with actual Stripe price ID for $25
    description: 'Professional Resume Review',
    recurring: false,
    amount: 2500 // $25.00 in cents
  },
  atsReport: {
    priceId: 'price_zzz', // Replace with actual Stripe price ID for $5
    description: 'Detailed ATS Report',
    recurring: false,
    amount: 500 // $5.00 in cents
  },
  keywordOpt: {
    priceId: 'price_aaa', // Replace with actual Stripe price ID for $5
    description: 'Keyword Optimization',
    recurring: false,
    amount: 500 // $5.00 in cents
  },
  tailoredSuggestions: {
    priceId: 'price_bbb', // Replace with actual Stripe price ID for $5
    description: 'Tailored Suggestions',
    recurring: false,
    amount: 500 // $5.00 in cents
  }
};

// Discount codes configuration
const DISCOUNT_CODES = {
  'tonfans25': 0.5 // 50% off for one-time payments
};

/**
 * Test endpoint to verify Stripe configuration
 */
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

/**
 * Create a checkout session for subscriptions or one-time services
 */
router.post('/create-checkout-session', async (req, res) => {
  try {
    console.log('Received checkout request:', req.body);
    const { serviceType, userId, resumeId, discountCode } = req.body;

    // Validate required fields
    if (!serviceType || !userId) {
      console.log('Missing required fields:', { serviceType, userId });
      return res.status(400).json({ error: 'Missing required fields: serviceType and userId' });
    }

    // Validate serviceType
    const service = serviceConfig[serviceType];
    if (!service) {
      console.log('Invalid service type:', serviceType);
      return res.status(400).json({ error: 'Invalid service type' });
    }

    // Check user existence
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    if (!user) {
      console.log('User not found:', userId);
      return res.status(404).json({ error: 'User not found' });
    }

    // Apply discount for one-time payments
    let finalPrice = service.amount;
    let appliedDiscount = null;
    if (!service.recurring && discountCode && DISCOUNT_CODES[discountCode]) {
      const discountMultiplier = DISCOUNT_CODES[discountCode];
      finalPrice = Math.round(finalPrice * (1 - discountMultiplier));
      appliedDiscount = discountCode;
    }

    console.log('Creating checkout session:', {
      serviceType,
      mode: service.recurring ? 'subscription' : 'payment',
      price: service.recurring ? '$15/month' : `${finalPrice / 100} USD`,
      discount: appliedDiscount
    });

    // Configure Stripe checkout session
    const sessionConfig = {
      payment_method_types: ['card'],
      line_items: [{
        price: service.recurring ? service.priceId : undefined,
        price_data: !service.recurring ? {
          currency: 'usd',
          product_data: {
            name: service.description,
            description: appliedDiscount ? `Discount applied: ${appliedDiscount}` : undefined
          },
          unit_amount: finalPrice
        } : undefined,
        quantity: 1
      }],
      mode: service.recurring ? 'subscription' : 'payment',
      success_url: `${process.env.CLIENT_URL}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/dashboard?canceled=true`,
      metadata: {
        serviceType,
        userId: userId.toString(),
        resumeId: resumeId?.toString() || '',
        appliedDiscount: appliedDiscount || ''
      }
    };

    const session = await stripe.checkout.sessions.create(sessionConfig);
    console.log('Stripe session created:', session.id);
    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout session error:', error);
    res.status(500).json({
      error: 'Error creating checkout session',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

/**
 * Stripe webhook handler for processing payment events
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    console.log('Webhook request received:', new Date().toISOString());

    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    console.log('Processing webhook event type:', event.type);

    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        const { serviceType, userId, resumeId } = session.metadata;
        const amount = session.amount_total / 100;

        if (serviceType === 'subscription') {
          await prisma.user.update({
            where: { id: parseInt(userId) },
            data: {
              subscriptionId: session.subscription,
              subscriptionStatus: 'active'
            }
          });
          console.log('Subscription activated for user:', userId);
        } else if (resumeId) {
          await prisma.resume.update({
            where: { id: parseInt(resumeId) },
            data: {
              status: 'processing',
              paymentStatus: 'success',
              paymentAmount: amount,
              price: amount,
              stripePaymentIntentId: session.payment_intent
            }
          });
          console.log('Payment processed for resume:', resumeId);
        } else {
          await prisma.servicePurchase.create({
            data: {
              userId: parseInt(userId),
              serviceType,
              paymentStatus: 'success',
              amount
            }
          });
          console.log('Service purchase recorded:', { userId, serviceType });
        }
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
          console.log('Session expired for resume:', expiredSession.metadata.resumeId);
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
          console.log('Payment failed for resume:', paymentIntent.metadata.resumeId);
        }
        break;

      case 'customer.subscription.deleted':
        const subscription = event.data.object;
        const user = await prisma.user.findFirst({
          where: { subscriptionId: subscription.id }
        });
        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { subscriptionStatus: 'inactive' }
          });
          console.log('Subscription cancelled for user:', user.id);
        }
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

/**
 * Check payment status for a given session ID
 */
router.get('/check-payment/:sessionId', async (req, res) => {
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
      metadata: session.metadata
    });

    if (session.payment_status === 'paid') {
      const { serviceType, userId, resumeId } = session.metadata;
      const amount = session.amount_total / 100;

      if (serviceType === 'subscription') {
        const updatedUser = await prisma.user.update({
          where: { id: parseInt(userId) },
          data: {
            subscriptionId: session.subscription,
            subscriptionStatus: 'active'
          }
        });
        return res.json({
          status: session.payment_status,
          amount,
          metadata: session.metadata,
          subscriptionStatus: updatedUser.subscriptionStatus
        });
      } else if (resumeId) {
        const updatedResume = await prisma.resume.update({
          where: { id: parseInt(resumeId) },
          data: {
            status: 'processing',
            paymentStatus: 'success',
            paymentAmount: amount,
            price: amount,
            stripePaymentIntentId: session.payment_intent
          }
        });
        return res.json({
          status: session.payment_status,
          amount,
          metadata: session.metadata,
          resumeStatus: updatedResume.status,
          paymentStatus: updatedResume.paymentStatus
        });
      } else {
        const servicePurchase = await prisma.servicePurchase.create({
          data: {
            userId: parseInt(userId),
            serviceType,
            paymentStatus: 'success',
            amount
          }
        });
        return res.json({
          status: session.payment_status,
          amount,
          metadata: session.metadata,
          servicePurchaseId: servicePurchase.id
        });
      }
    }

    res.json({
      status: session.payment_status,
      amount: session.amount_total / 100,
      metadata: session.metadata
    });
  } catch (error) {
    console.error('Error checking payment status:', error);
    res.status(500).json({
      error: 'Error checking payment status',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
  }
});

module.exports = router;
