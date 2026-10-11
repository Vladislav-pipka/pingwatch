// Creates a one-time "connect Telegram" link for the logged-in user.
// The browser opens t.me/<bot>?start=<token>; the bot (telegram-webhook) matches the token
// and saves the user's chat id automatically — no more copying ids from @userinfobot.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { getUserFromEvent, json } = require('../lib/auth');

const LINK_TTL_MINUTES = 30;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  );

  const user = await getUserFromEvent(sb, event);
  if (!user) return json(401, { error: 'Not signed in' });

  const botUsername = (process.env.TELEGRAM_BOT_USERNAME || 'S1te_Watch_Bot').replace(/^@/, '');
  const token = crypto.randomBytes(16).toString('hex'); // 32 chars, allowed in Telegram start params
  const expires = new Date(Date.now() + LINK_TTL_MINUTES * 60 * 1000).toISOString();

  const { error } = await sb
    .from('users')
    .update({ telegram_link_token: token, telegram_link_expires_at: expires })
    .eq('id', user.id);

  if (error) {
    console.error('[telegram-link] update failed:', error.message);
    return json(500, { error: 'Could not create link. Try again.' });
  }

  return json(200, {
    url: `https://t.me/${botUsername}?start=${token}`,
    bot: botUsername,
    expires_at: expires,
  });
};
