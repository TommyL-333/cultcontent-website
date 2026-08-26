/**
 * Creator Carnival — Networking Hub
 *
 * Roster of approved creators + brands who can browse each other, send
 * connection requests, and — once accepted — see each other's contact info
 * and message. Backs the "creator-matchmaking suite" / "connect with 1,000+
 * creators" promises made on the CCC marketing pages. See
 * ccc-network-mail.js for email delivery and ccc-network-messages.js for
 * the inbox/messaging layer built on top of accepted connections.
 */

const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const { DatabaseSync: Database } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'ccc-network.db');
const db = new Database(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS ccc_people (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid            TEXT UNIQUE NOT NULL,
    role            TEXT NOT NULL,                    -- 'creator' | 'brand'
    tier            TEXT NOT NULL DEFAULT 'general',   -- 'general' | 'priority' | 'executive'
    status          TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected' | 'deactivated'
    first_name      TEXT,
    last_name       TEXT,
    email           TEXT UNIQUE NOT NULL,
    phone           TEXT,
    brand_name      TEXT,
    tiktok_handle   TEXT,
    instagram_handle TEXT,
    category        TEXT,
    bio             TEXT,
    links           TEXT,                              -- JSON array [{label,url}]
    looking_for     TEXT,
    ghl_contact_id  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ccc_people_role_status ON ccc_people(role, status);

  CREATE TABLE IF NOT EXISTS ccc_connections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_person_id  INTEGER NOT NULL,
    to_person_id    INTEGER NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_person_id, to_person_id)
  );

  CREATE TABLE IF NOT EXISTS ccc_magic_links (
    token           TEXT PRIMARY KEY,
    person_id       INTEGER NOT NULL,
    expires_at      TEXT NOT NULL,
    used_at         TEXT
  );

  CREATE TABLE IF NOT EXISTS ccc_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id   INTEGER NOT NULL,
    from_person_id  INTEGER NOT NULL,
    to_person_id    INTEGER NOT NULL,
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    read_at         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ccc_messages_connection ON ccc_messages(connection_id);

  CREATE TABLE IF NOT EXISTS ccc_email_change_tokens (
    token           TEXT PRIMARY KEY,
    person_id       INTEGER NOT NULL,
    new_email       TEXT NOT NULL,
    expires_at      TEXT NOT NULL
  );
