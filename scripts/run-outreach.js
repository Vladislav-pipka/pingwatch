// Entry point for GitHub Actions: node scripts/run-outreach.js
const { handler } = require('../netlify/jobs/check-outreach');

handler()
  .then((res) => {
    console.log(res.body);
    if (res.statusCode >= 400) process.exit(1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
