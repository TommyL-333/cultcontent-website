# Creator Carnival Networking Hub — Project Handoff

What this is, how it's built, where things stand, and what's still open.
Written for a new contributor picking this up — not a Claude Code
instructions file (there isn't one for this repo; the only `CLAUDE.md`
in this codebase is an unrelated onboarding script buried in
`installer/`, for a different project entirely).

## What this is

The **Networking Roster** for Creator Carnival (Sept 12, 2026, National
Harbor, MD) — creators and brands sign up, get matched, browse a
directory, send connection requests, and message each other ahead of the
event. Lives at **`https://portal.cultcontent.cc/ccc-network`**.

This is one feature inside a much larger monolith
(`dashboard-server.js`, ~20k+ lines, covers TikTok Shop, GHL CRM, Lark,
Stripe booth sales, and a dozen other unrelated things). This doc only
covers the Networking Hub slice of it.

## Architecture

| Piece | Where | Notes |
|---|---|---|
| Frontend | `ccc-network-app/` | React 19 + Vite + HeroUI + Tailwind v4. Built to static files, served by the Express app at `/ccc-network`. |
| Routes | `dashboard-server.js` | Search for `Creator Carnival Networking Hub` — signup, login, magic-link auth, profile, directory, connect, admin API. Registered *before* `requireAuth` (public) except the `/api/admin/*` block. |
| Core logic + DB | `lib/ccc-network.js` | Signup, profile, directory, connections. SQLite via Node's built-in `node:sqlite` (`DatabaseSync`) — **not** `better-sqlite3**, which was ripped out (see below). |
| Messaging | `lib/ccc-network-messages.js` | Inbox/thread logic on top of accepted connections. Reuses the same DB handle as `lib/ccc-network.js`. |
| Email | `lib/ccc-network-mail.js` | Resend (not GHL — see below). |
| Admin UI | `dashboard/ccc-network-admin.html` | Static page, served at `/ccc-network-admin`, behind Cloudflare Access. |
| Design system | `ccc-network-app/DESIGN.md` | Read this before touching any screen's visuals. |

**Database**: `ccc-network.db`, a plain SQLite file on local disk. Tables:
`ccc_people` (the roster), `ccc_connections`, `ccc_messages`,
`ccc_magic_links`, `ccc_email_change_tokens`. No ORM — raw
`db.prepare(...).run/get/all()` throughout.

## Why `node:sqlite` and not `better-sqlite3`

`better-sqlite3` is a native addon and segfaulted on Railway (ABI
mismatch). After failed attempts to force a from-source rebuild via
`nixpacks.toml`, it was replaced outright with Node's built-in
`node:sqlite` module (stable-ish since Node 22, still logs an
"experimental" warning). The API is close enough to `better-sqlite3`
that most call sites didn't change — see `lib/ccc-network.js`'s
`addColumnIfMissing`/`renameColumnIfNeeded` helpers for the migration
pattern used on this table.

**Open risk, never fully confirmed**: this app stores its DB as a file
on local disk. If Railway ever runs more than one replica of this
service, or the volume isn't actually persistent, requests can land on
different instances with different copies of the file — a signup on one
instance, a confirmation-link click routed to another that never saw it.
This was the leading theory for an intermittent "invalid link" bug users
hit (see **Known issues** below) but was never definitively confirmed —
temporary diagnostic logging (`[ccc-network-auth-debug]` in
`dashboard-server.js`, both at token creation and consumption) is still
in place to catch it next time it's reproduced. **Remove that logging
once root-caused.**

## Account lifecycle (self-serve, no admin approval)

This used to require manual admin approval before anyone could log in.
It's now fully self-serve:

1. Sign up at `/ccc-network` → creates a `pending` row in `ccc_people`.
2. A confirmation email fires immediately (`sendVerifyEmail`, via
   Resend) with a one-click link.
3. Clicking it hits the *same* route a login link uses
   (`GET /ccc-network/auth/:token`) — if the person is still `pending`,
   it auto-flips them to `approved` and logs them in, in one step.
4. Resubmitting the signup form with the same still-pending email
   **resends** a fresh link and refreshes their profile fields, instead
   of hard-rejecting as "already registered" — a expired/lost first link
   would otherwise be a dead end.
5. Login is always passwordless — a magic link, never a password. There
   is no password anywhere in this system, so there's no "forgot
   password" flow to build; "log in" *is* the recovery mechanism.
6. `/ccc-network-admin` is no longer a required gate — it's for
   moderation after the fact (reject a bad actor, deactivate someone,
   adjust a brand's sponsorship tier, or manually rescue someone
   genuinely stuck).