`);

// ─── Additive migrations for columns added after initial release ──────────────
// better-sqlite3 has no "ADD COLUMN IF NOT EXISTS" — guard each with a
// duplicate-column catch so this stays safely re-runnable on every boot,
// same idea as the CREATE TABLE IF NOT EXISTS statements above.
function addColumnIfMissing(table, columnDef) {
  const columnName = columnDef.trim().split(/\s+/)[0];
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some(c => c.name === columnName)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}
addColumnIfMissing('ccc_people', `notify_request  INTEGER NOT NULL DEFAULT 1`);
addColumnIfMissing('ccc_people', `notify_approval INTEGER NOT NULL DEFAULT 1`);
addColumnIfMissing('ccc_people', `notify_message  INTEGER NOT NULL DEFAULT 1`);
addColumnIfMissing('ccc_connections', `status       TEXT NOT NULL DEFAULT 'pending'`); // pending | accepted | declined
addColumnIfMissing('ccc_connections', `responded_at TEXT`);

// One-time rename: `handle` was originally a single combined TikTok/IG
// field. Splitting it into tiktok_handle + instagram_handle needed a real
// schema change, not just a UI relabel — existing values are kept as
// tiktok_handle (the event's primary platform), not lost. No-ops once
// already migrated, and no-ops on a fresh install that never had `handle`.
function renameColumnIfNeeded(table, oldName, newName) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some(c => c.name === newName)) return;
  if (!existing.some(c => c.name === oldName)) return;
  db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
}
renameColumnIfNeeded('ccc_people', 'handle', 'tiktok_handle');
addColumnIfMissing('ccc_people', `instagram_handle TEXT`);

const MAGIC_LINK_TTL_MINUTES = 30;
const EMAIL_CHANGE_TTL_MINUTES = 30;
const PRIORITY_TIERS = ['priority', 'executive'];

function newUuid() {
  return crypto.randomUUID();
}

function serializePerson(row) {
  if (!row) return null;
  return { ...row, links: row.links ? JSON.parse(row.links) : [] };
}

// Strip contact fields — used anywhere a person's basic info is shown to
// someone who hasn't (yet) got an accepted connection with them.
function withoutContact(person) {
  if (!person) return person;
  const { email, phone, ghl_contact_id, ...rest } = person;
  return rest;
}

// ─── Signup / profile ──────────────────────────────────────────────────────────
function signup({ role, first_name, last_name, email, phone, brand_name, tiktok_handle, instagram_handle, category, bio, links, looking_for, tier }) {
  if (!['creator', 'brand'].includes(role)) return { ok: false, error: 'role must be creator or brand' };
  if (!email || !first_name) return { ok: false, error: 'first_name and email are required' };
  if (role === 'brand' && !brand_name) return { ok: false, error: 'brand_name is required for brand signups' };

  const existing = db.prepare(`SELECT id, uuid, status FROM ccc_people WHERE email = ?`).get(email.toLowerCase().trim());
  if (existing) {
    // A still-pending row (email never confirmed) is safe to treat as a
    // resend + refresh rather than a hard conflict — their original
    // confirmation link most likely just expired, and self-serve signup
    // has no other way for them to get a new one. Anything already
    // approved/rejected/deactivated is a real conflict.
    if (existing.status !== 'pending') return { ok: false, error: 'already_registered', status: existing.status };
    updateProfile(existing.id, { first_name, last_name, phone, brand_name, tiktok_handle, instagram_handle, category, bio, links, looking_for });
    return { ok: true, uuid: existing.uuid, resent: true };
  }

  const uuid = newUuid();
  const declaredTier = role === 'brand' && PRIORITY_TIERS.includes(tier) ? tier : 'general';

  db.prepare(`
    INSERT INTO ccc_people (uuid, role, tier, first_name, last_name, email, phone, brand_name, tiktok_handle, instagram_handle, category, bio, links, looking_for)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuid, role, declaredTier, first_name, last_name || '', email.toLowerCase().trim(), phone || '', brand_name || '', tiktok_handle || '', instagram_handle || '', category || '', bio || '', JSON.stringify(links || []), looking_for || '');

  return { ok: true, uuid };
}

function getPerson(idOrUuid) {
  const row = typeof idOrUuid === 'number'
    ? db.prepare(`SELECT * FROM ccc_people WHERE id = ?`).get(idOrUuid)
    : db.prepare(`SELECT * FROM ccc_people WHERE uuid = ?`).get(idOrUuid);
  return serializePerson(row);
}

function getPersonByEmail(email) {
  return serializePerson(db.prepare(`SELECT * FROM ccc_people WHERE email = ?`).get((email || '').toLowerCase().trim()));
}

function updateProfile(id, { first_name, last_name, phone, brand_name, tiktok_handle, instagram_handle, category, bio, links, looking_for }) {
  db.prepare(`
    UPDATE ccc_people SET
      first_name = ?, last_name = ?, phone = ?, brand_name = ?, tiktok_handle = ?, instagram_handle = ?,
      category = ?, bio = ?, links = ?, looking_for = ?
    WHERE id = ?
  `).run(first_name || '', last_name || '', phone || '', brand_name || '', tiktok_handle || '', instagram_handle || '', category || '', bio || '', JSON.stringify(links || []), looking_for || '', id);
  return getPerson(id);
}

function setGhlContactId(id, ghlContactId) {
  db.prepare(`UPDATE ccc_people SET ghl_contact_id = ? WHERE id = ?`).run(ghlContactId, id);
}

