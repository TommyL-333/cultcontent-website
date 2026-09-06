/**
 * Creator Carnival — brand challenges
 *
 * A challenge is a brief a brand posts to the roster ("post a TikTok using
 * our product, tag us, best one wins X"). Creators link their submission
 * back to it with a URL. Reuses the shared SQLite connection from
 * lib/ccc-network.js — same file, same tables — rather than opening a
 * second handle, the same way lib/ccc-network-messages.js does.
 *
 * Only brands create challenges and only creators enter them; both are
 * enforced here rather than only in the UI, since the API is reachable
 * directly by anyone with a session.
 */

const net = require('./ccc-network');
const db = net.db;

db.exec(`
  CREATE TABLE IF NOT EXISTS ccc_challenges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid            TEXT UNIQUE NOT NULL,
    brand_person_id INTEGER NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    reward          TEXT NOT NULL DEFAULT '',
    deadline        TEXT,
    status          TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ccc_challenges_brand ON ccc_challenges(brand_person_id, status);

  CREATE TABLE IF NOT EXISTS ccc_challenge_entries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_id      INTEGER NOT NULL,
    creator_person_id INTEGER NOT NULL,
    url               TEXT NOT NULL,
    note              TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(challenge_id, creator_person_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ccc_entries_challenge ON ccc_challenge_entries(challenge_id);
`);

const MAX_OPEN_PER_BRAND = 20;

// Only ever accept a real http(s) link. Creators paste these from TikTok and
// Instagram share sheets, and the URL is rendered as an anchor on the brand's
// side — a `javascript:` or `data:` value reaching an href is the thing to
// keep out, so parse it properly instead of pattern-matching the string.
function normalizeUrl(raw) {
  const text = (raw || '').trim();
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let parsed;
  try { parsed = new URL(withScheme); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname.includes('.')) return null;
  return parsed.toString().slice(0, 500);
}

function serialize(row) {
  if (!row) return null;
  return { ...row, entry_count: row.entry_count ?? 0 };
}

function createChallenge(brand, { title, description, reward, deadline }) {
  if (brand.role !== 'brand') return { ok: false, error: 'brands_only' };
  const name = (title || '').trim();
  if (!name) return { ok: false, error: 'title_required' };

  const open = db.prepare(`SELECT COUNT(*) AS n FROM ccc_challenges WHERE brand_person_id = ? AND status = 'open'`).get(brand.id).n;
  if (open >= MAX_OPEN_PER_BRAND) return { ok: false, error: 'too_many_open' };

  const uuid = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO ccc_challenges (uuid, brand_person_id, title, description, reward, deadline)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid, brand.id, name.slice(0, 140), (description || '').trim().slice(0, 2000), (reward || '').trim().slice(0, 200), (deadline || '').trim() || null);

  return { ok: true, challenge: getChallenge(uuid) };
}

function getChallenge(uuid) {
  return serialize(db.prepare(`
    SELECT c.*, p.brand_name, p.uuid AS brand_uuid, p.first_name, p.last_name,
           (SELECT COUNT(*) FROM ccc_challenge_entries e WHERE e.challenge_id = c.id) AS entry_count
    FROM ccc_challenges c JOIN ccc_people p ON p.id = c.brand_person_id
    WHERE c.uuid = ?
  `).get(uuid));
}

// The roster-wide feed. Challenges from deactivated or rejected brands drop
// out automatically via the status join rather than needing a cleanup pass.
function listChallenges(viewer) {
  const rows = db.prepare(`
    SELECT c.*, p.brand_name, p.uuid AS brand_uuid, p.first_name, p.last_name,
           (SELECT COUNT(*) FROM ccc_challenge_entries e WHERE e.challenge_id = c.id) AS entry_count,
           (SELECT e.url FROM ccc_challenge_entries e WHERE e.challenge_id = c.id AND e.creator_person_id = ?) AS my_entry_url
    FROM ccc_challenges c JOIN ccc_people p ON p.id = c.brand_person_id
    WHERE p.status = 'approved'
    ORDER BY (c.status = 'open') DESC, c.created_at DESC
  `).all(viewer.id);
  return rows.map(serialize);
}

