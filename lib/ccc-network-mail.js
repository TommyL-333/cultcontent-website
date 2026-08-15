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

async function sendApprovalEmail(person, token) {
  const url = magicLinkUrl(token);
  return sendEmail(person, {
    logLabel: 'approval',
    subject: "You're in — Creator Carnival Networking Roster",
    html: `<p>Hey ${person.first_name},</p><p>You're approved for the Creator Carnival Networking Roster. Click below to log in and finish your profile:</p><p><a href="${url}">${url}</a></p><p>See you September 12th at National Harbor.</p>`,
  });
}

async function sendConnectionNotification(person, requester) {
  const requesterName = `${requester.first_name} ${requester.last_name || ''}`.trim();
  const requesterOrg  = requester.role === 'brand' ? requester.brand_name : requester.handle;
  return sendEmail(person, {
    logLabel: 'connection',
    subject: `${requesterName} wants to connect on Creator Carnival`,
    html: `<p>Hey ${person.first_name},</p><p><strong>${requesterName}</strong>${requesterOrg ? ` (${requesterOrg})` : ''} just connected with you on the Creator Carnival Networking Roster. Their contact info:</p><ul><li>Email: ${requester.email}</li>${requester.phone ? `<li>Phone: ${requester.phone}</li>` : ''}</ul><p>Log in to the roster to see their full profile and reach out.</p>`,
  });
}

module.exports = { sendMagicLinkEmail, sendApprovalEmail, sendConnectionNotification, magicLinkUrl };
