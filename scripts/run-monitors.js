// Entry point for GitHub Actions: node scripts/run-monitors.js
const { handler } = require('../netlify/jobs/check-monitors');

handler()
  .then((res) => {
    console.log(typeof res.body === 'string' ? res.body.slice(0, 500) : res.body);
    if (res.statusCode >= 400) process.exit(1);
  })
  .catch((err) => { console.error(err); process.exit(1); });
