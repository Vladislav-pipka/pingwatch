const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { getUserFromEvent, json } = require('../lib/auth');

// Opens the Stripe billing portal for the LOGGED-IN user only.
// (Before: it trusted a customer id from the request body, and the dashboard sent the
// wrong field name, so "Manage plan" never worked.)
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
    );
    const user = await getUserFromEvent(sb, event);
    if (!user) return json(401, { error: 'Not signed in' });

    const { data, error } = await sb.from('users').select('stripe_customer_id').eq('id', user.id).single();
    if (error || !data || !data.stripe_customer_id) return json(404, { error: 'No active subscription found.' });

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${(process.env.SITE_URL || 'https://pingwatch.org').replace(/\/+$/, '')}/dashboard`,
    });
    return json(200, { url: session.url });
  } catch (err) {
    console.error('[portal]', err.message);
    return json(500, { error: 'Could not open billing portal.' });
  }
};
