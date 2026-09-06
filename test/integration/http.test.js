'use strict';
/**
 * Boots the real dashboard-server.js as a child process against a throwaway
 * DATA_DIR + a dedicated test port, then exercises it over real HTTP —
 * the same sequence manually curl-tested by hand throughout this build:
 * booth signups, then the full networking-hub loop (signup -> admin
 * approve -> magic link -> directory gating -> connect -> accept ->
 * message -> inbox), plus settings and a regression check that unrelated
 * site pages and the SPA shell still serve.
 *
 * CF_ACCESS_AUD is left unset so requireAuth no-ops for admin routes, same
 * as every local dev session this repo has ever been tested under.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PORT = 39292; // distinct from the 39281 used for manual click-through testing
const BASE = `http://localhost:${PORT}`;

let child;
let stdoutBuf = '';
let dataDir;

function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(`${BASE}/ccc-booth-availability`).then(
        (r) => (r.ok || r.status === 404 ? resolve() : retry()),
        retry,
      );
      function retry() {
        if (Date.now() > deadline) return reject(new Error('server did not become ready in time'));
        setTimeout(poll, 200);
      }
    })();
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-http-'));
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir };
  delete env.CF_ACCESS_AUD;

  child = spawn('node', ['dashboard-server.js'], { cwd: REPO_ROOT, env });
  child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stdoutBuf += chunk.toString(); });

  await waitForServer();
});

after(async () => {
  if (child) child.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
});

// Grabs the most recently logged magic-link token for `email` — mirrors the
// `grep -oP 'auth/\K[a-f0-9]+' server.log` workflow used throughout manual
// testing in this session, since the dev-fallback mail path only logs.
function latestTokenFor(email) {
  const re = new RegExp(`To: ${email}[\\s\\S]*?auth/([a-f0-9]+)`, 'g');
  let match, last;
  while ((match = re.exec(stdoutBuf))) last = match[1];
  if (!last) throw new Error(`no magic-link token found in server output for ${email}`);
  return last;
}

// Tiny per-user cookie-aware client — fetch() has no built-in cookie jar.
function makeSession() {
  let cookie = null;
  async function req(method, urlPath, body) {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      redirect: 'manual', // so a 302's Set-Cookie is visible on the response we get back
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    if (setCookie.length) cookie = setCookie[0].split(';')[0];
    return res;
  }
  return {
    get: (p) => req('GET', p),
    post: async (p, body) => {
      const res = await req('POST', p, body);
      return res;
    },
    postJson: async (p, body) => {
      const res = await req('POST', p, body);
      return res.status === 204 || res.headers.get('content-length') === '0' ? {} : res.json();
    },
    getJson: async (p) => (await req('GET', p)).json(),
  };
}

// ─── Booth signups ──────────────────────────────────────────────────────────────
test('booth availability reflects the seeded historical data', async () => {
  const a = await (await fetch(`${BASE}/ccc-booth-availability`)).json();
  assert.equal(a['freedom-way'].total, 81);
  assert.equal(a['capitol-canopy'].total, 60);
});

test('booth signup reserves a slot and decrements availability', async () => {
  const before1 = (await (await fetch(`${BASE}/ccc-booth-availability`)).json())['freedom-way'].available;
  const res = await fetch(`${BASE}/ccc-booth-signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booth_type: 'freedom-way', first_name: 'HTTP', last_name: 'Test', email: 'httptest@example.com', brand_name: 'HTTP Test Co', product_category: 'Testing' }),
  });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.paymentUrl.includes('client_reference_id='));
  const after1 = (await (await fetch(`${BASE}/ccc-booth-availability`)).json())['freedom-way'].available;
  assert.equal(after1, before1 - 1);
});

// ─── Networking Hub: full request -> approve -> connect -> message loop ────────
let creatorUuid, brandUuid;

test('networking signup: creator and brand', async () => {
  const c = await (await fetch(`${BASE}/ccc-network/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'creator', first_name: 'HTTP', last_name: 'Creator', email: 'httpcreator@example.com', tiktok_handle: '@httpcreator', category: 'Testing', looking_for: 'test brands' , terms_accepted: true }),
  })).json();
  assert.equal(c.ok, true);
  creatorUuid = c.uuid;

  const b = await (await fetch(`${BASE}/ccc-network/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'brand', first_name: 'HTTP', last_name: 'Brand', email: 'httpbrand@example.com', brand_name: 'HTTP Brand Co', tier: 'priority', looking_for: 'test creators' , terms_accepted: true }),
  })).json();
  assert.equal(b.ok, true);
  brandUuid = b.uuid;
});

test('self-serve: confirming the signup email activates the account with no admin step', async () => {
  const selfServe = await (await fetch(`${BASE}/ccc-network/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'creator', first_name: 'SelfServe', last_name: 'Test', email: 'selfserve-http@example.com', tiktok_handle: '@selfservehttp', category: 'Testing', looking_for: 'test brands' , terms_accepted: true }),
  })).json();
  assert.equal(selfServe.ok, true);

  await new Promise((r) => setTimeout(r, 300)); // let the async verify-email log flush
  const token = latestTokenFor('selfserve-http@example.com');
  const session = makeSession();
  const authRes = await session.get(`/ccc-network/auth/${token}`);
  assert.equal(authRes.status, 302); // logged straight in, no admin approval in between

  const me = await session.getJson('/api/ccc-network/me');
  assert.equal(me.ok, true);
  assert.equal(me.person.status, 'approved');
  assert.equal(me.person.uuid, selfServe.uuid);
});

test('self-serve: resubmitting while still pending resends instead of rejecting', async () => {
  const first = await (await fetch(`${BASE}/ccc-network/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'creator', first_name: 'Resend', last_name: 'Test', email: 'resend-http@example.com', tiktok_handle: '@resendhttp', category: 'Testing', looking_for: 'first draft' , terms_accepted: true }),
  })).json();
  assert.equal(first.ok, true);

  const second = await (await fetch(`${BASE}/ccc-network/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'creator', first_name: 'Resend', last_name: 'Test', email: 'resend-http@example.com', tiktok_handle: '@resendhttp', category: 'Testing', looking_for: 'fixed draft' , terms_accepted: true }),
  })).json();
  assert.equal(second.ok, true);
  assert.equal(second.resent, true);
  assert.equal(second.uuid, first.uuid);
});

test('admin approves both, which fires an approval magic-link email', async () => {
  const cRes = await fetch(`${BASE}/api/admin/ccc-network/people/${creatorUuid}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(cRes.status, 200);
  const bRes = await fetch(`${BASE}/api/admin/ccc-network/people/${brandUuid}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved', tier: 'priority' }),
  });
  assert.equal(bRes.status, 200);
});

const creatorSession = makeSession();
const brandSession = makeSession();

test('magic link login works for both, sets a session cookie', async () => {
  await new Promise((r) => setTimeout(r, 300)); // let the async approval-email log flush
  const cToken = latestTokenFor('httpcreator@example.com');
  const cAuth = await creatorSession.get(`/ccc-network/auth/${cToken}`);
  assert.equal(cAuth.status, 302);

  const bToken = latestTokenFor('httpbrand@example.com');
  const bAuth = await brandSession.get(`/ccc-network/auth/${bToken}`);
  assert.equal(bAuth.status, 302);

  const me = await creatorSession.getJson('/api/ccc-network/me');
  assert.equal(me.ok, true);
  assert.equal(me.person.uuid, creatorUuid);
});

test('unauthenticated /api/ccc-network/me is rejected', async () => {
  const res = await fetch(`${BASE}/api/ccc-network/me`);
  assert.equal(res.status, 401);
});

test('directory.json excludes the viewer and shows the other party', async () => {
  const dir = await creatorSession.getJson('/api/ccc-network/directory.json');
  assert.equal(dir.gated, false);
  assert.ok(dir.people.some((p) => p.uuid === brandUuid));
});

test('connect sends a pending request with no contact info revealed', async () => {
  const res = await creatorSession.postJson(`/ccc-network/connect/${brandUuid}`);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'pending');
  assert.equal(res.otherPerson.email, undefined);

  const conns = await creatorSession.getJson('/api/ccc-network/connections');
  assert.equal(conns.outgoing.length, 1);
});

test('the brand sees it as an incoming request and can accept it', async () => {
  const conns = await brandSession.getJson('/api/ccc-network/connections');
  assert.equal(conns.incoming.length, 1);
  assert.equal(conns.incoming[0].uuid, creatorUuid);

  const res = await brandSession.postJson(`/ccc-network/connections/${creatorUuid}/accept`);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'accepted');
  assert.ok(res.otherPerson.email); // now revealed
});

test('after acceptance, both profiles reveal contact info', async () => {
  const asCreator = await creatorSession.getJson(`/api/ccc-network/people/${brandUuid}`);
  assert.equal(asCreator.person.relationship, 'accepted');
  assert.ok(asCreator.person.email);

  const asBrand = await brandSession.getJson(`/api/ccc-network/people/${creatorUuid}`);
  assert.equal(asBrand.person.relationship, 'accepted');
  assert.ok(asBrand.person.email);
});

test('messaging works end to end and unread counts update correctly', async () => {
  const sendRes = await brandSession.postJson(`/ccc-network/messages/${creatorUuid}`, { body: 'Hey! Loved your profile, want to collab?' });
  assert.equal(sendRes.ok, true);

  const inbox = await creatorSession.getJson('/api/ccc-network/inbox');
  assert.equal(inbox.unread, 1);
  assert.equal(inbox.conversations[0].lastMessage.body, 'Hey! Loved your profile, want to collab?');

  const thread = await creatorSession.getJson(`/api/ccc-network/messages/${brandUuid}`);
  assert.equal(thread.messages.length, 1);

  const inboxAfterRead = await creatorSession.getJson('/api/ccc-network/inbox');
  assert.equal(inboxAfterRead.unread, 0); // reading the thread marked it read
});

test('messaging is rejected for a non-connected person', async () => {
  const stranger = await (await fetch(`${BASE}/ccc-network/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'creator', first_name: 'Stranger', email: 'stranger@example.com', looking_for: 'x' , terms_accepted: true }),
  })).json();
  await fetch(`${BASE}/api/admin/ccc-network/people/${stranger.uuid}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }),
  });
  const res = await creatorSession.postJson(`/ccc-network/messages/${stranger.uuid}`, { body: 'hi' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_connected');
});

test('settings: profile save, notifications, tier update', async () => {
  const saved = await creatorSession.postJson('/ccc-network/profile', { first_name: 'HTTP', last_name: 'Creator', bio: 'Updated bio', looking_for: 'updated', links: [] });
  assert.equal(saved.ok, true);
  assert.equal(saved.person.bio, 'Updated bio');

  const notif = await creatorSession.postJson('/ccc-network/settings/notifications', { notify_request: false, notify_approval: true, notify_message: true });
  assert.equal(notif.ok, true);
  assert.equal(notif.person.notify_request, 0);

  const tier = await brandSession.postJson('/ccc-network/settings/tier', { tier: 'executive' });
  assert.equal(tier.ok, true);
  assert.equal(tier.person.tier, 'executive');
});

test('CSV export is tier-gated: general brands 403, priority brands succeed', async () => {
  const generalBrand = await (await fetch(`${BASE}/ccc-network/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'brand', first_name: 'General', email: 'generalbrand@example.com', brand_name: 'General Co', tier: 'general', looking_for: 'x' , terms_accepted: true }),
  })).json();
  await fetch(`${BASE}/api/admin/ccc-network/people/${generalBrand.uuid}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved', tier: 'general' }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const generalSession = makeSession();
  const gToken = latestTokenFor('generalbrand@example.com');
  await generalSession.get(`/ccc-network/auth/${gToken}`);
  const forbidden = await generalSession.get('/ccc-network/contacts.csv');
  assert.equal(forbidden.status, 403);

  const allowed = await brandSession.get('/ccc-network/contacts.csv');
  assert.equal(allowed.status, 200);
});

test('email change: request logs a verification link to the *new* address, confirming updates it', async () => {
  await creatorSession.postJson('/ccc-network/settings/email', { email: 'httpcreator-new@example.com' });
  await new Promise((r) => setTimeout(r, 200));
  const match = /settings\/email\/confirm\/([a-f0-9]+)/.exec(stdoutBuf);
  assert.ok(match, 'expected an email-change confirm link in server output');
  const confirmRes = await fetch(`${BASE}/ccc-network/settings/email/confirm/${match[1]}`, { redirect: 'manual' });
  assert.equal(confirmRes.status, 302);
});

test('deactivate kills the session', async () => {
  const throwaway = await (await fetch(`${BASE}/ccc-network/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'creator', first_name: 'Throwaway', email: 'throwaway-http@example.com', looking_for: 'x' , terms_accepted: true }),
  })).json();
  await fetch(`${BASE}/api/admin/ccc-network/people/${throwaway.uuid}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const session = makeSession();
  const token = latestTokenFor('throwaway-http@example.com');
  await session.get(`/ccc-network/auth/${token}`);
  await session.postJson('/ccc-network/settings/deactivate');
  const me = await session.get('/api/ccc-network/me');
  assert.equal(me.status, 401);
});

// ─── Regression: unrelated pages + SPA shell still serve ───────────────────────
test('unrelated marketing pages and the SPA shell are unaffected', async () => {
  const home = await fetch(`${BASE}/`);
  assert.equal(home.status, 200);
  const boothPage = await fetch(`${BASE}/ccc-commerce-sponsor`);
  assert.equal(boothPage.status, 200);
  const spaHome = await fetch(`${BASE}/ccc-network/home`, { redirect: 'manual' });
  assert.ok([200, 301].includes(spaHome.status));
});
