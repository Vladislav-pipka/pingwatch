// Verifies the Supabase access token sent by the browser (Authorization: Bearer <token>).
// Never trust a user_id coming from the request body — anyone can send any id.

function getBearer(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

async function getUserFromEvent(sb, event) {
  const token = getBearer(event);
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

function isAdmin(user) {
  if (!user || !user.email) return false;
  const list = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(user.email.toLowerCase());
}

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

module.exports = { getBearer, getUserFromEvent, isAdmin, json };
