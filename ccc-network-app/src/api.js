// Thin fetch wrappers around the existing, unchanged Express API
// (dashboard-server.js + lib/ccc-network.js). Same-origin, cookie-based
// session auth — no base URL needed, no auth headers to manage.

export async function me() {
  const r = await fetch('/api/ccc-network/me');
  if (r.status === 401) return null;
  const j = await r.json();
  return j.person;
}

export async function signup(payload) {
  const r = await fetch('/ccc-network/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

export async function requestLogin(email) {
  await fetch('/ccc-network/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

export async function saveProfile(payload) {
  const r = await fetch('/ccc-network/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

export async function getDirectory() {
  const r = await fetch('/api/ccc-network/directory.json');
  return r.json();
}

export async function connect(uuid) {
  const r = await fetch(`/ccc-network/connect/${uuid}`, { method: 'POST' });
  return r.json();
}
