// Telegram bot webhook. Telegram sends every message to the bot here.
// "/start <token>" links the chat to the PingWatch account that created the token.

const { createClient } = require('@supabase/supabase-js');

const SITE_URL = (process.env.SITE_URL || 'https://pingwatch.org').replace(/\/+$/, '');

async function reply(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error('[telegram-webhook] reply failed:', err.message);
  }
}

exports.handler = async (event) => {
  // Telegram always expects 200, otherwise it keeps retrying the same update.
  const ok = { statusCode: 200, body: 'ok' };

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  // Only Telegram knows this secret (set via setWebhook secret_token).
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const got = (event.headers || {})['x-telegram-bot-api-secret-token'];
  if (!expected || got !== expected) {
    return { statusCode: 401, body: 'unauthorized' };
  }

  let update;
  try { update = JSON.parse(event.body || '{}'); } catch { return ok; }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat || typeof msg.text !== 'string') return ok;

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const m = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{8,64}))?$/.exec(text);

  if (!m) {
    await reply(chatId,
      'I send PingWatch downtime alerts here.\n\n' +
      `To connect this chat, open your dashboard at ${SITE_URL}/dashboard and press <b>Connect Telegram</b>.\n\n` +
      `Your chat ID: <code>${chatId}</code>`);
    return ok;
  }

  const linkToken = m[1];
  if (!linkToken) {
    await reply(chatId,
      '👋 Hi! This is the PingWatch alert bot.\n\n' +
      `To get alerts here, sign in at ${SITE_URL} and press <b>Connect Telegram</b> in the dashboard.\n\n` +
      `Your chat ID (for manual setup): <code>${chatId}</code>`);
    return ok;
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  );

  const { data: user, error } = await sb
    .from('users')
    .select('id, email, telegram_link_expires_at')
    .eq('telegram_link_token', linkToken)
    .maybeSingle();

  if (error) {
    console.error('[telegram-webhook] lookup failed:', error.message);
    await reply(chatId, '⚠️ Something went wrong. Please try again in a minute.');
    return ok;
  }

  if (!user || (user.telegram_link_expires_at && new Date(user.telegram_link_expires_at) < new Date())) {
    await reply(chatId, '⌛ This link has expired. Go back to the PingWatch dashboard and press <b>Connect Telegram</b> again.');
    return ok;
  }

  const { error: upErr } = await sb
    .from('users')
    .update({
      telegram_chat_id: chatId,
      notification_channel: 'telegram',
      telegram_link_token: null,
      telegram_link_expires_at: null,
    })
    .eq('id', user.id);

  if (upErr) {
    console.error('[telegram-webhook] update failed:', upErr.message);
    await reply(chatId, '⚠️ Could not connect. Please try again.');
    return ok;
  }

  await reply(chatId,
    '✅ <b>Telegram connected!</b>\n\n' +
    'PingWatch will message you here when one of your sites goes down — and again when it is back up.\n\n' +
    'You can go back to the dashboard now.');
  return ok;
};