**Duplicate-email handling on signup** (see `SignupScreen.jsx`) is
status-aware: `approved` → "log in instead" with a working deep link;
`rejected`/`deactivated` → told plainly there's no self-serve fix, contact
Tommy's team (since `createMagicLink` only ever issues a link for an
`approved` account — sending these two states to `/login` was a silent
dead end that got fixed); `pending` → resend, with copy distinguishing it
from a brand-new signup.

## Email delivery: Resend, not GoHighLevel

The original implementation piggybacked on the GHL integration built for
an unrelated SMS flow. It never actually worked — confirmed in
production logs: GHL's `conversations/messages/outbound` endpoint
requires a `conversationProviderId` that was never configured, so every
send 400'd and silently fell back to console-logging instead of
delivering. This was true for every email this app ever tried to send
(magic links, approvals, connection/message notifications), likely since
before `lib/ccc-network-mail.js` existed as a separate file.

Replaced with **Resend**, sending from `mail.cultcontent.cc` — a
dedicated subdomain (SPF/DKIM verified in Resend, DNS records live in
Cloudflare), deliberately kept separate from the team's real
`@cultcontent.cc` Google Workspace mail so nothing here risks it. GHL
contact upsert is kept as a best-effort CRM side effect but no longer
gates or blocks delivery.

