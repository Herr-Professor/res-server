router.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount } = req.body;
    
    const baseUrl = process.env.NODE_ENV === 'production'
      ? 'https://resumer-frontend.onrender.com'
      : 'http://localhost:3000';

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount || 1000, // Default to $10.00 if no amount provided
      currency: 'usd',
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'always'
      },
      metadata: {
        userId: req.user.id
      },
      return_url: `${baseUrl}/dashboard`,
      cancel_url: `${baseUrl}/upload`
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      amount: paymentIntent.amount
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
}); 