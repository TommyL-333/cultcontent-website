/**
 * Creator Carnival — Networking Hub email delivery
 *
 * Sends transactional email via Resend (RESEND_API_KEY). This used to
 * reuse the GHL "conversations/messages/outbound" endpoint (piggybacking
 * on the CRM integration built for the creator-onboard SMS send), but
 * that call requires a `conversationProviderId` GHL never actually had
 * configured — every send silently 400'd and fell back to logging,
 * including in production, since before this file existed. See git log
 * for that history; this is a from-scratch replacement, not a patch.
 *
 * GHL contact upsert is kept as a best-effort side effect (so applicants
 * still land in the CRM), but it's no longer load-bearing for email
 * delivery — a failed/unconfigured GHL upsert no longer blocks a send.
 *
 * Dev/unconfigured fallback: if RESEND_API_KEY is missing, or a send
 * fails, the email body (with the magic link/CTA url) is logged to the
 * console instead of thrown away — lets the whole signup→verify→login
 * flow be tested without live Resend credentials.
 *
 * Sends from mail.cultcontent.cc — a dedicated subdomain (SPF/DKIM
 * verified in Resend, DNS records live in Cloudflare), deliberately kept
 * separate from the bare cultcontent.cc domain so nothing here risks the
 * team's real @cultcontent.cc Google Workspace mail.
 */

const axios   = require('axios');
const net     = require('./ccc-network');
const Resend  = require('resend').Resend;

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.DASHBOARD_URL || 'https://cult-command-center-production.up.railway.app').replace(/\/$/, '');
const GHL_HEADERS = () => ({ Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-04-15', 'Content-Type': 'application/json' });

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'Creator Carnival <noreply@mail.cultcontent.cc>';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Best-effort CRM sync — not part of the send path anymore. A failure
// here is logged and swallowed; it never blocks or falls back the email.
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
    console.error('[ccc-network-mail] GHL contact upsert error (non-blocking):', e.response?.data || e.message);
    return null;
  }
}

async function syncGhlContact(person) {
  if (person.ghl_contact_id) return;
  const contactId = await upsertGhlContact(person);
  if (contactId) net.setGhlContactId(person.id, contactId);
}

async function sendEmail(person, { subject, html, logLabel }) {
  // Fire-and-forget CRM sync — doesn't gate or wait on the actual send.
  syncGhlContact(person).catch(() => {});

  if (!resend) {
    console.log(`[ccc-network-mail] DEV FALLBACK (${logLabel}) — no RESEND_API_KEY, logging instead of sending:\nTo: ${person.email}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ')}\n`);
    return { ok: false, devFallback: true };
  }
  try {
    const { data, error } = await resend.emails.send({ from: FROM_ADDRESS, to: person.email, subject, html });
    if (error) throw error;
    return { ok: true, id: data?.id };
  } catch (e) {
    console.error(`[ccc-network-mail] send error (${logLabel}):`, e);
    console.log(`[ccc-network-mail] DEV FALLBACK (${logLabel}) — send failed, logging instead:\nTo: ${person.email}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ')}\n`);
    return { ok: false, error: e.message || e };
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

// Sent from a webhook (dashboard-server.js POST /api/webhooks/creator-form-submit)
// whenever someone submits the "Apply to be a Carnival Creator" Google Form —
// that form has no backend of its own, so a Google Apps Script trigger on the
// form calls that webhook with whatever email/name they entered. Not tied to
// a ccc_people record at all (they may never have one) — this is a plain,
// direct send, unlike sendEmail() above which is CRM-synced per-person.
async function sendCreatorFormWelcomeEmail(email, name) {
  const url = `${PUBLIC_BASE_URL}/ccc-network`;
  const subject = "You're on the list — join the Creator Carnival Networking Roster";
  const html = `<p>Hey ${name || 'there'},</p><p>Thanks for applying to be a Creator Carnival creator! While that application is being reviewed, get a head start on networking — join the Networking Roster to browse the brands and creators already signed up, before the event:</p><p><a href="${url}">${url}</a></p><p>See you September 12th at National Harbor.</p>`;

  if (!resend) {
    console.log(`[ccc-network-mail] DEV FALLBACK (creator-form-welcome) — no RESEND_API_KEY, logging instead of sending:\nTo: ${email}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ')}\n`);
    return { ok: false, devFallback: true };
  }
  try {
    const { data, error } = await resend.emails.send({ from: FROM_ADDRESS, to: email, subject, html });
    if (error) throw error;
    return { ok: true, id: data?.id };
  } catch (e) {
    console.error('[ccc-network-mail] send error (creator-form-welcome):', e);
    console.log(`[ccc-network-mail] DEV FALLBACK (creator-form-welcome) — send failed, logging instead:\nTo: ${email}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ')}\n`);
    return { ok: false, error: e.message || e };
  }
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
// Resend's `to` is per-send (unlike the old GHL contact-cache approach),
// so this can just send straight to newEmail without any of the
// stale-cached-contact workaround the old implementation needed.
async function sendEmailChangeVerification(person, newEmail, token) {
  const url = `${PUBLIC_BASE_URL}/ccc-network/settings/email/confirm/${token}`;
  return sendEmail({ ...person, email: newEmail }, {
    logLabel: 'email-change',
    subject: 'Confirm your new email — Creator Carnival Networking',
    html: `<p>Hey ${person.first_name},</p><p>Confirm this is your new email for the Creator Carnival Networking Roster — this link expires in 30 minutes:</p><p><a href="${url}">${url}</a></p><p>Didn't request this? You can ignore it.</p>`,
  });
}

module.exports = {
  sendMagicLinkEmail, sendVerifyEmail, sendApprovalEmail,
  sendConnectionRequestEmail, sendConnectionAcceptedEmail, sendNewMessageEmail, sendEmailChangeVerification,
  sendCreatorFormWelcomeEmail,
  magicLinkUrl,
};