function setStatus(uuid, { status, tier }) {
  const allowed = ['pending', 'approved', 'rejected', 'deactivated'];
  if (!allowed.includes(status)) return { ok: false, error: `status must be one of: ${allowed.join(', ')}` };
  const person = getPerson(uuid);
  if (!person) return { ok: false, error: 'not_found' };

  const nextTier = tier && ['general', 'priority', 'executive'].includes(tier) ? tier : person.tier;
  const approvedAt = status === 'approved' ? new Date().toISOString() : person.approved_at;
  db.prepare(`UPDATE ccc_people SET status = ?, tier = ?, approved_at = ? WHERE uuid = ?`).run(status, nextTier, approvedAt, uuid);
  return { ok: true, person: getPerson(uuid) };
}

// ─── Magic links ────────────────────────────────────────────────────────────────
function createMagicLink(email) {
  const person = getPersonByEmail(email);
  if (!person || person.status !== 'approved') return null; // caller responds generically either way
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO ccc_magic_links (token, person_id, expires_at) VALUES (?, ?, ?)`).run(token, person.id, expiresAt);
  return { token, person };
}

// Sent immediately at signup so account creation is self-serve — no admin
// approval required. Same shape as createMagicLink, but keyed by id/uuid
// (not email) and skips the `status === 'approved'` gate, since the person
// is still 'pending' at this point. Consuming it, via the same
// GET /ccc-network/auth/:token route a login link uses, is what actually
// proves the email is real and flips them to 'approved' — see
// dashboard-server.js.
function createVerifyLink(idOrUuid) {
  const person = getPerson(idOrUuid);
  if (!person) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO ccc_magic_links (token, person_id, expires_at) VALUES (?, ?, ?)`).run(token, person.id, expiresAt);
  return { token, person };
}

function consumeMagicLink(token) {
  const link = db.prepare(`SELECT * FROM ccc_magic_links WHERE token = ?`).get(token);
  if (!link) return { ok: false, error: 'invalid_token' };
  if (link.used_at) return { ok: false, error: 'already_used' };
  if (new Date(link.expires_at) < new Date()) return { ok: false, error: 'expired' };
  db.prepare(`UPDATE ccc_magic_links SET used_at = datetime('now') WHERE token = ?`).run(token);
  const person = getPerson(link.person_id);
  return { ok: true, person };
}

// ─── Directory ──────────────────────────────────────────────────────────────────
function generalRosterIsOpen() {
  const opensAt = process.env.CCC_NETWORK_GENERAL_OPENS_AT;
  if (!opensAt) return true;
  return new Date() >= new Date(opensAt);
}

// What `forPerson` is allowed to browse right now. Directory cards never
// include contact info — that only appears via getPersonProfile() once
// there's an accepted connection.
function listDirectory(forPerson) {
  const canSeeAll = forPerson.role === 'creator' || PRIORITY_TIERS.includes(forPerson.tier) || generalRosterIsOpen();
  if (!canSeeAll) return { gated: true, opensAt: process.env.CCC_NETWORK_GENERAL_OPENS_AT, people: [] };

  const rows = db.prepare(`
    SELECT uuid, role, first_name, last_name, brand_name, tiktok_handle, instagram_handle, category, bio, links, looking_for
    FROM ccc_people WHERE status = 'approved' AND id != ?
    ORDER BY created_at DESC
  `).all(forPerson.id);
  return { gated: false, people: rows.map(serializePerson) };
}

// ─── Connections: request → accept/decline ─────────────────────────────────────
function getConnectionRow(personAId, personBId) {
  return db.prepare(`
    SELECT * FROM ccc_connections
    WHERE (from_person_id = ? AND to_person_id = ?) OR (from_person_id = ? AND to_person_id = ?)
  `).get(personAId, personBId, personBId, personAId);
}

