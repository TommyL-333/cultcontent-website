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

  -- A creator's *entry* is their participation in a challenge: one per
  -- challenge, carrying the review status and the brand's note. It holds many
  -- links, because a brief like "three videos" is one submission reviewed and
  -- paid as a unit, not three competing ones.
  CREATE TABLE IF NOT EXISTS ccc_challenge_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id    INTEGER NOT NULL,
    url         TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ccc_links_entry ON ccc_challenge_links(entry_id);
`);

function addColumnIfMissing(table, columnDef) {
  const columnName = columnDef.trim().split(/\s+/)[0];
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === columnName)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}

// How many links the brief expects, and how it pays out.
addColumnIfMissing('ccc_challenges', `deliverables INTEGER NOT NULL DEFAULT 1`);
addColumnIfMissing('ccc_challenges', `reward_model TEXT NOT NULL DEFAULT 'completion'`); // 'completion' | 'winners'

// The review lifecycle. Without these an entry could be read but never acted
// on, so a brand tracked payouts to N creators outside the app entirely.
addColumnIfMissing('ccc_challenge_entries', `status      TEXT NOT NULL DEFAULT 'submitted'`); // submitted | accepted | winner | rejected
addColumnIfMissing('ccc_challenge_entries', `brand_note  TEXT NOT NULL DEFAULT ''`);
addColumnIfMissing('ccc_challenge_entries', `reviewed_at TEXT`);
addColumnIfMissing('ccc_challenge_entries', `paid_at     TEXT`);

// One-time move of the old single url column into the links table. The
// original model allowed exactly one link per creator and *overwrote* it on
// re-submit, so a second video silently destroyed the first.
(function migrateSingleUrlColumn() {
  const cols = db.prepare(`PRAGMA table_info(ccc_challenge_entries)`).all().map((c) => c.name);
  if (!cols.includes('url')) return;
  const rows = db.prepare(`SELECT id, url, note FROM ccc_challenge_entries WHERE url IS NOT NULL AND url != ''`).all();
  const insert = db.prepare(`INSERT INTO ccc_challenge_links (entry_id, url, note) VALUES (?, ?, ?)`);
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM ccc_challenge_links WHERE entry_id = ?`);
  for (const row of rows) {
    if (existing.get(row.id).n === 0) insert.run(row.id, row.url, row.note || '');
  }
  db.exec(`ALTER TABLE ccc_challenge_entries DROP COLUMN url`);
  if (rows.length) console.log(`[ccc-challenges] migrated ${rows.length} entry url(s) into ccc_challenge_links`);
})();

const MAX_OPEN_PER_BRAND = 20;
// Generous, but stops one creator flooding a brand's review queue.
const MAX_LINKS_PER_ENTRY = 10;
const ENTRY_STATUSES = ['submitted', 'accepted', 'winner', 'rejected'];

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

