/**
 * Creator Carnival — Networking Hub email delivery
 *
 * This repo has no dedicated email provider — reuses the GHL integration
 * already wired in for the creator-onboard SMS send (dashboard-server.js,
 * POST /api/creator-onboard): upsert a GHL contact, then hit the same
 * outbound-messages endpoint with type:'Email' instead of type:'SMS'.
 *
 * Dev/unconfigured fallback: if GHL_API_KEY is missing, or a send fails, the
 * email body (with the magic link/CTA url) is logged to the console instead
 * of thrown away — lets the whole signup→approve→login flow be tested
 * without live GHL credentials.
 */

const axios = require('axios');
const net   = require('./ccc-network');

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.DASHBOARD_URL || 'https://cult-command-center-production.up.railway.app').replace(/\/$/, '');
const GHL_HEADERS = () => ({ Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-04-15', 'Content-Type': 'application/json' });

async function upsertGhlContact(person) {
  if (!process.env.GHL_API_KEY) return null;
  try {
    const payload = {
      firstName: person.first_name, lastName: person.last_name || '',
      email: person.email, phone: person.phone || undefined,
      tags: ['ccc-network', `ccc-network-${person.role}`],
      locationId: process.env.GHL_LOC_ID,
    };
    const { data } = await axios.post('https://services.leadconnectorhq.com/contacts/', payload, { headers: GHL_HEADERS() });
    return data?.contact?.id || null;
  } catch (e) {
    console.error('[ccc-network-mail] GHL contact upsert error:', e.response?.data || e.message);
    return null;
  }
}

async function ensureGhlContact(person) {
  if (person.ghl_contact_id) return person.ghl_contact_id;
  const contactId = await upsertGhlContact(person);
  if (contactId) net.setGhlContactId(person.id, contactId);
  return contactId;
}

async function sendEmail(person, { subject, html, logLabel }) {
  const contactId = await ensureGhlContact(person);
  if (!contactId) {
    console.log(`[ccc-network-mail] DEV FALLBACK (${logLabel}) — no GHL contact, logging instead of sending:\nTo: ${person.email}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ')}\n`);
    return { ok: false, devFallback: true };
  }
  try {
    await axios.post('https://services.leadconnectorhq.com/conversations/messages/outbound', {
      type: 'Email', contactId, subject, html,
    }, { headers: GHL_HEADERS() });
    return { ok: true };
  } catch (e) {
    console.error(`[ccc-network-mail] send error (${logLabel}):`, e.response?.data || e.message);
    console.log(`[ccc-network-mail] DEV FALLBACK (${logLabel}) — send failed, logging instead:\nTo: ${person.email}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ')}\n`);
    return { ok: false, error: e.response?.data || e.message };
  }
}

function magicLinkUrl(token) {
  return `${PUBLIC_BASE_URL}/ccc-network/auth/${token}`;
}

async function sendMagicLinkEmail(person, token) {
  const url = magicLinkUrl(token);
  return sendEmail(person, {
    logLabel: 'magic-link',
    subject: 'Your Creator Carnival Networking login link',
    html: `<p>Hey ${person.first_name},</p><p>Here's your login link for the Creator Carnival Networking Roster — it expires in 30 minutes and can only be used once:</p><p><a href="${url}">${url}</a></p><p>Didn't request this? You can ignore it.</p>`,
  });
}

// Sent right at signup — self-serve activation, no admin approval wait.
// Clicking it proves the email is real and logs them straight in.
async function sendVerifyEmail(person, token) {
  const url = magicLinkUrl(token);
  return sendEmail(person, {
    logLabel: 'verify',
    subject: 'Confirm your email — Creator Carnival Networking Roster',
    html: `<p>Hey ${person.first_name},</p><p>One click to activate your Creator Carnival Networking Roster account — no approval wait, you're in as soon as you confirm it's really you:</p><p><a href="${url}">${url}</a></p><p>This link expires in 30 minutes and can only be used once. Didn't sign up for this? You can ignore it.</p>`,
  });
}

async function sendApprovalEmail(person, token) {
  const url = magicLinkUrl(token);
  return sendEmail(person, {
    logLabel: 'approval',
    subject: "You're in — Creator Carnival Networking Roster",
    html: `<p>Hey ${person.first_name},</p><p>You're approved for the Creator Carnival Networking Roster. Click below to log in and finish your profile:</p><p><a href="${url}">${url}</a></p><p>See you September 12th at National Harbor.</p>`,
  });
}

function directoryUrl() {
  return `${PUBLIC_BASE_URL}/ccc-network/connections`;
}

async function sendConnectionRequestEmail(person, requester) {
  if (!person.notify_request) return { ok: true, skipped: 'opted_out' };
  const requesterName = `${requester.first_name} ${requester.last_name || ''}`.trim();
  const requesterOrg  = requester.role === 'brand' ? requester.brand_name : requester.handle;
  return sendEmail(person, {
    logLabel: 'connection-request',
    subject: `${requesterName} wants to connect on Creator Carnival`,
    html: `<p>Hey ${person.first_name},</p><p><strong>${requesterName}</strong>${requesterOrg ? ` (${requesterOrg})` : ''} sent you a connection request on the Creator Carnival Networking Roster.</p><p><a href="${directoryUrl()}">Review it in your Connections tab</a> — accepting shares contact info both ways and opens messaging.</p>`,
  });
}

async function sendConnectionAcceptedEmail(person, accepter) {
  if (!person.notify_approval) return { ok: true, skipped: 'opted_out' };
  const accepterName = `${accepter.first_name} ${accepter.last_name || ''}`.trim();
  const accepterOrg  = accepter.role === 'brand' ? accepter.brand_name : accepter.handle;
  return sendEmail(person, {
    logLabel: 'connection-accepted',
    subject: `${accepterName} accepted your connection request`,
    html: `<p>Hey ${person.first_name},</p><p><strong>${accepterName}</strong>${accepterOrg ? ` (${accepterOrg})` : ''} accepted your connection request. You can now see their contact info and message them:</p><ul><li>Email: ${accepter.email}</li>${accepter.phone ? `<li>Phone: ${accepter.phone}</li>` : ''}</ul><p><a href="${directoryUrl()}">View in your Connections tab</a>.</p>`,
  });
}

async function sendNewMessageEmail(person, sender) {
  if (!person.notify_message) return { ok: true, skipped: 'opted_out' };
  const senderName = `${sender.first_name} ${sender.last_name || ''}`.trim();
  return sendEmail(person, {
    logLabel: 'new-message',
    subject: `New message from ${senderName} on Creator Carnival`,
    html: `<p>Hey ${person.first_name},</p><p><strong>${senderName}</strong> sent you a message on the Creator Carnival Networking Roster.</p><p><a href="${PUBLIC_BASE_URL}/ccc-network/inbox">Read it in your Inbox</a>.</p>`,
  });
}

// Email-change verification always sends — it goes to the *new* address,
// which has no notify_* row to check yet (that's the whole point of it).
//
// GHL's outbound-message call has no per-send "to" field — it delivers to
// whatever email is on file for the cached contactId. Reusing `person`'s
// already-cached ghl_contact_id here would silently deliver to their OLD
// address instead, defeating the point of verification. So this does a
// one-off contact upsert against the *new* email and sends through that,
// without touching the real, cached ghl_contact_id on the person record.
async function sendEmailChangeVerification(person, newEmail, token) {
  const url = `${PUBLIC_BASE_URL}/ccc-network/settings/email/confirm/${token}`;
  const subject = 'Confirm your new email — Creator Carnival Networking';
  const html = `<p>Hey ${person.first_name},</p><p>Confirm this is your new email for the Creator Carnival Networking Roster — this link expires in 30 minutes:</p><p><a href="${url}">${url}</a></p><p>Didn't request this? You can ignore it.</p>`;

  const freshContactId = await upsertGhlContact({ ...person, email: newEmail });
  if (!freshContactId) {
    console.log(`[ccc-network-mail] DEV FALLBACK (email-change) — no GHL contact, logging instead of sending:\nTo: ${newEmail}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ')}\n`);
    return { ok: false, devFallback: true };
  }
  try {
    await axios.post('https://services.leadconnectorhq.com/conversations/messages/outbound', {
      type: 'Email', contactId: freshContactId, subject, html,
    }, { headers: GHL_HEADERS() });
    return { ok: true };
  } catch (e) {
    console.error('[ccc-network-mail] send error (email-change):', e.response?.data || e.message);
    console.log(`[ccc-network-mail] DEV FALLBACK (email-change) — send failed, logging instead:\nTo: ${newEmail}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ')}\n`);
    return { ok: false, error: e.response?.data || e.message };
  }
}

module.exports = {
  sendMagicLinkEmail, sendVerifyEmail, sendApprovalEmail,
  sendConnectionRequestEmail, sendConnectionAcceptedEmail, sendNewMessageEmail, sendEmailChangeVerification,
  magicLinkUrl,
};
