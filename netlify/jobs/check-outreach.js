// Quietly checks outreach candidate sites (not customers — nobody gets alerts from this).
// Runs on GitHub Actions (free for public repos), NOT on Netlify — on Netlify's free plan
// these checks would eat most of the 300 monthly credits. See .github/workflows/outreach-checks.yml

const { createClient } = require('@supabase/supabase-js');
const { ping, pingConfirmed, runPool } = require('../lib/ping');

const MAX_SITES_PER_RUN = Number(process.env.OUTREACH_MAX_SITES || 3000);
const DEADLINE_MS = Number(process.env.OUTREACH_DEADLINE_MS || 240000);
const CONCURRENCY = Number(process.env.OUTREACH_CONCURRENCY || 40);

exports.handler = async function () {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  );

  const { data: sites, error } = await sb
    .from('outreach_sites')
    .select('id, domain, url, last_status, checks_total, checks_up')
    .eq('is_active', true)
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(MAX_SITES_PER_RUN);

  if (error) {
    console.error('[outreach] fetch failed:', error.message);
    return { statusCode: 500, body: error.message };
  }
  if (!sites || !sites.length) return { statusCode: 200, body: 'no outreach sites' };

  const checked = await runPool(
    sites,
    async (site) => {
      // Re-check failures before we believe them — we must never email someone about a fake outage.
      // No 30s limit on GitHub Actions, so give slow sites a fair 10s (+ a second try).
      const r = (site.last_status === 'DOWN' || site.last_status === 'BROKEN')
        ? await ping(site.url, 10000)
        : await pingConfirmed(site.url, { timeoutMs: 10000, retryDelayMs: 3000, retryTimeoutMs: 10000 });
      return { site, r, at: new Date().toISOString() };
    },
    { concurrency: CONCURRENCY, deadlineMs: DEADLINE_MS }
  );

  const rows = [];
  let down = 0, blocked = 0, dead = 0, broken = 0;

  for (const item of checked) {
    if (!item || item.error || !item.site) continue;
    const { site, r, at } = item;
    // A site that never answered OK since we added it isn't "down" — it's broken/abandoned.
    // Only a site that WAS up and then failed counts as an outage worth emailing about.
    const everUp = (site.checks_up || 0) > 0;
    const prev = (site.last_status === 'DOWN' && !everUp) ? 'BROKEN' : site.last_status;

    const row = {
      id: site.id,
      last_checked_at: at,
      last_status_code: r.status || null,
      last_error: r.up ? null : [r.reason, r.details].filter(Boolean).join(' — '),
      add_total: 1,
      add_up: r.up ? 1 : 0,
      open_incident: false,
      close_incident: false,
    };

    if (r.up) {
      row.last_status = 'UP';
      row.close_incident = prev === 'DOWN';
    } else if (r.botBlocked) {
      // Site blocks robots (Cloudflare challenge, 403...). We can't measure it honestly — stop checking.
      row.last_status = 'BLOCKED';
      row.is_active = false;
      row.add_total = 0;
      row.close_incident = prev === 'DOWN';
      blocked++;
    } else if (prev == null && r.reason === 'DNS failure') {
      // Very first check and the domain doesn't even exist → dead domain, not an outage.
      row.last_status = 'DEAD';
      row.is_active = false;
      row.add_total = 0;
      dead++;
    } else if (prev === 'UP' || prev === 'DOWN') {
      // Real outage: it worked before, now it doesn't.
      row.last_status = 'DOWN';
      row.open_incident = prev === 'UP';
      row.error_reason = r.reason;
      row.error_details = r.details;
      down++;
    } else {
      // Never seen up (first check failed, or still failing since). Keep watching for a while
      // in case it comes back; after ~36 failed checks (≈6 hours) give up on it.
      row.last_status = 'BROKEN';
      if ((site.checks_total || 0) + 1 >= 36) {
        row.last_status = 'DEAD';
        row.is_active = false;
      }
      broken++;
    }
    rows.push(row);
  }

  if (rows.length) {
    const { error: applyErr } = await sb.rpc('pw_outreach_apply', { results: rows });
    if (applyErr) {
      console.error('[outreach] save failed:', applyErr.message);
      return { statusCode: 500, body: applyErr.message };
    }
  }

  const skipped = checked.filter((x) => x === undefined).length;
  console.log(`[outreach] checked=${rows.length} down=${down} broken=${broken} blocked=${blocked} dead=${dead} skipped=${skipped}`);
  return { statusCode: 200, body: JSON.stringify({ checked: rows.length, down, broken, blocked, dead, skipped }) };
};
