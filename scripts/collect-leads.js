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
      out.push({ url: h.url, source: 'Show HN', author: h.author || null, note: `${(h.title || '').slice(0, 160)} (${date})${h.author ? ' by ' + h.author : ''}` });
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

// ── Contact email: homepage, then common contact pages, then the HN author's profile ──
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const BAD_EMAIL = /(\.(png|jpe?g|gif|svg|webp|avif|js|css)$)|example\.|sentry|wixpress|@2x|@3x|u003e|noreply|no-reply|donotreply|domain\.com|email\.com|yourdomain|yoursite|privacy@|abuse@|postmaster@|@sentry/i;
const CONTACT_PATHS = ['/contact', '/about', '/support', '/contact-us', '/impressum', '/imprint'];

function decodeEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// "john [at] site [dot] com", "john (at) site.com", "john at site dot com" → john@site.com
// Pages: only bracketed forms ([at], (at)) — plain " at " would turn "try it at site.com" into a fake address.
// HN profiles (loose): also plain "me at site dot com", which is how people write it there.
function deobfuscate(text, { loose = false } = {}) {
  const at = loose ? /\s*(?:\[at\]|\(at\)|\{at\}|\s+at\s+)\s*/gi : /\s*(?:\[at\]|\(at\)|\{at\})\s*/gi;
  const dot = loose ? /\s*(?:\[dot\]|\(dot\)|\{dot\}|\s+dot\s+)\s*/gi : /\s*(?:\[dot\]|\(dot\)|\{dot\})\s*/gi;
  return decodeEntities(text).replace(at, '@').replace(dot, '.');
}

function extractEmails(html) {
  const found = new Set();
  const text = decodeEntities(html);
  for (const m of text.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    try { found.add(decodeURIComponent(m[1]).toLowerCase()); } catch { /* bad encoding */ }
  }
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0].toLowerCase());
  return [...found].filter((e) => !BAD_EMAIL.test(e) && e.length < 100);
}

function pickEmail(html, domain) {
  const list = extractEmails(html);
  const root = domain.split('.').slice(-2).join('.');
  return list.find((e) => e.endsWith('@' + domain) || e.endsWith('.' + root) || e.endsWith('@' + root)) || list[0] || null;
}

async function fetchText(fetchFn, url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 400000);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// HN user profiles often contain "email: me at site dot com" in the free-text "about".
async function emailFromHnProfile(fetchFn, author) {
  if (!author) return null;
  try {
    const res = await fetchFn(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(author)}.json`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const u = await res.json();
    if (!u || !u.about) return null;
    const list = extractEmails(deobfuscate(u.about.replace(/<[^>]+>/g, ' '), { loose: true }));
    return list[0] || null;
  } catch {
    return null;
  }
}

async function findEmail(fetchFn, site, { author } = {}) {
  const home = await fetchText(fetchFn, site.url);
  if (home) {
    const e = pickEmail(home, site.domain) || pickEmail(deobfuscate(home.replace(/<[^>]+>/g, ' ')), site.domain);
    if (e) return e;
  }
  for (const path of CONTACT_PATHS) {
    const html = await fetchText(fetchFn, site.url + path, 6000);
    if (!html) continue;
    const e = pickEmail(html, site.domain) || pickEmail(deobfuscate(html.replace(/<[^>]+>/g, ' ')), site.domain);
    if (e) return e;
  }
  return emailFromHnProfile(fetchFn, author);
}

// Find the HN author of an already-saved site (for sites collected before we stored authors).
async function hnAuthorForDomain(fetchFn, domain) {
  try {
    const url = `https://hn.algolia.com/api/v1/search?tags=show_hn&restrictSearchableAttributes=url&hitsPerPage=5&query=${encodeURIComponent(domain)}`;
    const data = await getJson(fetchFn, url);
    const hit = (data.hits || []).find((h) => h.url && h.url.toLowerCase().includes(domain));
    return hit ? hit.author : null;
  } catch {
    return null;
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
    byDomain.set(n.domain, { ...n, source: r.source, notes: r.note, author: r.author || null });
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
    await runPool(candidates, async (c) => { c.contact_email = await findEmail(fetchFn, c, { author: c.author }); }, { concurrency: 20, deadlineMs: 360000 });
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

// ── enrich: fill in missing emails for sites we already watch, outage sites first ──
async function enrich({ sb, fetchFn = fetch, env = process.env } = {}) {
  const max = Number(env.LEADS_MAX || 300);
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: incs, error: incErr } = await sb.from('outreach_incidents').select('site_id').gte('started_at', since).limit(5000);
  if (incErr) throw new Error('incidents lookup failed: ' + incErr.message);
  const outageIds = [...new Set((incs || []).map((i) => i.site_id))];

  let sites = [];
  for (let i = 0; i < outageIds.length; i += 300) {
    const { data, error } = await sb.from('outreach_sites').select('id, domain, url, notes, source')
      .in('id', outageIds.slice(i, i + 300)).is('contact_email', null).eq('is_active', true);
    if (error) throw new Error('sites lookup failed: ' + error.message);
    sites = sites.concat(data || []);
  }
  sites = sites.slice(0, max);
  console.log(`[enrich] outage sites without email: ${sites.length}`);

  let found = 0;
  await runPool(sites, async (site) => {
    let author = (/ by ([A-Za-z0-9_-]+)$/.exec(site.notes || '') || [])[1] || null;
    if (!author && site.source === 'Show HN') author = await hnAuthorForDomain(fetchFn, site.domain);
    const email = await findEmail(fetchFn, site, { author });
    if (!email) return;
    const { error } = await sb.from('outreach_sites').update({ contact_email: email }).eq('id', site.id);
    if (!error) found++;
  }, { concurrency: 10, deadlineMs: 480000 });
  return { checked: sites.length, found };
}

module.exports = { collect, enrich, fromHackerNews, fromGitHub, pickEmail, deobfuscate, emailFromHnProfile, __findEmail: findEmail };

if (require.main === module) {
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY);
  const mode = process.env.LEADS_MODE || 'collect';
  const job = mode === 'enrich'
    ? enrich({ sb }).then((r) => console.log(`[enrich] found emails for ${r.found} of ${r.checked} outage sites`))
    : collect({ sb }).then((r) => console.log(`[leads] added ${r.added} new sites (${r.withEmail} with a contact email)`));
  job.catch((e) => { console.error(e); process.exit(1); });
}
