const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// Маппинг Stripe Price ID → название плана
// ВАЖНО: раньше здесь были только старые ID, а checkout использует новые (price_1TVJ...).
// Из-за этого любое "subscription.updated" сбрасывало платного юзера на free.
const PRICE_TO_PLAN = {
  'price_1TVJBKH6KbqcVzkR4KnfydIi': 'pro',        // текущий (create-checkout-session)
  'price_1TVJBLH6KbqcVzkRWXldbzfe': 'unlimited',  // текущий (create-checkout-session)
  'price_1TS0fHH7w95uyPVpwlIDBr7R': 'pro',        // старый
  'price_1TS0frH7w95uyPVpqseFCoQz': 'unlimited',  // старый
};
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Первичная покупка
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const userId = session.metadata?.userId;
    const customerId = session.customer;
    const subscriptionId = session.subscription;
    const plan = session.metadata?.plan || 'free';

    if (userId) {
      await supabase
        .from('users')
        .update({
          plan,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
        })
        .eq('id', userId);
    }
  }

  // Смена плана через Customer Portal
  if (stripeEvent.type === 'customer.subscription.updated') {
    const subscription = stripeEvent.data.object;
    const customerId = subscription.customer;
    const priceId = subscription.items.data[0]?.price?.id;
    const knownPlan = PRICE_TO_PLAN[priceId] || subscription.metadata?.plan;

    if (!ACTIVE_STATUSES.includes(subscription.status)) {
      await supabase.from('users').update({ plan: 'free' }).eq('stripe_customer_id', customerId);
    } else if (knownPlan) {
      await supabase.from('users').update({ plan: knownPlan }).eq('stripe_customer_id', customerId);
    } else {
      // Неизвестная цена — лучше ничего не менять, чем случайно отобрать оплаченный план.
      console.warn(`[stripe-webhook] unknown price ${priceId} for customer ${customerId}, plan unchanged`);
    }
  }

  // Отмена подписки
  if (stripeEvent.type === 'customer.subscription.deleted') {
    const subscription = stripeEvent.data.object;
    const customerId = subscription.customer;

    await supabase
      .from('users')
      .update({ plan: 'free', stripe_subscription_id: null })
      .eq('stripe_customer_id', customerId);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
