/**
 * Creator Carnival — booth signups
 *
 * Replaces the Lark "Creator Carnival — Booth Signups" grid as the system of
 * record for the two low-cost booth tiers (Freedom Way / Commerce, Capitol
 * Canopy / Culture). SQLite file lives on the same DATA_DIR volume the rest
 * of the app already persists to.
 *
 * Booth reservation is a two-step flow:
 *   1. POST /ccc-booth-signup holds a slot (status='Pending') and returns a
 *      Stripe payment link with the reservation id + email pre-filled.
 *   2. Payment confirmation currently has no live webhook (no Stripe keys
 *      configured yet) — use the admin status endpoint to mark Paid by hand
 *      until one is wired up. Stale Pending holds auto-expire after 48h so
 *      abandoned checkouts don't permanently eat a slot.
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { DatabaseSync: Database } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'ccc-booths.db');
const db = new Database(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS ccc_booth_signups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id  TEXT UNIQUE NOT NULL,
    booth_type      TEXT NOT NULL,
    submission_time TEXT NOT NULL,
    first_name      TEXT,
    last_name       TEXT,
    email           TEXT NOT NULL,
    brand_name      TEXT NOT NULL,
    product_category TEXT,
    status          TEXT NOT NULL DEFAULT 'Pending',
    payment_url     TEXT,
    invited_by      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ccc_booth_type_status ON ccc_booth_signups(booth_type, status);
`);

const PENDING_TTL_HOURS = 48;
const HELD_STATUSES = ['Paid', 'Pending']; // both count against capacity

const CCC_BOOTHS = {
  'freedom-way': {
    label: 'Freedom Way Booth',
    total: 81,
    stripeBaseUrl: 'https://buy.stripe.com/9B614m85fd0Y5YG7CydZ60k',
  },
  'capitol-canopy': {
    label: 'Capitol Canopy Booth',
    total: 60,
    stripeBaseUrl: 'https://buy.stripe.com/00wbJ0dpz5yw1Iq3midZ60l',
  },
};

// ─── Historical backfill — the 4 rows from the Lark export ────────────────────
const SEED_ROWS = [
  { reservation_id: '4a551f300557683c037ca211', booth_type: 'freedom-way', submission_time: '07/26/2026, 05:46 PM', first_name: 'test', last_name: 'test', email: 'test@test.com', brand_name: 'test', product_category: 'test', status: 'Expired', payment_url: 'https://buy.stripe.com/4gMdR8dpz0ec1Iq6yudZ60c?client_reference_id=4a551f300557683c037ca211&prefilled_email=test%40test.com', invited_by: '' },
  { reservation_id: 'fb40f25df5bef7d440b5930e', booth_type: 'capitol-canopy', submission_time: '08/08/2026, 02:43 PM', first_name: 'Tommy', last_name: 'Lynch', email: 'Tommy@cultcontent.cc', brand_name: 'Cult Content', product_category: 'Social Commerce', status: 'Expired', payment_url: 'https://buy.stripe.com/8x26oGadn1igcn4cWSdZ60b?client_reference_id=fb40f25df5bef7d440b5930e&prefilled_email=Tommy%40cultcontent.cc', invited_by: '' },
  { reservation_id: '595b2eea6468857e8519d475', booth_type: 'capitol-canopy', submission_time: '08/11/2026, 12:46 AM', first_name: 'Tsolmon', last_name: 'Damba', email: 'tsolmonsart@gmail.com', brand_name: 'Tsolmon-Art', product_category: 'Original hand painted art works ( No print)', status: 'Paid', payment_url: 'https://buy.stripe.com/8x26oGadn1igcn4cWSdZ60b?client_reference_id=595b2eea6468857e8519d475&prefilled_email=tsolmonsart%40gmail.com', invited_by: 'Tommy Lynch' },
  { reservation_id: 'cfbc2b5ee0a61c02df29a042', booth_type: 'capitol-canopy', submission_time: '08/11/2026, 03:43 PM', first_name: 'Justin', last_name: 'Adams', email: 'justin.adams@oceanblueomega.com', brand_name: 'Oceanblue LLC', product_category: 'Omega -3 Supplements', status: 'Paid', payment_url: 'https://buy.stripe.com/8x26oGadn1igcn4cWSdZ60b?client_reference_id=cfbc2b5ee0a61c02df29a042&prefilled_email=justin.adams%40oceanblueomega.com', invited_by: 'Damon' },
];

function seedFromCsv() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO ccc_booth_signups
      (reservation_id, booth_type, submission_time, first_name, last_name, email, brand_name, product_category, status, payment_url, invited_by)
    VALUES (@reservation_id, @booth_type, @submission_time, @first_name, @last_name, @email, @brand_name, @product_category, @status, @payment_url, @invited_by)
  `);
  db.exec('BEGIN');
  try { SEED_ROWS.forEach(row => insert.run(row)); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
seedFromCsv();

// ─── Lazily expire stale Pending holds ─────────────────────────────────────────
function expireStale() {
  db.prepare(`
    UPDATE ccc_booth_signups
    SET status = 'Expired'
    WHERE status = 'Pending'
      AND created_at < datetime('now', ?)
  `).run(`-${PENDING_TTL_HOURS} hours`);
}

function getAvailability() {
  expireStale();
  const countStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM ccc_booth_signups
    WHERE booth_type = ? AND status IN (${HELD_STATUSES.map(() => '?').join(',')})
  `);
  const out = {};
  for (const [slug, cfg] of Object.entries(CCC_BOOTHS)) {
    const { n } = countStmt.get(slug, ...HELD_STATUSES);
    out[slug] = { available: Math.max(0, cfg.total - n), total: cfg.total };
  }
  return out;
}

function createSignup({ booth_type, first_name, last_name, email, brand_name, product_category, invited_by }) {
  const cfg = CCC_BOOTHS[booth_type];
  if (!cfg) return { ok: false, error: 'unknown_booth_type' };
  if (!email || !brand_name) return { ok: false, error: 'email and brand_name are required' };

  expireStale();
  const { n } = db.prepare(`
    SELECT COUNT(*) AS n FROM ccc_booth_signups
    WHERE booth_type = ? AND status IN (${HELD_STATUSES.map(() => '?').join(',')})
  `).get(booth_type, ...HELD_STATUSES);
  if (n >= cfg.total) return { ok: false, error: 'sold_out' };

  const reservationId = crypto.randomBytes(12).toString('hex');
  const paymentUrl = `${cfg.stripeBaseUrl}?client_reference_id=${reservationId}&prefilled_email=${encodeURIComponent(email)}`;
  const submissionTime = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  db.prepare(`
    INSERT INTO ccc_booth_signups
      (reservation_id, booth_type, submission_time, first_name, last_name, email, brand_name, product_category, status, payment_url, invited_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
  `).run(reservationId, booth_type, submissionTime, first_name || '', last_name || '', email, brand_name, product_category || '', paymentUrl, invited_by || '');

  return { ok: true, reservationId, paymentUrl, submissionTime };
}

function setStatus(reservationId, status) {
  const allowed = ['Pending', 'Paid', 'Expired', 'Cancelled'];
  if (!allowed.includes(status)) return { ok: false, error: `status must be one of: ${allowed.join(', ')}` };
  const result = db.prepare(`UPDATE ccc_booth_signups SET status = ? WHERE reservation_id = ?`).run(status, reservationId);
  if (result.changes === 0) return { ok: false, error: 'not_found' };
  return { ok: true };
}

function listAll({ booth_type, status } = {}) {
  expireStale();
  let sql = `SELECT * FROM ccc_booth_signups WHERE 1=1`;
  const params = [];
  if (booth_type) { sql += ` AND booth_type = ?`; params.push(booth_type); }
  if (status)     { sql += ` AND status = ?`;     params.push(status); }
  sql += ` ORDER BY id ASC`;
  return db.prepare(sql).all(...params);
}

module.exports = { CCC_BOOTHS, getAvailability, createSignup, setStatus, listAll };
