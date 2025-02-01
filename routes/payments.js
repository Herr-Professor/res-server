const express = require('express');
const { PrismaClient } = require('@prisma/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const router = express.Router();
const prisma = new PrismaClient();

// Create a payment intent
router.post('/create-payment-intent', async (req, res) => {
  try {
    const { plan, resumeId } = req.body;

    // Get price for the plan
    const prices = {
      basic: 500, // $5.00 in cents
      premium: 1000, // $10.00 in cents
      urgent: 2500, // $25.00 in cents
      jobApplication: 15000 // $150.00 in cents
    };

    const amount = prices[plan] || prices.basic;

    // Create a PaymentIntent with the order amount and currency
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata: {
        resumeId,
        plan
      }
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
    console.error('Payment intent creation error:', error);
    res.status(500).json({ error: 'Error creating payment intent' });
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