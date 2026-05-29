const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
);

async function notifyTelegram(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

async function notifyDiscord(webhookUrl, text) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text })
  });
}

async function notifySlack(webhookUrl, text) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
}

async function notifyEmail(email, text) {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER || process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASS || process.env.SMTP_PASSWORD
    }
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER || process.env.SMTP_EMAIL,
    to: email,
    subject: '🧪 PingWatch — Test Alert',
    text
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { user_id } = body;
  if (!user_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing user_id' }) };
  }

  const { data: user, error } = await sb
    .from('users')
    .select('notification_channel, telegram_chat_id, discord_webhook_url, slack_webhook_url, notification_email, email')
    .eq('id', user_id)
    .single();

  if (error || !user) {
    return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
  }

  const channel = user.notification_channel || 'email';
  const text = `🧪 PingWatch Test Alert\n\nThis is a test notification from PingWatch. Your ${channel} alerts are working correctly!`;

  try {
    if (channel === 'telegram') {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = user.telegram_chat_id;
      if (!chatId) return { statusCode: 400, body: JSON.stringify({ error: 'Telegram Chat ID not set. Save your channel settings first.' }) };
      await notifyTelegram(token, chatId, text);
    } else if (channel === 'discord') {
      if (!user.discord_webhook_url) return { statusCode: 400, body: JSON.stringify({ error: 'Discord webhook not configured.' }) };
      await notifyDiscord(user.discord_webhook_url, text);
    } else if (channel === 'slack') {
      if (!user.slack_webhook_url) return { statusCode: 400, body: JSON.stringify({ error: 'Slack webhook not configured.' }) };
      await notifySlack(user.slack_webhook_url, text);
    } else if (channel === 'email') {
      const to = user.notification_email || user.email;
      if (!to) return { statusCode: 400, body: JSON.stringify({ error: 'No email address found.' }) };
      await notifyEmail(to, text);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('send-test-alert error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
