const express = require('express');
const { PrismaClient } = require('@prisma/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const router = express.Router();
const prisma = new PrismaClient();

// Updated service configuration aligned with schema and Resopt.txt
const serviceConfig = {
  subscription: {
    priceId: process.env.STRIPE_PRICE_ID_SUBSCRIPTION || 'price_sub_placeholder', // Use env var or placeholder
    description: 'Premium Subscription ($15/month)',
    recurring: true,
    amount: 1500 // $15.00 in cents (for reference)
  },
  review: { // Changed from professionalReview
    priceId: process.env.STRIPE_PRICE_ID_REVIEW || 'price_review_placeholder', // Use env var or placeholder
    description: 'Professional Resume Review ($30)',
    recurring: false,
    amount: 3000 // $30.00 in cents
  },
  ppu_ats: { // Changed from atsReport
    priceId: process.env.STRIPE_PRICE_ID_PPU_ATS || 'price_ppu_ats_placeholder', // Use env var or placeholder
    description: 'Pay-Per-Use: Detailed ATS Report ($5)',
    recurring: false,
    amount: 500 // $5.00 in cents
  },
  ppu_optimization: { // Changed from keywordOpt/tailoredSuggestions
    priceId: process.env.STRIPE_PRICE_ID_PPU_OPT || 'price_ppu_opt_placeholder', // Use env var or placeholder
    description: 'Pay-Per-Use: Job-Specific Optimization ($5)',
    recurring: false,
    amount: 500 // $5.00 in cents
  }
  // Removed keywordOpt and tailoredSuggestions as they are covered by ppu_optimization
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
    const { serviceType, userId, resumeId, discountCode } = req.body; // resumeId is needed for 'review'

    // Validate required fields
    if (!serviceType || !userId) {
      console.log('Missing required fields:', { serviceType, userId });
      return res.status(400).json({ error: 'Missing required fields: serviceType and userId' });
    }
    // Validate resumeId specifically for review service
    if (serviceType === 'review' && !resumeId) {
        console.log('Missing resumeId for review service:', { serviceType, userId, resumeId });
        return res.status(400).json({ error: 'Missing required field: resumeId is required for review service' });
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
      success_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`, // Added default client URL
      cancel_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/dashboard?canceled=true`, // Added default client URL
      customer_email: user.email, // Pre-fill email
      metadata: {
        serviceType,
        userId: userId.toString(),
        // Only include resumeId if it's relevant (e.g., for reviews)
        resumeId: serviceType === 'review' ? resumeId.toString() : '',
        appliedDiscount: appliedDiscount || ''
      }
    };

    // Add subscription-specific configuration if needed
    if (service.recurring) {
      sessionConfig.subscription_data = {
        // Add trial period, etc., if needed in the future
        // trial_period_days: 30
      };
      // If user already has a Stripe customer ID, use it
      // This helps manage subscriptions under one customer in Stripe
      // You might need to store stripeCustomerId on your User model
      // const existingStripeCustomerId = user.stripeCustomerId;
      // if (existingStripeCustomerId) {
      //   sessionConfig.customer = existingStripeCustomerId;
      // } else {
      //   sessionConfig.customer_email = user.email;
      // }
    }

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
        // Ensure metadata exists before destructuring
        const metadata = session.metadata;
        if (!metadata) {
          console.error('Webhook Error: Checkout session completed event missing metadata!', { sessionId: session.id });
          return res.status(400).json({ error: 'Webhook error: Missing metadata' });
        }
        const { serviceType, userId, resumeId } = metadata;
        const parsedUserId = parseInt(userId);
        const parsedResumeId = resumeId ? parseInt(resumeId) : null;

        console.log('Webhook checkout.session.completed processing:', { serviceType, userId: parsedUserId, resumeId: parsedResumeId, sessionId: session.id });

        if (!parsedUserId) {
             console.error('Webhook Error: Invalid or missing userId in metadata!', { metadata });
             return res.status(400).json({ error: 'Webhook error: Invalid userId' });
        }

        // Handle based on serviceType from metadata
        if (serviceType === 'subscription') {
          await prisma.user.update({
            where: { id: parsedUserId },
            data: {
              stripeSubscriptionId: session.subscription, // Correct field from session for subscriptions
              subscriptionStatus: 'premium' // Updated status
            }
          });
          console.log(`Subscription activated for user: ${parsedUserId}`);

        } else if (serviceType === 'ppu_ats') {
           await prisma.user.update({
             where: { id: parsedUserId },
             data: {
               ppuAtsCredits: { increment: 1 } // Increment credits
             }
           });
           console.log(`PPU ATS credit added for user: ${parsedUserId}`);

        } else if (serviceType === 'ppu_optimization') {
          await prisma.user.update({
             where: { id: parsedUserId },
             data: {
               ppuOptimizationCredits: { increment: 1 } // Increment credits
             }
           });
          console.log(`PPU Optimization credit added for user: ${parsedUserId}`);

        } else if (serviceType === 'review') {
            if (!parsedResumeId) {
                console.error('Webhook Error: resumeId missing in metadata for review service!', { metadata });
                // Optionally handle this case - maybe log or notify admin
                return res.status(400).json({ error: 'Webhook error: Missing resumeId for review' });
            }
            // Create ReviewOrder and update Resume status within a transaction
            try {
               await prisma.$transaction(async (tx) => {
                 // 1. Create the ReviewOrder
                 await tx.reviewOrder.create({
                   data: {
                     userId: parsedUserId,
                     resumeId: parsedResumeId,
                     status: 'requested', // Initial status
                     paymentStatus: 'success',
                     stripePaymentIntentId: session.payment_intent // Use payment_intent for one-time payments
                   }
                 });
                 console.log(`ReviewOrder created for user: ${parsedUserId}, resume: ${parsedResumeId}`);

                 // 2. Update the associated Resume status
                 await tx.resume.update({
                   where: { id: parsedResumeId },
                   data: {
                     status: 'pending_review', // Set resume status
                     // Optionally store payment details also on resume if needed, though ReviewOrder is primary
                     // paymentStatus: 'success',
                     // stripePaymentIntentId: session.payment_intent
                   }
                 });
                 console.log(`Resume status updated to pending_review for resume: ${parsedResumeId}`);
               });
            } catch (transactionError) {
               console.error(`Webhook Transaction Error for review service: ${transactionError}`, { userId: parsedUserId, resumeId: parsedResumeId });
               // Decide how to handle transaction failure - potentially refund? Log for manual review.
               return res.status(500).json({ error: 'Webhook error: Failed to process review order transaction' });
            }

        } else {
           // Handle unknown serviceType or log an error
           console.warn(`Webhook Warning: Unhandled serviceType '${serviceType}' in checkout.session.completed`, { metadata });
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
        // Find user by the subscription ID that was cancelled
        const user = await prisma.user.findFirst({
          where: { stripeSubscriptionId: subscription.id } // Use correct field
        });
        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { subscriptionStatus: 'inactive' } // Set status to inactive
          });
          console.log(`Subscription deactivated for user: ${user.id}`);
        } else {
          console.warn(`Webhook Warning: Received customer.subscription.deleted for unknown subscription ID: ${subscription.id}`);
        }
        break;

      // Optional: Handle subscription updates (e.g., plan changes) if needed
      // case 'customer.subscription.updated':
      //   const updatedSubscription = event.data.object;
      //   // Logic to update user plan based on updatedSubscription details
      //   break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    // Return a 200 response to acknowledge receipt of the event
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).send(`Webhook Error: ${error.message}`);
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
