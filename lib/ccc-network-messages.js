/**
 * Creator Carnival — Networking Hub messaging
 *
 * Messages only flow between people with an accepted ccc_connections row —
 * enforced here, not just in the UI. Reuses the shared SQLite connection
 * from lib/ccc-network.js (same file, same tables) rather than opening a
 * second handle. Inbox screen polls GET /api/ccc-network/inbox and the
 * open thread on a short interval — no websocket infra in this app.
 */

const net = require('./ccc-network');
const db = net.db;

function requireAcceptedConnection(personId, otherPersonId) {
  const row = net.getConnectionRow(personId, otherPersonId);
  if (!row || row.status !== 'accepted') return null;
  return row;
}

function sendMessage(fromId, otherPersonUuid, body) {
  const text = (body || '').trim();
  if (!text) return { ok: false, error: 'empty_message' };
  const other = net.getPerson(otherPersonUuid);
  if (!other) return { ok: false, error: 'not_found' };
  const conn = requireAcceptedConnection(fromId, other.id);
  if (!conn) return { ok: false, error: 'not_connected' };

  db.prepare(`INSERT INTO ccc_messages (connection_id, from_person_id, to_person_id, body) VALUES (?, ?, ?, ?)`)
    .run(conn.id, fromId, other.id, text.slice(0, 4000));
  return { ok: true, otherPerson: other };
}

function listThread(personId, otherPersonUuid) {
  const other = net.getPerson(otherPersonUuid);
  if (!other) return { ok: false, error: 'not_found' };
  const conn = requireAcceptedConnection(personId, other.id);
  if (!conn) return { ok: false, error: 'not_connected' };

  const messages = db.prepare(`SELECT id, from_person_id, to_person_id, body, created_at FROM ccc_messages WHERE connection_id = ? ORDER BY id ASC`).all(conn.id);
  db.prepare(`UPDATE ccc_messages SET read_at = datetime('now') WHERE connection_id = ? AND to_person_id = ? AND read_at IS NULL`).run(conn.id, personId);
  return { ok: true, otherPerson: other, messages };
}

// One row per accepted connection, with the last message (if any) and how
// many are unread — powers the Inbox conversation list.
function listInbox(personId) {
  const conns = db.prepare(`SELECT * FROM ccc_connections WHERE status = 'accepted' AND (from_person_id = ? OR to_person_id = ?)`).all(personId, personId);

  return conns.map(c => {
    const otherId = c.from_person_id === personId ? c.to_person_id : c.from_person_id;
    const other = net.getPerson(otherId);
    const last = db.prepare(`SELECT body, created_at, from_person_id FROM ccc_messages WHERE connection_id = ? ORDER BY id DESC LIMIT 1`).get(c.id);
    const { unread } = db.prepare(`SELECT COUNT(*) as unread FROM ccc_messages WHERE connection_id = ? AND to_person_id = ? AND read_at IS NULL`).get(c.id, personId);
    return {
      uuid: other.uuid, first_name: other.first_name, last_name: other.last_name,
      role: other.role, brand_name: other.brand_name, handle: other.handle,
      lastMessage: last ? { body: last.body, created_at: last.created_at, fromMe: last.from_person_id === personId } : null,
      unread,
    };
  }).sort((a, b) => {
    const at = a.lastMessage?.created_at || '';
    const bt = b.lastMessage?.created_at || '';
    return bt.localeCompare(at);
  });
}

function unreadCount(personId) {
  const { total } = db.prepare(`
    SELECT COUNT(*) as total FROM ccc_messages m
    JOIN ccc_connections c ON c.id = m.connection_id
    WHERE m.to_person_id = ? AND m.read_at IS NULL AND c.status = 'accepted'
  `).get(personId);
  return total;
}

module.exports = { sendMessage, listThread, listInbox, unreadCount };