// Send (or re-send after a decline) a connection request. Does NOT reveal
// contact info — that only happens once the recipient accepts.
function connect(fromId, toUuid) {
  const to = getPerson(toUuid);
  if (!to || to.status !== 'approved') return { ok: false, error: 'not_found' };
  if (to.id === fromId) return { ok: false, error: 'cannot_connect_to_self' };

  const existing = getConnectionRow(fromId, to.id);
  if (existing?.status === 'accepted') return { ok: true, status: 'accepted' };
  if (existing?.status === 'pending')  return { ok: true, status: 'pending' };

  if (existing) {
    // Previously declined — let the original requester try again.
    db.prepare(`UPDATE ccc_connections SET from_person_id = ?, to_person_id = ?, status = 'pending', responded_at = NULL, created_at = datetime('now') WHERE id = ?`)
      .run(fromId, to.id, existing.id);
  } else {
    db.prepare(`INSERT INTO ccc_connections (from_person_id, to_person_id, status) VALUES (?, ?, 'pending')`).run(fromId, to.id);
  }
  return { ok: true, status: 'pending', otherPerson: withoutContact(to) };
}

// personId responding to a request that was sent TO them, from fromUuid.
function respondToConnection(personId, fromUuid, accept) {
  const from = getPerson(fromUuid);
  if (!from) return { ok: false, error: 'not_found' };
  const row = db.prepare(`SELECT * FROM ccc_connections WHERE from_person_id = ? AND to_person_id = ? AND status = 'pending'`).get(from.id, personId);
  if (!row) return { ok: false, error: 'not_found' };

  const status = accept ? 'accepted' : 'declined';
  db.prepare(`UPDATE ccc_connections SET status = ?, responded_at = datetime('now') WHERE id = ?`).run(status, row.id);
  return { ok: true, status, otherPerson: accept ? from : withoutContact(from) };
}

function listConnections(personId) {
  const rows = db.prepare(`
    SELECT c.*,
      pf.uuid as from_uuid, pf.first_name as from_first, pf.last_name as from_last, pf.role as from_role, pf.brand_name as from_brand, pf.tiktok_handle as from_tiktok, pf.instagram_handle as from_instagram, pf.category as from_category,
      pt.uuid as to_uuid, pt.first_name as to_first, pt.last_name as to_last, pt.role as to_role, pt.brand_name as to_brand, pt.tiktok_handle as to_tiktok, pt.instagram_handle as to_instagram, pt.category as to_category
    FROM ccc_connections c
    JOIN ccc_people pf ON pf.id = c.from_person_id
    JOIN ccc_people pt ON pt.id = c.to_person_id
    WHERE c.from_person_id = ? OR c.to_person_id = ?
    ORDER BY c.created_at DESC
  `).all(personId, personId);

  const other = (r) => r.from_person_id === personId
    ? { uuid: r.to_uuid, first_name: r.to_first, last_name: r.to_last, role: r.to_role, brand_name: r.to_brand, tiktok_handle: r.to_tiktok, instagram_handle: r.to_instagram, category: r.to_category }
    : { uuid: r.from_uuid, first_name: r.from_first, last_name: r.from_last, role: r.from_role, brand_name: r.from_brand, tiktok_handle: r.from_tiktok, instagram_handle: r.from_instagram, category: r.from_category };

  const current = [], incoming = [], outgoing = [];
  for (const r of rows) {
    if (r.status === 'accepted') current.push(other(r));
    else if (r.status === 'pending' && r.to_person_id === personId) incoming.push(other(r));
    else if (r.status === 'pending' && r.from_person_id === personId) outgoing.push(other(r));
  }
  return { current, incoming, outgoing };
}

// Full profile for viewing someone else — contact info only included if
// viewer and target have an accepted connection.
function getPersonProfile(viewerId, uuid) {
  const target = getPerson(uuid);
  if (!target || target.status !== 'approved') return null;
  if (target.id === viewerId) return { ...target, relationship: 'self' };

  const row = getConnectionRow(viewerId, target.id);
  let relationship = 'none';
  if (row?.status === 'accepted') relationship = 'accepted';
  else if (row?.status === 'pending' && row.from_person_id === viewerId) relationship = 'outgoing';
  else if (row?.status === 'pending' && row.to_person_id === viewerId) relationship = 'incoming';

  const person = relationship === 'accepted' ? target : withoutContact(target);
  return { ...person, relationship };
}

