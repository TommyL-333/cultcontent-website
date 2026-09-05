const { DatabaseSync: Database } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'ccc-creator-signups.db');
const db = new Database(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS ccc_creator_signups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    phone       TEXT,
    tiktok      TEXT,
    instagram   TEXT,
    sms_consent INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
  )
`);

function insert(data) {
  return db.prepare(`
    INSERT INTO ccc_creator_signups (name, email, phone, tiktok, instagram, sms_consent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.name, data.email, data.phone || null, data.tiktok || null, data.instagram || null, data.sms_consent ? 1 : 0);
}

function isDuplicate(email) {
  return !!db.prepare('SELECT id FROM ccc_creator_signups WHERE lower(email) = lower(?) LIMIT 1').get(email);
}

function list() {
  return db.prepare('SELECT * FROM ccc_creator_signups ORDER BY created_at DESC').all();
}

function count() {
  return db.prepare('SELECT COUNT(*) as n FROM ccc_creator_signups').get().n;
}

module.exports = { insert, isDuplicate, list, count, db };
