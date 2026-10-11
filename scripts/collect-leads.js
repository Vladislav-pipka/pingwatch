// Collects outreach candidates: small, young projects whose owners care about uptime
// (indie hackers, startups, freelancers). Runs on GitHub Actions — see
// .github/workflows/collect-leads.yml. New sites go straight into outreach_sites.
//
// Sources (public APIs only):
//   hn      — "Show HN" posts on Hacker News (people launching their own projects)
//   github  — homepages of GitHub repos tagged saas / side-project / indie-hacker / startup
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEY, GITHUB_TOKEN (optional, higher rate limit)
//      LEADS_SOURCES=hn,github  LEADS_DAYS=120  LEADS_MAX=500  LEADS_EMAILS=1

const { normalizeSite, isBlockedDomain } = require('../netlify/lib/sites');
const { runPool } = require('../netlify/lib/ping');

const UA = 'Mozilla/5.0 (compatible; PingWatch/1.1; +https://pingwatch.org)';
const GITHUB_TOPICS = ['saas', 'micro-saas', 'side-project', 'indie-hacker', 'indiehackers', 'startup'];

async function getJson(fetchFn, url, headers = {}) {
  const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// ── Hacker News: Show HN posts, walking back in time (Algolia caps one query at 1000 hits) ──
async function fromHackerNews(fetchFn, { days, limit }) {
  const from = Math.floor(Date.now() / 1000) - days * 86400;
  let cursor = Math.floor(Date.now() / 1000) + 60;
  const out = [];
  for (let round = 0; round < 30 && out.length < limit; round++) {
    const url = 'https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=1000'
      + `&numericFilters=${encodeURIComponent(`created_at_i>${from},created_at_i<${cursor}`)}`;
    const data = await getJson(fetchFn, url);
    const hits = data.hits || [];
    if (!hits.length) break;
    for (const h of hits) {
      if (!h.url) continue;
      const date = h.created_at ? h.created_at.slice(0, 10) : '';
      out.push({ url: h.url, source: 'Show HN', note: `${(h.title || '').slice(0, 160)} (${date})` });
    }
    const oldest = Math.min(...hits.map((h) => h.created_at_i || cursor));
    if (oldest >= cursor) break;
    cursor = oldest;
  }
  return out;
}

// ── GitHub: repos with a homepage, recently active ──
async function fromGitHub(fetchFn, { days, limit, token }) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const out = [];
  for (const topic of GITHUB_TOPICS) {
    for (let page = 1; page <= 3 && out.length < limit; page++) {
      const q = encodeURIComponent(`topic:${topic} pushed:>${since}`);
      const url = `https://api.github.com/search/repositories?q=${q}&sort=updated&order=desc&per_page=100&page=${page}`;
      let data;
      try { data = await getJson(fetchFn, url, headers); } catch (e) { console.warn('[github]', e.message); break; }
      const items = data.items || [];
      for (const r of items) {
        if (!r.homepage || r.fork || r.archived) continue;
        out.push({ url: r.homepage, source: `GitHub #${topic}`, note: `${r.full_name} — ${(r.description || '').slice(0, 120)}` });
      }
      if (items.length < 100) break;
    }
  }
  return out;
}

// ── Contact email from the homepage (public mailto / visible address) ──
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const BAD_EMAIL = /(\.(png|jpe?g|gif|svg|webp|avif)$)|example\.|sentry|wixpress|@2x|@3x|u003e|noreply|no-reply|domain\.com|email\.com|yourdomain|privacy@|abuse@/i;

function pickEmail(html, domain) {
  const found = new Set();
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) found.add(decodeURIComponent(m[1]).toLowerCase());
  for (const m of html.matchAll(EMAIL_RE)) found.add(m[0].toLowerCase());
  const list = [...found].filter((e) => !BAD_EMAIL.test(e) && e.length < 100);
  const root = domain.split('.').slice(-2).join('.');
  return list.find((e) => e.endsWith('@' + domain) || e.endsWith('.' + root) || e.endsWith('@' + root)) || list[0] || null;
}

async function findEmail(fetchFn, site) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchFn(site.url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 400000);
    return pickEmail(html, site.domain);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── main ──
async function collect({ sb, fetchFn = fetch, env = process.env } = {}) {
  const sources = String(env.LEADS_SOURCES || 'hn,github').split(',').map((s) => s.trim()).filter(Boolean);
  const days = Number(env.LEADS_DAYS || 120);
  const max = Number(env.LEADS_MAX || 500);
  const withEmails = String(env.LEADS_EMAILS || '1') !== '0';

  let raw = [];
  if (sources.includes('hn')) {
    try { raw = raw.concat(await fromHackerNews(fetchFn, { days, limit: max * 4 })); } catch (e) { console.warn('[hn]', e.message); }
  }
  if (sources.includes('github')) {
    raw = raw.concat(await fromGitHub(fetchFn, { days, limit: max * 2, token: env.GITHUB_TOKEN }));
  }
  console.log(`[leads] raw candidates: ${raw.length}`);

  // normalize, filter, dedupe
  const byDomain = new Map();
  for (const r of raw) {
    const n = normalizeSite(r.url);
    if (!n || isBlockedDomain(n.domain) || byDomain.has(n.domain)) continue;
    byDomain.set(n.domain, { ...n, source: r.source, notes: r.note });
  }
  let candidates = [...byDomain.values()];

  // skip domains we already have
  const domains = candidates.map((c) => c.domain);
  const existing = new Set();
  for (let i = 0; i < domains.length; i += 300) {
    const { data, error } = await sb.from('outreach_sites').select('domain').in('domain', domains.slice(i, i + 300));
    if (error) throw new Error('lookup failed: ' + error.message);
    (data || []).forEach((d) => existing.add(d.domain));
  }
  candidates = candidates.filter((c) => !existing.has(c.domain)).slice(0, max);
  console.log(`[leads] new after filters: ${candidates.length}`);
  if (!candidates.length) return { added: 0, withEmail: 0 };

  if (withEmails) {
    await runPool(candidates, async (c) => { c.contact_email = await findEmail(fetchFn, c); }, { concurrency: 20, deadlineMs: 240000 });
  }

  let added = 0;
  for (let i = 0; i < candidates.length; i += 500) {
    const rows = candidates.slice(i, i + 500).map((c) => ({
      domain: c.domain, url: c.url, source: c.source, notes: c.notes || null, contact_email: c.contact_email || null,
    }));
    const { data, error } = await sb.from('outreach_sites').upsert(rows, { onConflict: 'domain', ignoreDuplicates: true }).select('id');
    if (error) throw new Error('insert failed: ' + error.message);
    added += (data || []).length;
  }
  const withEmail = candidates.filter((c) => c.contact_email).length;
  return { added, withEmail };
}

module.exports = { collect, fromHackerNews, fromGitHub, pickEmail };

if (require.main === module) {
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY);
  collect({ sb })
    .then((r) => console.log(`[leads] added ${r.added} new sites (${r.withEmail} with a contact email)`))
    .catch((e) => { console.error(e); process.exit(1); });
}
