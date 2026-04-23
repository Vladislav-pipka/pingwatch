/* ─── Supabase Client (CDN) ──────────────────────────────── */
// Supabase is loaded via CDN in each HTML file. This module
// expects window.SUPABASE_URL and window.SUPABASE_KEY to be set
// before this file is loaded, OR uses the global supabase object.

let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;
  const { createClient } = window.supabase;
  _supabase = createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
  return _supabase;
}

/* ─── Theme Toggle ───────────────────────────────────────── */
function initTheme() {
  const root = document.documentElement;
  let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const saved = sessionStorage.getItem('theme');
  if (saved) theme = saved;
  root.setAttribute('data-theme', theme);
  updateToggleIcon(theme);
}

function updateToggleIcon(theme) {
  const btn = document.querySelector('[data-theme-toggle]');
  if (!btn) return;
  btn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  btn.innerHTML = theme === 'dark'
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
       </svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
       </svg>`;
}

function toggleTheme() {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  sessionStorage.setItem('theme', next);
  updateToggleIcon(next);
}

/* ─── Toast Notifications ────────────────────────────────── */
function showToast(message, type = 'default') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  const icon = type === 'success'
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg>`
    : type === 'error'
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  toast.innerHTML = `${icon}<span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toast-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

/* ─── Auth Helpers ───────────────────────────────────────── */
async function getSession() {
  const sb = getSupabase();
  const { data } = await sb.auth.getSession();
  return data.session;
}

async function getCurrentUser() {
  const sb = getSupabase();
  const { data } = await sb.auth.getUser();
  return data.user;
}

async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = '/index.html';
    return null;
  }
  return session.user;
}

async function signOut() {
  const sb = getSupabase();
  await sb.auth.signOut();
  window.location.href = '/index.html';
}

/* ─── Notification Channel UI Helper ────────────────────── */
function initChannelSelector(selectId, fields) {
  // fields: { telegram: el, discord: el, email: el }
  const select = document.getElementById(selectId);
  if (!select) return;

  function update() {
    const val = select.value;
    Object.entries(fields).forEach(([key, el]) => {
      if (!el) return;
      el.style.display = val === key ? 'flex' : 'none';
    });
  }

  select.addEventListener('change', update);
  update();
}

/* ─── Format Helpers ─────────────────────────────────────── */
function formatRelativeTime(isoString) {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/* ─── Modal Helper ───────────────────────────────────────── */
function openModal(id) {
  const m = document.getElementById(id);
  if (m) { m.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) { m.style.display = 'none'; document.body.style.overflow = ''; }
}

/* Export to global scope for inline handlers */
window.AppUtils = {
  getSupabase, initTheme, toggleTheme, showToast,
  getSession, getCurrentUser, requireAuth, signOut,
  initChannelSelector, formatRelativeTime, formatDuration,
  openModal, closeModal
};
