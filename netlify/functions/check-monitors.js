const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

/* ── Fetch with timeout ── */
async function ping(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'PingWatch/1.0 uptime-monitor' },
    });
    clearTimeout(timer);
    return { up: res.ok, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { up: false, status: 0, errMsg: err.message };
  }
}

/* ── Notification senders ── */
async function notifyTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram ${res.status}: ${body}`);
  }
}

async function notifyDiscord(webhookUrl, content) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord ${res.status}: ${body}`);
  }
}

async function notifyEmail(to, subject, text) {
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD,
    },
  });
  await transport.sendMail({
    from: `PingWatch <${process.env.SMTP_EMAIL}>`,
    to,
    subject,
    text,
  });
}

/* ── Dispatch alert to correct channel ── */
async function sendAlert({ channel, telegramChatId, discordWebhookUrl, notificationEmail }, monitor, isDown) {
  const label    = isDown ? '🔴 DOWN' : '🟢 BACK UP';
  const mdText   = `*${monitor.name}* is ${label}\nURL: \`${monitor.url}\`\n🕐 ${new Date().toUTCString()}`;
  const plainText = `${monitor.name} is ${label}\nURL: ${monitor.url}\nTime: ${new Date().toUTCString()}`;

  try {
    if (channel === 'telegram') {
      const token  = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = telegramChatId || process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) throw new Error('Telegram config missing');
      await notifyTelegram(token, chatId, mdText);

    } else if (channel === 'discord') {
      if (!discordWebhookUrl) throw new Error('Discord webhook URL not configured for this user');
      await notifyDiscord(discordWebhookUrl, plainText);

    } else if (channel === 'email') {
      if (!notificationEmail) throw new Error('Notification email not configured for this user');
      const subject = `PingWatch: ${monitor.name} is ${isDown ? 'DOWN' : 'back UP'}`;
      await notifyEmail(notificationEmail, subject, plainText);
    }

    console.log(`[ALERT] channel=${channel} monitor="${monitor.name}" status=${isDown ? 'DOWN' : 'UP'}`);
  } catch (err) {
    // Alert failure must not stop the check loop
    console.error(`[ALERT ERROR] monitor="${monitor.name}" channel=${channel}: ${err.message}`);
  }
}

/* ── Main scheduled handler ── */
exports.handler = async function () {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
    return { statusCode: 500, body: 'Missing Supabase configuration' };
  }

  const sb = createClient(supabaseUrl, supabaseKey);

  /* Fetch all active monitors with their owner's notification settings */
  const { data: monitors, error: fetchErr } = await sb
    .from('monitors')
    .select(`
      id, user_id, url, name, is_active, last_status,
      users (
        notification_channel,
        telegram_chat_id,
        discord_webhook_url,
        notification_email
      )
    `)
    .eq('is_active', true);

  if (fetchErr) {
    console.error('Error fetching monitors:', fetchErr.message);
    return { statusCode: 500, body: fetchErr.message };
  }

  if (!monitors?.length) {
    console.log('No active monitors to check.');
    return { statusCode: 200, body: 'No active monitors' };
  }

  const now     = new Date().toISOString();
  const results = [];

  /* Process in batches of 10 to avoid hitting rate limits */
  const BATCH = 10;
  for (let i = 0; i < monitors.length; i += BATCH) {
    await Promise.all(
      monitors.slice(i, i + BATCH).map(async (monitor) => {
        const { up } = await ping(monitor.url);
        const newStatus  = up ? 'UP' : 'DOWN';
        const prevStatus = monitor.last_status;
        const changed    = prevStatus !== newStatus;

        /* Always update last_status + last_checked_at */
        const { error: updateErr } = await sb
          .from('monitors')
          .update({ last_status: newStatus, last_checked_at: now })
          .eq('id', monitor.id);

        if (updateErr) {
          console.error(`[UPDATE ERR] "${monitor.name}": ${updateErr.message}`);
        }

        if (changed) {
          const user = monitor.users || {};
          const notifParams = {
            channel:            user.notification_channel || 'telegram',
            telegramChatId:     user.telegram_chat_id,
            discordWebhookUrl:  user.discord_webhook_url,
            notificationEmail:  user.notification_email,
          };

          if (newStatus === 'DOWN') {
            /* Open incident */
            const { error: incErr } = await sb.from('incidents').insert({
              monitor_id:       monitor.id,
              started_at:       now,
              resolved_at:      null,
              duration_seconds: null,
            });
            if (incErr) console.error(`[INCIDENT OPEN ERR] ${incErr.message}`);

            /* Send DOWN alert */
            await sendAlert(notifParams, monitor, true);

          } else if (newStatus === 'UP' && prevStatus === 'DOWN') {
            /* Resolve the most recent open incident */
            const { data: openInc } = await sb
              .from('incidents')
              .select('id, started_at')
              .eq('monitor_id', monitor.id)
              .is('resolved_at', null)
              .order('started_at', { ascending: false })
              .limit(1)
              .single();

            if (openInc) {
              const durationSecs = Math.round(
                (new Date(now) - new Date(openInc.started_at)) / 1000
              );
              const { error: resolveErr } = await sb.from('incidents').update({
                resolved_at:      now,
                duration_seconds: durationSecs,
              }).eq('id', openInc.id);

              if (resolveErr) console.error(`[INCIDENT CLOSE ERR] ${resolveErr.message}`);
            }

            /* Send RECOVERY alert */
            await sendAlert(notifParams, monitor, false);
          }
        }

        const line = `[CHECK] "${monitor.name}" → ${newStatus}${changed ? ' (CHANGED)' : ''}`;
        console.log(line);
        results.push({ name: monitor.name, status: newStatus, changed });
      })
    );
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ts: now, checked: results.length, results }),
  };
};
