# PingWatch 🟢

Uptime monitoring for developers, indie hackers, and small SaaS teams.

PingWatch checks your website or API automatically and sends instant alerts when it goes down — via Telegram, Discord, Slack, or email.

**Live:** [pingwatch.org](https://pingwatch.org)

---

## Features

- ✅ Monitors websites and API endpoints
- 🔔 Instant alerts via Telegram, Discord, Slack, or email
- 🟢 Recovery alerts when your site comes back online
- 📋 Incident history
- 💳 Free plan + paid plans via Stripe
- ⚡ Built on Netlify Functions — no server needed

## How it works

1. Add your URL
2. Choose your alert channel (Telegram, Discord, Slack, email)
3. PingWatch checks your site automatically
4. You get an alert the moment it goes down — and when it recovers

## Tech stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Netlify Functions (Node.js)
- **Database:** Supabase (PostgreSQL)
- **Payments:** Stripe
- **Alerts:** Telegram Bot API, Discord Webhooks, Slack Webhooks, Nodemailer

## Guides

- [How to get Telegram alerts when your site goes down](https://pingwatch.org/telegram-alerts)
- [Free uptime monitoring for side projects](https://pingwatch.org/free-uptime-monitoring)
- [How to monitor API uptime without building your own scripts](https://pingwatch.org/api-uptime-monitoring)

## Environment variables (Netlify → Site configuration → Environment variables)

| Name | What |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Supabase project URL and service-role key |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_BOT_USERNAME` | Bot username without @ (default `S1te_Watch_Bot`) |
| `TELEGRAM_WEBHOOK_SECRET` | Random string, also passed to `setWebhook` as `secret_token` |
| `ADMIN_EMAILS` | Comma-separated emails allowed to open `/admin.html` |
| `SITE_URL` | Optional, default `https://pingwatch.org` |
| `SUPPORT_EMAIL` | Optional, shown on outage reports |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Payments |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email alerts |

Database changes live in `supabase/*.sql` — run them in the Supabase SQL Editor.

## Outreach

`/admin.html` — add candidate sites, PingWatch checks them quietly (`netlify/jobs/check-outreach.js`, every ~10 min on GitHub Actions — not on Netlify, to save credits),
confirmed outages show up with a ready-to-send email and a private report page at `/r/<slug>`.

New candidates are collected by `scripts/collect-leads.js` (GitHub Actions → *Collect leads*, weekly or manual):
Show HN launches and homepages of indie/SaaS repos on GitHub, with free-hosting and big-platform domains filtered out.

---

Built by [@Vladislav-pipka](https://github.com/Vladislav-pipka)
