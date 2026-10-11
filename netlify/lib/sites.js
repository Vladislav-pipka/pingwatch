// Shared helpers for outreach sites: URL normalization and "is this worth watching" filters.

// "https://www.Shop.lv/about?x=1" → { domain: "shop.lv", url: "https://www.shop.lv" }
function normalizeSite(raw) {
  let s = String(raw || '').trim();
  if (!s || s.startsWith('#')) return null;
  s = s.split(/[\s,;]+/)[0];
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.length > 253 || /[^a-z0-9.-]/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost') return null;
  return { domain: host.replace(/^www\./, ''), url: `${u.protocol}//${host}` };
}

// Domains that are not "someone's own site": code hosts, app stores, social networks,
// big platforms (they never go down / nobody there would buy monitoring), and free hosting
// subdomains (static ones never go down; sleeping free tiers like Render/Heroku would look
// "down" on every cold start — a false outage we must never email about).
const BLOCKED = [
  'github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sr.ht', 'sourceforge.net', 'gitee.com',
  'github.io', 'gitlab.io', 'pages.dev', 'vercel.app', 'netlify.app', 'netlify.com', 'surge.sh',
  'onrender.com', 'herokuapp.com', 'fly.dev', 'railway.app', 'glitch.me', 'replit.app', 'repl.co',
  'web.app', 'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'workers.dev',
  'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com',
  'reddit.com', 'tiktok.com', 'discord.gg', 'discord.com', 't.me', 'news.ycombinator.com',
  'apps.apple.com', 'apple.com', 'play.google.com', 'google.com', 'chromewebstore.google.com',
  'addons.mozilla.org', 'microsoft.com', 'marketplace.visualstudio.com', 'amazon.com',
  'medium.com', 'substack.com', 'notion.site', 'notion.so', 'wordpress.com', 'blogspot.com', 'dev.to',
  'hashnode.dev', 'wikipedia.org', 'arxiv.org', 'npmjs.com', 'pypi.org', 'crates.io', 'huggingface.co',
  'itch.io', 'producthunt.com', 'gumroad.com', 'loom.com', 'figma.com', 'canva.site', 'carrd.co',
  'framer.website', 'framer.app', 'webflow.io', 'wixsite.com', 'typedream.app', 'bubbleapps.io',
  'streamlit.app', 'gradio.app', 'colab.research.google.com', 'docs.google.com', 'drive.google.com',
  'openai.com', 'chatgpt.com', 'anthropic.com', 'claude.ai', 'bsky.app', 'mastodon.social',
];

function isBlockedDomain(domain) {
  const d = String(domain || '').toLowerCase();
  return BLOCKED.some((b) => d === b || d.endsWith('.' + b));
}

module.exports = { normalizeSite, isBlockedDomain, BLOCKED };
