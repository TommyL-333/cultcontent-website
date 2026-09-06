/**
 * SQLite-backed express-session store.
 *
 * Replaces express-session's default MemoryStore, which keeps every session
 * in the process heap. That store logs a warning on boot for good reason:
 * sessions die with the process, so *every deploy signs out every user*. For
 * the Creator Carnival roster that meant a push on event day would log out
 * the whole floor at once, each person needing a fresh magic-link email over
 * venue wifi.
 *
 * Deliberately built on Node's own `node:sqlite` rather than pulling in
 * `connect-sqlite3` or `better-sqlite3`. A native addon is exactly what
 * segfaulted on Railway before and got ripped out of this codebase (see
 * lib/ccc-network.js) — repeating that to store sessions would be a bad
 * trade. This is the same pattern already proven here.
 *
 * The table lives on the same DATA_DIR volume as the rest of the app's
 * SQLite files, so it survives restarts and redeploys.
 */

const path = require('path');
const { Store } = require('express-session');
const { DatabaseSync } = require('node:sqlite');

// Expired rows are cleared on this interval as well as being filtered out on
// every read, so a stale row can never authenticate anyone even in the window
// before a sweep runs.
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

class SqliteSessionStore extends Store {
  constructor({ dataDir, file = 'sessions.db' } = {}) {
    super();
    this.db = new DatabaseSync(path.join(dataDir, file));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid        TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);

    this.prune();
    // unref so a pending sweep never holds the process open on shutdown.
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  // express-session hands us a cookie whose maxAge may have already been
  // consumed; fall back to the absolute expiry, then to a day, so a session
  // row always has a real deadline rather than 0 or NaN.
  #expiryOf(sess) {
    const cookie = sess?.cookie;
    if (cookie?.expires) return new Date(cookie.expires).getTime();
    if (cookie?.maxAge) return Date.now() + cookie.maxAge;
    return Date.now() + 24 * 60 * 60 * 1000;
  }

  prune() {
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    } catch (err) {
      console.error('[session-store] prune failed:', err.message);
    }
  }

  get(sid, cb) {
    try {
      const row = this.db
        .prepare('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?')
        .get(sid, Date.now());
      if (!row) return cb(null, null);
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      // A corrupt row should log the caller out, not 500 the request.
      console.error('[session-store] get failed:', err.message);
      return cb(null, null);
    }
  }

  set(sid, sess, cb) {
    try {
      this.db
        .prepare(`
          INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
        `)
        .run(sid, JSON.stringify(sess), this.#expiryOf(sess));
      return cb(null);
    } catch (err) {
      console.error('[session-store] set failed:', err.message);
      return cb(err);
    }
  }

  // Called for unmodified sessions when resave is false. Without it the
  // expiry would never move, so an active user would be logged out mid-event
  // exactly maxAge after logging in.
  touch(sid, sess, cb) {
    try {
      this.db
        .prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?')
        .run(this.#expiryOf(sess), sid);
      return cb(null);
    } catch (err) {
      console.error('[session-store] touch failed:', err.message);
      return cb(null); // a failed touch must not break the request
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return cb(null);
    } catch (err) {
      console.error('[session-store] destroy failed:', err.message);
      return cb(err);
    }
  }

  length(cb) {
    try {
      const { n } = this.db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?')
        .get(Date.now());
      return cb(null, n);
    } catch (err) {
      return cb(err);
    }
  }

  clear(cb) {
    try {
      this.db.exec('DELETE FROM sessions');
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }
}

module.exports = { SqliteSessionStore };
