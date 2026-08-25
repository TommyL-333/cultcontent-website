// ─── Creator Lead — public application page ──────────────────────────────────
// Public, no-login application page at portal.cultcontent.cc/apply/creator-lead
// (bio-link friendly). Applicants must submit 2+ TikTok video links to qualify;
// returning applicants (matched by phone, falling back to email) get their new
// video links appended to their existing record instead of creating a duplicate.
//
// Mounted from dashboard-server.js BEFORE app.use(requireAuth) — this page and
// its submit endpoint must stay public (no Cloudflare Access session).
//
// Lark Base: dedicated "Creator Lead Hiring" app (not the shared CRM base — the
// shared base's app credentials only have read access there, not table-create).
const APP_TOKEN             = 'LYAgbIxmTaIFSHsmLVfu8Y1FtV0';
const APPLICATIONS_TABLE_ID = 'tblCDeff8VuNnAyO';
const VIDEOS_TABLE_ID       = 'tbl14H1kRA9ds6ez';
const LARK_BASE_URL         = 'https://open.larksuite.com/open-apis/bitable/v1';

const MAX_TOTAL_VIDEOS = 10; // 2 required + up to 8 additional

function isTikTokUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host.endsWith('tiktok.com')) return false;
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return u.pathname.length > 1;
  if (/\/@[^/]+\/video\/\d+/.test(u.pathname)) return true;
  if (/^\/t\/[\w-]+/.test(u.pathname)) return true;
  return false;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

function normalizeHandle(raw) {
  return String(raw || '').trim().replace(/^@/, '');
}

