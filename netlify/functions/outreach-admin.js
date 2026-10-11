// Admin API for the outreach dashboard (admin.html). Only emails listed in ADMIN_EMAILS can use it.

const { createClient } = require('@supabase/supabase-js');
const { getUserFromEvent, isAdmin, json } = require('../lib/auth');
const { normalizeSite } = require('../lib/sites');

const STAGES = ['watching', 'contacted', 'replied', 'signed_up', 'not_interested'];
const DAYS = 30;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  );

  const user = await getUserFromEvent(sb, event);
  if (!user) return json(401, { error: 'Not signed in' });
  if (!isAdmin(user)) return json(403, { error: 'Not an admin. Add your email to ADMIN_EMAILS in Netlify.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = body.action;

  // ── me (is the current user an admin?) ────────────────
  if (action === 'me') return json(200, { admin: true });

  // ── list ───────────────────────────────────────────────
  if (action === 'list') {
    const { data: sites, error } = await sb
      .from('outreach_sites')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) return json(500, { error: error.message });

    const since = new Date(Date.now() - DAYS * 86400000).toISOString();
    const { data: incidents, error: incErr } = await sb
      .from('outreach_incidents')
      .select('site_id, started_at, resolved_at, duration_seconds, error_reason, error_details, status_code')
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(10000);
    if (incErr) return json(500, { error: incErr.message });

    const bySite = {};
    for (const inc of incidents || []) (bySite[inc.site_id] ||= []).push(inc);

    const siteUrl = (process.env.SITE_URL || 'https://pingwatch.org').replace(/\/+$/, '');
    return json(200, {
      site_url: siteUrl,
      sites: (sites || []).map((s) => ({
        ...s,
        report_url: `${siteUrl}/r/${s.report_slug}`,
        incidents: (bySite[s.id] || []).slice(0, 10),
        incidents_count: (bySite[s.id] || []).length,
      })),
    });
  }

  // ── add ────────────────────────────────────────────────
  if (action === 'add') {
    const lines = String(body.lines || '').split(/\r?\n/);
    const source = String(body.source || '').trim().slice(0, 200) || null;
    const seen = new Set();
    const rows = [];
    let invalid = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const n = normalizeSite(line);
      if (!n) { invalid++; continue; }
      if (seen.has(n.domain)) continue;
      seen.add(n.domain);
      rows.push({ domain: n.domain, url: n.url, source });
    }
    if (rows.length > 2000) return json(400, { error: 'Max 2000 sites at once.' });
    if (!rows.length) return json(200, { added: 0, duplicates: 0, invalid });

    const { data, error } = await sb
      .from('outreach_sites')
      .upsert(rows, { onConflict: 'domain', ignoreDuplicates: true })
      .select('id');
    if (error) return json(500, { error: error.message });

    const added = (data || []).length;
    return json(200, { added, duplicates: rows.length - added, invalid });
  }

  // ── update ─────────────────────────────────────────────
  if (action === 'update') {
    const id = body.id;
    const f = body.fields || {};
    const patch = {};
    if (typeof f.stage === 'string') {
      if (!STAGES.includes(f.stage)) return json(400, { error: 'Bad stage' });
      patch.stage = f.stage;
      if (f.stage === 'contacted') patch.contacted_at = new Date().toISOString();
    }
    if (typeof f.contact_email === 'string') patch.contact_email = f.contact_email.trim().slice(0, 200) || null;
    if (typeof f.notes === 'string') patch.notes = f.notes.slice(0, 2000) || null;
    if (typeof f.is_active === 'boolean') patch.is_active = f.is_active;
    if (!id || !Object.keys(patch).length) return json(400, { error: 'Nothing to update' });

    const { error } = await sb.from('outreach_sites').update(patch).eq('id', id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  // ── delete ─────────────────────────────────────────────
  if (action === 'delete') {
    if (!body.id) return json(400, { error: 'Missing id' });
    const { error } = await sb.from('outreach_sites').delete().eq('id', body.id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(400, { error: 'Unknown action' });
};

module.exports.normalizeSite = normalizeSite;
