const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

function formatTime(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date) + ` (${timeZone || 'UTC'})`;
  } catch {
    return date.toUTCString();
  }
}

function classifyFailure(status, errMsg) {
  const msg = (errMsg || '').toLowerCase();

  if (status === 401 || status === 403) return { reason: 'Access denied',        details: `HTTP ${status}` };
  if (status === 404)                   return { reason: 'Page not found',        details: 'HTTP 404' };
  if (status === 429)                   return { reason: 'Rate limited',           details: 'HTTP 429 — Too Many Requests' };
  if (status === 500)                   return { reason: 'Internal server error',  details: 'HTTP 500' };
  if (status === 502)                   return { reason: 'Bad gateway',            details: 'HTTP 502' };
  if (status === 503)                   return { reason: 'Service unavailable',    details: 'HTTP 503' };
  if (status === 504)                   return { reason: 'Gateway timeout',        details: 'HTTP 504' };
  if (status >= 500)                    return { reason: 'Server error',           details: `HTTP ${status}` };

  if (msg.includes('aborted') || msg.includes('timeout'))
    return { reason: 'Request timeout',    details: 'The server took too long to respond (>12s)' };
  if (msg.includes('enotfound') || msg.includes('getaddrinfo') || msg.includes('dns'))
    return { reason: 'DNS failure',        details: 'Domain could not be resolved' };
  if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls') || msg.includes('cert'))
    return { reason: 'SSL / TLS error',    details: 'Certificate or TLS handshake problem' };
  if (msg.includes('econnrefused') || msg.includes('refused'))
    return { reason: 'Connection refused', details: 'The server refused the connection' };
  if (msg.includes('econnreset') || msg.includes('reset'))
    return { reason: 'Connection reset',   details: 'The server closed the connection unexpectedly' };

  return { reason: 'Connection failed', details: errMsg || 'Unknown error' };
}

async function ping(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const started = Date.now();
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'PingWatch/1.0 (+https://pingwatch.netlify.app)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);

    const responseTime = Date.now() - started;
    const up = res.status < 500;

    if (up) {
      return { up: true, status: res.status, responseTime, reason: null, details: null };
    }

    const failure = classifyFailure(res.status);
    return { up: false, status: res.status, responseTime, reason: failure.reason, details: failure.details };

  } catch (err) {
    clearTimeout(timer);
    const failure = classifyFailure(0, err.message);
    return { up: false, status: 0, responseTime: null, errMsg: err.message, reason: failure.reason, details: failure.details };
  }
}

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

async function sendAlert(
  { channel, telegramChatId, discordWebhookUrl, slackWebhookUrl, notificationEmail, timezone },
  monitor,
  isDown,
  checkResult
) {
  const label     = isDown ? '🔴 DOWN' : '🟢 BACK UP';
  const localTime = formatTime(new Date(), timezone);

  const reasonLines = (isDown && checkResult && checkResult.reason)
    ? `\n⚠️ Reason: ${checkResult.reason}` +
      (checkResult.details ? `\n📋 Details: ${checkResult.details}` : '') +
      (checkResult.status  ? `\n🔢 Status: ${checkResult.status}`   : '')
    : '';

  const mdText    = `*${monitor.name}* is ${label}\nURL: \`${monitor.url}\`${reasonLines}\n🕐 ${localTime}`;
  const plainText = `${monitor.name} is ${label}\nURL: ${monitor.url}${reasonLines}\nTime: ${localTime}`;

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
    console.error(`[ALERT ERROR] monitor="${monitor.name}" channel=${channel}: ${err.message}`);
  }
}

exports.handler = async function () {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
    return { statusCode: 500, body: 'Missing Supabase configuration' };
  }

  const sb = createClient(supabaseUrl, supabaseKey);

  const { data: monitors, error: fetchErr } = await sb
    .from('monitors')
    .select(`
      id, user_id, url, name, is_active, last_status,
      users (
        notification_channel,
        telegram_chat_id,
        discord_webhook_url,
        slack_webhook_url,
        notification_email,
        timezone
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

  const BATCH = 10;
  for (let i = 0; i < monitors.length; i += BATCH) {
    await Promise.all(
      monitors.slice(i, i + BATCH).map(async (monitor) => {
        const checkResult = await ping(monitor.url);
        const { up }      = checkResult;
        const newStatus   = up ? 'UP' : 'DOWN';
        const prevStatus  = monitor.last_status;
        const changed     = prevStatus !== newStatus;

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
            channel:           user.notification_channel || 'telegram',
            telegramChatId:    user.telegram_chat_id,
            discordWebhookUrl: user.discord_webhook_url,
            slackWebhookUrl:   user.slack_webhook_url,
            notificationEmail: user.notification_email,
            timezone:          user.timezone || 'UTC',
          };

          if (newStatus === 'DOWN') {
            const { error: incErr } = await sb.from('incidents').insert({
              monitor_id:       monitor.id,
              started_at:       now,
              resolved_at:      null,
              duration_seconds: null,
            });
            if (incErr) console.error(`[INCIDENT OPEN ERR] ${incErr.message}`);

            await sendAlert(notifParams, monitor, true, checkResult);

          } else if (newStatus === 'UP' && prevStatus === 'DOWN') {
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

            await sendAlert(notifParams, monitor, false, checkResult);
          }
        }

        const reasonTag = (!up && checkResult.reason) ? ` | ${checkResult.reason}` : '';
        console.log(`[CHECK] "${monitor.name}" → ${newStatus}${changed ? ' (CHANGED)' : ''}${reasonTag}`);
        results.push({ name: monitor.name, status: newStatus, changed, reason: checkResult.reason || null });
      })
    );
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ts: now, checked: results.length, results }),
  };
};