**Required env vars** (Railway → the service's Variables tab):
- `RESEND_API_KEY` — sending access, scoped to `mail.cultcontent.cc` only.
- `PUBLIC_BASE_URL` — **must be `https://portal.cultcontent.cc`**. This
  builds every link baked into every email (confirmation, approval,
  connection requests, the creator-form webhook). Get this wrong and
  every email still *sends*, just with a wrong/confusing link — and
  since email content is fixed at send time, already-delivered emails
  can't be retroactively fixed once this is corrected, only future ones.
- Optional: `RESEND_FROM_ADDRESS` to override the default
  `Creator Carnival <noreply@mail.cultcontent.cc>`.

Neither of these showed up in one attempt to audit this service's
Variables tab even though the app was clearly reading a value from
somewhere (emails were going out with *a* base URL, just the wrong
domain) — Railway supports **Shared Variables** at the project level
that can silently supply a value a service-level tab won't show. If a
var seems to be "missing" but clearly has an effect, check for that
before assuming it's unset; a service-level variable of the same name
always overrides a shared one regardless.

## Domains — a real gotcha

Three different hostnames currently resolve to (possibly different)
deployments of this codebase:

- **`portal.cultcontent.cc`** — the canonical domain for the actual
  webapp/portal. This is what `PUBLIC_BASE_URL` should be.
- **`cultcontent.cc`** (bare domain) — the public marketing site
  (`culture-commerce-carnival.html`, `/ccc-network` also happens to work
  here since it's likely the same Railway service, but isn't the
  intended canonical link target).
- **`ccc.cultcontent.cc`** — confirmed to be a **separate Railway
  service** from the bare domain (different CNAME targets in Cloudflare
  DNS), serving what looks like the same marketing page content. Described
  by the project owner as unintentional/inconsistent domain setup, not a
  deliberate architecture — don't assume any of these three are
  interchangeable without checking.

## Google Form → welcome email webhook

The "Apply to be a Carnival Creator" page (`ccc-creator-apply.html`) is a
bare embedded Google Form with no backend of its own — Google owns that
response data entirely, nothing in this repo ever sees a submission
automatically. To bridge that:

- `POST /api/webhooks/creator-form-submit` (`dashboard-server.js`) —
  public route, same `WEBHOOK_SECRET` query-param convention as the
  existing GHL webhook. Takes `{ email, name }`, sends a plain Resend
  email pointing at the Networking Roster signup
  (`sendCreatorFormWelcomeEmail` in `lib/ccc-network-mail.js` — not tied
  to a `ccc_people` record, since most Form applicants don't have one).
- A **Google Apps Script** attached to the Form (installed manually in
  Google's Script Editor, *not* part of this repo — ask whoever manages
  the Form for the script, or re-derive it: an `onFormSubmit(e)` trigger
  that reads the email/name answers and `UrlFetchApp.fetch`es the
  webhook URL with the shared secret).

## Cloudflare Access

Was **never configured at all** for this domain before this work — a
`CF_ACCESS_AUD` value existed in Railway pointing at nothing real, so
every protected page (`/ccc-network-admin`, etc.) was permanently
locked out for everyone, including staff (fails closed, so at least
nothing was publicly exposed in the meantime). Fixed by creating a real
Access Application scoped to `/ccc-network-admin*` and `/api/admin/*`
(not the whole domain — the marketing pages, signup, and creator-apply
flow all need to stay public), with a policy allowing `@cultcontent.cc`
emails, and the resulting Application's Audience tag set as
`CF_ACCESS_AUD` in Railway.

Also worth knowing: the bare root path `/` has **two** competing route
handlers in `dashboard-server.js` — a public one (registered first, wins,
serves the marketing homepage) and a dead, unreachable one further down
meant to serve the internal ops dashboard (`dashboard/index.html`). That
second one is permanently shadowed. Not part of the Networking Hub
specifically, but discovered while working in this area and worth fixing
separately.

## Design system

Full detail in `ccc-network-app/DESIGN.md` — read it before touching any
screen. Short version: **two rounds happened**, and only the second one
is "current":

1. **Round 1** (superseded): restrained/institutional register — serif
   headlines (`Source Serif 4`), one brand accent leading per screen.
   Reasoned abstractly from "what does an AI-scaffolded app never do,"
   without a real brand reference.
2. **Round 2** (current): once pointed at the actual live event marketing
   page (`culture-commerce-carnival.html`, mirrored at
   `ccc.cultcontent.cc/culture-commerce-carnival`), matched that instead —
   festival energy, not fintech-trust energy. Heavy-weight Public Sans
   (no separate display face), all three brand accents (`--accent`
   red / `--accent-2` cyan / `--gold`) layered freely rather than
   restrained, plus genuinely carnival-specific details: marquee twinkle
   lights, real ticket die-cut notches, a candy-stripe bar, intentional
   asymmetric tilt on a few elements (a too-perfectly-aligned grid is
   itself an AI-generated tell).

**Round 2 is only applied to `HomeScreen.jsx`.** Every other screen
(`LoginScreen`, `SignupScreen`, `DirectoryScreen`, `ConnectionsScreen`,
`PersonProfileScreen`, `InboxScreen`, `ProfileScreen`, `SettingsScreen`,
`Topbar`, `PersonDetailCard`) is still on round 1's typography (harmless
— `font-display` now silently resolves to Public Sans instead of the
removed serif) but doesn't have the pill-glow/card-glow/marquee treatment
yet. That's the next piece of design work if picked back up.

## Data model note: TikTok vs Instagram

Creators used to have one combined `handle` field for "TikTok / IG."
Split into two real columns: `tiktok_handle` (renamed from the original
`handle` — existing values assumed to be TikTok, the event's primary
platform, so nothing was lost) and a new `instagram_handle`. Both
optional now that they're separate. See the migration pattern in
`lib/ccc-network.js` if adding more fields later.

## Known open issues

- **Intermittent "invalid" confirmation link** — reported by real users,
  never definitively root-caused. Leading theory is the multi-replica/
  no-shared-volume risk described above. Diagnostic logging is in place
  (`[ccc-network-auth-debug]`) but needs an actual reproduction with logs
  checked before/after to confirm or rule it out. **Do not remove that
  logging until this is resolved.**
- **Design system round 2** only on `HomeScreen.jsx` — rolling it out to
  the rest of the app is straightforward but not done.
- **No cross-check against real event registrants.** Anyone with a real
  inbox can self-serve a Networking Hub account regardless of whether
  they actually registered for the event (bought a Posh ticket, applied
  via the Google Form, or booked a booth). Discussed adding a check
  against Posh's attendee API + the Google Form responses + the local
  `ccc_booth_signups` table, deferred pending a Posh API key and Google
  Sheet access. If picked up: only `ccc_booth_signups` currently lives in
  this repo's own database; the other two are external and would need
  real integration work, not just a query.
- **The dead `/` route handler** in `dashboard-server.js` mentioned above
  — bigger, separate cleanup, not scoped to this feature.
- Whether the Apps Script for the creator-form webhook is actually
  installed on the live Google Form was never confirmed as done.

## Local development

```bash
npm test                                    # full suite (unit + integration)
npm run test:unit                           # lib/ tests only
npm run test:integration                    # HTTP-level tests only
npm run dev                                 # dashboard-server.js, --watch
npm run dev:network                         # ccc-network-app/ via Vite, HMR
npm run build                               # builds ccc-network-app/, needed before dashboard-server.js can serve it
```

Tests use an isolated temp SQLite DB per file (`test/helpers/isolated-data-dir.js`)
— they never touch the real `ccc-network.db`. Running the *actual* server
locally against the real DB will, on its own, trigger legitimate startup
migrations in `brands.json` (unrelated to this feature, comes from a
different merged change) — don't assume every local diff after boot is a
test artifact worth discarding; check `git diff` before reverting
anything that shows up.
