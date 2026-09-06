'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SqliteSessionStore } = require('../../lib/session-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-sessions-'));
}
// The store is callback-based because that's the express-session Store
// contract; promisify at the edges so the tests read straightforwardly.
const call = (store, method, ...args) =>
  new Promise((resolve, reject) =>
    store[method](...args, (err, value) => (err ? reject(err) : resolve(value))));

describe('SqliteSessionStore', () => {
  test('a stored session round-trips', async () => {
    const store = new SqliteSessionStore({ dataDir: tmpDir() });
    await call(store, 'set', 'sid-1', { cookie: { maxAge: 60_000 }, networkPersonId: 42 });
    assert.deepEqual(await call(store, 'get', 'sid-1'), { cookie: { maxAge: 60_000 }, networkPersonId: 42 });
  });

  test('an unknown sid returns null rather than throwing', async () => {
    const store = new SqliteSessionStore({ dataDir: tmpDir() });
    assert.equal(await call(store, 'get', 'never-existed'), null);
  });

  test('setting the same sid twice updates instead of duplicating', async () => {
    const store = new SqliteSessionStore({ dataDir: tmpDir() });
    await call(store, 'set', 'sid-2', { cookie: { maxAge: 60_000 }, networkPersonId: 1 });
    await call(store, 'set', 'sid-2', { cookie: { maxAge: 60_000 }, networkPersonId: 2 });
    assert.equal((await call(store, 'get', 'sid-2')).networkPersonId, 2);
    assert.equal(await call(store, 'length'), 1);
  });

  test('destroy removes the session', async () => {
    const store = new SqliteSessionStore({ dataDir: tmpDir() });
    await call(store, 'set', 'sid-3', { cookie: { maxAge: 60_000 } });
    await call(store, 'destroy', 'sid-3');
    assert.equal(await call(store, 'get', 'sid-3'), null);
  });

  test('an expired session is never returned, even before a prune sweep', async () => {
    const store = new SqliteSessionStore({ dataDir: tmpDir() });
    // Already in the past — reads filter on expiry, so this must not
    // authenticate anyone regardless of when the sweep last ran.
    await call(store, 'set', 'stale', { cookie: { expires: new Date(Date.now() - 1000) } });
    assert.equal(await call(store, 'get', 'stale'), null);
    assert.equal(await call(store, 'length'), 0, 'expired rows should not count as active');
  });

  test('touch extends an expiry without rewriting the session', async () => {
    const store = new SqliteSessionStore({ dataDir: tmpDir() });
    await call(store, 'set', 'sid-4', { cookie: { expires: new Date(Date.now() + 1000) }, networkPersonId: 9 });
    await call(store, 'touch', 'sid-4', { cookie: { expires: new Date(Date.now() + 600_000) } });

    const row = store.db.prepare('SELECT expires_at FROM sessions WHERE sid = ?').get('sid-4');
    assert.ok(row.expires_at > Date.now() + 500_000, 'expiry should have moved out');
    assert.equal((await call(store, 'get', 'sid-4')).networkPersonId, 9, 'payload should survive a touch');
  });

  test('a session written by one process is readable by the next — this is what survives a deploy', async () => {
    const dir = tmpDir();
    const first = new SqliteSessionStore({ dataDir: dir });
    await call(first, 'set', 'survivor', { cookie: { maxAge: 600_000 }, networkPersonId: 77 });

    // A fresh instance over the same directory stands in for the restart. The
    // old MemoryStore lost everything here, which is what logged out every
    // user on every deploy.
    const second = new SqliteSessionStore({ dataDir: dir });
    assert.equal((await call(second, 'get', 'survivor')).networkPersonId, 77);
  });

  test('prune deletes expired rows and leaves live ones', async () => {
    const store = new SqliteSessionStore({ dataDir: tmpDir() });
    await call(store, 'set', 'gone', { cookie: { expires: new Date(Date.now() - 5000) } });
    await call(store, 'set', 'alive', { cookie: { maxAge: 600_000 } });

    store.prune();
    const rows = store.db.prepare('SELECT sid FROM sessions').all().map((r) => r.sid);
    assert.deepEqual(rows, ['alive']);
  });

  test('a session with no cookie hint still gets a real future expiry', async () => {
    const store = new SqliteSessionStore({ dataDir: tmpDir() });
    await call(store, 'set', 'no-cookie', { networkPersonId: 3 });
    const row = store.db.prepare('SELECT expires_at FROM sessions WHERE sid = ?').get('no-cookie');
    assert.ok(row.expires_at > Date.now(), 'must not default to 0 or NaN');
    assert.equal((await call(store, 'get', 'no-cookie')).networkPersonId, 3);
  });
});
