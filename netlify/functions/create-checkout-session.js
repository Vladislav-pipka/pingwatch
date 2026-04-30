const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { plan, userId } = JSON.parse(event.body);

    const PRICE_IDS = {
      pro: 'price_1TS0fHH7w95uyPVpwlIDBr7R',
      unlimited: 'price_1TS0frH7w95uyPVpqseFCoQz',
    };

    if (!PRICE_IDS[plan]) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid plan' }),
      };
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
      success_url: 'https://pingwatch.netlify.app/dashboard?subscribed=true',
      cancel_url: 'https://pingwatch.netlify.app/pricing',
      metadata: { userId: userId || '' },
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
