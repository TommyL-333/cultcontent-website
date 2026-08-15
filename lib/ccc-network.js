/**
 * Creator Carnival — Networking Hub
 *
 * Roster of approved creators + brands who can browse each other and
 * "connect" (reveal contact info both ways, logged as a request). Backs the
 * "creator-matchmaking suite" / "connect with 1,000+ creators" promises made
 * on the CCC marketing pages. See ccc-network-mail.js for email delivery and
 * ccc-network-views.js for the server-rendered pages built on top of this.
 */

const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const Database  = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'ccc-network.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS ccc_people (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid            TEXT UNIQUE NOT NULL,
    role            TEXT NOT NULL,                    -- 'creator' | 'brand'
    tier            TEXT NOT NULL DEFAULT 'general',   -- 'general' | 'priority' | 'executive'
    status          TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
    first_name      TEXT,
    last_name       TEXT,
    email           TEXT UNIQUE NOT NULL,
    phone           TEXT,
    brand_name      TEXT,
    handle          TEXT,
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
`);

const MAGIC_LINK_TTL_MINUTES = 30;
const PRIORITY_TIERS = ['priority', 'executive'];

function newUuid() {
  return crypto.randomUUID();
}

function serializePerson(row) {
  if (!row) return null;
  return { ...row, links: row.links ? JSON.parse(row.links) : [] };
}

// ─── Signup / profile ──────────────────────────────────────────────────────────
function signup({ role, first_name, last_name, email, phone, brand_name, handle, category, bio, links, looking_for, tier }) {
  if (!['creator', 'brand'].includes(role)) return { ok: false, error: 'role must be creator or brand' };
  if (!email || !first_name) return { ok: false, error: 'first_name and email are required' };
  if (role === 'brand' && !brand_name) return { ok: false, error: 'brand_name is required for brand signups' };

  const existing = db.prepare(`SELECT uuid, status FROM ccc_people WHERE email = ?`).get(email.toLowerCase().trim());
  if (existing) return { ok: false, error: 'already_registered', status: existing.status };

  const uuid = newUuid();
  const declaredTier = role === 'brand' && PRIORITY_TIERS.includes(tier) ? tier : 'general';

  db.prepare(`
    INSERT INTO ccc_people (uuid, role, tier, first_name, last_name, email, phone, brand_name, handle, category, bio, links, looking_for)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuid, role, declaredTier, first_name, last_name || '', email.toLowerCase().trim(), phone || '', brand_name || '', handle || '', category || '', bio || '', JSON.stringify(links || []), looking_for || '');

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

function updateProfile(id, { first_name, last_name, phone, brand_name, handle, category, bio, links, looking_for }) {
  db.prepare(`
    UPDATE ccc_people SET
      first_name = ?, last_name = ?, phone = ?, brand_name = ?, handle = ?,
      category = ?, bio = ?, links = ?, looking_for = ?
    WHERE id = ?
  `).run(first_name || '', last_name || '', phone || '', brand_name || '', handle || '', category || '', bio || '', JSON.stringify(links || []), looking_for || '', id);
  return getPerson(id);
}

function setGhlContactId(id, ghlContactId) {
  db.prepare(`UPDATE ccc_people SET ghl_contact_id = ? WHERE id = ?`).run(ghlContactId, id);
}

function setStatus(uuid, { status, tier }) {
  const allowed = ['pending', 'approved', 'rejected'];
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

function consumeMagicLink(token) {
  const link = db.prepare(`SELECT * FROM ccc_magic_links WHERE token = ?`).get(token);
  if (!link) return { ok: false, error: 'invalid_token' };
  if (link.used_at) return { ok: false, error: 'already_used' };
  if (new Date(link.expires_at) < new Date()) return { ok: false, error: 'expired' };
  db.prepare(`UPDATE ccc_magic_links SET used_at = datetime('now') WHERE token = ?`).run(token);
  const person = getPerson(link.person_id);
  return { ok: true, person };
}

// ─── Directory + connections ────────────────────────────────────────────────────
function generalRosterIsOpen() {
  const opensAt = process.env.CCC_NETWORK_GENERAL_OPENS_AT;
  if (!opensAt) return true;
  return new Date() >= new Date(opensAt);
}

// What `forPerson` is allowed to browse right now.
function listDirectory(forPerson) {
  const canSeeAll = forPerson.role === 'creator' || PRIORITY_TIERS.includes(forPerson.tier) || generalRosterIsOpen();
  if (!canSeeAll) return { gated: true, opensAt: process.env.CCC_NETWORK_GENERAL_OPENS_AT, people: [] };

  const rows = db.prepare(`
    SELECT uuid, role, first_name, last_name, brand_name, handle, category, bio, links, looking_for
    FROM ccc_people WHERE status = 'approved' AND id != ?
    ORDER BY created_at DESC
  `).all(forPerson.id);
  return { gated: false, people: rows.map(serializePerson) };
}

function connect(fromId, toUuid) {
  const to = getPerson(toUuid);
  if (!to || to.status !== 'approved') return { ok: false, error: 'not_found' };
  if (to.id === fromId) return { ok: false, error: 'cannot_connect_to_self' };
  db.prepare(`INSERT OR IGNORE INTO ccc_connections (from_person_id, to_person_id) VALUES (?, ?)`).run(fromId, to.id);
  return { ok: true, otherPerson: to };
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
  return db.prepare(`SELECT first_name, last_name, email, phone, handle, category, bio FROM ccc_people WHERE role = 'creator' AND status = 'approved' ORDER BY created_at ASC`).all();
}

module.exports = {
  signup, getPerson, getPersonByEmail, updateProfile, setGhlContactId, setStatus,
  createMagicLink, consumeMagicLink,
  listDirectory, connect, generalRosterIsOpen,
  listAll, listApprovedCreatorsForExport,
  PRIORITY_TIERS,
};
