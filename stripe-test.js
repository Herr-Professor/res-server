require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function testStripePayment() {
    console.log('Starting Stripe test...');
    console.log('Stripe key prefix:', process.env.STRIPE_SECRET_KEY.substring(0, 8) + '...');

    try {
        // Create a PaymentIntent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: 1000, // $10.00
            currency: 'usd',
            payment_method_types: ['card'],
            metadata: {
                test: 'true',
                description: 'Test payment'
            }
        });

        console.log('Payment Intent created successfully!');
        console.log('Payment Intent ID:', paymentIntent.id);
        console.log('Client Secret:', paymentIntent.client_secret ? 'Present' : 'Missing');
        console.log('Status:', paymentIntent.status);
        console.log('Amount:', paymentIntent.amount);
        console.log('Currency:', paymentIntent.currency);

        // Test retrieving the payment intent
        const retrieved = await stripe.paymentIntents.retrieve(paymentIntent.id);
        console.log('\nSuccessfully retrieved payment intent:', retrieved.id);

    } catch (error) {
        console.error('Error details:');
        console.error('Message:', error.message);
        console.error('Type:', error.type);
        console.error('Code:', error.code);
        if (error.raw) {
            console.error('Raw error:', error.raw);
        }
    }
}

testStripePayment()
    .then(() => console.log('Test complete'))
    .catch(console.error); 