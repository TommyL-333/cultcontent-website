// Thin fetch wrappers around the existing, unchanged Express API
// (dashboard-server.js + lib/ccc-network*.js). Same-origin, cookie-based
// session auth — no base URL needed, no auth headers to manage.

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

export async function me() {
  const r = await fetch('/api/ccc-network/me');
  if (r.status === 401) return null;
  const j = await r.json();
  return j.person;
}

export async function signup(payload) {
  return postJson('/ccc-network/signup', payload);
}

export async function requestLogin(email) {
  await postJson('/ccc-network/login', { email });
}

export async function saveProfile(payload) {
  return postJson('/ccc-network/profile', payload);
}

export async function getDirectory() {
  const r = await fetch('/api/ccc-network/directory.json');
  return r.json();
}

export async function connect(uuid) {
  const r = await fetch(`/ccc-network/connect/${uuid}`, { method: 'POST' });
  return r.json();
}

// ─── Connections ────────────────────────────────────────────────────────────────
export async function getConnections() {
  const r = await fetch('/api/ccc-network/connections');
  return r.json();
}

export async function acceptConnection(uuid) {
  const r = await fetch(`/ccc-network/connections/${uuid}/accept`, { method: 'POST' });
  return r.json();
}

export async function declineConnection(uuid) {
  const r = await fetch(`/ccc-network/connections/${uuid}/decline`, { method: 'POST' });
  return r.json();
}

export async function getPersonProfile(uuid) {
  const r = await fetch(`/api/ccc-network/people/${uuid}`);
  return r.json();
}

// ─── Inbox ──────────────────────────────────────────────────────────────────────
export async function getInbox() {
  const r = await fetch('/api/ccc-network/inbox');
  return r.json();
}

export async function getThread(uuid) {
  const r = await fetch(`/api/ccc-network/messages/${uuid}`);
  return r.json();
}

export async function sendMessageTo(uuid, body) {
  return postJson(`/ccc-network/messages/${uuid}`, { body });
}

// ─── Settings ───────────────────────────────────────────────────────────────────
export async function updateNotifications(prefs) {
  return postJson('/ccc-network/settings/notifications', prefs);
}

export async function updateTier(tier) {
  return postJson('/ccc-network/settings/tier', { tier });
}

export async function deactivateAccount() {
  return postJson('/ccc-network/settings/deactivate', {});
}

export async function requestEmailChange(email) {
  return postJson('/ccc-network/settings/email', { email });
}