module.exports = (app, deps = {}) => {
  const { express, getLarkTenantToken } = deps;
  const axios = deps.axios || require('axios');
  const rateLimit = require('express-rate-limit');
  const path = require('path');

  const applyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8, // generous enough for a typo retry, tight enough to block scripted abuse
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many submissions from this network — try again in 15 minutes.' },
  });

  async function larkHeaders() {
    const token = await getLarkTenantToken();
    if (!token) throw new Error('Lark not configured (LARK_APP_ID/LARK_APP_SECRET missing)');
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  // Look up an existing applicant by phone (primary) or email (fallback).
  async function findExistingApplicant(phone, email) {
    const headers = await larkHeaders();
    const conditions = [];
    if (phone) conditions.push({ field_name: 'Phone', operator: 'is', value: [phone] });
    if (email) conditions.push({ field_name: 'Email', operator: 'is', value: [email] });
    if (!conditions.length) return null;
    const { data } = await axios.post(
      `${LARK_BASE_URL}/apps/${APP_TOKEN}/tables/${APPLICATIONS_TABLE_ID}/records/search`,
      { filter: { conjunction: 'or', conditions } },
      { headers }
    );
    const items = data?.data?.items || [];
    return items[0] || null;
  }

  async function createApplicant(fields) {
    const headers = await larkHeaders();
    const { data } = await axios.post(
      `${LARK_BASE_URL}/apps/${APP_TOKEN}/tables/${APPLICATIONS_TABLE_ID}/records`,
      { fields },
      { headers }
    );
    if (data.code !== 0) throw new Error(`Lark create error: ${JSON.stringify(data)}`);
    return data.data.record.record_id;
  }

  async function updateApplicant(recordId, fields) {
    const headers = await larkHeaders();
    const { data } = await axios.put(
      `${LARK_BASE_URL}/apps/${APP_TOKEN}/tables/${APPLICATIONS_TABLE_ID}/records/${recordId}`,
      { fields },
      { headers }
    );
    if (data.code !== 0) throw new Error(`Lark update error: ${JSON.stringify(data)}`);
  }

  async function createVideoRow(applicantRecordId, videoUrl, slot) {
    const headers = await larkHeaders();
    const { data } = await axios.post(
      `${LARK_BASE_URL}/apps/${APP_TOKEN}/tables/${VIDEOS_TABLE_ID}/records`,
      { fields: { 'Video URL': { link: videoUrl, text: videoUrl }, 'Applicant': [applicantRecordId], 'Slot': slot } },
      { headers }
    );
    if (data.code !== 0) throw new Error(`Lark video row error: ${JSON.stringify(data)}`);
  }

  // GET /apply/creator-lead — public application page
  app.get('/apply/creator-lead', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'creator-lead-apply.html'));
  });

  // POST /api/creator-lead/apply — public form submission
  app.post('/api/creator-lead/apply', applyLimiter, express.json(), async (req, res) => {
    try {
      const body = req.body || {};

      // Honeypot — bots tend to fill every field; humans never see this one.
      if (String(body.website || '').trim()) {
        return res.json({ ok: true });
      }

      const name       = String(body.name || '').trim();
      const tiktok      = normalizeHandle(body.tiktokHandle);
      const phone       = normalizePhone(body.phone);
      const email       = String(body.email || '').trim().toLowerCase();
      const motivation  = String(body.motivation || '').trim().slice(0, 2000);
      const consent     = body.consent === true;
      const source      = body.source === 'bio' ? 'bio' : 'direct';
      const rawLinks    = Array.isArray(body.videoLinks) ? body.videoLinks : [];

      if (!name)                          return res.status(400).json({ ok: false, error: 'Name is required.' });
      if (!tiktok)                        return res.status(400).json({ ok: false, error: 'TikTok handle is required.' });
      if (!phone || phone.length < 8)     return res.status(400).json({ ok: false, error: 'A valid phone number is required.' });
      if (!isValidEmail(email))           return res.status(400).json({ ok: false, error: 'A valid email is required.' });
      if (!motivation)                    return res.status(400).json({ ok: false, error: 'Please tell us why you want this role.' });
      if (!consent)                       return res.status(400).json({ ok: false, error: 'Consent to be contacted is required.' });

      // Dedupe + validate video links, cap at MAX_TOTAL_VIDEOS.
      const seen = new Set();
      const validLinks = [];
      for (const raw of rawLinks) {
        const url = String(raw || '').trim();
        if (!url || seen.has(url)) continue;
        if (!isTikTokUrl(url)) return res.status(400).json({ ok: false, error: `Not a valid TikTok video link: ${url}` });
        seen.add(url);
        validLinks.push(url);
        if (validLinks.length >= MAX_TOTAL_VIDEOS) break;
      }
      if (validLinks.length < 2) {
        return res.status(400).json({ ok: false, error: 'At least 2 valid, unique TikTok video links are required.' });
      }

      const existing = await findExistingApplicant(phone, email);

      let applicantId;
      if (existing) {
        applicantId = existing.record_id;
        // Refresh applicant details but never touch Stage — an existing applicant
        // may have already progressed past "Applied" and a resubmission shouldn't regress it.
        await updateApplicant(applicantId, {
          'Name': name,
          'TikTok Handle': tiktok,
          'Phone': phone,
          'Email': email,
          'Motivation': motivation,
        });
      } else {
        applicantId = await createApplicant({
          'Name': name,
          'TikTok Handle': tiktok,
          'Phone': phone,
          'Email': email,
          'Motivation': motivation,
          'Source': source,
          'Consent': true,
          'Consent Timestamp': Date.now(),
          'Stage': 'Applied',
        });
      }

      for (let i = 0; i < validLinks.length; i++) {
        const slot = i === 0 ? 'Required #1' : i === 1 ? 'Required #2' : 'Additional';
        await createVideoRow(applicantId, validLinks[i], slot);
      }

      return res.json({ ok: true, applicantId, returning: !!existing });
    } catch (e) {
      console.error('[creator-lead-apply] error:', e.response?.data || e.message);
      return res.status(500).json({ ok: false, error: 'Something went wrong on our end — please try again shortly.' });
    }
  });
};
