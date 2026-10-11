// Public downtime report: pingwatch.org/r/<slug>
// The slug is random, so reports can't be guessed or listed. Not indexed by search engines.

const { createClient } = require('@supabase/supabase-js');

const SITE_URL = (process.env.SITE_URL || 'https://pingwatch.org').replace(/\/+$/, '');

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fmtDuration(secs) {
  if (secs == null) return null;
  const m = Math.max(1, Math.round(secs / 60));
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `~${h} h ${rest} min` : `~${h} h`;
}

function fmtDateUTC(iso) {
  const d = new Date(iso);
  return d.toUTCString().replace(/:\d\d GMT$/, ' UTC');
}

function page({ title, body, status = 200 }) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'public, max-age=60',
    },
    body: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  :root { --bg:#f7f8fa; --card:#ffffff; --text:#111827; --muted:#6b7280; --border:#e5e7eb; --ok:#16a34a; --bad:#dc2626; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b1220; --card:#111827; --text:#e5e7eb; --muted:#9ca3af; --border:#1f2937; --ok:#22c55e; --bad:#f87171; --accent:#60a5fa; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: Inter, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height:1.5; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 32px 16px 48px; }
  .brand { font-weight:700; color:var(--text); text-decoration:none; font-size:15px; }
  .brand span { color: var(--accent); }
  h1 { font-size: 26px; margin: 24px 0 4px; word-break: break-word; }
  .sub { color: var(--muted); font-size: 14px; margin: 0 0 24px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:20px; margin-bottom:16px; }
  .stats { display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; }
  .stat .v { font-size: 24px; font-weight: 700; }
  .stat .l { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  table { width:100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align:left; padding: 10px 6px; border-top: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; border-top: none; }
  .cta { border-color: var(--accent); }
  .cta h2 { margin: 0 0 6px; font-size: 18px; }
  .cta p { margin: 0 0 14px; color: var(--muted); }
  .btn { display:inline-block; background: var(--accent); color:#fff; text-decoration:none; padding: 11px 20px; border-radius: 10px; font-weight: 600; }
  .foot { color: var(--muted); font-size: 12px; margin-top: 24px; }
  a { color: var(--accent); }
  .m-reason { display:none; color: var(--muted); font-size: 12px; }
  @media (max-width: 520px) {
    .stat .v { font-size: 18px; } .stat .l { font-size: 11px; }
    th:nth-child(3), td:nth-child(3) { display:none; }
    .m-reason { display:block; }
  }
</style>
</head>
<body>
<div class="wrap">
<a class="brand" href="${SITE_URL}/">Ping<span>Watch</span></a>
${body}
</div>
<script>
  // Show times in the visitor's own time zone.
  document.querySelectorAll('time[datetime]').forEach(function (el) {
    try {
      var d = new Date(el.getAttribute('datetime'));
      el.textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {}
  });
</script>
</body>
</html>`,
  };
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  let slug = qs.slug || '';
  if (!slug) {
    const m = /\/r\/([A-Za-z0-9_-]+)/.exec(event.path || '');
    if (m) slug = m[1];
  }
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(slug)) {
    return page({ title: 'Report not found — PingWatch', status: 404, body: '<h1>Report not found</h1><p class="sub">This link is wrong or the report was removed.</p>' });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  );

  const { data: site } = await sb
    .from('outreach_sites')
    .select('id, domain, url, created_at, last_status, last_checked_at, checks_total, checks_up')
    .eq('report_slug', slug)
    .maybeSingle();

  if (!site) {
    return page({ title: 'Report not found — PingWatch', status: 404, body: '<h1>Report not found</h1><p class="sub">This link is wrong or the report was removed.</p>' });
  }

  const { data: incidents } = await sb
    .from('outreach_incidents')
    .select('started_at, resolved_at, duration_seconds, error_reason, error_details, status_code')
    .eq('site_id', site.id)
    .order('started_at', { ascending: false })
    .limit(50);

  const list = incidents || [];
  const uptime = site.checks_total > 0 ? (100 * site.checks_up) / site.checks_total : null;
  const uptimeTxt = uptime == null ? '—' : `${uptime >= 99.995 ? '100' : uptime.toFixed(2)}%`;
  const totalDown = list.reduce((sum, i) => sum + (i.duration_seconds || 0), 0);
  const isDown = site.last_status === 'DOWN';

  const rowsHtml = list.length
    ? list.map((i) => {
        const dur = i.resolved_at ? fmtDuration(i.duration_seconds) : '<span class="bad">ongoing</span>';
        const reason = [i.error_reason, i.status_code ? `HTTP ${i.status_code}` : null].filter(Boolean).join(' · ');
        return `<tr>
          <td><time datetime="${esc(i.started_at)}">${esc(fmtDateUTC(i.started_at))}</time></td>
          <td>${i.resolved_at ? esc(dur) : dur}<div class="m-reason">${esc(reason || 'Unreachable')}</div></td>
          <td>${esc(reason || 'Unreachable')}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="3" class="sub">No outages recorded so far. 🎉</td></tr>';

  const signupUrl = `${SITE_URL}/?ref=report&url=${encodeURIComponent(site.url)}#start`;

  const body = `
<h1>Uptime report: ${esc(site.domain)}</h1>
<p class="sub">Automated checks of the homepage since <time datetime="${esc(site.created_at)}">${esc(fmtDateUTC(site.created_at))}</time>.
${site.last_checked_at ? `Last check: <time datetime="${esc(site.last_checked_at)}">${esc(fmtDateUTC(site.last_checked_at))}</time>.` : ''}</p>

<div class="card">
  <div class="stats">
    <div class="stat"><div class="v ${isDown ? 'bad' : 'ok'}">${isDown ? '● Down' : '● Online'}</div><div class="l">Right now</div></div>
    <div class="stat"><div class="v">${esc(uptimeTxt)}</div><div class="l">Uptime</div></div>
    <div class="stat"><div class="v">${list.length}</div><div class="l">Outages</div></div>
  </div>
  ${totalDown > 0 ? `<p class="sub" style="margin:14px 0 0">Total time offline: <b>${esc(fmtDuration(totalDown))}</b>. During that time visitors saw an error instead of the site.</p>` : ''}
</div>

<div class="card">
  <table>
    <thead><tr><th>Went down</th><th>Duration</th><th>Reason</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p class="sub" style="margin:12px 0 0;font-size:12px">Durations are approximate: the site is checked every few minutes, and an outage is only counted after a second failed check.</p>
</div>

<div class="card cta">
  <h2>Know about the next outage in minutes — not days later</h2>
  <p>PingWatch checks your site 24/7 and messages you on Telegram, email, Discord or Slack the moment it goes down — with the reason — and again when it's back. Free for 2 sites, no credit card.</p>
  <a class="btn" style="color:#fff" href="${esc(signupUrl)}">Start monitoring ${esc(site.domain)} free →</a>
</div>

<p class="foot">This report is based on public, automated checks of ${esc(site.domain)} and is visible only to people who have the link.
Want it removed? Email <a href="mailto:${esc(process.env.SUPPORT_EMAIL || 'smetanka939@gmail.com')}">${esc(process.env.SUPPORT_EMAIL || 'smetanka939@gmail.com')}</a> and it will be deleted.</p>`;

  return page({ title: `Uptime report: ${site.domain} — PingWatch`, body });
};
