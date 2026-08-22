// ─── Careers listing page ──────────────────────────────────────────────────
// Public, no-login page at portal.cultcontent.cc/apply — cards for each open
// role, linking out to that role's own apply page (e.g. /apply/creator-lead).
// Registered BEFORE app.use(requireAuth); the role cards themselves live in
// careers.html so adding a role is a one-line edit there, no server change.
module.exports = (app, deps = {}) => {
  const path = require('path');

  app.get('/apply', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'careers.html'));
  });
};
