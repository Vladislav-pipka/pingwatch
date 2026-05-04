const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { customer_id } = JSON.parse(event.body);

    if (!customer_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No customer_id' }) };
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customer_id,
      return_url: 'https://pingwatch.netlify.app/dashboard.html',
    });

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
