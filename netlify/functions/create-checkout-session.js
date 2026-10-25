const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { getUserFromEvent } = require('../lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { plan } = JSON.parse(event.body || '{}');

    // Who is paying comes from the login token, not from the request body.
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY);
    const authUser = await getUserFromEvent(sb, event);
    if (!authUser) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in' }) };
    }
    const user_id = authUser.id;
    const email = authUser.email;

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