function createChallenge(brand, { title, description, reward, deadline, deliverables, reward_model }) {
  if (brand.role !== 'brand') return { ok: false, error: 'brands_only' };
  const name = (title || '').trim();
  if (!name) return { ok: false, error: 'title_required' };

  const open = db.prepare(`SELECT COUNT(*) AS n FROM ccc_challenges WHERE brand_person_id = ? AND status = 'open'`).get(brand.id).n;
  if (open >= MAX_OPEN_PER_BRAND) return { ok: false, error: 'too_many_open' };

  const count = Math.min(Math.max(parseInt(deliverables, 10) || 1, 1), MAX_LINKS_PER_ENTRY);
  const model = reward_model === 'winners' ? 'winners' : 'completion';

  const uuid = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO ccc_challenges (uuid, brand_person_id, title, description, reward, deadline, deliverables, reward_model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuid, brand.id, name.slice(0, 140), (description || '').trim().slice(0, 2000), (reward || '').trim().slice(0, 200), (deadline || '').trim() || null, count, model);

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
// A creator's own entry, with its links, so the challenge card can show
// "2 of 3 submitted" and the review outcome without a second request.
function getEntryForCreator(challengeId, creatorId) {
  const entry = db.prepare(`
    SELECT id, status, brand_note, reviewed_at, paid_at, created_at
    FROM ccc_challenge_entries WHERE challenge_id = ? AND creator_person_id = ?
  `).get(challengeId, creatorId);
  if (!entry) return null;
  return { ...entry, links: linksFor(entry.id) };
}

function linksFor(entryId) {
  return db.prepare(`SELECT id, url, note, created_at FROM ccc_challenge_links WHERE entry_id = ? ORDER BY id ASC`).all(entryId);
}

function listChallenges(viewer) {
  const rows = db.prepare(`
    SELECT c.*, p.brand_name, p.uuid AS brand_uuid, p.first_name, p.last_name,
           (SELECT COUNT(*) FROM ccc_challenge_entries e WHERE e.challenge_id = c.id) AS entry_count
    FROM ccc_challenges c JOIN ccc_people p ON p.id = c.brand_person_id
    WHERE p.status = 'approved'
    ORDER BY (c.status = 'open') DESC, c.created_at DESC
  `).all();

  return rows.map((row) => ({ ...serialize(row), my_entry: getEntryForCreator(row.id, viewer.id) }));
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

// Adds a link to the creator's entry, creating the entry on first submission.
// This used to be an upsert on a single url column, which meant a brief asking
// for three videos silently overwrote the first two.
function submitLink(creator, challengeUuid, { url, note }) {
  if (creator.role !== 'creator') return { ok: false, error: 'creators_only' };
  const challenge = db.prepare(`SELECT * FROM ccc_challenges WHERE uuid = ?`).get(challengeUuid);
  if (!challenge) return { ok: false, error: 'not_found' };
  if (challenge.status !== 'open') return { ok: false, error: 'closed' };

  const clean = normalizeUrl(url);
  if (!clean) return { ok: false, error: 'bad_url' };

  db.prepare(`
    INSERT INTO ccc_challenge_entries (challenge_id, creator_person_id, note)
    VALUES (?, ?, '')
    ON CONFLICT(challenge_id, creator_person_id) DO NOTHING
  `).run(challenge.id, creator.id);

  const entry = db.prepare(`SELECT * FROM ccc_challenge_entries WHERE challenge_id = ? AND creator_person_id = ?`)
    .get(challenge.id, creator.id);

  const links = linksFor(entry.id);
  if (links.length >= MAX_LINKS_PER_ENTRY) return { ok: false, error: 'too_many_links' };
  // Posting the same URL twice is a double-tap, not a second deliverable.
  if (links.some((l) => l.url === clean)) return { ok: false, error: 'duplicate_link' };

  db.prepare(`INSERT INTO ccc_challenge_links (entry_id, url, note) VALUES (?, ?, ?)`)
    .run(entry.id, clean, (note || '').trim().slice(0, 500));

  return { ok: true, challenge: getChallenge(challengeUuid), entry: getEntryForCreator(challenge.id, creator.id) };
}

function removeLink(creator, challengeUuid, linkId) {
  const challenge = db.prepare(`SELECT * FROM ccc_challenges WHERE uuid = ?`).get(challengeUuid);
  if (!challenge) return { ok: false, error: 'not_found' };
  const entry = db.prepare(`SELECT * FROM ccc_challenge_entries WHERE challenge_id = ? AND creator_person_id = ?`)
    .get(challenge.id, creator.id);
  if (!entry) return { ok: false, error: 'not_found' };

  // Scoped to this creator's own entry — a link id alone must not be enough
  // to delete somebody else's submission.
  db.prepare(`DELETE FROM ccc_challenge_links WHERE id = ? AND entry_id = ?`).run(linkId, entry.id);
  return { ok: true, challenge: getChallenge(challengeUuid), entry: getEntryForCreator(challenge.id, creator.id) };
}

function withdrawEntry(creator, challengeUuid) {
  const challenge = db.prepare(`SELECT * FROM ccc_challenges WHERE uuid = ?`).get(challengeUuid);
  if (!challenge) return { ok: false, error: 'not_found' };
  const entry = db.prepare(`SELECT id FROM ccc_challenge_entries WHERE challenge_id = ? AND creator_person_id = ?`)
    .get(challenge.id, creator.id);
  if (entry) {
    db.prepare(`DELETE FROM ccc_challenge_links WHERE entry_id = ?`).run(entry.id);
    db.prepare(`DELETE FROM ccc_challenge_entries WHERE id = ?`).run(entry.id);
  }
  return { ok: true, challenge: getChallenge(challengeUuid) };
}

// ─── Review: what happens after a creator submits ───────────────────────────
function reviewEntry(brand, challengeUuid, creatorUuid, { status, brand_note }) {
  if (!ENTRY_STATUSES.includes(status)) return { ok: false, error: 'bad_status' };
  const challenge = db.prepare(`SELECT * FROM ccc_challenges WHERE uuid = ?`).get(challengeUuid);
  if (!challenge) return { ok: false, error: 'not_found' };
  if (challenge.brand_person_id !== brand.id) return { ok: false, error: 'not_yours' };

  const creator = net.getPerson(creatorUuid);
  if (!creator) return { ok: false, error: 'not_found' };
  const entry = db.prepare(`SELECT * FROM ccc_challenge_entries WHERE challenge_id = ? AND creator_person_id = ?`)
    .get(challenge.id, creator.id);
  if (!entry) return { ok: false, error: 'not_found' };

  db.prepare(`UPDATE ccc_challenge_entries SET status = ?, brand_note = ?, reviewed_at = ? WHERE id = ?`)
    .run(status, (brand_note || '').trim().slice(0, 1000), new Date().toISOString(), entry.id);

  return { ok: true, challenge: getChallenge(challengeUuid), creator, status };
}

// Record-only. The app never moves money — this exists so a brand paying
// dozens of small rewards can see who is still outstanding.
function setEntryPaid(brand, challengeUuid, creatorUuid, paid) {
  const challenge = db.prepare(`SELECT * FROM ccc_challenges WHERE uuid = ?`).get(challengeUuid);
  if (!challenge) return { ok: false, error: 'not_found' };
  if (challenge.brand_person_id !== brand.id) return { ok: false, error: 'not_yours' };

  const creator = net.getPerson(creatorUuid);
  if (!creator) return { ok: false, error: 'not_found' };
  db.prepare(`UPDATE ccc_challenge_entries SET paid_at = ? WHERE challenge_id = ? AND creator_person_id = ?`)
    .run(paid ? new Date().toISOString() : null, challenge.id, creator.id);

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

  const rows = db.prepare(`
    SELECT e.id, e.note, e.created_at, e.status, e.brand_note, e.reviewed_at, e.paid_at,
           p.uuid, p.first_name, p.last_name, p.tiktok_handle, p.instagram_handle, p.category
    FROM ccc_challenge_entries e JOIN ccc_people p ON p.id = e.creator_person_id
    WHERE e.challenge_id = ? ORDER BY e.created_at DESC
  `).all(challenge.id);

  const entries = rows.map((r) => {
    const links = linksFor(r.id);
    return {
      ...r,
      links,
      // Against the brief's deliverable count, so a brand can see at a glance
      // who actually finished before deciding anything.
      complete: links.length >= challenge.deliverables,
    };
  });

  return { ok: true, challenge: getChallenge(challengeUuid), entries };
}

module.exports = {
  createChallenge, getChallenge, listChallenges, listMyChallenges,
  setChallengeStatus, submitLink, removeLink, withdrawEntry, listEntries,
  reviewEntry, setEntryPaid,
  normalizeUrl, // exported for the unit tests
  MAX_OPEN_PER_BRAND, MAX_LINKS_PER_ENTRY, ENTRY_STATUSES,
};
