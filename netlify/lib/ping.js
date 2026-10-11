// Shared HTTP check logic used by check-monitors and check-outreach.

const SITE_URL = (process.env.SITE_URL || 'https://pingwatch.org').replace(/\/+$/, '');
const USER_AGENT = `Mozilla/5.0 (compatible; PingWatch/1.1; +${SITE_URL})`;

function classifyFailure(status, errMsg, timeoutMs) {
  const msg = (errMsg || '').toLowerCase();

  if (status === 401 || status === 403) return { reason: 'Access denied', details: `HTTP ${status}` };
  if (status === 404) return { reason: 'Page not found', details: 'HTTP 404' };
  if (status === 408) return { reason: 'Request timeout', details: 'HTTP 408 — Server timeout' };
  if (status === 429) return { reason: 'Rate limited', details: 'HTTP 429 — Too Many Requests' };
  if (status === 500) return { reason: 'Internal server error', details: 'HTTP 500' };
  if (status === 502) return { reason: 'Bad gateway', details: 'HTTP 502' };
  if (status === 503) return { reason: 'Service unavailable', details: 'HTTP 503' };
  if (status === 504) return { reason: 'Gateway timeout', details: 'HTTP 504' };
  if (status >= 500) return { reason: 'Server error', details: `HTTP ${status}` };
  if (status >= 400) return { reason: 'Client error', details: `HTTP ${status}` };

  if (msg.includes('aborted') || msg.includes('timeout')) {
    const secs = Math.round((timeoutMs || 10000) / 1000);
    return { reason: 'Request timeout', details: `The server took too long to respond (>${secs}s)` };
  }
  if (msg.includes('enotfound') || msg.includes('getaddrinfo') || msg.includes('dns') || msg.includes('eai_again')) {
    return { reason: 'DNS failure', details: 'Domain could not be resolved' };
  }
  if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls') || msg.includes('cert')) {
    return { reason: 'SSL / TLS error', details: 'Certificate or TLS handshake problem' };
  }
  if (msg.includes('econnrefused') || msg.includes('refused')) {
    return { reason: 'Connection refused', details: 'The server refused the connection' };
  }
  if (msg.includes('econnreset') || msg.includes('reset')) {
    return { reason: 'Connection reset', details: 'The server closed the connection unexpectedly' };
  }
  return { reason: 'Connection failed', details: errMsg || 'Unknown error' };
}

// Node's fetch hides the real cause in err.cause — pull it out so DNS/SSL errors are classified correctly.
function errorText(err) {
  if (!err) return '';
  const parts = [err.name, err.message];
  if (err.cause) parts.push(err.cause.code, err.cause.message);
  return parts.filter(Boolean).join(' ');
}

async function ping(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const responseTime = Date.now() - started;
    // We only need the status — drop the body so the connection is freed.
    try { await res.body?.cancel(); } catch { /* ignore */ }
    clearTimeout(timer);

    // Cloudflare / bot-protection challenge: the site is up, it just blocks robots.
    // 401/403/429 from a public homepage almost always means "robots not welcome", not "site is down".
    const botBlocked = Boolean(res.headers.get('cf-mitigated')) || [401, 403, 429].includes(res.status);

    if (res.status < 400) {
      return { up: true, status: res.status, responseTime, reason: null, details: null, botBlocked: false };
    }
    const f = classifyFailure(res.status, null, timeoutMs);
    return { up: false, status: res.status, responseTime, reason: f.reason, details: f.details, botBlocked };
  } catch (err) {
    clearTimeout(timer);
    const text = errorText(err);
    const f = classifyFailure(0, text, timeoutMs);
    return { up: false, status: 0, responseTime: null, errMsg: text, reason: f.reason, details: f.details, botBlocked: false };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ping, and if it fails, wait a moment and ping again. Only a second failure counts as "down".
// This filters out one-off network blips, which would otherwise cause false alerts.
async function pingConfirmed(url, { timeoutMs = 10000, retryDelayMs = 2000, retryTimeoutMs = 8000 } = {}) {
  const first = await ping(url, timeoutMs);
  if (first.up) return { ...first, retried: false };
  await sleep(retryDelayMs);
  const second = await ping(url, retryTimeoutMs);
  return { ...second, retried: true };
}

// Run async jobs with a concurrency limit and an overall deadline.
// Jobs not started before the deadline are skipped (returned as undefined).
async function runPool(items, worker, { concurrency = 20, deadlineMs = Infinity } = {}) {
  const started = Date.now();
  const results = new Array(items.length);
  let next = 0;

  async function lane() {
    while (next < items.length) {
      if (Date.now() - started > deadlineMs) return;
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

module.exports = { classifyFailure, ping, pingConfirmed, runPool, sleep, SITE_URL, USER_AGENT };
