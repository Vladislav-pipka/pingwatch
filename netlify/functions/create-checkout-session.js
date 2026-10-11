const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { plan, user_id, email } = JSON.parse(event.body);

    const PRICE_IDS = {
      pro: 'price_1TVJBKH6KbqcVzkR4KnfydIi',
      unlimited: 'price_1TVJBLH6KbqcVzkRWXldbzfe',
    };

    if (!PRICE_IDS[plan]) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid plan' }),
      };
    }

    const SITE_URL = (process.env.SITE_URL || 'https://pingwatch.org').replace(/\/+$/, '');

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email || undefined,
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
      success_url: `${SITE_URL}/dashboard?subscribed=true`,
      cancel_url: `${SITE_URL}/pricing`,
      metadata: {
        userId: user_id || '',
        plan: plan || 'free',
      },
      // Keep the plan on the subscription itself, so later "subscription.updated" events know it.
      subscription_data: {
        metadata: { userId: user_id || '', plan: plan || 'free' },
      },
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