// ─── Settings ───────────────────────────────────────────────────────────────────
function setNotificationPrefs(id, { notify_request, notify_approval, notify_message }) {
  db.prepare(`UPDATE ccc_people SET notify_request = ?, notify_approval = ?, notify_message = ? WHERE id = ?`)
    .run(notify_request ? 1 : 0, notify_approval ? 1 : 0, notify_message ? 1 : 0, id);
  return getPerson(id);
}

function setTierRequest(id, tier) {
  if (!PRIORITY_TIERS.includes(tier) && tier !== 'general') return { ok: false, error: 'invalid_tier' };
  db.prepare(`UPDATE ccc_people SET tier = ? WHERE id = ?`).run(tier, id);
  return { ok: true, person: getPerson(id) };
}

function deactivate(id) {
  db.prepare(`UPDATE ccc_people SET status = 'deactivated' WHERE id = ?`).run(id);
}

function requestEmailChange(personId, newEmail) {
  const clean = (newEmail || '').toLowerCase().trim();
  if (!clean || !clean.includes('@')) return { ok: false, error: 'invalid_email' };
  const taken = db.prepare(`SELECT id FROM ccc_people WHERE email = ? AND id != ?`).get(clean, personId);
  if (taken) return { ok: false, error: 'email_in_use' };

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MINUTES * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO ccc_email_change_tokens (token, person_id, new_email, expires_at) VALUES (?, ?, ?, ?)`).run(token, personId, clean, expiresAt);
  return { ok: true, token, newEmail: clean };
}

function confirmEmailChange(token) {
  const row = db.prepare(`SELECT * FROM ccc_email_change_tokens WHERE token = ?`).get(token);
  if (!row) return { ok: false, error: 'invalid_token' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, error: 'expired' };
  db.prepare(`UPDATE ccc_people SET email = ? WHERE id = ?`).run(row.new_email, row.person_id);
  db.prepare(`DELETE FROM ccc_email_change_tokens WHERE token = ?`).run(token);
  return { ok: true, person: getPerson(row.person_id) };
}

// ─── Admin ──────────────────────────────────────────────────────────────────────
function listAll({ role, status, tier } = {}) {
  let sql = `SELECT * FROM ccc_people WHERE 1=1`;
  const params = [];
  if (role)   { sql += ` AND role = ?`;   params.push(role); }
  if (status) { sql += ` AND status = ?`; params.push(status); }
  if (tier)   { sql += ` AND tier = ?`;   params.push(tier); }
  sql += ` ORDER BY id ASC`;
  return db.prepare(sql).all(...params).map(serializePerson);
}

function listApprovedCreatorsForExport() {
  return db.prepare(`SELECT first_name, last_name, email, phone, tiktok_handle, instagram_handle, category, bio FROM ccc_people WHERE role = 'creator' AND status = 'approved' ORDER BY created_at ASC`).all();
}

module.exports = {
  db, // shared connection — lib/ccc-network-messages.js reuses this rather than opening a second handle on the same file
  signup, getPerson, getPersonByEmail, updateProfile, setGhlContactId, setStatus,
  createMagicLink, createVerifyLink, consumeMagicLink,
  listDirectory, connect, respondToConnection, listConnections, getPersonProfile, generalRosterIsOpen,
  setNotificationPrefs, setTierRequest, deactivate, requestEmailChange, confirmEmailChange,
  listAll, listApprovedCreatorsForExport,
  PRIORITY_TIERS,
  getConnectionRow, // reused by ccc-network-messages.js to validate a connection is accepted before allowing messages
};