function listMyChallenges(brand) {
  const rows = db.prepare(`
    SELECT c.*, p.brand_name, p.uuid AS brand_uuid, p.first_name, p.last_name,
           (SELECT COUNT(*) FROM ccc_challenge_entries e WHERE e.challenge_id = c.id) AS entry_count
    FROM ccc_challenges c JOIN ccc_people p ON p.id = c.brand_person_id
    WHERE c.brand_person_id = ? ORDER BY c.created_at DESC
  `).all(brand.id);
  return rows.map(serialize);
}

function setChallengeStatus(brand, uuid, status) {
  if (!['open', 'closed'].includes(status)) return { ok: false, error: 'bad_status' };
  const row = db.prepare(`SELECT * FROM ccc_challenges WHERE uuid = ?`).get(uuid);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.brand_person_id !== brand.id) return { ok: false, error: 'not_yours' };
  db.prepare(`UPDATE ccc_challenges SET status = ? WHERE id = ?`).run(status, row.id);
  return { ok: true, challenge: getChallenge(uuid) };
}

// Re-submitting replaces the previous link rather than erroring — a creator
// fixing a typo'd URL or swapping in a re-uploaded video is the common case,
// and the UNIQUE(challenge_id, creator_person_id) index makes it one upsert.
function submitEntry(creator, challengeUuid, { url, note }) {
  if (creator.role !== 'creator') return { ok: false, error: 'creators_only' };
  const challenge = db.prepare(`SELECT * FROM ccc_challenges WHERE uuid = ?`).get(challengeUuid);
  if (!challenge) return { ok: false, error: 'not_found' };
  if (challenge.status !== 'open') return { ok: false, error: 'closed' };

  const clean = normalizeUrl(url);
  if (!clean) return { ok: false, error: 'bad_url' };

  db.prepare(`
    INSERT INTO ccc_challenge_entries (challenge_id, creator_person_id, url, note)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(challenge_id, creator_person_id) DO UPDATE SET url = excluded.url, note = excluded.note
  `).run(challenge.id, creator.id, clean, (note || '').trim().slice(0, 500));

  return { ok: true, challenge: getChallenge(challengeUuid) };
}

function withdrawEntry(creator, challengeUuid) {
  const challenge = db.prepare(`SELECT * FROM ccc_challenges WHERE uuid = ?`).get(challengeUuid);
  if (!challenge) return { ok: false, error: 'not_found' };
  db.prepare(`DELETE FROM ccc_challenge_entries WHERE challenge_id = ? AND creator_person_id = ?`).run(challenge.id, creator.id);
  return { ok: true, challenge: getChallenge(challengeUuid) };
}

// Entries are only ever visible to the brand that posted the challenge —
// one brand should not be able to read which creators entered a competitor's.
// Contact details stay out of this payload regardless of connection state;
// the entry list is a link roster, not a contact export.
function listEntries(brand, challengeUuid) {
  const challenge = db.prepare(`SELECT * FROM ccc_challenges WHERE uuid = ?`).get(challengeUuid);
  if (!challenge) return { ok: false, error: 'not_found' };
  if (challenge.brand_person_id !== brand.id) return { ok: false, error: 'not_yours' };

  const entries = db.prepare(`
    SELECT e.url, e.note, e.created_at,
           p.uuid, p.first_name, p.last_name, p.tiktok_handle, p.instagram_handle, p.category
    FROM ccc_challenge_entries e JOIN ccc_people p ON p.id = e.creator_person_id
    WHERE e.challenge_id = ? ORDER BY e.created_at DESC
  `).all(challenge.id);

  return { ok: true, challenge: getChallenge(challengeUuid), entries };
}

module.exports = {
  createChallenge, getChallenge, listChallenges, listMyChallenges,
  setChallengeStatus, submitEntry, withdrawEntry, listEntries,
  normalizeUrl, // exported for the unit tests
  MAX_OPEN_PER_BRAND,
};
