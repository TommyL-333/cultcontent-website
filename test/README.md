# Test suite — booth signups + Networking Hub

Covers everything built this round: `lib/ccc-booths.js`, `lib/ccc-network.js`,
`lib/ccc-network-messages.js`, `lib/ccc-network-mail.js`, and the real HTTP
routes in `dashboard-server.js`. Uses Node's built-in test runner
(`node:test`) — no new dependency.

## Running it

```
npm test              # everything (unit + HTTP integration)
npm run test:unit     # just the lib/*.js unit tests — fast, no server
npm run test:integration  # boots the real server and hits it over HTTP
```

Every test uses a throwaway `DATA_DIR` (a fresh temp directory per test
file) — nothing here ever touches your real dev database or the one on
production. The integration suite boots `dashboard-server.js` as a real
child process on port `39292` (distinct from the `39281` used for manual
click-through testing) and tears it down afterward.

## What's covered

- **`test/lib/ccc-booths.test.js`** — availability math, signup validation,
  sold-out blocking, status updates, admin filtering. Runs against the same
  4-row historical seed the real module ships with.
- **`test/lib/ccc-network.test.js`** — signup validation, approval + magic
  links (including single-use enforcement), directory tier-gating, the full
  connect → accept/decline → re-request state machine, contact-info
  visibility rules, and every Settings action (notifications, tier,
  deactivate, email change with token expiry/reuse).
- **`test/lib/ccc-network-messages.test.js`** — messages are blocked until a
  connection is `accepted`, unread counts, mark-as-read on thread open.
- **`test/lib/ccc-network-mail.test.js`** — with `GHL_API_KEY` unset, every
  send degrades to the console-log fallback instead of throwing or making a
  real network call; opted-out notification preferences skip the send
  entirely (not just the delivery).
- **`test/integration/http.test.js`** — the same signup → approve → magic
  link → directory → connect → accept → message → settings → CSV export →
  deactivate loop that's been manually curl-tested by hand all session, now
  scripted end-to-end over real HTTP, plus a regression check that
  unrelated marketing pages and the SPA shell still serve.

## What's intentionally not covered

No browser/UI test — there's no browser automation tool available in this
environment, so the React frontend (`ccc-network-app/`) is unverified by
this suite the same way it's been unverified all session: a build-success +
compiled-output check, not a rendered one. A real click-through is still
the only way to confirm the UI actually looks right.
