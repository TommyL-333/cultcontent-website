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
  // Completion is attached to the person object so screens that already take
  // a `person` prop don't all need a second one threaded through them.
  return j.person ? { ...j.person, completion: j.completion } : null;
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

// Tier is staff-assigned in /ccc-network-admin — there is deliberately no
// client function for it. The route it used now returns 403.

export async function deactivateAccount() {
  return postJson('/ccc-network/settings/deactivate', {});
}

export async function requestEmailChange(email) {
  return postJson('/ccc-network/settings/email', { email });
}

// ─── Event data (schedule + site map) ───────────────────────────────────────────
// Public endpoint — served without a session so the itinerary and map still
// load for someone checking their phone at the gate before they log in.
export async function getEvent() {
  const r = await fetch('/api/ccc-network/event.json');
  if (!r.ok) throw new Error('event data unavailable');
  return r.json();
}

export async function getExhibitors() {
  const r = await fetch('/api/ccc-network/exhibitors');
  return r.json();
}

// ─── Challenges ─────────────────────────────────────────────────────────────────
export async function getChallenges() {
  const r = await fetch('/api/ccc-network/challenges');
  return r.json();
}

export async function createChallenge(payload) {
  return postJson('/ccc-network/challenges', payload);
}

export async function setChallengeStatus(uuid, status) {
  return postJson(`/ccc-network/challenges/${uuid}/status`, { status });
}

export async function enterChallenge(uuid, { url, note }) {
  return postJson(`/ccc-network/challenges/${uuid}/enter`, { url, note });
}

export async function withdrawFromChallenge(uuid) {
  const r = await fetch(`/ccc-network/challenges/${uuid}/withdraw`, { method: 'POST' });
  return r.json();
}

export async function getChallengeEntries(uuid) {
  const r = await fetch(`/api/ccc-network/challenges/${uuid}/entries`);
  return r.json();
}

// ─── Contact sharing consent ────────────────────────────────────────────────────
export async function updateContactSharing(shareContact) {
  return postJson('/ccc-network/settings/contact-sharing', { share_contact: shareContact });
}
