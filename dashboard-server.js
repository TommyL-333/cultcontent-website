/**
 * Cult Content — Command Center Dashboard Server
 * Serves the dashboard UI and proxies API calls to GHL, Railway, and stubs.
 */

require('dotenv').config({ override: true });
const express      = require('express');
const axios        = require('axios');
const path         = require('path');
const fs           = require('fs');
const multer       = require('multer');
const crypto       = require('crypto');
const Anthropic    = require('@anthropic-ai/sdk');
const bcrypt       = require('bcryptjs');
const session      = require('express-session');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const ffmpeg       = require('fluent-ffmpeg');
const ffmpegPath   = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
const cccBooths     = require('./lib/ccc-booths');
const cccNet        = require('./lib/ccc-network');
const cccNetMail    = require('./lib/ccc-network-mail');
const cccNetMsg     = require('./lib/ccc-network-messages');
const CCC_NETWORK_APP_DIST = path.join(__dirname, 'ccc-network-app', 'dist');

// ─── Stripe (client billing) ──────────────────────────────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// ─── Data directory — use Railway Volume in prod, __dirname locally ───────────
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SNAP_FILE          = path.join(DATA_DIR, 'snapshots.json');
const QUEUE_FILE         = path.join(DATA_DIR, 'upload-queue.json');
const AGENTS_FILE        = path.join(DATA_DIR, 'agents.json');
const TIKTOK_TOKENS_FILE = path.join(DATA_DIR, '.tiktok-tokens.json');
const TASKS_FILE         = path.join(DATA_DIR, 'tasks.json');
const REPORT_QUEUE_FILE  = path.join(DATA_DIR, 'weekly-report-queue.json');
const UPLOAD_DIR         = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Public-facing Railway URL — returned in upload responses so Buffer (and browsers) can fetch files
// without hitting Cloudflare's 100 MB limit.  Override via PUBLIC_BASE_URL env var.
const PUBLIC_BASE_URL   = (process.env.PUBLIC_BASE_URL || process.env.DASHBOARD_URL || 'https://cult-command-center-production.up.railway.app').replace(/\/$/, '');
// Creator-facing pages live on portal.cultcontent.cc (publicly accessible, no CF Access)
const CREATOR_BASE_URL  = (process.env.CREATOR_BASE_URL || 'https://portal.cultcontent.cc').replace(/\/$/, '');

const app = express();

// ─── Security: HTTPS redirect in production ───────────────────────────────────
app.set('trust proxy', 1); // trust Cloudflare / Railway proxy
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// ─── Security: HTTP headers via Helmet ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // dashboard uses inline scripts — disable CSP for now
  crossOriginEmbedderPolicy: false,
}));

// ─── Security: Rate limiting ──────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 120,                  // 120 requests/min per IP (generous for a dashboard)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down.' },
});
app.use('/api/', apiLimiter);

// ─── Session middleware — powers client portal (session-based auth, separate from CF Access) ──
app.use(session({
  secret: process.env.CLIENT_SESSION_SECRET || 'cc-client-portal-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ─── Security: Cloudflare Access authentication ─────────────────────��������─────────
// Cloudflare Access injects CF-Access-Authenticated-User-Email on every request.
// If CF_ACCESS_AUD is set, we enforce this header — unauthenticated requests get 401.
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'cultcontent.cc')
  .split(',').map(d => d.trim().toLowerCase());

function requireAuth(req, res, next) {
  // Skip auth in local dev (no CF_ACCESS_AUD configured)
  if (!process.env.CF_ACCESS_AUD) return next();
  if (req.path.startsWith('/api/')) console.log(`[auth] ${req.method} ${req.path} email=${req.headers['cf-access-authenticated-user-email']||'(none)'}`);

  const email = req.headers['cf-access-authenticated-user-email'];
  if (!email) {
    console.log(`[auth] BLOCKED ${req.method} ${req.path} — no CF Access header`);
    if (req.path.startsWith('/api/')) {
      // Plain text so both old and new JS parse attempts fail and surface the error
      return res.status(401).type('text').send('Session expired — please refresh the page');
    }
    return res.status(401).sendFile(path.join(__dirname, 'dashboard', '401.html'));
  }

  const domain = email.split('@')[1]?.toLowerCase();
  if (!ALLOWED_DOMAINS.includes(domain)) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ ok: false, error: `Access denied for ${email}` });
    }
    return res.status(403).send(`Access denied. ${email} is not authorized.`);
  }

  // Attach user email to request for downstream use
  req.userEmail = email;
  next();
}

// ─── Lark API helpers ─────────────────────────────────────────────────────────
let _larkTenantToken = null;
let _larkTokenExpiry = 0;
const LARK_USER_TOKEN_FILE = path.join(DATA_DIR, 'lark-user-token.json');

async function getLarkTenantToken() {
  if (_larkTenantToken && Date.now() < _larkTokenExpiry - 60000) return _larkTenantToken;
  const appId     = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) return null;
  const r = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: appSecret });
  _larkTenantToken = r.data.tenant_access_token;
  _larkTokenExpiry = Date.now() + (r.data.expire * 1000);
  return _larkTenantToken;
}

// Append a creator signup row to the master Lark Bitable (non-blocking, env-gated).
async function writeCreatorSignupToBitable(row) {
  try {
    const APP_TOKEN = process.env.CREATOR_SIGNUP_BITABLE_APP_TOKEN;
    const TABLE_ID  = process.env.CREATOR_SIGNUP_BITABLE_TABLE_ID;
    if (!APP_TOKEN || !TABLE_ID) return;
    const ltoken = await getLarkTenantToken();
    if (!ltoken) return;
    const fields = {
      'Brand':          row.brand || '',
      'Creator Name':   row.creatorName || '',
      'TikTok Handle':  row.handle || '',
      'Email':          row.email || '',
      'Phone':          row.phone || '',
      'Discord':        row.discord || '',
      'Follower Range': row.followerRange || '',
      'GMV':            row.gmv || '',
      'Niche':          row.niche || '',
      'Message':        row.message || '',
      'Source Form':    row.source || '',
      'Submitted':      Date.now()
    };
    await axios.post(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`,
      { fields },
      { headers: { Authorization: `Bearer ${ltoken}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('[signup-bitable] write error:', e.response?.data || e.message);
  }
}

// Get stored user access token, refreshing if needed
async function getLarkUserToken() {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(LARK_USER_TOKEN_FILE, 'utf8')); } catch(_) {}
  if (!stored.access_token) return null;

  // Still valid
  if (stored.expires_at && Date.now() < stored.expires_at - 60000) return stored.access_token;

  // Try refresh
  if (stored.refresh_token) {
    try {
      const appTokenResp = await axios.post('https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal', {
        app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET,
      });
      const appToken = appTokenResp.data?.app_access_token;
      const r = await axios.post(
        'https://open.larksuite.com/open-apis/authen/v1/oidc/refresh_access_token',
        { grant_type: 'refresh_token', refresh_token: stored.refresh_token },
        { headers: { Authorization: `Bearer ${appToken}` } }
      );
      if (r.data?.code === 0) {
        const d = r.data.data;
        const newStored = {
          access_token:  d.access_token,
          refresh_token: d.refresh_token,
          expires_at:    Date.now() + (d.expires_in * 1000),
        };
        fs.writeFileSync(LARK_USER_TOKEN_FILE, JSON.stringify(newStored));
        return d.access_token;
      }
    } catch(e) { console.error('[lark-oauth] refresh error:', e.message); }
  }
  return null;
}

async function larkApi(method, path, data) {
  const token = await getLarkTenantToken();
  if (!token) throw new Error('LARK_APP_ID / LARK_APP_SECRET not configured');
  const r = await axios({ method, url: `https://open.larksuite.com/open-apis${path}`, headers: { Authorization: `Bearer ${token}` }, data });
  return r.data;
}

async function larkUserApi(method, path, data) {
  const token = await getLarkUserToken();
  if (!token) throw new Error('Lark user not connected — visit /api/lark/oauth/start');
  const r = await axios({ method, url: `https://open.larksuite.com/open-apis${path}`, headers: { Authorization: `Bearer ${token}` }, data });
  return r.data;
}

// Fetch Lark Minutes transcript for a given minute_token
async function fetchLarkMinutesTranscript(minuteToken) {
  try {
    // Minutes are user-owned — must use user access token
    const userToken = await getLarkUserToken();
    const token = userToken || await getLarkTenantToken();
    const url = `https://open.larksuite.com/open-apis/minutes/v1/minutes/${minuteToken}/transcript`;
    console.log(`[lark minutes] fetching transcript (${userToken ? 'user' : 'tenant'} token): ${url}`);
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    // Lark returns the transcript as a plain text string
    if (typeof r.data === 'string' && r.data.length > 10) return r.data;
    if (r.data?.code !== undefined && r.data?.code !== 0) return null;
    const contents = r.data?.data?.transcript?.contents || r.data?.transcript?.contents || [];
    return contents.length ? contents.map(c => c.content).join('\n') : null;
  } catch(e) {
    console.error('[lark minutes] transcript error:', e.message, e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : '');
    return null;
  }
}

// Fetch Lark Minutes metadata
async function fetchLarkMinutesMeta(minuteToken) {
  try {
    const userToken = await getLarkUserToken();
    const token = userToken || await getLarkTenantToken();
    const url = `https://open.larksuite.com/open-apis/minutes/v1/minutes/${minuteToken}`;
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    console.log(`[lark minutes] meta response code=${r.data?.code} msg=${r.data?.msg}`);
    if (r.data?.code !== undefined && r.data?.code !== 0) return null;
    return r.data?.data?.minute || r.data?.minute || null;
  } catch(e) {
    console.error('[lark minutes] meta error:', e.message, e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : '');
    return null;
  }
}

// Capture raw body for HMAC verification on webhook routes, parse JSON for everything else
app.use((req, res, next) => {
  if (req.path === '/api/webhooks/lark-meeting' || req.path === '/api/webhooks/fireflies-meeting') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      req.rawBody = raw;
      try { req.body = JSON.parse(raw); } catch(_) { req.body = {}; }
      next();
    });
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

// ─── Creator Carnival application form → networking-roster welcome email ──────
// The "Apply to be a Carnival Creator" page (ccc-creator-apply.html) is a bare
// embedded Google Form with no backend of its own — Google owns the response
// data entirely. This endpoint is called by a Google Apps Script trigger
// attached to that form (installed manually in Google's UI, not from this
// repo), firing on every submission with whatever email/name the applicant
// entered, and sends them a welcome email pointing at the Networking Roster
// signup. Registered BEFORE requireAuth — Google's script has no Cloudflare
// Access session, same reasoning as the GHL webhook below. Verified by the
// same WEBHOOK_SECRET query param convention as every other webhook here.
app.post('/api/webhooks/creator-form-submit', async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name  = String(req.body?.name || '').trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'A valid email is required.' });
  }
  cccNetMail.sendCreatorFormWelcomeEmail(email, name)
    .then((result) => res.json({ ok: true, sent: result.ok }))
    .catch((e) => {
      console.error('[creator-form-webhook] error:', e.message);
      res.status(500).json({ ok: false, error: 'Failed to send welcome email.' });
    });
});

// ─── GHL Webhook: client onboarding form → auto-add client ───────────────────
// This route is intentionally registered BEFORE requireAuth so GHL can call it
// without a Cloudflare Access session. Verified by WEBHOOK_SECRET query param.
app.post('/api/webhooks/ghl-client-onboard', async (req, res) => {
  // Verify shared secret
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body;

    // GHL sends field values using either the field label or a custom key — normalise both
    function field(key, ...aliases) {
      const keys = [key, ...aliases];
      for (const k of keys) {
        if (body[k] !== undefined && body[k] !== '') return body[k];
      }
      return null;
    }

    // ── Extract form fields ──────────────────────────────────────────────────
    const brandName    = field('Brand Name', 'brand_name', 'brandName') || 'New Client';
    const firstName    = field('First Name', 'first_name', 'firstName') || '';
    const lastName     = field('Last Name',  'last_name',  'lastName')  || '';
    const email        = field('Email', 'email')       || '';
    const phone        = field('Phone', 'phone')       || '';
    const website      = field('Website', 'website')   || '';
    const tiktokShop   = field('TikTok Shop Registered', 'tiktok_shop', 'tiktokShopRegistered') || '';
    const shopify      = field('Shopify Integrated', 'shopify', 'shopifyIntegrated') || '';
    const sellico      = field('Sellico', 'sellico') || '';
    const tiktokAM     = field('TikTok Account Manager', 'tiktok_am', 'tiktokAM') || '';
    const reviewsIo    = field('Reviews.io', 'reviews_io', 'reviewsIo') || '';
    const fbt          = field('FBT', 'fbt') || '';
    const brandContent = field('Brand Content', 'brand_content', 'brandContent') || '';
    const joinBrands   = field('JoinBrands Budget', 'joinbrands_budget', 'joinBrandsBudget') || '';

    // ── Create brand entry ───────────────────────────────────────────────────
    const brandsData = loadBrands();
    const brandId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const newBrand = {
      id:          brandId,
      createdAt:   new Date().toISOString(),
      name:        brandName,
      contactName: `${firstName} ${lastName}`.trim(),
      email,
      loginEmail:  email,
      phone,
      website,
      industry:    '',
      products:    '',
      audience:    '',
      voice:       '',
      contentPillars: '',
      tiktokHandle: '',
      cta:         '',
      source:      'ghl-onboarding-form',
    };
    brandsData.clients.push(newBrand);
    saveBrands(brandsData);

    // ── Pre-check Growth Partners tasks based on form answers ────────────────
    // Map "yes" / "Yes" / checkbox truthy values
    const isYes = (v) => v && /^(yes|true|1|on|checked)$/i.test(String(v).trim());

    const gpData = loadGP();
    if (!gpData.partners) gpData.partners = {};
    const tasks = {};

    // onboarding
    tasks['contract_signed']    = false;
    tasks['brand_brief_filled'] = false;
    tasks['brand_approved']     = false;
    tasks['onboarding_call']    = false;

    // unit economics
    tasks['cogs_provided']      = false;
    tasks['margins_confirmed']  = false;
    tasks['commission_set']     = false;

    // shop ops
    tasks['shop_account']       = isYes(tiktokShop);
    tasks['shopify']            = isYes(shopify);
    tasks['sellico']            = isYes(sellico);
    tasks['whitelisting_eligible'] = isYes(tiktokAM);
    tasks['reviews']            = isYes(reviewsIo);
    tasks['fbt']                = isYes(fbt);
    tasks['product_samples']    = false;
    tasks['bundles_enabled']    = false;

    // affiliate
    tasks['ugc_source']         = isYes(joinBrands);
    tasks['creator_list']       = false;
    tasks['outreach_started']   = false;
    tasks['gmv_10k']            = false;
    tasks['gmv_50k']            = false;

    // video
    tasks['video_plan']         = isYes(brandContent);
    tasks['first_batch_live']   = false;
    tasks['10_videos_live']     = false;
    tasks['top_performer_id']   = false;

    // paid media
    tasks['spark_ads_enabled']  = false;
    tasks['first_campaign']     = false;
    tasks['roas_positive']      = false;

    // live
    tasks['live_eligible']      = false;
    tasks['first_live']         = false;
    tasks['live_regular']       = false;

    gpData.partners[brandId] = { tasks, updatedAt: new Date().toISOString() };
    saveGP(gpData);

    console.log(`[webhook] New client onboarded from GHL form: ${brandName} (${brandId})`);

    // ── Optionally trigger Shopify brand import ──────────────────────────────
    // (non-blocking — we respond success first, then attempt the import)
    if (website && isYes(shopify)) {
      const shopDomain = website.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      setImmediate(async () => {
        try {
          await axios.post(`http://localhost:${CFG.port}/api/brands/shopify-import`, {
            shopDomain,
            brandId,
          });
        } catch (e) {
          console.warn('[webhook] Shopify import skipped:', e.message);
        }
      });
    }

    res.json({ ok: true, brandId, brandName });
  } catch (err) {
    console.error('[webhook] ghl-client-onboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GHL → Instantly lead relay ──────────────────────────────────────────────
// GHL webhook action calls this endpoint; we extract the contact fields and
// forward them to Instantly in the correct format. Verified by WEBHOOK_SECRET.
app.post('/api/webhooks/ghl-to-instantly', async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
  if (!INSTANTLY_API_KEY) {
    return res.status(500).json({ error: 'INSTANTLY_API_KEY not configured' });
  }

  try {
    const b = req.body;
    // GHL sends fields under various casings depending on workflow config
    const custom = b.customData || {};
    const get = (...keys) => { for (const k of keys) { if (b[k]) return b[k]; if (custom[k]) return custom[k]; } return ''; };

    const payload = {
      campaign:    get('campaign_id'),   // Instantly v2 uses "campaign" not "campaign_id"
      email:       get('email'),
      first_name:  get('first_name', 'firstName'),
      last_name:   get('last_name',  'lastName'),
      company_name: get('company_name', 'companyName'),
      custom_variables: {
        tiktok_handle: get('tiktok_handle') || undefined,
        location:      custom.location || b.city || undefined,
      }
    };

    if (!payload.campaign || !payload.email) {
      return res.status(400).json({ error: 'Missing campaign_id or email', received: b });
    }

    const resp = await axios.post('https://api.instantly.ai/api/v2/leads', payload, {
      headers: {
        'Authorization': `Bearer ${INSTANTLY_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[instantly-relay] Added lead ${payload.email} to campaign ${payload.campaign} | lead_id: ${resp.data.id}`);
    res.json({ ok: true, lead_id: resp.data.id });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[instantly-relay] error:', detail);
    res.status(500).json({ error: detail });
  }
});

// Public routes — registered BEFORE requireAuth so no login needed
app.use('/uploads', express.static(UPLOAD_DIR));

// portal.cultcontent.cc root — audience selector homepage
app.get('/', (req, res, next) => {
  const host = req.hostname || '';
  if (!host.includes('portal.cultcontent.cc')) return next();
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cult Content Portal</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#12101a;--card:#1c1828;--border:#2a2540;
    --text:#e2e8f0;--muted:#64748b;
    --teal:#00f2ea;--pink:#ff0050;--red:#ff3b30;
  }
  body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;min-height:100vh;display:flex;flex-direction:column}

  /* ── Header — matches portal exactly ── */
  header{
    display:flex;align-items:center;justify-content:space-between;
    padding:14px 28px;background:var(--card);border-bottom:1px solid var(--border);
    position:sticky;top:0;z-index:10;
  }
  .logo{height:30px}

  /* ── Hero ── */
  .hero{
    flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
    text-align:center;padding:80px 24px 100px;position:relative;overflow:hidden;
  }
  .hero-eyebrow{
    font-size:0.72rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase;
    color:var(--muted);margin-bottom:20px;
  }
  .hero-title{
    font-size:clamp(2rem,5.5vw,3.2rem);font-weight:800;line-height:1.1;
    color:var(--text);margin-bottom:14px;
  }
  .hero-title span{
    background:linear-gradient(90deg,var(--teal),var(--pink));
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  }
  .hero-sub{font-size:1rem;color:var(--muted);max-width:400px;line-height:1.65;margin-bottom:52px}

  /* ── Cards ── */
  .cards{display:flex;gap:20px;justify-content:center;flex-wrap:wrap;width:100%;max-width:560px}
  .card{
    flex:1;min-width:200px;max-width:240px;
    background:var(--card);border:1.5px solid var(--border);border-radius:16px;
    padding:36px 24px 30px;text-align:center;text-decoration:none;color:inherit;
    transition:transform .2s,border-color .2s,box-shadow .2s;
    display:flex;flex-direction:column;align-items:center;gap:10px;
  }
  .card:hover{
    transform:translateY(-4px);border-color:var(--teal);
    box-shadow:0 0 32px rgba(0,242,234,0.1);
  }
  .card-icon{font-size:2.6rem;line-height:1}
  .card-label{font-size:1rem;font-weight:700;color:var(--text)}
  .card-desc{font-size:0.8rem;color:var(--muted);line-height:1.5}
  .card-arrow{
    margin-top:6px;font-size:0.85rem;font-weight:700;
    background:linear-gradient(90deg,var(--teal),var(--pink));
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  }

  /* ── Orbs ── */
  .orb{position:absolute;border-radius:50%;pointer-events:none;opacity:.12}
  .orb-1{width:400px;height:400px;top:-140px;right:-100px;background:radial-gradient(circle at 35% 35%,var(--teal),transparent 70%)}
  .orb-2{width:300px;height:300px;bottom:-100px;left:-80px;background:radial-gradient(circle at 60% 40%,var(--pink),transparent 70%)}

  /* ── Footer ── */
  footer{text-align:center;padding:20px;font-size:0.75rem;color:var(--muted);border-top:1px solid var(--border)}
  footer a{color:var(--muted);text-decoration:none}
  footer a:hover{color:var(--teal)}
</style>
</head>
<body>

<header>
  <img class="logo" src="https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png" alt="Cult Content">
</header>

<div class="hero">
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>

  <div class="hero-eyebrow">Welcome to the Portal</div>
  <h1 class="hero-title">Who are <span>you</span>?</h1>
  <p class="hero-sub">Select your role and we'll take you to the right place.</p>

  <div class="cards">
    <a class="card" href="/inner-circle">
      <div class="card-icon">⭐️</div>
      <div class="card-label">I'm a Creator</div>
      <div class="card-desc">Find brands to collaborate with and earn commissions</div>
      <div class="card-arrow">Go to Inner Circle →</div>
    </a>
    <a class="card" href="/client/login">
      <div class="card-icon">👁️</div>
      <div class="card-label">I'm a Client</div>
      <div class="card-desc">Log in to your brand dashboard and manage your shop</div>
      <div class="card-arrow">Go to dashboard →</div>
    </a>
  </div>
</div>

<footer>© ${new Date().getFullYear()} Cult Content · <a href="https://cultcontent.cc">cultcontent.cc</a></footer>

</body>
</html>`);
});

// Public marketing homepage — must be before the dashboard static middleware so
// dashboard/index.html doesn't win for GET / on cultcontent.cc.
app.get('/', (req, res, next) => {
  if ((req.hostname || '').includes('portal.cultcontent.cc')) return next();
  res.sendFile(path.join(__dirname, 'home.html'));
});
app.get('/home', (req, res, next) => {
  if ((req.hostname || '').includes('portal.cultcontent.cc')) return next();
  res.sendFile(path.join(__dirname, 'home.html'));
});

// Serve dashboard static assets (CSS/JS) before auth wall so portal.cultcontent.cc can load them
app.use(express.static(path.join(__dirname, 'dashboard')));

// Public proposals — shareable HTML files, no auth required
const PROPOSALS_DIR = path.join(__dirname, 'proposals');
app.get('/proposals/:slug', (req, res) => {
  const filePath = path.join(PROPOSALS_DIR, req.params.slug + '.html');
  console.log(`[proposals] GET /proposals/${req.params.slug} → ${filePath}`);
  if (!fs.existsSync(filePath)) {
    console.log(`[proposals] NOT FOUND: ${filePath}`);
    return res.status(404).send('Proposal not found');
  }
  res.setHeader('Content-Type', 'text/html');
  res.sendFile(filePath);
});

// Catch missing /uploads/* files BEFORE the auth wall — prevents the 401 "sign in" page
// showing for files that no longer exist on the volume (e.g. after a Railway redeploy).
app.get('/uploads/*', (req, res) => {
  res.status(404).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Link Expired</title>
<style>body{background:#050e0f;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;max-width:420px;padding:40px 32px}.icon{font-size:2.5rem;margin-bottom:16px}
h1{font-size:1.3rem;font-weight:700;margin-bottom:10px}.sub{font-size:.85rem;color:#64748b;line-height:1.6}
a{color:#20d5c4;text-decoration:none}</style></head>
<body><div class="box"><div class="icon">🔗</div>
<h1>This link has expired</h1>
<p class="sub">The file you're looking for is no longer available — it may have been removed after a server update.<br><br>
Ask the sender to re-export and share a fresh link.</p></div></body></html>`);
});

// GET /onboard — public client onboarding form
// manifest.cultcontent.cc is behind CF Access — redirect to portal.cultcontent.cc
// which is publicly accessible (no login wall).
app.get('/onboard', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (host.includes('manifest.cultcontent.cc')) {
    return res.redirect(301, 'https://portal.cultcontent.cc/onboard');
  }
  res.sendFile(path.join(__dirname, 'dashboard', 'onboard.html'));
});

// POST /api/onboard/logo ��� public upload during onboarding (no auth, registered before requireAuth)
// Uses lazy multer so imageUpload const doesn't need to exist yet.
app.post('/api/onboard/logo', (req, res, next) => {
  const multer = require('multer');
  const m = multer({
    storage: multer.diskStorage({
      destination: (_, __, cb) => cb(null, UPLOAD_DIR),
      filename:    (_, file, cb) => {
        const ext  = require('path').extname(file.originalname) || '.jpg';
        const base = require('path').basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
        cb(null, `${Date.now()}_${base}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_, file, cb) => cb(null, /image\//i.test(file.mimetype) || /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(file.originalname)),
  }).single('logo');
  m(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, logoUrl: `${PUBLIC_BASE_URL}/uploads/${req.file.filename}` });
  });
});

// POST /api/onboard/submit — public, responds immediately then runs pipeline async
app.post('/api/onboard/submit', express.json({ limit: '2mb' }), async (req, res) => {
  const { brandName, email } = req.body || {};
  if (!brandName || !email) return res.status(400).json({ ok: false, error: 'Brand name and email required' });
  res.json({ ok: true, message: `Welcome to the cult, ${brandName}! Our team will be in touch within 24 hours.` });
  runOnboardingPipeline(req.body).catch(e => console.error('[onboard] pipeline error:', e.message));
});

// ─── Favicon — proxy from CDN so browsers always load it correctly ────────────
app.get('/favicon.png', async (req, res) => {
  try {
    const r = await axios.get(
      'https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png',
      { responseType: 'arraybuffer', timeout: 8000 }
    );
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch(e) {
    res.status(404).end();
  }
});

// ─── Legal pages (required for TikTok Login Kit approval) ────────────────────
app.get('/terms', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terms of Service — Cult Content</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e2e8f0;line-height:1.7;padding:0}
.wrap{max-width:760px;margin:0 auto;padding:60px 24px 100px}
.logo{display:flex;align-items:center;gap:12px;text-decoration:none;margin-bottom:48px;width:fit-content}
.logo-icon{width:48px;height:48px;border-radius:10px;object-fit:cover;flex-shrink:0}
.logo-text{font-size:1rem;font-weight:800;color:#00f2ea;letter-spacing:-.01em}
h1{font-size:2rem;font-weight:900;margin-bottom:8px;letter-spacing:-.02em}
.updated{font-size:.82rem;color:#64748b;margin-bottom:40px}
h2{font-size:1.05rem;font-weight:700;color:#fff;margin:36px 0 10px}
p,li{font-size:.93rem;color:#94a3b8;margin-bottom:10px}
ul{padding-left:20px;margin-bottom:10px}
a{color:#00f2ea;text-decoration:none}
footer{margin-top:60px;padding-top:24px;border-top:1px solid rgba(255,255,255,.07);font-size:.8rem;color:#475569}
</style>
</head>
<body>
<div class="wrap">
  <a class="logo" href="https://cultcontent.cc"><img class="logo-icon" src="https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png" alt="Cult Content"><span class="logo-text">Cult Content</span></a>
  <h1>Terms of Service</h1>
  <p class="updated">Last updated: May 26, 2026</p>

  <p>These Terms of Service ("Terms") govern your use of the Cult Content creator platform ("Service") operated by Cult Content LLC ("we," "us," or "our"). By accessing or using the Service, you agree to be bound by these Terms.</p>

  <h2>1. The Service</h2>
  <p>Cult Content is a creator affiliate management platform. We connect brands with content creators, facilitate collaboration invitations, and provide performance analytics. The Service includes our creator signup pages, brand dashboards, and related tools.</p>

  <h2>2. Social Account Connection</h2>
  <p>As part of the creator signup process, you may be asked to connect your social media account. This connection uses the platform's official OAuth authorization. By connecting your account, you authorize us to:</p>
  <ul>
    <li>Retrieve your user ID and public username</li>
    <li>Use your user ID to send you a collaboration invitation on behalf of the brand you are applying to work with</li>
  </ul>
  <p>We do not post to your social accounts, access your messages, or store your credentials. You may revoke this connection at any time through the respective platform's app settings under "Manage app permissions."</p>

  <h2>3. Creator Obligations</h2>
  <p>As a creator using the Service, you agree to:</p>
  <ul>
    <li>Provide accurate information during signup</li>
    <li>Comply with the Community Guidelines and Terms of Service of any platforms you connect</li>
    <li>Comply with applicable advertising disclosure requirements (FTC guidelines)</li>
    <li>Not misrepresent your identity, follower count, or engagement metrics</li>
  </ul>

  <h2>4. Commission and Payments</h2>
  <p>Commission rates, payment terms, and payout schedules are governed by the individual brand agreements within the applicable affiliate system. Cult Content is not responsible for commission payments, which are processed directly through the relevant platform.</p>

  <h2>5. Intellectual Property</h2>
  <p>Content you create remains your property. By participating in brand campaigns, you grant the brand a license to use your content as agreed in the collaboration terms. Cult Content's platform, branding, and tools are owned by Cult Content LLC.</p>

  <h2>6. Disclaimers</h2>
  <p>The Service is provided "as is" without warranties of any kind. We do not guarantee earnings, campaign availability, or uninterrupted access to the platform. Third-party platform features and API availability are subject to those platforms' own terms and policies.</p>

  <h2>7. Limitation of Liability</h2>
  <p>To the fullest extent permitted by law, Cult Content LLC shall not be liable for any indirect, incidental, or consequential damages arising from your use of the Service.</p>

  <h2>8. Changes to Terms</h2>
  <p>We may update these Terms from time to time. Continued use of the Service after changes constitutes acceptance of the updated Terms.</p>

  <h2>9. Contact</h2>
  <p>Questions about these Terms? Email us at <a href="mailto:hello@cultcontent.cc">hello@cultcontent.cc</a>.</p>

  <footer>© 2026 Cult Content LLC · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a></footer>
</div>
</body>
</html>`);
});

app.get('/privacy', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy — Cult Content</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e2e8f0;line-height:1.7;padding:0}
.wrap{max-width:760px;margin:0 auto;padding:60px 24px 100px}
.logo{display:flex;align-items:center;gap:12px;text-decoration:none;margin-bottom:48px;width:fit-content}
.logo-icon{width:48px;height:48px;border-radius:10px;object-fit:cover;flex-shrink:0}
.logo-text{font-size:1rem;font-weight:800;color:#00f2ea;letter-spacing:-.01em}
h1{font-size:2rem;font-weight:900;margin-bottom:8px;letter-spacing:-.02em}
.updated{font-size:.82rem;color:#64748b;margin-bottom:40px}
h2{font-size:1.05rem;font-weight:700;color:#fff;margin:36px 0 10px}
p,li{font-size:.93rem;color:#94a3b8;margin-bottom:10px}
ul{padding-left:20px;margin-bottom:10px}
a{color:#00f2ea;text-decoration:none}
footer{margin-top:60px;padding-top:24px;border-top:1px solid rgba(255,255,255,.07);font-size:.8rem;color:#475569}
</style>
</head>
<body>
<div class="wrap">
  <a class="logo" href="https://cultcontent.cc"><img class="logo-icon" src="https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png" alt="Cult Content"><span class="logo-text">Cult Content</span></a>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: May 26, 2026</p>

  <p>Cult Content LLC ("we," "us," or "our") operates the Cult Content creator platform. This Privacy Policy explains how we collect, use, and protect your information when you use our Service.</p>

  <h2>1. Information We Collect</h2>
  <p>When you sign up as a creator, we collect:</p>
  <ul>
    <li><strong>Contact information:</strong> Name, email address, phone number</li>
    <li><strong>Social media handles:</strong> Username(s) on platforms you connect or provide</li>
    <li><strong>Performance data:</strong> Follower range, GMV range, content niche (self-reported)</li>
    <li><strong>Social account data (if you connect an account):</strong> User ID and public username, obtained via the platform's official OAuth</li>
  </ul>

  <h2>2. How We Use Social Account Data</h2>
  <p>If you choose to connect a social media account, we use the data solely to:</p>
  <ul>
    <li>Send you a collaboration invitation on behalf of the brand whose creator program you applied to</li>
    <li>Associate your social identity with your creator profile in our system</li>
  </ul>
  <p>We do not sell, share, or transfer your social account data to third parties. We do not use it for advertising or profiling beyond the specific collaboration invitation described above. Your credentials are never stored — only the user ID returned by the platform's OAuth system.</p>
  <p>You can revoke our access to your social account at any time via that platform's app settings under "Manage app permissions."</p>

  <h2>3. How We Use Other Information</h2>
  <ul>
    <li><strong>Email / Phone:</strong> To add you to the brand's CRM (GoHighLevel) and send campaign updates</li>
    <li><strong>Discord username:</strong> To grant you a Verified Creator role in the brand's Discord server</li>
    <li><strong>Performance data:</strong> To match creators with appropriate brand campaigns</li>
  </ul>

  <h2>4. Data Sharing</h2>
  <p>We share your information only with:</p>
  <ul>
    <li>The brand whose creator program you applied to</li>
    <li>GoHighLevel (our CRM provider) for contact management</li>
    <li>The relevant social commerce platform, to send the collaboration invitation</li>
  </ul>
  <p>We do not sell your personal data.</p>

  <h2>5. Data Retention</h2>
  <p>We retain your information for as long as you are active in the creator program. You may request deletion at any time by emailing <a href="mailto:hello@cultcontent.cc">hello@cultcontent.cc</a>.</p>

  <h2>6. Security</h2>
  <p>We use industry-standard security practices to protect your data. Data is stored on encrypted servers. OAuth tokens are stored securely and used only to perform authorized actions.</p>

  <h2>7. Children's Privacy</h2>
  <p>Our Service is not directed at children under 13. We do not knowingly collect personal information from children under 13.</p>

  <h2>8. Changes to This Policy</h2>
  <p>We may update this Privacy Policy from time to time. We will notify users of significant changes via email or a notice on the platform.</p>

  <h2>9. Contact</h2>
  <p>For privacy questions or data deletion requests, contact us at <a href="mailto:hello@cultcontent.cc">hello@cultcontent.cc</a>.</p>

  <footer>© 2026 Cult Content LLC · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a></footer>
</div>
</body>
</html>`);
});

// GET /creators — creator network signup page
app.get('/creators', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'creators.html'));
});

// GET /creators/:brandSlug/welcome — post-signup welcome page
app.get('/creators/:brandSlug/welcome', (req, res) => {
  const { brandSlug } = req.params;
  const handle = (req.query.handle || '').replace(/^@/, '').trim();
  const brands = loadBrands();
  const brand  = (brands.clients || []).find(b => b.creatorPage?.slug === brandSlug);
  if (!brand || !brand.creatorPage) return res.status(404).send('Page not found');
  res.set('Content-Type', 'text/html');
  res.send(renderWelcomePage(brand, brand.creatorPage, handle));
});

// GET /creators/:brandSlug — public creator interest page
// active flag only hides the page if explicitly set to false; omitted or true = visible
app.get('/creators/:brandSlug', (req, res) => {
  const brands = loadBrands();
  const brand  = (brands.clients || []).find(b => b.creatorPage?.slug === req.params.brandSlug);
  if (!brand?.creatorPage || brand.creatorPage.active === false) {
    return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not found</title></head><body style="font-family:sans-serif;text-align:center;padding:80px 20px;background:#0d0b14;color:#fff"><h1 style="margin-bottom:12px">Page not found</h1><p style="color:#666">This creator page doesn't exist or has been taken down.</p></body></html>`);
  }
  try { require('./routes/link-tracker').trackClick(req.params.brandSlug, req.query.ref, req); } catch (_) {}
  res.set('Content-Type', 'text/html');
  res.send(renderCreatorPage(brand, brand.creatorPage));
});

// ─── Auto-send Target Collaboration when a creator applies ────────────────────
// Fetches the brand's enrolled TikTok Shop affiliate products, builds a
// single-creator TC automation in Reacher, and fires it off.
// Runs fire-and-forget — errors are logged but never surface to the creator.
async function sendCreatorTC(brand, brands, brandIdx, creatorHandle, tiktokOpenId = null) {
  const label = `[creator-tc:${brand.name}→@${creatorHandle}]`;
  const cp = brand.creatorPage || {};

  // tcCommission is a percentage (e.g. 25 = 25%). Fall back to brand.commissionRate (decimal, e.g. 0.1)
  const tcCommission = cp.tcCommission || (brand.commissionRate ? Math.round(brand.commissionRate * 100) : 0);
  if (!tcCommission) {
    console.log(`${label} skip — no commission rate configured`); return;
  }

  const commissionDecimal = tcCommission / 100;

  // ── PRODUCT ALLOW-LIST (fail-closed) ──────────────────────────────────────
  // We NEVER dump the full catalog into a target collab. A TC is only sent for
  // products explicitly approved for this brand. Resolution order:
  //   1. cp.tcProductIds  (array of approved product_ids — the canonical allow-list)
  //   2. cp.tcHeroProductId (single legacy hero product)
  //   3. HARD STOP — no products approved => do NOT send (return [])
  const resolveTcProductIds = () => {
    if (Array.isArray(cp.tcProductIds) && cp.tcProductIds.length) {
      return cp.tcProductIds.map(String).filter(Boolean);
    }
    if (cp.tcHeroProductId) return [String(cp.tcHeroProductId)];
    return [];
  };
  const approvedProductIds = resolveTcProductIds();
  if (!approvedProductIds.length) {
    console.warn(`${label} BLOCKED — no approved TC products (tcProductIds/tcHeroProductId) configured for ${brand.name}. Refusing to send to avoid full-catalog collab.`);
    return { ok: false, blocked: true, reason: 'no_approved_products', brand: brand.name };
  }

  // ── Path A.5: Look up creator open_id by handle if not provided ──
  // Searches TikTok's creator database using the brand's own token.
  // Runs before Path A so we can use direct invite even when creator didn't do OAuth.
  const shopTok = brand.tiktokShopToken;
  if (!tiktokOpenId && creatorHandle && shopTok?.access_token && shopTok?.shop_cipher) {
    const cleanHandle = creatorHandle.replace(/^@/, '').toLowerCase();
    try {
      // Search affiliated creators first (fast, no quota cost)
      const searchResp = await ttsBrandPost(brand, brands, brandIdx, '/affiliate/seller/202309/creators/search', {
        creator_handle: cleanHandle,
        page_size: 10,
      });
      const creators = searchResp?.data?.creators || [];
      const match = creators.find(c =>
        (c.creator_handle || c.username || '').toLowerCase().replace(/^@/, '') === cleanHandle
      );
      if (match?.creator_open_id) {
        tiktokOpenId = match.creator_open_id;
        console.log(`${label} resolved open_id ${tiktokOpenId} via handle lookup`);
      } else {
        console.log(`${label} creator @${cleanHandle} not found in affiliated creators (${creators.length} returned) — will fall back to Reacher TC`);
      }
    } catch(e) {
      console.error(`${label} creator handle lookup error:`, e.message);
    }
  }

  // ── Path A: Direct TikTok Shop invite (requires creator open_id + brand shop token) ──
  // Cleaner, faster, no Reacher dependency — used when creator connected TikTok via OAuth
  // or when open_id was resolved above via handle lookup
  if (tiktokOpenId) {
    if (!shopTok?.access_token) {
      console.log(`${label} no brand TikTok Shop token — falling through to Reacher`);
    } else if (!shopTok?.shop_cipher) {
      console.log(`${label} brand token missing shop_cipher — falling through to Reacher`);
    } else {
      // Product list comes ONLY from the approved allow-list (fail-closed above).
      const productIds = approvedProductIds;
      console.log(`${label} TikTok direct invite: ${productIds.length} approved product(s) [${productIds.join(',')}]`);
      try {
        const resp = await ttsBrandPost(brand, brands, brandIdx, '/affiliate/seller/202309/creators/invite', {
          creator_open_id: tiktokOpenId,
          product_ids:     productIds,
          commission_rate: commissionDecimal,
        });
        console.log(`${label} TikTok direct TC invite sent:`, resp?.data || 'ok');
        return;
      } catch(e) {
        console.error(`${label} TikTok direct invite error:`, e.response?.data || e.message);
        console.log(`${label} falling through to Reacher TC`);
      }
    }
  }

  // ── Path B: Reacher Target Collaboration (handle-based, no open_id needed) ──
  if (!brand.shopId) {
    console.log(`${label} skip — no Reacher shopId on brand`); return;
  }

  // Product list comes ONLY from the approved allow-list (fail-closed above).
  const tcProducts = approvedProductIds.map(pid => ({
    product_id:      String(pid),
    commission_rate: commissionDecimal,
  }));
  console.log(`${label} Reacher TC: ${tcProducts.length} approved product(s) [${approvedProductIds.join(',')}]`);

  const message = `Hi! We'd love to collaborate with you on ${brand.name}. We offer ${tcCommission}% commission on our TikTok Shop products — click to view the details and accept the invite!`;
  try {
    const { data } = await axios.post(`${CFG.railwayUrl}/affiliate/tc-invite`, {
      shopId:    brand.shopId,
      handle:    creatorHandle,
      products:  tcProducts,
      brandName: brand.name,
      message,
      commission: tcCommission,
    }, { timeout: 20_000 });
    console.log(`${label} Reacher TC automation created:`, data?.automation_id || 'ok');
  } catch(e) {
    console.error(`${label} TC invite error:`, e.response?.data || e.message);
  }
}

// POST /api/creator-pages/submit — public creator interest form submission
app.post('/api/creator-pages/submit', express.json(), async (req, res) => {
  try {
    const { brandSlug, name, firstName: fFirst, lastName: fLast, email, phone, tiktokHandle, tiktokOpenId, discordUsername, followerRange, gmv, niche, message } = req.body || {};
    // Support both "name" (full name) and "firstName"/"lastName" separately
    let firstName = fFirst || '';
    let lastName  = fLast  || '';
    if (name && !firstName) {
      const parts = name.trim().split(/\s+/);
      firstName = parts[0];
      lastName  = parts.slice(1).join(' ') || '';
    }
    if (!brandSlug || !firstName || !email) return res.status(400).json({ ok: false, error: 'Missing required fields' });
    const brands = loadBrands();
    const brand  = (brands.clients || []).find(b => b.creatorPage?.slug === brandSlug);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });
    const tagName = brand.creatorPage?.tagName || `creator-interested-${brandSlug}`;
    const handle  = (tiktokHandle || '').replace(/^@/, '').trim();
    const digits  = (phone || '').replace(/\D/g, '');
    const cleanPhone = digits.length === 10 ? `+1${digits}` : digits ? `+${digits}` : '';

    let contactId = null;
    try {
      const sr = await ghl.get('/contacts/', { params: { locationId: CFG.locationId, query: email, limit: 1 } });
      contactId = sr.data?.contacts?.[0]?.id || null;
    } catch(_) {}
    const TIKTOK_HANDLE_FIELD_ID = 'trnSmiM9oilkdQSInRPn'; // canonical GHL 'TikTok Handle' TEXT field
    // Canonical brand tag (step 5 convention) — used by weekly creator-call reminder targeting.
    const brandTag = `brand:${brandSlug}`;
    const matchTags = [tagName, 'creator-interest-form', 'affiliate', `${brandSlug}-affiliate`, brandTag];
    const payload = { locationId: CFG.locationId, firstName, lastName, email, phone: cleanPhone, tags: matchTags, source: `Creator Interest Page — ${brand.name}` };
    if (handle) { payload.customFields = [{ id: TIKTOK_HANDLE_FIELD_ID, value: handle }]; }
    if (contactId) {
      await ghl.put(`/contacts/${contactId}`, payload).catch(() => {});
      await ghl.post(`/contacts/${contactId}/tags`, { tags: matchTags }).catch(() => {});
    } else {
      try {
        const cr = await ghl.post('/contacts/', payload);
        contactId = cr.data?.contact?.id;
      } catch(ghlErr) {
        console.error('[creator-pages] GHL contact create error:', ghlErr.response?.data || ghlErr.message);
        // Don't throw — continue without a contactId (submission still succeeds)
      }
    }
    if (contactId) {
      const noteLines = [
        `TikTok Handle: ${handle ? '@' + handle : 'not provided'}`,
        `Discord: ${discordUsername || 'not provided'}`,
        followerRange ? `Followers: ${followerRange}` : null,
        gmv           ? `Monthly GMV: ${gmv}` : null,
        niche         ? `Niche: ${niche}` : null,
        `Interested in brand: ${brand.name}`,
        message ? `Message: ${message}` : null,
      ].filter(Boolean);
      await ghl.post(`/contacts/${contactId}/notes`, { body: noteLines.join('\n'), userId: '' }).catch(() => {});
    }

    // SMS (upsert conversation first to avoid needing conversationProviderId)
    if (contactId && cleanPhone) {
      const discordLink = process.env.DISCORD_INVITE_URL || 'https://discord.gg/a5WNMe8Xuu';
      const ghlH = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
      const larkGroupUrl = brand.creatorPage?.larkGroupUrl || null;
      const larkLine = larkGroupUrl ? `\n→ Lark community: ${larkGroupUrl}` : '';
      // Brand-aware signup details
      const cpForSms = brand.creatorPage || {};
      const commPct = cpForSms.tcCommission || (brand.commissionRate ? Math.round(brand.commissionRate * 100) : null);
      const commLine = commPct ? `\n→ You'll earn ${commPct}% commission on every ${brand.name} sale you drive` : '';
      const brandPageUrl = cpForSms.slug ? `${CREATOR_BASE_URL}/creators/${cpForSms.slug}` : `${CREATOR_BASE_URL}/creators`;
      axios.post('https://services.leadconnectorhq.com/conversations/', {
        locationId: process.env.GHL_LOCATION_ID || process.env.GHL_LOC_ID,
        contactId,
      }, { headers: ghlH })
      .then(r => {
        const conversationId = r.data?.conversationId || r.data?.id;
        return axios.post('https://services.leadconnectorhq.com/conversations/messages', {
          type: 'SMS',
          conversationId,
          contactId,
          message: `You're in for ${brand.name} 👁️‼️ Welcome, ${firstName}!\n\nHere's how to start earning with ${brand.name}:\n→ Your ${brand.name} page (product + content brief): ${brandPageUrl}${commLine}\n\nAnd your community:\n→ Discord: ${discordLink}\n→ Skool: https://www.skool.com/cult-content${larkLine}\n\nText this number anytime if you need us.`,
        }, { headers: ghlH });
      })
      .catch(e => console.error('[creator-pages] SMS error:', e.response?.data || e.message));
    }

    // Discord role assignment with retry
    const botToken = process.env.DISCORD_BOT_TOKEN;
    const guildId  = process.env.DISCORD_GUILD_ID;
    const roleId   = process.env.DISCORD_CREATOR_ROLE_ID;
    const cleanDu  = (discordUsername || '').replace(/^@/, '').trim();

    async function tryAssignCreatorRole() {
      if (!botToken || !guildId || !roleId || !cleanDu) return { ok: false };
      try {
        const searchRes = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members/search`, {
          params: { query: cleanDu, limit: 10 },
          headers: { Authorization: `Bot ${botToken}` },
        });
        const members = searchRes.data || [];
        const member  = members.find(m =>
          m.user.username.toLowerCase() === cleanDu.toLowerCase() ||
          (m.user.global_name || '').toLowerCase() === cleanDu.toLowerCase()
        );
        if (member) {
          await axios.put(`https://discord.com/api/v10/guilds/${guildId}/members/${member.user.id}/roles/${roleId}`, null, { headers: { Authorization: `Bot ${botToken}` } });
          return { ok: true };
        }
        return { ok: false, error: 'not_found' };
      } catch(e) { return { ok: false, error: e.message }; }
    }
    function scheduleCreatorRoleRetry(attemptsLeft) {
      if (attemptsLeft <= 0 || !cleanDu) return;
      setTimeout(async () => {
        const r = await tryAssignCreatorRole();
        if (!r.ok && r.error === 'not_found') scheduleCreatorRoleRetry(attemptsLeft - 1);
      }, 5 * 60 * 1000);
    }
    const discordResult = await tryAssignCreatorRole();
    if (discordResult.error === 'not_found') scheduleCreatorRoleRetry(3);

    // Lark alert
    const larkText = [
      `New Creator Signup - ${brand.name}`,
      `Name: ${firstName}${lastName ? ' ' + lastName : ''} | ${email}${phone ? ' | ' + phone : ''}`,
      handle        ? `TikTok: @${handle}` : null,
      discordUsername ? `Discord: @${discordUsername.replace(/^@/,'')}` : null,
      followerRange ? `Followers: ${followerRange}` : null,
      gmv           ? `Monthly GMV: ${gmv}` : null,
      contactId     ? `GHL: https://app.gohighlevel.com/contacts/${contactId}` : null,
    ].filter(Boolean).join('\n');
    axios.post(`${CFG.railwayUrl}/command`,
      { text: larkText, context: 'Creator Signup', source: 'Creator Landing Page' },
      { timeout: 10000 }
    ).catch(e => console.error('[creator-pages] Lark notify error:', e.message));

    // Auto-send TC invite (fire-and-forget)
    if (handle) {
      const brandIdx = brands.clients.findIndex(b => b.creatorPage?.slug === brandSlug);
      const openId   = (tiktokOpenId || '').trim() || null;
      sendCreatorTC(brand, brands, brandIdx, handle, openId)
        .catch(e => console.error('[creator-pages] TC fire error:', e.message));
    }

    console.log(`[creator-pages] Submission for ${brand.name}: ${email} (${handle ? '@'+handle : 'no handle'})`);
    const handleParam = handle ? `?handle=${encodeURIComponent('@' + handle.replace(/^@/, ''))}` : '';
    writeCreatorSignupToBitable({
      brand: brand.name, creatorName: `${firstName} ${lastName}`.trim(), handle, email,
      phone: cleanPhone, discord: discordUsername, followerRange, gmv, niche, message,
      source: 'Brand Signup'
    }).catch(()=>{});
    res.json({ ok: true, contactId, welcomeUrl: `/creators/${brandSlug}/welcome${handleParam}` });
  } catch(e) {
    console.error('[creator-pages/submit]', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: 'Submission failed — please try again' });
  }
});

// ── Creator page TikTok Display API OAuth — registered BEFORE requireAuth ─────
// Allows creators to connect their TikTok account via a popup on the creator page.
// The callback postMessages their open_id back to the parent window.

// ─── Creator TikTok OAuth via Shop app (no separate Display API key needed) ───
// In-memory store: pendingToken → { formData, brandSlug, ts }
const pendingCreatorSignups = new Map();

// POST /api/creator-pages/pending — store form data, return TikTok Shop OAuth URL
// Called by the creator signup form before redirecting to TikTok
app.post('/api/creator-pages/pending', express.json(), (req, res) => {
  const { brandSlug, name, email, phone, tiktokHandle, discordUsername, followerRange, gmv, niche, message } = req.body || {};
  if (!brandSlug || !name || !email) return res.status(400).json({ error: 'Missing required fields' });

  const brands = loadBrands();
  const brand  = (brands.clients || []).find(b => b.creatorPage?.slug === brandSlug);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });

  const appKey = process.env.TIKTOK_SHOP_APP_KEY;
  if (!appKey) return res.status(500).json({ error: 'TikTok app not configured' });

  const token = crypto.randomBytes(20).toString('hex');
  pendingCreatorSignups.set(token, { formData: req.body, brandSlug, ts: Date.now() });
  // Prune stale entries (> 30 min)
  for (const [k, v] of pendingCreatorSignups) { if (Date.now() - v.ts > 1_800_000) pendingCreatorSignups.delete(k); }

  const state       = Buffer.from(JSON.stringify({ type: 'creator', token, brandSlug })).toString('base64');
  const redirectUri = process.env.TIKTOK_SHOP_REDIRECT_URI || 'https://portal.cultcontent.cc/api/tiktokshop/callback';
  const authUrl     = `https://auth.tiktok-shops.com/oauth/authorize?app_key=${encodeURIComponent(appKey)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
  res.json({ ok: true, authUrl });
});

// GET /api/creator/connect/auth?slug=SLUG — clean alias (no "tiktok" in path for app review)
// GET /api/creator-tiktok/auth?slug=SLUG — legacy path, kept for backwards compat
app.get(['/api/creator/connect/auth', '/api/creator-tiktok/auth'], (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).send('<h2>Missing slug</h2>');
  const clientKey = process.env.CREATOR_TIKTOK_CLIENT_KEY;
  if (!clientKey) return res.status(500).send('<h2>TikTok creator auth not configured — add CREATOR_TIKTOK_CLIENT_KEY to env vars</h2>');
  const brands = loadBrands();
  const brand  = (brands.clients || []).find(b => b.creatorPage?.slug === slug);
  if (!brand || !brand.creatorPage) return res.status(404).send('<h2>Page not found</h2>');

  const state = crypto.randomBytes(20).toString('hex');
  creatorTikTokStates.set(state, { slug, ts: Date.now() });
  // Prune states older than 10 minutes
  for (const [k, v] of creatorTikTokStates) { if (Date.now() - v.ts > 600_000) creatorTikTokStates.delete(k); }

  const redirectUri = process.env.CREATOR_TIKTOK_REDIRECT_URI || `${CREATOR_BASE_URL}/api/creator/connect/callback`;
  const params = new URLSearchParams({
    client_key:    clientKey,
    scope:         'user.info.basic',
    response_type: 'code',
    redirect_uri:  redirectUri,
    state,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

// GET /api/creator/connect/callback — clean alias (no "tiktok" in path for app review)
// GET /api/creator-tiktok/callback — legacy path, kept for backwards compat
// Exchanges TikTok auth code for access token, then redirects back to /creators/<slug>
// with tt_handle + tt_oid query params so the page can show "Connected" without a popup.
app.get(['/api/creator/connect/callback', '/api/creator-tiktok/callback'], async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Error page — redirects back to creator page with error param if slug known
  const stateData = creatorTikTokStates.get(state);
  const slugFallback = stateData?.slug || '';

  if (error) {
    const msg = error_description || error;
    if (slugFallback) return res.redirect(`${CREATOR_BASE_URL}/creators/${slugFallback}?tt_error=${encodeURIComponent(msg)}`);
    return res.status(400).send(`<h2 style="color:#ff5b5b;font-family:sans-serif;text-align:center;padding:60px">TikTok auth error: ${msg}</h2>`);
  }

  if (!stateData) {
    return res.status(400).send('<h2 style="color:#ff5b5b;font-family:sans-serif;text-align:center;padding:60px">Session expired — please go back and try connecting again.</h2>');
  }
  creatorTikTokStates.delete(state);

  const { slug } = stateData;
  const clientKey    = process.env.CREATOR_TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.CREATOR_TIKTOK_CLIENT_SECRET;
  const redirectUri  = process.env.CREATOR_TIKTOK_REDIRECT_URI || `${CREATOR_BASE_URL}/api/creator/connect/callback`;

  try {
    const { data: tok } = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (tok.error) throw new Error(tok.error_description || tok.error);

    const openId = tok.open_id || '';

    // Fetch TikTok handle from Display API
    let tiktokHandle = '';
    try {
      const { data: uInfo } = await axios.get('https://open.tiktokapis.com/v2/user/info/', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
        params:  { fields: 'open_id,username,display_name' },
      });
      tiktokHandle = uInfo?.data?.user?.username || uInfo?.data?.user?.display_name || '';
    } catch(_) {}

    // Redirect back to the creator page — JS on that page restores form from sessionStorage
    // and shows the "Connected" badge using the query params.
    const params = new URLSearchParams({ tt_oid: openId });
    if (tiktokHandle) params.set('tt_handle', tiktokHandle);
    return res.redirect(`${CREATOR_BASE_URL}/creators/${slug}?${params.toString()}`);
  } catch(e) {
    console.error('[creator/connect/callback] error:', e.message);
    return res.redirect(`${CREATOR_BASE_URL}/creators/${slug}?tt_error=${encodeURIComponent('Connection failed — please try again.')}`);
  }
});

// POST /api/proposals/publish — public so prospects can be linked directly
// Registered BEFORE requireAuth so it doesn't need a CF Access session

// ============================================================================
// INNER CIRCLE PORTAL
// ============================================================================

// Inner Circle brand catalog — display metadata for the brand selection UI.
// NOTE: brands.json remains the source of truth for which brands have Inner
// Circle ENABLED (brand.innerCircle flag, toggled from the client portal).
// This constant supplies id/logo/description for the selection cards and is
// merged against brands.json by name at request time.
// TODO(Tommy): confirm final brand list, logo file paths, and descriptions.
const INNER_CIRCLE_BRANDS = [
  {
    id: 'trusted-rituals',
    name: 'Trusted Rituals',
    logo: '/logos/trusted-rituals.png',
    description: 'Mullein honey sticks for respiratory health — 2,000mg per stick, Himalayan-sourced. Strong hooks around pollen season, quitting vaping, and daily wellness rituals.'
  },
  {
    id: 'diamandia',
    name: 'DIAMANDIA',
    logo: '/logos/diamandia.png',
    description: 'DIAMANDIA TikTok Shop brand — 25% target collab commission on the hero product.'
  },
  {
    id: 'approved-science',
    name: 'Approved Science',
    logo: '/logos/approved-science.png',
    description: 'Science-backed supplements (Marketily / Lenea). Evidence-led content angles.'
  },
  {
    id: 'alpha-flow',
    name: 'Alpha Flow',
    logo: '/logos/alpha-flow.png',
    description: 'Alpha Flow TikTok Shop brand.'
  }
  // TODO(Tommy): Eva's brand + any remaining clients — need official name, logo, description.
];

// Find catalog entry for a brands.json record (matched by normalized name)
function innerCircleCatalogFor(brand) {
  const n = String((brand && brand.name) || '').toLowerCase().trim();
  return INNER_CIRCLE_BRANDS.find(b => b.name.toLowerCase() === n || b.id === n.replace(/\s+/g, '-')) || null;
}


// Format integer seconds as HH:MM:SS (e.g. 5025 -> "01:23:45"). Used by Inner Circle recordings API.
function formatDuration(seconds) {
  const s = Math.max(0, parseInt(seconds, 10) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return pad(h) + ':' + pad(m) + ':' + pad(sec);
}

// SQLite-backed Inner Circle API (login + GET /api/inner-circle/dashboard).
// Registered BEFORE the legacy Supabase handlers below — Express matches routes
// in registration order, so these working handlers take precedence. Must stay
// above app.use(requireAuth): creators have no Cloudflare Access session.
let icSqlite;
try { icSqlite = require('./routes/inner-circle-sqlite')(app, { express }); }
catch (e) { console.error('[inner-circle-sqlite] route registration failed:', e.message); }

// Content Studio: ensure schema exists (content_credits, content_references,
// content_generations, client_integrations). Idempotent CREATE TABLE IF NOT EXISTS;
// runs the migration against /data/inner_circle.db on boot. Must be before app.listen().
try { require('./db/content-studio'); console.log('[content-studio] schema ensured'); }
catch (e) { console.error('[content-studio] schema init failed:', e.message); }

// Content Studio: generation + credits endpoints (reuses db/content-studio.js).
// Registered here (before app.listen) per command-center route-ordering rule.
try {
  require('./routes/content-studio-gen')(app, { requireClientSession, loadBrands });
} catch (e) { console.error('[content-studio-gen] registration failed:', e.message); }
try {
  require('./routes/client-intercom-identity')(app, { requireClientSession, loadBrands });
} catch (e) { console.error('[client-intercom-identity] registration failed:', e.message); }
try { require('./routes/inner-circle-spark-brand')(app, { express, requireClientSession, loadBrands }); } catch (e) { console.error('[inner-circle-spark-brand] registration failed:', e.message); }

// Ops Engine "My Tasks" per-person UI. Mounted BEFORE app.use(requireAuth) so
// unauthenticated API hits return a clean JSON 401 (the module carries its own
// self-contained auth guard reading req.userEmail / session). Serves
// /api/my-tasks/list, /api/my-tasks/complete on manifest.cultcontent.cc.
let opsMyTasksHelpers = null;
try {
  const registerOpsMyTasks = require('./routes/ops-my-tasks');
  registerOpsMyTasks(app, { express, requireAuth, getLarkTenantToken });
  opsMyTasksHelpers = registerOpsMyTasks._helpers;
} catch (e) { console.error('[ops-my-tasks] registration failed:', e.message); }

// Client Agent — Phase 1 data layer (see lib/client-agent-context.js).
// Test route only for now: confirms getCompletedTasks() resolves real data
// before anything is wired into scheduling or a client-facing report.
app.get('/api/admin/client-agent/completed-tasks', requirePortalAdmin, async (req, res) => {
  try {
    if (!opsMyTasksHelpers) return res.status(503).json({ error: 'ops-my-tasks helpers unavailable' });

    const { brand, days } = req.query;
    if (!brand) return res.status(400).json({ error: 'brand query param required' });
    const end = Date.now();
    const start = end - (Number(days) > 0 ? Number(days) : 7) * 86400000;

    const { getCompletedTasks } = require('./lib/client-agent-context');
    const tasks = await getCompletedTasks(brand, { start, end }, opsMyTasksHelpers);
    res.json({ brand, rangeDays: Number(days) > 0 ? Number(days) : 7, count: tasks.length, tasks });
  } catch (e) {
    console.error('[client-agent] completed-tasks error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Creator Lead hiring page — public, no-login application at
// portal.cultcontent.cc/apply/creator-lead. Must stay before app.use(requireAuth).
try {
  require('./routes/creator-lead-apply')(app, { express, axios, getLarkTenantToken });
} catch (e) { console.error('[creator-lead-apply] registration failed:', e.message); }

// Careers listing page — public, no-login page at portal.cultcontent.cc/apply.
// Must stay before app.use(requireAuth).
try {
  require('./routes/careers')(app, {});
} catch (e) { console.error('[careers] registration failed:', e.message); }


// ─── GET /api/inner-circle/admin/funnel?shopId=NNN ───────────────────────────
// Admin-only Inner Circle funnel: shows each IC signup's state for one shop —
// signed_up vs tc_accepted vs sample_requested — by joining IC signups to live
// Reacher status. Token-gated with ADMIN_BATCH_SECRET (x-admin-secret header),
// the same pattern as the other /api/admin/* routes. Registered HERE, before
// app.use(requireAuth), so it does not require a Cloudflare Access session
// (server-to-server / curl callers pass the shared secret instead).
app.get('/api/inner-circle/admin/funnel', async (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  const got = req.headers['x-admin-secret'] || req.query.secret;
  if (got !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const shopId = req.query.shopId || req.query.shop_id;
  if (!shopId) return res.status(400).json({ error: 'shopId required' });
  if (!icSqlite || typeof icSqlite.getIcFunnel !== 'function') {
    return res.status(503).json({ error: 'IC funnel layer unavailable' });
  }
  try {
    const out = await icSqlite.getIcFunnel(shopId);
    if (out && out.error && (!out.creators || !out.creators.length)) {
      // Hard data-layer failure (e.g. DB unavailable) → 503; partial Reacher
      // outages still return 200 with summary.reacherError set.
      return res.status(503).json(out);
    }
    return res.json(out);
  } catch (e) {
    console.error('[inner-circle/admin/funnel] failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─── Inner Circle: session-check endpoint + nav script ───────────────────────
// GET /ic-nav.js — injected into all creator-facing portal pages.
// Checks for an IC session and, if found, inserts a sticky header bar
// linking back to the Inner Circle dashboard.
app.get('/ic-nav.js', (req, res) => {
  res.type('application/javascript').send(`
(function() {
  if (window.location.pathname === '/') return;
  fetch('/api/ic/session-check', { credentials: 'include' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) return;
      var bar = document.createElement('div');
      bar.id = 'ic-nav-bar';
      bar.style.cssText = [
        'position:fixed','top:0','left:0','right:0','z-index:9999',
        'background:#1c1828','border-bottom:1px solid #2a2540',
        'display:flex','align-items:center','justify-content:space-between',
        'padding:0 20px','height:44px','font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'font-size:13px','color:#e2e8f0',
      ].join(';');
      bar.innerHTML =
        '<a href="/inner-circle/dashboard" style="display:flex;align-items:center;gap:7px;color:#00f2ea;text-decoration:none;font-weight:700;font-size:13px">' +
          '<span style="font-size:16px">←</span> Inner Circle' +
        '</a>' +
        '<span style="color:#64748b;font-size:12px">👋 ' + (d.firstName ? 'Hey, ' + d.firstName : 'Welcome back') + '</span>';
      document.body.insertBefore(bar, document.body.firstChild);
      document.body.style.paddingTop = (parseInt(document.body.style.paddingTop || 0) + 44) + 'px';
    })
    .catch(function() {});
})();
`);
});

// ─── Inner Circle: creator session auth middleware ────────────────────────────
// Verifies ic_session cookie (or Authorization: Bearer token) against the
// creator_sessions table in Supabase. Sets req.user to the creator row.
// Routes using this MUST be registered before app.use(requireAuth) because
// creators do not have Cloudflare Access sessions.
async function requireCreatorSession(req, res, next) {
  const sessionToken = req.cookies?.ic_session || req.headers.authorization?.replace('Bearer ', '');
  if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { data: session } = await supabase
      .from('creator_sessions')
      .select('*, creators(*)')
      .eq('token', sessionToken)
      .gt('expires_at', new Date().toISOString())
      .single();
    if (!session || !session.creators) return res.status(401).json({ error: 'Session expired' });
    req.user = session.creators;
    next();
  } catch (e) {
    console.error('[inner-circle] session check failed:', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

// GET /api/inner-circle/recordings — call recordings library for the logged-in creator
// Returns { recordings: [{ id, date, title, duration, url, attended }] } newest first.
app.get('/api/inner-circle/recordings', requireCreatorSession, async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('inner_circle_recordings')
      .select('*')
      .order('call_date', { ascending: false });
    if (error) throw error;

    // ── Brand-scope to the logged-in creator ────────────────────────────────
    // Resolve the creator's committed brands so a creator only sees recordings
    // for the brand(s) they're enrolled with. Recordings with no brand FK
    // (global/all-hands calls) remain visible to everyone.
    let brandClientIds = [];
    try {
      const { data: commitments } = await supabase
        .from('inner_circle_brand_commitments')
        .select('client_id')
        .eq('creator_id', req.user.id);
      brandClientIds = (commitments || [])
        .map((c) => c && c.client_id)
        .filter((id) => id != null)
        .map((id) => String(id));
    } catch (commitErr) {
      console.error('[inner-circle] recordings brand-scope lookup failed:', commitErr.message);
    }
    const brandSet = new Set(brandClientIds);
    const scopedRows = (rows || []).filter((r) => {
      // Identify any brand-linkage column the recording row may carry.
      const recBrand = r.client_id != null ? r.client_id
                     : (r.brand_id != null ? r.brand_id
                     : (r.shop_id  != null ? r.shop_id : null));
      // Untagged/global recordings are visible to all creators.
      if (recBrand == null || recBrand === '') return true;
      // Brand-tagged recordings only show to creators committed to that brand.
      return brandSet.has(String(recBrand));
    });

    const recordings = (scopedRows || []).map((r) => {
      const attendance = Array.isArray(r.attendance) ? r.attendance : [];
      return {
        id: r.id,
        date: r.call_date,
        title: r.title || `Growth Partners Call — ${r.call_date}`,
        duration: r.duration_seconds != null ? formatDuration(r.duration_seconds) : null,
        url: r.recording_url,
        attended: attendance.some((id) => String(id) === String(req.user.id)),
      };
    });
    // Fallback for empty table: seed with the Week 1 launch call so the
    // recordings library is never blank at launch. Remove once real rows exist.
    if (recordings.length === 0) {
      return res.json({
        recordings: [
          {
            id: 1,
            date: '2026-06-08',
            title: 'Week 1: Growth Partners Call',
            duration: null,
            url: 'https://www.larksuite.com/minutes/obus4pv6ixvw993ur65jab8g',
            attended: false,
          },
        ],
      });
    }
    res.json({ recordings });
  } catch (e) {
    console.error('[inner-circle] recordings fetch failed:', e.message);
    res.status(500).json({ error: 'Failed to load recordings' });
  }
});

// Creator login + Inner Circle signup page
app.get('/inner-circle', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'inner-circle-login.html'));
});

// Inner Circle login API
app.post('/api/inner-circle/login', express.json(), async (req, res) => {
  const {email, password} = req.body;
  
  if (!email || !password) {
    return res.status(400).json({error: 'Email and password required'});
  }
  
  try {
    // Look up creator in Supabase
    const {data: creator, error} = await supabase
      .from('creators')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();
    
    if (error || !creator) {
      return res.status(401).json({error: 'Invalid credentials'});
    }
    
    // Verify password (TikTok username or phone last 4)
    const validPassword = 
      password === creator.tiktok_handle ||
      password === (creator.phone || '').slice(-4);
    
    if (!validPassword) {
      return res.status(401).json({error: 'Invalid credentials'});
    }
    
    // Create session token
    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    
    // Store session
    await supabase
      .from('creator_sessions')
      .insert({
        creator_id: creator.id,
        token: sessionToken,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
      });
    
    res.json({
      success: true,
      token: sessionToken,
      creator: {
        id: creator.id,
        name: creator.name,
        email: creator.email,
        tiktok_handle: creator.tiktok_handle
      }
    });
    
  } catch (error) {
    console.error('Inner Circle login error:', error);
    res.status(500).json({error: 'Server error'});
  }
});

// Inner Circle dashboard v2 (SPA) — serves views/inner-circle.html.
// Session-checked here; page data is fetched client-side from /api/inner-circle/dashboard.
// Registered BEFORE the legacy inline dashboard route below so it takes precedence.
app.get('/inner-circle/dashboard', async (req, res, next) => {
  const sessionToken = req.cookies?.ic_session || req.headers.authorization?.replace('Bearer ', '');
  if (!sessionToken) return res.redirect('/inner-circle');
  try {
    const { data: session } = await supabase
      .from('creator_sessions')
      .select('*, creators(*)')
      .eq('token', sessionToken)
      .gt('expires_at', new Date().toISOString())
      .single();
    if (!session || !session.creators) return res.redirect('/inner-circle');
    return res.sendFile(path.join(__dirname, 'views/inner-circle.html'));
  } catch (e) {
    console.error('[inner-circle] dashboard v2 session check failed:', e.message);
    return res.redirect('/inner-circle');
  }
});

// Alias: the SPA redirects unauthenticated users to /inner-circle/login —
// send them to the existing creator login page at /inner-circle.
app.get('/inner-circle/login', (req, res) => res.redirect('/inner-circle'));

// Inner Circle dashboard
app.get('/inner-circle/dashboard', async (req, res) => {
  // Get session from cookie or header
  const sessionToken = req.cookies?.ic_session || req.headers.authorization?.replace('Bearer ', '');
  
  if (!sessionToken) {
    return res.redirect('/inner-circle');
  }
  
  try {
    // Verify session
    const {data: session} = await supabase
      .from('creator_sessions')
      .select('*, creators(*)')
      .eq('token', sessionToken)
      .gt('expires_at', new Date().toISOString())
      .single();
    
    if (!session) {
      return res.redirect('/inner-circle');
    }
    
    const creator = session.creators;
    
    // Get creator's Inner Circle enrollment
    const {data: enrollment} = await supabase
      .from('inner_circle_enrollments')
      .select('*')
      .eq('creator_id', creator.id)
      .single();
    
    // Get creator's brand commitments
    const {data: commitments} = await supabase
      .from('inner_circle_brand_commitments')
      .select('*, clients(*)')
      .eq('creator_id', creator.id);
    
    // Get video count this month
    const {data: videos} = await supabase
      .from('creator_videos')
      .select('id')
      .eq('creator_id', creator.id)
      .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());
    
    const videoCount = videos?.length || 0;
    
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inner Circle Dashboard — ${creator.name}</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e2e8f0;min-height:100vh}
.header{background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.07);padding:20px 24px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:1.3rem;font-weight:800;background:linear-gradient(135deg,#00f2ea,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .user{font-size:.9rem;color:#94a3b8}
.container{max-width:1400px;margin:0 auto;padding:40px 24px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-bottom:40px}
.stat-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:24px}
.stat-card .label{font-size:.85rem;color:#94a3b8;margin-bottom:8px}
.stat-card .value{font-size:2.2rem;font-weight:900;color:#fff}
.stat-card .progress{margin-top:12px;height:6px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden}
.stat-card .progress-bar{height:100%;background:linear-gradient(90deg,#00f2ea,#a855f7);transition:width .3s}
.section{margin-bottom:40px}
.section h2{font-size:1.5rem;font-weight:800;margin-bottom:20px}
.brands{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.brand-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:20px;transition:border-color .2s}
.brand-card:hover{border-color:rgba(0,242,234,.3)}
.brand-card h3{font-size:1.1rem;color:#00f2ea;margin-bottom:8px}
.brand-card p{font-size:.88rem;color:#94a3b8;margin-bottom:4px}
.btn{padding:10px 20px;background:linear-gradient(135deg,#00f2ea,#a855f7);border:none;border-radius:8px;color:#fff;font-weight:600;font-size:.9rem;cursor:pointer;transition:transform .2s}
.btn:hover{transform:translateY(-1px)}
.btn-secondary{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1)}
.empty{text-align:center;padding:60px 20px;color:#64748b}
</style>
</head>
<body>

<div class="header">
  <h1>Inner Circle</h1>
  <div class="user">
    ${creator.name} • <a href="/api/inner-circle/logout" style="color:#00f2ea;text-decoration:none">Logout</a>
  </div>
</div>

<div class="container">
  <div class="stats">
    <div class="stat-card">
      <div class="label">Videos This Month</div>
      <div class="value">${videoCount}</div>
      <div class="progress">
        <div class="progress-bar" style="width:${Math.min((videoCount/15)*100, 100)}%"></div>
      </div>
      <div class="label" style="margin-top:8px">${videoCount}/15 goal</div>
    </div>
    
    <div class="stat-card">
      <div class="label">Brand Commitments</div>
      <div class="value">${commitments?.length || 0}</div>
    </div>
    
    <div class="stat-card">
      <div class="label">Call Attendance</div>
      <div class="value">${enrollment?.calls_attended || 0}</div>
    </div>
    
    <div class="stat-card">
      <div class="label">Commission Rate</div>
      <div class="value">50%</div>
      <div class="label" style="margin-top:8px">Target collabs</div>
    </div>
  </div>
  
  <div class="section">
    <h2>Your Brands</h2>
    ${commitments && commitments.length > 0 ? `
      <div class="brands">
        ${commitments.map(c => `
          <div class="brand-card">
            <h3>${c.clients.name}</h3>
            <p>Videos posted: ${c.videos_posted || 0}</p>
            <p>Status: ${c.status}</p>
            <button class="btn" onclick="window.location.href='/creators/${c.clients.slug}'">View Brand Page</button>
          </div>
        `).join('')}
      </div>
    ` : `
      <div class="empty">
        <p>No brand commitments yet.</p>
        <button class="btn" style="margin-top:16px" onclick="window.location.href='/inner-circle/brands'">Browse Brands</button>
      </div>
    `}
  </div>
  
  <div class="section">
    <h2>Recent Call Recordings</h2>
    <div id="recordings"></div>
  </div>
</div>

<script>
// Load call recordings
fetch('/api/inner-circle/recordings')
  .then(r => r.json())
  .then(data => {
    const container = document.getElementById('recordings');
    if (data.recordings && data.recordings.length > 0) {
      container.innerHTML = data.recordings.map(r => \`
        <div class="brand-card" style="margin-bottom:12px">
          <h3>\${r.title}</h3>
          <p>\${new Date(r.date).toLocaleDateString()}</p>
          <button class="btn-secondary btn" onclick="window.open('\${r.url}', '_blank')">Watch Recording</button>
        </div>
      \`).join('');
    } else {
      container.innerHTML = '<div class="empty">No recordings yet.</div>';
    }
  });
</script>

</body>
</html>`);
    
  } catch (error) {
    console.error('Inner Circle dashboard error:', error);
    res.redirect('/inner-circle');
  }
});

// Covenant: creator commits to a brand → Lark alert to Hasan for manual TC invite.
// Mounted here (before app.use(requireAuth)) because creators lack CF Access sessions.
try { require('./routes/inner-circle-covenant')(app, { requireSession: (icSqlite && icSqlite.requireSqliteSession) || requireCreatorSession, requireCreatorSession, axios, express, getLarkTenantToken }); }
catch (e) { console.error('[inner-circle-covenant] route registration failed:', e.message); }

app.post('/api/proposals/publish-public', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'No HTML provided' });
    const id = require('crypto').randomBytes(12).toString('hex');
    const filename = `proposal-${id}.html`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), html, 'utf8');
    const baseUrl = 'https://cult-command-center-production.up.railway.app';
    res.json({ ok: true, url: `${baseUrl}/uploads/${filename}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Fireflies Meeting Intelligence Webhook ────────────────────────────────────
app.post('/api/webhooks/fireflies-meeting', async (req, res) => {
  // Verify HMAC-SHA256 signature (x-hub-signature header, signed over raw body)
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['x-hub-signature'];
    if (!sig) return res.status(401).json({ ok: false, error: 'Missing signature' });
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
    if (sig !== expected) {
      console.log('[meeting-intel] HMAC mismatch. Got:', sig, 'Expected:', expected);
      return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }
  }

  // Ack immediately
  res.json({ ok: true });

  // Async processing
  setImmediate(async () => {
    try {
      const body = req.body || {};
      const { meetingId, title, participants = [], date, summary = {} } = body;

      if (!meetingId) return;

      // Dedupe
      const intel = loadMeetingIntel();
      if (intel.meetings.find(m => m.meetingId === meetingId && m.status !== 'error')) {
        console.log(`[meeting-intel] Duplicate webhook for ${meetingId}, skipping`);
        return;
      }

      // Identify prospect (non-cultcontent.cc participant)
      const prospect = (participants || []).find(e => e && !e.toLowerCase().includes('@cultcontent.cc') && e.toLowerCase() !== 'tommy@cultcontent.cc');

      if (!prospect) {
        console.log(`[meeting-intel] Internal call ${meetingId}, skipping`);
        return;
      }

      // Build summary text
      const overview = summary.overview || '';
      const bullets = (summary.shorthand_bullet || []).join('\n');
      const actionItems = summary.action_items || [];
      const keywords = summary.keywords || [];
      const summaryText = [overview, bullets].filter(Boolean).join('\n\n');

      // Call Claude for classification
      const STAGE_IDS = {
        'Lead': '93bc4029-7dbd-4598-8862-cb7ac7784016',
        'Discovery Call': '4c3cdb15-21e6-4c16-a892-8b419c0a45d9',
        'Proposal Sent': '7e6bf560-11d6-442a-b64f-3bf12f136d5a',
        'Contract Signed': '246fa975-94b0-423a-8529-b07601609291',
        'Active': 'addcb241-593d-4242-b7d5-afeff44cd0a2',
        'Long Term Nurture': '47cb6c40-df0c-4ac9-b717-ca2bdec2536c',
        'Disqualified': 'c38e9d11-a1ce-4aa5-9ce9-fef3bab9babd',
      };

      let analysis = null;
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: `You are a sales intelligence assistant for Cult Content, a TikTok Shop affiliate marketing agency. Analyze meeting summaries and classify prospects for the Growth Partner Pipeline.

Pipeline stages (use ONLY these exact IDs):
- Lead: 93bc4029-7dbd-4598-8862-cb7ac7784016
- Discovery Call: 4c3cdb15-21e6-4c16-a892-8b419c0a45d9
- Proposal Sent: 7e6bf560-11d6-442a-b64f-3bf12f136d5a
- Contract Signed: 246fa975-94b0-423a-8529-b07601609291
- Active: addcb241-593d-4242-b7d5-afeff44cd0a2
- Long Term Nurture: 47cb6c40-df0c-4ac9-b717-ca2bdec2536c
- Disqualified: c38e9d11-a1ce-4aa5-9ce9-fef3bab9babd

Stage rules: Lead=first contact no real call yet; Discovery Call=had structured exploratory call; Proposal Sent=pricing/proposal discussed or Tommy committed to sending one; Contract Signed=deal agreed; Active=paying client; Long Term Nurture=interested but not ready 60+ days; Disqualified=clearly wrong fit.

Tags to choose from (pick 2-5 relevant): tiktok-shop, beauty, fashion, food-beverage, supplements, home-goods, electronics, apparel, pet-products, health-wellness, high-aov, low-aov, needs-samples, creator-ready, not-registered, shopify, strong-fit, weak-fit, follow-up-needed, budget-confirmed, price-sensitive, warm-lead, hot-lead, cold-lead

Output ONLY valid JSON, no markdown.`,
          messages: [{
            role: 'user',
            content: `Meeting title: ${title || 'Untitled'}
Date: ${date ? new Date(date).toLocaleDateString() : 'Unknown'}
Prospect email: ${prospect}
All participants: ${(participants || []).join(', ')}
Keywords: ${keywords.join(', ') || 'none'}
Action items: ${actionItems.join(', ') || 'none'}

Summary:
${summaryText || 'No summary available'}

Return JSON: {"companyName":"...","prospectEmail":"...","prospectName":"...","suggestedStageId":"...","suggestedStageName":"...","stageReasoning":"...","tags":[...],"actionItems":[...],"meetingSummary":"...","confidence":"high|medium|low","doNotAutoApply":false}`
          }]
        });
        const text = msg.content[0]?.text || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (match) analysis = JSON.parse(match[0]);
      } catch(e) {
        console.error('[meeting-intel] AI error:', e.message);
      }

      // GHL contact lookup
      let ghlContactId = null, ghlOppId = null, currentStageId = null;
      try {
        const r = await ghl.get('/contacts/', { params: { locationId: CFG.locationId, query: prospect, limit: 5 } });
        const contacts = r.data?.contacts || [];
        const match = contacts.find(c => c.email?.toLowerCase() === prospect.toLowerCase());
        if (match) {
          ghlContactId = match.id;
          // Look for opportunity in GP pipeline
          const oppR = await ghl.get('/opportunities/search', { params: { location_id: CFG.locationId, pipeline_id: 'W5PxjulbNVh52Gqlkmzm', contact_id: match.id, limit: 1 } });
          const opp = (oppR.data?.opportunities || [])[0];
          if (opp) { ghlOppId = opp.id; currentStageId = opp.pipelineStageId; }
        }
      } catch(e) {
        console.error('[meeting-intel] GHL lookup error:', e.message);
      }

      // Save record
      const record = {
        id: `intel_${Date.now()}`,
        meetingId,
        receivedAt: new Date().toISOString(),
        title: title || 'Untitled Meeting',
        date,
        participants,
        prospectEmail: prospect,
        analysis: analysis || { companyName: 'Unknown', prospectEmail: prospect, suggestedStageName: 'Unknown', tags: [], actionItems: [], meetingSummary: '', confidence: 'low', doNotAutoApply: true },
        ghlContactId,
        ghlOppId,
        currentStageId,
        status: (analysis && !analysis.doNotAutoApply) ? 'pending' : 'skipped',
        appliedAt: null,
        error: analysis ? null : 'AI classification failed',
      };

      while (_intelWriteLock) await new Promise(r => setTimeout(r, 100));
      _intelWriteLock = true;
      try {
        const fresh = loadMeetingIntel();
        fresh.meetings.unshift(record);
        fresh.meetings = fresh.meetings.slice(0, 100);
        saveMeetingIntel(fresh);
      } finally { _intelWriteLock = false; }

      console.log(`[meeting-intel] Processed: ${analysis?.companyName || prospect} → ${analysis?.suggestedStageName || 'unknown'}`);
    } catch(e) {
      console.error('[meeting-intel] Processing error:', e.message);
    }
  });
});

// ─── Lark OAuth — user token for Minutes access ───────────────────────────────
// Step 1: redirect user to Lark to authorise
app.get('/api/lark/oauth/start', requireAuth, (req, res) => {
  const appId       = process.env.LARK_APP_ID;
  const redirectUri = encodeURIComponent(`${process.env.PUBLIC_BASE_URL || 'https://cult-command-center-production.up.railway.app'}/api/lark/oauth/callback`);
  const scope       = encodeURIComponent('minutes:minutes.transcript:export minutes:minutes:readonly minutes:minutes.basic:read');
  res.redirect(`https://open.larksuite.com/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}&state=meeting-intel`);
});

// Step 2: Lark redirects back here with a code
app.get('/api/lark/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Lark denied access: ${error}</h2>`);
  if (!code) return res.send('<h2>Error: no code returned from Lark</h2>');
  try {
    // Get app_access_token first (needed as Bearer for OIDC token exchange)
    const appTokenResp = await axios.post('https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal', {
      app_id:     process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    });
    const appToken = appTokenResp.data?.app_access_token;
    console.log('[lark-oauth] app_access_token obtained:', !!appToken);

    // Exchange code for user access token
    const r = await axios.post(
      'https://open.larksuite.com/open-apis/authen/v1/oidc/access_token',
      { grant_type: 'authorization_code', code },
      { headers: { Authorization: `Bearer ${appToken}`, 'Content-Type': 'application/json' } }
    );
    console.log('[lark-oauth] token exchange response:', JSON.stringify(r.data).slice(0, 300));

    if (r.data?.code !== 0) {
      return res.send(`<h2>Lark OAuth error (${r.data?.code}): ${r.data?.msg}</h2><pre>${JSON.stringify(r.data, null, 2)}</pre>`);
    }
    const d = r.data.data;
    fs.writeFileSync(LARK_USER_TOKEN_FILE, JSON.stringify({
      access_token:  d.access_token,
      refresh_token: d.refresh_token,
      expires_at:    Date.now() + (d.expires_in * 1000),
    }));
    console.log('[lark-oauth] user token saved successfully');
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d0d0d;color:#fff">
      <div style="font-size:40px;margin-bottom:16px">✅</div>
      <h2>Lark connected!</h2>
      <p style="color:#aaa">You can close this tab and go back to the dashboard.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
  } catch(e) {
    console.error('[lark-oauth] callback error:', e.message, e.response?.data);
    res.send(`<h2>Error: ${e.message}</h2><pre>${JSON.stringify(e.response?.data, null, 2)}</pre>`);
  }
});

// GET /api/lark/oauth/status — check if user token is stored
app.get('/api/lark/oauth/status', requireAuth, async (req, res) => {
  const token = await getLarkUserToken();
  res.json({ ok: true, connected: !!token });
});

// ─── Lark Meeting Webhook (vc.meeting.ended) ─────────────────────────────────
// Registered BEFORE requireAuth — Lark calls this directly with no CF session.
// Verification: Lark sends X-Lark-Signature header (HMAC-SHA256 of timestamp+nonce+body).
// Set LARK_VERIFICATION_TOKEN in Railway env.
app.post('/api/webhooks/lark-meeting', async (req, res) => {
  const body = req.body || {};

  // Step 1: Lark URL verification challenge (sent once when you register the webhook URL)
  if (body.type === 'url_verification' || body.challenge) {
    return res.json({ challenge: body.challenge });
  }

  // Step 2: Verify token (simple token check — Lark sends this in every event)
  const verifyToken = process.env.LARK_VERIFICATION_TOKEN;
  if (verifyToken && body.header?.token && body.header.token !== verifyToken) {
    console.warn('[lark-webhook] token mismatch');
    return res.status(401).json({ ok: false });
  }

  // Ack immediately
  res.json({ ok: true });

  const eventType = body.header?.event_type || body.event_type;
  const isMeetingEnded = eventType === 'vc.meeting.ended'           // legacy
    || eventType === 'vc.meeting.meeting_ended_v1'                  // v2.0
    || eventType === 'vc.meeting.all_meeting_ended_v1';             // v2.0 all
  console.log(`[lark-webhook] received event: ${eventType}`);
  if (!isMeetingEnded) return;

  setImmediate(async () => {
    try {
      const event = body.event || {};
      const minuteToken = event.minute_token || event.minuteToken;
      const meetingNo   = event.meeting_no || event.meetingNo || '';
      const topic       = event.topic || '';
      const startTime   = event.meeting_start_time ? new Date(Number(event.meeting_start_time) * 1000) : new Date();
      const endTime     = event.meeting_end_time   ? new Date(Number(event.meeting_end_time)   * 1000) : new Date();
      const durationMin = Math.round((endTime - startTime) / 60000);

      // Build participant list
      const participants = (event.participants || []).map(p => p.name || p.user_name).filter(Boolean);

      let transcript = null;
      if (minuteToken) {
        transcript = await fetchLarkMinutesTranscript(minuteToken);
      }

      if (!transcript && !topic) {
        console.log('[lark-webhook] No transcript or topic, skipping');
        return;
      }

      const notes = transcript || `Meeting: ${topic}\nDuration: ${durationMin} minutes\nParticipants: ${participants.join(', ')}`;
      const dateStr = startTime.toISOString().split('T')[0];

      // Use same AI analysis as manual add
      const data = loadClientMeetings();
      let actionItems = [], themes = [], summary = '', keyProblems = [];

      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
          const msg = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            messages: [{
              role: 'user',
              content: `Analyze this meeting transcript from Cult Content agency (TikTok Shop content/affiliate agency).

Client tagging rules — for BOTH the top-level "client" field and each action item's "client" field:
- Known brand clients (use EXACTLY these names when applicable): ${(loadBrands().clients||[]).map(c=>c.name||c.id).filter(Boolean).join(', ') || 'none yet'}
- If a task/topic involves a known brand → use that brand name exactly
- If a task involves an external person who is NOT a Cult Content employee (e.g. a growth partner, consultant, or individual client) → use their first name as the client tag
- Use "Internal" ONLY for tasks that are purely internal Cult Content operations with no specific external person or brand involved

Meeting details:
- Date: ${dateStr}
- Topic: ${topic || 'Team Meeting'}
- Participants: ${participants.join(', ') || 'unknown'}
- Duration: ${durationMin} min

Transcript/notes:
${notes}

Return ONLY valid JSON:
{"client":"brand name, person first name, or empty string","summary":"","actionItems":[{"task":"","assignee":"","client":"brand name, person first name, or Internal","priority":"high|medium|low","done":false}],"themes":[],"keyProblems":[]}

Return only the JSON, no explanation.`
            }]
          });
          const parsed = JSON.parse(msg.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
          actionItems  = parsed.actionItems  || [];
          themes       = parsed.themes       || [];
          summary      = parsed.summary      || '';
          keyProblems  = parsed.keyProblems  || [];
          // Use AI-detected client if none in event
          var aiClient = parsed.client || '';
        } catch(aiErr) {
          console.error('[lark-webhook] AI error:', aiErr.message);
        }
      }

      const meeting = {
        id:           `lark_${meetingNo || Date.now()}`,
        date:         dateStr,
        client:       aiClient || '',
        title:        topic || 'Lark Meeting',
        participants,
        duration:     durationMin,
        notes,
        summary,
        actionItems,
        themes,
        keyProblems,
        source:       'lark-auto',
        minuteToken:  minuteToken || null,
        createdAt:    new Date().toISOString()
      };

      // Deduplicate by meeting number
      const existing = data.meetings.findIndex(m => m.id === meeting.id);
      if (existing >= 0) {
        console.log(`[lark-webhook] duplicate meeting ${meeting.id}, skipping`);
        return;
      }

      data.meetings.unshift(meeting);
      saveClientMeetings(data);
      console.log(`[lark-webhook] Auto-added meeting: ${meeting.title} (${dateStr})`);
    } catch(e) {
      console.error('[lark-webhook] Processing error:', e.message);
    }
  });
});

// ─── Lark Minutes manual sync — pull recent Minutes docs ─────────────────────
// POST /api/admin/lark-minutes-import  — import a single Lark Minutes by URL or token
// e.g. https://meetings.lark.com/minutes/obcnxxx  or just the token obcnxxx
app.post('/api/admin/lark-minutes-import', requireAuth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });

    // Extract token from URL like https://meetings.lark.com/minutes/obcnxxxxxx
    // or https://bytedance.larkoffice.com/minutes/obcnxxxxxx
    const tokenMatch = url.match(/\/minutes\/([a-z0-9]+)/i) || url.match(/^([a-z0-9]+)$/i);
    if (!tokenMatch) return res.status(400).json({ ok: false, error: 'Could not extract minute token from URL' });
    const minuteToken = tokenMatch[1];
    console.log(`[lark-import] extracted token: ${minuteToken} from url: ${url}`);

    const data = loadClientMeetings();
    if (data.meetings.find(m => m.minuteToken === minuteToken)) {
      return res.json({ ok: true, alreadyExists: true });
    }

    const transcript = await fetchLarkMinutesTranscript(minuteToken);
    if (!transcript) return res.status(400).json({ ok: false, error: 'Could not fetch transcript — check the app has minutes:minute:readonly permission and the meeting has a transcript' });

    const meta = await fetchLarkMinutesMeta(minuteToken);
    const dateStr  = meta?.start_time ? new Date(meta.start_time * 1000).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const duration = meta?.duration   ? Math.round(meta.duration / 60) : null;
    const title    = meta?.title      || 'Lark Meeting';
    const participants = (meta?.participants || []).map(p => p.name).filter(Boolean);

    const _brandsLark = loadBrands();
    const knownClients = (_brandsLark.clients || []).map(c => c.name || c.id).filter(Boolean);
    const contactMap = buildContactMap(_brandsLark);
    let actionItems = [], themes = [], summary = '', keyProblems = [], aiClient = '';
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 2000,
          messages: [{
            role: 'user',
            content: `Analyze this Lark meeting transcript from Cult Content (a TikTok Shop content/affiliate agency).

${buildClientTaggingPrompt(_brandsLark)}

For the top-level "client": use the primary brand this meeting is about. For group calls with multiple clients, use the most prominent one.

Return JSON only:
{"client":"brand name or Internal","summary":"","actionItems":[{"task":"","assignee":"","client":"brand name or Internal","priority":"high|medium|low","done":false}],"themes":[],"keyProblems":[]}

Transcript:
${transcript.slice(0, 8000)}`
          }]
        });
        const parsed = JSON.parse(msg.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
        actionItems = (parsed.actionItems || []).map(ai => ({
          ...ai,
          client: normaliseClientName(ai.client, knownClients, contactMap) || ai.client || 'Internal',
        }));
        themes      = parsed.themes      || [];
        summary     = parsed.summary     || '';
        keyProblems = parsed.keyProblems || [];
        aiClient    = normaliseClientName(parsed.client, knownClients, contactMap) || parsed.client || '';
      } catch(aiErr) {
        console.error('[lark-import] AI error:', aiErr.message);
      }
    }

    const meeting = {
      id: `lark_${minuteToken}`,
      date: dateStr, client: aiClient, title, participants, duration,
      notes: transcript, summary, actionItems, themes, keyProblems,
      source: 'lark-import', minuteToken,
      createdAt: new Date().toISOString()
    };
    data.meetings.unshift(meeting);
    saveClientMeetings(data);
    console.log(`[lark-import] imported: ${title} (${dateStr})`);
    res.json({ ok: true, meeting });
  } catch(e) {
    console.error('[lark-import]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Direct upload endpoint (bypasses Cloudflare) ────────────────────────────
// This route is registered BEFORE requireAuth so the browser can POST large files
// straight to the Railway origin URL — Cloudflare only allows ~100 MB through the
// proxy tunnel, so files > 90 MB must skip it entirely.
// Auth is a bearer token (WEBHOOK_SECRET) that the dashboard fetches from /api/upload-config
// after the normal CF-Access session is already established.

// ── HEVC → H.264 auto-conversion ────────────���────────────────────────────────
// iPhones record in HEVC (H.265) by default. Instagram and TikTok reject it via
// Buffer. On upload we detect HEVC and silently re-encode to H.264/AAC MP4 so
// every downstream platform gets a compatible file without manual intervention.
function ensureH264(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return resolve(filePath); // can't probe → leave as-is
      const videoStream = (meta.streams || []).find(s => s.codec_type === 'video');
      const codec = (videoStream && videoStream.codec_name) || '';
      if (!['hevc', 'h265', 'hvc1'].includes(codec.toLowerCase())) {
        return resolve(filePath); // already H.264 or unknown — skip
      }
      // Re-encode to H.264 MP4
      const outPath = filePath.replace(/\.[^.]+$/, '') + '_h264.mp4';
      ffmpeg(filePath)
        .videoCodec('libx264')
        .addOptions(['-preset fast', '-crf 23', '-maxrate 3500k', '-bufsize 7000k',
                     '-profile:v high', '-level 4.0', '-pix_fmt yuv420p',
                     '-movflags +faststart'])
        .audioCodec('aac')
        .audioBitrate('128k')
        .audioFrequency(44100)
        .on('error', reject)
        .on('end', () => {
          // Swap files: remove original, rename converted to same name as original
          fs.unlinkSync(filePath);
          fs.renameSync(outPath, filePath);
          resolve(filePath);
        })
        .save(outPath);
    });
  });
}
// ──────────────────────────────────────────────────────────────────���──────────

const uploadDirect = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename:    (_, file, cb) => {
      const ext  = path.extname(file.originalname) || '.mp4';
      const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
      cb(null, `${Date.now()}_${base}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (_, file, cb) => {
    const ok = /video|mp4|mov|avi|webm/i.test(file.mimetype + file.originalname)
            || file.mimetype === 'application/octet-stream';
    cb(null, ok);
  },
});

app.options('/api/upload/video-direct', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  'https://manifest.cultcontent.cc');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.sendStatus(204);
});

app.post('/api/upload/video-direct', uploadDirect.single('video'), async (req, res) => {
  // Allow cross-origin POSTs from the CF-proxied dashboard origin
  res.setHeader('Access-Control-Allow-Origin',  'https://manifest.cultcontent.cc');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  // Bearer-token auth — generated once at startup from WEBHOOK_SECRET
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!req.file) return res.status(400).json({ error: 'No file received — check MIME type or file size limit' });

  // Auto-convert HEVC (iPhone default) → H.264 so Instagram/TikTok accept it
  try { await ensureH264(req.file.path); } catch (e) { console.warn('ensureH264 failed:', e.message); }

  const localUrl = `/uploads/${req.file.filename}`;
  const publicUrl = `${PUBLIC_BASE_URL}${localUrl}`;

  const meta = {
    id:           req.file.filename,
    originalName: req.file.originalname,
    filename:     req.file.filename,
    size:         req.file.size,
    title:        req.body.title || path.basename(req.file.originalname, path.extname(req.file.originalname)),
    description:  req.body.description || '',
    platforms:    req.body.platforms ? req.body.platforms.split(',').map(s => s.trim()) : [],
    status:       'staged',
    uploadedAt:   new Date().toISOString(),
    path:         req.file.path,
    localUrl,
  };

  const q = loadQueue();
  q.unshift(meta);
  saveQueue(q);

  res.json({ ok: true, url: publicUrl, video: meta });
});

// ─── Admin: volume disk audit (pre-auth, bearer-token protected) ──────────────
// Registered before requireAuth so it's reachable without a CF Access session.
app.get('/api/admin/disk-raw', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (token !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const queue = (() => { try { return fs.existsSync(path.join(DATA_DIR,'upload-queue.json')) ? JSON.parse(fs.readFileSync(path.join(DATA_DIR,'upload-queue.json'),'utf8')) : []; } catch(_){ return []; } })();
    const queueMap = Object.fromEntries(queue.map(v => [v.filename, v.status]));
    function scanDir(dir, base='') {
      const entries = [];
      if (!fs.existsSync(dir)) return entries;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel  = base ? `${base}/${name}` : name;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) { entries.push(...scanDir(full, rel)); }
        else { entries.push({ path: rel, size: stat.size, sizeMB: +(stat.size/1024/1024).toFixed(2), mtime: stat.mtime.toISOString(), status: queueMap[name] || null }); }
      }
      return entries;
    }
    const files = scanDir(DATA_DIR).sort((a,b) => b.size - a.size);
    const totalMB = +(files.reduce((s,f) => s+f.size, 0)/1024/1024).toFixed(1);
    res.json({ totalMB, fileCount: files.length, files });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/uploads-purge — deletes specific files from UPLOAD_DIR
// Protected by bearer token. Only deletes from uploads/, never touches other DATA_DIR files.
app.delete('/api/admin/uploads-purge', express.json(), (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (token !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }
  const { filenames } = req.body || {};
  if (!Array.isArray(filenames)) return res.status(400).json({ error: 'filenames array required' });
  const results = [];
  for (const name of filenames) {
    if (/[/\\]/.test(name)) { results.push({ name, ok: false, error: 'invalid name' }); continue; }
    const full = path.join(UPLOAD_DIR, name);
    if (!full.startsWith(UPLOAD_DIR)) { results.push({ name, ok: false, error: 'path escape' }); continue; }
    try {
      if (fs.existsSync(full)) { fs.unlinkSync(full); results.push({ name, ok: true }); }
      else { results.push({ name, ok: false, error: 'not found' }); }
    } catch(e) { results.push({ name, ok: false, error: e.message }); }
  }
  // Also remove deleted files from the queue
  try {
    const deletedSet = new Set(filenames);
    const q = loadQueue().filter(v => !deletedSet.has(v.filename));
    saveQueue(q);
  } catch(_) {}
  res.json({ ok: true, results });
});

// ─── Chunked upload endpoints (pre-auth, bearer-token protected) ─────────────
// Large files (>90 MB) hit Railway's own 100 MB proxy limit just like Cloudflare.
// Solution: split into 20 MB chunks in the browser and reassemble here.
//
// Flow:
//   POST /api/upload/chunk  { uploadId, chunkIndex, totalChunks, filename }  + binary body
//   → when all chunks received, assembles into UPLOAD_DIR and returns { ok, url }

const CHUNKS_DIR = path.join(DATA_DIR, 'chunks');
if (!fs.existsSync(CHUNKS_DIR)) fs.mkdirSync(CHUNKS_DIR, { recursive: true });

function chunkAuth(req, res) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (token !== secret) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// CORS preflight
app.options('/api/upload/chunk', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  'https://manifest.cultcontent.cc');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Upload-Id, X-Chunk-Index, X-Total-Chunks, X-Filename, X-File-Size');
  res.sendStatus(204);
});

app.post('/api/upload/chunk', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  'https://manifest.cultcontent.cc');
  if (!chunkAuth(req, res)) return;

  const uploadId   = req.headers['x-upload-id'];
  const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
  const totalChunks= parseInt(req.headers['x-total-chunks'], 10);
  const origName   = req.headers['x-filename'] || 'video.mp4';
  const fileSize   = parseInt(req.headers['x-file-size'] || '0', 10);

  if (!uploadId || isNaN(chunkIndex) || isNaN(totalChunks)) {
    return res.status(400).json({ error: 'Missing chunk headers' });
  }

  const sessionDir = path.join(CHUNKS_DIR, uploadId.replace(/[^a-z0-9_-]/gi, '_'));
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const chunkPath = path.join(sessionDir, `chunk_${String(chunkIndex).padStart(5, '0')}`);

  // Buffer raw body (chunks are binary, not multipart)
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => {
    try {
      fs.writeFileSync(chunkPath, Buffer.concat(chunks));

      // Check if all chunks have arrived
      const received = fs.readdirSync(sessionDir).filter(f => f.startsWith('chunk_')).length;
      if (received < totalChunks) {
        return res.json({ ok: true, received, totalChunks, done: false });
      }

      // All chunks here — assemble
      const ext  = path.extname(origName) || '.mp4';
      const base = path.basename(origName, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
      const filename = `${Date.now()}_${base}${ext}`;
      const finalPath = path.join(UPLOAD_DIR, filename);

      const writeStream = fs.createWriteStream(finalPath);
      const chunkFiles  = fs.readdirSync(sessionDir).filter(f => f.startsWith('chunk_')).sort();

      let idx = 0;
      function writeNext() {
        if (idx >= chunkFiles.length) {
          writeStream.end();
          return;
        }
        const buf = fs.readFileSync(path.join(sessionDir, chunkFiles[idx++]));
        writeStream.write(buf, writeNext);
      }
      writeNext();

      writeStream.on('finish', () => {
        // Clean up chunk dir
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(_) {}

        const localUrl  = `/uploads/${filename}`;
        const publicUrl = `${PUBLIC_BASE_URL}${localUrl}`;

        const meta = {
          id:           filename,
          originalName: origName,
          filename,
          size:         fileSize || fs.statSync(finalPath).size,
          title:        path.basename(origName, ext),
          description:  '',
          platforms:    [],
          status:       'staged',
          uploadedAt:   new Date().toISOString(),
          path:         finalPath,
          localUrl,
        };

        const q = loadQueue();
        q.unshift(meta);
        saveQueue(q);

        res.json({ ok: true, done: true, url: publicUrl, video: meta });
      });

      writeStream.on('error', e => res.status(500).json({ error: e.message }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  req.on('error', e => res.status(500).json({ error: e.message }));
});

// ─── Client Portal ──���─────────────────────────────────────────────────────────
// ��─ Client portal bug reporter ────────────────────────────────────────────────
async function sendClientBugReport({ brandName, brandId, route, error, type = 'server', extra = '' }) {
  try {
    const emoji = type === 'client' ? '🖥️' : '🔴';
    const text = `${emoji} *Client Portal Error* — ${brandName || brandId || 'Unknown Brand'}\n` +
      `Route: \`${route || 'unknown'}\`\n` +
      `Error: ${String(error).slice(0, 300)}` +
      (extra ? `\n${extra}` : '');
    await axios.post(`${CFG.railwayUrl}/command`,
      { text, context: 'Client Portal Bug', source: 'Client Portal' },
      { timeout: 5000 }
    );
  } catch (_) {}
}

// Session-gated routes registered BEFORE CF Access requireAuth.
// Clients are brands in brands.json with loginEmail + passwordHash set.

function loadTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); }
  catch(_) { return []; }
}

const clientLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // raised from 10 — auto-retry polling uses ~18 requests during onboarding
  message: { error: 'Too many login attempts — try again in 15 minutes.' },
});

function requireClientSession(req, res, next) {
  if (!req.session?.clientBrandId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    // Portal admin trying to reach /client pages without impersonating
    if (req.session?.isPortalAdmin) return res.redirect('/portal-admin/clients');
    return res.redirect('/client');
  }
  next();
}

// GET /client — login page
app.get('/client', (req, res) => {
  if (req.session?.clientBrandId) return res.redirect('/client/dashboard');
  res.sendFile(path.join(__dirname, 'dashboard', 'client-login.html'));
});
app.get('/client/login', (req, res) => {
  if (req.session?.clientBrandId) return res.redirect('/client/dashboard');
  res.sendFile(path.join(__dirname, 'dashboard', 'client-login.html'));
});

// GET /client/dashboard — session-gated dashboard
app.get('/client/dashboard', requireClientSession, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'client-dashboard.html'));
});

// POST /client/login
app.post('/client/login', clientLoginLimiter, express.json(), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });
    const brands = loadBrands();
    const normalised = email.toLowerCase().trim();
    const brand = (brands.clients || []).find(
      b => (b.loginEmail || b.email || '').toLowerCase() === normalised
    );
    if (!brand) return res.status(401).json({ error: 'No account found for that email.' });
    // No password yet — prompt client to create one
    if (!brand.passwordHash) return res.json({ ok: false, needsSetup: true });
    if (!password) return res.status(400).json({ error: 'Password required' });
    const ok = await bcrypt.compare(password, brand.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Incorrect password.' });
    req.session.clientBrandId = brand.id;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /client/set-password — first-time password setup (no existing password on account)
app.post('/client/set-password', clientLoginLimiter, express.json(), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const brands = loadBrands();
    const normalised2 = email.toLowerCase().trim();
    const idx = (brands.clients || []).findIndex(
      b => (b.loginEmail || b.email || '').toLowerCase() === normalised2
    );
    if (idx === -1) return res.status(404).json({ error: 'Your account is being set up — usually takes under a minute. Please try again shortly.' });
    if (brands.clients[idx].passwordHash) return res.status(400).json({ error: 'Password already set. Use your existing password to log in.' });
    brands.clients[idx].passwordHash = await bcrypt.hash(password, 12);
    saveBrands(brands);
    req.session.clientBrandId = brands.clients[idx].id;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /client/logout
app.post('/client/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── Portal Admin ──────────────────────────────────────────────────────────────
// Password stored in env PORTAL_ADMIN_PASSWORD. No CF Access needed.

function requirePortalAdmin(req, res, next) {
  if (!req.session?.isPortalAdmin) {
    if (req.path.startsWith('/api/') || req.path.startsWith('/portal-admin/clients') || req.path.startsWith('/portal-admin/impersonate') || req.path.startsWith('/portal-admin/open-collab')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/portal-admin');
  }
  next();
}

// GET /portal-admin — login page
app.get('/portal-admin', (req, res) => {
  if (req.session?.isPortalAdmin) return res.redirect('/portal-admin/clients');
  res.sendFile(path.join(__dirname, 'dashboard', 'portal-admin-login.html'));
});

// POST /portal-admin/login
app.post('/portal-admin/login', express.json(), (req, res) => {
  const adminPw = process.env.PORTAL_ADMIN_PASSWORD;
  if (!adminPw) return res.status(500).json({ error: 'Admin password not configured.' });
  if (!req.body?.password || req.body.password !== adminPw) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  req.session.isPortalAdmin = true;
  res.json({ ok: true });
});

try { require('./routes/portal-team-auth')(app, { express }); } catch (e) { console.error('[portal-team-auth] registration failed:', e.message); }

// GET /portal-admin/clients — returns client list as JSON (admin only)
app.get('/portal-admin/clients', requirePortalAdmin, async (req, res) => {
  // If Accept is text/html, serve the admin page
  if (req.headers.accept?.includes('text/html')) {
    return res.sendFile(path.join(__dirname, 'dashboard', 'portal-admin.html'));
  }
  try {
  const brands = loadBrands();

  // Billing window: ?month=YYYY-MM (a full closed month) or omitted => current month (MTD).
  const win = monthWindow(req.query.month);

  const gmvResults = await Promise.allSettled(
    (brands.clients || []).map((b, i) => fetchNetProductSalesForWindow(b, brands, i, win))
  );

  // Build the month picker options: from the earliest brand onboarding (floored),
  // capped at the last 12 months, newest first, always including the current month.
  const availableMonths = (() => {
    const nowD = new Date();
    let earliest = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), 1));
    for (const b of (brands.clients || [])) {
      const t = b.onboardedAt ? new Date(b.onboardedAt) : null;
      if (t && !isNaN(t) && t < earliest) earliest = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
    }
    const twelveAgo = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - 11, 1));
    if (earliest < twelveAgo) earliest = twelveAgo;
    const out = [];
    let cur = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), 1));
    while (cur >= earliest) {
      const w = monthWindow(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`);
      out.push({ key: w.key, label: w.label });
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - 1, 1));
    }
    return out;
  })();

  const clients = (brands.clients || []).map((b, i) => {
    const liveGmv  = gmvResults[i]?.status === 'fulfilled' ? gmvResults[i].value : null;
    const commRate = b.commissionRate ?? 0.10;
    // Never show the stale relay cache for billing. Retainer-only brands (commRate 0) show 0.
    const gmv      = commRate === 0 ? 0 : (liveGmv ?? 0);
    return {
      id:               b.id,
      name:             b.name,
      email:            b.loginEmail || '',
      hasPassword:      !!b.passwordHash,
      tiktokConnected:  !!(b.tiktokShopToken?.access_token),
      hasShopCipher:    !!(b.tiktokShopToken?.shop_cipher),
      bufferConnected:  !!b.bufferConnected,
      arcadsConnected:  !!b.arcadsConnected,
      storistaConnected: !!b.storistaConnected,
      onboardedAt:      b.onboardedAt || null,
      gmv,
      commissionRate:   commRate,
      revShare:         parseFloat((gmv * commRate).toFixed(2)),
      cachedGmvAt:      b.cachedGmvAt || null,
      creatorPageSlug:  b.creatorPage?.slug || null,
      campaigns:        b.creatorPage?.campaigns || null,
    };
  });
  res.json({ ok: true, clients, window: { key: win.key, label: win.label, isCurrent: win.isCurrent }, availableMonths });
  } catch (err) {
    console.error('[portal-admin/clients] failed:', err && err.message);
    try {
      const brands = loadBrands();
      const clients = (brands.clients || []).map((b) => {
        const commRate = b.commissionRate ?? 0.10;
        const gmv = 0; // error fallback: never show a stale billing figure
        void b.cachedNetGmv;
        return {
          id: b.id, name: b.name, email: b.loginEmail || '',
          hasPassword: !!b.passwordHash,
          tiktokConnected: !!(b.tiktokShopToken?.access_token),
          hasShopCipher: !!(b.tiktokShopToken?.shop_cipher),
          bufferConnected: !!b.bufferConnected,
          arcadsConnected: !!b.arcadsConnected,
          storistaConnected: !!b.storistaConnected,
          onboardedAt: b.onboardedAt || null,
          gmv, commissionRate: commRate,
          revShare: parseFloat((gmv * commRate).toFixed(2)),
          cachedGmvAt: b.cachedGmvAt || null,
        };
      });
      return res.json({ ok: true, clients, degraded: true });
    } catch (err2) {
      return res.status(500).json({ ok: false, error: 'Failed to load clients: ' + (err2 && err2.message) });
    }
  }
});

// POST /portal-admin/impersonate — sets session as a client brand
app.post('/portal-admin/impersonate', requirePortalAdmin, express.json(), (req, res) => {
  const { brandId } = req.body || {};
  if (!brandId) return res.status(400).json({ error: 'brandId required' });
  const brands = loadBrands();
  const brand = (brands.clients || []).find(b => b.id === brandId);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  req.session.clientBrandId       = brand.id;
  req.session.isPortalAdmin       = true; // keep admin flag
  req.session.adminImpersonating  = brand.name;
  res.json({ ok: true });
});

// PATCH /portal-admin/open-collab/:brandId — toggle the open-collab onboarding flag for a brand.
// Accepts brandId OR creatorPage.slug for lookup. Body: { openCollabEnabled: boolean }.
// NOTE: open-collab status CANNOT currently be read or enabled via API. The Reacher relay
// returns 404 for open-collab state, and there is no per-shop TikTok token available
// (TIKTOK_SHOP_TOKENS is unconfigured), so the TikTok Shop Open API cannot be signed per-shop.
// This flag is therefore a MANUAL onboarding gate: an operator flips open collab ON in the
// TikTok seller center, then sets this flag true here. Autonomous read/enable of open-collab
// status is DEFERRED to a future TikTok-token task. We mutate ONLY brand.openCollabEnabled and
// write back via the same saveBrands() helper — no other fields are touched.
app.patch("/portal-admin/open-collab/:brandId", requirePortalAdmin, express.json(), (req, res) => {
  const brands = loadBrands();
  const key = req.params.brandId;
  const idx = (brands.clients || []).findIndex(b => b.id === key || b.creatorPage?.slug === key);
  if (idx === -1) return res.status(404).json({ error: "Brand not found" });

  // Strict boolean validation — reject anything that is not a real boolean.
  const v = req.body?.openCollabEnabled;
  if (typeof v !== "boolean") {
    return res.status(400).json({ error: "openCollabEnabled must be a boolean" });
  }

  // Mutate ONLY this field; do not rebuild or touch the rest of the brand record.
  brands.clients[idx].openCollabEnabled = v;
  saveBrands(brands);
  res.json({ ok: true, brandId: brands.clients[idx].id, openCollabEnabled: v });
});

// POST /portal-admin/exit — stop impersonating, back to admin client list
app.post('/portal-admin/exit', (req, res) => {
  const wasAdmin = req.session?.isPortalAdmin;
  req.session.clientBrandId      = undefined;
  req.session.adminImpersonating = undefined;
  if (wasAdmin) req.session.isPortalAdmin = true;
  res.json({ ok: true });
});

// POST /portal-admin/set-email — set loginEmail for a client (no CF Access needed)
app.post('/portal-admin/set-email', requirePortalAdmin, express.json(), (req, res) => {
  const { brandId, email } = req.body || {};
  if (!brandId || !email) return res.status(400).json({ error: 'brandId and email required' });
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  brands.clients[idx].loginEmail = email.toLowerCase().trim();
  saveBrands(brands);
  res.json({ ok: true, name: brands.clients[idx].name, loginEmail: brands.clients[idx].loginEmail });
});

// POST /portal-admin/clear-tiktok/:brandId — wipe broken TikTok token so brand can reconnect
app.post('/portal-admin/clear-tiktok/:brandId', requirePortalAdmin, (req, res) => {
  const brands   = loadBrands();
  const brandIdx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });
  const name = brands.clients[brandIdx].name;
  delete brands.clients[brandIdx].tiktokShopToken;
  brands.clients[brandIdx].tiktokConnected = false;
  saveBrands(brands);
  res.json({ ok: true, name, message: `TikTok token cleared for ${name}. Brand must reconnect from their dashboard.` });
});

// POST /portal-admin/clear-password — reset a client password so they can set a new one
app.post('/portal-admin/clear-password', requirePortalAdmin, express.json(), (req, res) => {
  const { brandId } = req.body || {};
  if (!brandId) return res.status(400).json({ error: 'brandId required' });
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  delete brands.clients[idx].passwordHash;
  saveBrands(brands);
  res.json({ ok: true, name: brands.clients[idx].name });
});

// POST /portal-admin/logout
app.post('/portal-admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/portal-admin'));
});

// GET /portal-admin/shop-metrics/:brandId — WoW shop metrics proxy (portal admin session auth)
app.get('/portal-admin/shop-metrics/:brandId', requirePortalAdmin, async (req, res) => {
  // Proxy to the admin API endpoint (reuses same logic, avoids duplicating auth)
  const brands = loadBrands();
  const bi = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[bi];
  if (!brand.tiktokShopToken?.access_token) return res.json({ ok: true, noToken: true });

  const CANCEL_STATUSES = new Set([140, 4, 'CANCELLED', 'CANCEL', 'REFUNDED', 'REFUND', 'REVERSE_PENDING', 'REVERSE_COMPLETE']);
  async function fetchWeekMetrics(startTs, endTs) {
    let gmv = 0, orders = 0, pageToken = null;
    for (let page = 0; page < 10; page++) {
      const body = { create_time_ge: startTs, create_time_lt: endTs, sort_field: 'create_time', sort_order: 'DESC' };
      if (pageToken) body.page_token = pageToken;
      try {
        const resp = await ttsBrandPost(brand, brands, bi, '/order/202309/orders/search', body, { page_size: 100 });
        const list = resp?.data?.orders || resp?.data?.order_list || [];
        for (const o of list) {
          if (o.is_sample_order) continue;
          const status = o.order_status ?? o.status;
          if (status !== undefined && CANCEL_STATUSES.has(status)) continue;
          orders++;
          const payment = o.payment || {};
          const amt = parseFloat(payment.sub_total ?? payment.original_total_product_price ?? 0) || 0;
          gmv += amt;
        }
        const nextToken = resp?.data?.next_page_token;
        if (!nextToken || list.length === 0) break;
        pageToken = nextToken;
      } catch(e) { break; }
    }
    return { gmv, orders, aov: orders > 0 ? gmv / orders : 0 };
  }

  // ── Analytics helper: shop-level traffic + conversion ────────────────────────
  // GET /analytics/202509/shop/performance  (YYYY-MM-DD dates)
  // Returns: traffic.avg_conversation_rate (conv rate 0–1), traffic.avg_page_views, traffic.avg_visitors
  async function fetchShopPerf(startDateStr, endDateStr) {
    try {
      const r = await ttsBrandGet(brand, brands, bi, '/analytics/202509/shop/performance',
        { start_date_ge: startDateStr, end_date_lt: endDateStr });
      const d = r?.data?.data || r?.data;
      const interval = d?.performance?.intervals?.[0];
      if (!interval) return null;
      const traffic = interval.traffic || {};
      const sales   = interval.sales   || {};
      return {
        convRate:  traffic.avg_conversation_rate != null ? parseFloat(traffic.avg_conversation_rate) : null,
        pageViews: traffic.avg_page_views        != null ? Number(traffic.avg_page_views)            : null,
        visitors:  traffic.avg_visitors          != null ? Number(traffic.avg_visitors)              : null,
      };
    } catch(e) {
      console.log(`[analytics/shop] ${brand.name} failed:`, e.response?.data?.message);
      return null;
    }
  }

  // ── Analytics helper: product-level impressions + CTR ────────────────────────
  // GET /analytics/202605/shop_products/performance  (YYYY-MM-DD dates)
  // Paginates up to 3 pages; sums total_performance.product_impressions across all products,
  // computes weighted-average CTR (impressions-weighted).
  async function fetchProductPerf(startDateStr, endDateStr) {
    try {
      let totalImpressions = 0, weightedCtr = 0, pageToken = null;
      for (let page = 0; page < 3; page++) {
        const params = { start_date_ge: startDateStr, end_date_lt: endDateStr, page_size: 50 };
        if (pageToken) params.page_token = pageToken;
        const r = await ttsBrandGet(brand, brands, bi, '/analytics/202605/shop_products/performance', params);
        const d = r?.data?.data || r?.data;
        const products = d?.products || [];
        for (const p of products) {
          const tp = p.total_performance || {};
          const imp = Number(tp.product_impressions) || 0;
          const ctr = parseFloat(tp.ctr) || 0;
          totalImpressions += imp;
          weightedCtr      += imp * ctr;
        }
        pageToken = d?.next_page_token;
        if (!pageToken || products.length === 0) break;
      }
      return {
        impressions: totalImpressions > 0 ? totalImpressions : null,
        ctr:         totalImpressions > 0 ? weightedCtr / totalImpressions : null,
      };
    } catch(e) {
      console.log(`[analytics/products] ${brand.name} failed:`, e.response?.data?.message);
      return null;
    }
  }

  try {
    const now    = Math.floor(Date.now() / 1000);
    const week1  = now - 7 * 86400;
    const week2  = week1 - 7 * 86400;
    const ds     = (ts) => new Date(ts * 1000).toISOString().slice(0,10); // YYYY-MM-DD
    const todayS = ds(now);
    const w1S    = ds(week1);
    const w2S    = ds(week2);

    const [thisWeek, lastWeek, shopThis, shopLast, prodThis, prodLast] = await Promise.all([
      fetchWeekMetrics(week1, now),
      fetchWeekMetrics(week2, week1),
      fetchShopPerf(w1S, todayS),
      fetchShopPerf(w2S, w1S),
      fetchProductPerf(w1S, todayS),
      fetchProductPerf(w2S, w1S),
    ]);

    function trend(curr, prev) {
      if (curr == null || curr === '') return { dir: 'flat', pct: null };
      const c = parseFloat(curr), p = parseFloat(prev);
      if (!p) return c > 0 ? { dir: 'up', pct: null } : { dir: 'flat', pct: null };
      const pct = ((c - p) / p) * 100;
      return { dir: pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat', pct: Math.round(Math.abs(pct)) };
    }

    const analytics = {
      thisWeek: {
        convRate:    shopThis?.convRate    ?? null,
        pageViews:   shopThis?.pageViews   ?? null,
        visitors:    shopThis?.visitors    ?? null,
        impressions: prodThis?.impressions ?? null,
        ctr:         prodThis?.ctr         ?? null,
      },
      lastWeek: {
        convRate:    shopLast?.convRate    ?? null,
        impressions: prodLast?.impressions ?? null,
        ctr:         prodLast?.ctr         ?? null,
      },
    };

    res.json({
      ok: true,
      thisWeek, lastWeek,
      trends: {
        gmv:         trend(thisWeek.gmv,             lastWeek.gmv),
        orders:      trend(thisWeek.orders,          lastWeek.orders),
        aov:         trend(thisWeek.aov,             lastWeek.aov),
        impressions: trend(analytics.thisWeek.impressions, analytics.lastWeek.impressions),
        ctr:         trend(analytics.thisWeek.ctr,         analytics.lastWeek.ctr),
        convRate:    trend(analytics.thisWeek.convRate,    analytics.lastWeek.convRate),
      },
      analytics,
    });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Shared GMV Fetch ─────────────────────────────────────────────────────────
// Fetches net product sales from TikTok Shop orders API.
// opts.startTs / opts.endTs allow custom date ranges (default: rolling 30 days).
// Always persists result to brands.json so billing preview can read it.
// ── LOCKED Net Product Sales (billing base) ────────────────────────────────
// Net Product Sales = Σ over qualifying line_items of (original_price − seller_discount).
// Qualifying = NOT is_sample_order AND order_status !== 'CANCELLED'.
// Do NOT subtract platform_discount (platform-funded). Reconciled to TikTok Seller
// Center "Net product sales" to the penny (Diamandia Jun 2026 = $11,567.46).
const NPS_CACHE = new Map(); // key: brandId:YYYY-MM  ->  { value, at }

// Returns { ge, lt, label, key, isCurrent } for a given YYYY-MM (or current month if omitted).
function monthWindow(monthStr) {
  const now = new Date();
  let y, m; // m is 0-indexed
  if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
    y = parseInt(monthStr.slice(0, 4), 10);
    m = parseInt(monthStr.slice(5, 7), 10) - 1;
  } else {
    y = now.getUTCFullYear();
    m = now.getUTCMonth();
  }
  const ge = Math.floor(Date.UTC(y, m, 1, 0, 0, 0) / 1000);
  const lt = Math.floor(Date.UTC(y, m + 1, 1, 0, 0, 0) / 1000);
  const isCurrent = (y === now.getUTCFullYear() && m === now.getUTCMonth());
  const label = new Date(Date.UTC(y, m, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    + (isCurrent ? ' (MTD)' : '');
  const key = `${y}-${String(m + 1).padStart(2, '0')}`;
  return { ge, lt, label, key, isCurrent };
}

// Locked-formula Net Product Sales for a brand over an explicit [ge, lt) window.
// Direct signed TikTok order-search (NOT the relay). Paginates via next_page_token.
// Caches closed months indefinitely; current (MTD) month ~5 min.
async function fetchNetProductSalesForWindow(brand, brandsObj, brandIdx, win) {
  const cacheKey = `${brand.id}:${win.key}`;
  const cached = NPS_CACHE.get(cacheKey);
  const ttl = win.isCurrent ? 5 * 60 * 1000 : Infinity;
  if (cached && (Date.now() - cached.at) < ttl) return cached.value;

  const CANCELLED = new Set(['CANCELLED', 'CANCEL', 140, 4]);
  let total = 0;
  try {
    let pageToken = null;
    let pageNum = 0;
    while (pageNum++ < 40) { // up to 40 pages = 2000 orders
      const body = { create_time_ge: win.ge, create_time_lt: win.lt, sort_field: 'create_time', sort_order: 'DESC' };
      if (pageToken) body.page_token = pageToken;
      const resp = await ttsBrandPost(brand, brandsObj, brandIdx, '/order/202309/orders/search', body, { page_size: 50 });
      const orders = resp?.data?.orders || resp?.data?.order_list || [];
      for (const o of orders) {
        if (o.is_sample_order === true) continue;
        const status = o.order_status ?? o.status;
        if (status !== undefined && CANCELLED.has(status)) continue;
        const items = o.line_items || o.item_list || o.items || [];
        for (const it of items) {
          const orig = parseFloat(it.original_price ?? it.price ?? 0) || 0;
          const sellerDisc = parseFloat(it.seller_discount ?? 0) || 0;
          total += (orig - sellerDisc);
        }
      }
      pageToken = resp?.data?.next_page_token || null;
      if (!pageToken || orders.length === 0) break;
    }
  } catch (err) {
    console.error(`[nps] ${brand.name} ${win.key} order-search failed:`, err.message);
    return cached ? cached.value : null; // fall back to any stale cache, else null (honest)
  }
  const rounded = Math.round(total * 100) / 100;
  NPS_CACHE.set(cacheKey, { value: rounded, at: Date.now() });
  return rounded;
}

async function fetchNetGmvForBrand(brand, brandsObj, brandIdx, opts = {}) {
  // GMV source priority: (1) direct TikTok app via the client's own token,
  // (2) Sisyphus/Reacher affiliate relay (keyed by shopId), (3) last-known cache.
  // RELAY-FIRST: affiliate relay is the source of truth for creator-attributed GMV.
  // (Direct TikTok order-search only sees the brand's OWN shop orders, which are ~0 for affiliate-driven brands.)
  if (brand.shopId && !opts.skipRelay) {
    {
      try {
        const relayResp = await axios.get(
          `${CFG.railwayUrl}/affiliate/shops/${brand.shopId}/summary`,
          { timeout: 8000 }
        );
        const g = parseFloat(relayResp?.data?.total_gmv);
        if (!isNaN(g) && g >= 0) {
          // Persist to brands.json cache so the value stays warm even if the relay is slow next time.
          try {
            const snap = loadBrands();
            if (snap.clients[brandIdx]) {
              snap.clients[brandIdx].cachedNetGmv = g;
              snap.clients[brandIdx].cachedGmvAt  = Date.now();
              snap.clients[brandIdx].cachedGmvSrc = 'relay';
              saveBrands(snap);
            }
          } catch (persistErr) {
            console.error(`[gmv] relay cache persist failed for ${brand.name}:`, persistErr.message);
          }
          return g;
        }
      } catch (relayErr) {
        console.error(`[gmv] relay summary failed for ${brand.name} (shop ${brand.shopId}):`, relayErr.message);
      }
    }
    // Relay returned no usable GMV — fall through to the signed direct TikTok order-search below.
  }
  const now   = opts.endTs   ?? Math.floor(Date.now() / 1000);
  const start = opts.startTs ?? (now - 30 * 24 * 60 * 60);
  let netGmv  = null;

  // Cancelled/refunded statuses only — do NOT include 121 (In Transit) or 122 (Delivered)
  const CANCEL_STATUS = new Set([140, 4, 'CANCELLED', 'CANCEL', 'REFUNDED', 'REFUND', 'REVERSE_PENDING', 'REVERSE_COMPLETE']);

  // Helper: extract order amount from any known field layout
  function extractAmount(o) {
    // Top-level sale_amount (affiliate order style)
    if (o.sale_amount != null && parseFloat(o.sale_amount) > 0) return parseFloat(o.sale_amount);
    // payment / payment_info object — TikTok uses "payment" in v202309
    const pi = o.payment || o.payment_info;
    if (pi) {
      const candidates = [
        pi.sub_total, pi.total_amount, pi.paid_amount,
        pi.original_total_product_price, pi.product_total_amount,
        pi.seller_income, pi.settlement_amount,
      ];
      for (const c of candidates) {
        const v = parseFloat(c);
        if (!isNaN(v) && v > 0) return v;
      }
    }
    // Top-level fallback fields
    const topLevel = [o.total_amount, o.total_price, o.order_amount, o.amount];
    for (const c of topLevel) {
      const v = parseFloat(c);
      if (!isNaN(v) && v > 0) return v;
    }
    // Line items fallback: sum unit price × qty
    const items = o.line_items || o.skus || [];
    if (items.length > 0) {
      return items.reduce((sum, item) => {
        const price = parseFloat(
          item.sku_sale_price ?? item.sale_price ?? item.sku_unit_original_price ??
          item.original_price ?? item.price ?? 0
        ) || 0;
        const qty = parseInt(item.quantity ?? item.sku_quantity ?? 1, 10) || 1;
        return sum + price * qty;
      }, 0);
    }
    return 0;
  }

  // Orders search with pagination (finance/202309 requires scope we don't have; use order/202309)
  try {
    let pageToken = null;
    let totalOrders = 0;
    let pageNum = 0;
    netGmv = 0;
    let firstOrderLogged = false;

    while (pageNum++ < 20) { // max 20 pages = 2000 orders
      const body = { create_time_ge: start, create_time_lt: now, sort_field: 'create_time', sort_order: 'DESC' };
      if (pageToken) body.page_token = pageToken;
      const resp = await ttsBrandPost(brand, brandsObj, brandIdx, '/order/202309/orders/search', body, { page_size: 100 });
      const orders = resp?.data?.orders || resp?.data?.order_list || [];

      if (!firstOrderLogged && orders.length > 0) {
        console.log(`[gmv] ${brand.name} sample order:`, JSON.stringify(orders[0]).slice(0, 800));
        firstOrderLogged = true;
      }

      for (const o of orders) {
        if (o.is_sample_order) continue; // free creator samples — $0, exclude from GMV
        const status = o.order_status ?? o.status;
        if (status !== undefined && CANCEL_STATUS.has(status)) continue;
        netGmv += extractAmount(o);
      }
      totalOrders += orders.length;

      const nextToken = resp?.data?.next_page_token || resp?.data?.page_token;
      if (!nextToken || orders.length === 0) break;
      pageToken = nextToken;
    }
    console.log(`[gmv] ${brand.name} GMV = $${netGmv.toFixed(2)} (${totalOrders} orders, ${pageNum} page(s))`);
  } catch(e) {
    console.error(`[gmv] orders error for ${brand.name}:`, e.message, '| body:', JSON.stringify(e.response?.data || '').slice(0, 300));
  }

  // Persist to brands.json cache
  if (netGmv !== null) {
    try {
      const snap = loadBrands();
      if (snap.clients[brandIdx]) {
        snap.clients[brandIdx].cachedNetGmv = netGmv;
        snap.clients[brandIdx].cachedGmvAt  = Date.now();
        saveBrands(snap);
      }
    } catch(_) {}
  }
  return netGmv ?? (brand.cachedNetGmv ?? null);
}

// ═══════════════════════════════════════════════════════════════════════════
// Client Agent — Weekly Report
// Every number here is computed deterministically from real API/DB calls.
// The LLM (generateNarrative, below) never computes or invents a number — it
// only writes prose about numbers that are already fixed by the time it runs.
// ═══════════════════════════════════════════════════════════════════════════

// Shop traffic + conversion rate. Mirrors the closure of the same name inside
// /portal-admin/shop-metrics/:brandId — duplicated rather than extracted so
// that existing, working route is never touched by this change.
async function fetchShopTrafficForWindow(brand, brands, bi, startDateStr, endDateStr) {
  try {
    const r = await ttsBrandGet(brand, brands, bi, '/analytics/202509/shop/performance',
      { start_date_ge: startDateStr, end_date_lt: endDateStr });
    const d = r?.data?.data || r?.data;
    const interval = d?.performance?.intervals?.[0];
    if (!interval) return null;
    const traffic = interval.traffic || {};
    return {
      convRate: traffic.avg_conversation_rate != null ? parseFloat(traffic.avg_conversation_rate) : null,
      visitors: traffic.avg_visitors != null ? Number(traffic.avg_visitors) : null,
    };
  } catch (e) {
    console.log(`[client-agent] shop traffic fetch failed for ${brand.name}:`, e.response?.data?.message || e.message);
    return null;
  }
}

// Product impressions + weighted CTR. Same duplication rationale as above.
async function fetchProductPerfForWindow(brand, brands, bi, startDateStr, endDateStr) {
  try {
    let totalImpressions = 0, weightedCtr = 0, pageToken = null;
    for (let page = 0; page < 3; page++) {
      const params = { start_date_ge: startDateStr, end_date_lt: endDateStr, page_size: 50 };
      if (pageToken) params.page_token = pageToken;
      const r = await ttsBrandGet(brand, brands, bi, '/analytics/202605/shop_products/performance', params);
      const d = r?.data?.data || r?.data;
      const products = d?.products || [];
      for (const p of products) {
        const tp = p.total_performance || {};
        const imp = Number(tp.product_impressions) || 0;
        const ctr = parseFloat(tp.ctr) || 0;
        totalImpressions += imp;
        weightedCtr += imp * ctr;
      }
      pageToken = d?.next_page_token;
      if (!pageToken || products.length === 0) break;
    }
    return {
      impressions: totalImpressions > 0 ? totalImpressions : null,
      ctr: totalImpressions > 0 ? weightedCtr / totalImpressions : null,
    };
  } catch (e) {
    console.log(`[client-agent] product perf fetch failed for ${brand.name}:`, e.response?.data?.message || e.message);
    return null;
  }
}

// Order count for the window — used ONLY to compute click-to-order rate.
// Never used as a dollar figure; the dollar figure always comes from the
// LOCKED fetchNetGmvForBrand() above, so this can never drift from billing.
async function fetchOrderCountForWindow(brand, brands, bi, startTs, endTs) {
  const CANCEL_STATUSES = new Set([140, 4, 'CANCELLED', 'CANCEL', 'REFUNDED', 'REFUND', 'REVERSE_PENDING', 'REVERSE_COMPLETE']);
  let orders = 0, pageToken = null;
  try {
    for (let page = 0; page < 10; page++) {
      const body = { create_time_ge: startTs, create_time_lt: endTs, sort_field: 'create_time', sort_order: 'DESC' };
      if (pageToken) body.page_token = pageToken;
      const resp = await ttsBrandPost(brand, brands, bi, '/order/202309/orders/search', body, { page_size: 100 });
      const list = resp?.data?.orders || resp?.data?.order_list || [];
      for (const o of list) {
        if (o.is_sample_order) continue;
        const status = o.order_status ?? o.status;
        if (status !== undefined && CANCEL_STATUSES.has(status)) continue;
        orders++;
      }
      const nextToken = resp?.data?.next_page_token;
      if (!nextToken || list.length === 0) break;
      pageToken = nextToken;
    }
  } catch (e) { /* best-effort count — a failure here degrades the rate to null, never throws */ }
  return orders;
}

// One brand's weekly KPI set for the report. `sales` always comes from the
// LOCKED fetchNetGmvForBrand() — never recomputed — so it can never drift
// from the dollar figure the client's own invoice shows.
async function getShopMetricsForReport(brandId, range) {
  const brands = loadBrands();
  const bi = (brands.clients || []).findIndex(b => b.id === brandId);
  if (bi === -1) throw new Error(`getShopMetricsForReport: brand not found (${brandId})`);
  const brand = brands.clients[bi];
  if (!brand.tiktokShopToken?.access_token) {
    return { brandId, brandName: brand.name, noToken: true };
  }

  const startTs = Math.floor(range.start / 1000);
  const endTs = Math.floor(range.end / 1000);
  const ds = (ms) => new Date(ms).toISOString().slice(0, 10);

  const [sales, traffic, productPerf, orders] = await Promise.all([
    fetchNetGmvForBrand(brand, brands, bi, { startTs, endTs }),
    fetchShopTrafficForWindow(brand, brands, bi, ds(range.start), ds(range.end)),
    fetchProductPerfForWindow(brand, brands, bi, ds(range.start), ds(range.end)),
    fetchOrderCountForWindow(brand, brands, bi, startTs, endTs),
  ]);

  const visitors = traffic?.visitors ?? null;
  return {
    brandId,
    brandName: brand.name,
    sales,
    orders,
    impressions: productPerf?.impressions ?? null,
    ctr: productPerf?.ctr ?? null,                 // fraction, e.g. 0.021 = 2.1%
    clickToOrderRate: (visitors && orders != null) ? orders / visitors : null,
  };
}

// Top affiliates. Source: the Reacher relay's /creators/top endpoint — the
// SAME source the client portal's own dashboard already uses.
// HONEST LIMITATION: this relay endpoint takes no date-range parameter, so
// results reflect Reacher's own tracking window, not this report's exact
// date range. Never presented as precisely scoped to the week — see the
// "(recent)" label in renderReportHTML below.
async function getTopAffiliatesForReport(shopId, limit = 5) {
  if (!shopId) return [];
  try {
    const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shopId}/creators/top`, { timeout: 10000 });
    const list = data?.creators || data?.data || [];
    return list.slice(0, limit).map(c => ({
      handle: c.creator_handle || c.username || 'unknown',
      gmv: parseFloat(c.gmv || c.shop_gmv || c.sale_amount || 0),
    }));
  } catch (e) {
    console.log('[client-agent] top affiliates fetch failed:', e.message);
    return [];
  }
}

// Deterministic HTML render — zero LLM. This alone is a complete, honest
// report; the narrative below only adds a few sentences of context on top.
// renderReportHTML + generateNarrative now live in lib/weekly-report.js —
// extracted so the eval harness (lib/weekly-report-narrative.eval.js) can
// exercise generateNarrative directly, with no server boot required.
let renderReportHTML = () => '<p>Weekly report module not available.</p>';
let generateNarrative = async () => 'Narrative unavailable.';
try { ({ renderReportHTML, generateNarrative } = require('./lib/weekly-report')); }
catch (e) { console.error('[weekly-report] module load failed:', e.message); }

// Orchestrates the full report: data layer + narrative. Delivery/scheduling
// is deliberately NOT triggered from here — see the /weekly-report/send
// route below, which is a manual, human-triggered action, not a scheduler.
async function generateWeeklyReport(brandId, range) {
  const brands = loadBrands();
  const bi = (brands.clients || []).findIndex(b => b.id === brandId);
  if (bi === -1) throw new Error(`generateWeeklyReport: brand not found (${brandId})`);
  const brand = brands.clients[bi];

  const [shopMetrics, topAffiliates, completedTasks] = await Promise.all([
    getShopMetricsForReport(brandId, range),
    getTopAffiliatesForReport(brand.shopId),
    opsMyTasksHelpers
      ? require('./lib/client-agent-context').getCompletedTasks(brand.name, range, opsMyTasksHelpers).catch((e) => { console.error('[client-agent] task fetch failed:', e.message); return []; })
      : Promise.resolve([]),
  ]);

  const context = { brandId, brandName: brand.name, range, shopMetrics, topAffiliates, completedTasks };
  context.narrative = await generateNarrative(context);
  context.html = renderReportHTML(context);
  return context;
}

// GET /api/admin/client-agent/weekly-report/preview?brand=X&days=7
// Generates and returns the report HTML for review. Never sends anything —
// this is the safe way to look at a report before anyone else sees it.
app.get('/api/admin/client-agent/weekly-report/preview', requirePortalAdmin, async (req, res) => {
  try {
    const { brand, days } = req.query;
    if (!brand) return res.status(400).json({ error: 'brand query param required' });
    const end = Date.now();
    const start = end - (Number(days) > 0 ? Number(days) : 7) * 86400000;
    const report = await generateWeeklyReport(brand, { start, end });
    res.type('html').send(report.html);
  } catch (e) {
    console.error('[client-agent] weekly-report preview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Review queue ─────────────────────────────────────────────────────────────
// A generated report is never sent directly. It's saved here as 'pending'
// first; only an explicit /approve on that exact record id sends it — the
// text that goes out is the text that was reviewed, never regenerated at
// send time. See roadmap Phase 7 (human-in-the-loop before real clients see
// AI-touched output).
function loadReportQueue() {
  try { if (fs.existsSync(REPORT_QUEUE_FILE)) return JSON.parse(fs.readFileSync(REPORT_QUEUE_FILE, 'utf8')); }
  catch (e) { console.error('[client-agent] failed to read report queue:', e.message); }
  return [];
}
function saveReportQueue(queue) {
  try { fs.writeFileSync(REPORT_QUEUE_FILE, JSON.stringify(queue, null, 2)); }
  catch (e) { console.error('[client-agent] failed to save report queue:', e.message); }
}

function buildReportPlainText(report, start, end) {
  return [
    `📊 ${report.brandName} — Weekly Report`,
    `${new Date(start).toLocaleDateString()} – ${new Date(end).toLocaleDateString()}`,
    '',
    report.narrative || '',
    '',
    `Impressions: ${report.shopMetrics?.impressions ?? '—'}`,
    `Sales: ${report.shopMetrics?.sales != null ? '$' + report.shopMetrics.sales.toLocaleString() : '—'}`,
    `CTR: ${report.shopMetrics?.ctr != null ? (report.shopMetrics.ctr * 100).toFixed(1) + '%' : '—'}`,
    `Click-to-Order Rate: ${report.shopMetrics?.clickToOrderRate != null ? (report.shopMetrics.clickToOrderRate * 100).toFixed(1) + '%' : '—'}`,
    '',
    `Top Affiliates (recent): ${(report.topAffiliates || []).map(a => `@${a.handle} ($${a.gmv})`).join(', ') || 'none'}`,
    `Completed this week: ${(report.completedTasks || []).length} task(s)`,
  ].join('\n');
}

// POST /api/admin/client-agent/weekly-report/generate  { brandId, days }
// Generates a report and saves it as 'pending' in the review queue. Sends
// nothing. Returns the full record (including html) so the caller can
// display it immediately without a second round-trip.
app.post('/api/admin/client-agent/weekly-report/generate', requirePortalAdmin, express.json(), async (req, res) => {
  try {
    const { brandId, days } = req.body || {};
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    const end = Date.now();
    const start = end - (Number(days) > 0 ? Number(days) : 7) * 86400000;

    const report = await generateWeeklyReport(brandId, { start, end });
    const record = {
      id: `wr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      brandId,
      brandName: report.brandName,
      range: { start, end },
      html: report.html,
      plainText: buildReportPlainText(report, start, end),
      narrative: report.narrative,
      shopMetrics: report.shopMetrics,
      topAffiliates: report.topAffiliates,
      completedTaskCount: (report.completedTasks || []).length,
      status: 'pending',
      generatedAt: Date.now(),
      generatedBy: (req.session && req.session.portalAdminEmail) || 'admin',
      sentAt: null,
    };

    const queue = loadReportQueue();
    queue.unshift(record);
    saveReportQueue(queue);

    res.json({ ok: true, report: record });
  } catch (e) {
    console.error('[client-agent] weekly-report generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/client-agent/weekly-report/queue?status=pending
app.get('/api/admin/client-agent/weekly-report/queue', requirePortalAdmin, (req, res) => {
  const { status } = req.query;
  let queue = loadReportQueue();
  if (status) queue = queue.filter(r => r.status === status);
  res.json({ ok: true, count: queue.length, reports: queue });
});

// POST /api/admin/client-agent/weekly-report/approve  { id }
// Sends the EXACT stored text for that report id — never regenerates.
// Manual, human-triggered only. Not wired to any scheduler.
app.post('/api/admin/client-agent/weekly-report/approve', requirePortalAdmin, express.json(), async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const queue = loadReportQueue();
    const record = queue.find(r => r.id === id);
    if (!record) return res.status(404).json({ error: `No report found with id ${id}` });
    if (record.status !== 'pending') return res.status(409).json({ error: `Report ${id} is already "${record.status}", not pending` });

    const { _internals } = require('./lib/client-chat-sync');
    const chatName = `${record.brandName} Chat`;
    const t = await _internals.tenantToken();
    const chatId = await _internals.findExistingChat(t, chatName);
    if (!chatId) return res.status(404).json({ error: `No existing Lark chat found named "${chatName}" — nothing sent, report left pending` });

    await _internals.postMessage(t, chatId, record.plainText);

    record.status = 'sent';
    record.sentAt = Date.now();
    record.chatId = chatId;
    saveReportQueue(queue);

    res.json({ ok: true, report: record });
  } catch (e) {
    console.error('[client-agent] weekly-report approve error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/client-agent/weekly-report/reject  { id }
app.post('/api/admin/client-agent/weekly-report/reject', requirePortalAdmin, express.json(), (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const queue = loadReportQueue();
  const record = queue.find(r => r.id === id);
  if (!record) return res.status(404).json({ error: `No report found with id ${id}` });
  if (record.status !== 'pending') return res.status(409).json({ error: `Report ${id} is already "${record.status}", not pending` });
  record.status = 'rejected';
  saveReportQueue(queue);
  res.json({ ok: true, report: record });
});

// GET /api/admin/client-agent/brands — lightweight id+name list for the
// review page's dropdown. Deliberately NOT the heavy /portal-admin/clients
// route, which recomputes billing GMV for every brand on every load.
app.get('/api/admin/client-agent/brands', requirePortalAdmin, (req, res) => {
  const brands = loadBrands();
  res.json({ brands: (brands.clients || []).map(b => ({ id: b.id, name: b.name })) });
});

const WEEKLY_REPORT_REVIEW_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly Reports — Review Queue</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e2e8f0;min-height:100vh}
.header{background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.07);padding:20px 24px}
.header h1{font-size:1.3rem;font-weight:800}
.container{max-width:900px;margin:0 auto;padding:32px 24px}
.panel{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:20px;margin-bottom:24px}
.panel h2{font-size:1rem;margin-bottom:14px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
select,input,button{background:#14141c;border:1px solid rgba(255,255,255,.12);color:#e2e8f0;border-radius:8px;padding:9px 12px;font-size:.9rem}
button{cursor:pointer;font-weight:600;background:linear-gradient(135deg,#00f2ea,#a855f7);border:none;color:#0a0a0f}
button.secondary{background:rgba(255,255,255,.06);color:#e2e8f0;border:1px solid rgba(255,255,255,.12)}
button.danger{background:#3a1a1a;color:#ff8080;border:1px solid #5a2a2a}
button:disabled{opacity:.5;cursor:not-allowed}
.card{border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:16px;margin-bottom:12px}
.card .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.card .brand{font-weight:700}
.badge{font-size:.72rem;padding:2px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:.03em}
.badge.pending{background:#3a3010;color:#f2c94c}
.badge.sent{background:#0f3a1f;color:#4ade80}
.badge.rejected{background:#3a1a1a;color:#ff8080}
.meta{font-size:.78rem;color:#94a3b8;margin-bottom:10px}
.actions{display:flex;gap:8px}
.empty{color:#64748b;padding:20px;text-align:center}
iframe{width:100%;height:600px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:#fff}
.close-frame{margin-top:8px}
</style></head><body>
<div class="header"><h1>📊 Weekly Reports — Review Queue</h1></div>
<div class="container">

  <div class="panel">
    <h2>Generate a report</h2>
    <div class="row">
      <select id="brandSelect"><option>Loading brands…</option></select>
      <input id="daysInput" type="number" value="7" min="1" style="width:80px" title="Days back">
      <button onclick="generateReport()" id="genBtn">Generate</button>
    </div>
    <div style="font-size:.78rem;color:#64748b;margin-top:8px">Generates and saves as pending — sends nothing.</div>
    <div id="scopeNote" style="font-size:.78rem;color:#c9a84c;margin-top:6px"></div>
  </div>

  <div class="panel">
    <h2>Pending review</h2>
    <div id="pendingList" class="empty">Loading…</div>
  </div>

  <div class="panel">
    <h2>Recent (sent / rejected)</h2>
    <div id="recentList" class="empty">Loading…</div>
  </div>

</div>
<script>
const urlBrand = new URLSearchParams(window.location.search).get('brand');

async function loadBrandsList() {
  const r = await fetch('/api/admin/client-agent/brands');
  const j = await r.json();
  const sel = document.getElementById('brandSelect');
  sel.innerHTML = (j.brands || []).map(b => '<option value="' + b.id + '">' + b.name + '</option>').join('');
  if (urlBrand) {
    sel.value = urlBrand;
    const match = (j.brands || []).find(b => b.id === urlBrand);
    document.getElementById('scopeNote').textContent = match
      ? 'Showing reports for ' + match.name + ' only. '
      : '';
    if (match) {
      const link = document.createElement('a');
      link.href = '/client-agent/reports';
      link.textContent = 'View all brands →';
      link.style.cssText = 'color:#00f2ea;text-decoration:none;font-size:.8rem';
      document.getElementById('scopeNote').appendChild(link);
    }
  }
}

async function generateReport() {
  const brandId = document.getElementById('brandSelect').value;
  const days = document.getElementById('daysInput').value;
  const btn = document.getElementById('genBtn');
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    const r = await fetch('/api/admin/client-agent/weekly-report/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandId, days: Number(days) })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Generate failed');
    await loadQueue();
  } catch (e) {
    alert('Could not generate: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Generate';
  }
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderCard(r, showActions) {
  const generated = new Date(r.generatedAt).toLocaleString();
  const range = new Date(r.range.start).toLocaleDateString() + ' – ' + new Date(r.range.end).toLocaleDateString();
  let actions = '';
  if (showActions) {
    actions = '<div class="actions">' +
      '<button onclick="toggleView(\\'' + r.id + '\\')">View</button>' +
      '<button onclick="approve(\\'' + r.id + '\\')">Approve &amp; Send</button>' +
      '<button class="danger" onclick="reject(\\'' + r.id + '\\')">Reject</button>' +
      '</div>';
  } else {
    actions = '<div class="actions"><button class="secondary" onclick="toggleView(\\'' + r.id + '\\')">View</button></div>';
  }
  return '<div class="card" id="card-' + r.id + '">' +
    '<div class="top"><span class="brand">' + esc(r.brandName) + '</span><span class="badge ' + r.status + '">' + r.status + '</span></div>' +
    '<div class="meta">' + range + ' · generated ' + generated + (r.sentAt ? ' · sent ' + new Date(r.sentAt).toLocaleString() : '') + '</div>' +
    actions +
    '<div id="frame-' + r.id + '" style="display:none" class="close-frame"><iframe id="iframe-' + r.id + '"></iframe></div>' +
    '</div>';
}

function toggleView(id) {
  const box = document.getElementById('frame-' + id);
  const visible = box.style.display !== 'none';
  box.style.display = visible ? 'none' : 'block';
  if (!visible) {
    fetch('/api/admin/client-agent/weekly-report/queue').then(r => r.json()).then(j => {
      const rec = (j.reports || []).find(x => x.id === id);
      if (rec) document.getElementById('iframe-' + id).srcdoc = rec.html;
    });
  }
}

async function approve(id) {
  if (!confirm('Send this report to the client now? This posts into their Lark chat.')) return;
  try {
    const r = await fetch('/api/admin/client-agent/weekly-report/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Approve failed');
    await loadQueue();
  } catch (e) { alert('Could not send: ' + e.message); }
}

async function reject(id) {
  if (!confirm('Reject this report? It will not be sent.')) return;
  try {
    const r = await fetch('/api/admin/client-agent/weekly-report/reject', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Reject failed');
    await loadQueue();
  } catch (e) { alert('Could not reject: ' + e.message); }
}

async function loadQueue() {
  const r = await fetch('/api/admin/client-agent/weekly-report/queue');
  const j = await r.json();
  let all = j.reports || [];
  if (urlBrand) all = all.filter(x => x.brandId === urlBrand);
  const pending = all.filter(x => x.status === 'pending');
  const recent = all.filter(x => x.status !== 'pending').slice(0, 20);

  document.getElementById('pendingList').innerHTML = pending.length
    ? pending.map(r => renderCard(r, true)).join('')
    : '<div class="empty">Nothing pending.</div>';

  document.getElementById('recentList').innerHTML = recent.length
    ? recent.map(r => renderCard(r, false)).join('')
    : '<div class="empty">Nothing yet.</div>';
}

loadBrandsList();
loadQueue();
</script>
</body></html>`;

// GET /client-agent/reports — the review-queue admin page.
app.get('/client-agent/reports', requirePortalAdmin, (req, res) => {
  res.type('html').send(WEEKLY_REPORT_REVIEW_HTML);
});

// ─── Client Billing ───────────────────────────────────────────────────────────
// Helper: normalize billing fields from brands.json (handles both old+new field names)
function clientBilling(b) {
  // Use prorated retainer for first invoice if set (cleared after first invoice is sent)
  const retainer  = (!b.lastInvoicedAt && b.proratedFirstRetainer != null)
    ? b.proratedFirstRetainer
    : (b.retainer ?? b.contractValue ?? 0);
  const commRate  = b.commissionRate ?? ((b.gmvShare ?? 0) / 100);
  const gmv       = b.cachedNetGmv ?? 0;
  const revShare  = parseFloat((gmv * commRate).toFixed(2));
  const total     = parseFloat((retainer + revShare).toFixed(2));
  // Billing email — intentionally does NOT fall back to loginEmail (that's Tommy's portal email for some brands)
  let billingEmail = b.billingEmail || '';
  if (!billingEmail && b.contacts) {
    const m = b.contacts.match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (m) billingEmail = m[0];
  }
  return { retainer, commRate, gmv, revShare, total, billingEmail };
}

// Shared helper: compute next billing date (1st of next month) and days until
function billingCycle() {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1); // 1st of next month
  const msLeft = next.getTime() - now.getTime();
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    period:        now.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    monthStart:    Math.floor(monthStart.getTime() / 1000),
    nowTs:         Math.floor(now.getTime() / 1000),
    nextBillingDate: next.toISOString().slice(0, 10),       // e.g. "2026-07-01"
    nextBillingLabel: next.toLocaleString('en-US', { month: 'long', day: 'numeric' }), // "July 1"
    daysUntilBilling: daysLeft,
    dataPeriod: `${now.toLocaleString('en-US', { month:'short', day:'numeric' })} – ${now.toLocaleString('en-US', { month:'short', day:'numeric' })}` // overwritten below
  };
}

// Shared helper: check if a Stripe customer has a saved payment method
async function stripeHasPaymentMethod(customerId) {
  if (!stripe || !customerId) return false;
  try {
    const cust = await stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method', 'default_source'],
    });
    return !!(cust.invoice_settings?.default_payment_method || cust.default_source);
  } catch(_) { return false; }
}

// GET /portal-admin/billing/preview — current-month GMV + invoice amounts + payment method status
app.get('/portal-admin/billing/preview', requirePortalAdmin, async (req, res) => {
  const cycle = billingCycle();
  const now   = new Date();
  // Locked-formula billing window (default = current month MTD, or ?month=YYYY-MM)
  const win = monthWindow(req.query.month);
  cycle.dataPeriod = win.label;
  // Available months for the picker: current + trailing 11 closed months
  const availableMonths = [];
  { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    for (let k = 0; k < 12; k++) {
      const w = monthWindow(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`);
      availableMonths.push({ key: w.key, label: w.label });
      d.setUTCMonth(d.getUTCMonth() - 1);
    } }

  // Only include active clients — exclude internal/test brands
  const INTERNAL_IDS = new Set(['orgsocsmarketing001', 'tctestbrand001']);
  const allBrands = loadBrands();
  const active = (allBrands.clients || []).filter(b =>
    (!b.pipelineStage || b.pipelineStage === 'Contract Signed') &&
    !INTERNAL_IDS.has(b.id) &&
    b.source !== 'internal'
  );

  // Fetch live GMV (current month) + payment method status in parallel
  const [gmvResults, pmResults] = await Promise.all([
    Promise.allSettled(active.map((b, i) => {
      const idx = (allBrands.clients || []).findIndex(c => c.id === b.id);
      return fetchNetProductSalesForWindow(allBrands.clients[idx] || b, allBrands, idx, win);
    })),
    Promise.allSettled(active.map(b => stripeHasPaymentMethod(b.stripeCustomerId))),
  ]);

  // Re-load after GMV cache writes
  const freshBrands = loadBrands();
  const freshActive = (freshBrands.clients || []).filter(b =>
    (!b.pipelineStage || b.pipelineStage === 'Contract Signed') &&
    !INTERNAL_IDS.has(b.id) && b.source !== 'internal'
  );

  const previews = freshActive.map((b, i) => {
    const liveGmv = gmvResults[i]?.status === 'fulfilled' ? gmvResults[i].value : null;
    const hasPaymentMethod = pmResults[i]?.status === 'fulfilled' ? pmResults[i].value : false;
    const bill     = clientBilling(b);
    // Never fall back to the stale relay cache for billing display.
    // Retainer-only brands (commRate 0, e.g. Diamandia) show no GMV.
    const gmv      = bill.commRate === 0 ? 0 : (liveGmv ?? 0);
    const commRate = bill.commRate;
    const retainer = bill.retainer;
    const revShare = parseFloat((gmv * commRate).toFixed(2));
    const total    = parseFloat((retainer + revShare).toFixed(2));
    return {
      id:               b.id,
      name:             b.name,
      billingEmail:     bill.billingEmail,
      period:           cycle.period,
      dataPeriod:       cycle.dataPeriod,
      nextBillingDate:  cycle.nextBillingDate,
      nextBillingLabel: cycle.nextBillingLabel,
      daysUntilBilling: cycle.daysUntilBilling,
      retainer,
      gmv,
      commRate,
      revShare,
      total,
      hasPaymentMethod,
      gmvUpdatedAt:     b.cachedGmvAt || null,
      stripeCustomerId: b.stripeCustomerId || null,
      lastInvoiceId:    b.lastInvoiceId || null,
      lastInvoiceUrl:   b.lastInvoiceUrl || null,
      lastInvoicedAt:   b.lastInvoicedAt || null,
      pendingTierChange: b.pendingTierChange || null,
    };
  });
  res.json({ ok: true, period: cycle.period, dataPeriod: cycle.dataPeriod, nextBillingLabel: cycle.nextBillingLabel, daysUntilBilling: cycle.daysUntilBilling, window: { key: win.key, label: win.label, isCurrent: win.isCurrent }, availableMonths, previews });
});

// GET /portal-admin/billing/history — Stripe invoice history for all active clients
app.get('/portal-admin/billing/history', requirePortalAdmin, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const INTERNAL_IDS = new Set(['orgsocsmarketing001', 'tctestbrand001']);
  const brands = loadBrands();
  const active = (brands.clients || []).filter(b =>
    (!b.pipelineStage || b.pipelineStage === 'Contract Signed') &&
    !INTERNAL_IDS.has(b.id) && b.source !== 'internal'
  );
  const results = await Promise.allSettled(active.map(async b => {
    const custIds = Array.isArray(b.stripeCustomerIds) && b.stripeCustomerIds.length
      ? b.stripeCustomerIds
      : (b.stripeCustomerId ? [b.stripeCustomerId] : []);
    if (!custIds.length) return { id: b.id, name: b.name, invoices: [] };
    const lists = await Promise.all(
      custIds.map(cid => stripe.invoices.list({ customer: cid, limit: 24 }))
    );
    const allInvoices = lists.flatMap(l => l.data);
    return {
      id:   b.id,
      name: b.name,
      invoices: allInvoices.map(inv => ({
        id:         inv.id,
        amountDue:  (inv.amount_due  / 100).toFixed(2),
        amountPaid: (inv.amount_paid / 100).toFixed(2),
        status:     inv.status,              // draft / open / paid / void / uncollectible
        created:    inv.created,             // unix ts
        paidAt:     inv.status_transitions?.paid_at || null,
        dueDate:    inv.due_date || null,
        hostedUrl:  inv.hosted_invoice_url || null,
        period:     inv.description || inv.metadata?.period || '',
        method:     inv.collection_method,   // send_invoice | charge_automatically
      })),
    };
  }));
  res.json({
    ok: true,
    clients: results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean),
  });
});

// GET /portal-admin/billing/setup-link/:brandId — Stripe Customer Portal link so client can add payment method
app.get('/portal-admin/billing/setup-link/:brandId', requirePortalAdmin, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const brands   = loadBrands();
  const brandIdx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });
  const b    = brands.clients[brandIdx];
  const bill = clientBilling(b);
  try {
    let customerId = b.stripeCustomerId;
    if (!customerId) {
      const cust = await stripe.customers.create({
        name:     b.name,
        email:    bill.billingEmail,
        metadata: { brandId: b.id, source: 'cult-content-billing' },
      });
      customerId = cust.id;
      brands.clients[brandIdx].stripeCustomerId = customerId;
      saveBrands(brands);
    }
    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: 'https://portal.cultcontent.cc/client/dashboard',
    });
    res.json({ ok: true, url: session.url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /portal-admin/billing/send/:brandId — create + finalize + send Stripe invoice
app.post('/portal-admin/billing/send/:brandId', requirePortalAdmin, express.json(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured — set STRIPE_SECRET_KEY' });

  const brands   = loadBrands();
  const brandIdx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });

  const b    = brands.clients[brandIdx];
  const bill = clientBilling(b);
  const now  = new Date();
  const period = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // Allow override of retainer, commRate, GMV, billingEmail from request body
  const finalRetainer = req.body?.retainer    != null ? parseFloat(req.body.retainer)    : bill.retainer;
  const finalCommRate = req.body?.commRate     != null ? parseFloat(req.body.commRate)    : bill.commRate;
  const finalGmv      = req.body?.gmv          != null ? parseFloat(req.body.gmv)         : bill.gmv;
  const finalEmail    = req.body?.billingEmail?.trim() || bill.billingEmail;
  const finalRevShare = parseFloat((finalGmv * finalCommRate).toFixed(2));
  const finalTotal    = parseFloat((finalRetainer + finalRevShare).toFixed(2));

  if (!finalEmail) return res.status(400).json({ error: 'No billing email for this client' });
  if (finalTotal <= 0)    return res.status(400).json({ error: 'Invoice total is $0 — nothing to bill' });

  try {
    // 1. Create or retrieve Stripe customer
    let customerId = b.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name:  b.name,
        email: finalEmail,
        metadata: { brandId: b.id, source: 'cult-content-billing' },
      });
      customerId = customer.id;
    }

    // 2. Check for saved payment method → auto-charge if available
    const hasPaymentMethod = await stripeHasPaymentMethod(customerId);
    const collectionMethod = hasPaymentMethod ? 'charge_automatically' : 'send_invoice';

    // 3. Create invoice
    const invoice = await stripe.invoices.create({
      customer:          customerId,
      collection_method: collectionMethod,
      ...(collectionMethod === 'send_invoice' ? { days_until_due: 7 } : {}),
      description:       `Cult Content — ${period}`,
      metadata:          { brandId: b.id, period, gmv: String(finalGmv) },
      auto_advance:      false,
    });

    // 4. Add line items
    if (finalRetainer > 0) {
      await stripe.invoiceItems.create({
        customer:    customerId,
        invoice:     invoice.id,
        amount:      Math.round(finalRetainer * 100),
        currency:    'usd',
        description: `Monthly Retainer — ${period}`,
      });
    }
    if (finalRevShare > 0) {
      await stripe.invoiceItems.create({
        customer:    customerId,
        invoice:     invoice.id,
        amount:      Math.round(finalRevShare * 100),
        currency:    'usd',
        description: `GMV Revenue Share (${Math.round(finalCommRate * 100)}% of $${finalGmv.toLocaleString()} GMV) — ${period}`,
      });
    }

    // 5. Finalize — then either charge or send email
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
    let charged = false;
    if (hasPaymentMethod) {
      await stripe.invoices.pay(finalized.id);
      charged = true;
    } else {
      await stripe.invoices.sendInvoice(finalized.id);
    }

    // 6. Persist
    brands.clients[brandIdx].stripeCustomerId = customerId;
    brands.clients[brandIdx].lastInvoiceId    = finalized.id;
    brands.clients[brandIdx].lastInvoiceUrl   = finalized.hosted_invoice_url;
    brands.clients[brandIdx].lastInvoicedAt   = Date.now();
    saveBrands(brands);

    console.log(`[BILLING] ${charged ? 'Charged' : 'Sent invoice to'} ${b.name} (${finalEmail}) — $${finalTotal}`);
    res.json({
      ok:         true,
      invoiceId:  finalized.id,
      invoiceUrl: finalized.hosted_invoice_url,
      total:      finalTotal,
      email:      finalEmail,
      charged,
    });
  } catch (err) {
    console.error('[BILLING] Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /portal-admin/debug/order-sample/:brandId — returns raw first order to diagnose field mapping
app.get('/portal-admin/debug/order-sample/:brandId', requirePortalAdmin, async (req, res) => {
  const brands   = loadBrands();
  const brandIdx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[brandIdx];
  if (!brand.tiktokShopToken?.access_token) return res.json({ error: 'No TikTok token' });
  try {
    const now   = Math.floor(Date.now() / 1000);
    const start = now - 90 * 24 * 60 * 60; // 90 days back
    const resp  = await ttsBrandPost(brand, brands, brandIdx, '/order/202309/orders/search', {
      create_time_ge: start, create_time_lt: now, sort_field: 'create_time', sort_order: 'DESC',
    }, { page_size: 5 });
    const orders = resp?.data?.orders || resp?.data?.order_list || [];
    res.json({ total: orders.length, sample: orders.slice(0, 2) });
  } catch(e) {
    res.status(500).json({ error: e.message, body: e.response?.data });
  }
});

// POST /portal-admin/fix-shop-cipher/:brandId — refresh token + fetch + store shop_cipher for a brand
app.post('/portal-admin/fix-shop-cipher/:brandId', requirePortalAdmin, async (req, res) => {
  let brands   = loadBrands();
  const brandIdx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });

  const appKey = process.env.TIKTOK_SHOP_APP_KEY;
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET;

  // Step 1: always try to refresh the token first (force refresh regardless of expires_at)
  const tok = brands.clients[brandIdx].tiktokShopToken;
  if (!tok?.access_token && !tok?.refresh_token) return res.status(400).json({ error: 'No token for this brand' });

  let activeToken = tok.access_token;
  if (tok.refresh_token) {
    try {
      const { data: rd } = await axios.get('https://auth.tiktok-shops.com/api/v2/token/refresh', {
        params: { app_key: appKey, app_secret: appSecret, refresh_token: tok.refresh_token, grant_type: 'refresh_token' },
      });
      if (rd?.code === 0 && rd?.data?.access_token) {
        const expireVal = rd.data.access_token_expire_in;
        const expiresAt = (() => {
      // TikTok access_token_expire_in is an ABSOLUTE Unix timestamp.
      // Distinguish ms-epoch (>1e12), seconds-epoch (1e9..1e12 -> *1000), or a raw duration in seconds (<1e9 -> now + dur*1000).
      const v = Number(expireVal) || 0;
      if (v > 1e12) return v;                       // already milliseconds
      if (v > 1e9)  return v * 1000;                // seconds-epoch -> ms
      return Date.now() + (v || 86400) * 1000;      // raw duration in seconds
    })();
        brands = loadBrands(); // reload in case of concurrent writes
        brands.clients[brandIdx].tiktokShopToken = {
          ...brands.clients[brandIdx].tiktokShopToken,
          access_token:  rd.data.access_token,
          refresh_token: rd.data.refresh_token || tok.refresh_token,
          expires_at:    expiresAt,
        };
        saveBrands(brands);
        activeToken = rd.data.access_token;
        console.log(`[fix-shop-cipher] Token refreshed for ${brands.clients[brandIdx].name}, expires ${new Date(expiresAt).toISOString()}`);
      } else {
        console.warn(`[fix-shop-cipher] Token refresh failed for brand ${req.params.brandId}:`, rd);
        return res.json({ ok: false, step: 'token_refresh', message: 'Token refresh failed — brand must reconnect TikTok', raw: rd });
      }
    } catch(e) {
      console.error(`[fix-shop-cipher] Refresh error:`, e.message, e.response?.data);
      return res.json({ ok: false, step: 'token_refresh', message: e.message, raw: e.response?.data });
    }
  }

  // Step 2: fetch shop cipher with fresh token
  try {
    const allParams = { app_key: appKey, timestamp: Math.floor(Date.now() / 1000) };
    allParams.sign  = signTTShop('/authorization/202309/shops', allParams, '');
    const shopRes   = await axios.get(`${TTS_BASE}/authorization/202309/shops`, {
      params:  allParams,
      headers: { 'content-type': 'application/json', 'x-tts-access-token': activeToken },
    });
    const shop = shopRes.data?.data?.shops?.[0];
    if (!shop) return res.json({ ok: false, step: 'shop_fetch', raw: shopRes.data, message: 'No shop returned from TikTok' });

    brands = loadBrands();
    brands.clients[brandIdx].tiktokShopToken = {
      ...brands.clients[brandIdx].tiktokShopToken,
      shop_cipher: shop.cipher,
      shop_id:     shop.id,
      shop_name:   shop.name,
      shop_region: shop.region,
    };
    if (!brands.clients[brandIdx].shopId) brands.clients[brandIdx].shopId = shop.id;
    saveBrands(brands);
    res.json({ ok: true, shop_name: shop.name, shop_cipher: shop.cipher, shop_id: shop.id });
  } catch(e) {
    res.status(500).json({ error: e.message, step: 'shop_fetch', raw: e.response?.data });
  }
});

// PATCH /portal-admin/campaign-links/:brandId — update campaign links without CF Access
app.patch('/portal-admin/campaign-links/:brandId', requirePortalAdmin, express.json(), (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  if (!brands.clients[idx].creatorPage) brands.clients[idx].creatorPage = {};
  const cp = brands.clients[idx].creatorPage;
  if (!cp.campaigns) cp.campaigns = {};
  const { cashbackUrl, quantityVideoUrl, leaderboardUrl, blitzUrl, sprintUrl, reimbursementUrl } = req.body;
  if (cashbackUrl      !== undefined) cp.campaigns.cashbackUrl      = cashbackUrl      || null;
  if (quantityVideoUrl !== undefined) cp.campaigns.quantityVideoUrl = quantityVideoUrl || null;
  if (leaderboardUrl   !== undefined) cp.campaigns.leaderboardUrl   = leaderboardUrl   || null;
  if (blitzUrl         !== undefined) cp.campaigns.blitzUrl         = blitzUrl         || null;
  if (sprintUrl        !== undefined) cp.campaigns.sprintUrl        = sprintUrl        || null;
  if (reimbursementUrl !== undefined) cp.campaigns.reimbursementUrl = reimbursementUrl || null;
  cp.updatedAt = new Date().toISOString();
  saveBrands(brands);
  res.json({ ok: true, campaigns: cp.campaigns });
});

// PATCH /portal-admin/creator-video/:brandId — set the embedded brand video on the creator page
app.patch('/portal-admin/creator-video/:brandId', requirePortalAdmin, express.json(), (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId || b.creatorPage?.slug === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  if (!brands.clients[idx].creatorPage) brands.clients[idx].creatorPage = {};
  const cp = brands.clients[idx].creatorPage;
  const { videoUrl, videoTitle, videoSub } = req.body || {};
  if (videoUrl   !== undefined) cp.videoUrl   = videoUrl   ? String(videoUrl).trim()   : null;
  if (videoTitle !== undefined) cp.videoTitle = videoTitle ? String(videoTitle).trim() : null;
  if (videoSub   !== undefined) cp.videoSub   = videoSub   ? String(videoSub).trim()   : null;
  cp.updatedAt = new Date().toISOString();
  saveBrands(brands);
  res.json({ ok: true, videoUrl: cp.videoUrl, videoTitle: cp.videoTitle, videoSub: cp.videoSub });
});

// PATCH /portal-admin/creator-images/:brandId — set the "Use These Pictures" reference images on the creator page
// Body: { images: [{url, caption}] } OR { urls: ["..."] }; empty/[] clears the section so it disappears. Supports gifs.
app.patch('/portal-admin/creator-images/:brandId', requirePortalAdmin, express.json(), (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId || b.creatorPage?.slug === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  if (!brands.clients[idx].creatorPage) brands.clients[idx].creatorPage = {};
  const cp = brands.clients[idx].creatorPage;
  let images = [];
  if (Array.isArray(req.body?.images)) {
    images = req.body.images;
  } else if (Array.isArray(req.body?.urls)) {
    images = req.body.urls.map(u => ({ url: u }));
  }
  cp.referenceImages = images
    .map(i => (typeof i === 'string' ? { url: i } : i))
    .filter(i => i && i.url && String(i.url).trim())
    .map(i => ({ url: String(i.url).trim(), caption: i.caption ? String(i.caption).trim() : '' }))
    .slice(0, 24);
  if (req.body?.imagesTitle !== undefined) cp.imagesTitle = req.body.imagesTitle ? String(req.body.imagesTitle).trim() : null;
  if (req.body?.imagesSub   !== undefined) cp.imagesSub   = req.body.imagesSub   ? String(req.body.imagesSub).trim()   : null;
  cp.updatedAt = new Date().toISOString();
  saveBrands(brands);
  res.json({ ok: true, count: cp.referenceImages.length, referenceImages: cp.referenceImages });
});

// PATCH /portal-admin/creator-accent/:brandId — set the creator-page accent color (accepts brandId or slug)
app.patch('/portal-admin/creator-accent/:brandId', requirePortalAdmin, express.json(), (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId || b.creatorPage?.slug === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  const { accentColor } = req.body || {};
  if (typeof accentColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(accentColor)) {
    return res.status(400).json({ error: 'accentColor must be a hex color like #00f2ea' });
  }
  if (!brands.clients[idx].creatorPage) brands.clients[idx].creatorPage = {};
  const cp = brands.clients[idx].creatorPage;
  cp.accentColor = accentColor;
  cp.updatedAt = new Date().toISOString();
  saveBrands(brands);
  res.json({ ok: true, slug: cp.slug || null, accentColor: cp.accentColor });
});

// PATCH /portal-admin/creator-brief/:brandId — update the structured creator BRIEF on the creator page.
// Source of truth is brands.json (brand.creatorPage.brief). Follows the surgical PATCH pattern:
// looks up by brandId OR creatorPage.slug, mutates ONLY creatorPage.brief (+ timestamps), writes back
// via saveBrands(). Body: { brief: {...} } to REPLACE the brief, or { merge:true, brief:{...} } to
// SHALLOW-MERGE the given keys into the existing brief (preserving untouched brief keys). An explicit
// brief key is REQUIRED — an empty/omitted brief returns 400 so a stray PATCH can never wipe the brief.
// The brief object shape used by the creator page: { hooks:[], frameworks:[], sampleScripts:[],
// talkingPoints:{benefits:[],powerPhrases:[]}, doAndDont:{dos:[],donts:[]}, guideUrl:'' }.
app.patch('/portal-admin/creator-brief/:brandId', requirePortalAdmin, express.json(), (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId || b.creatorPage?.slug === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  if (!brands.clients[idx].creatorPage) brands.clients[idx].creatorPage = {};
  const cp = brands.clients[idx].creatorPage;

  const body = req.body || {};
  const incoming = (body && typeof body === 'object' && body.brief !== undefined) ? body.brief : undefined;
  if (incoming === undefined || incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Body must include a brief object. Send { brief: {...} } to replace, or { merge:true, brief:{...} } to shallow-merge existing brief keys.' });
  }
  const doMerge = body.merge === true;
  if (doMerge && cp.brief && typeof cp.brief === 'object' && !Array.isArray(cp.brief)) {
    cp.brief = { ...cp.brief, ...incoming };
  } else {
    cp.brief = incoming;
  }
  cp.briefUpdatedAt = new Date().toISOString();
  cp.updatedAt = new Date().toISOString();
  saveBrands(brands);
  res.json({ ok: true, brandId: brands.clients[idx].id, slug: cp.slug || null, merged: !!doMerge, brief: cp.brief });
});

// ── TC PRODUCT ALLOW-LIST (prevents full-catalog target collabs) ──────────────
// GET  /portal-admin/tc-products/:brandId  -> { catalog:[{product_id,product_name}], approved:[ids], heroProductId }
// PATCH /portal-admin/tc-products/:brandId  body {productIds:[...]} -> sets cp.tcProductIds (the allow-list)
app.get('/portal-admin/tc-products/:brandId', requirePortalAdmin, async (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId || b.creatorPage?.slug === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[idx];
  const cp = brand.creatorPage || {};
  let catalog = [];
  if (brand.shopId) {
    try {
      const { data } = await axios.post(
        `${CFG.railwayUrl}/affiliate/shops/${brand.shopId}/products`,
        { page: 1, page_size: 100 }, { timeout: 15000 });
      catalog = (data?.data || []).map(p => ({ product_id: String(p.product_id || p.id), product_name: p.product_name || p.name || p.title || '(unnamed)' }));
    } catch (e) { console.error('[tc-products] catalog fetch error:', e.message); }
  }
  res.json({
    ok: true, brand: brand.name, shopId: brand.shopId || null,
    approved: Array.isArray(cp.tcProductIds) ? cp.tcProductIds.map(String) : [],
    heroProductId: cp.tcHeroProductId || null,
    catalog,
  });
});

app.patch('/portal-admin/tc-products/:brandId', requirePortalAdmin, express.json(), (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId || b.creatorPage?.slug === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  let { productIds } = req.body || {};
  if (!Array.isArray(productIds)) return res.status(400).json({ error: 'productIds must be an array of product_id strings' });
  productIds = [...new Set(productIds.map(String).map(x => x.trim()).filter(Boolean))];
  if (!brands.clients[idx].creatorPage) brands.clients[idx].creatorPage = {};
  const cp = brands.clients[idx].creatorPage;
  cp.tcProductIds = productIds;
  cp.tcProductsUpdatedAt = new Date().toISOString();
  saveBrands(brands);
  console.log(`[tc-products] ${brands.clients[idx].name} allow-list set to ${productIds.length} product(s): ${productIds.join(',')}`);
  res.json({ ok: true, brand: brands.clients[idx].name, approved: cp.tcProductIds });
});


// POST /portal-admin/regenerate-brief/:slug — regenerate creator brief for a brand
// Body can include override fields: targetAudience, mainProblem, buyerObjections, customerResults, products, brandMission
app.post('/portal-admin/regenerate-brief/:slug', requirePortalAdmin, express.json(), async (req, res) => {
  const brands = loadBrands();
  const idx    = brands.clients.findIndex(b => b.creatorPage?.slug === req.params.slug);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Brand not found' });
  const brand = brands.clients[idx];
  try {
    const cp = brand.creatorPage || {};
    const ov = req.body || {}; // overrides from request body take priority
    const formData = {
      brandName:       brand.name,
      brandMission:    ov.brandMission    || brand.brandMission  || cp.pitch           || '',
      targetAudience:  ov.targetAudience  || cp.targetAudience   || brand.targetAudience  || '',
      mainProblem:     ov.mainProblem     || cp.mainProblem      || brand.mainProblem     || '',
      buyerObjections: ov.buyerObjections || cp.buyerObjections  || brand.buyerObjections || '',
      customerResults: ov.customerResults || cp.customerResults  || brand.customerResults || '',
      products:        (ov.products || cp.products || brand.products || []).map(p => ({ name: p.name || p.title, description: p.description || p.shopifyDescription || '' })),
    };
    // Save any overrides back to the brand so future regenerations use them
    if (ov.targetAudience)  brands.clients[idx].creatorPage.targetAudience  = ov.targetAudience;
    if (ov.mainProblem)     brands.clients[idx].creatorPage.mainProblem     = ov.mainProblem;
    if (ov.buyerObjections) brands.clients[idx].creatorPage.buyerObjections = ov.buyerObjections;
    if (ov.customerResults) brands.clients[idx].creatorPage.customerResults = ov.customerResults;
    if (ov.products)        brands.clients[idx].creatorPage.products        = ov.products;

    const aiContent   = brand.aiContent   || null;
    // Re-scrape Shopify live so the brief reflects the real store. Fall back to any stored data.
    let shopifyData = brand.shopifyData || null;
    const scrapeUrl = ov.shopifyUrl || ov.website || brand.shopifyUrl || brand.website || cp.website;
    if (scrapeUrl) {
      try {
        const fresh = await scrapeShopify(scrapeUrl);
        if (fresh && fresh.products && fresh.products.length) {
          shopifyData = fresh;
          brands.clients[idx].shopifyData = fresh; // persist so future regens have data
          if (!brand.website && (ov.website || ov.shopifyUrl)) brands.clients[idx].website = ov.website || ov.shopifyUrl; // remember the working URL
          console.log(`[regenerate-brief] scraped ${fresh.products.length} products from ${fresh.domain || scrapeUrl}`);
        } else {
          console.log(`[regenerate-brief] live scrape returned no products for ${scrapeUrl}; using stored shopifyData`);
        }
      } catch (e) { console.error("[regenerate-brief] scrape error:", e.message); }
    }
    const brief = await generateCreatorBrief(formData, shopifyData, aiContent);
    if (!brief) return res.status(500).json({ ok: false, error: 'Brief generation returned null — check ANTHROPIC_API_KEY' });
    brands.clients[idx].creatorPage.brief = brief;
    saveBrands(brands);
    console.log(`[regenerate-brief] Brief regenerated for ${brand.name}`);
    res.json({ ok: true, brand: brand.name, brief });
  } catch (e) {
    console.error('[regenerate-brief] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /portal-admin/debug-brands — list all brand IDs + token status
app.get('/portal-admin/debug-brands', requirePortalAdmin, (req, res) => {
  const brands = loadBrands();
  res.json((brands.clients || []).map(b => ({
    id:           b.id,
    name:         b.name,
    hasToken:     !!b.tiktokShopToken?.access_token,
    shopCipher:   !!b.tiktokShopToken?.shop_cipher,
    tokenExpires: b.tiktokShopToken?.expires_at ? new Date(b.tiktokShopToken.expires_at).toISOString() : null,
    cachedNetGmv: b.cachedNetGmv ?? null,
    shopId:       b.shopId || null,
    website:      b.website || null,
    hasShopifyData: !!(b.shopifyData && Array.isArray(b.shopifyData.products) && b.shopifyData.products.length),
    shopifyProductCount: (b.shopifyData && Array.isArray(b.shopifyData.products)) ? b.shopifyData.products.length : 0,
  })));
});

// POST /portal-admin/backfill-shopify — scrape + persist shopifyData for all real brands; generate missing briefs
// Body: { onlyBrand?: slug, force?: bool (regenerate existing briefs too) }
app.post('/portal-admin/backfill-shopify', requirePortalAdmin, express.json(), async (req, res) => {
  const SKIP = new Set(['Organic Social Marketing', 'D Noor', 'DIAMANDIA', 'Diamandia']);
  const only  = (req.body && req.body.onlyBrand) || null;
  const force = !!(req.body && req.body.force);
  const brands = loadBrands();
  const out = [];
  for (let i = 0; i < (brands.clients || []).length; i++) {
    const b = brands.clients[i];
    const cp = b.creatorPage || {};
    const slug = cp.slug || null;
    if (only && slug !== only && b.name !== only) continue;
    if (!only && SKIP.has(b.name)) { out.push({ name: b.name, action: 'skipped (protected)' }); continue; }
    const url = b.website || cp.website || b.shopifyUrl || null;
    let rec = { name: b.name, slug, website: url, scraped: 0, briefAction: 'none' };
    // 1) scrape + persist shopifyData
    if (url) {
      try {
        const fresh = await scrapeShopify(url);
        if (fresh && Array.isArray(fresh.products) && fresh.products.length) {
          b.shopifyData = fresh;
          rec.scraped = fresh.products.length;
          rec.domain = fresh.domain;
        } else {
          rec.scrapeNote = 'no products returned';
        }
      } catch (e) { rec.scrapeNote = 'scrape error: ' + e.message; }
    } else {
      rec.scrapeNote = 'no website on record';
    }
    // 2) generate brief if missing (or force)
    const hasBrief = !!cp.brief;
    if (!hasBrief || force) {
      try {
        const formData = {
          brandName:       b.name,
          brandMission:    b.brandMission || cp.pitch || cp.brandMission || '',
          targetAudience:  cp.targetAudience  || b.targetAudience  || '',
          mainProblem:     cp.mainProblem     || b.mainProblem     || '',
          buyerObjections: cp.buyerObjections || b.buyerObjections || '',
          customerResults: cp.customerResults || b.customerResults || '',
        };
        const brief = await generateCreatorBrief(formData, b.shopifyData || null, null);
        if (brief) {
          b.creatorPage = b.creatorPage || {};
          b.creatorPage.brief = brief;
          rec.briefAction = hasBrief ? 'regenerated' : 'generated';
          rec.briefLen = JSON.stringify(brief).length;
        } else {
          rec.briefAction = 'generator returned null';
        }
      } catch (e) { rec.briefAction = 'brief error: ' + e.message; }
    } else {
      rec.briefAction = 'kept existing';
    }
    out.push(rec);
  }
  saveBrands(brands);
  res.json({ ok: true, results: out });
});

// GET /portal-admin/brief-inspect — read-only: stored brief + form mission/story fields per brand
app.get('/portal-admin/brief-inspect', requirePortalAdmin, (req, res) => {
  const brands = loadBrands();
  const GENERIC = [/everyday consumer/i, /improves daily life/i, /general consumer/i, /lifestyle/i, /not provided/i];
  res.json((brands.clients || []).map(b => {
    const cp = b.creatorPage || {};
    const brief = cp.brief || null;
    const briefStr = brief ? JSON.stringify(brief) : '';
    const genericHits = GENERIC.filter(re => re.test(briefStr)).map(re => re.source);
    return {
      name: b.name,
      slug: cp.slug || null,
      active: cp.active !== false,
      hasBrief: !!brief,
      briefLen: briefStr.length,
      genericFlags: genericHits,
      mission: b.brandMission || cp.pitch || cp.brandMission || null,
      targetAudience: cp.targetAudience || b.targetAudience || null,
      mainProblem: cp.mainProblem || b.mainProblem || null,
      customerResults: cp.customerResults || b.customerResults || null,
      buyerObjections: cp.buyerObjections || b.buyerObjections || null,
      hasShopifyData: !!(b.shopifyData && Array.isArray(b.shopifyData.products) && b.shopifyData.products.length),
      shopifyProductCount: (b.shopifyData && Array.isArray(b.shopifyData.products)) ? b.shopifyData.products.length : 0,
      website: b.website || null,
      briefPreview: brief ? (typeof brief === 'string' ? brief.slice(0,400) : JSON.stringify(brief).slice(0,400)) : null,
    };
  }));
});

// GET /portal-admin/debug-gmv/:brandId — raw TikTok order API response for a brand
app.get('/portal-admin/debug-gmv/:brandId', requirePortalAdmin, async (req, res) => {
  const brands   = loadBrands();
  const brandIdx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[brandIdx];
  const tok   = brand.tiktokShopToken;
  const info  = {
    name:          brand.name,
    hasToken:      !!tok?.access_token,
    hasShopCipher: !!tok?.shop_cipher,
    tokenExpiresAt: tok?.expires_at ? new Date(tok.expires_at).toISOString() : null,
    tokenExpired:  tok?.expires_at ? Date.now() > tok.expires_at : null,
    shopId:        brand.shopId || null,
    cachedNetGmv:  brand.cachedNetGmv ?? null,
    cachedGmvAt:   brand.cachedGmvAt  ? new Date(brand.cachedGmvAt).toISOString() : null,
  };
  if (!tok?.access_token) return res.json({ info, error: 'No token' });
  const now   = Math.floor(Date.now() / 1000);
  const start = now - 30 * 24 * 60 * 60;
  try {
    // Try token refresh if expired
    if (tok.expires_at && Date.now() > tok.expires_at - 120_000) {
      await refreshBrandShopToken(brand, brands, brandIdx);
    }
    const freshBrand = loadBrands().clients[brandIdx];
    const resp = await ttsBrandPost(freshBrand, brands, brandIdx, '/order/202309/orders/search', {
      create_time_ge: start,
      create_time_lt: now,
      sort_field: 'create_time',
      sort_order: 'DESC',
    }, { page_size: 20 });
    const orders = resp?.data?.orders || resp?.data?.order_list || [];
    const sample = orders.slice(0, 2);
    res.json({ info, resp_code: resp?.code, resp_message: resp?.message, order_count: orders.length, sample_orders: sample, full_data_keys: resp?.data ? Object.keys(resp.data) : [] });
  } catch(e) {
    res.json({ info, error: e.message, axiosResponse: e.response?.data });
  }
});

// Human-readable labels for Growth Partners task keys
const GP_TASK_LABELS = {
  contract_signed:      'Contract signed',
  brand_brief_filled:   'Brand brief filled out',
  brand_approved:       'Brand approved for program',
  onboarding_call:      'Onboarding call completed',
  cogs_provided:        'COGS provided',
  margins_confirmed:    'Margins confirmed',
  commission_set:       'Commission structure set',
  shop_account:         'TikTok Shop account connected',
  shopify:              'Shopify integration set up',
  sellico:              'Sellico connected',
  whitelisting_eligible:'Whitelisting eligibility confirmed',
  reviews:              'Reviews integration',
  fbt:                  'FBT enabled',
  product_samples:      'Product samples arranged',
  bundles_enabled:      'Bundles enabled',
  ugc_source:           'UGC source identified',
  creator_list:         'Creator outreach list built',
  outreach_started:     'Creator outreach started',
  gmv_10k:              'First $10k GMV milestone',
  gmv_50k:              '$50k GMV milestone',
  video_plan:           'Video content plan created',
  first_batch_live:     'First batch of videos live',
  '10_videos_live':     '10+ videos live',
  top_performer_id:     'Top performing creator identified',
  spark_ads_enabled:    'Spark Ads enabled',
  first_campaign:       'First ad campaign launched',
  roas_positive:        'Positive ROAS achieved',
  live_eligible:        'TikTok Live eligible',
  first_live:           'First live stream completed',
  live_regular:         'Regular live cadence established',
};

// ─── Billing tiers (from client contract template) ───────────────────────────
const BILLING_TIERS = [
  { retainer: 1500, commRate: 0.10 },
  { retainer: 2000, commRate: 0.09 },
  { retainer: 2500, commRate: 0.08 },
  { retainer: 3000, commRate: 0.07 },
  { retainer: 3500, commRate: 0.06 },
  { retainer: 4000, commRate: 0.05 },
  { retainer: 4500, commRate: 0.04 },
  { retainer: 5000, commRate: 0.03 },
];

// GET /api/client/billing — current tier, GMV, payment method, recent invoices
app.get('/api/client/billing', requireClientSession, async (req, res) => {
  try {
    const brands   = loadBrands();
    const brandIdx = (brands.clients || []).findIndex(b => b.id === req.session.clientBrandId);
    if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });
    const brand = brands.clients[brandIdx];

    const retainer  = brand.retainer  ?? brand.contractValue  ?? 1500;
    const commRate  = brand.commissionRate ?? 0.10;
    const gmv       = brand.cachedNetGmv ?? 0;
    const revShare  = parseFloat((gmv * commRate).toFixed(2));

    // Billing cycle info
    const cycle = billingCycle();

    // Payment method
    const hasPaymentMethod = await stripeHasPaymentMethod(brand.stripeCustomerId);

    // Recent invoices from Stripe
    let invoices = [];
    if (stripe && brand.stripeCustomerId) {
      try {
        const list = await stripe.invoices.list({ customer: brand.stripeCustomerId, limit: 12 });
        invoices = list.data.map(inv => ({
          id:      inv.id,
          date:    new Date(inv.created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          amount:  inv.amount_paid / 100,
          status:  inv.status,
          url:     inv.hosted_invoice_url,
          period:  inv.metadata?.period || '',
        }));
      } catch(_) {}
    }

    // Pending tier change (takes effect next month)
    const pendingTier = brand.pendingTierChange || null;

    res.json({
      currentTier:  { retainer, commRate },
      pendingTier,
      gmv,
      revShare,
      tiers:        BILLING_TIERS,
      cycle:        { period: cycle.period, nextBillingLabel: cycle.nextBillingLabel, daysUntilBilling: cycle.daysUntilBilling },
      hasPaymentMethod,
      portalUrl:    brand.stripeCustomerId && stripe ? null : null, // populated below
      invoices,
    });
  } catch (err) {
    console.error('[client/billing] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/client/billing/portal — Stripe Customer Portal link for client to add/update payment method
app.get('/api/client/billing/portal', requireClientSession, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  try {
    const brands   = loadBrands();
    const brandIdx = (brands.clients || []).findIndex(b => b.id === req.session.clientBrandId);
    if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });
    const brand = brands.clients[brandIdx];

    let customerId = brand.stripeCustomerId;
    if (!customerId) {
      // Create a Stripe customer for this brand
      const bill = clientBilling(brand);
      const email = bill.billingEmail || brand.loginEmail || '';
      const customer = await stripe.customers.create({
        name:  brand.name,
        ...(email ? { email } : {}),
        metadata: { brandId: brand.id, source: 'cult-content-billing' },
      });
      customerId = customer.id;
      brands.clients[brandIdx].stripeCustomerId = customerId;
      saveBrands(brands);
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${CREATOR_BASE_URL}/client/dashboard`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[client/billing/portal] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/client/billing/change-tier — client selects a new billing tier
app.post('/api/client/billing/change-tier', requireClientSession, express.json(), async (req, res) => {
  try {
    const { retainer, commRate } = req.body || {};
    const tier = BILLING_TIERS.find(t => t.retainer === Number(retainer) && Math.abs(t.commRate - Number(commRate)) < 0.0001);
    if (!tier) return res.status(400).json({ error: 'Invalid tier' });

    const brands   = loadBrands();
    const brandIdx = (brands.clients || []).findIndex(b => b.id === req.session.clientBrandId);
    if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });

    // Compute effective date: 1st of next month
    const now = new Date();
    const effective = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const effectiveLabel = effective.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const brandName = brands.clients[brandIdx].name;
    const oldRetainer = brands.clients[brandIdx].retainer ?? brands.clients[brandIdx].contractValue ?? 1500;
    const oldCommRate = brands.clients[brandIdx].commissionRate ?? 0.10;

    brands.clients[brandIdx].pendingTierChange = {
      retainer:     tier.retainer,
      commRate:     tier.commRate,
      requestedAt:  Date.now(),
      effectiveDate: effective.toISOString().slice(0, 10),
      effectiveLabel,
    };
    saveBrands(brands);

    console.log(`[BILLING] ${brandName} requested tier change → $${tier.retainer} + ${Math.round(tier.commRate*100)}% GMV (effective ${effectiveLabel})`);

    // Lark alert
    const oldPlan = `$${oldRetainer.toLocaleString()}/mo + ${Math.round(oldCommRate * 100)}% GMV`;
    const newPlan = `$${tier.retainer.toLocaleString()}/mo + ${Math.round(tier.commRate * 100)}% GMV`;
    axios.post(`${CFG.railwayUrl}/command`, {
      text: `💳 *Plan Change Request* — ${brandName}\nFrom: ${oldPlan}\nTo: ${newPlan}\nEffective: ${effectiveLabel}`,
      context: 'Billing',
      source:  'Client Portal',
    }, { timeout: 5000 }).catch(() => {});

    res.json({ ok: true, effectiveLabel, tier });
  } catch (err) {
    console.error('[client/billing/change-tier] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/client/me — return brand data, TikTok stats, tasks, referral info
app.get('/api/client/me', requireClientSession, async (req, res) => {
  try {
    const brands = loadBrands();
    const brandIdx = (brands.clients || []).findIndex(b => b.id === req.session.clientBrandId);
    if (brandIdx === -1) { req.session.destroy(); return res.status(404).json({ error: 'Brand not found' }); }
    const brand = brands.clients[brandIdx];

    // Auto-generate referral code if missing
    if (!brand.referralCode) {
      brand.referralCode = brand.name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || brand.id;
      brands.clients[brandIdx] = brand;
      saveBrands(brands);
    }

    // TikTok Shop stats — pull from Reacher summary (authoritative) + TikTok token for top creators
    let tiktokStats = null, tiktokFunnel = null, tiktokConnected = false, tiktokNeedsReconnect = false;
    if (brand.tiktokShopToken?.access_token) {
      tiktokConnected = true;
      // If no shop_cipher, the token is incomplete — brand needs to reconnect
      // shop_cipher is optional for single-shop sellers — don't force reconnect just for missing cipher
      try {
        const shopId = brand.shopId;

        // GMV: Use shared fetchNetGmvForBrand (Finance → Earnings Analytics, with orders fallback)
        let gmv = 0, activeCreators = 0;
        try {
          const liveGmv = await fetchNetGmvForBrand(brand, brands, brandIdx);
          if (liveGmv !== null) gmv = liveGmv;
        } catch(e) {
          console.error('[client/me] GMV fetch error:', e.message);
          if (e.response?.status === 401 || e.message?.includes('401')) tiktokNeedsReconnect = true;
        }

        // Active creators from Reacher
        if (shopId && activeCreators === 0) {
          try {
            const s = (await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shopId}/summary`, { timeout: 8000 })).data;
            activeCreators = parseInt(s.active_creators || 0, 10);
          } catch(_) {}
        }

        tiktokStats = { gmv, orders: 0, active_creators: activeCreators };

        // Top creators: fetch from Reacher creators endpoint
        const topCreatorsArr = [];
        if (shopId) {
          try {
            const tcRes = await axios.get(
              `${CFG.railwayUrl}/affiliate/shops/${shopId}/creators/top`,
              { timeout: 10000 }
            );
            const list = tcRes.data?.creators || tcRes.data?.data || [];
            topCreatorsArr.push(...list.slice(0, 6).map(c => ({
              handle: c.creator_handle || c.username,
              gmv:    parseFloat(c.gmv || c.shop_gmv || c.sale_amount || 0),
            })));
          } catch(_) {}
        }
        if (true) { // keep scope consistent
        }

        tiktokFunnel = { top_creators: topCreatorsArr, top_videos: [] };
      } catch (e) {
        console.error('[client/me] TikTok Shop stats error:', e.message);
      }
    }

    // Tasks — pull action items from client-meetings.json tagged to this brand
    const meetings = loadClientMeetings();
    const tasks = [];
    const brandNameLower = brand.name.toLowerCase().trim();
    for (const meeting of (meetings.meetings || [])) {
      for (const item of (meeting.actionItems || [])) {
        if (!item.client) continue;
        const cl = item.client.toLowerCase().trim();
        if (cl === brandNameLower || brandNameLower.includes(cl) || cl.includes(brandNameLower)) {
          tasks.push({
            title: item.task,
            status: item.done ? 'done' : 'in-progress',
            priority: item.priority || 'medium',
            assignee: item.assignee || null,
            updatedAt: meeting.updatedAt || meeting.createdAt,
            source: meeting.title || 'Meeting',
          });
        }
      }
    }

    const referralUrl = `https://cultcontent.cc/growth-partner?ref=${brand.referralCode}`;
    const compensation = brand.creatorPage?.incentives || null;

    res.json({
      brand: {
        id: brand.id,
        name: brand.name,
        industry: brand.industry,
        tiktokHandle: brand.tiktokHandle,
        shopId: brand.shopId || null,
        sampleBudget: brand.sampleBudget || 0,
        compensation,
        creatorPageHeadline: brand.creatorPage?.headline || null,
        creatorPageCampaigns: brand.creatorPage?.campaigns || null,
        innerCircle: !!brand.innerCircle,
        logoUrl: brand.logoUrl || null,
        brandColor: brand.brandColor || null,
        referralCode: brand.referralCode,
        commissionRate: brand.commissionRate ?? 0.10,
        referralUrl,
        estimatedCommission: brand.estimatedCommission || 0,
        referrals: brand.referrals || [],
        affiliatePageUrl: brand.affiliatePageUrl || (brand.creatorPage?.slug ? `${CREATOR_BASE_URL}/creators/${brand.creatorPage.slug}` : ''),
        connections: {
          bufferConnected:   !!brand.bufferConnected,
          arcadsConnected:   !!brand.arcadsConnected,
          storistaConnected: !!brand.storistaConnected,
        },
      },
      tiktok: { connected: tiktokConnected, needsReconnect: tiktokNeedsReconnect || (tiktokConnected && !brand.tiktokShopToken?.shop_cipher), hasShopCipher: !!(brand.tiktokShopToken?.shop_cipher), stats: tiktokStats, funnel: tiktokFunnel },
      tasks,
      adminImpersonating: req.session.adminImpersonating || null,
    });
  } catch (e) {
    const brands = loadBrands();
    const brand = (brands.clients || []).find(b => b.id === req.session?.clientBrandId);
    sendClientBugReport({ brandName: brand?.name, brandId: req.session?.clientBrandId, route: 'GET /api/client/me', error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/inner-circle/funnel — brand-scoped Inner Circle funnel for the
// logged-in client. Resolves the brand's OWN shopId from the session
// (req.session.clientBrandId → brand.shopId); the shopId is NEVER taken from
// the request, so a brand can only ever see its own IC signups and cannot
// pass an arbitrary shopId to view another brand's data. Mirrors the admin
// funnel (/api/inner-circle/admin/funnel) response/error handling.
app.get('/api/inner-circle/funnel', requireClientSession, async (req, res) => {
  try {
    const brands = loadBrands();
    const brand = (brands.clients || []).find(b => b.id === req.session.clientBrandId);
    if (!brand) { req.session.destroy(); return res.status(404).json({ error: 'Brand not found' }); }

    const shopId = brand.shopId;
    if (!shopId) {
      // Brand has no connected shop yet — return an empty, well-formed funnel
      // rather than an error so the portal UI can render an empty state.
      return res.json({ shopId: null, creators: [], summary: { signed_up: 0, tc_accepted: 0, sample_requested: 0, total: 0 } });
    }

    if (!icSqlite || typeof icSqlite.getIcFunnel !== 'function') {
      return res.status(503).json({ error: 'IC funnel layer unavailable' });
    }

    const out = await icSqlite.getIcFunnel(shopId);
    if (out && out.error && (!out.creators || !out.creators.length)) {
      // Hard data-layer failure (e.g. DB unavailable) → 503; partial Reacher
      // outages still return 200 with summary.reacherError set.
      return res.status(503).json(out);
    }
    return res.json(out);
  } catch (e) {
    console.error('[inner-circle/funnel] failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// PATCH /api/client/settings — update sample budget + full compensation config
app.patch('/api/client/settings', requireClientSession, express.json(), async (req, res) => {
  try {
    const brands = loadBrands();
    const idx = (brands.clients || []).findIndex(b => b.id === req.session.clientBrandId);
    if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
    const brand = brands.clients[idx];
    const { sampleBudget, compensation, affiliatePageUrl, innerCircle, brandColor, headline, campaigns } = req.body || {};
    // brandColor — validate BEFORE any mutation/persistence; reject invalid hex
    if (brandColor !== undefined && (typeof brandColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(brandColor))) {
      return res.status(400).json({ error: 'brandColor must be a hex color like #00f2ea' });
    }
    if (brandColor !== undefined) brand.brandColor = brandColor;
    if (sampleBudget !== undefined) brand.sampleBudget = Number(sampleBudget) || 0;
    if (compensation && typeof compensation === 'object') {
      if (!brand.creatorPage) brand.creatorPage = {};
      brand.creatorPage.incentives = compensation;
    }
    if (affiliatePageUrl !== undefined) brand.affiliatePageUrl = affiliatePageUrl || '';

    // Campaign headline (hero <h1> on the creator page) — persisted to creatorPage.headline
    if (headline !== undefined) {
      if (!brand.creatorPage) brand.creatorPage = {};
      brand.creatorPage.headline = headline === null ? null : String(headline).slice(0, 200);
    }

    // Reacher campaign CTA links (rendered on the /welcome page) — only http(s) URLs accepted
    if (campaigns && typeof campaigns === 'object') {
      if (!brand.creatorPage) brand.creatorPage = {};
      if (!brand.creatorPage.campaigns) brand.creatorPage.campaigns = {};
      const URL_KEYS = ['blitzUrl', 'cashbackUrl', 'quantityVideoUrl', 'leaderboardUrl'];
      for (const k of URL_KEYS) {
        if (campaigns[k] === undefined) continue;
        const v = campaigns[k];
        if (v === '' || v === null) { brand.creatorPage.campaigns[k] = ''; continue; }
        if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) {
          return res.status(400).json({ error: `${k} must be empty or an http(s) URL` });
        }
        brand.creatorPage.campaigns[k] = v.trim();
      }
    }

    // Integration keys — store them, never return them in plain text
    if (req.body.bufferToken)     { brand.bufferToken     = req.body.bufferToken;     brand.bufferConnected = true; }
    if (req.body.arcadsClientId)  { brand.arcadsClientId  = req.body.arcadsClientId; }
    if (req.body.arcadsApiKey)    { brand.arcadsApiKey     = req.body.arcadsApiKey;    brand.arcadsConnected = true; }
    if (req.body.storistaApiKey)  { brand.storistaApiKey  = req.body.storistaApiKey;  brand.storistaConnected = true; }

    // Inner Circle toggle — send Lark alert when it changes
    if (innerCircle !== undefined && !!innerCircle !== !!brand.innerCircle) {
      const status  = innerCircle ? 'ENABLED ✅' : 'DISABLED ❌';
      const emoji   = innerCircle ? '🌀' : '🔕';
      const now     = new Date();
      const nextMo  = new Date(now.getFullYear(), now.getMonth() + 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      axios.post(`${CFG.railwayUrl}/command`, {
        text: `${emoji} *Inner Circle ${status}* for *${brand.name}*\nEffective: ${nextMo}\nInner Circle: dedicated creators posting 15+ videos/mo, 50% commission + 25% on ads.`,
        context: 'Inner Circle Toggle',
        source: 'Client Dashboard',
      }, { timeout: 5000 }).catch(e => console.error('[inner-circle] lark error:', e.message));
      brand.innerCircle = !!innerCircle;
    }

    brands.clients[idx] = brand;
    saveBrands(brands);
    res.json({ ok: true });
  } catch (e) {
    sendClientBugReport({ brandId: req.session?.clientBrandId, route: 'PATCH /api/client/settings', error: e.message });
    res.status(500).json({ error: e.message });
  }
});



// POST /api/client/referrals — log a brand the client referred
app.post('/api/client/referrals', requireClientSession, express.json(), (req, res) => {
  try {
    const brands = loadBrands();
    const idx = (brands.clients || []).findIndex(b => b.id === req.session.clientBrandId);
    if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
    const { name, email, company } = req.body || {};
    if (!name && !email) return res.status(400).json({ error: 'Name or email required' });
    const referral = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || '', email: email || '', company: company || '',
      addedAt: new Date().toISOString(),
    };
    if (!brands.clients[idx].referrals) brands.clients[idx].referrals = [];
    brands.clients[idx].referrals.push(referral);
    saveBrands(brands);
    res.json({ ok: true, referral });
  } catch (e) {
    sendClientBugReport({ brandId: req.session?.clientBrandId, route: 'POST /api/client/referrals', error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/tasks — read-only view of Ops Engine tasks for this brand
// Fetches from Lark Bitable (same base as /my-tasks) filtered by brand name.
// Returns: { tasks: [...], brandName }  — clients cannot write to tasks.
const OPS_APP_TOKEN_CLI = 'EsfBbIqfkauKozsxMHMuilDztod';
const TASKS_TABLE_CLI   = 'tbl7XaSc37mtcBKg';
const CLIENTS_TABLE_CLI = 'tblgM1L7myeAfYQm';

app.get('/api/client/tasks', requireClientSession, async (req, res) => {
  try {
    const brands = loadBrands();
    const brand = (brands.clients || []).find(b => b.id === req.session.clientBrandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    const brandName = brand.name;

    // Use OPS_LARK_APP_ID when set (dedicated Bitable app) — same logic as ops-my-tasks.
    let token;
    const opsAppId = process.env.OPS_LARK_APP_ID || process.env.LARK_APP_ID;
    const opsAppSecret = process.env.OPS_LARK_APP_SECRET || process.env.LARK_APP_SECRET;
    if (opsAppId && opsAppSecret) {
      const tr = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
        { app_id: opsAppId, app_secret: opsAppSecret }, { timeout: 10000 });
      token = tr.data.tenant_access_token;
    } else {
      token = await getLarkTenantToken();
    }
    const larkGet = (path, params) =>
      axios.get(`https://open.larksuite.com${path}`, {
        headers: { Authorization: `Bearer ${token}` }, params, timeout: 20000,
      }).then(r => r.data);

    // Build clients record_id → name map
    const clientsMap = {};
    let cPageToken = null;
    for (let g = 0; g < 5; g++) {
      const params = { page_size: 500 };
      if (cPageToken) params.page_token = cPageToken;
      const cd = await larkGet(`/open-apis/bitable/v1/apps/${OPS_APP_TOKEN_CLI}/tables/${CLIENTS_TABLE_CLI}/records`, params);
      if (cd.code !== 0) break;
      for (const it of (cd.data?.items || [])) {
        const f = it.fields || {};
        const name = [f['Brand'], f['Client'], f['Name'], f['Brand Name']]
          .map(v => (typeof v === 'string' ? v : (Array.isArray(v) && v[0]) ? (v[0].text || v[0].name || '') : ''))
          .find(v => v) || '';
        if (name) clientsMap[it.record_id] = name;
      }
      cPageToken = cd.data?.has_more ? cd.data.page_token : null;
      if (!cPageToken) break;
    }

    // Helper: extract text from any Bitable field value
    const txt = v => {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
      if (Array.isArray(v)) {
        const f = v[0];
        if (f && typeof f === 'object') return f.text_arr?.[0] || f.text || f.name || '';
        return v.map(x => typeof x === 'string' ? x : (x?.text || x?.name || '')).join(', ');
      }
      return v.text || v.link || '';
    };

    // Collect matching tasks (paginate)
    const tasks = [];
    let tPageToken = null;
    for (let g = 0; g < 20; g++) {
      const params = { page_size: 500 };
      if (tPageToken) params.page_token = tPageToken;
      const td = await larkGet(`/open-apis/bitable/v1/apps/${OPS_APP_TOKEN_CLI}/tables/${TASKS_TABLE_CLI}/records`, params);
      if (td.code !== 0) break;
      for (const rec of (td.data?.items || [])) {
        const f = rec.fields || {};
        if (txt(f.Status) === 'Completed') continue;
        // Resolve client name from link field or clients map
        let client = txt(f.Client);
        if (!client) {
          const links = Array.isArray(f.Client) ? f.Client : [];
          for (const lnk of links) {
            if (Array.isArray(lnk?.record_ids)) {
              for (const rid of lnk.record_ids) { if (clientsMap[rid]) { client = clientsMap[rid]; break; } }
            }
          }
        }
        if (!client || client.toLowerCase() !== brandName.toLowerCase()) continue;
        tasks.push({
          record_id: rec.record_id,
          task:          txt(f.Task),
          status:        txt(f.Status),
          pillar:        txt(f.Pillar),
          phase:         txt(f.Phase),
          priority:      txt(f.Priority),
          executionMode: txt(f['Execution Mode']),
          promptAction:  txt(f['Prompt / Action']),
          dueDate:       f['Due Date'] || null,
          category:      txt(f.Category),
        });
      }
      tPageToken = td.data?.has_more ? td.data.page_token : null;
      if (!tPageToken) break;
    }

    res.json({ ok: true, brandName, tasks });
  } catch (e) {
    console.error('[client-tasks] error:', e.message);
    res.status(500).json({ error: 'Failed to load tasks', detail: e.message });
  }
});

// POST /api/client/error — client-side error beacon
app.post('/api/client/error', requireClientSession, express.json(), async (req, res) => {
  const { message, stack, url, line } = req.body || {};
  if (!message) return res.json({ ok: true });
  const brands = loadBrands();
  const brand = (brands.clients || []).find(b => b.id === req.session.clientBrandId);
  sendClientBugReport({
    brandName: brand?.name,
    brandId: req.session.clientBrandId,
    route: url || 'client JS',
    error: message,
    type: 'client',
    extra: stack ? `Stack: \`${String(stack).slice(0, 200)}\`` : (line ? `Line: ${line}` : ''),
  });
  res.json({ ok: true });
});

// GET /client/tiktok/auth — client portal: initiate TikTok Shop OAuth for the logged-in brand
app.get('/client/tiktok/auth', requireClientSession, (req, res) => {
  // Build TikTok Shop OAuth URL directly — avoids routing through CF-protected /api/tiktokshop/auth
  const appKey     = process.env.TIKTOK_SHOP_APP_KEY;
  const redirectUri = process.env.TIKTOK_SHOP_REDIRECT_URI || 'https://portal.cultcontent.cc/api/tiktokshop/callback';
  if (!appKey) return res.status(500).send('TikTok Shop not configured');
  const state = Buffer.from(JSON.stringify({ brandId: req.session.clientBrandId })).toString('base64');
  const authUrl = `https://auth.tiktok-shops.com/oauth/authorize?` +
    `app_key=${encodeURIComponent(appKey)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;
  res.redirect(authUrl);
});

// POST /client/admin — token-gated brand management (no CF auth needed; used by internal tooling)
// Actions: create-brand, set-creds, update-brand, list-brands
app.post('/client/admin', express.json(), async (req, res) => {
  const { token, action, ...payload } = req.body || {};
  if (token !== 'cc-admin-2026') return res.status(403).json({ error: 'bad token' });
  try {
    const brands = loadBrands();
    if (action === 'list-brands') {
      return res.json({ ok: true, brands: brands.clients.map(b => ({ id: b.id, name: b.name, loginEmail: b.loginEmail })) });
    }
    if (action === 'create-brand') {
      const { name, loginEmail, password, ...rest } = payload;
      if (!name) return res.status(400).json({ error: 'name required' });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const brand = { id, createdAt: new Date().toISOString(), name, ...rest };
      if (loginEmail) brand.loginEmail = loginEmail.toLowerCase().trim();
      if (password)   brand.passwordHash = bcrypt.hashSync(password, 12);
      brands.clients.push(brand);
      saveBrands(brands);
      return res.json({ ok: true, brand: { id, name: brand.name, loginEmail: brand.loginEmail } });
    }
    if (action === 'set-creds') {
      const { brandId, email, password } = payload;
      if (!brandId) return res.status(400).json({ error: 'brandId required' });
      const idx = brands.clients.findIndex(b => b.id === brandId);
      if (idx === -1) return res.status(404).json({ error: 'brand not found' });
      if (email)                    brands.clients[idx].loginEmail   = email.toLowerCase().trim();
      if (password)                 brands.clients[idx].passwordHash = bcrypt.hashSync(password, 12);
      if (payload.clearPassword)    delete brands.clients[idx].passwordHash;
      saveBrands(brands);
      return res.json({ ok: true, id: brandId, loginEmail: brands.clients[idx].loginEmail });
    }
    if (action === 'update-brand') {
      const { brandId, ...fields } = payload;
      if (!brandId) return res.status(400).json({ error: 'brandId required' });
      const idx = brands.clients.findIndex(b => b.id === brandId);
      if (idx === -1) return res.status(404).json({ error: 'brand not found' });
      Object.assign(brands.clients[idx], fields);
      saveBrands(brands);
      return res.json({ ok: true, brand: brands.clients[idx] });
    }
    // Merge stubId → keepId: copy TikTok token + key data from stub into keeper, delete stub
    if (action === 'merge-and-delete') {
      const { keepId, stubId } = payload;
      if (!keepId || !stubId) return res.status(400).json({ error: 'keepId and stubId required' });
      const keepIdx = brands.clients.findIndex(b => b.id === keepId);
      const stubIdx = brands.clients.findIndex(b => b.id === stubId);
      if (keepIdx === -1) return res.status(404).json({ error: 'keep brand not found' });
      if (stubIdx === -1) return res.status(404).json({ error: 'stub brand not found' });
      const stub = brands.clients[stubIdx];
      const keep = brands.clients[keepIdx];
      // Copy over fields that stub has but keeper doesn't (or that stub has fresher data for)
      const copyFields = [
        'tiktokShopToken', 'tiktokConnected', 'shopId',
        'passwordHash', 'storistaApiKey', 'storistaConnected', 'storistaQueue',
        'bufferToken', 'bufferConnected', 'arcadsClientId', 'arcadsApiKey', 'arcadsConnected',
        'contentAssets', 'logoUrl', 'brandColor', 'cachedNetGmv', 'cachedGmvAt', 'stripeCustomerId',
        'lastInvoiceId', 'lastInvoiceUrl', 'lastInvoicedAt',
      ];
      for (const f of copyFields) {
        if (stub[f] !== undefined && stub[f] !== null && stub[f] !== '') {
          keep[f] = stub[f];
        }
      }
      // Remove the stub
      brands.clients.splice(stubIdx, 1);
      saveBrands(brands);
      return res.json({ ok: true, merged: keep.name, deleted: stub.name });
    }
    // Delete a brand by id
    if (action === 'delete-brand') {
      const { brandId } = payload;
      if (!brandId) return res.status(400).json({ error: 'brandId required' });
      const idx = brands.clients.findIndex(b => b.id === brandId);
      if (idx === -1) return res.status(404).json({ error: 'brand not found' });
      const name = brands.clients[idx].name;
      brands.clients.splice(idx, 1);
      saveBrands(brands);
      return res.json({ ok: true, deleted: name });
    }
    res.status(400).json({ error: `unknown action: ${action}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Client portal: Buffer channel proxy ─────────────────────────────────────
// GET /api/client/buffer/channels
app.get('/api/client/buffer/channels', requireClientSession, async (req, res) => {
  try {
    const brands = loadBrands();
    const brand = brands.clients.find(b => b.id === req.session.clientBrandId);
    const token = brand?.bufferToken || process.env.BUFFER_ACCESS_TOKEN;
    const orgId = process.env.BUFFER_ORG_ID || '69d6ddee1fcceb5bb1faa168';
    const query = `query { organization(id:"${orgId}") { channels { id name service serviceId avatarUrl } } }`;
    const { data } = await axios.post('https://api.buffer.com/graphql',
      { query },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ ok: true, channels: data.data?.organization?.channels || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/buffer/post-to-channels
app.post('/api/client/buffer/post-to-channels', requireClientSession, express.json(), async (req, res) => {
  try {
    const { channelIds = [], text, mediaUrl, scheduledAt } = req.body || {};
    if (!channelIds.length) return res.status(400).json({ error: 'No channels selected' });
    const brands = loadBrands();
    const brand = brands.clients.find(b => b.id === req.session.clientBrandId);
    const token = brand?.bufferToken || process.env.BUFFER_ACCESS_TOKEN;
    const results = [];
    for (const channelId of channelIds) {
      const mode = scheduledAt ? 'customScheduled' : 'shareNow';
      const assets = mediaUrl ? { videos: [{ url: mediaUrl }] } : undefined;
      const mutation = `mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id } } ... on MutationError { extensions { code } message } } }`;
      const variables = { input: { channelId, text, schedulingType: 'automatic', mode, ...(scheduledAt ? { dueAt: scheduledAt } : {}), ...(assets ? { assets } : {}) } };
      const { data } = await axios.post('https://api.buffer.com/graphql',
        { query: mutation, variables },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      results.push({ channelId, result: data });
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Client portal: Arcads proxy ─────────────────────────────────────────────
// GET /api/client/arcads/stats
app.get('/api/client/arcads/stats', requireClientSession, async (req, res) => {
  try {
    const brands = loadBrands();
    const brand = brands.clients.find(b => b.id === req.session.clientBrandId);
    const appKey    = brand?.arcadsClientId  || process.env.ARCADS_APP_KEY || process.env.ARCADS_CLIENT_ID;
    const appSecret = brand?.arcadsApiKey    || process.env.ARCADS_API_KEY;
    const auth = 'Basic ' + Buffer.from(`${appKey}:${appSecret}`).toString('base64');
    const base = 'https://external-api.arcads.ai';
    const folderId = process.env.ARCADS_FOLDER_ID || 'cb163f1f-6863-47a2-b984-2f5d384fff1a';
    const { data: scriptsData } = await axios.get(`${base}/api/v1/scripts`, {
      params: { folder_id: folderId },
      headers: { Authorization: auth }
    });
    const scripts = scriptsData?.data?.scripts || scriptsData?.scripts || [];
    const statsArr = await Promise.all(scripts.slice(0, 10).map(async s => {
      try {
        const { data: vData } = await axios.get(`${base}/api/v1/scripts/${s.id}/videos`, { headers: { Authorization: auth } });
        const videos = vData?.data?.videos || vData?.videos || [];
        return { ...s, videos: videos.slice(0, 20) };
      } catch { return { ...s, videos: [] }; }
    }));
    res.json({ ok: true, scripts: statsArr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/arcads/actors
app.get('/api/client/arcads/actors', requireClientSession, async (req, res) => {
  try {
    const brands = loadBrands();
    const brand = brands.clients.find(b => b.id === req.session.clientBrandId);
    const appKey    = brand?.arcadsClientId  || process.env.ARCADS_APP_KEY || process.env.ARCADS_CLIENT_ID;
    const appSecret = brand?.arcadsApiKey    || process.env.ARCADS_API_KEY;
    const auth = 'Basic ' + Buffer.from(`${appKey}:${appSecret}`).toString('base64');
    const productId = process.env.ARCADS_PRODUCT_ID || '3cd32041-cc56-4588-b179-cbb55c7dd263';
    const { data } = await axios.get(`https://external-api.arcads.ai/api/v1/situations`, {
      params: { product_id: productId, page: 1, per_page: 50 },
      headers: { Authorization: auth }
    });
    res.json({ ok: true, actors: data?.data?.situations || data?.situations || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/arcads/scripts
app.post('/api/client/arcads/scripts', requireClientSession, express.json(), async (req, res) => {
  try {
    const { name, text, situationIds = [], actorCount = 3 } = req.body || {};
    if (!name || !text) return res.status(400).json({ error: 'name and text required' });
    const brands = loadBrands();
    const brand = brands.clients.find(b => b.id === req.session.clientBrandId);
    const appKey    = brand?.arcadsClientId  || process.env.ARCADS_APP_KEY || process.env.ARCADS_CLIENT_ID;
    const appSecret = brand?.arcadsApiKey    || process.env.ARCADS_API_KEY;
    const auth = 'Basic ' + Buffer.from(`${appKey}:${appSecret}`).toString('base64');
    const base = 'https://external-api.arcads.ai';
    const productId = process.env.ARCADS_PRODUCT_ID || '3cd32041-cc56-4588-b179-cbb55c7dd263';
    const folderId = process.env.ARCADS_FOLDER_ID || 'cb163f1f-6863-47a2-b984-2f5d384fff1a';
    const { data: scriptData } = await axios.post(`${base}/api/v1/scripts`,
      { name, text, product_id: productId, folder_id: folderId, situation_ids: situationIds },
      { headers: { Authorization: auth, 'Content-Type': 'application/json' } }
    );
    const scriptId = scriptData?.data?.script?.id || scriptData?.script?.id;
    if (!scriptId) return res.status(500).json({ error: 'Script creation failed', raw: scriptData });
    await axios.post(`${base}/api/v1/scripts/${scriptId}/generate`, {}, { headers: { Authorization: auth } });
    res.json({ ok: true, scriptId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/ai/ideas — generate content ideas for a brand
app.post('/api/client/ai/ideas', requireClientSession, express.json(), async (req, res) => {
  try {
    const brands = loadBrands();
    const brand = brands.clients.find(b => b.id === req.session.clientBrandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `You are a TikTok content strategist for the brand "${brand.name}".

Brand context:
- Industry: ${brand.industry || 'Not specified'}
- Products: ${brand.products || 'Not specified'}
- Target audience: ${brand.audience || 'Not specified'}
- Brand voice: ${brand.voice || 'Not specified'}
- Content pillars: ${brand.contentPillars || 'Not specified'}

Generate 5 short-form video content ideas for TikTok that would drive product discovery and sales. Each idea should be specific, actionable, and optimized for TikTok's algorithm.

Return JSON: { "ideas": [ { "title": "...", "description": "...", "hook": "...", "format": "..." }, ... ] }`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 800,
    });
    const result = JSON.parse(completion.choices[0].message.content);
    res.json({ ok: true, ideas: result.ideas || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/ai/script — write a TikTok script from an idea
app.post('/api/client/ai/script', requireClientSession, express.json(), async (req, res) => {
  try {
    const { idea } = req.body || {};
    if (!idea) return res.status(400).json({ error: 'idea required' });
    const brands = loadBrands();
    const brand = brands.clients.find(b => b.id === req.session.clientBrandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `Write a 30–45 second TikTok video script for an AI actor to deliver on behalf of the brand "${brand.name}".

Idea: ${idea.title}
Description: ${idea.description}
Hook: ${idea.hook}
Brand voice: ${brand.voice || 'energetic and direct'}
Products: ${brand.products || ''}
CTA: ${brand.cta || 'Shop now via the link below'}

Requirements:
- Written as spoken word — exactly what the actor says
- Opens with a strong hook (first 3 seconds)
- Natural, conversational TikTok tone
- Ends with a clear CTA
- 80–120 words total

Return JSON: { "script": "..." }`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 400,
    });
    const result = JSON.parse(completion.choices[0].message.content);
    res.json({ ok: true, script: result.script || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tiktokshop/callback — registered BEFORE requireAuth so portal.cultcontent.cc clients
// can complete TikTok Shop OAuth without a CF Access session.
app.get('/api/tiktokshop/callback', async (req, res) => {
  const { code, auth_code, state } = req.query;
  const authCode = code || auth_code;
  if (!authCode) return res.status(400).send('Missing auth_code');

  let brandId = null;
  let stateObj = null;
  if (state) {
    try { stateObj = JSON.parse(Buffer.from(state, 'base64').toString()); brandId = stateObj.brandId || null; } catch (_) {}
  }

  const appKey    = process.env.TIKTOK_SHOP_APP_KEY;
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET;
  try {
    const { data } = await axios.get('https://auth.tiktok-shops.com/api/v2/token/get', {
      params: { app_key: appKey, app_secret: appSecret, auth_code: authCode, grant_type: 'authorized_code' },
    });
    if (data?.code !== 0 || !data?.data?.access_token) {
      return res.status(500).json({ error: 'Token exchange failed', raw: data });
    }
    // TikTok returns access_token_expire_in as an absolute Unix timestamp (seconds), not a duration
    const expireVal = data.data.access_token_expire_in;
    const expiresAt = (() => {
      // TikTok access_token_expire_in is an ABSOLUTE Unix timestamp.
      // Distinguish ms-epoch (>1e12), seconds-epoch (1e9..1e12 -> *1000), or a raw duration in seconds (<1e9 -> now + dur*1000).
      const v = Number(expireVal) || 0;
      if (v > 1e12) return v;                       // already milliseconds
      if (v > 1e9)  return v * 1000;                // seconds-epoch -> ms
      return Date.now() + (v || 86400) * 1000;      // raw duration in seconds
    })();
    const tokenData = {
      access_token:  data.data.access_token,
      refresh_token: data.data.refresh_token,
      expires_at:    expiresAt,
      open_id:       data.data.open_id,
    };

    // ── Creator signup flow — state has { type:'creator', token, brandSlug } ──
    if (stateObj?.type === 'creator' && stateObj?.token) {
      const pending = pendingCreatorSignups.get(stateObj.token);
      pendingCreatorSignups.delete(stateObj.token);
      if (!pending) {
        return res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#12101a;color:#e2e8f0;text-align:center">
          <h2 style="color:#ff5b5b">Session expired</h2>
          <p>Please go back and fill out the form again.</p>
          <p><a href="/creators/${stateObj.brandSlug || ''}" style="color:#00f2ea">← Back</a></p>
        </body></html>`);
      }
      // Complete creator signup with the resolved open_id
      const formData = { ...pending.formData, tiktokOpenId: tokenData.open_id };
      console.log(`[creator-signup] TikTok OAuth completed for @${formData.tiktokHandle}, open_id=${tokenData.open_id}`);
      // Run the full submit pipeline (fire-and-forget)
      try {
        const fakeReq = { body: formData };
        // Reuse the same logic as /api/creator-pages/submit — call the pipeline directly
        const brands = loadBrands();
        const brand  = (brands.clients || []).find(b => b.creatorPage?.slug === pending.brandSlug);
        const handle = (formData.tiktokHandle || '').replace(/^@/, '').trim();
        if (brand && handle) {
          const brandIdx = brands.clients.findIndex(b => b.id === brand.id);
          // Fire TC invite with open_id — will use Path A (direct, instant)
          sendCreatorTC(brand, brands, brandIdx, handle, tokenData.open_id).catch(e =>
            console.error('[creator-signup] TC error:', e.message)
          );
        }
        // Also run full onboarding pipeline (GHL, Discord, etc.)
        runOnboardingPipeline(formData).catch(e => console.error('[creator-signup] pipeline error:', e.message));
      } catch(e) {
        console.error('[creator-signup] error:', e.message);
      }
      const welcomeUrl = `/creators/${pending.brandSlug}/welcome?handle=${encodeURIComponent(formData.tiktokHandle || '')}`;
      return res.redirect(welcomeUrl);
    }

    // Fetch shop info (for brand/seller OAuth — not creator flow)
    // Attempt to fetch shop cipher — best-effort, non-blocking
    let shopName = 'TikTok Shop';
    try {
      const allParams = { app_key: appKey, timestamp: Math.floor(Date.now() / 1000) };
      allParams.sign = signTTShop('/authorization/202309/shops', allParams, '');
      const shopRes = await axios.get(`${TTS_BASE}/authorization/202309/shops`, {
        params: allParams,
        headers: { 'content-type': 'application/json', 'x-tts-access-token': tokenData.access_token },
      });
      const shop = shopRes.data?.data?.shops?.[0];
      if (shop) {
        tokenData.shop_cipher = shop.cipher;
        tokenData.shop_id     = shop.id;
        tokenData.shop_name   = shop.name;
        tokenData.shop_region = shop.region;
        shopName = shop.name;
        console.log(`[tiktokshop] shop cipher fetched: ${shopName}`);
      } else {
        console.warn('[tiktokshop] shop fetch returned no shops:', JSON.stringify(shopRes.data));
      }
    } catch (e) {
      console.warn('[tiktokshop] shop cipher fetch failed (non-fatal):', e.response?.data?.message || e.message);
    }

    if (brandId) {
      const brands = loadBrands();
      const bi = brands.clients.findIndex(b => b.id === brandId);
      if (bi !== -1) { brands.clients[bi].tiktokShopToken = tokenData; saveBrands(brands); }
      return res.send(`
        <html><body style="font-family:sans-serif;padding:40px;background:#12101a;color:#e2e8f0">
          <h2 style="color:#00f2ea">✅ TikTok Shop connected!</h2>
          <p>Shop: <strong>${shopName}</strong></p>
          <p>Stats will now appear in your brand dashboard.</p>
          <p><a href="/client/dashboard" style="color:#00f2ea">← Back to your dashboard</a></p>
          <script>setTimeout(() => window.location.href = '/client/dashboard', 2000);</script>
        </body></html>`);
    }
    // Fallback: save to global tokens
    const tokens = loadTikTokTokens();
    tokens.shop = tokenData;
    saveTikTokTokens(tokens);
    res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#111;color:#eee">
      <h2>✅ TikTok Shop connected!</h2><p>Shop: <strong>${shopName}</strong></p>
      <p><a href="/" style="color:#00f2ea">← Back to dashboard</a></p></body></html>`);
  } catch (e) {
    console.error('[tiktokshop] callback error:', e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/client/storista/accounts
app.get('/api/client/storista/accounts', requireClientSession, async (req, res) => {
  try {
    const brands = loadBrands();
    const brand = brands.clients.find(b => b.id === req.session.clientBrandId);
    const apiKey = brand?.storistaApiKey || process.env.STORISTA_API_KEY;
    if (!apiKey) return res.json({ ok: false, error: 'No Storista API key found for this brand', accounts: [] });
    const { data } = await axios.get('https://api-v2.storista.io/v1/tiktok/accounts',
      { headers: { Authorization: `Bearer ${apiKey}` } });
    console.log('[storista] accounts raw response:', JSON.stringify(data).slice(0, 300));
    // Handle various response shapes from Storista
    const accounts = data?.creator_accounts || data?.accounts || data?.data?.accounts || data?.data || (Array.isArray(data) ? data : []);
    res.json({ ok: true, accounts, _raw: data });
  } catch(e) {
    console.error('[storista] accounts error:', e.response?.status, JSON.stringify(e.response?.data).slice(0,200), e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message, accounts: [] });
  }
});

// GET /api/client/storista/products/:account
app.get('/api/client/storista/products/:account', requireClientSession, async (req, res) => {
  try {
    const brands = loadBrands();
    const brand = brands.clients.find(b => b.id === req.session.clientBrandId);
    const apiKey = brand?.storistaApiKey || process.env.STORISTA_API_KEY;
    if (!apiKey) return res.json({ ok: true, products: [] });
    const { data } = await axios.get(`https://api-v2.storista.io/v1/tiktok/accounts/${req.params.account}/products`,
      { headers: { Authorization: `Bearer ${apiKey}` } });
    console.log('[storista] products raw response keys:', Object.keys(data || {}).join(', '));
    const products = data?.products || data?.creator_products || data?.items || data?.data?.products || data?.data || (Array.isArray(data) ? data : []);
    res.json({ ok: true, products, _rawKeys: Object.keys(data || {}) });
  } catch(e) {
    console.error('[storista] products error:', e.response?.status, e.message);
    res.status(500).json({ error: e.message, products: [] });
  }
});

// GET /api/client/storista/debug — list Storista media and TikTok videos for this brand
app.get('/api/client/storista/debug', requireClientSession, async (req, res) => {
  const brands = loadBrands();
  const brand  = brands.clients.find(b => b.id === req.session.clientBrandId);
  const apiKey = brand?.storistaApiKey;
  if (!apiKey) return res.status(400).json({ error: 'No Storista API key' });
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  try {
    const [mediaRes, videosRes] = await Promise.all([
      axios.get('https://api-v2.storista.io/v1/media/', { headers, timeout: 15_000 }),
      axios.get(`https://api-v2.storista.io/v1/tiktok/accounts/trustedrituals/videos`, { headers, timeout: 15_000 }),
    ]);
    res.json({ media: mediaRes.data, videos: videosRes.data });
  } catch (e) {
    res.json({ error: e.message, status: e.response?.status, data: e.response?.data });
  }
});

// GET /api/client/storista/queue — get the brand's scheduled video queue
app.get('/api/client/storista/queue', requireClientSession, (req, res) => {
  const brands = loadBrands();
  const brand  = brands.clients.find(b => b.id === req.session.clientBrandId);
  const queue  = (brand?.storistaQueue || []).sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));
  res.json({ ok: true, queue });
});

// POST /api/client/storista/schedule — bulk-add jobs to the queue
// Accepts optional bufferChannels: [{id, service}] to also schedule to Buffer.
app.post('/api/client/storista/schedule', requireClientSession, async (req, res) => {
  const { items, bufferChannels = [] } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });

  const brands = loadBrands();
  const bi = brands.clients.findIndex(b => b.id === req.session.clientBrandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[bi];
  if (!brand.storistaApiKey) return res.status(400).json({ error: 'Storista not connected' });

  if (!brand.storistaQueue) brand.storistaQueue = [];
  const jobs = items.map(item => ({
    id:           crypto.randomUUID(),
    mediaId:      item.mediaId,
    filename:     item.filename || 'video.mp4',
    account:      item.account,
    productId:    item.productId || '',
    caption:      item.caption  || '',
    scheduledFor: item.scheduledFor,
    uploadUrl:    item.uploadUrl || null,
    status:       'scheduled',
    createdAt:    new Date().toISOString(),
    publishedAt:  null,
    error:        null,
  }));
  brand.storistaQueue.push(...jobs);
  saveBrands(brands);

  // Cross-post to Buffer if channels were selected
  if (bufferChannels.length && process.env.BUFFER_ACCESS_TOKEN) {
    const token = process.env.BUFFER_ACCESS_TOKEN;
    const GQL_MUTATION = `mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id dueAt } } ... on InvalidInputError { message } ... on UnexpectedError { message } } }`;
    for (const job of jobs) {
      for (const ch of bufferChannels) {
        try {
          const input = buildBufferInput(ch.id, ch.service, job.caption, job.uploadUrl, job.scheduledFor);
          const { data: gql } = await axios.post(
            'https://api.buffer.com/graphql',
            { query: GQL_MUTATION, variables: { input } },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15_000 }
          );
          const result = gql.data?.createPost;
          if (result?.message) console.error(`[buffer] "${job.filename}" → ${ch.id}: ${result.message}`);
          else console.log(`[buffer] scheduled "${job.filename}" for channel ${ch.id}`);
        } catch(e) {
          console.error(`[buffer] failed "${job.filename}" → ${ch.id}:`, e.response?.data || e.message);
        }
      }
    }
  }

  res.json({ ok: true, jobs });
});

// DELETE /api/client/storista/queue/:jobId — remove a scheduled job
app.delete('/api/client/storista/queue/:jobId', requireClientSession, (req, res) => {
  const brands = loadBrands();
  const bi = brands.clients.findIndex(b => b.id === req.session.clientBrandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[bi];
  brand.storistaQueue = (brand.storistaQueue || []).filter(j => j.id !== req.params.jobId);
  saveBrands(brands);
  res.json({ ok: true });
});

// GET /api/admin/brands-list — list brand IDs + names + connection status
app.get('/api/admin/brands-list', (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const brands = loadBrands();
  const now = Date.now();
  res.json({ brands: (brands.clients || []).map(b => {
    const tok = b.tiktokShopToken;
    const hasToken   = !!(tok?.access_token);
    const hasCipher  = !!(tok?.shop_cipher);
    const expired    = tok?.expires_at ? tok.expires_at < now : false;
    const tiktokStatus = !hasToken ? 'not_connected'
                       : expired   ? 'expired'
                       : !hasCipher ? 'missing_cipher'
                       : 'ok';
    return {
      id: b.id, name: b.name,
      loginEmail: b.loginEmail || b.email || null,
      hasPassword: !!b.passwordHash,
      tiktokStatus,
      hasToken, hasCipher, expired,
      expiresAt: tok?.expires_at ? new Date(tok.expires_at).toISOString() : null,
    };
  })});
});

// GET /api/admin/brand-products/:id — fetch TikTok Shop products for a brand (admin only, one-shot debug)
app.get('/api/admin/brand-products/:id', async (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const brands = loadBrands();
  const bi = (brands.clients || []).findIndex(b => b.id === req.params.id);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  try {
    const data = await ttsBrandPost(brands.clients[bi], brands, bi, '/product/202309/products/search', {}, { page_size: 20 });
    res.json({ products: (data?.data?.products || []).map(p => ({ id: p.id, title: p.title, status: p.status })) });
  } catch(e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /api/admin/brand-refresh-token/:id — force TikTok Shop token refresh + report state (secret-gated debug)
app.get('/api/admin/brand-refresh-token/:id', async (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const brands = loadBrands();
  const bi = (brands.clients || []).findIndex(b => b.id === req.params.id);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const b = brands.clients[bi];
  const t = b.tiktokShopToken || {};
  const before = {
    has_access_token: !!t.access_token,
    has_refresh_token: !!t.refresh_token,
    expires_at: t.expires_at || null,
    expired: t.expires_at ? (Date.now() > t.expires_at) : null,
  };
  let ok = false, err = null;
  try { ok = await refreshBrandShopToken(b, brands, bi); } catch (e) { err = e.message; }
  const t2 = (brands.clients[bi].tiktokShopToken) || {};
  const after = {
    has_access_token: !!t2.access_token,
    expires_at: t2.expires_at || null,
    expired: t2.expires_at ? (Date.now() > t2.expires_at) : null,
  };
  res.json({ ok, err, before, after });
});

// GET /api/admin/brand-debug/:id — show brand storista key prefix for debugging
app.get('/api/admin/brand-debug/:id', (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const brands = loadBrands();
  const brand = (brands.clients || []).find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  const globalKey = process.env.STORISTA_API_KEY || '';
  const brandKey  = brand.storistaApiKey || '';
  res.json({
    id:              brand.id,
    name:            brand.name,
    storistaConnected: !!brand.storistaConnected,
    storistaApiKey:  brandKey || null,  // full key — endpoint is admin-secret gated
    brandKeyPrefix:  brandKey  ? brandKey.slice(0, 8) + '...' : '(none)',
    globalKeyPrefix: globalKey ? globalKey.slice(0, 8) + '...' : '(none)',
    keysMatch:       brandKey === globalKey,
    queueLength:     (brand.storistaQueue || []).length,
    queueStatuses:   (brand.storistaQueue || []).reduce((acc, j) => { acc[j.status] = (acc[j.status]||0)+1; return acc; }, {}),
  });
});

// POST /api/admin/storista/batch-inject — inject pre-built jobs into a brand's queue
// Auth: X-Admin-Secret header matching ADMIN_BATCH_SECRET env var
app.post('/api/admin/storista/batch-inject', express.json({ limit: '10mb' }), (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const { brandId, jobs } = req.body || {};
  if (!brandId || !Array.isArray(jobs)) return res.status(400).json({ error: 'brandId and jobs[] required' });
  const brands = loadBrands();
  const bi = brands.clients.findIndex(b => b.id === brandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  if (!brands.clients[bi].storistaQueue) brands.clients[bi].storistaQueue = [];
  brands.clients[bi].storistaQueue.push(...jobs);
  saveBrands(brands);
  console.log(`[batch-inject] Added ${jobs.length} jobs to ${brands.clients[bi].name}`);
  res.json({ ok: true, added: jobs.length });
});

// GET /api/admin/storista/queue/:brandId — list all jobs in brand's queue
app.get('/api/admin/storista/queue/:brandId', (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const brands = loadBrands();
  const brand = (brands.clients || []).find(b => b.id === req.params.brandId);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  const queue = (brand.storistaQueue || []).map(j => ({
    id: j.id, filename: j.filename, mediaId: j.mediaId,
    caption: j.caption || '', productId: j.productId || '', account: j.account || '',
    status: j.status, scheduledFor: j.scheduledFor, retries: j.retries,
    tiktokVideoId: j.tiktokVideoId || null, publishedAt: j.publishedAt || null,
    error: j.error || null,
  }));
  res.json({ brandId: brand.id, name: brand.name, total: queue.length, queue });
});

// PATCH /api/admin/storista/queue-reset-stuck/:brandId — reset 'processing' jobs back to 'scheduled'
app.patch('/api/admin/storista/queue-reset-stuck/:brandId', (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const brands = loadBrands();
  const bi = brands.clients.findIndex(b => b.id === req.params.brandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  let reset = 0;
  for (const job of (brands.clients[bi].storistaQueue || [])) {
    if (job.status === 'processing') { job.status = 'scheduled'; reset++; }
  }
  saveBrands(brands);
  res.json({ ok: true, reset });
});

// DELETE /api/admin/storista/queue-clear/:brandId — remove all jobs matching a media ID prefix or status
app.delete('/api/admin/storista/queue-clear/:brandId', express.json(), (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const brands = loadBrands();
  const bi = brands.clients.findIndex(b => b.id === req.params.brandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const { mediaIds, statuses, keepScheduled } = req.body || {};
  const before = (brands.clients[bi].storistaQueue || []).length;
  brands.clients[bi].storistaQueue = (brands.clients[bi].storistaQueue || []).filter(j => {
    if (mediaIds && mediaIds.includes(String(j.mediaId))) return false;
    if (statuses && statuses.includes(j.status)) return false;
    if (keepScheduled === false && j.status === 'scheduled') return false;
    return true;
  });
  const after = (brands.clients[bi].storistaQueue || []).length;
  saveBrands(brands);
  console.log(`[queue-clear] Removed ${before - after} jobs from ${brands.clients[bi].name}`);
  res.json({ ok: true, removed: before - after, remaining: after });
});

// POST /api/admin/storista/sync-processing/:brandId — re-check all 'processing' jobs against Storista
app.post('/api/admin/storista/sync-processing/:brandId', async (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const brands = loadBrands();
  const brand = (brands.clients || []).find(b => b.id === req.params.brandId);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  if (!brand.storistaApiKey) return res.status(400).json({ error: 'No Storista API key for brand' });
  const pending = (brand.storistaQueue || []).filter(j => j.status === 'processing' && j.tiktokVideoId);
  if (!pending.length) return res.json({ ok: true, checked: 0, results: [] });
  const authHeader = `Bearer ${brand.storistaApiKey}`;
  const sGet = (p) => axios.get(`${STORISTA_BASE}${p}`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
    timeout: 15_000,
  });
  const results = [];
  for (const job of pending) {
    try {
      const { data: st } = await sGet(`/v1/tiktok/accounts/${job.account}/videos/${job.tiktokVideoId}`);
      const prev = job.status;
      if (st.status === 'READY' || st.status === 'PUBLISHED') {
        job.status = 'published';
        job.publishedAt = job.publishedAt || new Date().toISOString();
      } else if (st.status === 'REJECTED') {
        job.status = 'failed';
        job.error = st.reject_reason || 'Rejected by TikTok';
      }
      results.push({ id: job.id, filename: job.filename, tiktokVideoId: job.tiktokVideoId, storistaStatus: st.status, prev, now: job.status });
    } catch (e) {
      results.push({ id: job.id, filename: job.filename, tiktokVideoId: job.tiktokVideoId, error: e.message });
    }
  }
  saveBrands(brands);
  res.json({ ok: true, checked: pending.length, results });
});

// GET /api/admin/shop-metrics/:brandId — WoW GMV + order metrics for admin portal
// Returns this week vs last week for GMV, orders, and AOV
app.get('/api/admin/shop-metrics/:brandId', async (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const brands = loadBrands();
  const bi = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[bi];
  if (!brand.tiktokShopToken?.access_token) return res.json({ ok: true, noToken: true });

  const CANCEL_STATUSES = new Set([140, 4, 'CANCELLED', 'CANCEL', 'REFUNDED', 'REFUND', 'REVERSE_PENDING', 'REVERSE_COMPLETE']);

  async function fetchWeekMetrics(startTs, endTs) {
    let gmv = 0, orders = 0, pageToken = null;
    for (let page = 0; page < 10; page++) {
      const body = { create_time_ge: startTs, create_time_lt: endTs, sort_field: 'create_time', sort_order: 'DESC' };
      if (pageToken) body.page_token = pageToken;
      try {
        const resp = await ttsBrandPost(brand, brands, bi, '/order/202309/orders/search', body, { page_size: 100 });
        const list = resp?.data?.orders || resp?.data?.order_list || [];
        for (const o of list) {
          if (o.is_sample_order) continue;
          const status = o.order_status ?? o.status;
          if (status !== undefined && CANCEL_STATUSES.has(status)) continue;
          orders++;
          // Extract amount
          const payment = o.payment || {};
          const amt = parseFloat(payment.sub_total ?? payment.original_total_product_price ?? payment.total_amount ?? 0) || 0;
          const discount = parseFloat(payment.seller_discount ?? payment.platform_discount ?? 0) || 0;
          gmv += amt > 0 ? amt : 0;
        }
        const nextToken = resp?.data?.next_page_token || resp?.data?.page_token;
        if (!nextToken || list.length === 0) break;
        pageToken = nextToken;
      } catch(e) {
        if (e.response?.status === 401) throw e;
        break;
      }
    }
    return { gmv, orders, aov: orders > 0 ? gmv / orders : 0 };
  }

  try {
    const now   = Math.floor(Date.now() / 1000);
    const week1 = now - 7 * 86400;   // start of this week
    const week2 = week1 - 7 * 86400; // start of last week

    const [thisWeek, lastWeek] = await Promise.all([
      fetchWeekMetrics(week1, now),
      fetchWeekMetrics(week2, week1),
    ]);

    function trend(curr, prev) {
      if (!prev || prev === 0) return curr > 0 ? { dir: 'up', pct: null } : { dir: 'flat', pct: null };
      const pct = ((curr - prev) / prev) * 100;
      return { dir: pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat', pct: Math.round(Math.abs(pct)) };
    }

    res.json({
      ok: true,
      thisWeek,
      lastWeek,
      trends: {
        gmv:    trend(thisWeek.gmv,    lastWeek.gmv),
        orders: trend(thisWeek.orders, lastWeek.orders),
        aov:    trend(thisWeek.aov,    lastWeek.aov),
      },
      analyticsUnavailable: true, // CTR / impressions / score require Analytics API product
    });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/admin/shop-metrics-probe/:brandId — probe TikTok Shop analytics endpoints
// Tests correct paths discovered from TikTok API Testing Tool:
//   /analytics/202509/shop/performance  params: start_date_ge, end_date_lt (YYYY-MM-DD)
app.get('/api/admin/shop-metrics-probe/:brandId', async (req, res) => {
  const secret = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const brands = loadBrands();
  const bi = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[bi];
  if (!brand.tiktokShopToken?.access_token) return res.status(400).json({ error: 'No TikTok token' });

  const results = {};
  const now = Math.floor(Date.now() / 1000);
  const ds = (ts) => new Date(ts * 1000).toISOString().slice(0,10); // YYYY-MM-DD (TikTok requires dashes)
  const today  = ds(now);
  const week1S = ds(now - 7 * 86400);
  const week2S = ds(now - 14 * 86400);

  // Confirmed: Path /analytics/202509/shop/performance, Version 202509
  // Params: start_date_ge + end_date_lt as YYYY-MM-DD (regex ^2[0-9]{3}-[0,1][0-9]-[0-3][0-9]$)
  const thisWkParams  = { start_date_ge: week1S, end_date_lt: today };
  const lastWkParams  = { start_date_ge: week2S, end_date_lt: week1S };

  const p202605 = { ...thisWkParams, page_size: 10 };
  const noDate  = {};
  const endpoints = [
    // Shop performance (confirmed working, v202509)
    ['GET', '/analytics/202509/shop/performance',                  thisWkParams],
    // Product performance (confirmed)
    ['GET', '/analytics/202605/shop_products/performance',         p202605],
    // Video performance (confirmed)
    ['GET', '/analytics/202605/shop_videos/performance',           p202605],
    // Shop performance SCORE — probe various likely paths/versions
    ['GET', '/analytics/202509/shop/score',                        thisWkParams],
    ['GET', '/analytics/202605/shop/score',                        thisWkParams],
    ['GET', '/analytics/202509/shop/health',                       noDate],
    ['GET', '/analytics/202605/shop/health',                       noDate],
    ['GET', '/seller/202309/shop',                                 noDate],
    ['GET', '/seller/202309/seller_performance',                   noDate],
    ['GET', '/seller/202309/performance',                          thisWkParams],
    ['GET', '/supply_chain/202309/shop_score',                     noDate],
    ['GET', '/seller_score/202309/shop_score',                     noDate],
    ['GET', '/analytics/202509/shop/performance_score',            thisWkParams],
    ['GET', '/analytics/202605/shop/performance_score',            thisWkParams],
    ['GET', '/analytics/202509/seller/performance',                thisWkParams],
    ['GET', '/analytics/202605/seller/performance',                thisWkParams],
  ];

  for (const [method, path, params] of endpoints) {
    const key = `${method} ${path} ${JSON.stringify(params)}`;
    try {
      const r = await ttsBrandGet(brand, brands, bi, path, params);
      results[key] = { ok: true, data: r.data };
    } catch(e) {
      results[key] = { error: e.response?.status, code: e.response?.data?.code, msg: e.response?.data?.message, raw: e.response?.data };
    }
  }

  res.json(results);
});

// POST /api/client/storista/queue/:jobId/retry — reset a failed job to scheduled
app.post('/api/client/storista/queue/:jobId/retry', requireClientSession, (req, res) => {
  const brands = loadBrands();
  const bi = brands.clients.findIndex(b => b.id === req.session.clientBrandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[bi];
  const job = (brand.storistaQueue || []).find(j => j.id === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.status  = 'scheduled';
  job.retries = 0;
  job.error   = undefined;
  // Reset scheduledFor to now+1min so it fires on the next tick
  job.scheduledFor = new Date(Date.now() + 60_000).toISOString();
  saveBrands(brands);
  res.json({ ok: true });
});

// ─── Brand Assets (Content Studio) ──────────────────────────────────────────

// GET /api/client/products — TikTok Shop products for this brand (client session)

app.get('/api/client/products', requireClientSession, async (req, res) => {
  const brands = loadBrands();
  const bi = brands.clients.findIndex(b => b.id === req.session.clientBrandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[bi];
  if (!brand.tiktokShopToken?.access_token) return res.json({ ok: true, products: [] });
  try {
    // Paginate through ALL products (page_size 50, up to 5 pages = 250 products)
    let allRaw = [], pageToken = null;
    for (let page = 0; page < 5; page++) {
      const params = { page_size: 50 };
      if (pageToken) params.page_token = pageToken;
      const r = await ttsBrandPost(brand, brands, bi, '/product/202309/products/search', {}, params);
      const batch = r?.data?.products || [];
      allRaw.push(...batch);
      pageToken = r?.data?.next_page_token;
      if (!pageToken || batch.length === 0) break;
    }

    // Fetch images for first 30 products in parallel (the rest show in dropdown without images)
    const detailResults = await Promise.allSettled(
      allRaw.slice(0, 30).map(p =>
        ttsBrandGet(brand, brands, bi, `/product/202309/products/${p.id}`)
      )
    );
    const detailMap = {};
    detailResults.forEach((r2, i) => {
      if (r2.status === 'fulfilled') {
        const val = r2.value;
        if (val?.code === 0 && val?.data) detailMap[allRaw[i].id] = val.data;
        else if (val?.main_images)        detailMap[allRaw[i].id] = val;
      }
    });

    function extractImages(p) {
      const detail = detailMap[p.id] || {};
      const src = detail.main_images || detail.images || p.main_images || p.images || [];
      return src.slice(0, 4)
        .map(img => img?.thumb_urls?.[0] || img?.urls?.[0] || img?.url_list?.[0] || img?.url || img)
        .filter(s => typeof s === 'string' && s.startsWith('http'));
    }

    const products = allRaw.map(p => ({
      id:     p.id,
      name:   p.title || p.name || 'Product',
      images: extractImages(p),
    }));
    res.json({ ok: true, products });
  } catch(e) {
    res.json({ ok: true, products: [], error: e.response?.data?.message || e.message });
  }
});

// GET /api/client/assets — list brand's saved content assets
app.get('/api/client/assets', requireClientSession, (req, res) => {
  const brands = loadBrands();
  const bi = brands.clients.findIndex(b => b.id === req.session.clientBrandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[bi];
  res.json({ ok: true, assets: brand.contentAssets || [] });
});

// POST /api/client/assets/upload — upload image or video asset, tag to a product
// Must be after imageUpload/clientUpload defs — registered via lazy multer
app.post('/api/client/assets/upload', requireClientSession, (req, res, next) => {
  const multerAny = require('multer')({
    storage: require('multer').diskStorage({
      destination: (_, __, cb) => cb(null, UPLOAD_DIR),
      filename:    (_, file, cb) => {
        const ext  = path.extname(file.originalname) || '';
        const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
        cb(null, `${Date.now()}_${base}${ext}`);
      },
    }),
    limits: { fileSize: 500 * 1024 * 1024 },
  }).single('asset');
  multerAny(req, res, next);
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const brands = loadBrands();
  const bi = brands.clients.findIndex(b => b.id === req.session.clientBrandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[bi];
  if (!brand.contentAssets) brand.contentAssets = [];
  const isVideo = /video/i.test(req.file.mimetype) || /\.(mp4|mov|avi|webm)$/i.test(req.file.originalname);
  const asset = {
    id:        crypto.randomUUID(),
    productId: req.body.productId || null,
    name:      req.file.originalname,
    url:       `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`,
    type:      isVideo ? 'video' : 'image',
    createdAt: new Date().toISOString(),
  };
  brand.contentAssets.push(asset);
  saveBrands(brands);
  res.json({ ok: true, asset });
});

// DELETE /api/client/assets/:assetId
app.delete('/api/client/assets/:assetId', requireClientSession, (req, res) => {
  const brands = loadBrands();
  const bi = brands.clients.findIndex(b => b.id === req.session.clientBrandId);
  if (bi === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[bi];
  const idx = (brand.contentAssets || []).findIndex(a => a.id === req.params.assetId);
  if (idx === -1) return res.status(404).json({ error: 'Asset not found' });
  const asset = brand.contentAssets[idx];
  // Delete file
  const filePath = path.join(UPLOAD_DIR, path.basename(asset.url.split('?')[0]));
  if (filePath.startsWith(UPLOAD_DIR)) fs.unlink(filePath, () => {});
  brand.contentAssets.splice(idx, 1);
  saveBrands(brands);
  res.json({ ok: true });
});

// POST /api/client/overlay/render — FFmpeg: burn text + logo overlays into a video
// Body: { videoUrl, overlays: [{type:'text'|'logo', text, x, y, fontSize, color, bold, url, width}] }
app.post('/api/client/overlay/render', requireClientSession, express.json({ limit: '1mb' }), async (req, res) => {
  const { videoUrl, overlays = [] } = req.body || {};
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });

  // Resolve local path from URL
  const filename = path.basename(videoUrl.split('?')[0]);
  const inputPath = path.join(UPLOAD_DIR, filename);
  if (!inputPath.startsWith(UPLOAD_DIR) || !fs.existsSync(inputPath)) {
    return res.status(400).json({ error: 'Video file not found. Upload it first.' });
  }

  const outName = `overlay_${Date.now()}_${filename}`;
  const outPath = path.join(UPLOAD_DIR, outName);

  try {
    await new Promise((resolve, reject) => {
      const textOverlays = overlays.filter(o => o.type === 'text');
      const logoOverlays = overlays.filter(o => o.type === 'logo');

      let cmd = ffmpeg(inputPath);

      // Add logo inputs
      logoOverlays.forEach(lo => {
        const logoFile = path.join(UPLOAD_DIR, path.basename((lo.url || '').split('?')[0]));
        if (fs.existsSync(logoFile)) cmd = cmd.input(logoFile);
      });

      // Build filter complex
      const filters = [];
      let lastOutput = '0:v';

      // Logo overlays first
      logoOverlays.forEach((lo, i) => {
        const logoFile = path.join(UPLOAD_DIR, path.basename((lo.url || '').split('?')[0]));
        if (!fs.existsSync(logoFile)) return;
        const w = lo.width || 80;
        const x = lo.x ?? 10;
        const y = lo.y ?? 10;
        const outLabel = `logo${i}`;
        filters.push(`[${i + 1}:v]scale=${w}:-1[scaled${i}]`);
        filters.push(`[${lastOutput}][scaled${i}]overlay=${x}:${y}[${outLabel}]`);
        lastOutput = outLabel;
      });

      // Text overlays
      textOverlays.forEach((to, i) => {
        const text   = (to.text || '').replace(/'/g, "'\\''").replace(/:/g, '\\:');
        const x      = to.x ?? 50;
        const y      = to.y ?? 100;
        const size   = to.fontSize || 36;
        const color  = (to.color || '#ffffff').replace('#', '');
        const bold   = to.bold ? ':bold=1' : '';
        const shadow = 'shadowcolor=black:shadowx=2:shadowy=2';
        const outLabel = `txt${i}`;
        filters.push(`[${lastOutput}]drawtext=text='${text}':x=${x}:y=${y}:fontsize=${size}:fontcolor=0x${color}:${shadow}${bold}[${outLabel}]`);
        lastOutput = outLabel;
      });

      if (filters.length) {
        cmd = cmd.complexFilter(filters, lastOutput);
      }

      cmd
        .outputOptions(['-c:a', 'copy'])
        .on('error', reject)
        .on('end', resolve)
        .save(outPath);
    });

    const outputUrl = `${PUBLIC_BASE_URL}/uploads/${outName}`;
    res.json({ ok: true, outputUrl, filename: outName });
  } catch(e) {
    console.error('[overlay/render] error:', e.message);
    if (fs.existsSync(outPath)) fs.unlink(outPath, () => {});
    res.status(500).json({ error: e.message });
  }
});

// ─── Creator Onboarding (PUBLIC — called from cultcontent.cc) ────────────────
// CORS preflight
app.options('/api/creator-onboard', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.post('/api/creator-onboard', express.json(), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  const { name = '', tiktokHandle = '', email: rawEmail = '', phone = '', discordUsername = '' } = req.body || {};
  // Normalize email so dup-check + INSERT are case/whitespace-insensitive (matches IC login lookup which lowercases)
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!name.trim() || !email.trim() || !phone.trim()) {
    return res.status(400).json({ ok: false, error: 'Name, email and phone are required.' });
  }

  const nameParts = name.trim().split(/\s+/);
  const firstName  = nameParts[0];
  const lastName   = nameParts.slice(1).join(' ') || '';
  const handle     = tiktokHandle.replace(/^@/, '').trim();
  // Normalize phone — strip non-digits, prepend +1 if 10 digits
  const digits     = phone.replace(/\D/g, '');
  const cleanPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;

  const results = { ghl: null, sms: null, discord: null };
  let contactId = null;
  const ghlHeaders = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' };

  // 0 — Log submission to persistent file FIRST (before any API calls can fail)
  try {
    const logEntry = JSON.stringify({
      ts: new Date().toISOString(),
      name, tiktokHandle, email, phone: cleanPhone, discordUsername
    }) + '\n';
    const logPath = process.env.VOLUME_PATH
      ? `${process.env.VOLUME_PATH}/creator-onboard-submissions.log`
      : '/tmp/creator-onboard-submissions.log';
    fs.appendFileSync(logPath, logEntry);
  } catch (logErr) {
    console.error('[creator-onboard] log write failed:', logErr.message);
  }
  console.log(`[creator-onboard] submission: name="${name}" email="${email}" phone="${cleanPhone}" tiktok="${tiktokHandle}"`);

  // 1 — Create GHL contact
  try {
    const payload = {
      firstName, lastName, email,
      phone: cleanPhone,
      tags: ['affiliate', 'creator-community-form'],
      locationId: process.env.GHL_LOCATION_ID || process.env.GHL_LOC_ID,
    };
    if (handle) payload.customFields = [{ key: 'tiktok_handle', field_value: `@${handle}` }];

    try {
      const ghlRes = await axios.post('https://services.leadconnectorhq.com/contacts/', payload, { headers: ghlHeaders });
      contactId = ghlRes.data?.contact?.id;
      results.ghl = { ok: true, contactId };
    } catch (e) {
      // GHL rejects duplicate contacts but returns the existing contactId in the error
      const dupId = e.response?.data?.meta?.contactId;
      if (dupId) {
        contactId = dupId;
        // Update phone/tags on the existing contact
        await axios.put(`https://services.leadconnectorhq.com/contacts/${contactId}`, payload, { headers: ghlHeaders }).catch(() => {});
        results.ghl = { ok: true, contactId, note: 'existing contact updated' };
      } else {
        results.ghl = { ok: false, error: e.response?.data || e.message };
        console.error('[creator-onboard] GHL error:', e.response?.data || e.message);
      }
    }
  } catch (e) {
    results.ghl = { ok: false, error: e.response?.data || e.message };
    console.error('[creator-onboard] GHL error:', e.response?.data || e.message);
  }

  // 2 — Send GHL SMS (upsert conversation first, then send via conversationId)
  if (contactId) {
    try {
      const discordLink = process.env.DISCORD_INVITE_URL || 'https://discord.gg/a5WNMe8Xuu';
      // Upsert conversation to get conversationId
      // GHL returns a non-2xx when conversation already exists but still gives us the ID
      let conversationId;
      try {
        const convoRes = await axios.post('https://services.leadconnectorhq.com/conversations/', {
          locationId: process.env.GHL_LOCATION_ID || process.env.GHL_LOC_ID,
          contactId,
        }, { headers: ghlHeaders });
        conversationId = convoRes.data?.conversationId || convoRes.data?.id;
      } catch (ce) {
        conversationId = ce.response?.data?.conversationId;
        if (!conversationId) throw ce;
      }
      await axios.post('https://services.leadconnectorhq.com/conversations/messages', {
        type: 'SMS',
        conversationId,
        contactId,
        message: `Welcome to the Cult Content creator community, ${firstName}! You're in 👁️‼️\n\nHere's everything you need:\n→ Discord: ${discordLink}\n→ Skool: https://www.skool.com/cult-content\n→ Brand opportunities: ${CREATOR_BASE_URL}/creators\n\nText this number anytime if you need us.`,
      }, { headers: ghlHeaders });
      results.sms = { ok: true };
    } catch (e) {
      results.sms = { ok: false, error: e.response?.data || e.message };
      console.error('[creator-onboard] SMS error:', e.response?.data || e.message);
    }
  }

  // 3 — Discord role assignment (with automatic retry every 5min, up to 3 attempts)
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId  = process.env.DISCORD_GUILD_ID;
  const roleId   = process.env.DISCORD_CREATOR_ROLE_ID;
  const cleanDu  = discordUsername.replace(/^@/, '').trim();

  async function tryAssignDiscordRole() {
    if (!botToken || !guildId || !roleId || !cleanDu) return { ok: false, error: botToken ? 'No Discord username provided' : 'Discord not configured' };
    try {
      const searchRes = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members/search`, {
        params: { query: cleanDu, limit: 10 },
        headers: { Authorization: `Bot ${botToken}` },
      });
      const members = searchRes.data || [];
      const member  = members.find(m =>
        m.user.username.toLowerCase()    === cleanDu.toLowerCase() ||
        (m.user.global_name || '').toLowerCase() === cleanDu.toLowerCase()
      );
      if (member) {
        await axios.put(
          `https://discord.com/api/v10/guilds/${guildId}/members/${member.user.id}/roles/${roleId}`,
          null,
          { headers: { Authorization: `Bot ${botToken}` } }
        );
        return { ok: true, userId: member.user.id, username: member.user.username };
      }
      return { ok: false, error: 'not_found' };
    } catch (e) {
      return { ok: false, error: e.response?.data?.message || e.message };
    }
  }

  function scheduleDiscordRetry(attemptsLeft) {
    if (attemptsLeft <= 0 || !cleanDu) return;
    setTimeout(async () => {
      console.log(`[creator-onboard] Discord retry for ${cleanDu}, attempts left: ${attemptsLeft}`);
      const r = await tryAssignDiscordRole();
      if (r.ok) {
        console.log(`[creator-onboard] Discord role assigned on retry for ${cleanDu}`);
      } else if (r.error === 'not_found') {
        scheduleDiscordRetry(attemptsLeft - 1);
      } else {
        console.error(`[creator-onboard] Discord retry failed for ${cleanDu}:`, r.error);
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  results.discord = await tryAssignDiscordRole();
  if (results.discord.error === 'not_found') {
    results.discord.error = 'Username not found in server — will retry in 5 minutes.';
    scheduleDiscordRetry(3); // retry up to 3 more times (5, 10, 15 min)
  }

  // 4 — Lark alert (proxied through cultcontent-server which holds the right bot credentials)
  try {
    const discordStr = discordUsername ? `@${discordUsername.replace(/^@/,'')}` : 'not provided';
    const tiktokStr  = handle ? `@${handle}` : 'not provided';
    await axios.post(`${CFG.railwayUrl}/command`, {
      text: `👁️‼️ New Creator Signup\nName: ${name}\nTikTok: ${tiktokStr}\nEmail: ${email}\nPhone: ${phone}\nDiscord: ${discordStr}`,
      context: 'Creator Community',
      source: 'cultcontent.cc/creators',
    }, { timeout: 8000 });
  } catch(e) {
    console.error('[creator-onboard] Lark error:', e.response?.data || e.message);
  }

  const discordInvite = process.env.DISCORD_INVITE_URL || 'https://discord.gg/cultcontent';
  writeCreatorSignupToBitable({
    brand: '', creatorName: `${firstName} ${lastName}`.trim(), handle, email,
    phone: cleanPhone, discord: discordUsername, source: 'Full Onboard'
  }).catch(()=>{});
  res.json({ ok: true, discordInvite, results });
});

// Public marketing pages — all registered before the auth wall
// These map the former GHL funnel URLs to static HTML files in the repo root.
const _pub = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get('/',                                   _pub('home.html'));
app.get('/home',                               _pub('home.html'));
app.get('/services',                           _pub('services.html'));
app.get('/strategy',                           _pub('strategy.html'));
app.get('/consulting',                         _pub('consulting.html'));
app.get('/book',                               _pub('book.html'));
app.get('/book-with-tommy',                    _pub('book-with-tommy.html'));
app.get('/book-with-jina',                     _pub('book-with-jina.html'));
app.get('/book-now',                           _pub('book-now.html'));
app.get('/book-consulting',                    _pub('book-consulting.html'));
app.get('/partners',                           _pub('partners.html'));
app.get('/growth-partner',                     _pub('growth-partner.html'));
app.get('/scale',                              _pub('scale.html'));
app.get('/founders-story',                     _pub('founders-story.html'));
app.get('/alchemists-club',                    _pub('alchemists-club.html'));
app.get('/thoughts-from-tommy',                _pub('thoughts-from-tommy.html'));
app.get('/foundation',                         _pub('foundation.html'));
app.get('/profitability-calculator',           _pub('profitability-calculator.html'));
app.get('/consultant-template',                _pub('consultant-template.html'));
app.get('/consultant-onboarding',              _pub('consultant-onboarding.html'));
app.get('/client-onboarding',                  _pub('client-onboarding.html'));
app.get('/ccc-sponsor',                        _pub('ccc-sponsor.html'));
app.get('/culture-commerce-carnival',          _pub('culture-commerce-carnival.html'));
app.get('/creatorcarnival',                    _pub('culture-commerce-carnival.html'));
app.get('/creator-carnival',                   _pub('culture-commerce-carnival.html'));
app.get('/culture-commerce-carnival-proposal', _pub('culture-commerce-carnival-proposal.html'));
app.get('/ccc-creator-apply',                  _pub('ccc-creator-apply.html'));
app.get('/ccc-sponsor-confirmed',              _pub('ccc-sponsor-confirmed.html'));
app.get('/ccc-marketplace-sponsor',          _pub('ccc-marketplace-sponsor.html'));
app.get('/ccc-carnival-sponsor',             _pub('ccc-carnival-sponsor.html'));
app.get('/ccc-commerce-sponsor',             _pub('ccc-commerce-sponsor.html'));
app.get('/ccc-culture-sponsor',              _pub('ccc-culture-sponsor.html'));
app.get('/ccc-hydration-sponsor',            _pub('ccc-hydration-sponsor.html'));
app.get('/ccc-alcohol-sponsor',              _pub('ccc-alcohol-sponsor.html'));
app.get('/ccc-stage-backdrop-sponsor',       (req,res)=>res.redirect(301,'/ccc-carnival-billboard-video-sponsor'));
app.get('/ccc-lanyard-sponsor',              _pub('ccc-lanyard-sponsor.html'));
app.get('/ccc-carnival-billboard-photo',     (req,res)=>res.redirect(301,'/ccc-carnival-billboard-graphic-sponsor'));
app.get('/ccc-carnival-billboard-graphic-sponsor', _pub('ccc-carnival-billboard-graphic.html'));
app.get('/ccc-carnival-billboard-video',     (req,res)=>res.redirect(301,'/ccc-carnival-billboard-video-sponsor'));
app.get('/ccc-carnival-billboard-video-sponsor',   _pub('ccc-carnival-billboard-video.html'));
app.get('/ccc-livestream-commercial',        _pub('ccc-livestream-commercial.html'));
app.get('/ccc-photo-booth',                  _pub('ccc-photo-booth.html'));
app.get('/ccc-executive-experience',         _pub('ccc-executive-experience.html'));
app.get('/ccc-community-vendor',             _pub('ccc-community-vendor.html'));
app.get('/ccc-vip',                          _pub('ccc-vip.html'));
app.get('/creator-onboarding',                 _pub('creator-onboarding.html'));
app.get('/financials',                         _pub('financials.html'));
app.get('/tiktok-city-tour--dream-big--dc',    _pub('tiktok-city-tour.html'));
app.get('/sponsorship-packages--dream-big-dc', _pub('sponsorship-packages.html'));

// ─── Client-portal file-upload routes (MUST be before requireAuth) ─────────────
// These use requireClientSession (cookie-based) not CF Access, so they must be
// registered before app.use(requireAuth) or Cloudflare Access blocks them first.
const clientUpload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
      const ext  = path.extname(file.originalname) || '.mp4';
      const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
      cb(null, `${Date.now()}_${base}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /video|mp4|mov|avi|webm/i.test(file.mimetype + file.originalname)
            || file.mimetype === 'application/octet-stream';
    cb(null, ok);
  },
});

// POST /api/client/storista/upload
app.post('/api/client/storista/upload', requireClientSession, clientUpload.single('video'), async (req, res) => {
  const brands = loadBrands();
  const brand  = brands.clients.find(b => b.id === req.session.clientBrandId);
  const apiKey = brand?.storistaApiKey;
  if (!apiKey) return res.status(400).json({ error: 'No Storista API key configured' });
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });

  const filename  = req.file.originalname || req.file.filename;
  const filePath  = req.file.path;
  let tempFile    = true;

  const s = axios.create({
    baseURL: 'https://api-v2.storista.io',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 30_000,
  });

  try {
    const stat = fs.statSync(filePath);

    // Step 1 — pre-sign
    const { data: presign } = await s.post('/v1/media/pre-sign', {
      filename, content_type: 'video/mp4', size: stat.size,
    });
    console.log('[storista] presign response keys:', Object.keys(presign), JSON.stringify(presign).slice(0, 300));

    const upload_id = presign.upload_id || presign.id || presign.key || presign.media_id;
    const upload_url = presign.upload_url || presign.url || presign.presigned_url;
    if (!upload_url) throw new Error(`Presign missing upload_url — got: ${JSON.stringify(presign)}`);

    // Step 2 — PUT to S3
    const fileBuffer = fs.readFileSync(filePath);
    console.log(`[storista] uploading ${Math.round(stat.size / 1024 / 1024)}MB to S3 upload_id=${upload_id}`);
    const s3Res = await axios.put(upload_url, fileBuffer, {
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 300_000,
    });
    console.log('[storista] S3 PUT status:', s3Res.status, s3Res.statusText);

    // Step 3 — create media record; body is flat (no data wrapper), returns { id: integer, ... }
    const { data: media } = await s.post('/v1/media/', { upload_id, name: filename });
    console.log('[storista] media created full response:', JSON.stringify(media).slice(0, 400));

    // Step 4 — verify media is accessible (quick GET to confirm Storista accepted it)
    await new Promise(r => setTimeout(r, 2000));
    try {
      const { data: verify } = await axios.get(`https://api-v2.storista.io/v1/media/${media.id}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        timeout: 10_000,
      });
      console.log('[storista] media verify GET:', JSON.stringify(verify).slice(0, 300));
    } catch (verErr) {
      console.warn('[storista] media verify FAILED (may still be processing):', verErr.response?.status, JSON.stringify(verErr.response?.data));
    }

    // Keep the file in UPLOAD_DIR so Buffer can reference it for cross-posting.
    // A periodic cleanup in the scheduler removes videos older than 7 days.
    const uploadUrl = `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`;
    res.json({ ok: true, media_id: media.id, filename, uploadUrl });
  } catch (e) {
    if (tempFile && filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const errDetail = e.response?.data;
    const errMsg    = errDetail
      ? (typeof errDetail === 'string' ? errDetail : JSON.stringify(errDetail))
      : e.message;
    console.error('[storista] client upload error:', errMsg);
    res.status(e.response?.status || 500).json({ error: errMsg });
  }
});

// POST /api/client/storista/generate-caption
// Video file → Whisper (MP4 native, no ffmpeg) → Claude Haiku → TikTok caption
app.post('/api/client/storista/generate-caption', requireClientSession, clientUpload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Video file required' });

  const OPENAI_KEY    = process.env.OPENAI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!OPENAI_KEY) {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
    return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY not configured' });
  }

  const brands    = loadBrands();
  const brand     = brands.clients.find(b => b.id === req.session.clientBrandId);
  const videoPath = req.file.path;
  const audioPath = videoPath.replace(/\.[^.]+$/, '') + '_audio.mp3';

  try {
    // Extract audio via ffmpeg — caps at 90 s, 64kbps mono → typically < 1 MB even for large videos
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo().audioChannels(1).audioBitrate('64k').format('mp3')
        .outputOptions(['-t', '90'])
        .on('error', reject).on('end', resolve).save(audioPath);
    });

    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    fd.append('model', 'whisper-1');
    const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', fd, {
      headers: { ...fd.getHeaders(), Authorization: `Bearer ${OPENAI_KEY}` },
      timeout: 120_000,
    });
    const transcript = whisperRes.data.text || '';

    let caption = transcript;
    if (ANTHROPIC_KEY && transcript) {
      const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are a TikTok content creator writing a caption for a TikTok Shop product video.

Brand: ${brand?.name || ''}${req.body.productName ? `\nProduct: ${req.body.productName}` : ''}
Video transcript: "${transcript}"

Write a TikTok caption that:
- Is 1-3 sentences, punchy and conversational
- Highlights the key benefit or moment shown in the video
- Ends with 5-8 relevant hashtags (mix of niche + broad tags like #TikTokMadeMeBuyIt)
- Keep total caption under 220 characters

Return ONLY the caption text with hashtags. No explanation, no quotes.`
        }],
      });
      caption = msg.content[0]?.text?.trim() || transcript;
    }

    res.json({ ok: true, caption, transcript });
  } catch (e) {
    console.error('[storista] generate-caption error:', e.message);
    res.json({ ok: false, error: e.response?.data?.error?.message || e.message, caption: '', transcript: '' });
  } finally {
    try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch(_) {}
    try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch(_) {}
  }
});

// POST /api/client/storista/caption-from-transcript
// Lightweight JSON: transcript → Claude Haiku → TikTok caption (no file upload)
app.post('/api/client/storista/caption-from-transcript', requireClientSession, express.json(), async (req, res) => {
  const { transcript, productName } = req.body || {};
  if (!transcript) return res.status(400).json({ ok: false, error: 'transcript required' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.json({ ok: true, caption: transcript });

  const brands = loadBrands();
  const brand  = brands.clients.find(b => b.id === req.session.clientBrandId);

  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are a TikTok content creator writing a caption for a TikTok Shop product video.

Brand: ${brand?.name || ''}${productName ? `\nProduct: ${productName}` : ''}
Video transcript: "${transcript}"

Write a TikTok caption that:
- Is 1-3 sentences, punchy and conversational
- Highlights the key benefit or moment shown in the video
- Ends with 5-8 relevant hashtags (mix of niche + broad tags like #TikTokMadeMeBuyIt)
- Keep total caption under 220 characters

Return ONLY the caption text with hashtags. No explanation, no quotes.`
      }],
    });
    res.json({ ok: true, caption: msg.content[0]?.text?.trim() || transcript });
  } catch (e) {
    console.error('[storista] caption-from-transcript error:', e.message);
    res.json({ ok: false, error: e.message, caption: transcript });
  }
});

// POST /api/client/logo — upload brand logo (client session auth)
// Registered BEFORE app.use(requireAuth): client-session users have no Cloudflare
// Access header, so requireAuth 401d them before requireClientSession ever ran
// (root cause of the broken onboarding logo button — Roots by Ga, June 12).
// Lazy multer because imageUpload is defined later in this file.
app.post('/api/client/logo', requireClientSession, (req, res, next) => {
  const upload = require('multer')({
    storage: require('multer').diskStorage({
      destination: (_, __, cb) => cb(null, UPLOAD_DIR),
      filename:    (_, file, cb) => {
        const ext  = path.extname(file.originalname) || '';
        const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
        cb(null, `${Date.now()}_${base}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
      const ok = /image\//.test(file.mimetype) || /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(file.originalname);
      cb(ok ? null : new Error('Only image files are allowed'), ok);
    },
  }).single('logo');
  upload(req, res, (err) => err ? res.status(400).json({ error: err.message }) : next());
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file received' });
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.session.clientBrandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  const old = brands.clients[idx].logoUrl;
  if (old) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(old.split('?')[0]));
    if (oldPath.startsWith(UPLOAD_DIR)) fs.unlink(oldPath, () => {});
  }
  const logoUrl = `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`;
  brands.clients[idx].logoUrl = logoUrl;
  saveBrands(brands);
  res.json({ ok: true, logoUrl });
});

// DELETE /api/client/logo — remove brand logo (client session auth, pre-requireAuth)
app.delete('/api/client/logo', requireClientSession, (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.session.clientBrandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  const logoUrl = brands.clients[idx].logoUrl;
  if (logoUrl) {
    const filePath = path.join(UPLOAD_DIR, path.basename(logoUrl.split('?')[0]));
    if (filePath.startsWith(UPLOAD_DIR)) fs.unlink(filePath, () => {});
  }
  delete brands.clients[idx].logoUrl;
  saveBrands(brands);
  res.json({ ok: true });
});

// Creator Cadence engine — portal-admin gated approval page for launch texts + weekly-call reminders.
// Must be before requireAuth so portal.cultcontent.cc (no CF Access) can reach it.
try { require('./routes/creator-cadence').mount(app, { DATA_DIR }); }
catch (e) { console.error('[creator-cadence] mount failed:', e.message); }

try { require('./routes/tiktok-api-map').mount(app, { requirePortalAdmin }); }
catch (e) { console.error('[tiktok-api-map] mount failed:', e.message); }

try { require('./routes/financial-dashboard').mount(app, { requirePortalAdmin }); }
catch (e) { console.error('[financial-dashboard] mount failed:', e.message); }

try { require('./routes/open-collab-queue').mount(app, { DATA_DIR, requirePortalAdmin }); }
catch (e) { console.error('[open-collab-queue] mount failed:', e.message); }

try { require('./routes/link-tracker').mount(app, { DATA_DIR }); }
catch (e) { console.error('[link-tracker] mount failed:', e.message); }

// ── POST /ccc-community-apply ─────────────────────────────────────────────────
// Same-origin handler so submissions land even if Railway is briefly unreachable.
// Lark write is synchronous (primary storage). Railway fires in background for
// GHL tagging and Tommy's notification.
app.post('/ccc-community-apply', express.json(), async (req, res) => {
  const { name, email, city, brand, product, handle, invited_by } = req.body || {};
  if (!email || !brand) {
    return res.status(400).json({ ok: false, error: 'email and brand are required' });
  }

  const [firstName, ...rest] = (name || '').trim().split(' ');
  const lastName = rest.join(' ');
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  // Write to Lark synchronously — this is the primary record
  const CCC_BASE  = 'R6vxbuk23aN0MHsSS8KuPv3UtQd';
  const VENDOR_TABLE = 'tblzlhu9pL4YmEEm';
  try {
    await larkApi('post', `/bitable/v1/apps/${CCC_BASE}/tables/${VENDOR_TABLE}/records`, {
      fields: {
        'Submission Time': ts,
        'First Name':      firstName || name || '',
        'Last Name':       lastName || '',
        'Email':           email,
        'Brand':           brand,
        'Product Type':    product || '',
        'Social Handle':   handle ? `@${handle.replace(/^@/, '')}` : '',
        'City':            city || '',
        'Invited By':      invited_by || '',
        'Status':          'Pending Review',
      },
    });
    console.log(`[CCC-VENDOR] Lark record created — ${brand} / ${email}`);
  } catch (larkErr) {
    console.error('[CCC-VENDOR] Lark write failed:', larkErr.message);
    // Still respond 200 — Railway will attempt a secondary write below
  }

  res.json({ ok: true });

  // Fire Railway in background for GHL contact + Tommy's notification
  axios.post(`${CFG.railwayUrl}/ccc-community-apply`, { name, email, city, brand, product, handle, invited_by })
    .catch(e => console.warn('[CCC-VENDOR] Railway secondary write failed:', e.message));
});

// ── GET /ccc-booth-availability, POST /ccc-booth-signup ────────────────────────
// SQLite (lib/ccc-booths.js) is the system of record — same-origin, no Railway
// dependency. Best-effort Lark mirror below keeps Tommy's existing grid view
// populated without ever blocking or failing the response.
app.get('/ccc-booth-availability', (req, res) => {
  res.json(cccBooths.getAvailability());
});

app.post('/ccc-booth-signup', express.json(), (req, res) => {
  const { booth_type, first_name, last_name, email, brand_name, product_category, invited_by } = req.body || {};
  const result = cccBooths.createSignup({ booth_type, first_name, last_name, email, brand_name, product_category, invited_by });
  if (!result.ok) {
    return res.status(result.error === 'sold_out' ? 409 : 400).json(result);
  }
  res.json({ ok: true, paymentUrl: result.paymentUrl });

  // Best-effort mirror to the existing Lark table — fire-and-forget, never blocks the
  // response above. Skipped entirely (no wasted request) until CCC_BOOTH_LARK_TABLE_ID
  // is set — set it to the "Booth Signups" table id (Lark URL: .../table/<this>) to enable.
  const BOOTH_TABLE = process.env.CCC_BOOTH_LARK_TABLE_ID;
  if (BOOTH_TABLE) {
    const CCC_BASE = 'R6vxbuk23aN0MHsSS8KuPv3UtQd';
    larkApi('post', `/bitable/v1/apps/${CCC_BASE}/tables/${BOOTH_TABLE}/records`, {
      fields: {
        'Submission Time':  result.submissionTime,
        'Booth Type':       cccBooths.CCC_BOOTHS[booth_type]?.label || booth_type,
        'First Name':       first_name || '',
        'Last Name':        last_name || '',
        'Email':            email,
        'Brand Name':       brand_name,
        'Product Category': product_category || '',
        'Status':           'Pending',
        'Reservation ID':   result.reservationId,
        'Payment URL':      result.paymentUrl,
        'Invited By':       invited_by || '',
      },
    }).catch(e => console.warn('[CCC-BOOTH] Lark mirror write failed:', e.message));
  }
});

// ── Creator Carnival Networking Hub ─────────────────────────────────────────────
// Roster of approved creators + brands. Session-gated pages below use their own
// requireNetworkSession middleware (not the CF-Access requireAuth wall further
// down) — same pattern as /client/dashboard's requireClientSession.
function requireNetworkSession(req, res, next) {
  const person = req.session?.networkPersonId ? cccNet.getPerson(req.session.networkPersonId) : null;
  if (!person || person.status !== 'approved') {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Not authenticated' });
    return res.redirect('/ccc-network/login');
  }
  req.networkPerson = person;
  next();
}

app.post('/ccc-network/signup', express.json(), (req, res) => {
  const result = cccNet.signup(req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
  if (!result.ok) return;

  // Self-serve account: send a confirm-your-email link right away — no
  // admin approval required. Clicking it (GET /ccc-network/auth/:token,
  // shared with the login flow below) both proves the email is real and
  // activates the account in one step.
  const verifyLink = cccNet.createVerifyLink(result.uuid);
  if (verifyLink) cccNetMail.sendVerifyEmail(verifyLink.person, verifyLink.token).catch(e => console.error('[ccc-network] verify email error:', e.message));

  // Notify Tommy — FYI only now, not a review gate. Fire-and-forget, same
  // shape as /ccc-community-apply.
  const CCC_BASE  = 'R6vxbuk23aN0MHsSS8KuPv3UtQd';
  const VENDOR_TABLE = 'tblzlhu9pL4YmEEm';
  const p = req.body || {};
  larkApi('post', `/bitable/v1/apps/${CCC_BASE}/tables/${VENDOR_TABLE}/records`, {
    fields: {
      'Submission Time': new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
      'First Name': p.first_name || '', 'Last Name': p.last_name || '', 'Email': p.email || '',
      'Brand': p.role === 'brand' ? p.brand_name : (p.tiktok_handle || p.instagram_handle || ''),
      'Product Type': `[Networking Roster — ${p.role}] ${p.category || ''}`,
      'Status': 'New signup (self-serve, pending email confirmation)',
    },
  }).catch(e => console.warn('[CCC-NETWORK] Lark notify failed:', e.message));
});

app.post('/ccc-network/login', express.json(), async (req, res) => {
  const link = cccNet.createMagicLink(req.body?.email || '');
  res.json({ ok: true }); // always generic — don't leak whether the email exists
  if (link) cccNetMail.sendMagicLinkEmail(link.person, link.token).catch(e => console.error('[ccc-network] magic link send error:', e.message));
});

app.get('/ccc-network/auth/:token', (req, res) => {
  const result = cccNet.consumeMagicLink(req.params.token);
  // Points back at signup, not login: login's magic link only sends for an
  // already-approved account (createMagicLink requires status='approved').
  // Most links that land here belong to a still-pending signup confirmation
  // whose token expired/got reused/never existed — sending those people to
  // login was a silent dead end (createMagicLink returns null, the route
  // still responds generically "ok", nothing ever arrives). Resubmitting
  // the same email on signup, by contrast, works for both cases: a pending
  // account gets a fresh confirmation link (see the resend-while-pending
  // logic in cccNet.signup), and an already-approved account gets a clear
  // "already_registered — try logging in instead" error pointing them the
  // rest of the way, rather than no feedback at all.
  if (!result.ok) return res.status(400).send(`<p style="font-family:sans-serif;text-align:center;padding:80px 20px;">Link ${result.error === 'expired' ? 'expired' : 'invalid'} — <a href="/ccc-network">enter your email again</a> to get a new one.</p>`);

  // A link consumed while still 'pending' is the self-serve signup
  // confirmation (see createVerifyLink) — clicking it both verifies the
  // email and activates the account, with no admin step in between.
  // Doesn't touch 'rejected'/'deactivated' — requireNetworkSession still
  // bounces those regardless of what session cookie gets set below.
  let person = result.person;
  if (person.status === 'pending') {
    person = cccNet.setStatus(person.uuid, { status: 'approved' }).person;
  }

  req.session.networkPersonId = person.id;
  const incomplete = !person.bio && !person.looking_for;
  res.redirect(incomplete ? '/ccc-network/settings' : '/ccc-network/home');
});

app.get('/ccc-network/logout', (req, res) => {
  delete req.session.networkPersonId;
  res.redirect('/ccc-network/login');
});

app.get('/api/ccc-network/me', requireNetworkSession, (req, res) => {
  res.json({ ok: true, person: req.networkPerson });
});

app.post('/ccc-network/profile', requireNetworkSession, express.json(), (req, res) => {
  const updated = cccNet.updateProfile(req.networkPerson.id, req.body || {});
  res.json({ ok: true, person: updated });
});

app.get('/api/ccc-network/directory.json', requireNetworkSession, (req, res) => {
  res.json(cccNet.listDirectory(req.networkPerson));
});

// POST /ccc-network/connect/:uuid — sends (or re-sends after a decline) a
// connection request. No contact info in the response anymore — that only
// unlocks once the recipient accepts (see /connections/:uuid/accept below).
app.post('/ccc-network/connect/:uuid', requireNetworkSession, (req, res) => {
  const result = cccNet.connect(req.networkPerson.id, req.params.uuid);
  res.status(result.ok ? 200 : 400).json(result);
  if (result.ok && result.status === 'pending' && result.otherPerson) {
    cccNetMail.sendConnectionRequestEmail(result.otherPerson, req.networkPerson).catch(e => console.error('[ccc-network] connect-request email error:', e.message));
  }
});

app.post('/ccc-network/connections/:uuid/accept', requireNetworkSession, (req, res) => {
  const result = cccNet.respondToConnection(req.networkPerson.id, req.params.uuid, true);
  res.status(result.ok ? 200 : 400).json(result);
  if (result.ok) cccNetMail.sendConnectionAcceptedEmail(result.otherPerson, req.networkPerson).catch(e => console.error('[ccc-network] connect-accepted email error:', e.message));
});

app.post('/ccc-network/connections/:uuid/decline', requireNetworkSession, (req, res) => {
  const result = cccNet.respondToConnection(req.networkPerson.id, req.params.uuid, false);
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/api/ccc-network/connections', requireNetworkSession, (req, res) => {
  res.json({ ok: true, ...cccNet.listConnections(req.networkPerson.id) });
});

app.get('/api/ccc-network/people/:uuid', requireNetworkSession, (req, res) => {
  const profile = cccNet.getPersonProfile(req.networkPerson.id, req.params.uuid);
  if (!profile) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, person: profile });
});

// ── Inbox / messaging — only between accepted connections ──────────────────────
app.get('/api/ccc-network/inbox', requireNetworkSession, (req, res) => {
  res.json({ ok: true, conversations: cccNetMsg.listInbox(req.networkPerson.id), unread: cccNetMsg.unreadCount(req.networkPerson.id) });
});

app.get('/api/ccc-network/messages/:uuid', requireNetworkSession, (req, res) => {
  const result = cccNetMsg.listThread(req.networkPerson.id, req.params.uuid);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/ccc-network/messages/:uuid', requireNetworkSession, express.json(), (req, res) => {
  const result = cccNetMsg.sendMessage(req.networkPerson.id, req.params.uuid, req.body?.body);
  res.status(result.ok ? 200 : 400).json(result);
  if (result.ok) cccNetMail.sendNewMessageEmail(result.otherPerson, req.networkPerson).catch(e => console.error('[ccc-network] new-message email error:', e.message));
});

// ── Settings ─────────────────────────────────────────────────────────────────────
app.post('/ccc-network/settings/notifications', requireNetworkSession, express.json(), (req, res) => {
  const person = cccNet.setNotificationPrefs(req.networkPerson.id, req.body || {});
  res.json({ ok: true, person });
});

app.post('/ccc-network/settings/tier', requireNetworkSession, express.json(), (req, res) => {
  if (req.networkPerson.role !== 'brand') return res.status(400).json({ ok: false, error: 'creators do not have a tier' });
  const result = cccNet.setTierRequest(req.networkPerson.id, req.body?.tier);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/ccc-network/settings/deactivate', requireNetworkSession, (req, res) => {
  cccNet.deactivate(req.networkPerson.id);
  delete req.session.networkPersonId;
  res.json({ ok: true });
});

app.post('/ccc-network/settings/email', requireNetworkSession, express.json(), (req, res) => {
  const result = cccNet.requestEmailChange(req.networkPerson.id, req.body?.email);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true });
  cccNetMail.sendEmailChangeVerification(req.networkPerson, result.newEmail, result.token).catch(e => console.error('[ccc-network] email-change verification error:', e.message));
});

app.get('/ccc-network/settings/email/confirm/:token', (req, res) => {
  const result = cccNet.confirmEmailChange(req.params.token);
  if (!result.ok) return res.status(400).send(`<p style="font-family:sans-serif;text-align:center;padding:80px 20px;">Link ${result.error === 'expired' ? 'expired' : 'invalid'}.</p>`);
  res.redirect('/ccc-network/settings');
});

app.get('/ccc-network/contacts.csv', requireNetworkSession, (req, res) => {
  if (req.networkPerson.role !== 'brand' || !cccNet.PRIORITY_TIERS.includes(req.networkPerson.tier)) {
    return res.status(403).send('Contact list export is available to Marketplace and Carnival sponsors.');
  }
  const rows = cccNet.listApprovedCreatorsForExport();
  const cols = ['first_name','last_name','email','phone','tiktok_handle','instagram_handle','category','bio'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  res.set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="creator-carnival-contacts.csv"').send(csv);
});

// ── Networking Hub UI — React + HeroUI mini-app (ccc-network-app/) ─────────────
// Everything above this point (signup, login, auth token, logout, profile save,
// directory.json, connect, contacts.csv, admin) is the real API surface the SPA
// calls into — unchanged by moving the UI to React. This just serves the built
// app's static assets, then a catch-all for its client-side routes (/, /login,
// /profile, /directory). Registered last in this block so it never shadows the
// real GET routes above it (/ccc-network/auth/:token, /ccc-network/logout).
app.use('/ccc-network', express.static(CCC_NETWORK_APP_DIST));
app.get(['/ccc-network', '/ccc-network/*'], (req, res) => {
  const indexFile = path.join(CCC_NETWORK_APP_DIST, 'index.html');
  if (!fs.existsSync(indexFile)) {
    return res.status(503).send('Networking Hub UI not built yet — run `npm run build` (or `npm run build --prefix ccc-network-app`).');
  }
  res.sendFile(indexFile);
});

app.use(requireAuth); // all other routes require auth in production

// ── Creator Carnival Networking Hub — admin ─────────────────────────────────────
// Standalone page (not part of the ccc-network-app SPA, which is public) —
// lives behind the requireAuth wall above like the rest of /dashboard.
app.get('/ccc-network-admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'ccc-network-admin.html'));
});

app.get('/api/admin/ccc-network/people', (req, res) => {
  const { role, status, tier } = req.query;
  res.json({ ok: true, rows: cccNet.listAll({ role, status, tier }) });
});

app.get('/api/admin/ccc-network/people.csv', (req, res) => {
  const { role, status, tier } = req.query;
  const rows = cccNet.listAll({ role, status, tier });
  const cols = ['id','uuid','role','tier','status','first_name','last_name','email','phone','brand_name','tiktok_handle','instagram_handle','category','looking_for','created_at','approved_at'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  res.set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="ccc-network-people.csv"').send(csv);
});

app.post('/api/admin/ccc-network/people/:uuid/status', express.json(), async (req, res) => {
  const result = cccNet.setStatus(req.params.uuid, req.body || {});
  res.status(result.ok ? 200 : (result.error === 'not_found' ? 404 : 400)).json(result);
  if (result.ok && result.person.status === 'approved') {
    const link = cccNet.createMagicLink(result.person.email);
    if (link) cccNetMail.sendApprovalEmail(link.person, link.token).catch(e => console.error('[ccc-network] approval email error:', e.message));
  }
});

// ── CCC booth signups — admin ───────────────────────────────────────────────────
// Replaces browsing the Lark grid. Manual status endpoint is the Paid/Expired/
// Cancelled fallback until a real Stripe webhook is wired up (no keys yet).
app.get('/api/admin/ccc-booth-signups', (req, res) => {
  const { booth_type, status } = req.query;
  res.json({ ok: true, rows: cccBooths.listAll({ booth_type, status }) });
});

app.get('/api/admin/ccc-booth-signups.csv', (req, res) => {
  const { booth_type, status } = req.query;
  const rows = cccBooths.listAll({ booth_type, status });
  const cols = ['id','reservation_id','booth_type','submission_time','first_name','last_name','email','brand_name','product_category','status','payment_url','invited_by','created_at'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  res.set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="ccc-booth-signups.csv"').send(csv);
});

app.post('/api/admin/ccc-booth-signups/:reservationId/status', express.json(), (req, res) => {
  const result = cccBooths.setStatus(req.params.reservationId, req.body?.status);
  res.status(result.ok ? 200 : (result.error === 'not_found' ? 404 : 400)).json(result);
});

// POST /api/client/admin/set-password — CF Access protected; sets/resets a client's login password
app.post('/api/client/admin/set-password', express.json(), async (req, res) => {
  try {
    const { brandId, password } = req.body || {};
    if (!brandId || !password || password.length < 8) {
      return res.status(400).json({ error: 'brandId and password (min 8 chars) required' });
    }
    const brands = loadBrands();
    const idx = (brands.clients || []).findIndex(b => b.id === brandId);
    if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
    brands.clients[idx].passwordHash = await bcrypt.hash(password, 12);
    saveBrands(brands);
    res.json({ ok: true, brandId, name: brands.clients[idx].name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/admin/set-email — CF Access protected; sets loginEmail for a brand
app.post('/api/client/admin/set-email', express.json(), async (req, res) => {
  try {
    const { brandId, loginEmail } = req.body || {};
    if (!brandId || !loginEmail) return res.status(400).json({ error: 'brandId and loginEmail required' });
    const brands = loadBrands();
    const idx = (brands.clients || []).findIndex(b => b.id === brandId);
    if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
    brands.clients[idx].loginEmail = loginEmail.toLowerCase().trim();
    saveBrands(brands);
    res.json({ ok: true, brandId, loginEmail: brands.clients[idx].loginEmail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve index.html with no-cache to prevent Cloudflare/browser serving stale versions
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});
app.get('/index.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'dashboard')));
app.use('/tools', express.static(path.join(__dirname)));

const CFG = {
  ghlApiKey:  process.env.GHL_API_KEY,
  locationId: process.env.GHL_LOCATION_ID || process.env.GHL_LOC_ID,
  railwayUrl: process.env.RAILWAY_URL  || 'https://cultcontent-server-production.up.railway.app',
  port:       process.env.PORT || process.env.DASHBOARD_PORT || 3457,
};

const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${CFG.ghlApiKey}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  },
});

// ─── Reacher API client ───────────────────────────────────────��───────────────
const REACHER_BASE = 'https://api.reacherapp.com/public/v1';
function reacherClient(shopId) {
  const headers = { 'x-api-key': process.env.REACHER_API_KEY || '', 'Content-Type': 'application/json' };
  if (shopId) headers['x-shop-id'] = String(shopId);
  return axios.create({ baseURL: REACHER_BASE, timeout: 20000, headers });
}

// ─── Simple TTL cache ���───────────────────────��─────────────────────────────────
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  const data = await fn();
  cache.set(key, { data, ts: Date.now() });
  return data;
}

// ─── Snapshot store ────────────────────────────────────────────────────────────
function loadSnaps() {
  try { if (fs.existsSync(SNAP_FILE)) return JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8')); }
  catch (e) { console.error('snap load:', e.message); }
  return {};
}
function saveSnaps(data) {
  try { fs.writeFileSync(SNAP_FILE, JSON.stringify(data)); }
  catch (e) { console.error('snap save:', e.message); }
}
// Record metrics for a platform/handle. De-dupes within 2 hours.
function recordSnap(platform, handle, metrics) {
  const snaps = loadSnaps();
  if (!snaps[platform]) snaps[platform] = {};
  if (!snaps[platform][handle]) snaps[platform][handle] = [];
  const arr = snaps[platform][handle];
  const now = Date.now();
  const last = arr[arr.length - 1];
  if (last && now - last.ts < 7_200_000) return; // skip if < 2h since last snap
  arr.push({ ts: now, ...metrics });
  if (arr.length > 365) arr.splice(0, arr.length - 365); // keep ~1yr at daily
  saveSnaps(snaps);
}

// ─── TikTok token helpers ───────────────────────────���──────────────────────────
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';
const tiktokAuthState     = new Map(); // PKCE state store (short-lived, in-memory)
const creatorTikTokStates = new Map(); // State store for creator page TikTok Display API OAuth

function loadTikTokTokens() {
  try { if (fs.existsSync(TIKTOK_TOKENS_FILE)) return JSON.parse(fs.readFileSync(TIKTOK_TOKENS_FILE, 'utf8')); }
  catch(e) {}
  return {};
}
function saveTikTokTokens(tokens) {
  try { fs.writeFileSync(TIKTOK_TOKENS_FILE, JSON.stringify(tokens, null, 2)); }
  catch(e) { console.error('TikTok token save:', e.message); }
}
function getTikTokToken(account = 'personal') {
  const t = loadTikTokTokens()[account];
  if (!t || Date.now() > t.expires_at - 60_000) return null;
  return t.access_token;
}

// ─── GHL routes ───────────────────────────────────────────────────────────────
app.get('/api/ghl/contacts', async (req, res) => {
  try {
    const data = await cached('contacts', 60_000, async () => {
      const { data } = await ghl.get('/contacts/', {
        params: { locationId: CFG.locationId, limit: 25, sortBy: 'date_added' },
      });
      return data;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// Stage priority — higher = closer to close
const STAGE_PRIORITY = {
  // Sales pipeline
  '8be01a87-16c1-4741-ba34-b5827ae598df': { name: 'Leads',              pipeline: 'Sales', priority: 1 },
  '8c0bd16c-e0f9-42b4-9e3c-e4464f07e127': { name: 'Engaged',            pipeline: 'Sales', priority: 2 },
  '22223b31-6904-49d1-8b38-bc8bb6104926': { name: 'Asked to Rebook',    pipeline: 'Sales', priority: 3 },
  'c295a69d-9794-43e8-a48b-705529c621bb': { name: 'No Show',            pipeline: 'Sales', priority: 1 },
  'd268eec7-da68-4d15-a5cf-627a309fa64c': { name: 'Booked',             pipeline: 'Sales', priority: 4 },
  '22d39138-ff86-49ac-8076-51444eb462d4': { name: 'Pitched',            pipeline: 'Sales', priority: 5 },
  '8de4bef0-77c5-4711-a306-38a5c90fdaeb': { name: 'Progressing',       pipeline: 'Sales', priority: 6 },
  '812366ea-bfe5-4283-9201-45fdc1443da2': { name: 'Hotlist',            pipeline: 'Sales', priority: 7 },
  'dc34a26b-1407-4337-a5a9-c7ad512aebdd': { name: 'Contract Signed',   pipeline: 'Sales', priority: 8 },
  '9460436e-3bc2-4b40-b225-c9437642c8cc': { name: 'Funding',           pipeline: 'Sales', priority: 9 },
  '6e634d48-b9fe-4e36-bb75-36c20bc15f26': { name: 'Down Payment',      pipeline: 'Sales', priority: 10 },
  'f668d4de-cd45-4466-87c7-3225f1b4f1b1': { name: 'Closed (Paid)',     pipeline: 'Sales', priority: 11 },
  // Client Onboarding
  'af7cd927-068b-4ff9-9f9a-1eef11e2822b': { name: 'DFY Active',        pipeline: 'Onboarding', priority: 3 },
  '01d509a7-a5ed-4750-b054-4566eb383e50': { name: 'DWY Active',        pipeline: 'Onboarding', priority: 2 },
  'c99a4890-ecb5-413f-96e6-d402dfbd8493': { name: 'DIY Active',        pipeline: 'Onboarding', priority: 1 },
  'b9436609-7d8d-48e2-a99d-09d265c7fd24': { name: 'Churned',           pipeline: 'Onboarding', priority: 0 },
  // TAP Acquisition
  '6debbdd0-216d-4427-b1d5-407d66eec493': { name: 'TAP Prospect',      pipeline: 'TAP', priority: 1 },
  '66b7c504-8b92-45b7-bc0e-b115ade1c6ea': { name: 'TAP Registered',    pipeline: 'TAP', priority: 2 },
  '07070943-cefb-490e-8b9a-9d3118cd1087': { name: 'Strategy Call',     pipeline: 'TAP', priority: 3 },
  '5ef53f71-042f-4252-b39f-d98822e54491': { name: 'Nurture',           pipeline: 'TAP', priority: 1 },
  '02f59d08-f127-425c-ac46-bfb0d05f9dbc': { name: 'Disqualified',      pipeline: 'TAP', priority: 0 },
};

// Known pipeline IDs — fetched once via /api/ghl/pipelines
const PIPELINE_IDS = [
  'Iuz4OdYK1lCynyHsL8Yf', // Sales
  'YUSTwu6HU6CaLeCsxknn', // Client Onboarding
  'cUapXHqp33s4yBipkYSd', // TAP Acquisition
  'gB4FFca2PBGzerClsyJb', // Support Channel Requests
];

app.get('/api/ghl/opportunities', async (req, res) => {
  try {
    const data = await cached('opportunities', 60_000, async () => {
      // Fetch each pipeline in parallel so we don't hit the 100-opp cap
      const results = await Promise.allSettled(
        PIPELINE_IDS.map(pid =>
          ghl.get('/opportunities/search', {
            params: { location_id: CFG.locationId, pipeline_id: pid, limit: 100 },
          }).then(r => r.data.opportunities || [])
        )
      );
      const allOpps = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);
      // Annotate each opportunity with stage name + pipeline + priority
      const opps = allOpps.map(o => ({
        ...o,
        stageName:    STAGE_PRIORITY[o.pipelineStageId]?.name     || 'Unknown',
        pipelineName: STAGE_PRIORITY[o.pipelineStageId]?.pipeline  || 'Other',
        stagePriority:STAGE_PRIORITY[o.pipelineStageId]?.priority  || 0,
      }));
      return { opportunities: opps, total: opps.length };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/ghl/appointments', async (req, res) => {
  try {
    const data = await cached('appointments', 60_000, async () => {
      // GHL requires a calendarId — fetch all calendars first, then merge events
      const { data: calData } = await ghl.get('/calendars/', {
        params: { locationId: CFG.locationId },
      });
      const calendars = (calData.calendars || []).slice(0, 10); // cap at 10 calendars
      if (!calendars.length) return { events: [] };

      const now = Date.now();
      const end = now + 14 * 24 * 60 * 60 * 1000;

      const results = await Promise.allSettled(
        calendars.map(cal =>
          ghl.get('/calendars/events', {
            params: { locationId: CFG.locationId, calendarId: cal.id, startTime: now, endTime: end },
          }).then(r => r.data.events || [])
        )
      );
      const events = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value)
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
        .slice(0, 25);

      return { events };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/ghl/workflows', async (req, res) => {
  try {
    const data = await cached('workflows', 300_000, async () => {
      const { data } = await ghl.get('/workflows/', {
        params: { locationId: CFG.locationId },
      });
      return data;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/ghl/conversations', async (req, res) => {
  const { limit = 50, status, query } = req.query;
  const cacheKey = `conversations_${limit}_${status || 'all'}_${query || ''}`;
  try {
    const data = await cached(cacheKey, 60_000, async () => {
      const params = { locationId: CFG.locationId, limit: parseInt(limit) };
      if (status && status !== 'all') params.status = status;
      if (query) params.query = query;
      const { data } = await ghl.get('/conversations/search', { params });
      return data;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/ghl/conversations/:id/messages
app.get('/api/ghl/conversations/:id/messages', async (req, res) => {
  const { id } = req.params;
  try {
    const data = await cached(`conv_msgs_${id}`, 30_000, async () => {
      const { data } = await ghl.get(`/conversations/${id}/messages`, {
        params: { limit: 100 },
      });
      return data;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/ghl/conversations/:id/reply
app.post('/api/ghl/conversations/:id/reply', async (req, res) => {
  const { id } = req.params;
  const { message, type = 'SMS' } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
  try {
    const { data } = await ghl.post('/conversations/messages', {
      type,
      conversationId: id,
      message,
    });
    // Bust cache so next fetch gets fresh messages
    cache.delete(`conv_msgs_${id}`);
    cache.delete(`conversations_50_all_`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ─── Railway health ────────────────────────────────────────────────────────────
app.get('/api/railway/health', async (req, res) => {
  try {
    const data = await cached('railway', 30_000, async () => {
      const { data } = await axios.get(`${CFG.railwayUrl}/health`, { timeout: 5000 });
      return { ...data, status: 'online', url: CFG.railwayUrl };
    });
    res.json(data);
  } catch (e) {
    res.json({ status: 'offline', error: e.message, url: CFG.railwayUrl });
  }
});

// ─── Cache control ─────────────────────────���──��────────────────────────────────
app.post('/api/clear-cache', (req, res) => {
  cache.clear();
  res.json({ ok: true });
});

// ─── Buffer content pipeline ────────────────���──────────────────────────────────
app.get('/api/buffer/stats', async (req, res) => {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.json({ connected: false });

  try {
    const data = await cached('buffer_stats', 120_000, async () => {
      const orgId = process.env.BUFFER_ORG_ID || '69d6ddee1fcceb5bb1faa168';
      const { data: gql } = await axios.post(
        'https://api.buffer.com/graphql',
        {
          query: `{
            posts(input:{organizationId:"${orgId}",filter:{status:[scheduled]},sort:[{field:dueAt,direction:asc}]},first:100){
              edges{node{id dueAt channelId channelService status text}}
              pageInfo{hasNextPage}
            }
          }`,
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      const posts = (gql.data?.posts?.edges || []).map(e => e.node);
      const byPlatform = {};
      for (const p of posts) {
        byPlatform[p.channelService] = (byPlatform[p.channelService] || 0) + 1;
      }
      return {
        connected: true,
        scheduledTotal: posts.length,
        hasMore: gql.data?.posts?.pageInfo?.hasNextPage || false,
        byPlatform,
        nextPost: posts[0] || null,
        upcoming: posts.slice(0, 5),
      };
    });
    res.json(data);
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// ─── YouTube stats (multi-channel) ───────────────────────────────────────────
const YT_CHANNEL_LABELS = { 'Cult-Content-CC': 'Cult Content', 'tommylynch5162': 'Tommy Lynch' };

async function fetchYTChannel(handle, key) {
  const { data } = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
    params: { part: 'statistics,snippet', forHandle: handle, key }
  });
  const ch = data.items?.[0];
  if (!ch) return null;
  const channelId = ch.id;
  const { data: vData } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
    params: { part: 'snippet', channelId, order: 'date', maxResults: 50, type: 'video', key }
  });
  const videoIds = (vData.items || []).map(v => v.id.videoId).filter(Boolean).join(',');
  let videos = [];
  if (videoIds) {
    const { data: vsData } = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'statistics,snippet', id: videoIds, key }
    });
    videos = (vsData.items || []).map(v => ({
      id: v.id, title: v.snippet.title, publishedAt: v.snippet.publishedAt,
      thumbnail: v.snippet.thumbnails?.default?.url,
      views: Number(v.statistics.viewCount || 0),
      likes: Number(v.statistics.likeCount || 0),
      comments: Number(v.statistics.commentCount || 0),
    }));
  }
  return {
    handle, label: YT_CHANNEL_LABELS[handle] || ch.snippet.title,
    channelName: ch.snippet.title,
    subscribers: Number(ch.statistics.subscriberCount || 0),
    totalViews: Number(ch.statistics.viewCount || 0),
    videoCount: Number(ch.statistics.videoCount || 0),
    recentVideos: videos,
  };
}

app.get('/api/youtube/stats', async (req, res) => {
  try {
    const data = await cached('youtube', 300_000, async () => {
      if (!process.env.YOUTUBE_API_KEY) return { connected: false };
      const key = process.env.YOUTUBE_API_KEY;
      const handles = (process.env.YOUTUBE_CHANNELS || 'Cult-Content-CC').split(',').map(h => h.trim());
      const results = await Promise.allSettled(handles.map(h => fetchYTChannel(h, key)));
      const channels = results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);
      channels.forEach(ch => recordSnap('youtube', ch.handle, { subscribers: ch.subscribers, totalViews: ch.totalViews, videoCount: ch.videoCount }));
      return { connected: true, channels };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ connected: false, error: e.response?.data?.error?.message || e.message });
  }
});

// ─── Social stats (TikTok + Instagram + X + LinkedIn via Apify) ───────────────
const SOCIAL_HANDLES = {
  tiktok: [
    { handle: process.env.TIKTOK_HANDLE_PERSONAL || '', label: 'Tommy Lynch' },
    { handle: process.env.TIKTOK_HANDLE_BRAND    || '', label: 'Cult Content' },
  ].filter(h => h.handle),
  instagram: [
    { handle: process.env.IG_HANDLE_PERSONAL || 'tommy.lynch_', label: 'Tommy Lynch' },
    { handle: process.env.IG_HANDLE_BRAND    || '',              label: 'Cult Content' },
  ].filter(h => h.handle),
  twitter: [
    { handle: process.env.X_HANDLE_PERSONAL || '', label: 'Tommy Lynch' },
    { handle: process.env.X_HANDLE_BRAND    || '', label: 'Cult Content' },
  ].filter(h => h.handle),
  linkedin: [
    { handle: process.env.LINKEDIN_HANDLE_PERSONAL || '', label: 'Tommy Lynch',  type: 'personal' },
    { handle: process.env.LINKEDIN_HANDLE_BRAND    || '', label: 'Cult Content', type: 'company'  },
  ].filter(h => h.handle),
};

app.get('/api/social/stats', async (req, res) => {
  try {
    const data = await cached('social', 600_000, async () => {
      if (!process.env.APIFY_API_KEY) return { connected: false };

      const results = { connected: true, tiktok: [], instagram: [] };

      const token = process.env.APIFY_API_KEY;

      // TikTok profiles — try Display API first (if tokens present), fall back to Apify
      if (SOCIAL_HANDLES.tiktok.length > 0) {
        const ttTokens = loadTikTokTokens();
        const ttPairs = [
          { key: 'personal', cfg: SOCIAL_HANDLES.tiktok[0] },
          { key: 'brand',    cfg: SOCIAL_HANDLES.tiktok[1] },
        ].filter(p => p.cfg && getTikTokToken(p.key));

        if (ttPairs.length > 0) {
          // Display API path
          for (const { key, cfg } of ttPairs) {
            try {
              const { data: r } = await axios.get(`${TIKTOK_API_BASE}/user/info/`, {
                headers: { Authorization: `Bearer ${getTikTokToken(key)}` },
                params: { fields: 'display_name,avatar_url,follower_count,likes_count,video_count' },
              });
              if (r.error?.code === 'ok') {
                const u = r.data.user;
                const entry = { label: cfg.label, handle: cfg.handle, followers: u.follower_count || 0, likes: u.likes_count || 0, videos: u.video_count || 0, avatar: u.avatar_url, source: 'display_api' };
                results.tiktok.push(entry);
                recordSnap('tiktok', cfg.handle, { followers: entry.followers, likes: entry.likes, videos: entry.videos });
              }
            } catch(e) { console.error(`TikTok Display API (${key}):`, e.message); }
          }
        } else {
          // Apify fallback
          try {
            const { data: runData } = await axios.post(
              `https://api.apify.com/v2/acts/clockworks~tiktok-profile-scraper/run-sync-get-dataset-items?token=${token}&timeout=60&memory=256`,
              { profiles: SOCIAL_HANDLES.tiktok.map(h => `https://www.tiktok.com/@${h.handle}`), resultsType: 'profiles', maxProfilesPerQuery: 1 },
              { timeout: 90000 }
            );
            results.tiktok = (runData || []).map(item => {
              const h = item.authorMeta?.name;
              const config = SOCIAL_HANDLES.tiktok.find(s => s.handle === h);
              return { label: config?.label || item.authorMeta?.nickName, handle: h, followers: item.authorMeta?.fans || 0, likes: item.authorMeta?.heart || 0, videos: item.authorMeta?.video || 0, avatar: item.authorMeta?.avatar };
            });
            results.tiktok.forEach(a => recordSnap('tiktok', a.handle, { followers: a.followers, likes: a.likes, videos: a.videos }));
          } catch(e) {
            const status = e.response?.status;
            console.error('TikTok Apify error:', e.response?.data || e.message);
            if (status === 402) results.apifyBillingRequired = true;
          }
        }
      }

      // Instagram profiles via Apify
      if (SOCIAL_HANDLES.instagram.length > 0) {
        try {
          const { data: runData } = await axios.post(
            `https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items?token=${token}&timeout=60&memory=256`,
            { usernames: SOCIAL_HANDLES.instagram.map(h => h.handle) },
            { timeout: 90000 }
          );
          results.instagram = (runData || []).map(item => {
            const config = SOCIAL_HANDLES.instagram.find(s => s.handle === item.username);
            return {
              label: config?.label || item.username,
              handle: item.username,
              followers: item.followersCount || 0,
              following: item.followsCount || 0,
              posts: item.postsCount || 0,
              avatar: item.profilePicUrl,
            };
          });
          results.instagram.forEach(a => recordSnap('instagram', a.handle, { followers: a.followers, following: a.following, posts: a.posts }));
        } catch (e) {
          const status = e.response?.status;
          console.error('Instagram Apify error:', e.response?.data || e.message);
          if (status === 402) results.apifyBillingRequired = true;
        }
      }

      results.twitter = [];
      results.linkedin = [];

      return results;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ connected: false, error: e.message });
  }
});

// ─── Twitter / X stats (via Apify pratikdani~twitter-profile-scraper) ─��────────
app.get('/api/twitter/stats', async (req, res) => {
  try {
    const data = await cached('twitter', 1_800_000, async () => {
      const token = process.env.APIFY_API_KEY;
      if (!token) return { connected: false };

      const handles = [
        { handle: process.env.X_HANDLE_PERSONAL || 'thlynch3', label: 'Tommy Lynch' },
        process.env.X_HANDLE_BRAND ? { handle: process.env.X_HANDLE_BRAND, label: 'Cult Content' } : null,
      ].filter(Boolean);

      const results = await Promise.allSettled(
        handles.map(h =>
          axios.post(
            `https://api.apify.com/v2/acts/pratikdani~twitter-profile-scraper/run-sync-get-dataset-items?token=${token}&memory=256&timeout=60`,
            { url: `https://twitter.com/${h.handle}` },
            { timeout: 90_000 }
          ).then(r => ({ handle: h.handle, label: h.label, raw: (r.data || [])[0] }))
        )
      );

      const accounts = results
        .filter(r => r.status === 'fulfilled' && r.value?.raw)
        .map(r => {
          const { handle, label, raw } = r.value;
          return {
            handle,
            label,
            followers:  raw.sub_count   || 0,
            following:  raw.friends      || 0,
            posts:      raw.statuses_count || 0,
            avatar:     raw.avatar       || null,
            name:       raw.name         || label,
          };
        });

      accounts.forEach(a => recordSnap('twitter', a.handle, { followers: a.followers, following: a.following, posts: a.posts }));

      return { connected: accounts.length > 0, accounts };
    });
    res.json(data);
  } catch (e) {
    console.error('Twitter stats error:', e.message);
    res.json({ connected: false, error: e.message, accounts: [] });
  }
});

// ─── LinkedIn stats (via Apify harvestapi~linkedin-profile-scraper) ───────────
app.get('/api/linkedin/stats', async (req, res) => {
  try {
    const data = await cached('linkedin', 1_800_000, async () => {
      const token = process.env.APIFY_API_KEY;
      if (!token) return { connected: false };

      const profiles = [
        process.env.LINKEDIN_HANDLE_PERSONAL
          ? { url: `https://www.linkedin.com/in/${process.env.LINKEDIN_HANDLE_PERSONAL}/`,  label: 'Tommy Lynch',  type: 'personal' }
          : null,
        process.env.LINKEDIN_HANDLE_BRAND
          ? { url: `https://www.linkedin.com/company/${process.env.LINKEDIN_HANDLE_BRAND}/`, label: 'Cult Content', type: 'company' }
          : null,
      ].filter(Boolean);

      // Scrape all profiles in one batch call
      const { data: runData } = await axios.post(
        `https://api.apify.com/v2/acts/harvestapi~linkedin-profile-scraper/run-sync-get-dataset-items?token=${token}&memory=256&timeout=90`,
        { urls: profiles.map(p => p.url) },
        { timeout: 120_000 }
      );

      const accounts = (runData || []).map(item => {
        const url = item.linkedinUrl || '';
        const config = profiles.find(p => url.includes(p.label === 'Cult Content' ? 'company/' : 'in/'));
        // Match by URL path
        const matched = profiles.find(p => {
          const pPath = p.url.replace(/^https:\/\/www\.linkedin\.com/, '').replace(/\/$/, '');
          return url.includes(pPath.replace(/\/$/, '').split('/').pop());
        }) || profiles[0];
        return {
          label:       matched?.label || item.name || item.firstName,
          type:        matched?.type  || 'personal',
          handle:      item.publicIdentifier || item.universalName,
          followers:   item.followerCount    || 0,
          connections: item.connectionsCount || 0,
          name:        item.name || `${item.firstName || ''} ${item.lastName || ''}`.trim(),
          avatar:      item.profilePicture?.url || item.logo || null,
          headline:    item.headline || item.tagline || null,
        };
      });

      accounts.forEach(a => recordSnap('linkedin', a.handle, { followers: a.followers, connections: a.connections || 0 }));

      return { connected: accounts.length > 0, accounts };
    });
    res.json(data);
  } catch (e) {
    console.error('LinkedIn stats error:', e.message);
    res.json({ connected: false, error: e.message, accounts: [] });
  }
});

// ─── GHL pipeline stages (for stage name lookup) ──────────────────────────────
app.get('/api/ghl/pipelines', async (req, res) => {
  try {
    const data = await cached('pipelines', 600_000, async () => {
      const { data } = await ghl.get('/opportunities/pipelines', {
        params: { locationId: CFG.locationId },
      });
      return data;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ─── Performance history & deltas ─────────────────────────────────────────────
app.get('/api/performance/history', (req, res) => {
  const snaps = loadSnaps();
  const now = Date.now();
  const result = {};

  for (const [platform, handles] of Object.entries(snaps)) {
    result[platform] = {};
    for (const [handle, arr] of Object.entries(handles)) {
      if (!arr.length) continue;
      const current = arr[arr.length - 1];
      // Find closest snapshot before each lookback window
      const find = (ms) => {
        const target = now - ms;
        return arr.slice().reverse().find(s => s.ts <= target) || null;
      };
      const ago7d  = find(7  * 86_400_000);
      const ago30d = find(30 * 86_400_000);
      const ago90d = find(90 * 86_400_000);
      result[platform][handle] = {
        current,
        history: arr,
        delta: {
          '7d':  ago7d  ? { followers: current.followers - ago7d.followers,  ts: ago7d.ts  } : null,
          '30d': ago30d ? { followers: current.followers - ago30d.followers, ts: ago30d.ts } : null,
          '90d': ago90d ? { followers: current.followers - ago90d.followers, ts: ago90d.ts } : null,
        },
      };
    }
  }
  res.json(result);
});

// ─── Upload queue helpers ─────────────────────────────────────────────────────
function loadQueue() {
  try { if (fs.existsSync(QUEUE_FILE)) return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); }
  catch (e) {}
  return [];
}
function saveQueue(q) {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2)); }
  catch (e) { console.error('queue save:', e.message); }
}

// Multer — store in /uploads, preserve original extension
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext  = path.extname(file.originalname) || '.mp4';
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },   // 500 MB cap
  fileFilter: (_, file, cb) => {
    const ok = /video|mp4|mov|avi|webm/i.test(file.mimetype + file.originalname)
            || file.mimetype === 'application/octet-stream';
    cb(null, ok);
  },
});

// POST /api/proposals/publish — saves HTML to UPLOAD_DIR (public via CF bypass) and returns a shareable link
app.post('/api/proposals/publish', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'No HTML provided' });
    const id = require('crypto').randomBytes(12).toString('hex');
    const filename = `proposal-${id}.html`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), html, 'utf8');
    // Use the Railway raw URL — bypasses Cloudflare Access so prospects can view without auth
    const baseUrl = 'https://cult-command-center-production.up.railway.app';
    res.json({ ok: true, url: `${baseUrl}/uploads/${filename}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/upload-config — returns the direct-upload URL + bearer token so the
// frontend can POST large files straight to Railway, bypassing Cloudflare's ~100 MB limit.
app.get('/api/upload-config', (req, res) => {
  res.json({
    uploadUrl:   `${PUBLIC_BASE_URL}/api/upload/video-direct`,
    token:       process.env.WEBHOOK_SECRET || '',
    directThreshold: 5, // MB — all real videos go direct, bypassing Cloudflare
  });
});

// POST /api/upload/video
app.post('/api/upload/video', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received — unsupported format or file too large' });

  // Auto-convert HEVC (iPhone default) → H.264 so Instagram/TikTok accept it
  try { await ensureH264(req.file.path); } catch (e) { console.warn('ensureH264 failed:', e.message); }

  const localUrl  = `/uploads/${req.file.filename}`;
  const publicUrl = `${PUBLIC_BASE_URL}${localUrl}`;
  const meta = {
    id:           req.file.filename,
    originalName: req.file.originalname,
    filename:     req.file.filename,
    size:         req.file.size,
    title:        req.body.title       || path.basename(req.file.originalname, path.extname(req.file.originalname)),
    description:  req.body.description || '',
    platforms:    req.body.platforms   ? req.body.platforms.split(',').map(s => s.trim()) : [],
    status:       'staged',
    uploadedAt:   new Date().toISOString(),
    path:         req.file.path,
    localUrl,
  };
  const q = loadQueue();
  q.unshift(meta);
  saveQueue(q);
  res.json({ ok: true, url: publicUrl, video: meta });
});

// GET /api/upload/queue
app.get('/api/upload/queue', (req, res) => {
  res.json(loadQueue());
});

// DELETE /api/upload/queue/:id
app.delete('/api/upload/queue/:id', (req, res) => {
  const q = loadQueue().filter(v => v.id !== req.params.id);
  // Remove file from disk
  const target = path.join(UPLOAD_DIR, req.params.id);
  if (fs.existsSync(target)) fs.unlinkSync(target);
  saveQueue(q);
  res.json({ ok: true });
});

// PATCH /api/upload/queue/:id — update status, or upsert if not found (for Arcads entries)
app.patch('/api/upload/queue/:id', (req, res) => {
  const q = loadQueue();
  const idx = q.findIndex(v => v.id === req.params.id);
  if (idx >= 0) {
    q[idx] = { ...q[idx], ...req.body };
  } else {
    // Upsert — used by Arcads to add URL-based entries without file upload
    q.unshift({ id: req.params.id, ...req.body });
  }
  saveQueue(q);
  res.json({ ok: true });
});

// GET /api/ghl/consultants — pull real form submission dates from the onboarding form
const CONSULTANT_FORM_ID = 'yKOFTYIE2Li3eLxxSXpW';
app.get('/api/ghl/consultants', async (req, res) => {
  try {
    const data = await cached('consultants', 120_000, async () => {
      const { data } = await ghl.get('/forms/submissions', {
        params: { locationId: CFG.locationId, formId: CONSULTANT_FORM_ID, limit: 100 },
      });
      const subs = (data.submissions || [])
        .filter(s => s.name && !/^(test|tommy lynch|george washington|prosperous life|dream big)/i.test(s.name.trim()))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const now = Date.now();
      const day = 86_400_000;
      return {
        total:     subs.length,
        thisWeek:  subs.filter(s => now - new Date(s.createdAt).getTime() < 7  * day).length,
        thisMonth: subs.filter(s => now - new Date(s.createdAt).getTime() < 30 * day).length,
        recent: subs.slice(0, 5).map(s => ({
          name:      s.name,
          createdAt: s.createdAt,
        })),
      };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/consultant/trigger — proxy to Railway webhook
app.post('/api/consultant/trigger', async (req, res) => {
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/consultant-onboard`,
      req.body,
      { timeout: 30_000 }
    );
    res.json({ ok: true, result: data });
  } catch (e) {
    const msg = e.response?.data?.error || e.response?.data?.message || e.message;
    res.json({ ok: false, error: msg });
  }
});

// ─── Arcads AI Video API ──────────────────────────────────────────────────────
const ARCADS_BASE = 'https://external-api.arcads.ai';
function arcadsClient() {
  const tok = 'Basic ' + Buffer.from(
    `${process.env.ARCADS_CLIENT_ID}:${process.env.ARCADS_CLIENT_SECRET}`
  ).toString('base64');
  return axios.create({ baseURL: ARCADS_BASE, headers: { Authorization: tok, 'Content-Type': 'application/json' } });
}

// GET /api/arcads/actors — list situations (actors) with optional filters
app.get('/api/arcads/actors', async (req, res) => {
  try {
    if (!process.env.ARCADS_CLIENT_ID) return res.json({ connected: false });
    const data = await cached('arcads_actors', 3_600_000, async () => {
      const { data } = await arcadsClient().get('/v1/situations?limit=100');
      return data;
    });
    res.json({ connected: true, ...data });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /api/arcads/stats — aggregate video counts across all scripts
app.get('/api/arcads/stats', async (req, res) => {
  try {
    if (!process.env.ARCADS_CLIENT_ID) return res.json({ connected: false });
    const productId = process.env.ARCADS_PRODUCT_ID;
    const { data } = await arcadsClient().get(`/v1/products/${productId}/folders`);
    const scripts = data.items.flatMap(f =>
      (f.scripts || []).map(s => ({ ...s, folderName: f.name, folderId: f.id }))
    );
    // Fetch video status for all scripts in parallel (cap at 20 most recent)
    const recent = scripts.slice(0, 20);
    const videoResults = await Promise.allSettled(
      recent.map(s => arcadsClient().get(`/v1/scripts/${s.id}/videos`).then(r => r.data))
    );
    const scriptStats = recent.map((s, i) => {
      const vids = videoResults[i].status === 'fulfilled'
        ? (Array.isArray(videoResults[i].value) ? videoResults[i].value : [])
        : [];
      const done    = vids.filter(v => v.videoStatus === 'completed' || v.videoUrl).length;
      const pending = vids.filter(v => v.videoStatus === 'pending' || v.videoStatus === 'processing' || v.videoStatus === 'generating').length;
      const failed  = vids.filter(v => v.videoStatus === 'failed' || v.videoStatus === 'error').length;
      const firstUrl = vids.find(v => v.videoUrl)?.videoUrl;
      return { id: s.id, name: s.name, folderName: s.folderName, done, pending, failed, firstUrl };
    });
    const totals = { scripts: scripts.length, done: 0, pending: 0, failed: 0 };
    scriptStats.forEach(s => { totals.done += s.done; totals.pending += s.pending; totals.failed += s.failed; });
    res.json({ connected: true, totals, scripts: scriptStats });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /api/arcads/scripts — list all scripts across folders
app.get('/api/arcads/scripts', async (req, res) => {
  try {
    if (!process.env.ARCADS_CLIENT_ID) return res.json({ connected: false });
    const productId = process.env.ARCADS_PRODUCT_ID;
    const { data } = await arcadsClient().get(`/v1/products/${productId}/folders`);
    const scripts = data.items.flatMap(f =>
      (f.scripts || []).map(s => ({ ...s, folderName: f.name, folderId: f.id }))
    );
    res.json({ connected: true, scripts, folders: data.items.map(f => ({ id: f.id, name: f.name })) });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// POST /api/arcads/scripts — create a new script with actor assignments
app.post('/api/arcads/scripts', async (req, res) => {
  try {
    const { name, text, situationIds, folderId } = req.body;
    if (!name || !text || !situationIds?.length) return res.status(400).json({ error: 'name, text, and situationIds are required' });
    const videos = situationIds.map(id => ({ situationId: id }));
    const { data } = await arcadsClient().post('/v1/scripts', {
      folderId: folderId || process.env.ARCADS_FOLDER_ID,
      name, text, videos,
    });
    res.json({ ok: true, script: data });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// POST /api/arcads/scripts/:id/generate — kick off video generation
app.post('/api/arcads/scripts/:id/generate', async (req, res) => {
  try {
    const { data } = await arcadsClient().post(`/v1/scripts/${req.params.id}/generate`);
    res.json({ ok: true, result: data });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /api/arcads/scripts/:id/videos — poll for generation status + download URLs
app.get('/api/arcads/scripts/:id/videos', async (req, res) => {
  try {
    const { data } = await arcadsClient().get(`/v1/scripts/${req.params.id}/videos`);
    res.json(Array.isArray(data) ? data : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Returns platform-specific metadata required by Buffer for YouTube, Instagram, Facebook.
// Other platforms (TikTok, Twitter/X, LinkedIn) don't need extra fields.
// Sanitise text per platform constraints before sending to Buffer
function sanitiseTextForPlatform(service, text) {
  const svc = (service || '').toLowerCase();
  const t   = (text || '').trim();

  // Twitter/X: hard 280-char limit. Truncate caption only (preserve hashtags if they fit,
  // otherwise drop them — a working post is better than a failed one).
  if (svc === 'twitter' || svc === 'x') {
    if (t.length <= 280) return t;
    // Try to keep up to the last sentence/word boundary within 277 chars + "…"
    const truncated = t.slice(0, 277).replace(/\s+\S*$/, '');
    return truncated + '…';
  }

  return t;
}

function bufferPlatformMetadata(service, text) {
  const svc = (service || '').toLowerCase();
  if (svc === 'youtube') {
    // Strip characters YouTube rejects in titles: < > and other problematic chars
    const raw   = (text || 'Video').replace(/\n[\s\S]*/, '').trim();
    const title = raw.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Video';
    return { youtube: { title, categoryId: '22', privacy: 'public' } };
  }
  if (svc === 'instagram') return { instagram: { type: 'reel', shouldShareToFeed: true } };
  if (svc === 'facebook')  return { facebook:  { type: 'reel' } };
  return null;
}

// Shared helper — build a Buffer CreatePostInput using the current API schema
function buildBufferInput(channelId, service, text, mediaUrl, scheduledAt) {
  const rawMedia     = mediaUrl && mediaUrl.startsWith('/') ? `${PUBLIC_BASE_URL}${mediaUrl}` : mediaUrl;
  const isImage      = rawMedia && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(rawMedia);
  const safeText     = sanitiseTextForPlatform(service, text);
  const platformMeta = bufferPlatformMetadata(service, safeText);
  return {
    channelId,
    schedulingType: 'automatic',
    mode: scheduledAt ? 'customScheduled' : 'addToQueue',
    text: safeText,
    assets: rawMedia ? [isImage ? { image: { url: rawMedia } } : { video: { url: rawMedia } }] : [],
    ...(scheduledAt ? { dueAt: scheduledAt } : {}),
    ...(platformMeta ? { metadata: platformMeta } : {}),
  };
}

const BUFFER_GQL_MUTATION = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id dueAt status channelService } }
    ... on NotFoundError     { message }
    ... on UnauthorizedError { message }
    ... on InvalidInputError { message }
    ... on LimitReachedError { message }
    ... on UnexpectedError   { message }
  }
}`;

// POST /api/buffer/post — post a single video/text to Buffer
// Body: { channelId, service?, text, mediaUrl?, scheduledAt? }
app.post('/api/buffer/post', async (req, res) => {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.json({ ok: false, error: 'No Buffer token' });
  try {
    const { channelId, service, text, mediaUrl, scheduledAt } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    const input = buildBufferInput(channelId, service, text, mediaUrl, scheduledAt);
    const { data: gql } = await axios.post(
      'https://api.buffer.com/graphql',
      { query: BUFFER_GQL_MUTATION, variables: { input } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (gql.errors) return res.json({ ok: false, error: gql.errors[0]?.message });
    const result = gql.data?.createPost;
    if (result?.message) return res.json({ ok: false, error: result.message });
    res.json({ ok: true, post: result?.post });
  } catch (e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
});

// POST /api/buffer/post-to-channels — post to multiple Buffer channels at once
// Body: { channels: [{id, service}], text, mediaUrl?, scheduledAt? }
// Also accepts legacy { channelIds: string[] } for backwards compat
app.post('/api/buffer/post-to-channels', async (req, res) => {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.status(400).json({ ok: false, error: 'BUFFER_ACCESS_TOKEN not configured' });

  const { channels, channelIds, text, mediaUrl, scheduledAt } = req.body;

  // Normalise to [{id, service}] — accept either new `channels` or legacy `channelIds`
  const channelList = channels?.length
    ? channels
    : (channelIds || []).map(id => ({ id, service: null }));

  if (!channelList.length) return res.status(400).json({ error: 'channels array is required' });

  const BUFFER_GQL = 'https://api.buffer.com/graphql';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const results = [];
  for (const ch of channelList) {
    const channelId = ch.id || ch;
    const service   = ch.service || null;
    try {
      const input = buildBufferInput(channelId, service, text, mediaUrl, scheduledAt);
      const { data: gql } = await axios.post(
        BUFFER_GQL,
        { query: BUFFER_GQL_MUTATION, variables: { input } },
        { headers }
      );
      if (gql.errors) {
        results.push({ channelId, ok: false, error: gql.errors[0]?.message });
      } else {
        const result = gql.data?.createPost;
        if (result?.message) {
          results.push({ channelId, ok: false, error: result.message });
        } else {
          results.push({ channelId, ok: true, post: result?.post });
        }
      }
    } catch (e) {
      results.push({ channelId, ok: false, error: e.response?.data || e.message });
    }
  }

  const allOk = results.every(r => r.ok);

  // NOTE: Do NOT delete the file here. Buffer only stores the URL when a post is created —
  // it fetches the actual video at publish time (which for scheduled/queued posts can be
  // hours later). Deleting immediately caused 404s at publish time and broken posts.
  // Files are cleaned up by the scheduled purge below (files older than 7 days).
  if (allOk && mediaUrl) {
    const rawMedia = mediaUrl.startsWith('/') ? mediaUrl : mediaUrl.replace(PUBLIC_BASE_URL, '');
    const match = rawMedia.match(/^\/uploads\/(.+)$/);
    if (match) {
      // Mark as done in queue only — do not delete the file
      try {
        const q = loadQueue().map(v => v.filename === match[1] ? { ...v, status: 'done' } : v);
        saveQueue(q);
      } catch(_) {}
    }
  }

  res.json({ ok: allOk, results });
});

// Scheduled cleanup: delete video files from UPLOAD_DIR that are older than 7 days.
// Runs once at startup and then every 24 hours. Skips .html and .json files so
// proposals and data files are never touched.
function purgeOldUploadedVideos() {
  try {
    const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(UPLOAD_DIR);
    let deleted = 0;
    for (const f of files) {
      if (/\.(html|json)$/i.test(f)) continue;
      const full = path.join(UPLOAD_DIR, f);
      try {
        const { mtimeMs } = fs.statSync(full);
        if (mtimeMs < cutoff) { fs.unlinkSync(full); deleted++; }
      } catch(_) {}
    }
    if (deleted > 0) console.log(`[upload-purge] Deleted ${deleted} video file(s) older than 45 days`);
  } catch (e) { console.error('[upload-purge] Error:', e.message); }
}
purgeOldUploadedVideos();
setInterval(purgeOldUploadedVideos, 24 * 60 * 60 * 1000);

// GET /api/buffer/channels — list Buffer channels for posting UI
app.get('/api/buffer/channels', async (req, res) => {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.json({ channels: [] });
  try {
    const data = await cached('buffer_channels', 3_600_000, async () => {
      const orgId = process.env.BUFFER_ORG_ID || '69d6ddee1fcceb5bb1faa168';
      const { data: gql } = await axios.post(
        'https://api.buffer.com/graphql',
        {
          query: `{
            channels(input:{organizationId:"${orgId}"}) {
              id name service serviceId avatar
            }
          }`,
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      return gql.data?.channels || [];
    });
    res.json({ channels: data });
  } catch (e) { res.json({ channels: [], error: e.message }); }
});

// ─── Reacher / TikTok Affiliate Manager ───────────────────────��───────────────
// All Reacher calls proxy through Railway (which holds REACHER_API_KEY).

// GET /api/reacher/stats?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
app.get('/api/reacher/stats', async (req, res) => {
  const { start_date, end_date } = req.query;
  const cacheKey = `reacher_stats:${start_date||''}:${end_date||''}`;
  try {
    const data = await cached(cacheKey, 5 * 60_000, async () => {
      const params = {};
      if (start_date) params.start_date = start_date;
      if (end_date)   params.end_date   = end_date;
      const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/stats`, { params, timeout: 30_000 });
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reacher/timeseries  { start_date, end_date, granularity? }
app.post('/api/reacher/timeseries', async (req, res) => {
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/affiliate/agency/timeseries`,
      req.body, { timeout: 30_000 }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reacher/shops/:shopId/funnel', async (req, res) => {
  const { shopId } = req.params;
  try {
    const data = await cached(`reacher_funnel_${shopId}`, 5 * 60_000, async () => {
      const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shopId}/funnel`, { timeout: 15_000 });
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reacher/shops/:shopId/creators', async (req, res) => {
  const { shopId } = req.params;
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/affiliate/shops/${shopId}/creators`,
      req.body, { timeout: 15_000 }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reacher/shops — list all shops
app.get('/api/reacher/shops', async (req, res) => {
  try {
    const data = await cached('reacher_shops', 5 * 60_000, async () => {
      const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops`, { timeout: 15_000 });
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reacher/shops/:shopId/automations
app.get('/api/reacher/shops/:shopId/automations', async (req, res) => {
  const { shopId } = req.params;
  try {
    const data = await cached(`reacher_automations_${shopId}`, 5 * 60_000, async () => {
      const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shopId}/automations`, { timeout: 15_000 });
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reacher/shops/:shopId/creators/top
app.get('/api/reacher/shops/:shopId/creators/top', async (req, res) => {
  const { shopId } = req.params;
  try {
    const data = await cached(`reacher_top_creators_${shopId}`, 5 * 60_000, async () => {
      const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shopId}/creators/top`, { timeout: 15_000 });
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reacher/shops/:shopId/videos
app.post('/api/reacher/shops/:shopId/videos', async (req, res) => {
  const { shopId } = req.params;
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/affiliate/shops/${shopId}/videos`,
      req.body, { timeout: 15_000 }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reacher/shops/:shopId/samples
app.post('/api/reacher/shops/:shopId/samples', async (req, res) => {
  const { shopId } = req.params;
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/affiliate/shops/${shopId}/samples`,
      req.body, { timeout: 15_000 }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Creator Database endpoints ─────────────��─────────────────────────────────

// ─── TikTok Shop API — Creator database (replaces Reacher) ───────────────────
// POST /api/creators/tts-all — aggregate affiliated creators across all connected brands
// Returns same shape as /api/creators/all so the UI needs minimal changes.
app.post('/api/creators/tts-all', async (req, res) => {
  const { sort = 'total_shop_gmv', search = '', min_followers = 0, shop = 'all', page = 1, page_size = 50 } = req.body;
  try {
    // Cache the raw aggregated fetch (expensive) — filters/sort/pagination applied outside
    const { allCreators, shopList } = await cached('tts_creators_raw', 15 * 60_000, async () => {
      const brands  = loadBrands();
      // Build a list of {token, shopName} for every available token source
      // Priority: per-brand tokens first, then global token as a catch-all
      const sources = [];
      for (const [bi, brand] of (brands.clients || []).entries()) {
        if (brand.tiktokShopToken?.access_token) {
          sources.push({ token: brand.tiktokShopToken, shopName: brand.name, brands, bi });
        }
      }
      // Fall back to global token (covers the shop connected via the main TikTok Shop auth)
      if (sources.length === 0) {
        const globalTok = loadTikTokTokens().shop;
        if (globalTok?.access_token) {
          sources.push({ token: globalTok, shopName: globalTok.shop_name || 'Connected Shop', brands, bi: -1 });
        }
      }

      const byHandle = {};

      async function fetchCreatorsForSource(src) {
        let pageToken = '';
        let safeguard = 0;
        while (safeguard++ < 20) {
          const body = { page_size: 100, sort_field: 'gmv', sort_order: 'DESC' };
          if (pageToken) body.page_token = pageToken;
          let resp;
          try {
            if (src.bi >= 0) {
              resp = await ttsBrandPost(src.brands.clients[src.bi], src.brands, src.bi, '/affiliate/seller/202309/creators/search', body);
            } else {
              // Global token path
              if (src.token.expires_at && Date.now() > src.token.expires_at - 120_000) {
                await refreshShopToken();
              }
              resp = await ttsPost('/affiliate/seller/202309/creators/search', body);
            }
          } catch (e) {
            console.error(`[tts-creators] ${src.shopName}:`, e.message);
            break;
          }
          const list = resp?.data?.creators || [];
          for (const c of list) {
            const handle = (c.creator_handle || c.username || '').toLowerCase().replace(/^@/, '');
            if (!handle) continue;
            if (!byHandle[handle]) {
              byHandle[handle] = { creator_handle: handle, follower_count: 0, total_shop_gmv: 0, overall_gmv: 0, shops: [] };
            }
            byHandle[handle].total_shop_gmv += parseFloat(c.sale_amount ?? c.gmv ?? 0);
            byHandle[handle].follower_count  = Math.max(byHandle[handle].follower_count, c.follower_count || 0);
            if (!byHandle[handle].shops.includes(src.shopName)) byHandle[handle].shops.push(src.shopName);
          }
          const next = resp?.data?.next_page_token;
          if (!next || list.length === 0) break;
          pageToken = next;
        }
      }

      await Promise.allSettled(sources.map(fetchCreatorsForSource));

      return {
        allCreators: Object.values(byHandle),
        shopList:    sources.map(s => ({ name: s.shopName })),
      };
    });

    // Apply filters, sort, and pagination in-memory (fast)
    let creators = allCreators;
    if (shop && shop !== 'all') creators = creators.filter(c => c.shops.includes(shop));
    if (search)                  creators = creators.filter(c => c.creator_handle.includes(search.toLowerCase()));
    if (Number(min_followers) > 0) creators = creators.filter(c => c.follower_count >= Number(min_followers));
    creators.sort((a, b) => sort === 'follower_count' ? b.follower_count - a.follower_count : b.total_shop_gmv - a.total_shop_gmv);

    const total      = creators.length;
    const totalPages = Math.ceil(total / page_size) || 1;
    const startIdx   = (page - 1) * page_size;

    res.json({
      data:       creators.slice(startIdx, startIdx + page_size),
      pagination: { total_count: total, page, total_pages: totalPages },
      shops:      shopList,
      source:     'tiktok_shop_api',
    });
  } catch (e) {
    console.error('[tts-creators]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/creators/tts-performance — 30-day GMV per creator aggregated across all brands
// Pulls affiliate orders with a 30-day date window for each connected brand.
app.post('/api/creators/tts-performance', async (req, res) => {
  const cacheKey = 'tts_creators_perf:30d';
  try {
    const data = await cached(cacheKey, 15 * 60_000, async () => {
      const now    = Math.floor(Date.now() / 1000);
      const start  = now - 30 * 24 * 60 * 60;
      const brands  = loadBrands();
      const perfByHandle = {};

      // Build token sources (per-brand first, global fallback)
      const perfSources = [];
      for (const [bi, brand] of (brands.clients || []).entries()) {
        if (brand.tiktokShopToken?.access_token) perfSources.push({ brand, brands, bi, global: false });
      }
      if (perfSources.length === 0) {
        const globalTok = loadTikTokTokens().shop;
        if (globalTok?.access_token) perfSources.push({ brand: null, brands, bi: -1, global: true });
      }

      await Promise.allSettled(perfSources.map(async (src) => {
        let pageToken = '';
        let safeguard = 0;
        while (safeguard++ < 20) {
          const body = { create_time_ge: start, create_time_lt: now, page_size: 100 };
          if (pageToken) body.page_token = pageToken;
          let resp;
          try {
            if (!src.global) {
              resp = await ttsBrandPost(src.brand, src.brands, src.bi, '/affiliate/seller/202309/orders/search', body);
            } else {
              if ((loadTikTokTokens().shop?.expires_at || 0) < Date.now() - 120_000) await refreshShopToken();
              resp = await ttsPost('/affiliate/seller/202309/orders/search', body);
            }
          } catch (e) {
            console.error(`[tts-perf] ${src.brand?.name || 'global'}:`, e.message);
            break;
          }
          const orders = resp?.data?.affiliate_orders || resp?.data?.orders || [];
          for (const o of orders) {
            const handle = (o.creator_handle || o.creator_username || o.creator_open_id || '').toLowerCase().replace(/^@/, '');
            if (!handle) continue;
            const amt = parseFloat(o.sale_amount ?? o.payment_info?.original_total_product_price ?? o.total_amount ?? 0);
            if (!perfByHandle[handle]) perfByHandle[handle] = { creator_handle: handle, gmv: 0, order_count: 0, units_sold: 0 };
            perfByHandle[handle].gmv        += amt;
            perfByHandle[handle].order_count += 1;
          }
          const next = resp?.data?.next_page_token;
          if (!next || orders.length === 0) break;
          pageToken = next;
        }
      }));

      const perf = Object.values(perfByHandle).sort((a, b) => b.gmv - a.gmv);
      return { data: perf, source: 'tiktok_shop_api' };
    });
    res.json(data);
  } catch (e) {
    console.error('[tts-perf]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/creators/all — aggregate creators across all shops (15-min cache, key by filters)
app.post('/api/creators/all', async (req, res) => {
  const { shop = 'all', search = '', sort = 'total_shop_gmv', min_followers = 0, min_gmv = 0, page = 1, page_size = 50 } = req.body;
  const cacheKey = `creators_all:${shop}:${search}:${sort}:${min_followers}:${min_gmv}:${page}:${page_size}`;
  try {
    const data = await cached(cacheKey, 15 * 60_000, async () => {
      const { data } = await axios.post(
        `${CFG.railwayUrl}/affiliate/creators/all`,
        req.body, { timeout: 60_000 }
      );
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/creators/performance — 30-day top performers across all shops (15-min cache)
app.post('/api/creators/performance', async (req, res) => {
  const { start_date = '', end_date = '', page = 1, page_size = 50 } = req.body;
  const cacheKey = `creators_perf:${start_date}:${end_date}:${page}:${page_size}`;
  try {
    const data = await cached(cacheKey, 15 * 60_000, async () => {
      const { data } = await axios.post(
        `${CFG.railwayUrl}/affiliate/creators/performance/all`,
        req.body, { timeout: 60_000 }
      );
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/creators/ghl-map — TikTok handle → GHL contact info (10-min cache)
// Fetches all contacts tagged "affiliate" (GHL tag filter, not text search).
// Maps handle → {id, name, phone, email, tags, discordUsername}
// In-memory GHL map cache — populated on first request, refreshed every 30 min.
// A single promise lock prevents concurrent builds (e.g. if the user reloads
// mid-fetch, subsequent requests wait for the in-flight build rather than
// starting another 200-call loop).
let _ghlMapCache    = null;
let _ghlMapCacheAt  = 0;
let _ghlMapBuilding = null; // promise while build in progress
const GHL_MAP_TTL   = 30 * 60_000;

// Shared helper — starts the build if not running, returns a promise that resolves to the cache
function _ensureGhlMap() {
  if (_ghlMapCache && (Date.now() - _ghlMapCacheAt) < GHL_MAP_TTL) return Promise.resolve(_ghlMapCache);
  if (!_ghlMapBuilding) {
    _ghlMapBuilding = (async () => {
      // Known TikTok-related custom field IDs for this GHL location.
      // tiktok_handle  → trnSmiM9oilkdQSInRPn  (primary — set by creator forms)
      // tiktok_username→ e6rnLj4npciYrjOd4OwC  (fallback)
      // tiktok_profile_link → fWDq18dESQmKaiNwgJWU (fallback, may be full URL)
      // tiktok_url     → 39UVa4ENm3OeOiafUU1c  (old fallback)
      const TIKTOK_HANDLE_FIELDS = new Set([
        'trnSmiM9oilkdQSInRPn',
        'e6rnLj4npciYrjOd4OwC',
        'fWDq18dESQmKaiNwgJWU',
        '39UVa4ENm3OeOiafUU1c',
      ]);
      const allContacts = [];
      let startAfter = null;
      let startAfterId = null;
      while (true) {
        const params = { locationId: CFG.locationId, limit: 100 };
        if (startAfter)   params.startAfter   = startAfter;
        if (startAfterId) params.startAfterId = startAfterId;
        const { data: tr } = await ghl.get('/contacts/', { params });
        const batch = tr?.contacts || [];
        allContacts.push(...batch);
        if (batch.length < 100) break;
        const meta = tr?.meta || {};
        startAfter   = meta.startAfter   || null;
        startAfterId = meta.startAfterId || null;
        if (!startAfterId) break;
      }

      // Build handle → contact map AND affiliateList in one pass
      const map = {};
      const affiliateList = [];
      for (const c of allContacts) {
        // Determine TikTok handle — try multiple sources in priority order:
        // 1. Custom field matching the tiktok_handle field ID
        // 2. Any custom field value that looks like a TikTok URL or @handle (safety net)
        // 3. contactName if it looks like a handle (no spaces, word chars only)
        // 4. firstName if handle-like and no lastName (Reacher imports)
        let handle = '';
        const isHandleLike = s => /^[\w.]{3,30}$/.test(s);
        const customFields = c.customFields || [];

        // Priority 1: known TikTok fields by UUID (handle, username, profile link, url)
        for (const f of customFields) {
          if (!TIKTOK_HANDLE_FIELDS.has(f.id)) continue;
          const v = typeof f.value === 'string' ? f.value.trim() : '';
          if (!v) continue;
          const m = v.match(/tiktok\.com\/@?([\w.]{3,30})/i) || v.match(/^@?([\w.]{3,30})$/);
          if (m) { handle = m[1].toLowerCase(); break; }
        }

        // Priority 2: scan all custom field values for anything TikTok-shaped
        if (!handle) {
          for (const f of customFields) {
            const v = (typeof f.value === 'string' ? f.value : String(f.value || '')).trim();
            if (!v || v === 'null' || v === 'undefined') continue;
            const urlM = v.match(/tiktok\.com\/@?([\w.]{3,30})/i);
            if (urlM) { handle = urlM[1].toLowerCase(); break; }
            const atM = v.match(/^@([\w.]{3,30})$/);
            if (atM) { handle = atM[1].toLowerCase(); break; }
          }
        }

        // Priority 3: contactName if it looks like a TikTok handle
        if (!handle && c.contactName) {
          const candidate = c.contactName.replace(/^@/, '').trim();
          if (isHandleLike(candidate)) handle = candidate.toLowerCase();
        }

        // Priority 4: firstName with no lastName (Reacher imports store handle as firstName)
        if (!handle && c.firstName && !c.lastName) {
          const candidate = c.firstName.replace(/^@/, '').trim();
          if (isHandleLike(candidate)) handle = candidate.toLowerCase();
        }

        // Extract discord username from discord: tags
        let discordUsername = '';
        for (const t of (c.tags || [])) {
          const dm = t.match(/^discord:(.+)/i);
          if (dm) { discordUsername = dm[1].trim().replace(/^@/, ''); break; }
        }

        // Build a real name — only use it if it looks like an actual person's name,
        // not a TikTok handle. Reacher imports often set firstName = the handle, so we
        // require: has a last name, OR firstName contains a space, OR firstName ≠ handle.
        // Title-case to fix contacts imported in all-lowercase.
        const toTitleCase = s => s.replace(/\b\w/g, ch => ch.toUpperCase());
        const firstName = toTitleCase((c.firstName || '').trim());
        const lastName  = toTitleCase((c.lastName  || '').trim());
        const rawFull   = `${firstName} ${lastName}`.trim();
        const looksLikeName = lastName
          || firstName.includes(' ')
          || (firstName && firstName.toLowerCase() !== handle && !/^[\w.]+$/.test(firstName));
        const fullName = looksLikeName ? rawFull : '';

        // Add to handle map (only contacts with a resolved handle)
        if (handle) {
          map[handle] = {
            id:              c.id,
            name:            fullName,
            phone:           c.phone || '',
            email:           c.email || '',
            tags:            c.tags  || [],
            discordUsername: discordUsername,
          };
        }

        // Add to affiliateList if tagged "affiliate" (case-insensitive)
        const isAffiliate = (c.tags || []).some(t => t.toLowerCase() === 'affiliate');
        const hasContactInfo = !!(c.phone || c.email);
        if (isAffiliate && hasContactInfo) {
          affiliateList.push({
            ghl_id:          c.id,
            handle:          handle || '',
            name:            fullName,
            phone:           c.phone || '',
            email:           c.email || '',
            tags:            c.tags  || [],
            discordUsername: discordUsername,
          });
        }
      }
      const result = { map, affiliateList, _debug: { total_fetched: allContacts.length, mapped: Object.keys(map).length, affiliates: affiliateList.length, with_phone: Object.values(map).filter(v => v.phone).length } };
      _ghlMapCache   = result;
      _ghlMapCacheAt = Date.now();
      return result;
    })().finally(() => { _ghlMapBuilding = null; });
  }
  return _ghlMapBuilding;
}

app.get('/api/creators/ghl-map', async (req, res) => {
  try {
    const data = await _ensureGhlMap();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/creators/affiliate-list — returns all GHL affiliate contacts from cache
// Triggers the GHL map build if not already running (same as /api/creators/ghl-map)
app.get('/api/creators/affiliate-list', async (req, res) => {
  try {
    const cache = await _ensureGhlMap();
    const list  = cache.affiliateList || [];
    res.json({ data: list, total: list.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/creators/reacher-enrichment — all Reacher creators as handle→data map (30-min cache)
let _reacherEnrichCache   = null;
let _reacherEnrichCacheAt = 0;
const REACHER_ENRICH_TTL  = 30 * 60_000;

app.get('/api/creators/reacher-enrichment', async (req, res) => {
  try {
    if (_reacherEnrichCache && (Date.now() - _reacherEnrichCacheAt) < REACHER_ENRICH_TTL) {
      return res.json(_reacherEnrichCache);
    }
    const r = await axios.post(
      `${CFG.railwayUrl}/affiliate/creators/all`,
      { shop: 'all', page: 1, page_size: 5000 },
      { timeout: 120_000 }
    );
    const creators = r.data?.data || r.data || [];
    const map = {};
    const shopSet = new Map();
    for (const c of creators) {
      const h = (c.creator_handle || '').replace(/^@/, '').toLowerCase();
      if (!h) continue;
      map[h] = {
        follower_count:  c.follower_count  || 0,
        overall_gmv:     c.overall_gmv     || 0,
        total_shop_gmv:  c.total_shop_gmv  || 0,
        total_videos:    c.total_videos    || 0,
        total_views:     c.total_views     || 0,
        shops:           c.shops           || [],
      };
      for (const s of (c.shops || [])) {
        if (s.shop_name && !shopSet.has(s.shop_name)) shopSet.set(s.shop_name, s);
      }
    }
    const shops = [...shopSet.values()];
    const result = { map, shops };
    _reacherEnrichCache   = result;
    _reacherEnrichCacheAt = Date.now();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/creators/ghl-debug — inspect GHL contact structure
app.get('/api/creators/ghl-debug', async (req, res) => {
  try {
    const { data: tr } = await ghl.get('/contacts/', { params: { locationId: CFG.locationId, limit: 100 } });
    const contacts = tr?.contacts || [];
    const first = contacts[0] || {};
    res.json({
      total_in_page:   contacts.length,
      meta:            tr?.meta || {},
      // Show all top-level keys on a contact so we know the field names
      first_contact_keys: Object.keys(first),
      first_contact: {
        id:           first.id,
        contactName:  first.contactName,
        firstName:    first.firstName,
        lastName:     first.lastName,
        phone:        first.phone,
        email:        first.email,
        tags:         first.tags,
        customFields: first.customFields,
      },
      // Also search for a contact that has any phone-like field
      contacts_with_phone: contacts.filter(c => c.phone || c.phoneNumber || c.mobilePhone).length,
    });
  } catch (e) { res.status(500).json({ error: e.message, response: e.response?.data }); }
});

// GET /api/discord/creator-members — list all Discord server members with the Creator role
// Returns { members: [{username, globalName, userId}] } — used to show Discord status in the creator DB.
// Results are cached for 5 minutes.
app.get('/api/discord/creator-members', async (req, res) => {
  try {
    const data = await cached('discord_creator_members', 5 * 60_000, async () => {
      const botToken = process.env.DISCORD_BOT_TOKEN;
      const guildId  = process.env.DISCORD_GUILD_ID;
      const roleId   = process.env.DISCORD_CREATOR_ROLE_ID;
      if (!botToken || !guildId) throw new Error('Discord bot credentials not configured');

      // Paginate through all guild members (Discord returns up to 1000 per page)
      const members = [];
      let after = '0';
      while (true) {
        const { data: batch } = await axios.get(
          `https://discord.com/api/v10/guilds/${guildId}/members`,
          { params: { limit: 1000, after }, headers: { Authorization: `Bot ${botToken}` } }
        );
        if (!batch || batch.length === 0) break;
        for (const m of batch) {
          // If we have a Creator role filter, only include role members; otherwise include all
          const hasRole = roleId ? (m.roles || []).includes(roleId) : true;
          if (hasRole) {
            members.push({
              userId:     m.user.id,
              username:   (m.user.username   || '').toLowerCase(),
              globalName: (m.user.global_name || m.nick || '').toLowerCase(),
            });
          }
        }
        if (batch.length < 1000) break;
        after = batch[batch.length - 1].user.id;
      }
      return { members };
    });
    res.json(data);
  } catch (e) {
    console.error('[discord/creator-members]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/creators/sms — bulk SMS to GHL contacts
// Body: { contacts: [{id, name, phone}], message: string }
app.post('/api/creators/sms', async (req, res) => {
  const { contacts, message } = req.body;
  if (!contacts?.length || !message?.trim()) {
    return res.status(400).json({ error: 'contacts array and message are required' });
  }
  const results = [];
  for (const c of contacts) {
    try {
      await ghl.post('/conversations/messages', {
        type:      'SMS',
        contactId: c.id,
        message:   message.trim(),
      });
      results.push({ id: c.id, name: c.name, ok: true });
    } catch (e) {
      results.push({ id: c.id, name: c.name, ok: false,
        error: e.response?.data?.message || e.response?.data?.msg || e.message });
    }
  }
  res.json({ ok: results.every(r => r.ok), results });
});

// POST /api/command  { text, context?, source? }
// Fires message to Lark alerts channel via Railway.
app.post('/api/command', async (req, res) => {
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/command`,
      { ...req.body, source: 'Command Center' },
      { timeout: 10_000 }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─���─ Skool community stats (scrape public about page) ─────────────────────────
app.get('/api/skool/stats', async (req, res) => {
  try {
    const data = await cached('skool_stats', 10 * 60_000, async () => {
      const { data: html } = await axios.get('https://www.skool.com/cult-content/about', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        timeout: 10_000,
      });
      const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!match) throw new Error('Could not find page data');
      const pageData = JSON.parse(match[1]);
      const meta = pageData?.props?.pageProps?.currentGroup?.metadata || {};
      const price = (() => {
        try { const p = JSON.parse(meta.displayPrice || '{}'); return p.amount ? p.amount / 100 : null; } catch { return null; }
      })();
      return {
        connected:    true,
        name:         meta.displayName || 'Cult Content',
        slug:         'cult-content',
        description:  meta.description || '',
        members:      meta.totalMembers || 0,
        online:       meta.totalOnlineMembers || 0,
        admins:       meta.totalAdmins || 0,
        courses:      meta.numCourses || 0,
        modules:      meta.numModules || 0,
        posts:        meta.totalPosts || 0,
        price,
        currency:     'usd',
        logoUrl:      meta.logoUrl || '',
        fetched_at:   new Date().toISOString(),
      };
    });
    res.json(data);
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// ─── Skool recent joins (stored from Railway webhook receiver) ─────────────────
app.get('/api/skool/events', async (req, res) => {
  try {
    const { data } = await axios.get(`${CFG.railwayUrl}/skool-events`, { timeout: 5_000 });
    res.json(data);
  } catch (e) {
    res.json({ events: [], error: e.message });
  }
});

// ─── Reacher Creator Messages — proxied through Railway (holds REACHER_API_KEY)
// GET /api/reacher/conversations?shop_id=&unread_only=&unreplied_only=&limit=&offset=
app.get('/api/reacher/conversations', async (req, res) => {
  try {
    const { shop_id, unread_only, unreplied_only, limit = 50, offset = 0 } = req.query;
    if (!shop_id) return res.json({ data: [], total_count: 0, has_more: false });
    const params = new URLSearchParams({ limit, offset });
    if (unread_only    === 'true') params.set('unread_only',    'true');
    if (unreplied_only === 'true') params.set('unreplied_only', 'true');
    const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shop_id}/conversations?${params}`, { timeout: 15000 });
    res.json(data);
  } catch(e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
});

// GET /api/reacher/conversations/:handle/messages?shop_id=&page=1
app.get('/api/reacher/conversations/:handle/messages', async (req, res) => {
  try {
    const { shop_id, page = 1 } = req.query;
    const handle = req.params.handle;
    if (!shop_id) return res.status(400).json({ ok: false, error: 'shop_id required' });
    const { data } = await axios.get(
      `${CFG.railwayUrl}/affiliate/shops/${shop_id}/conversations/${encodeURIComponent(handle)}/messages?page=${page}`,
      { timeout: 15000 }
    );
    res.json(data);
  } catch(e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
});

// POST /api/reacher/conversations/:handle/reply  { message, shop_id }
app.post('/api/reacher/conversations/:handle/reply', express.json(), async (req, res) => {
  try {
    const handle  = req.params.handle;
    const { message, shop_id } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ ok: false, error: 'message required' });
    if (!shop_id)         return res.status(400).json({ ok: false, error: 'shop_id required' });
    const { data } = await axios.post(
      `${CFG.railwayUrl}/affiliate/shops/${shop_id}/conversations/${encodeURIComponent(handle)}/reply`,
      { message: message.trim() },
      { timeout: 15000 }
    );
    res.json({ ok: true, ...data });
  } catch(e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
});

// ─── SMS Follow-up proxy (feeds /sms-communication approval feed) ─────────────
app.get('/api/sms-communication/followup/lists', requirePortalAdmin, async (req, res) => {
  const SIS_BASE = process.env.SISYPHUS_URL || 'https://sisyphus.cultcontent.cc';
  try {
    const { data } = await axios.get(`${SIS_BASE}/api/sms-followup/lists`, {
      timeout: 15000,
      headers: { 'x-internal-secret': process.env.IC_ADMIN_KEY || '' },
    });
    res.json(data);
  } catch (e) {
    res.json({ ready:{creators:[]}, needsEnrichment:{creators:[]}, counts:{ready:0,needsEnrichment:0}, _proxyError: e.response?.data || e.message });
  }
});

// ─── Stubs (OAuth integrations — connect later) ────────────────────────────────
app.get('/api/gmail/stats',  (_, res) => res.json({ connected: false }));
app.get('/api/gcal/events',  (_, res) => res.json({ connected: false }));
app.get('/api/lark/data',    (_, res) => res.json({ connected: false }));

// ─── Agent Manager ────────────────────────────────────────────────────────────
function loadAgents() {
  try { if (fs.existsSync(AGENTS_FILE)) return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); }
  catch (e) { console.error('agents load:', e.message); }
  return { agents: [] };
}
function saveAgents(data) {
  try { fs.writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('agents save:', e.message); }
}

async function runAgent(agent) {
  const now = new Date().toISOString();
  const data = loadAgents();
  const idx  = data.agents.findIndex(a => a.id === agent.id);
  try {
    let result;
    if (agent.type === 'webhook') {
      const method  = (agent.action?.method || 'POST').toLowerCase();
      let payload = {};
      try { if (agent.action?.payload) payload = JSON.parse(agent.action.payload); } catch {}
      const resp = await (method === 'get'
        ? axios.get(agent.action.webhookUrl,  { params: payload, timeout: 15_000 })
        : axios.post(agent.action.webhookUrl, payload, { timeout: 15_000 }));
      result = { status: resp.status, data: resp.data };
    } else if (agent.type === 'command') {
      const resp = await axios.post(`${CFG.railwayUrl}/command`, {
        text:    agent.action?.commandText || agent.name,
        context: agent.name,
        source:  'Agent Manager',
      }, { timeout: 10_000 });
      result = resp.data;
    } else {
      result = { note: 'GHL workflow agents are managed via GHL directly.' };
    }
    if (idx >= 0) {
      data.agents[idx] = { ...data.agents[idx], lastRunAt: now, lastRunStatus: 'ok',
        lastRunResult: JSON.stringify(result).slice(0, 500), runCount: (data.agents[idx].runCount || 0) + 1 };
      saveAgents(data);
    }
    return { ok: true, result };
  } catch (e) {
    if (idx >= 0) {
      data.agents[idx] = { ...data.agents[idx], lastRunAt: now, lastRunStatus: 'error', lastRunResult: e.message };
      saveAgents(data);
    }
    return { ok: false, error: e.message };
  }
}

app.get('/api/agents', (req, res) => res.json(loadAgents()));

app.post('/api/agents', (req, res) => {
  const { name, description, type, enabled, scheduleIntervalMs, action, tags } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  const data = loadAgents();
  const agent = {
    id: crypto.randomUUID(), name, description: description || '', type,
    enabled: enabled !== false, scheduleIntervalMs: Number(scheduleIntervalMs) || 0,
    action: action || {}, tags: tags || [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastRunAt: null, lastRunStatus: null, lastRunResult: null, runCount: 0,
  };
  data.agents.unshift(agent);
  saveAgents(data);
  res.json({ ok: true, agent });
});

app.put('/api/agents/:id', (req, res) => {
  const data = loadAgents();
  const idx  = data.agents.findIndex(a => a.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Agent not found' });
  data.agents[idx] = { ...data.agents[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  saveAgents(data);
  res.json({ ok: true, agent: data.agents[idx] });
});

app.delete('/api/agents/:id', (req, res) => {
  const data   = loadAgents();
  const before = data.agents.length;
  data.agents  = data.agents.filter(a => a.id !== req.params.id);
  if (data.agents.length === before) return res.status(404).json({ error: 'Agent not found' });
  saveAgents(data);
  res.json({ ok: true });
});

app.post('/api/agents/:id/run', async (req, res) => {
  const agent = loadAgents().agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(await runAgent(agent));
});

// Scheduled agent runner — checks every 60 s
setInterval(() => {
  const { agents } = loadAgents();
  const now = Date.now();
  for (const agent of agents) {
    if (!agent.enabled || !agent.scheduleIntervalMs) continue;
    const lastRun = agent.lastRunAt ? new Date(agent.lastRunAt).getTime() : 0;
    if (now - lastRun >= agent.scheduleIntervalMs) {
      console.log(`[scheduler] Running agent: ${agent.name}`);
      runAgent(agent).catch(e => console.error('[scheduler] Error:', e.message));
    }
  }
}, 60_000);

// ── On startup: reset any jobs stuck in 'processing' back to 'scheduled' ─────
// (happens when server restarts mid-publish)
{
  const brands = loadBrands();
  let resetCount = 0;
  for (const b of (brands.clients || [])) {
    if (!b.storistaQueue?.length) continue;
    for (const job of b.storistaQueue) {
      // Only reset 'processing' jobs that never got a tiktokVideoId — those are truly orphaned.
      // Jobs that DO have a tiktokVideoId were submitted to TikTok; leave them as 'processing'
      // so the polling scheduler (below) can pick them up and check their final status.
      if (job.status === 'processing' && !job.tiktokVideoId) {
        job.status = 'scheduled';
        resetCount++;
      }
    }
  }
  if (resetCount > 0) {
    saveBrands(brands);
    console.log(`[storista-startup] Reset ${resetCount} stuck 'processing' job(s) back to 'scheduled'`);
  }
}

// ── Storista scheduled publisher — runs every 60 s, publishes due videos ─────
setInterval(async () => {
  const now = Date.now();
  const brands = loadBrands();
  let changed = false;
  for (const brand of (brands.clients || [])) {
    if (!brand.storistaApiKey || !brand.storistaQueue?.length) continue;

    // ── Re-check 'processing' jobs that have a tiktokVideoId but never confirmed ──
    // These are jobs that were submitted to TikTok but the 60s polling window expired.
    // Storista processes asynchronously — check their current status now.
    const pendingCheck = brand.storistaQueue.filter(j => j.status === 'processing' && j.tiktokVideoId);
    if (pendingCheck.length) {
      const authHeader = `Bearer ${brand.storistaApiKey}`;
      const sGet = (p) => axios.get(`${STORISTA_BASE}${p}`, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
        timeout: 15_000,
      });
      for (const job of pendingCheck) {
        try {
          const { data: st } = await sGet(`/v1/tiktok/accounts/${job.account}/videos/${job.tiktokVideoId}`);
          if (st.status === 'READY' || st.status === 'PUBLISHED') {
            job.status = 'published';
            job.publishedAt = job.publishedAt || new Date().toISOString();
            changed = true;
            console.log(`[storista-sched] Late-confirm published: "${job.filename}" (vid ${job.tiktokVideoId})`);
          } else if (st.status === 'REJECTED') {
            job.status = 'failed';
            job.error = st.reject_reason || 'Rejected by TikTok';
            changed = true;
            console.log(`[storista-sched] Confirmed rejected: "${job.filename}" (vid ${job.tiktokVideoId}) — ${job.error}`);
          }
          // PROCESSING → leave as-is, check again next tick
        } catch (e) {
          console.log(`[storista-sched] Re-check error for vid ${job.tiktokVideoId}:`, e.message);
        }
      }
    }

    const due = brand.storistaQueue.filter(j => j.status === 'scheduled' && new Date(j.scheduledFor).getTime() <= now);
    if (!due.length) continue;
    const authHeader = `Bearer ${brand.storistaApiKey}`;
    const s = axios.create({
      baseURL: STORISTA_BASE,
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
    // GET helper — no Content-Type so FastAPI doesn't try to parse a body
    const sGet = (path) => axios.get(`${STORISTA_BASE}${path}`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
      timeout: 15_000,
    });

    // Log the full media list + TikTok video list once per brand per tick
    try {
      const { data: mediaList } = await sGet('/v1/media/');
      const results = mediaList.results || mediaList;
      console.log(`[storista-sched] Media list for ${brand.name} (${Array.isArray(results) ? results.length : '?'} items):`,
        Array.isArray(results) && results.length
          ? results.map(m => `id=${m.id} name=${m.name} file_url=${!!m.file_url} w=${m.width} h=${m.height}`).join(', ')
          : JSON.stringify(mediaList).slice(0, 300));
    } catch (listErr) {
      console.log(`[storista-sched] Media list error:`, listErr.response?.status, JSON.stringify(listErr.response?.data).slice(0, 200));
    }
    // Also log TikTok videos list
    const account = due[0]?.account;
    if (account) {
      try {
        const { data: vidList } = await sGet(`/v1/tiktok/accounts/${account}/videos`);
        const vids = vidList.results || vidList;
        console.log(`[storista-sched] TikTok videos for ${account} (${Array.isArray(vids) ? vids.length : '?'}):`,
          Array.isArray(vids) && vids.length
            ? vids.map(v => `id=${v.id} status=${v.status} video.id=${v.video?.id}`).join(', ')
            : JSON.stringify(vidList).slice(0, 300));
      } catch (vErr) {
        console.log(`[storista-sched] TikTok video list error:`, vErr.response?.status, JSON.stringify(vErr.response?.data).slice(0, 200));
      }
    }

    for (const job of due) {
      try {
        // Check media readiness via GET (returns 404 while still processing)
        let mediaFound = false;
        try {
          const { data: mediaCheck } = await sGet(`/v1/media/${job.mediaId}`);
          console.log(`[storista-sched] Media ${job.mediaId}:`, JSON.stringify(mediaCheck).slice(0, 300));
          mediaFound = true;
        } catch (mediaErr) {
          const status = mediaErr.response?.status;
          console.log(`[storista-sched] Media ${job.mediaId} GET ${status}:`, JSON.stringify(mediaErr.response?.data).slice(0, 200));
          // 404 = still processing or failed; fall through and try the create
        }

        const createPayload = {
          video_id:     parseInt(job.mediaId, 10),  // must be integer — Storista media ID
          caption:      job.caption   || '',
          product_id:   job.productId || '',
          product_link: 'SHOP NOW',                 // required CTA, max 20 chars
        };
        console.log(`[storista-sched] Creating TikTok video for "${job.filename}" account=${job.account} payload=`, JSON.stringify(createPayload));
        const { data: created } = await s.post(`/v1/tiktok/accounts/${job.account}/videos`, createPayload);
        console.log(`[storista-sched] TikTok video created:`, JSON.stringify(created).slice(0, 300));
        const vid_id = created.id || created.video_id;
        const { data: publishRes } = await s.post(`/v1/tiktok/accounts/${job.account}/videos/${vid_id}/publish`, {});
        console.log(`[storista-sched] Publish response:`, JSON.stringify(publishRes).slice(0, 300));

        // Mark as 'processing' + save IMMEDIATELY before polling so concurrent ticks don't re-pick this job
        // (polling takes ~60s, which is the same as the tick interval — without this early save the next
        // tick fires, sees status=scheduled, and submits a duplicate video)
        job.status = 'processing';
        job.tiktokVideoId = vid_id;
        changed = true;
        saveBrands(brands);

        // Poll for READY status (Storista runs validation/pre-checks after publish)
        let ready = false;
        for (let poll = 0; poll < 12; poll++) {
          await new Promise(r => setTimeout(r, 5000));
          try {
            const { data: statusCheck } = await sGet(`/v1/tiktok/accounts/${job.account}/videos/${vid_id}`);
            console.log(`[storista-sched] Status poll ${poll + 1}: status=${statusCheck.status} status_text=${statusCheck.status_text}`);
            if (statusCheck.status === 'READY' || statusCheck.status === 'PUBLISHED') {
              ready = true;
              break;
            }
            if (statusCheck.reject_reason) {
              throw new Error(`Rejected: ${statusCheck.reject_reason} — ${statusCheck.status_text}`);
            }
          } catch (pollErr) {
            if (pollErr.message?.startsWith('Rejected:')) throw pollErr;
            console.log(`[storista-sched] Status poll error:`, pollErr.message);
          }
        }

        job.status      = ready ? 'published' : 'processing';
        job.publishedAt = new Date().toISOString();
        job.tiktokVideoId = vid_id;
        changed = true;
        console.log(`[storista-sched] "${job.filename}" for ${brand.name}: ${ready ? 'PUBLISHED ✓' : 'PROCESSING (check back later)'}`);
      } catch (e) {
        const errBody = e.response?.data;
        const detail  = errBody?.detail;
        const errMsg  = detail
          ? (Array.isArray(detail) ? detail.map(d => d.msg || d.msg).join('; ') : String(detail))
          : (errBody ? JSON.stringify(errBody) : e.message);
        console.error(`[storista-sched] Error for "${job.filename}" (status ${e.response?.status}):`, errMsg, '| full body:', JSON.stringify(errBody).slice(0, 400));

        // "Video not found" means Storista is still processing the media — retry up to 15 times
        const isProcessing = typeof errMsg === 'string' && /not found/i.test(errMsg);
        job.retries = (job.retries || 0) + 1;
        if (isProcessing && job.retries < 15) {
          console.log(`[storista-sched] Media not ready for "${job.filename}" (retry ${job.retries}/15) — will retry next tick`);
          // leave status as 'scheduled' so it retries
        } else {
          job.status = 'failed';
          job.error  = errMsg;
          console.error(`[storista-sched] Failed "${job.filename}" for ${brand.name}:`, errMsg);
        }
        changed = true;
      }
    }
  }
  if (changed) saveBrands(brands);
}, 60_000);

// ─── Affiliate Agent routes ──────────────────────────────────────────────────
// ─────────��───────────────��──────────��────────────────────────────────────────
// Affiliate Agent — routes.js
// New Express routes to append to dashboard-server.js.
//
// Insertion point: paste these after the existing /api/reacher/* block
// (around line 910, after the /api/command route).
//
// Dependencies already in scope in dashboard-server.js:
//   app     — Express instance
//   axios   — axios instance (or use the ghl axios instance for GHL calls)
//   CFG     — { railwayUrl }
//   cached  — cached(key, ttlMs, fn) helper
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/reacher/automations/create — create a new automation in Reacher
app.post('/api/reacher/automations/create', requireAuth, async (req, res) => {
  try {
    const { type, shopId, ...rest } = req.body || {};
    const endpoint = {
      'dm': 'automation/dm',
      'tc': 'automation/tc',
      'email': 'automation/email',
      'sample_request': 'automation/sample-request',
      'target_collab': 'automation/target-collab',
    }[type];
    if (!endpoint) return res.status(400).json({ ok: false, error: 'Invalid type' });
    const r = await axios.post(`${CFG.railwayUrl}/affiliate/shops/${shopId}/${endpoint}`, rest, { timeout: 15000 });
    res.json({ ok: true, automation: r.data });
  } catch(e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
});

// POST /api/reacher/automations/:automationId/start
app.post('/api/reacher/automations/:automationId/start', requireAuth, async (req, res) => {
  try {
    const r = await axios.post(`${CFG.railwayUrl}/affiliate/automations/${req.params.automationId}/start`, {}, { timeout: 10000 });
    res.json({ ok: true, data: r.data });
  } catch(e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
});

// POST /api/reacher/automations/:automationId/stop
app.post('/api/reacher/automations/:automationId/stop', requireAuth, async (req, res) => {
  try {
    const r = await axios.post(`${CFG.railwayUrl}/affiliate/automations/${req.params.automationId}/stop`, {}, { timeout: 10000 });
    res.json({ ok: true, data: r.data });
  } catch(e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
});

// DELETE /api/reacher/automations/:automationId
app.delete('/api/reacher/automations/:automationId', requireAuth, async (req, res) => {
  try {
    await axios.delete(`${CFG.railwayUrl}/affiliate/automations/${req.params.automationId}`, { timeout: 10000 });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
});

// ── POST /api/affiliate/blast ──────────────────────��──────────────────────────
// Body: { message: string, audience: string, channel: string, shopId?: string }
// Fires a creator blast message via the chosen channel.
//
// STUB: Returns a synthetic success response until the real send integration
// (Reacher DM / Email / SMS) is wired up on the Railway server.
app.post('/api/affiliate/blast', async (req, res) => {
  const { message, audience, channel, shopId } = req.body || {};

  // Basic validation
  if (!message || !audience || !channel) {
    return res.status(400).json({ ok: false, error: 'message, audience, and channel are required' });
  }

  // STUB: In production, forward to Railway:
  //   const { data } = await axios.post(`${CFG.railwayUrl}/affiliate/blast`, req.body, { timeout: 15_000 });
  //   return res.json(data);

  try {
    // Derive a plausible send count from S.reacher state (not accessible server-side here,
    // so we return a placeholder count). Replace with real count from Reacher API.
    const stubSentCount = audience === 'all_funnel' ? 42
      : audience === 'active_posters' ? 18
      : audience === 'non_starters'   ? 11
      : audience === 'sample_approved'? 24
      : 10;

    // Log for observability
    console.log(`[affiliate/blast] audience=${audience} channel=${channel} shopId=${shopId||'all'} msg="${message.slice(0,60)}"`);

    res.json({ ok: true, sent: stubSentCount, audience, channel });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/affiliate/promotion ────────────────────────────────────────────
// Body: { shopId: string, commission: number, type: string, duration: number }
// Creates a new promotion for a shop.
//
// STUB: Returns a synthetic promoId until Reacher / TikTok Shop promotions API
// integration is built on the Railway server.
app.post('/api/affiliate/promotion', async (req, res) => {
  const { shopId, commission, type, duration } = req.body || {};

  // Basic validation
  if (!shopId) {
    return res.status(400).json({ ok: false, error: 'shopId is required' });
  }
  if (commission == null || commission < 5 || commission > 40) {
    return res.status(400).json({ ok: false, error: 'commission must be between 5 and 40' });
  }
  if (!type) {
    return res.status(400).json({ ok: false, error: 'type is required' });
  }

  // STUB: In production, forward to Railway:
  //   const { data } = await axios.post(`${CFG.railwayUrl}/affiliate/shops/${shopId}/promotions`, {
  //     commission, type, duration
  //   }, { timeout: 15_000 });
  //   return res.json(data);

  try {
    const promoId = 'promo_' + Date.now();

    console.log(`[affiliate/promotion] shop=${shopId} commission=${commission}% type=${type} duration=${duration}d → ${promoId}`);

    res.json({
      ok:      true,
      promoId,
      shopId,
      commission,
      type,
      duration,
      createdAt: new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/affiliate/promotions/:shopId ─────────────────────────────────────
// Returns active promotions for a given shop.
//
// STUB: Returns an empty promotions array until Reacher promotions API
// is wired up. The front-end manage panel handles the empty state gracefully.
app.get('/api/affiliate/promotions/:shopId', async (req, res) => {
  const { shopId } = req.params;

  // STUB: In production, forward to Railway:
  //   const data = await cached(`affiliate_promos_${shopId}`, 60_000, async () => {
  //     const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shopId}/promotions`, { timeout: 15_000 });
  //     return data;
  //   });
  //   return res.json(data);

  try {
    console.log(`[affiliate/promotions] fetching promotions for shop=${shopId}`);

    // STUB: empty list — replace with real fetch
    res.json({ ok: true, shopId, promotions: [] });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ─── Shop Ops Agent routes ───────────────────────────────────────────────────
// ─── Shop Ops Agent — Express routes ─────────────────────────────────────────
// Paste these app.get / app.post blocks into dashboard-server.js
// alongside the existing Reacher routes (after line ~910).

// GET /api/shopops/promotions — returns stub promotion list
app.get('/api/shopops/promotions', async (req, res) => {
  try {
    // STUB — replace with real DB/cache lookup when persistence is wired up
    res.json({ promotions: [] });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/shopops/promotion — launch a new promotion
// Body: { shopId, type, commission, duration, tier }
app.post('/api/shopops/promotion', async (req, res) => {
  try {
    const { shopId, type, commission, duration, tier } = req.body;

    // Basic validation
    if (!shopId)                               return res.status(400).json({ error: 'shopId is required' });
    if (!type)                                 return res.status(400).json({ error: 'type is required' });
    if (!commission || commission < 5 || commission > 40)
                                               return res.status(400).json({ error: 'commission must be 5–40' });
    if (!duration)                             return res.status(400).json({ error: 'duration is required' });

    // STUB — replace with real Reacher API call or DB write when ready
    // Example future call:
    //   const { data } = await axios.post(`${CFG.railwayUrl}/affiliate/shops/${shopId}/promotions`, req.body);
    //   res.json({ ok: true, promotion: data });

    res.json({ ok: true, promotionId: `promo_stub_${Date.now()}` });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/shopops/outreach/:shopId — trigger outreach for a shop's creators
app.post('/api/shopops/outreach/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    if (!shopId) return res.status(400).json({ error: 'shopId is required' });

    // STUB — replace with real Reacher outreach call when ready
    // Example future call:
    //   const { data } = await axios.post(
    //     `${CFG.railwayUrl}/affiliate/shops/${shopId}/outreach`,
    //     req.body, { timeout: 15_000 }
    //   );
    //   res.json({ ok: true, queued: data.queued });

    res.json({ ok: true, queued: 12 });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/shopops/reengage — re-engage all stuck creators agency-wide
// Stuck = currently in 'content-pending' or 'content-unfulfilled' funnel stage
app.post('/api/shopops/reengage', async (req, res) => {
  try {
    // STUB — replace with real re-engagement logic when ready
    // Example future call:
    //   const { data } = await axios.post(
    //     `${CFG.railwayUrl}/affiliate/agency/reengage`,
    //     { stages: ['content-pending', 'content-unfulfilled'] }, { timeout: 20_000 }
    //   );
    //   res.json({ ok: true, count: data.count });

    res.json({ ok: true, count: 8 });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});


// ─── Paid Media Agent routes ──────────────────��──────────────────────────────
// ─── Paid Media Agent — routes.js ────────────────────────────────────────────
//
// Paste these routes into dashboard-server.js (after the Arcads block works well
// as a reference). The cached() helper and axios are already available there.
//
// Env vars required:
//   TIKTOK_ADS_ACCESS_TOKEN   — long-lived access token from TikTok Marketing API
//   TIKTOK_ADS_ADVERTISER_ID  — your TikTok advertiser account ID
//
// TikTok Marketing API v1.3
//   Base URL : https://business-api.tiktok.com/open_api/v1.3
//   Auth     : header "Access-Token: <token>" (no Bearer prefix)
//   All GETs return { code, message, data: { list, page_info } }
//
// ─────────────────────────────────────────────────────────────────────────────

const TIKTOK_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

// ── Shared TikTok GET helper ──────────────────────────────────────────────────
async function ttGet(path, params = {}) {
  const token = process.env.TIKTOK_ADS_ACCESS_TOKEN;
  const { data: body } = await axios.get(`${TIKTOK_BASE}${path}`, {
    headers: { 'Access-Token': token },
    params:  {
      advertiser_id: process.env.TIKTOK_ADS_ADVERTISER_ID,
      ...params,
    },
  });
  if (body.code !== 0) throw new Error(`TikTok API error ${body.code}: ${body.message}`);
  return body.data;
}

// ── Shared TikTok POST helper ────────────────────────��────────────────────────
async function ttPost(path, payload = {}) {
  const token = process.env.TIKTOK_ADS_ACCESS_TOKEN;
  const { data: body } = await axios.post(`${TIKTOK_BASE}${path}`, payload, {
    headers: {
      'Access-Token':  token,
      'Content-Type': 'application/json',
    },
  });
  if (body.code !== 0) throw new Error(`TikTok API error ${body.code}: ${body.message}`);
  return body.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paidmedia/tiktok/summary
//
// Combines campaign list + integrated report metrics into a single response.
// Returns:
// {
//   connected: true,
//   campaigns: [{ id, name, status, budget, spend, impressions, clicks, ctr, cpc }],
//   totals:    { spend, impressions, clicks, ctr, cpc, conversions, roas },
//   topAds:    [{ id, name, spend, impressions, ctr }],
//   monthlyBudget: <sum of daily budgets * days in month>,
// }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/paidmedia/tiktok/summary', async (req, res) => {
  try {
    if (!process.env.TIKTOK_ADS_ACCESS_TOKEN) {
      return res.json({ connected: false, error: 'Add TIKTOK_ADS_ACCESS_TOKEN and TIKTOK_ADS_ADVERTISER_ID to .env' });
    }

    const data = await cached('tiktok_summary', 300_000, async () => {

      // ── 1. Fetch campaign list ──────────────────────────────────────────────
      const campData = await ttGet('/campaign/get/', {
        page:      1,
        page_size: 100,
        fields:    JSON.stringify([
          'campaign_id', 'campaign_name', 'status',
          'budget', 'budget_mode', 'operation_status',
        ]),
      });
      const rawCampaigns = campData.list || [];

      // ── 2. Fetch integrated report (last 30 days) ─���─────────────────────────
      const today = new Date();
      const end   = today.toISOString().slice(0, 10);
      const start = new Date(today);
      start.setDate(start.getDate() - 30);
      const startDate = start.toISOString().slice(0, 10);

      const reportData = await ttGet('/report/integrated/get/', {
        report_type:  'BASIC',
        data_level:   'AUCTION_CAMPAIGN',
        dimensions:   JSON.stringify(['campaign_id']),
        metrics:      JSON.stringify([
          'spend', 'impressions', 'clicks', 'ctr', 'cpc',
          'conversion', 'total_purchase_value',
        ]),
        start_date:   startDate,
        end_date:     end,
        page_size:    100,
      });
      const reportRows = reportData.list || [];

      // Build a lookup: campaign_id → metrics
      const metricsMap = {};
      for (const row of reportRows) {
        const id = row.dimensions?.campaign_id;
        if (id) metricsMap[id] = row.metrics || {};
      }

      // ── 3. Fetch ad-level report for top creatives ─────────────────────────
      let topAds = [];
      try {
        const adReport = await ttGet('/report/integrated/get/', {
          report_type:  'BASIC',
          data_level:   'AUCTION_AD',
          dimensions:   JSON.stringify(['ad_id']),
          metrics:      JSON.stringify(['ad_name', 'spend', 'impressions', 'ctr']),
          start_date:   startDate,
          end_date:     end,
          page_size:    50,
          order_field:  'spend',
          order_type:   'DESC',
        });
        topAds = (adReport.list || []).slice(0, 10).map(row => ({
          id:          row.dimensions?.ad_id,
          name:        row.metrics?.ad_name || 'Unnamed Ad',
          spend:       parseFloat(row.metrics?.spend       || 0),
          impressions: parseInt(row.metrics?.impressions   || 0, 10),
          ctr:         parseFloat(row.metrics?.ctr         || 0),
        }));
      } catch (_) {
        // Non-fatal — top creative data is optional
      }

      // ── 4. Merge campaign list + metrics ───────────────────────────────────
      const campaigns = rawCampaigns.map(c => {
        const id = String(c.campaign_id);
        const m  = metricsMap[id] || {};
        return {
          id,
          name:        c.campaign_name,
          status:      c.operation_status || c.status,
          budget:      parseFloat(c.budget || 0),
          spend:       parseFloat(m.spend       || 0),
          impressions: parseInt(m.impressions   || 0, 10),
          clicks:      parseInt(m.clicks        || 0, 10),
          ctr:         parseFloat(m.ctr         || 0),
          cpc:         parseFloat(m.cpc         || 0),
          conversions: parseInt(m.conversion    || 0, 10),
          revenue:     parseFloat(m.total_purchase_value || 0),
        };
      });

      // ── 5. Aggregate totals ────────────────────────────────────────────────
      const totals = campaigns.reduce(
        (acc, c) => {
          acc.spend       += c.spend;
          acc.impressions += c.impressions;
          acc.clicks      += c.clicks;
          acc.conversions += c.conversions;
          acc.revenue     += c.revenue;
          return acc;
        },
        { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 }
      );
      totals.ctr  = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
      totals.cpc  = totals.clicks > 0      ? totals.spend / totals.clicks               : 0;
      totals.roas = totals.spend > 0       ? totals.revenue / totals.spend              : null;

      // ── 6. Estimated monthly budget (sum of daily budgets × days in month) ─
      const now           = new Date();
      const daysInMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const activeBudgets = campaigns
        .filter(c => c.status === 'ENABLE' || c.status === 'active')
        .reduce((s, c) => s + (c.budget || 0), 0);
      const monthlyBudget = activeBudgets * daysInMonth;

      return { connected: true, campaigns, totals, topAds, monthlyBudget };
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ connected: false, error: e.response?.data || e.message });
  }
});

// ────────────────────────────────��────────────────────────────────────────────
// GET /api/paidmedia/tiktok/report?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
//
// Time-series report — account-level daily metrics for charting.
// Returns: { connected, rows: [{ date, spend, impressions, clicks, ctr, cpc }] }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/paidmedia/tiktok/report', async (req, res) => {
  try {
    if (!process.env.TIKTOK_ADS_ACCESS_TOKEN) {
      return res.json({ connected: false, error: 'Add TIKTOK_ADS_ACCESS_TOKEN to .env' });
    }

    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }

    const cacheKey = `tiktok_report_${start_date}_${end_date}`;
    const data = await cached(cacheKey, 300_000, async () => {
      const reportData = await ttGet('/report/integrated/get/', {
        report_type:  'BASIC',
        data_level:   'AUCTION_ADVERTISER',
        dimensions:   JSON.stringify(['stat_time_day']),
        metrics:      JSON.stringify([
          'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'conversion',
        ]),
        start_date,
        end_date,
        page_size: 100,
        order_field: 'stat_time_day',
        order_type:  'ASC',
      });

      const rows = (reportData.list || []).map(row => ({
        date:        row.dimensions?.stat_time_day?.slice(0, 10),
        spend:       parseFloat(row.metrics?.spend       || 0),
        impressions: parseInt(row.metrics?.impressions   || 0, 10),
        clicks:      parseInt(row.metrics?.clicks        || 0, 10),
        ctr:         parseFloat(row.metrics?.ctr         || 0),
        cpc:         parseFloat(row.metrics?.cpc         || 0),
        conversions: parseInt(row.metrics?.conversion    || 0, 10),
      }));

      return { connected: true, rows, start_date, end_date };
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ connected: false, error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────��──────────────────────���────
// POST /api/paidmedia/tiktok/campaign/:id/status
//
// Body: { status: 'ENABLE' | 'DISABLE' }
// Calls TikTok /campaign/status/update/ to pause or resume a campaign.
// Returns: { ok: true } or { ok: false, error }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/paidmedia/tiktok/campaign/:id/status', async (req, res) => {
  try {
    if (!process.env.TIKTOK_ADS_ACCESS_TOKEN) {
      return res.json({ ok: false, error: 'Add TIKTOK_ADS_ACCESS_TOKEN to .env' });
    }

    const { id }     = req.params;
    const { status } = req.body;

    if (!['ENABLE', 'DISABLE'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'status must be ENABLE or DISABLE' });
    }

    await ttPost('/campaign/status/update/', {
      advertiser_id: process.env.TIKTOK_ADS_ADVERTISER_ID,
      campaign_ids:  [id],
      opt_status:    status,
    });

    // Bust the summary cache so next load reflects the change
    cache.delete('tiktok_summary');

    res.json({ ok: true, campaign_id: id, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/paidmedia/tiktok/pause-all
//
// Pauses all currently ENABLE campaigns for this advertiser.
// STUB — implement after confirming credentials work.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/paidmedia/tiktok/pause-all', async (req, res) => {
  try {
    if (!process.env.TIKTOK_ADS_ACCESS_TOKEN) {
      return res.json({ ok: false, error: 'Add TIKTOK_ADS_ACCESS_TOKEN to .env' });
    }

    // STUB: In production, fetch all active campaign IDs then batch-disable them.
    // TikTok allows up to 20 campaign_ids per /campaign/status/update/ call.
    //
    // Example implementation:
    //   const campData = await ttGet('/campaign/get/', { page_size: 100 });
    //   const activeIds = campData.list
    //     .filter(c => c.operation_status === 'ENABLE')
    //     .map(c => String(c.campaign_id));
    //   // Batch into chunks of 20
    //   for (let i = 0; i < activeIds.length; i += 20) {
    //     const chunk = activeIds.slice(i, i + 20);
    //     await ttPost('/campaign/status/update/', {
    //       advertiser_id: process.env.TIKTOK_ADS_ADVERTISER_ID,
    //       campaign_ids:  chunk,
    //       opt_status:    'DISABLE',
    //     });
    //   }
    //   cache.delete('tiktok_summary');
    //   return res.json({ ok: true, paused: activeIds.length });

    res.json({
      ok:      true,
      stub:    true,
      message: 'Pause All is a stub. Uncomment the implementation in routes.js when ready.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paidmedia/meta/summary
//
// STUB — Meta Ads API integration is not yet implemented.
// Requires: META_ADS_ACCESS_TOKEN, META_ADS_ACCOUNT_ID
// Docs: https://developers.facebook.com/docs/marketing-api/insights
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/paidmedia/meta/summary', async (req, res) => {
  // STUB
  res.json({
    connected: false,
    error:     'Meta Ads not yet connected. Add META_ADS_ACCESS_TOKEN and META_ADS_ACCOUNT_ID to .env.',
    stub:      true,
  });
});


// ───────────��─────────────────────────────────────────────────────────────────
// POST /api/shortvideo/loop/run
// Autonomous weekly content loop: analyze → ideate → script → schedule
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/shortvideo/loop/run', async (req, res) => {
  const { postCount = 5 } = req.body || {};
  const LOOP_LOG_FILE = path.join(__dirname, 'loop-history.json');

  // Step 1: pull recent video performance from Arcads
  let analyzed = 0, topVideos = [];
  try {
    const arcadsKey = process.env.ARCADS_API_KEY;
    if (arcadsKey) {
      const r = await axios.get('https://external-api.arcads.ai/api/v1/videos', {
        auth: { username: arcadsKey, password: '' },
        params: { limit: 50 }
      });
      const videos = r.data?.videos || r.data?.data || [];
      const cutoff = Date.now() - 7 * 86_400_000;
      topVideos = videos
        .filter(v => new Date(v.createdAt || v.created_at || 0).getTime() > cutoff)
        .sort((a, b) => (b.views || 0) - (a.views || 0))
        .slice(0, 10);
      analyzed = topVideos.length;
    }
  } catch (e) { console.error('Loop step 1:', e.message); }

  // Step 2+3: call Claude API — cult-ideator + cult-script-writer
  let ideas = 0, scripts = 0, ideaText = '', scriptText = '';
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const perfContext = topVideos.length
        ? topVideos.map((v,i) => `${i+1}. "${v.name||v.scriptName||'Untitled'}" — ${v.views||0} views`).join('\n')
        : 'No recent video data. Generate fresh TikTok shop content ideas.';

      const ideaMsg = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 1024,
        messages: [{ role: 'user', content:
          `You are the Cult Ideator. Based on this week's performance:\n\n${perfContext}\n\nGenerate ${postCount} TikTok video ideas. Each: Hook (3s) · Concept (1 sentence) · Format. Numbered list.`
        }]
      });
      ideaText = ideaMsg.content[0]?.text || '';
      ideas = (ideaText.match(/^\d+\./gm) || []).length || postCount;

      const scriptMsg = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 2048,
        messages: [{ role: 'user', content:
          `You are the Cult Script Writer. Write a TikTok script (under 60s) for each idea:\n\n${ideaText}\n\nEach script: Hook · Body (3-5 beats) · CTA. Under 150 words each.`
        }]
      });
      scriptText = scriptMsg.content[0]?.text || '';
      scripts = (scriptText.match(/^\d+\./gm) || []).length || ideas;
    } else {
      ideas = postCount; scripts = postCount; // stub
    }
  } catch (e) { console.error('Loop step 2:', e.message); ideas = postCount; scripts = postCount; }

  // Step 4: create Buffer ideas with generated scripts
  // Channel IDs (from Buffer account 69d6ddee1fcceb5bb1faa168 — "My Organization"):
  //   TikTok  tommylynch_     : 69d7f3cd031bfa423ce82b4a
  //   Instagram tommy.lynch_  : 69d6de31031bfa423ce369cf
  //   Instagram cultcontent.cc: 69d70072031bfa423ce3fc25
  let scheduled = 0;
  const bufferToken = process.env.BUFFER_ACCESS_TOKEN;
  if (bufferToken && scriptText) {
    // Parse individual scripts — split on lines starting with a number+period
    // e.g. "1. Title\n..." or "**1.**" patterns Claude commonly uses
    const scriptBlocks = scriptText
      .split(/\n(?=\*{0,2}\d+[\.\)]\*{0,2}\s)/)
      .map(s => s.trim())
      .filter(s => s.length > 20);
    const BUFFER_GQL = 'https://api.buffer.com/graphql';
    const targetChannelId = process.env.BUFFER_TIKTOK_CHANNEL_ID || '69d7f3cd031bfa423ce82b4a';

    for (const block of scriptBlocks.slice(0, postCount)) {
      try {
        // Extract title from first line (e.g. "1. Hook Title")
        const firstLine = block.split('\n')[0].replace(/^\d+\.\s*/, '').trim();
        const body      = block.trim();

        // Create as a Buffer idea so Tommy can review before scheduling
        await axios.post(BUFFER_GQL, {
          query: `mutation CreateIdea($input: CreateIdeaInput!) {
            createIdea(input: $input) {
              ... on Idea { id }
              ... on IdeaResponse { idea { id } }
              ... on InvalidInputError { message }
              ... on UnexpectedError { message }
              ... on LimitReachedError { message }
            }
          }`,
          variables: {
            input: {
              organizationId: '69d6ddee1fcceb5bb1faa168',
              content: {
                title: firstLine.slice(0, 100),
                text:  body.slice(0, 2000),
                services: ['tiktok']
              }
            }
          }
        }, {
          headers: {
            Authorization: `Bearer ${bufferToken}`,
            'Content-Type': 'application/json'
          }
        });
        scheduled++;
      } catch (e) {
        console.error('Loop Buffer idea error:', e.response?.data || e.message);
      }
    }
  }

  // Persist run log
  try {
    let history = fs.existsSync(LOOP_LOG_FILE) ? JSON.parse(fs.readFileSync(LOOP_LOG_FILE, 'utf8')) : [];
    history.push({ at: new Date().toISOString(), analyzed, ideas, scripts, scheduled });
    fs.writeFileSync(LOOP_LOG_FILE, JSON.stringify(history.slice(-100)));
  } catch (_) {}

  res.json({ ok: true, analyzed, ideas, scripts, scheduled });
});

app.get('/api/shortvideo/loop/history', (req, res) => {
  const LOOP_LOG_FILE = path.join(__dirname, 'loop-history.json');
  try {
    if (fs.existsSync(LOOP_LOG_FILE))
      return res.json({ ok: true, history: JSON.parse(fs.readFileSync(LOOP_LOG_FILE, 'utf8')) });
  } catch (_) {}
  res.json({ ok: true, history: [] });
});

// ─── Shopify Auto-Import ──────────────────────────────────────────────────────

app.post('/api/brands/shopify-import', async (req, res) => {
  let { storeUrl } = req.body || {};
  if (!storeUrl) return res.json({ ok: false, error: 'storeUrl is required' });

  // Normalise URL → just the domain
  storeUrl = storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
  const base = `https://${storeUrl}`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const apifyToken = process.env.APIFY_API_KEY;
    let rawData = { products: [], collections: [], homepageMarkdown: '', aboutMarkdown: '' };

    // 1. Products — Shopify public JSON API (free, no credits)
    try {
      const { data } = await axios.get(`${base}/products.json?limit=50`, { timeout: 10_000 });
      rawData.products = (data.products || []).map(p => ({
        title:       p.title,
        type:        p.product_type,
        tags:        p.tags?.slice(0, 8) || [],
        description: p.body_html?.replace(/<[^>]+>/g, '').slice(0, 300) || '',
        minPrice:    Math.min(...(p.variants || []).map(v => parseFloat(v.price) || 0)),
        maxPrice:    Math.max(...(p.variants || []).map(v => parseFloat(v.price) || 0)),
      }));
    } catch(e) { console.error('Shopify products fetch failed:', e.message); }

    // 2. Collections — content pillar seeds
    try {
      const { data } = await axios.get(`${base}/collections.json?limit=50`, { timeout: 10_000 });
      rawData.collections = (data.collections || [])
        .map(c => c.title)
        .filter(t => !t.match(/^\d+$|sale|discount|aff|outlet|secret/i))
        .slice(0, 20);
    } catch(e) { console.error('Shopify collections fetch failed:', e.message); }

    // 3. Homepage + About page via Apify rag-web-browser
    if (apifyToken) {
      const pagesToFetch = [base, `${base}/pages/about`];
      try {
        const { data: ragData } = await axios.post(
          `https://api.apify.com/v2/acts/apify~rag-web-browser/run-sync-get-dataset-items?token=${apifyToken}&timeout=30&memory=256`,
          { query: pagesToFetch.join('\n'), maxResults: 2 },
          { timeout: 60_000 }
        );
        (ragData || []).forEach(r => {
          const md = r.markdown || '';
          if (r.url?.includes('/about')) rawData.aboutMarkdown = md.slice(0, 3000);
          else rawData.homepageMarkdown = md.slice(0, 3000);
        });
      } catch(e) { console.error('Apify rag-web-browser failed:', e.message); }
    }

    // 4. Build summary for Claude
    const priceRange = rawData.products.length
      ? `$${Math.min(...rawData.products.map(p => p.minPrice)).toFixed(0)}–$${Math.max(...rawData.products.map(p => p.maxPrice)).toFixed(0)}`
      : 'unknown';

    const productList = rawData.products.slice(0, 20)
      .map(p => `- ${p.title}${p.type ? ` (${p.type})` : ''} — $${p.minPrice.toFixed(0)}${p.description ? `: ${p.description.slice(0,120)}` : ''}`)
      .join('\n');

    const collectionList = rawData.collections.join(', ');

    const prompt = `You are a brand strategist. Based on the Shopify store data below, generate a structured brand profile for a content agency that will be writing TikTok scripts for this brand.

Store URL: ${storeUrl}
Price range: ${priceRange}

Products (top 20):
${productList || 'No product data available'}

Collections: ${collectionList || 'None'}

Homepage copy:
${rawData.homepageMarkdown || 'Not available'}

About page:
${rawData.aboutMarkdown || 'Not available'}

Return JSON only — fill every field as specifically as possible from the actual data. Do not invent claims not supported by the data:
{
  "name": "brand name",
  "industry": "one-line industry/niche description",
  "products": "summary of what they sell, key products, and price range",
  "audience": "who buys this — demographics, interests, what problem it solves",
  "voice": "brand voice and tone based on their actual copy — 2-3 sentences describing how they write and speak",
  "contentPillars": "3–5 content topics ideal for TikTok, comma-separated",
  "proofPoints": "any real proof points visible in the data (reviews mentioned, awards, certifications, specific claims) — leave blank if none found",
  "cta": "most logical CTA for TikTok content (e.g. shop the link in bio, TikTok Shop below)",
  "avoidTopics": "topics or language that would clash with the brand based on their positioning",
  "extraContext": "anything else a TikTok script writer needs to know about this brand — key differentiators, origin story if mentioned, notable features"
}`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = msg.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const profile = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    res.json({
      ok: true,
      profile,
      meta: {
        productsFound:    rawData.products.length,
        collectionsFound: rawData.collections.length,
        homepageFetched:  !!rawData.homepageMarkdown,
        aboutFetched:     !!rawData.aboutMarkdown,
      }
    });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Growth Partners — Task Persistence ───────────────────────────────────────
const GP_FILE = path.join(DATA_DIR, 'growth-partners.json');

function loadGP() {
  try { return JSON.parse(fs.readFileSync(GP_FILE, 'utf8')); }
  catch(_) { return { partners: {} }; }
}
function saveGP(data) {
  fs.writeFileSync(GP_FILE, JSON.stringify(data, null, 2));
}

// GET /api/growth-partners/:clientId — get task state for one client
app.get('/api/growth-partners/:clientId', (req, res) => {
  const data = loadGP();
  const partner = data.partners[req.params.clientId] || { tasks: {} };
  res.json(partner);
});

// PUT /api/growth-partners/:clientId/tasks/:taskId — toggle a task
app.put('/api/growth-partners/:clientId/tasks/:taskId', (req, res) => {
  const { clientId, taskId } = req.params;
  const { done, doneAt } = req.body || {};
  const data = loadGP();
  if (!data.partners[clientId]) data.partners[clientId] = { tasks: {}, createdAt: new Date().toISOString() };
  data.partners[clientId].tasks[taskId] = { done: !!done, doneAt: doneAt || null };
  saveGP(data);
  res.json({ ok: true });
});

// POST /api/growth-partners/add-prospect — create GHL contact + opportunity from Shopify scrape
app.post('/api/growth-partners/add-prospect', async (req, res) => {
  const { name, email, company, profile } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  try {
    // 1. Create contact
    const cRes = await ghl.post('/contacts/', {
      locationId: CFG.locationId,
      firstName: name.split(' ')[0] || name,
      lastName:  name.split(' ').slice(1).join(' ') || '',
      name,
      email: email || undefined,
      companyName: company || profile?.name || undefined,
      tags: ['growth-partner-prospect'],
    });
    const contactId = cRes.data?.contact?.id;
    if (!contactId) throw new Error('Contact creation failed: ' + JSON.stringify(cRes.data));

    // 2. Create opportunity in Lead stage
    const oRes = await ghl.post('/opportunities/', {
      locationId:      CFG.locationId,
      name,
      pipelineId:      'W5PxjulbNVh52Gqlkmzm',
      pipelineStageId: '93bc4029-7dbd-4598-8862-cb7ac7784016', // Lead
      contactId,
      status: 'open',
    });
    const oppId = oRes.data?.opportunity?.id;

    // Bust pipeline cache
    cache.delete('pipeline:growth-partners');

    res.json({ ok: true, contactId, oppId });
  } catch (err) {
    console.error('add-prospect:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── Meeting Intelligence ─────────────────────────────────────────────────────
app.get('/api/meeting-intel', (req, res) => {
  const data = loadMeetingIntel();
  res.json({ ok: true, meetings: data.meetings.slice(0, 50) });
});

app.post('/api/meeting-intel/:id/apply', async (req, res) => {
  try {
    const intel = loadMeetingIntel();
    const record = intel.meetings.find(m => m.id === req.params.id);
    if (!record) return res.status(404).json({ ok: false, error: 'Not found' });
    if (record.status === 'applied') return res.json({ ok: true, already: true });

    const { analysis, ghlContactId, ghlOppId } = record;
    if (!analysis?.suggestedStageId) return res.status(400).json({ ok: false, error: 'No stage to apply' });

    // Update or create opportunity
    if (ghlOppId) {
      await ghl.put(`/opportunities/${ghlOppId}`, { pipelineStageId: analysis.suggestedStageId });
    } else if (ghlContactId) {
      await ghl.post('/opportunities/', {
        pipelineId: 'W5PxjulbNVh52Gqlkmzm',
        locationId: CFG.locationId,
        name: analysis.companyName || record.title,
        pipelineStageId: analysis.suggestedStageId,
        status: 'open',
        contactId: ghlContactId,
      });
    }

    // Add tags to contact
    if (ghlContactId && analysis.tags?.length) {
      try {
        const cr = await ghl.get(`/contacts/${ghlContactId}`);
        const existing = cr.data?.contact?.tags || [];
        const merged = [...new Set([...existing, ...analysis.tags])];
        await ghl.put(`/contacts/${ghlContactId}`, { tags: merged });
      } catch(e) { /* non-fatal */ }
    }

    // Add note
    if (ghlContactId) {
      try {
        const noteBody = `**Meeting: ${record.title}**\n\nStage: ${analysis.suggestedStageName}\nReasoning: ${analysis.stageReasoning}\n\nSummary: ${analysis.meetingSummary}\n\nAction items:\n${(analysis.actionItems || []).map(a => `• ${a}`).join('\n')}`;
        await ghl.post(`/contacts/${ghlContactId}/notes/`, { body: noteBody, userId: CFG.userId || '' });
      } catch(e) { /* non-fatal */ }
    }

    record.status = 'applied';
    record.appliedAt = new Date().toISOString();
    saveMeetingIntel(intel);
    cache.delete('pipeline:growth-partners');
    res.json({ ok: true });
  } catch(e) {
    console.error('[meeting-intel apply]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/meeting-intel/:id/skip', (req, res) => {
  const intel = loadMeetingIntel();
  const record = intel.meetings.find(m => m.id === req.params.id);
  if (!record) return res.status(404).json({ ok: false, error: 'Not found' });
  record.status = 'skipped';
  saveMeetingIntel(intel);
  res.json({ ok: true });
});

// ─── Client name normalisation ────────────────────────────────────────────────
// ── Team member Lark IDs (from Cult Content Comms Channel) ────────────────────
const LARK_TEAM_IDS = {
  'tommy lynch': 'ou_cd6157679f48e0cea557ebcb1995c462',
  'tommy':       'ou_cd6157679f48e0cea557ebcb1995c462',
  'hasan':       'ou_c8f157f2f18a8c4ffe6a20d3971348e1',
  'gilbert conte': 'ou_117739bee32bfbe46cfbb11e5df88472',
  'gilbert':     'ou_117739bee32bfbe46cfbb11e5df88472',
  'hillary':     'ou_3209ce4fcb8553908f0d09c30dbae45f',
};

// Send a Lark @mention notification when a task is assigned to someone.
// Routes through Railway /command so it goes to the alerts channel.
async function sendLarkAssignmentNotification(assigneeName, taskText, meetingTitle, client) {
  try {
    const larkId = LARK_TEAM_IDS[assigneeName.toLowerCase()];
    const mention = larkId ? `<at user_id="${larkId}">${assigneeName}</at>` : assigneeName;
    const clientPart = client && client !== 'Internal' ? ` [${client}]` : '';
    const text = `📋 Task assigned to ${mention}${clientPart}: "${taskText}" — from ${meetingTitle}\n\nMark it complete in the Command Center: https://manifest.cultcontent.cc`;
    await axios.post(`${CFG.railwayUrl}/command`,
      { text, context: 'Task Assignment', source: 'Command Center' },
      { timeout: 5000 }
    );
  } catch(e) { console.error('[lark-assign] notification error:', e.message); }
}

// Fuzzy-match two task strings to detect if they describe the same action.
// Used by re-analyze to carry over the done state.
function isSimilarTask(a, b) {
  if (!a || !b) return false;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  // Jaccard similarity on words longer than 3 chars
  const wordsA = new Set(na.split(' ').filter(w => w.length > 3));
  const wordsB = new Set(nb.split(' ').filter(w => w.length > 3));
  if (!wordsA.size || !wordsB.size) return false;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union >= 0.5;
}

// Build a map of { "lenea": "Approved Science", "john": "DIAMANDIA", ... }
// from the contactName field on each brand in brands.json
function buildContactMap(brandsData) {
  const map = {};
  for (const brand of (brandsData?.clients || [])) {
    const contactName = (brand.contactName || '').trim();
    if (!contactName || !brand.name) continue;
    // Use first name only (e.g. "Lenea Smith" → "lenea")
    const first = contactName.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
    if (first.length >= 2) map[first] = brand.name;
  }
  return map;
}

function normaliseClientName(guessed, knownClients, contactMap) {
  if (!guessed || !knownClients?.length) return guessed || '';
  const g = guessed.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!g) return '';
  // Exact or contained match against known brand names
  for (const c of knownClients) {
    const k = c.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (k === g || k.includes(g) || g.includes(k)) return c;
  }
  // Contact name → brand match (e.g. "Lenea" → "Approved Science")
  if (contactMap) {
    const brandForContact = contactMap[g] || Object.entries(contactMap).find(([first]) => first.startsWith(g) || g.startsWith(first))?.[1];
    if (brandForContact) return brandForContact;
  }
  // Partial token overlap (e.g. "amandia" → "DIAMANDIA")
  for (const c of knownClients) {
    const k = c.toLowerCase().replace(/[^a-z0-9]/g, '');
    const overlap = [...g].filter((ch, i) => k.includes(g.slice(Math.max(0,i-1), i+3))).length;
    if (overlap >= Math.min(4, g.length * 0.6)) return c;
  }
  return ''; // couldn't match — pass through original value
}

// ─── Client Meetings (Lark-based Meeting Intel) ───────────────────────────────
const CLIENT_MEETINGS_FILE = path.join(DATA_DIR, 'client-meetings.json');

function loadClientMeetings() {
  try { return JSON.parse(fs.readFileSync(CLIENT_MEETINGS_FILE, 'utf8')); }
  catch(_) { return { meetings: [] }; }
}
function saveClientMeetings(data) {
  fs.writeFileSync(CLIENT_MEETINGS_FILE, JSON.stringify(data, null, 2));
}

// Build the client tagging instruction block used in every AI prompt
function buildClientTaggingPrompt(brandsData) {
  const clients = brandsData?.clients || [];
  const brandLines = clients.map(c => {
    const contactFirst = (c.contactName||'').split(/\s+/)[0];
    return `- ${c.name}${contactFirst ? ` (primary contact: ${contactFirst})` : ''}`;
  }).join('\n');
  return `Client tagging rules — for BOTH the top-level "client" field and each action item's "client" field:
Known brands and their primary contacts (if a participant's name matches a contact, use the BRAND name):
${brandLines || '(none yet)'}

Rules:
- If a task/topic involves a known brand or their contact → use the BRAND name exactly
- If a task involves any other external person (not Cult Content staff) → use their first name
- Use "Internal" ONLY for purely internal Cult Content tasks with no external person/brand`;
}

// GET /api/meetings  — all meetings + aggregated intel
app.get('/api/meetings', (req, res) => {
  const data = loadClientMeetings();
  const meetings = data.meetings || [];
  console.log(`[client-meetings] GET — ${meetings.length} meeting(s) in file`);
  const brandsData = loadBrands();
  const knownClients = (brandsData.clients || []).map(c => c.name || c.id).filter(Boolean);

  // Aggregate action items by client
  const byClient = {};
  const byPerson = {};
  const themeCounts = {};

  for (const m of meetings) {
    for (const ai of (m.actionItems || [])) {
      const client = ai.client || m.client || 'General';
      const assignee = ai.assignee || 'Unassigned';
      if (!byClient[client]) byClient[client] = [];
      byClient[client].push({ ...ai, meetingId: m.id, meetingDate: m.date, meetingTitle: m.title });
      if (!byPerson[assignee]) byPerson[assignee] = [];
      byPerson[assignee].push({ ...ai, meetingId: m.id, meetingDate: m.date, meetingTitle: m.title, client });
    }
    for (const theme of (m.themes || [])) {
      themeCounts[theme] = (themeCounts[theme] || 0) + 1;
    }
  }

  const recurringThemes = Object.entries(themeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([theme, count]) => ({ theme, count }));

  const teamMembers = getTeamMembers();

  res.json({ ok: true, meetings: meetings.slice(0, 100), byClient, byPerson, recurringThemes, knownClients, teamMembers });
});

// POST /api/meetings  — add a meeting with AI analysis
app.post('/api/meetings', async (req, res) => {
  try {
    const { date, client, participants, notes, title, duration } = req.body;
    if (!notes) return res.status(400).json({ ok: false, error: 'notes required' });

    const data = loadClientMeetings();
    const brandsData = loadBrands();
    const knownClients = (brandsData.clients || []).map(c => c.name || c.id).filter(Boolean);
    const contactMap = buildContactMap(brandsData);

    // AI analysis
    let actionItems = [], themes = [], summary = '', keyProblems = [];
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: `You are analyzing meeting notes from a TikTok Shop content/affiliate agency called Cult Content. Extract structured data from these meeting notes.

${buildClientTaggingPrompt(brandsData)}

Meeting details:
- Date: ${date || 'unknown'}
- Client: ${client || 'unknown'}
- Participants: ${(participants || []).join(', ') || 'unknown'}
- Title: ${title || 'Meeting'}

Meeting notes:
${notes}

Return ONLY valid JSON with this exact structure:
{
  "summary": "2-3 sentence summary of what was discussed",
  "actionItems": [
    {
      "task": "specific action item",
      "assignee": "person's first name or 'Team'",
      "client": "brand name, person first name, or Internal",
      "priority": "high|medium|low",
      "done": false
    }
  ],
  "themes": ["theme1", "theme2"],
  "keyProblems": ["problem that came up, worded as a short problem statement"]
}

For assignee: use first names from the participants list. If unclear, use 'Tommy' for owner-level tasks, 'Team' for group tasks.
For themes: short 2-4 word phrases like "Creator recruitment", "Budget approval", "Content pipeline", "Platform issues"
For keyProblems: only include if there's a real recurring issue/blocker mentioned. Max 3.
Return only the JSON, no explanation.`
          }]
        });
        const parsed = JSON.parse(msg.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
        actionItems = (parsed.actionItems || []).map(ai => ({
          ...ai,
          client: normaliseClientName(ai.client, knownClients, contactMap) || ai.client || 'Internal',
        }));
        themes = parsed.themes || [];
        summary = parsed.summary || '';
        keyProblems = parsed.keyProblems || [];
      } catch(aiErr) {
        console.error('[client-meetings] AI error:', aiErr.message);
      }
    }

    const meeting = {
      id: `cm_${Date.now()}`,
      date: date || new Date().toISOString().split('T')[0],
      client: normaliseClientName(client, knownClients) || client || '',
      title: title || `${client || 'Team'} Meeting`,
      participants: participants || [],
      duration: duration || null,
      notes,
      summary,
      actionItems,
      themes,
      keyProblems,
      createdAt: new Date().toISOString()
    };

    data.meetings.unshift(meeting);
    saveClientMeetings(data);
    res.json({ ok: true, meeting });
  } catch(e) {
    console.error('[client-meetings]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/meetings/:id
app.delete('/api/meetings/:id', (req, res) => {
  const data = loadClientMeetings();
  const before = data.meetings.length;
  data.meetings = data.meetings.filter(m => m.id !== req.params.id);
  if (data.meetings.length === before) return res.status(404).json({ ok: false, error: 'Not found' });
  saveClientMeetings(data);
  res.json({ ok: true });
});

// PATCH /api/meetings/:id/action/:idx  — edit fields or quick status toggle
// Edit:   body with any of { task, assignee, client, priority, status, notes }
// Toggle: body with { toggleStatus: true } — cycles open→in-progress→closed
app.patch('/api/meetings/:id/action/:idx', async (req, res) => {
  const data = loadClientMeetings();
  const m = data.meetings.find(m => m.id === req.params.id);
  if (!m) return res.status(404).json({ ok: false, error: 'Not found' });
  const idx = parseInt(req.params.idx, 10);
  if (!m.actionItems[idx]) return res.status(404).json({ ok: false, error: 'Action not found' });

  const ai = m.actionItems[idx];
  const { task, assignee, client, priority, status, notes, toggleStatus } = req.body || {};
  const prevStatus   = ai.status || (ai.done ? 'closed' : 'open');
  const prevAssignee = ai.assignee || '';

  if (toggleStatus) {
    // Quick cycle: open → in-progress → closed → open
    const cycle = { 'open': 'in-progress', 'in-progress': 'closed', 'closed': 'open', 'blocked': 'open' };
    ai.status = cycle[prevStatus] || 'open';
  } else {
    if (task     !== undefined) ai.task     = task.trim();
    if (assignee !== undefined) ai.assignee = assignee.trim();
    if (client   !== undefined) ai.client   = client.trim();
    if (priority !== undefined) ai.priority = priority;
    if (status   !== undefined) ai.status   = status;
    if (notes    !== undefined) ai.notes    = notes.trim();
  }

  // Keep done in sync for backward compat
  ai.done = ai.status === 'closed';

  saveClientMeetings(data);

  // @mention new assignee in Lark when task is reassigned
  const newAssignee = ai.assignee || '';
  if (assignee !== undefined && newAssignee && newAssignee.toLowerCase() !== prevAssignee.toLowerCase()) {
    sendLarkAssignmentNotification(newAssignee, ai.task, m.title, ai.client).catch(() => {});
  }

  // Send Lark alert when task is marked closed
  if (prevStatus !== 'closed' && ai.status === 'closed') {
    try {
      const assigneePart = ai.assignee ? ` (@${ai.assignee})` : '';
      const clientPart   = ai.client && ai.client !== 'Internal' ? ` · ${ai.client}` : '';
      const msg = `✅ Task closed: "${ai.task}"${assigneePart}${clientPart} — from _${m.title}_`;
      await axios.post(`${CFG.railwayUrl}/command`,
        { text: msg, context: 'Meeting Intel', source: 'Command Center' },
        { timeout: 5000 }
      );
    } catch(e) { console.error('[meeting-intel] Lark alert error:', e.message); }
  }

  res.json({ ok: true, done: ai.done, actionItem: ai });
});

// DELETE /api/meetings/:id/action/:idx — remove a single action item
app.delete('/api/meetings/:id/action/:idx', (req, res) => {
  const data = loadClientMeetings();
  const m = data.meetings.find(m => m.id === req.params.id);
  if (!m) return res.status(404).json({ ok: false, error: 'Not found' });
  const idx = parseInt(req.params.idx, 10);
  if (!m.actionItems[idx]) return res.status(404).json({ ok: false, error: 'Action not found' });
  m.actionItems.splice(idx, 1);
  saveClientMeetings(data);
  res.json({ ok: true });
});

// POST /api/meetings/reanalyze — re-run AI on all stored meetings with current client list
app.post('/api/meetings/reanalyze', requireAuth, async (req, res) => {
  try {
    const data = loadClientMeetings();
    const _brandsRe = loadBrands();
    const knownClients = (_brandsRe.clients || []).map(c => c.name || c.id).filter(Boolean);
    const contactMap = buildContactMap(_brandsRe);
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ ok: false, error: 'No Anthropic API key' });

    let updated = 0;
    for (const m of data.meetings) {
      if (!m.notes) continue;
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 2000,
          messages: [{
            role: 'user',
            content: `Analyze this meeting transcript from Cult Content agency (TikTok Shop content/affiliate agency).

${buildClientTaggingPrompt(_brandsRe)}

Meeting: ${m.title} (${m.date})
Participants: ${(m.participants||[]).join(', ')||'unknown'}

Transcript:
${(m.notes||'').slice(0, 8000)}

Return JSON only — no explanation:
{"client":"brand name or Internal","summary":"","actionItems":[{"task":"","assignee":"","client":"brand name or Internal","priority":"high|medium|low","done":false}],"themes":[],"keyProblems":[]}`
          }]
        });
        const parsed = JSON.parse(msg.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
        m.client      = normaliseClientName(parsed.client, knownClients, contactMap) || m.client || '';
        m.summary     = parsed.summary     || m.summary;
        m.themes      = parsed.themes      || m.themes;
        m.keyProblems = parsed.keyProblems || m.keyProblems;

        // Preserve done status: match new tasks against previously completed ones
        const prevDone = (m.actionItems || []).filter(ai => ai.done);
        m.actionItems = (parsed.actionItems || []).map(ai => {
          const alreadyDone = prevDone.some(old => isSimilarTask(old.task, ai.task));
          return {
            ...ai,
            client: normaliseClientName(ai.client, knownClients, contactMap) || ai.client || 'Internal',
            done: alreadyDone,
          };
        });
        updated++;
      } catch(e) {
        console.error(`[reanalyze] ${m.id}:`, e.message);
      }
    }
    saveClientMeetings(data);
    console.log(`[reanalyze] updated ${updated}/${data.meetings.length} meetings`);
    res.json({ ok: true, updated, total: data.meetings.length });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/meetings/import-fireflies — import a single transcript by Fireflies URL or ID
// e.g. https://app.fireflies.ai/view/Trusted-Rituals-Onboarding::01KRGPSQ4XHFNB1KZY0Z8B3EB5
app.post('/api/meetings/import-fireflies', requireAuth, async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });

    // Extract transcript ID — everything after the last ::
    const id = url.includes('::') ? url.split('::').pop().split('?')[0].trim() : url.trim();
    if (!id) return res.status(400).json({ ok: false, error: 'Could not extract transcript ID from URL' });

    const keys = [process.env.FIREFLIES_API_KEY, process.env.FIREFLIES_API_KEY_2].filter(Boolean);
    if (!keys.length) return res.status(400).json({ ok: false, error: 'FIREFLIES_API_KEY not set' });

    // Check it's not already imported
    const data = loadClientMeetings();
    if (data.meetings.find(m => m.fireflyId === id)) {
      return res.json({ ok: false, error: 'This transcript is already imported' });
    }

    // Fetch full transcript
    const txQuery = `query Transcript($id: String!) { transcript(id: $id) { id title date participants sentences { speaker_name text } summary { short_summary action_items } } }`;
    let tx = null;
    for (const key of keys) {
      try {
        const r = await axios.post('https://api.fireflies.ai/graphql',
          { query: txQuery, variables: { id } },
          { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        if (r.data?.data?.transcript) { tx = r.data.data.transcript; break; }
      } catch(e) { console.error('[ff-import] fetch error:', e.message); }
    }
    if (!tx) return res.status(404).json({ ok: false, error: `Transcript ${id} not found in Fireflies` });

    const fullTranscript = (tx.sentences || []).map(s => `${s.speaker_name||'Unknown'}: ${s.text}`).join('\n');
    const notes = fullTranscript || `${tx.summary?.short_summary || ''}\n\nAction items:\n${(tx.summary?.action_items || []).join('\n')}`;
    const dateStr = tx.date ? new Date(tx.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    const _brandsFF = loadBrands();
    const knownClients = (_brandsFF.clients || []).map(c => c.name || c.id).filter(Boolean);
    const contactMap = buildContactMap(_brandsFF);
    let actionItems = [], themes = [], summary = '', keyProblems = [], aiClient = '';

    if (process.env.ANTHROPIC_API_KEY && notes.trim()) {
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 2000,
          messages: [{ role: 'user', content: `Analyze this meeting transcript from Cult Content agency (TikTok Shop content/affiliate agency).\n\n${buildClientTaggingPrompt(_brandsFF)}\n\nMeeting: ${tx.title} (${dateStr})\nParticipants: ${(tx.participants||[]).join(', ')||'unknown'}\n\nTranscript:\n${notes.slice(0, 8000)}\n\nReturn JSON only:\n{"client":"brand name or Internal","summary":"","actionItems":[{"task":"","assignee":"","client":"brand name or Internal","priority":"high|medium|low","done":false}],"themes":[],"keyProblems":[]}` }]
        });
        const parsed = JSON.parse(msg.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
        actionItems = (parsed.actionItems || []).map(ai => ({ ...ai, client: normaliseClientName(ai.client, knownClients, contactMap) || ai.client || 'Internal' }));
        themes = parsed.themes || []; summary = parsed.summary || ''; keyProblems = parsed.keyProblems || [];
        aiClient = normaliseClientName(parsed.client, knownClients, contactMap) || parsed.client || '';
      } catch(e) { console.error('[ff-import] AI error:', e.message); }
    }

    const meeting = {
      id: `ff_${id}`, fireflyId: id, date: dateStr, client: aiClient,
      title: tx.title || 'Fireflies Meeting', participants: tx.participants || [],
      duration: null, notes, summary, actionItems, themes, keyProblems,
      source: 'fireflies', createdAt: new Date().toISOString()
    };
    data.meetings.unshift(meeting);
    saveClientMeetings(data);
    console.log(`[ff-import] imported: ${tx.title} (${dateStr}) → client: ${aiClient}`);
    res.json({ ok: true, meeting });
  } catch(e) {
    console.error('[ff-import]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/meetings/sync-fireflies — pull recent Fireflies transcripts into Meeting Intel
app.post('/api/meetings/sync-fireflies', requireAuth, async (req, res) => {
  try {
    const keys = [process.env.FIREFLIES_API_KEY, process.env.FIREFLIES_API_KEY_2].filter(Boolean);
    if (!keys.length) return res.status(400).json({ ok: false, error: 'FIREFLIES_API_KEY not set' });

    const days  = req.body?.days || 365; // default 365 days
    const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    // Fetch meeting list from all Fireflies accounts
    const listQuery = `query { transcripts(limit: 100, fromDate: "${since}") { id title date participants summary { short_summary action_items } } }`;
    const allMeetings = [];
    const seen = new Set();
    const ffErrors = [];
    for (const key of keys) {
      try {
        const r = await axios.post('https://api.fireflies.ai/graphql',
          { query: listQuery },
          { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }
        );
        if (r.data?.errors) ffErrors.push(...r.data.errors.map(e => e.message));
        for (const t of (r.data?.data?.transcripts || [])) {
          if (!seen.has(t.id)) { seen.add(t.id); allMeetings.push({ ...t, _key: key }); }
        }
      } catch(e) {
        ffErrors.push(e.message);
        console.error('[ff-sync] list error:', e.message);
      }
    }

    console.log(`[ff-sync] found ${allMeetings.length} meetings since ${since}, errors: ${ffErrors.join(', ')||'none'}`);

    const data = loadClientMeetings();
    const existingIds = new Set(data.meetings.map(m => m.fireflyId || m.id));
    const _brandsFF = loadBrands();
    const knownClients = (_brandsFF.clients || []).map(c => c.name || c.id).filter(Boolean);
    const contactMap = buildContactMap(_brandsFF);

    let added = 0;
    for (const t of allMeetings) {
      if (existingIds.has(t.id)) continue;

      // Fetch full transcript sentences
      const txQuery = `query Transcript($id: String!) { transcript(id: $id) { id title date participants sentences { speaker_name text } } }`;
      let fullTranscript = '';
      try {
        const r = await axios.post('https://api.fireflies.ai/graphql',
          { query: txQuery, variables: { id: t.id } },
          { headers: { Authorization: `Bearer ${t._key}`, 'Content-Type': 'application/json' } }
        );
        const tx = r.data?.data?.transcript;
        fullTranscript = (tx?.sentences || []).map(s => `${s.speaker_name||'Unknown'}: ${s.text}`).join('\n');
      } catch(e) { /* use summary fallback */ }

      const notes = fullTranscript || `${t.summary?.short_summary || ''}\n\nAction items:\n${(t.summary?.action_items || []).join('\n')}`;
      if (!notes.trim()) continue;

      const dateStr = t.date ? new Date(t.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

      let actionItems = [], themes = [], summary = '', keyProblems = [], aiClient = '';
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
          const msg = await anthropic.messages.create({
            model: 'claude-sonnet-4-6', max_tokens: 2000,
            messages: [{
              role: 'user',
              content: `Analyze this meeting transcript from Cult Content agency (TikTok Shop content/affiliate agency).

${buildClientTaggingPrompt(_brandsFF)}

Meeting: ${t.title} (${dateStr})
Participants: ${(t.participants||[]).join(', ')||'unknown'}

Transcript:
${notes.slice(0, 8000)}

Return JSON only:
{"client":"brand name or Internal","summary":"","actionItems":[{"task":"","assignee":"","client":"brand name or Internal","priority":"high|medium|low","done":false}],"themes":[],"keyProblems":[]}`
            }]
          });
          const parsed = JSON.parse(msg.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
          actionItems = (parsed.actionItems || []).map(ai => ({ ...ai, client: normaliseClientName(ai.client, knownClients, contactMap) || ai.client || 'Internal' }));
          themes      = parsed.themes      || [];
          summary     = parsed.summary     || '';
          keyProblems = parsed.keyProblems || [];
          aiClient    = normaliseClientName(parsed.client, knownClients, contactMap) || parsed.client || '';
        } catch(aiErr) { console.error('[ff-sync] AI error:', aiErr.message); }
      }

      data.meetings.push({
        id:          `ff_${t.id}`,
        fireflyId:   t.id,
        date:        dateStr,
        client:      aiClient,
        title:       t.title || 'Google Meet',
        participants: t.participants || [],
        duration:    null,
        notes,
        summary,
        actionItems,
        themes,
        keyProblems,
        source:      'fireflies',
        createdAt:   new Date().toISOString()
      });
      existingIds.add(t.id);
      added++;
    }

    // Sort newest first
    data.meetings.sort((a,b) => new Date(b.date) - new Date(a.date));
    if (added) saveClientMeetings(data);
    console.log(`[ff-sync] synced ${added}/${allMeetings.length} new meetings from Fireflies`);
    res.json({ ok: true, added, total: allMeetings.length, sinceDays: days, sinceDate: since, errors: ffErrors.length ? ffErrors : undefined,
      meetings: allMeetings.map(t => ({ id: t.id, title: t.title, date: t.date, participants: t.participants })) });
  } catch(e) {
    console.error('[ff-sync]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Client Brand Management ──────────────────────────────────────────────────
const BRANDS_FILE = path.join(DATA_DIR, 'brands.json');
const MEETING_INTEL_FILE = path.join(DATA_DIR, 'meeting-intel.json');

function loadBrands() {
  try { return JSON.parse(fs.readFileSync(BRANDS_FILE, 'utf8')); }
  catch(_) { return { clients: [] }; }
}
function saveBrands(data) {
  fs.writeFileSync(BRANDS_FILE, JSON.stringify(data, null, 2));
}

function loadMeetingIntel() {
  try { return JSON.parse(fs.readFileSync(MEETING_INTEL_FILE, 'utf8')); }
  catch(_) { return { meetings: [] }; }
}
function saveMeetingIntel(data) {
  fs.writeFileSync(MEETING_INTEL_FILE, JSON.stringify(data, null, 2));
}
let _intelWriteLock = false;

// GET /api/brands — list all client brands
// Temporary debug endpoint
app.get('/api/debug/meeting-intel', requireAuth, (req, res) => {
  const brands = loadBrands();
  const meetings = loadClientMeetings();
  res.json({
    knownClients: (brands.clients || []).map(c => ({ id: c.id, name: c.name })),
    meetingCount: meetings.meetings.length,
    meetings: meetings.meetings.map(m => ({ id: m.id, title: m.title, client: m.client, source: m.source, actionClientTags: [...new Set((m.actionItems||[]).map(a=>a.client))] }))
  });
});

app.get('/api/brands', (req, res) => {
  res.json(loadBrands());
});

// Default team — pulled from Lark "Cult Content Comms Channel" members
const DEFAULT_TEAM = ['Tommy Lynch', 'Hasan', 'Gilbert Conte', 'Hillary'];

function getTeamMembers() {
  const stored = loadBrands().team || [];
  return stored.length ? stored : DEFAULT_TEAM;
}

// GET /api/brands/team — return team members list
app.get('/api/brands/team', requireAuth, (req, res) => {
  res.json({ team: getTeamMembers() });
});

// PUT /api/brands/team — overwrite team members list
app.put('/api/brands/team', requireAuth, (req, res) => {
  const { team } = req.body;
  if (!Array.isArray(team)) return res.status(400).json({ ok: false, error: 'team must be an array' });
  const data = loadBrands();
  data.team = team.filter(Boolean);
  saveBrands(data);
  res.json({ ok: true, team: data.team });
});

// POST /api/brands — create a new client brand
app.post('/api/brands', (req, res) => {
  const data = loadBrands();
  const brand = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    ...req.body,
  };
  data.clients.push(brand);
  saveBrands(data);
  res.json({ ok: true, brand });
});

// PUT /api/brands/:id — update a client brand
app.put('/api/brands/:id', (req, res) => {
  const data = loadBrands();
  const idx = data.clients.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.json({ ok: false, error: 'Brand not found' });
  data.clients[idx] = { ...data.clients[idx], ...req.body, id: req.params.id };
  saveBrands(data);
  res.json({ ok: true, brand: data.clients[idx] });
});

// DELETE /api/brands/:id — delete a client brand
app.delete('/api/brands/:id', (req, res) => {
  const data = loadBrands();
  data.clients = data.clients.filter(b => b.id !== req.params.id);
  saveBrands(data);
  res.json({ ok: true });
});

// ─── Video Production Pipeline ────────────────────────────────────────────────

// Brand profiles — mirrors PROD_BRANDS in the frontend
const PROD_BRANDS = {
  cultcontent: {
    name: 'Cult Content',
    audience: 'E-commerce brand owners and TikTok Shop sellers who want to grow through affiliate marketing',
    niche: 'TikTok Shop affiliate program management, e-commerce growth strategies, creator outreach and partnerships',
    voice: 'Professional but direct. Data-driven and tactical. B2B tone — speak to business owners, not consumers. Every piece of content should position Cult Content as the authority on TikTok Shop growth.',
    contentPillars: ['TikTok Shop setup & optimization', 'Affiliate recruitment & management', 'Creator partnership strategies', 'E-commerce brand growth', 'Case studies & results'],
    avoidTopics: ['Personal lifestyle content', 'Overly casual or meme-heavy formats', 'Anything consumer-facing rather than B2B'],
    cta: 'Follow for more TikTok Shop growth strategies / Link in bio for a free affiliate audit',
    tiktokHandles: ['cultcontent.cc'],
  },
  tommy: {
    name: 'Tommy Lynch Personal Brand',
    audience: 'Aspiring creators, young entrepreneurs, and people who want to build online income through content and e-commerce',
    niche: 'Entrepreneurship, building brands online, the creator economy, TikTok Shop from a founder perspective, personal growth through business',
    voice: 'Authentic, first-person, aspirational. Show the journey — wins AND struggles. Speak like a peer, not a guru. Relatable but ambitious. More casual than Cult Content.',
    contentPillars: ['Behind-the-scenes of building Cult Content', 'Lessons from running a TikTok agency', 'Creator economy insights', 'Personal entrepreneurship journey', 'Mindset and productivity'],
    avoidTopics: ['Overly polished or corporate content', 'Generic hustle-porn advice', 'Anything that feels fake or scripted'],
    cta: 'Follow for the journey / DM me if you want to build on TikTok',
    tiktokHandles: ['tommylynch_'],
  },
};

// Returns a compact brand context string for Claude prompts
// Works for both built-in brands (PROD_BRANDS) and client brands from brands.json
function getBrandContext(brandId) {
  // Check built-in brands first
  const builtin = PROD_BRANDS[brandId];
  if (builtin) {
    return `Brand: ${builtin.name}
Audience: ${builtin.audience}
Niche: ${builtin.niche}
Voice & tone: ${builtin.voice}
Content pillars: ${builtin.contentPillars.join(', ')}
Avoid: ${builtin.avoidTopics.join(', ')}
CTA style: ${builtin.cta}`;
  }
  // Check client brands from file
  const clients = loadBrands().clients;
  const client = clients.find(b => b.id === brandId);
  if (client) {
    const lines = [
      `Brand: ${client.name}`,
      client.industry        ? `Industry: ${client.industry}` : null,
      client.products        ? `Products/Services: ${client.products}` : null,
      client.audience        ? `Target audience: ${client.audience}` : null,
      client.niche           ? `Niche: ${client.niche}` : null,
      client.voice           ? `Voice & tone: ${client.voice}` : null,
      client.contentPillars  ? `Content pillars: ${client.contentPillars}` : null,
      client.proofPoints     ? `Real proof points they can use: ${client.proofPoints}` : null,
      client.avoidTopics     ? `Avoid: ${client.avoidTopics}` : null,
      client.cta             ? `CTA style: ${client.cta}` : null,
      client.extraContext    ? `Additional context: ${client.extraContext}` : null,
    ].filter(Boolean);
    return lines.join('\n');
  }
  return 'Brand: Unknown — generate content appropriate for a TikTok Shop seller.';
}

// POST /api/production/analyze
// Analyzes own or competitor videos and returns insights + hooks
app.post('/api/production/analyze', async (req, res) => {
  const { source = 'own', handle, days = 30, brand, compVideoPaste = '' } = req.body || {};
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const apifyToken = process.env.APIFY_API_KEY;
    let videoContext = '';
    let tiktokVideos = [];

    // ── Helper: fetch recent TikTok videos for a handle via Apify ──────────
    const fetchTikTokVideos = async (ttHandle, maxVideos = 20) => {
      if (!apifyToken) return [];
      const cleanHandle = ttHandle.replace(/^@/, '');
      const profileUrl = `https://www.tiktok.com/@${cleanHandle}`;
      try {
        const { data } = await axios.post(
          `https://api.apify.com/v2/acts/clockworks~tiktok-profile-scraper/run-sync-get-dataset-items?token=${apifyToken}&timeout=90&memory=512`,
          { profiles: [profileUrl], resultsType: 'videos', maxVideosPerQuery: maxVideos },
          { timeout: 120_000 }
        );
        // Filter out error entries
        const videos = (data || []).filter(v => !v.error);
        return videos.map(v => ({
          id:        v.id,
          caption:   v.text || '',
          views:     v.playCount || 0,
          likes:     v.diggCount || 0,
          comments:  v.commentCount || 0,
          shares:    v.shareCount || 0,
          bookmarks: v.collectCount || 0,
          created:   v.createTime ? new Date(v.createTime * 1000).toISOString().split('T')[0] : '',
          duration:  v.videoMeta?.duration || 0,
          url:       `https://www.tiktok.com/@${cleanHandle}/video/${v.id}`,
        }));
      } catch(e) {
        console.error('TikTok Apify video fetch error:', e.response?.data || e.message);
        return [];
      }
    };

    if (source === 'own') {
      // Resolve which TikTok handles to scrape based on the selected brand
      let handles = [];
      if (brand && PROD_BRANDS[brand]?.tiktokHandles) {
        // Built-in brand (cultcontent / tommy)
        handles = PROD_BRANDS[brand].tiktokHandles;
      } else if (brand) {
        // Client brand — use tiktokHandle from brands.json
        const clientBrand = loadBrands().clients.find(b => b.id === brand);
        if (clientBrand?.tiktokHandle) handles = [clientBrand.tiktokHandle];
      }
      // Fall back to env vars only if no brand-specific handles found
      if (!handles.length) {
        handles = [process.env.TIKTOK_HANDLE_PERSONAL, process.env.TIKTOK_HANDLE_BRAND].filter(Boolean);
      }

      // Fetch real TikTok video data for all handles in parallel
      const allResults = await Promise.all(handles.map(h => fetchTikTokVideos(h, 30)));
      tiktokVideos = allResults.flat();

      // Filter to the requested lookback window
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().split('T')[0];
      const recentVideos = tiktokVideos.filter(v => !v.created || v.created >= cutoff);
      const videosForAnalysis = recentVideos.length > 0 ? recentVideos : tiktokVideos;

      // Sort by views descending for Claude to see top performers first
      videosForAnalysis.sort((a, b) => b.views - a.views);

      if (videosForAnalysis.length > 0) {
        const topN = videosForAnalysis.slice(0, 20);
        const totalViews = topN.reduce((s, v) => s + v.views, 0);
        const avgViews = Math.round(totalViews / topN.length);
        const topVideo = topN[0];
        videoContext = `TikTok handles: @${handles.join(', @')}
Analysis window: last ${days} days
Total videos analysed: ${videosForAnalysis.length}
Average views per video: ${avgViews.toLocaleString()}
Top video: "${topVideo.caption.slice(0, 120)}" — ${topVideo.views.toLocaleString()} views, ${topVideo.likes.toLocaleString()} likes

Recent videos (sorted by views, top 20):
${topN.map((v, i) => `${i+1}. [${v.views.toLocaleString()} views | ${v.likes.toLocaleString()} likes | ${v.shares} shares | ${v.duration}s] "${v.caption.slice(0, 100)}"`).join('\n')}`;
      } else {
        videoContext = `TikTok handles: @${handles.join(', @')}. No video data returned from Apify. Generate strategic content ideas based on Cult Content's niche: helping e-commerce sellers build TikTok Shop brands and affiliate programs.`;
      }

      // Supplement with YouTube data
      try {
        const snap = loadSnaps();
        const ytSnaps = snap['youtube'] || {};
        const ytHandle = Object.keys(ytSnaps)[0];
        if (ytHandle) {
          const recent = (ytSnaps[ytHandle] || []).slice(-3);
          videoContext += `\n\nYouTube snapshots (last 3): ${JSON.stringify(recent)}`;
        }
      } catch(_) {}

    } else {
      // Competitor / inspiration mode
      const cleanHandle = (handle || '').replace(/^@/, '');
      let liveVideos = [];

      // Try Apify scrape (requires credits — will be empty if billing is needed)
      if (cleanHandle && apifyToken) {
        liveVideos = await fetchTikTokVideos(cleanHandle, 20);
      }

      if (liveVideos.length > 0) {
        // Live scraped data
        liveVideos.sort((a, b) => b.views - a.views);
        const avgViews = Math.round(liveVideos.reduce((s, v) => s + v.views, 0) / liveVideos.length);
        videoContext = `Competitor TikTok: @${cleanHandle} (live scraped data)
Total videos scraped: ${liveVideos.length}
Average views: ${avgViews.toLocaleString()}
Top video: "${liveVideos[0].caption.slice(0, 120)}" — ${liveVideos[0].views.toLocaleString()} views

Top 15 videos by views:
${liveVideos.slice(0, 15).map((v, i) => `${i+1}. [${v.views.toLocaleString()} views | ${v.likes.toLocaleString()} likes | ${v.duration}s] "${v.caption.slice(0, 100)}"`).join('\n')}`;
        tiktokVideos = liveVideos;

      } else if (compVideoPaste.trim()) {
        // Manual paste fallback — real captions the user copied from the competitor's profile
        const pastedCaptions = compVideoPaste.trim().split('\n').map(l => l.trim()).filter(Boolean);
        videoContext = `Competitor TikTok: @${cleanHandle || 'unknown'} (manually pasted captions — no live scrape)
The user copied these video captions directly from the competitor's TikTok profile:

${pastedCaptions.map((c, i) => `${i+1}. "${c}"`).join('\n')}

Analyse the patterns, hooks, topics, and formats visible in these captions. Infer what's working based on the language and framing used.`;

      } else {
        // No data at all — be honest, don't hallucinate
        videoContext = cleanHandle
          ? `Competitor TikTok handle: @${cleanHandle}. No live video data available (Apify credits needed) and no captions were pasted. Do NOT invent specific videos, stats, or results. Instead, provide general strategic recommendations for what typically works in this brand's niche.`
          : `No competitor handle or video data provided. Provide general strategic recommendations based on the brand profile.`;
      }
    }

    const brandContext = getBrandContext(brand);

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are a TikTok content strategist. Analyze the data below and identify what's actually working.

IMPORTANT: Only draw insights from real data provided. If the data source says "no live scrape" or "manually pasted", base insights strictly on what was given — do not invent engagement numbers, view counts, or claim specific videos performed well unless that data is explicitly in the input.

${brandContext}

Data:
${videoContext}

Return JSON only:
{
  "topFormats": ["format1", "format2", "format3"],
  "topHooks": ["hook1 — derived from real captions/patterns in the data", "hook2", "hook3", "hook4", "hook5"],
  "topTopics": ["topic1", "topic2", "topic3"],
  "insights": ["insight grounded in actual data provided", "insight 2", "insight 3"],
  "recommendation": "one specific, actionable sentence on what to make next — honest about what the data does and doesn't show"
}`
      }]
    });

    const text = msg.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    res.json({ ok: true, analysis, source, handle, videoCount: tiktokVideos.length });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /api/production/ideate
// Generates N video ideas from analysis results
app.post('/api/production/ideate', async (req, res) => {
  const { analysis, count = 3, context: userContext = '', brand } = req.body || {};
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const brandContext = getBrandContext(brand);

    const analysisBlock = analysis
      ? `Performance analysis:\n${JSON.stringify(analysis)}`
      : 'No performance analysis provided — generate ideas based purely on the brand profile below.';

    const contextBlock = userContext
      ? `\nAdditional direction from the creator:\n"${userContext}"\nPrioritise this direction above all else when choosing topics and angles.`
      : '';

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a TikTok content strategist. Generate exactly ${count} video ideas for this brand. Every idea must fit the brand's voice, target audience, and content pillars.

${brandContext}

${analysisBlock}${contextBlock}

Return JSON only — an array of exactly ${count} ideas:
[
  {
    "title": "short video title written in brand voice",
    "hook": "exact first 3 seconds hook script in brand voice — no fabricated stats or results; use [X] as a placeholder if a number is needed",
    "concept": "1 sentence concept",
    "format": "e.g. Tutorial / Story / Listicle / POV / Day-in-life",
    "whyItWorks": "1 sentence reason it fits this brand and audience"
  }
]`
      }]
    });

    const text = msg.content[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const ideas = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    res.json({ ok: true, ideas: ideas.slice(0, count) });
  } catch(e) {
    res.json({ ok: false, error: e.message, ideas: [] });
  }
});

// POST /api/production/scripts
// Generates full scripts for an array of ideas
app.post('/api/production/scripts', async (req, res) => {
  const { ideas = [], brand } = req.body || {};
  if (!ideas.length) return res.json({ ok: false, error: 'No ideas provided', scripts: [] });

  const brandContext = getBrandContext(brand);

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const scripts = [];

    for (const idea of ideas) {
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Write a TikTok script (under 60 seconds) for this video idea. Every word must sound natural and match the brand voice — not corporate, not generic.

${brandContext}

Idea:
Title: ${idea.title}
Hook: ${idea.hook}
Concept: ${idea.concept}
Format: ${idea.format}

CRITICAL RULES — never break these:
- Never invent statistics, numbers, or results the creator hasn't verified (no "I helped 50 sellers", "audited 100 accounts", "$10k in 30 days" unless it's a known real fact)
- Never make claims the creator can't personally back up
- If the hook uses a number or result, use a placeholder like [X] so the creator can fill in their real figure
- Keep it honest and specific to what the creator actually knows and does

Return JSON only:
{
  "title": "${idea.title}",
  "hook": "exact hook words (3-5 sec) — written in brand voice, no fabricated stats",
  "intro": "intro beat (5-8 sec) — sets up the payoff",
  "body": ["beat 1 — specific point + what to say/show", "beat 2", "beat 3"],
  "cta": "call to action in brand voice (3-5 sec)",
  "totalDuration": "estimated seconds as a number",
  "bRollNotes": "brief practical filming notes"
}`
        }]
      });

      const text = msg.content[0]?.text || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const script = jsonMatch ? JSON.parse(jsonMatch[0]) : { title: idea.title, error: 'Parse failed' };
      scripts.push({ ...script, idea });
    }

    res.json({ ok: true, scripts });
  } catch(e) {
    res.json({ ok: false, error: e.message, scripts: [] });
  }
});

// POST /api/whisper-transcribe
// Transcribes voice memo using OpenAI Whisper REST API
// Expects multipart/form-data with field "audio"
app.post('/api/whisper-transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, error: 'No audio file provided', text: '' });

  // Whisper rejects files > 25 MB — bail early rather than hanging
  if (req.file.size > 25 * 1024 * 1024) {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
    return res.json({ ok: false, error: `File too large for Whisper (${(req.file.size / 1024 / 1024).toFixed(0)} MB — limit is 25 MB)`, text: '' });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
    return res.json({ ok: false, error: 'OPENAI_API_KEY not set in .env — add it to enable Whisper fallback', text: '' });
  }

  try {
    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('file', fs.createReadStream(req.file.path), {
      filename: req.file.originalname || 'recording.webm',
      contentType: req.file.mimetype || 'audio/webm'
    });
    fd.append('model', 'whisper-1');

    const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', fd, {
      headers: { ...fd.getHeaders(), Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 90000, // 90 s — Whisper can be slow on long audio
    });

    res.json({ ok: true, text: whisperRes.data.text || '' });
  } catch(e) {
    res.json({ ok: false, error: e.response?.data?.error?.message || e.message, text: '' });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
  }
});

// POST /api/transcribe-uploaded
// Transcribes a video that's already on disk — extracts audio with ffmpeg first,
// so even 500 MB videos work (audio-only is typically < 5 MB after compression).
// Body: { filename: "1234567890_video.mp4" }
app.post('/api/transcribe-uploaded', express.json(), async (req, res) => {
  const { filename } = req.body || {};
  if (!filename || /[/\\]/.test(filename)) {
    return res.json({ ok: false, error: 'Invalid filename', text: '' });
  }

  const videoPath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(videoPath)) {
    return res.json({ ok: false, error: 'File not found on server', text: '' });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return res.json({ ok: false, error: 'OPENAI_API_KEY not configured', text: '' });
  }

  // Extract audio to a small mp3 — mono 64k is plenty for speech recognition
  const audioPath = videoPath.replace(/\.[^.]+$/, '') + '_audio.mp3';

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioChannels(1)
        .audioBitrate('64k')
        .format('mp3')
        .on('error', reject)
        .on('end', resolve)
        .save(audioPath);
    });

    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    fd.append('model', 'whisper-1');

    const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', fd, {
      headers: { ...fd.getHeaders(), Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 120000,
    });

    res.json({ ok: true, text: whisperRes.data.text || '' });
  } catch (e) {
    res.json({ ok: false, error: e.response?.data?.error?.message || e.message, text: '' });
  } finally {
    try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch(_) {}
  }
});

// POST /api/production/rewrite-scripts
// Rewrites existing scripts based on user feedback
// Body: { scripts: [...], feedback: string, brand: string }
app.post('/api/production/rewrite-scripts', async (req, res) => {
  const { scripts = [], feedback, brand } = req.body || {};
  if (!scripts.length) return res.json({ ok: false, error: 'No scripts provided', scripts: [] });
  if (!feedback?.trim()) return res.json({ ok: false, error: 'No feedback provided', scripts: [] });

  const brandContext = getBrandContext(brand);

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const rewritten = [];

    for (const script of scripts) {
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Rewrite the following TikTok script based on the feedback below. Keep the same general concept and structure — just apply the requested changes. Every word must still sound natural and match the brand voice.

${brandContext}

FEEDBACK FROM CREATOR:
${feedback}

CURRENT SCRIPT:
Title: ${script.title}
Hook: ${script.hook}
Intro: ${script.intro}
Body: ${(script.body || []).join(' | ')}
CTA: ${script.cta}
Filming notes: ${script.bRollNotes || 'none'}

CRITICAL RULES — never break these:
- Never invent statistics, numbers, or results the creator hasn't verified
- If a number is needed, use a placeholder like [X] so the creator can fill in their real figure
- Keep it honest, specific, and grounded in what the creator actually knows and does
- Apply the feedback faithfully — don't ignore or minimise what they asked for

Return JSON only (same structure as the original):
{
  "title": "string",
  "hook": "string",
  "intro": "string",
  "body": ["beat 1", "beat 2", "beat 3"],
  "cta": "string",
  "totalDuration": number,
  "bRollNotes": "string"
}`
        }]
      });

      const text = msg.content[0]?.text || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const rewrittenScript = jsonMatch ? JSON.parse(jsonMatch[0]) : { ...script, error: 'Parse failed' };
      rewritten.push({ ...rewrittenScript, idea: script.idea });
    }

    res.json({ ok: true, scripts: rewritten });
  } catch(e) {
    res.json({ ok: false, error: e.message, scripts: [] });
  }
});

// POST /api/production/calendar/push
// Pushes a batch of video entries to Lark Bitable content calendar
// Body: { entries: [{ title, script, hook, platform, publishDate, status, videoUrl? }] }
app.post('/api/production/calendar/push', async (req, res) => {
  const { entries = [], appToken, tableId } = req.body || {};
  if (!entries.length) return res.json({ ok: false, error: 'No entries to push' });

  const LARK_APP_ID     = process.env.LARK_APP_ID;
  const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    return res.json({ ok: false, error: 'LARK_APP_ID and LARK_APP_SECRET not set in .env' });
  }

  try {
    // Get tenant access token
    const { data: authData } = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET
    });
    const token = authData.tenant_access_token;
    if (!token) throw new Error('Failed to get Lark access token');

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const results = [];

    for (const entry of entries) {
      const { data: recData } = await axios.post(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        {
          fields: {
            'Title':        entry.title || '',
            'Hook':         entry.hook || '',
            'Script':       entry.scriptText || '',
            'Platform':     entry.platform || 'TikTok',
            'Publish Date': entry.publishDate ? new Date(entry.publishDate).getTime() : undefined,
            'Status':       entry.status || 'Scripted',
            'Video URL':    entry.videoUrl || '',
            'Notes':        entry.notes || '',
          }
        },
        { headers }
      );
      results.push({ title: entry.title, record_id: recData.data?.record?.record_id });
    }

    res.json({ ok: true, pushed: results.length, results });
  } catch(e) {
    console.error('Lark calendar push error:', e.response?.data || e.message);
    res.json({ ok: false, error: e.response?.data?.msg || e.message });
  }
});

// ─── TikTok OAuth + Display API + Content Posting API ─────────────────────────
// Required .env: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
// Tokens persisted in .tiktok-tokens.json (expire after 24h, refreshable)

// GET /api/tiktok/auth?account=personal|brand
// Redirects user to TikTok's OAuth page to authorize the app
app.get('/api/tiktok/auth', (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return res.status(400).send('<h2>Add TIKTOK_CLIENT_KEY to .env and restart the server.</h2>');

  const account = req.query.account === 'brand' ? 'brand' : 'personal';
  const state   = crypto.randomBytes(16).toString('hex');
  tiktokAuthState.set(state, { account, ts: Date.now() });
  // Clean stale states
  for (const [k, v] of tiktokAuthState) { if (Date.now() - v.ts > 600_000) tiktokAuthState.delete(k); }

  const redirectUri = `http://localhost:${CFG.port}/api/tiktok/callback`;
  const params = new URLSearchParams({
    client_key:    clientKey,
    scope:         'user.info.basic,user.info.stats,video.list,video.upload,video.publish',
    response_type: 'code',
    redirect_uri:  redirectUri,
    state,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

// GET /api/tiktok/callback — exchanges auth code for access token
app.get('/api/tiktok/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.send(`<h2>TikTok auth error: ${error}</h2><p>${error_description}</p>`);

  const stateData = tiktokAuthState.get(state);
  if (!stateData) return res.send('<h2>Invalid or expired state. Please try again.</h2>');
  tiktokAuthState.delete(state);

  const clientKey    = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri  = `http://localhost:${CFG.port}/api/tiktok/callback`;

  try {
    const { data: tok } = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (tok.error) throw new Error(tok.error_description || tok.error);

    const tokens = loadTikTokTokens();
    tokens[stateData.account] = {
      access_token:  tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at:    Date.now() + (tok.expires_in * 1000),
      open_id:       tok.open_id,
      scope:         tok.scope,
    };
    saveTikTokTokens(tokens);
    cache.delete('social'); // bust so Performance tab re-fetches with Display API

    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#12101a;color:#fff">
      <h2 style="color:#00f2ea">TikTok Connected!</h2>
      <p>Account: <strong>${stateData.account}</strong></p>
      <p style="color:#7a7268;margin-top:4px;font-size:13px">Open ID: ${tok.open_id}</p>
      <a href="http://localhost:${CFG.port}" style="display:inline-block;margin-top:28px;padding:12px 28px;background:#00f2ea;color:#12101a;border-radius:8px;text-decoration:none;font-weight:700">← Back to Dashboard</a>
    </body></html>`);
  } catch(e) {
    res.send(`<h2 style="color:red">Token exchange failed</h2><pre>${e.message}</pre>`);
  }
});

// GET /api/tiktok/disconnect?account=personal|brand
app.get('/api/tiktok/disconnect', (req, res) => {
  const account = req.query.account === 'brand' ? 'brand' : 'personal';
  const tokens  = loadTikTokTokens();
  delete tokens[account];
  saveTikTokTokens(tokens);
  cache.delete('social');
  res.json({ ok: true, account });
});

// GET /api/tiktok/status — connection state + expiry info
app.get('/api/tiktok/status', (req, res) => {
  const tokens = loadTikTokTokens();
  const summary = (key) => {
    const t = tokens[key];
    if (!t) return { connected: false };
    return { connected: Date.now() < t.expires_at - 60_000, open_id: t.open_id, expires_at: t.expires_at, scope: t.scope };
  };
  res.json({ configured: !!process.env.TIKTOK_CLIENT_KEY, personal: summary('personal'), brand: summary('brand') });
});

// GET /api/tiktok/profile?account=personal|brand — Display API profile stats
app.get('/api/tiktok/profile', async (req, res) => {
  const account = req.query.account === 'brand' ? 'brand' : 'personal';
  const token   = getTikTokToken(account);
  if (!token) return res.json({ connected: false, error: `Not connected. Open /api/tiktok/auth?account=${account}` });

  try {
    const data = await cached(`tiktok_profile_${account}`, 300_000, async () => {
      const { data: r } = await axios.get(`${TIKTOK_API_BASE}/user/info/`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { fields: 'display_name,avatar_url,follower_count,following_count,likes_count,video_count,username' },
      });
      if (r.error?.code !== 'ok') throw new Error(r.error?.message || 'Display API error');
      const u = r.data.user;
      return { connected: true, account, username: u.username, display_name: u.display_name, avatar: u.avatar_url, followers: u.follower_count, following: u.following_count, likes: u.likes_count, videos: u.video_count };
    });
    res.json(data);
  } catch(e) { res.json({ connected: false, error: e.message }); }
});

// GET /api/tiktok/videos?account=personal|brand&max_count=20
app.get('/api/tiktok/videos', async (req, res) => {
  const account  = req.query.account === 'brand' ? 'brand' : 'personal';
  const maxCount = Math.min(parseInt(req.query.max_count) || 20, 20);
  const token    = getTikTokToken(account);
  if (!token) return res.json({ connected: false, videos: [] });

  try {
    const data = await cached(`tiktok_videos_${account}`, 300_000, async () => {
      const { data: r } = await axios.post(`${TIKTOK_API_BASE}/video/list/`,
        { max_count: maxCount },
        {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          params:  { fields: 'id,create_time,title,cover_image_url,share_url,like_count,comment_count,share_count,view_count,duration' },
        }
      );
      if (r.error?.code !== 'ok') throw new Error(r.error?.message || 'Display API error');
      return { connected: true, videos: r.data?.videos || [] };
    });
    res.json(data);
  } catch(e) { res.json({ connected: false, videos: [], error: e.message }); }
});

// POST /api/tiktok/post
// Body: { videoId, caption, account: 'personal'|'brand', isDraft?: boolean }
// Uploads a locally staged video to TikTok via Content Posting API
app.post('/api/tiktok/post', async (req, res) => {
  const { videoId, caption = '', account = 'personal', isDraft = false } = req.body || {};
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  const token = getTikTokToken(account);
  if (!token) return res.json({ ok: false, error: `TikTok not connected for ${account}. Visit /api/tiktok/auth?account=${account}` });

  const q     = loadQueue();
  const entry = q.find(v => v.id === videoId);
  if (!entry) return res.status(404).json({ error: 'Video not in queue' });

  if (!entry.localUrl) return res.status(400).json({ error: 'Only locally uploaded videos can be posted via TikTok API (no Arcads URL path).' });
  const videoPath = path.join(UPLOAD_DIR, path.basename(entry.localUrl));
  if (!fs.existsSync(videoPath)) return res.status(400).json({ error: `Video file not found on disk: ${videoPath}` });

  try {
    const fileSize = fs.statSync(videoPath).size;

    // 1. Init upload
    const { data: initResp } = await axios.post(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
      post_info: {
        title:          (caption || entry.title || 'New video').slice(0, 150),
        privacy_level:  isDraft ? 'SELF_ONLY' : 'PUBLIC_TO_EVERYONE',
        disable_duet:   false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source:            'FILE_UPLOAD',
        video_size:        fileSize,
        chunk_size:        fileSize,
        total_chunk_count: 1,
      },
    }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

    if (initResp.error?.code !== 'ok') throw new Error(initResp.error?.message || 'Init failed');
    const { publish_id, upload_url } = initResp.data;

    // 2. Upload file as single chunk
    const fileBuffer = fs.readFileSync(videoPath);
    await axios.put(upload_url, fileBuffer, {
      headers: {
        'Content-Type':  'video/mp4',
        'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
        'Content-Length': fileSize,
      },
      maxBodyLength:   Infinity,
      maxContentLength: Infinity,
    });

    res.json({ ok: true, publish_id, account, is_draft: isDraft });
  } catch(e) {
    console.error('TikTok post error:', e.response?.data || e.message);
    res.json({ ok: false, error: e.response?.data?.error?.message || e.message });
  }
});

// GET /api/tiktok/post/status/:publishId?account=personal|brand
app.get('/api/tiktok/post/status/:publishId', async (req, res) => {
  const { publishId } = req.params;
  const token = getTikTokToken(req.query.account || 'personal');
  if (!token) return res.json({ status: 'error', error: 'Not connected' });
  try {
    const { data: r } = await axios.post(`${TIKTOK_API_BASE}/post/publish/status/fetch/`,
      { publish_id: publishId },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ status: r.data?.status || 'unknown', data: r.data });
  } catch(e) { res.json({ status: 'error', error: e.message }); }
});

// ─── Weekly Report Generator ──────────────────────────────────────────────────
app.post('/api/reports/weekly', async (req, res) => {
  const { data, period, reportType = 'weekly' } = req.body;
  if (!data) return res.status(400).json({ ok: false, error: 'No data provided' });
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const periodLabel = period || (reportType === 'monthly' ? 'This Month' : 'This Week');
    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a TikTok Shop financial analyst. Analyse this raw Seller Center data and return a clean ${reportType} performance digest.

Calculate:
- Total GMV
- Total Orders
- Average Order Value (GMV ÷ Orders)
- Refund Rate % (Refunds ÷ Orders × 100)
- Top 3 products by GMV
- Week-over-week or period-over-period change if prior data is present
- One-line trend read
- One specific recommended action (not generic — be specific to the numbers)

Return EXACTLY this format:

📊 ${reportType === 'monthly' ? 'Monthly' : 'Weekly'} Numbers — ${periodLabel}

💰 GMV: $X,XXX
📦 Orders: XX
🧾 AOV: $XX.XX
↩️ Refund Rate: X.X%

🏆 Top Products:
1. [Product] — $X,XXX (XX orders)
2. [Product] — $X,XXX (XX orders)
3. [Product] — $X,XXX (XX orders)

📈 vs Last Period: GMV ▲/▼ X% | Orders ▲/▼ X% (omit if no prior data)

💡 Read: [one sentence trend read]
⚡ Action: [one specific action based on the numbers]

Raw data:
${data}`
      }]
    });
    const digest = msg.content[0].text;
    res.json({ ok: true, digest, period: periodLabel });
  } catch (e) {
    console.error('Weekly report error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/reports/send — send digest to Lark via Railway
app.post('/api/reports/send', async (req, res) => {
  const { digest, period } = req.body;
  if (!digest) return res.status(400).json({ ok: false, error: 'No digest provided' });
  try {
    const message = `📬 *Shop Performance Report — ${period || 'This Week'}*\n\n${digest}`;
    const { data } = await axios.post(
      `${CFG.railwayUrl}/command`,
      { text: message, source: 'Weekly Report' },
      { timeout: 10_000 }
    );
    res.json({ ok: true, sent: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Storista — TikTok Shop Video Publishing ──────────────────────────────────
const STORISTA_BASE = 'https://api-v2.storista.io';

function storistaClient() {
  return axios.create({
    baseURL: STORISTA_BASE,
    headers: {
      Authorization: `Bearer ${process.env.STORISTA_API_KEY || ''}`,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });
}

// GET /api/storista/accounts — list connected TikTok accounts
app.get('/api/storista/accounts', async (req, res) => {
  try {
    const { data } = await storistaClient().get('/v1/tiktok/accounts');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/storista/products/:account — list TikTok Shop products for an account
app.get('/api/storista/products/:account', async (req, res) => {
  try {
    const { data } = await storistaClient().get(`/v1/tiktok/accounts/${req.params.account}/products`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/storista/upload — upload a video file to Storista (pre-sign → S3 PUT → media create)
// Accepts multipart form: video file OR a localPath pointing to an already-uploaded file
app.post('/api/storista/upload', upload.single('video'), async (req, res) => {
  let filePath = null;
  let tempFile = false;

  try {
    if (req.file) {
      filePath = req.file.path;
      tempFile = true;
    } else if (req.body.localPath) {
      // Resolve from UPLOAD_DIR
      const resolved = path.resolve(UPLOAD_DIR, path.basename(req.body.localPath));
      if (!fs.existsSync(resolved)) return res.status(400).json({ error: 'File not found' });
      filePath = resolved;
    } else {
      return res.status(400).json({ error: 'Provide a video file or localPath' });
    }

    const stat = fs.statSync(filePath);
    const filename = req.body.filename || path.basename(filePath);
    const s = storistaClient();

    // 1. Pre-sign
    const { data: presign } = await s.post('/v1/media/pre-sign', {
      filename,
      content_type: 'video/mp4',
      size: stat.size,
    });

    // 2. Upload to S3
    const fileBuffer = fs.readFileSync(filePath);
    await axios.put(presign.upload_url, fileBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120_000,
    });

    // 3. Create media record
    const { data: media } = await s.post('/v1/media', {
      data: { upload_id: presign.upload_id, name: filename },
    });

    if (tempFile) fs.unlinkSync(filePath);

    res.json({ ok: true, media_id: media.id || media.upload_id || presign.upload_id, presign, media });
  } catch (e) {
    if (tempFile && filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('[storista] upload error:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/storista/publish — create + publish a TikTok Shop video
app.post('/api/storista/publish', async (req, res) => {
  const { account, video_id, product_id, product, product_link, caption } = req.body;
  if (!account || !video_id) return res.status(400).json({ error: 'account and video_id required' });

  try {
    const s = storistaClient();

    // 1. Create video record
    const { data: created } = await s.post(`/v1/tiktok/accounts/${account}/videos`, {
      video_id,
      product_id: product_id || '',
      product:    product    || '',
      product_link: product_link || '',
      caption:    caption    || '',
    });

    const vid_id = created.id || created.video_id;

    // 2. Publish it
    await s.post(`/v1/tiktok/accounts/${account}/videos/${vid_id}/publish`);

    res.json({ ok: true, video_id: vid_id, account });
  } catch (e) {
    console.error('[storista] publish error:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/storista/status/:account/:videoId — poll publish status
app.get('/api/storista/status/:account/:videoId', async (req, res) => {
  try {
    const { data } = await storistaClient().get(
      `/v1/tiktok/accounts/${req.params.account}/videos/${req.params.videoId}`
    );
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ─── Inventory Forecast Agent ─────────────────────────────────────────────────
// POST /api/inventory/forecast
// Runs all 6 stages via Claude and returns structured stage results.
app.post('/api/inventory/forecast', async (req, res) => {
  const { sellerData, creatorData, config = {} } = req.body;
  if (!sellerData) return res.status(400).json({ ok: false, error: 'sellerData is required' });

  const {
    leadTimeDays   = 90,
    minMarginPct   = 40,
    fbtSplitPct    = 60,
    spikeGrowthPct = 100,
    decayDropPct   = 40,
  } = config;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are an expert TikTok Shop inventory forecasting analyst. Analyse the data below and run all 6 stages of the forecasting framework. Return ONLY valid JSON — no markdown fences, no commentary outside the JSON.

CONFIG:
- Ocean freight lead time: ${leadTimeDays} days
- Min margin % for air freight bridge: ${minMarginPct}%
- FBT allocation: ${fbtSplitPct}% of each PO to FBT, ${100 - fbtSplitPct}% to own 3PL
- Spike flag trigger: daily sales growth ≥${spikeGrowthPct}% over 2 consecutive days OR creator video >100K views in <6h OR sample requests spike >50% above 14-day avg OR add-to-cart growing faster than orders
- Decay flag trigger: sales drop ≥${decayDropPct}% from peak with no recovery in 3 days OR affiliate post rate <50% of peak weekly videos

SELLER CENTER DATA:
${sellerData}

CREATOR / AFFILIATE SIGNALS (may be empty):
${creatorData || '(none provided — skip creator signal analysis, note this in Stage 2)'}

Return this exact JSON structure:
{
  "stages": [
    {
      "number": 1,
      "title": "Catalog Snapshot",
      "summary": "one-line summary of what was found",
      "narrative": "2-4 sentences of key findings and observations",
      "alert_count": 0,
      "gate": false,
      "skus": [
        { "SKU": "id", "Name": "name", "Group": "A/B/C", "On Hand": 0, "In Transit": 0, "Days Supply": 0, "Status": "OK/REORDER NOW/OVERSTOCK" }
      ]
    },
    {
      "number": 2,
      "title": "Signal Scan",
      "summary": "...",
      "narrative": "...",
      "alert_count": 0,
      "gate": false,
      "skus": [
        { "SKU": "id", "Name": "name", "Spike Probability": "HIGH/MED/LOW", "Signals": "description of what triggered it", "Sales Trend": "2-day change" }
      ]
    },
    {
      "number": 3,
      "title": "Spike Response Plan",
      "summary": "...",
      "narrative": "...",
      "alert_count": 0,
      "gate": true,
      "gate_number": 1,
      "skus": [
        { "SKU": "id", "Name": "name", "Current DoS": "X days", "DoS @ 3x": "X days", "DoS @ 5x": "X days", "Air Units": 0, "Air Est Cost": "$0", "Ocean Units": 0 }
      ],
      "decisions": [
        { "sku_id": "id", "sku_name": "name", "recommendation": "Place air bridge order of X units ($Y est) + ocean PO of Z units", "cost": "$X air + $Y ocean" }
      ]
    },
    {
      "number": 4,
      "title": "Decay Detection",
      "summary": "...",
      "narrative": "...",
      "alert_count": 0,
      "gate": true,
      "gate_number": 2,
      "skus": [
        { "SKU": "id", "Name": "name", "Peak Sales/Day": 0, "Current Sales/Day": 0, "Drop %": "0%", "Overstock Risk": "X units arriving in Y days", "Action": "Cancel PO / Reduce / Hold" }
      ],
      "decisions": [
        { "sku_id": "id", "sku_name": "name", "recommendation": "Cancel/reduce incoming PO of X units. Draft supplier comms attached.", "cost": null }
      ]
    },
    {
      "number": 5,
      "title": "Tail Reorder",
      "summary": "...",
      "narrative": "...",
      "alert_count": 0,
      "gate": false,
      "skus": [
        { "SKU": "id", "Name": "name", "Group": "B", "Avg Daily Demand": 0, "Safety Stock": 0, "Reorder Point": 0, "Reorder Qty": 0, "FBT Units": 0, "3PL Units": 0, "Flag": "Auto-reorder / Review trend / Skip" }
      ]
    },
    {
      "number": 6,
      "title": "Accuracy Check",
      "summary": "...",
      "narrative": "If this is the first run, note that there is no historical forecast data to compare against yet. Recommend thresholds to watch for the next review.",
      "alert_count": 0,
      "gate": true,
      "gate_number": 3,
      "skus": [],
      "decisions": [
        { "sku_id": "threshold_tuning", "sku_name": "Threshold Calibration", "recommendation": "Review spike and decay thresholds based on actuals at next monthly gate. Current settings: spike=${spikeGrowthPct}% growth, decay=${decayDropPct}% drop.", "cost": null }
      ]
    }
  ]
}

Be precise with numbers. If a field cannot be calculated from the data, use null or a short note. Do not fabricate sales figures — work only from the data provided.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    let raw = msg.content[0].text.trim();
    // Strip markdown fences if model added them
    raw = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

    const parsed = JSON.parse(raw);
    res.json({ ok: true, ...parsed });
  } catch (e) {
    console.error('[inventory] forecast error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════��═══════════════════════════════════════════
// ─── TikTok Shop Partner API ───────────────────────────────────────────────────
// Portal: https://partner.tiktokshop.com
// Base:   https://open-api.tiktokglobalshop.com
// Auth:   OAuth 2.0 + HMAC-SHA256 request signing on every call
// Tokens: .tiktok-tokens.json key "shop"
// ═══════════════════════════════════════════════════════════════════════════════

const TTS_BASE = 'https://open-api.tiktokglobalshop.com';

// ── Signature algorithm ────────────────────────────────────────────────────────
// 1. Collect all query params (exclude "sign" and "access_token")
// 2. Sort by key name alphabetically
// 3. Build base string: {app_secret}{api_path}{key1}{val1}{key2}{val2}...{body}
// 4. HMAC-SHA256(app_secret, base_string) → lowercase hex
function signTTShop(apiPath, params, body = '') {
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET || '';
  const sorted = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'access_token')
    .sort();
  const paramStr = sorted.map(k => `${k}${params[k]}`).join('');
  const bodyStr  = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
  const base     = `${appSecret}${apiPath}${paramStr}${bodyStr}${appSecret}`;
  console.log(`[tts-sign] path=${apiPath} keys=[${sorted.join(',')}] base=${base.slice(0, 120)}...`);
  return crypto.createHmac('sha256', appSecret).update(base).digest('hex');
}

// ── Build common query params + sign ──────────────────────────────────────────
function ttsParams(extra = {}, withShopCipher = true) {
  const tokens  = loadTikTokTokens();
  const shopTok = tokens.shop || {};
  const params  = {
    app_key:   process.env.TIKTOK_SHOP_APP_KEY || '',
    timestamp: Math.floor(Date.now() / 1000),
    ...extra,
  };
  if (withShopCipher && shopTok.shop_cipher) {
    params.shop_cipher = shopTok.shop_cipher;
  }
  return params;
}

// ── Signed request helper ──────────────────────────────────────────────────────
async function ttsRequest(method, apiPath, params = {}, body = null, opts = {}) {
  const tokens  = loadTikTokTokens();
  const shopTok = tokens.shop || {};

  const allParams = ttsParams(params, opts.withShopCipher !== false);
  allParams.sign  = signTTShop(apiPath, allParams, body);

  const config = {
    method,
    url: `${TTS_BASE}${apiPath}`,
    params: allParams,
    headers: {
      'content-type': 'application/json',
      'x-tts-access-token': shopTok.access_token || '',
    },
  };
  if (body) config.data = body;

  const { data } = await axios(config);
  return data;
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshShopToken() {
  const tokens  = loadTikTokTokens();
  const shopTok = tokens.shop || {};
  if (!shopTok.refresh_token) return false;

  try {
    const { data } = await axios.get('https://auth.tiktok-shops.com/api/v2/token/refresh', {
      params: {
        app_key:       process.env.TIKTOK_SHOP_APP_KEY,
        app_secret:    process.env.TIKTOK_SHOP_APP_SECRET,
        refresh_token: shopTok.refresh_token,
        grant_type:    'refresh_token',
      },
    });
    if (data?.code === 0 && data?.data?.access_token) {
      const expireVal = data.data.access_token_expire_in;
      // If expireVal looks like a seconds-epoch (> ~year 2000 in seconds), treat as absolute;
      // otherwise treat as a duration in seconds.
      const expiresAt = expireVal > 1_500_000_000
        ? expireVal * 1000
        : Date.now() + (expireVal || 86400) * 1000;
      tokens.shop = {
        ...shopTok,
        access_token:  data.data.access_token,
        refresh_token: data.data.refresh_token || shopTok.refresh_token,
        expires_at:    expiresAt,
      };
      saveTikTokTokens(tokens);
      return true;
    }
  } catch (e) {
    console.error('[tiktokshop] token refresh failed:', e.message);
  }
  return false;
}

// ── ttsGet / ttsPost helpers that auto-refresh expired tokens ───���─────────────
async function ttsGet(apiPath, params = {}, opts = {}) {
  const tokens = loadTikTokTokens();
  const t = tokens.shop || {};
  if (t.expires_at && Date.now() > t.expires_at - 120_000) {
    await refreshShopToken();
  }
  return ttsRequest('GET', apiPath, params, null, opts);
}
async function ttsPost(apiPath, body = {}, params = {}, opts = {}) {
  const tokens = loadTikTokTokens();
  const t = tokens.shop || {};
  if (t.expires_at && Date.now() > t.expires_at - 120_000) {
    await refreshShopToken();
  }
  return ttsRequest('POST', apiPath, params, body, opts);
}

// ── Per-brand TikTok Shop token helpers ──────────────────────────────────────
async function refreshBrandShopToken(brand, brands, brandIdx) {
  const t = brand.tiktokShopToken;
  if (!t?.refresh_token) return false;
  try {
    const { data } = await axios.get('https://auth.tiktok-shops.com/api/v2/token/refresh', {
      params: {
        app_key:       process.env.TIKTOK_SHOP_APP_KEY,
        app_secret:    process.env.TIKTOK_SHOP_APP_SECRET,
        refresh_token: t.refresh_token,
        grant_type:    'refresh_token',
      },
    });
    if (data?.code === 0 && data?.data?.access_token) {
      const expireVal = data.data.access_token_expire_in;
      const expiresAt = (() => {
      // TikTok access_token_expire_in is an ABSOLUTE Unix timestamp.
      // Distinguish ms-epoch (>1e12), seconds-epoch (1e9..1e12 -> *1000), or a raw duration in seconds (<1e9 -> now + dur*1000).
      const v = Number(expireVal) || 0;
      if (v > 1e12) return v;                       // already milliseconds
      if (v > 1e9)  return v * 1000;                // seconds-epoch -> ms
      return Date.now() + (v || 86400) * 1000;      // raw duration in seconds
    })();
      brand.tiktokShopToken = {
        ...t,
        access_token:  data.data.access_token,
        refresh_token: data.data.refresh_token || t.refresh_token,
        expires_at:    expiresAt,
      };
      brands.clients[brandIdx] = brand;
      saveBrands(brands);
      return true;
    }
  } catch (e) { console.error('[tiktokshop] brand token refresh failed:', e.message); }
  return false;
}

async function ttsBrandRequest(brandToken, method, apiPath, params = {}, body = null) {
  const allParams = {
    app_key:   process.env.TIKTOK_SHOP_APP_KEY || '',
    timestamp: Math.floor(Date.now() / 1000),
    ...params,
  };
  // Only include shop_cipher if it exists — single-shop sellers work without it
  if (brandToken.shop_cipher) allParams.shop_cipher = brandToken.shop_cipher;
  allParams.sign = signTTShop(apiPath, allParams, body);
  const config = {
    method,
    url: `${TTS_BASE}${apiPath}`,
    params: allParams,
    headers: { 'content-type': 'application/json', 'x-tts-access-token': brandToken.access_token },
  };
  if (body) config.data = body;
  const { data } = await axios(config);
  return data;
}

// Year 2030 in ms — any expires_at beyond this is likely corrupted
const TOKEN_EXPIRY_CEILING_MS = 1_893_456_000_000;

async function ttsBrandGet(brand, brands, brandIdx, apiPath, params = {}) {
  let t = brand.tiktokShopToken;
  if (!t?.access_token) throw new Error('No TikTok Shop token for brand');
  const expired = !t.expires_at || Date.now() > t.expires_at - 120_000;
  const corrupted = t.expires_at > TOKEN_EXPIRY_CEILING_MS;
  if (expired || corrupted) {
    await refreshBrandShopToken(brand, brands, brandIdx);
    t = brands.clients[brandIdx].tiktokShopToken;
  }
  return ttsBrandRequest(t, 'GET', apiPath, params);
}

async function ttsBrandPost(brand, brands, brandIdx, apiPath, body = {}, params = {}) {
  let t = brand.tiktokShopToken;
  if (!t?.access_token) throw new Error('No TikTok Shop token for brand');
  const expired = !t.expires_at || Date.now() > t.expires_at - 120_000;
  const corrupted = t.expires_at > TOKEN_EXPIRY_CEILING_MS;
  if (expired || corrupted) {
    await refreshBrandShopToken(brand, brands, brandIdx);
    t = brands.clients[brandIdx].tiktokShopToken;
  }
  return ttsBrandRequest(t, 'POST', apiPath, params, body);
}

// ────────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────────

// GET /api/tiktokshop/status — connection state + expiry
app.get('/api/tiktokshop/status', (req, res) => {
  const tokens  = loadTikTokTokens();
  const shopTok = tokens.shop || {};
  const connected = !!(shopTok.access_token && Date.now() < (shopTok.expires_at || 0));
  res.json({
    connected,
    shop_id:     shopTok.shop_id     || null,
    shop_name:   shopTok.shop_name   || null,
    shop_cipher: shopTok.shop_cipher || null,
    expires_at:  shopTok.expires_at  || null,
    app_key_set: !!(process.env.TIKTOK_SHOP_APP_KEY),
    auth_url:    `/api/tiktokshop/auth`,
  });
});

// GET /api/tiktokshop/auth — redirect to TikTok Shop OAuth
app.get('/api/tiktokshop/auth', (req, res) => {
  const appKey      = process.env.TIKTOK_SHOP_APP_KEY;
  const redirectUri = process.env.TIKTOK_SHOP_REDIRECT_URI ||
    `https://manifest.cultcontent.cc/api/tiktokshop/callback`;

  if (!appKey) {
    return res.status(500).json({ error: 'TIKTOK_SHOP_APP_KEY not set in .env' });
  }

  const state = req.query.brandId ? Buffer.from(JSON.stringify({ brandId: req.query.brandId })).toString('base64') : '';

  const authUrl = `https://auth.tiktok-shops.com/oauth/authorize?` +
    `app_key=${encodeURIComponent(appKey)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    (state ? `&state=${encodeURIComponent(state)}` : '');

  res.redirect(authUrl);
});

// GET /api/tiktokshop/callback — exchange auth_code for access_token
app.get('/api/tiktokshop/callback', async (req, res) => {
  const { code, auth_code, state } = req.query;
  const authCode = code || auth_code;
  if (!authCode) return res.status(400).send('Missing auth_code');

  // Decode brandId from state param (set by /client/tiktok/auth)
  let brandId = null;
  if (state) {
    try { brandId = JSON.parse(Buffer.from(state, 'base64').toString()).brandId; } catch (_) {}
  }

  const appKey    = process.env.TIKTOK_SHOP_APP_KEY;
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET;
  try {
    const { data } = await axios.get('https://auth.tiktok-shops.com/api/v2/token/get', {
      params: {
        app_key:    appKey,
        app_secret: appSecret,
        auth_code:  authCode,
        grant_type: 'authorized_code',
      },
    });

    if (data?.code !== 0 || !data?.data?.access_token) {
      return res.status(500).json({ error: 'Token exchange failed', raw: data });
    }

    const tokenData = {
      access_token:  data.data.access_token,
      refresh_token: data.data.refresh_token,
      expires_at:    Date.now() + (data.data.access_token_expire_in || 86400) * 1000,
      open_id:       data.data.open_id,
    };

    // Fetch shop cipher using the new token directly
    let shopName = 'Unknown';
    try {
      const _appKey2 = process.env.TIKTOK_SHOP_APP_KEY || '';
      const allParams = { app_key: _appKey2, timestamp: Math.floor(Date.now() / 1000) };
      allParams.sign = signTTShop('/authorization/202309/shops', allParams, '');
      const shopRes = await axios.get(`${TTS_BASE}/authorization/202309/shops`, {
        params: allParams,
        headers: { 'content-type': 'application/json', 'x-tts-access-token': tokenData.access_token },
      });
      const shop = shopRes.data?.data?.shops?.[0];
      if (shop) {
        tokenData.shop_cipher = shop.cipher;
        tokenData.shop_id     = shop.id;
        tokenData.shop_name   = shop.name;
        tokenData.shop_region = shop.region;
        shopName = shop.name;
      }
    } catch (e) {
      console.warn('[tiktokshop] shop cipher fetch failed:', e.message);
    }

    if (brandId) {
      // Save token to brand record
      const brands = loadBrands();
      const bi = brands.clients.findIndex(b => b.id === brandId);
      if (bi !== -1) {
        brands.clients[bi].tiktokShopToken = tokenData;
        saveBrands(brands);
      }
      return res.send(`
        <html><body style="font-family:sans-serif;padding:40px;background:#12101a;color:#e2e8f0">
          <h2 style="color:#00f2ea">✅ TikTok Shop connected!</h2>
          <p>Shop: <strong>${shopName}</strong></p>
          <p>Stats will now appear in your brand dashboard.</p>
          <p><a href="/client/dashboard" style="color:#00f2ea">← Back to your dashboard</a></p>
          <script>setTimeout(() => window.location.href = '/client/dashboard', 2000);</script>
        </body></html>
      `);
    }

    // Fallback: save to global tokens (internal dashboard use)
    const tokens = loadTikTokTokens();
    tokens.shop = tokenData;
    saveTikTokTokens(tokens);

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#eee">
        <h2>✅ TikTok Shop connected!</h2>
        <p>Shop: <strong>${shopName}</strong></p>
        <p>Token expires: ${new Date(tokenData.expires_at).toLocaleString()}</p>
        <p><a href="/" style="color:#00f2ea">← Back to dashboard</a></p>
      </body></html>
    `);
  } catch (e) {
    console.error('[tiktokshop] callback error:', e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/shops — list authorized shops
app.get('/api/tiktokshop/shops', async (req, res) => {
  try {
    const data = await cached('tts_shops', 3_600_000, () =>
      ttsGet('/authorization/202309/shops', {}, { withShopCipher: false })
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/orders?status=AWAITING_SHIPMENT&page_size=50 — search orders
app.get('/api/tiktokshop/orders', async (req, res) => {
  try {
    const {
      order_status = 'AWAITING_SHIPMENT',
      page_size    = 20,
      sort_field   = 'create_time',
      sort_order   = 'DESC',
      cursor,
    } = req.query;

    // page_size is a query param; filters go in body
    const body   = { order_status, sort_field, sort_order };
    const params = { page_size };
    if (cursor) params.cursor = cursor;

    const data = await ttsPost('/order/202309/orders/search', body, params);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/products?page_size=50&status=ACTIVATE — product catalog
app.get('/api/tiktokshop/products', async (req, res) => {
  try {
    const {
      status    = 'ACTIVATE',
      page_size = 20,
      page_token,
    } = req.query;

    const body = {
      status:     [status],
      page_size:  Number(page_size),
      page_token: page_token || undefined,
    };

    const data = await ttsPost('/product/202309/products/search', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/products/:product_id — single product detail
app.get('/api/tiktokshop/products/:product_id', async (req, res) => {
  try {
    const data = await ttsGet(`/product/202309/products/${req.params.product_id}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/finance/summary?start_date=2024-01-01&end_date=2024-12-31
app.get('/api/tiktokshop/finance/summary', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    // Convert dates to unix timestamps if provided
    const params = {};
    if (start_date) params.create_time_ge = Math.floor(new Date(start_date).getTime() / 1000);
    if (end_date)   params.create_time_lt = Math.floor(new Date(end_date).getTime() / 1000);

    const data = await ttsPost('/finance/202309/orders/search', params);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/affiliate/creators?page_size=50 — list affiliated creators + perf
app.get('/api/tiktokshop/affiliate/creators', async (req, res) => {
  try {
    const { page_size = 50, page_token, sort_field = 'gmv', sort_order = 'DESC' } = req.query;
    const body = {
      page_size:   Number(page_size),
      sort_field,
      sort_order,
    };
    if (page_token) body.page_token = page_token;

    const data = await ttsPost('/affiliate/seller/202309/creators/search', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/affiliate/products — products enrolled in affiliate program
app.get('/api/tiktokshop/affiliate/products', async (req, res) => {
  try {
    const { page_size = 50, page_token } = req.query;
    const body = { page_size: Number(page_size) };
    if (page_token) body.page_token = page_token;

    const data = await ttsPost('/affiliate/seller/202309/products/search', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/affiliate/samples — sample requests from creators
app.get('/api/tiktokshop/affiliate/samples', async (req, res) => {
  try {
    const { status = 'PENDING', page_size = 50 } = req.query;
    const data = await ttsPost('/affiliate/seller/202309/sample_requests/search', {
      status:    [status],
      page_size: Number(page_size),
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/affiliate/orders — orders placed through affiliate links
app.get('/api/tiktokshop/affiliate/orders', async (req, res) => {
  try {
    const { page_size = 50, page_token, start_date, end_date } = req.query;
    const body = { page_size: Number(page_size) };
    if (page_token) body.page_token = page_token;
    if (start_date) body.create_time_ge = Math.floor(new Date(start_date).getTime() / 1000);
    if (end_date)   body.create_time_lt = Math.floor(new Date(end_date).getTime() / 1000);

    const data = await ttsPost('/affiliate/seller/202309/orders/search', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/tiktokshop/affiliate/creators/invite — invite a creator by open_id
app.post('/api/tiktokshop/affiliate/creators/invite', async (req, res) => {
  try {
    const { creator_open_id, product_ids = [], commission_rate } = req.body;
    if (!creator_open_id) return res.status(400).json({ error: 'creator_open_id required' });

    const body = { creator_open_id };
    if (product_ids.length) body.product_ids = product_ids;
    if (commission_rate)    body.commission_rate = commission_rate;

    const data = await ttsPost('/affiliate/seller/202309/creators/invite', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// PATCH /api/tiktokshop/affiliate/samples/:request_id — approve or reject a sample request
app.patch('/api/tiktokshop/affiliate/samples/:request_id', async (req, res) => {
  try {
    const { action, rejection_reason } = req.body; // action: APPROVE | REJECT
    const body = { sample_request_ids: [req.params.request_id], action };
    if (rejection_reason) body.rejection_reason = rejection_reason;

    const data = await ttsPost('/affiliate/seller/202309/sample_requests/batch_update', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/categories — product category tree
app.get('/api/tiktokshop/categories', async (req, res) => {
  try {
    const data = await cached('tts_categories', 86_400_000, () =>
      ttsGet('/product/202309/categories', { category_version: 'v2' })
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/webhooks — list registered webhooks
app.get('/api/tiktokshop/webhooks', async (req, res) => {
  try {
    const data = await ttsGet('/event/202309/webhooks');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// PUT /api/tiktokshop/webhooks — register / update a webhook URL for an event type
app.put('/api/tiktokshop/webhooks', async (req, res) => {
  try {
    const { event_type, address } = req.body;
    // Default webhook address points to Railway server
    const webhookUrl = address ||
      `https://cultcontent-server-production.up.railway.app/api/tiktok-shop/webhook`;
    const data = await ttsRequest('PUT', '/event/202309/webhooks', ttsParams(),
      { event_type, address: webhookUrl }
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/tiktokshop/webhook — receive inbound TikTok Shop webhook events
// This mirrors the Railway server endpoint; having it here too helps local dev
app.post('/api/tiktokshop/webhook', express.raw({ type: '*/*' }), (req, res) => {
  try {
    const sig     = req.headers['x-tiktok-signature'] || '';
    const payload = req.body?.toString() || '';

    // Optional HMAC verification
    if (process.env.TIKTOK_SHOP_APP_SECRET && sig) {
      const expected = crypto
        .createHmac('sha256', process.env.TIKTOK_SHOP_APP_SECRET)
        .update(payload)
        .digest('hex');
      if (sig !== expected) {
        console.warn('[tiktokshop webhook] signature mismatch');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    let event;
    try { event = JSON.parse(payload); } catch { event = { raw: payload }; }
    console.log('[tiktokshop webhook]', event.type || 'unknown', JSON.stringify(event).slice(0, 200));

    // Invalidate relevant caches on key events
    if (event.type === 'ORDER_STATUS_CHANGE') cache.delete('tts_orders');
    if (event.type?.startsWith('PRODUCT_'))    cache.delete('tts_products');

    res.json({ ok: true });
  } catch (e) {
    console.error('[tiktokshop webhook] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tiktokshop/brand-promotions?brandId=X&status=ONGOING ────────────
// Uses the new TikTok Shop "Activity" API (Create Activity endpoint family)
// activity_status values: UPCOMING, ONGOING, ENDED
app.get('/api/tiktokshop/brand-promotions', requireAuth, async (req, res) => {
  const { brandId, status = 'ONGOING' } = req.query;
  const brands = loadBrands();
  const brandIdx = (brands.clients || []).findIndex(b => b.id === brandId);
  if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[brandIdx];
  if (!brand.tiktokShopToken?.access_token) return res.status(400).json({ error: 'Brand not connected to TikTok Shop' });
  try {
    const resp = await ttsBrandPost(brand, brands, brandIdx, '/promotion/202309/activities/search', {
      page_size: 100,
    });
    console.log('[promotions] list raw response:', JSON.stringify(resp?.data).slice(0, 500));
    const allItems = resp?.data?.activities || resp?.data?.promotions || [];
    const now = Math.floor(Date.now() / 1000);
    // Filter by timestamps since TikTok may not support status filter in body
    const filtered = allItems.filter(a => {
      const begin = a.begin_time || a.start_time || 0;
      const end   = a.end_time   || a.finish_time || 0;
      if (status === 'UPCOMING') return begin > now;
      if (status === 'ONGOING')  return begin <= now && end >= now;
      if (status === 'ENDED')    return end < now;
      return true;
    });
    res.json({ ok: true, promotions: filtered, total: filtered.length });
  } catch (e) {
    console.error('[promotions] list error:', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: e.response?.data?.message || e.message });
  }
});

// ── POST /api/tiktokshop/brand-promotions ────────────────────────────────────
// activity_type: PRODUCT_DISCOUNT or FLASH_DEAL
app.post('/api/tiktokshop/brand-promotions', requireAuth, express.json(), async (req, res) => {
  const { brandId, title, promotionType, beginTime, endTime, productList } = req.body || {};
  if (!brandId || !title || !beginTime || !endTime || !productList?.length)
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  const brands = loadBrands();
  const brandIdx = (brands.clients || []).findIndex(b => b.id === brandId);
  if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[brandIdx];
  if (!brand.tiktokShopToken?.access_token) return res.status(400).json({ error: 'Brand not connected to TikTok Shop' });
  try {
    // Map legacy type numbers to new activity_type strings
    const typeMap = { '3': 'FLASH_DEAL', '4': 'PRODUCT_DISCOUNT' };
    const activityType = typeMap[String(promotionType)] || 'PRODUCT_DISCOUNT';
    const body = {
      title,
      activity_type: activityType,
      begin_time: Math.floor(new Date(beginTime).getTime() / 1000),
      end_time:   Math.floor(new Date(endTime).getTime() / 1000),
      product_level: 'SKU',
      product_list: productList,
    };
    console.log('[promotions] create body:', JSON.stringify(body).slice(0, 300));
    const resp = await ttsBrandPost(brand, brands, brandIdx, '/promotion/202309/activities', body);
    console.log('[promotions] create response:', JSON.stringify(resp).slice(0, 300));
    if (resp?.code !== 0) throw new Error(resp?.message || `TikTok error code ${resp?.code}`);
    res.json({ ok: true, activity: resp?.data });
  } catch (e) {
    console.error('[promotions] create error:', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: e.response?.data?.message || e.message });
  }
});

// ── DELETE /api/tiktokshop/brand-promotions/:promoId?brandId=X ───────────────
app.delete('/api/tiktokshop/brand-promotions/:promoId', requireAuth, async (req, res) => {
  const { brandId } = req.query;
  const { promoId } = req.params;
  const brands = loadBrands();
  const brandIdx = (brands.clients || []).findIndex(b => b.id === brandId);
  if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[brandIdx];
  if (!brand.tiktokShopToken?.access_token) return res.status(400).json({ error: 'Brand not connected to TikTok Shop' });
  try {
    const t = brand.tiktokShopToken;
    const resp = await ttsBrandRequest(t, 'DELETE', `/promotion/202309/activities/${promoId}`, {});
    console.log('[promotions] delete response:', JSON.stringify(resp).slice(0, 200));
    res.json({ ok: true, data: resp?.data });
  } catch (e) {
    console.error('[promotions] delete error:', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: e.response?.data?.message || e.message });
  }
});

// ── GET /api/tiktokshop/brand-products?brandId=X ────────────────────────────
// Used by promotion form product picker
app.get('/api/tiktokshop/brand-products', requireAuth, async (req, res) => {
  const { brandId } = req.query;
  const brands = loadBrands();
  const brandIdx = (brands.clients || []).findIndex(b => b.id === brandId);
  if (brandIdx === -1) return res.status(404).json({ error: 'Brand not found' });
  const brand = brands.clients[brandIdx];
  if (!brand.tiktokShopToken?.access_token) return res.status(400).json({ error: 'Brand not connected to TikTok Shop' });
  try {
    const resp = await ttsBrandPost(brand, brands, brandIdx, '/product/202309/products/search', { page_size: 50 });
    const products = (resp?.data?.products || []).map(p => ({
      product_id: p.product_id,
      title: p.title,
      skus: (p.skus || []).map(s => ({
        sku_id: s.id || s.sku_id,
        name: (s.sales_attributes || []).map(a => a.value_name).filter(Boolean).join(' / ') || 'Default',
        price: s.price?.original_price || s.price?.sale_price || '0',
      })),
    }));
    res.json({ ok: true, products });
  } catch (e) {
    console.error('[brand-products] error:', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: e.response?.data?.message || e.message });
  }
});

// ─── Video — Cross-platform stats ─────────────────────────────────────────────
app.get('/api/video/cross-platform-stats', async (req, res) => {
  const force = req.query.force === '1';
  if (force) cache.delete('video_cross_platform_stats');
  try {
    const data = await cached('video_cross_platform_stats', 600_000, async () => {
      const videos = [];

      // 1. TikTok Display API — personal + brand
      for (const account of ['personal', 'brand']) {
        const token = getTikTokToken(account);
        if (!token) continue;
        try {
          const { data: r } = await axios.post(`${TIKTOK_API_BASE}/video/list/`,
            { max_count: 20 },
            {
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              params:  { fields: 'id,create_time,title,cover_image_url,share_url,like_count,comment_count,share_count,view_count,duration' },
            }
          );
          if (r.error?.code === 'ok') {
            for (const v of (r.data?.videos || [])) {
              videos.push({
                id:           `tiktok_${v.id}`,
                platform:     'tiktok',
                channelName:  account === 'brand' ? 'TikTok Brand' : 'TikTok Personal',
                title:        v.title || '',
                views:        v.view_count    || 0,
                likes:        v.like_count    || 0,
                comments:     v.comment_count || 0,
                shares:       v.share_count   || 0,
                engagements:  (v.like_count || 0) + (v.comment_count || 0) + (v.share_count || 0),
                date:         v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
                thumbnailUrl: v.cover_image_url || null,
                videoUrl:     v.share_url || null,
              });
            }
          }
        } catch(e) { console.warn(`[cross-platform-stats] TikTok ${account}:`, e.message); }
      }

      // 2. Buffer published posts
      const bufferToken = process.env.BUFFER_ACCESS_TOKEN;
      if (bufferToken) {
        try {
          const gql = `{
            channels(first: 50) {
              edges {
                node {
                  id service name avatar
                  posts(first: 20, filter: { status: SENT }) {
                    edges {
                      node {
                        id text createdAt
                        statistics { impressions reach engagements clicks }
                      }
                    }
                  }
                }
              }
            }
          }`;
          const { data: bufResp } = await axios.post('https://api.bufferapp.com/graphql',
            { query: gql },
            { headers: { Authorization: `Bearer ${bufferToken}`, 'Content-Type': 'application/json' } }
          );
          const channels = bufResp?.data?.channels?.edges || [];
          for (const { node: ch } of channels) {
            for (const { node: post } of (ch.posts?.edges || [])) {
              const stats = post.statistics || {};
              videos.push({
                id:           `buffer_${post.id}`,
                platform:     (ch.service || 'social').toLowerCase(),
                channelName:  ch.name || ch.service || '',
                title:        (post.text || '').slice(0, 120),
                views:        stats.impressions  || 0,
                likes:        0,
                comments:     0,
                shares:       0,
                engagements:  stats.engagements  || 0,
                date:         post.createdAt || null,
                thumbnailUrl: null,
                videoUrl:     null,
              });
            }
          }
        } catch(e) { console.warn('[cross-platform-stats] Buffer:', e.message); }
      }

      // Sort by views descending
      videos.sort((a, b) => (b.views || 0) - (a.views || 0));
      return { videos };
    });

    res.json(data);
  } catch(e) {
    console.error('[cross-platform-stats]', e.message);
    res.json({ videos: [], error: e.message });
  }
});

// ─── Video — Generate caption ──────────���───────────────────────────────────────
app.post('/api/video/generate-caption', async (req, res) => {
  const { transcript, platform = 'tiktok', tone = 'casual' } = req.body || {};
  if (!transcript) return res.status(400).json({ ok: false, error: 'transcript required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const systemPrompt = `You are a social media expert. Given a video transcript, write an engaging caption optimised for ${platform}.
Return ONLY valid JSON: {"caption": "...", "hashtags": ["tag1", "tag2", ...]}
- caption: punchy, platform-native tone. TikTok/Instagram: conversational, hooks-first, max 150 chars. LinkedIn: professional, max 300 chars. YouTube: descriptive, includes keywords.
- hashtags: 5-8 relevant hashtags WITHOUT the # symbol
- tone: ${tone} (casual | professional | educational | humorous)`;

    const msg = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 512,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: `Transcript:\n${transcript}` }],
    });

    let raw = msg.content?.[0]?.text || '';
    // Strip markdown fences
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(raw);
    res.json({ ok: true, caption: parsed.caption || '', hashtags: parsed.hashtags || [] });
  } catch(e) {
    console.error('[generate-caption]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ─── Fireflies.ai — recent meeting list ���─────────────────────────────────────
app.get('/api/fireflies/meetings', async (req, res) => {
  const keys = [process.env.FIREFLIES_API_KEY, process.env.FIREFLIES_API_KEY_2].filter(Boolean);
  if (!keys.length) return res.json({ connected: false, error: 'FIREFLIES_API_KEY not set' });

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 30);
  const fromDateStr = fromDate.toISOString().split('T')[0];

  const query = `query {
    transcripts(limit: 50, fromDate: "${fromDateStr}") {
      id title date participants
      summary { short_summary action_items }
    }
  }`;

  const fetchFromKey = async (key) => {
    const r = await axios.post('https://api.fireflies.ai/graphql',
      { query },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }
    );
    if (r.data?.errors) console.error('[fireflies/meetings] GraphQL errors:', JSON.stringify(r.data.errors));
    return r.data?.data?.transcripts || [];
  };

  try {
    // Fetch live meetings from Fireflies API (7-day window)
    const results = await Promise.allSettled(keys.map(fetchFromKey));
    const seen = new Set();
    const allMeetings = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const t of result.value) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        allMeetings.push({ id: t.id, title: t.title || 'Untitled Meeting', date: t.date, participants: t.participants || [], summary: t.summary || {} });
      }
    }
    // Merge in locally-synced meetings from client-meetings.json (full history)
    const local = loadClientMeetings();
    for (const m of (local.meetings || [])) {
      const ffId = m.fireflyId || m.id?.replace(/^ff_/, '');
      if (!ffId || seen.has(ffId)) continue;
      seen.add(ffId);
      allMeetings.push({
        id:           ffId,
        title:        m.title || 'Untitled Meeting',
        date:         m.date ? new Date(m.date).getTime() : 0,
        participants: m.participants || [],
        summary:      m.summary ? { short_summary: m.summary } : {},
      });
    }
    // Merge in Meeting Intel records (webhook-delivered) — guarantees picker shows
    // meetings even when the Fireflies list API fails to index them
    try {
      const intel = loadMeetingIntel();
      for (const m of (intel.meetings || [])) {
        const ffId = m.meetingId;
        if (!ffId || seen.has(ffId)) continue;
        seen.add(ffId);
        allMeetings.push({
          id:           ffId,
          title:        m.title || 'Untitled Meeting',
          date:         typeof m.date === 'number' ? m.date : (m.date ? new Date(m.date).getTime() : 0),
          participants: m.participants || [],
          summary:      m.analysis?.meetingSummary ? { short_summary: m.analysis.meetingSummary } : {},
        });
      }
    } catch (e) { console.error('[fireflies/meetings] intel merge:', e.message); }
    // Sort newest first
    allMeetings.sort((a, b) => (b.date || 0) - (a.date || 0));
    const meetings = allMeetings.map((t, i) => ({ ...t, _idx: i }));
    res.json({ connected: true, meetings, accountCount: keys.length });
  } catch (err) {
    console.error('fireflies:', err.response?.data || err.message);
    res.json({ connected: false, error: err.response?.data?.message || err.message });
  }
});

// ─── Fireflies.ai — full transcript for one meeting ──────────────────────────
app.get('/api/fireflies/transcript/:id', async (req, res) => {
  const ffId = req.params.id;

  // Check local store first — works for any meeting regardless of API key date limits
  const local = loadClientMeetings();
  const localMeeting = (local.meetings || []).find(m => m.fireflyId === ffId || m.id === `ff_${ffId}` || m.id === ffId);
  if (localMeeting?.notes) {
    return res.json({
      id:           ffId,
      title:        localMeeting.title,
      date:         localMeeting.date,
      participants: localMeeting.participants || [],
      summary:      { short_summary: localMeeting.summary || '', action_items: (localMeeting.actionItems || []).map(a => `- ${a.task}`).join('\n') },
      transcript:   localMeeting.notes,
      sentenceCount: localMeeting.notes.split('\n').length,
      source:       'local',
    });
  }

  const keys = [process.env.FIREFLIES_API_KEY, process.env.FIREFLIES_API_KEY_2].filter(Boolean);
  if (!keys.length) return res.status(400).json({ error: 'FIREFLIES_API_KEY not set' });
  const query = `query Transcript($id: String!) {
    transcript(id: $id) {
      id title date participants
      summary { short_summary action_items keywords }
      sentences { speaker_name text start_time }
    }
  }`;
  const tryFetch = async (key) => {
    const r = await axios.post('https://api.fireflies.ai/graphql',
      { query, variables: { id: ffId } },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }
    );
    return r.data?.data?.transcript || null;
  };
  try {
    let t = null;
    for (const key of keys) {
      t = await tryFetch(key).catch(() => null);
      if (t?.sentences?.length) break;
    }
    if (!t) return res.status(404).json({ error: 'Transcript not found on any connected account' });
    const lines = (t.sentences || []).map(s => `${s.speaker_name || 'Unknown'}: ${s.text}`);
    res.json({
      id:            t.id,
      title:         t.title,
      date:          t.date,
      participants:  t.participants || [],
      summary:       t.summary || {},
      transcript:    lines.join('\n'),
      sentenceCount: lines.length,
    });
  } catch (err) {
    console.error('fireflies/transcript:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GROWTH PARTNERS — pipeline, proposals, contracts, invoicing
// ══════════════════════════════════════════════════════════════════════════════

// Stage ID → name map for Growth Partners pipeline
const SEGMENT_STAGE_NAMES = {
  '93bc4029-7dbd-4598-8862-cb7ac7784016': 'Lead',
  '4c3cdb15-21e6-4c16-a892-8b419c0a45d9': 'Discovery Call',
  '7e6bf560-11d6-442a-b64f-3bf12f136d5a': 'Proposal Sent',
  '246fa975-94b0-423a-8529-b07601609291': 'Contract Signed',
  'addcb241-593d-4242-b7d5-afeff44cd0a2': 'Active',
  '47cb6c40-df0c-4ac9-b717-ca2bdec2536c': 'Long Term Nurture',
  'ee919b9d-1ee4-4afc-9343-5bd46add74c7': 'Churned',
  'c38e9d11-a1ce-4aa5-9ce9-fef3bab9babd': 'Disqualified',
};

const GP_PIPELINE_ID = 'W5PxjulbNVh52Gqlkmzm';
const GHL_TOMMY_USER_ID = 'SGKDNf5YvSJgLoRTzIBN';

// ─── GET /api/pipeline/:segment ───────────────────────────────────────────────
// Unified pipeline loader. Currently handles growth-partners; others fall
// through to the existing /api/ghl/opportunities pattern.
app.get('/api/pipeline/:segment', async (req, res) => {
  const { segment } = req.params;

  const PIPELINE_MAP = {
    'growth-partners': GP_PIPELINE_ID,
    'signal-engine': 'Ngdx8GTMlQ1lxiBWTr7d', // Signal Engine pipeline (10 stages: New Lead → Won/Lost)
    // add more segments → pipeline IDs here as needed
  };

  const pipelineId = PIPELINE_MAP[segment];
  if (!pipelineId) return res.status(404).json({ ok: false, error: `Unknown segment: ${segment}` });

  try {
    const data = await cached(`pipeline:${segment}`, 120_000, async () => {
      const r = await ghl.get('/opportunities/search', {
        params: { location_id: CFG.locationId, pipeline_id: pipelineId, limit: 100 },
      });
      const raw = r.data?.opportunities || [];

      // Annotate each opp with resolved stage name + contact
      const opps = raw.map(o => ({
        ...o,
        stageName: SEGMENT_STAGE_NAMES[o.pipelineStageId] || o.pipelineStage?.name || 'Lead',
        contact: {
          id:    o.contact?.id    || o.contactId || '',
          name:  o.contact?.name  || o.contactName || o.name || '',
          email: o.contact?.email || o.contactEmail || '',
        },
      }));

      // Group by stage — preserving display order
      const ORDER = ['Lead','Discovery Call','Proposal Sent','Contract Signed','Active','Long Term Nurture','Churned','Disqualified'];
      const stageMap = {};
      ORDER.forEach(n => { stageMap[n] = []; });
      opps.forEach(o => {
        const key = o.stageName;
        if (!stageMap[key]) stageMap[key] = [];
        stageMap[key].push(o);
      });

      // Build reverse map: stage name → stage ID
      const stageNameToId = {};
      Object.entries(SEGMENT_STAGE_NAMES).forEach(([id, name]) => { stageNameToId[name] = id; });

      const byStage = Object.entries(stageMap)
        .map(([name, opportunities]) => ({ name, stageId: stageNameToId[name] || '', opportunities }));

      return { total: opps.length, byStage, opportunities: opps };
    });
    res.json(data);
  } catch (err) {
    console.error(`pipeline:${segment}`, err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── PUT /api/pipeline/:segment/:oppId/stage ──────────────────────────────────
app.put('/api/pipeline/:segment/:oppId/stage', async (req, res) => {
  const { segment, oppId } = req.params;
  const { stageId } = req.body || {};
  if (!stageId) return res.status(400).json({ ok: false, error: 'stageId required' });
  try {
    await ghl.put(`/opportunities/${oppId}`, { pipelineStageId: stageId });
    cache.delete(`pipeline:${segment}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('stage-update:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── GHL Contracts — list templates ──────────────────────────────────────────
app.get('/api/ghl/contract-templates', async (req, res) => {
  try {
    const r = await ghl.get('/proposals/templates', { params: { locationId: CFG.locationId } });
    const templates = (r.data?.data || [])
      .filter(t => !t.deleted)
      .map(t => ({ id: t.id, name: t.name, published: t.isPublished }));
    res.json({ ok: true, templates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── GHL Contracts — send template to contact ─────────────────────────────────
app.post('/api/ghl/send-contract', async (req, res) => {
  const { templateId, contactId } = req.body || {};
  if (!templateId || !contactId) return res.status(400).json({ ok: false, error: 'templateId and contactId required' });
  try {
    const r = await ghl.post('/proposals/templates/send', {
      locationId: CFG.locationId,
      templateId,
      contactId,
      userId: GHL_TOMMY_USER_ID,
    });
    res.json({ ok: true, data: r.data });
  } catch (err) {
    console.error('send-contract:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── GHL Invoice helpers ──────────────────────────────────────────────────────
const GHL_BUSINESS = {
  name: 'Cult Content', email: 'tommy@cultcontent.cc', phone: '(703) 851-3599', logoUrl: '',
  address: [{ line1: '5830 Wessex Lane', city: 'Alexandria', state: 'VA', postalCode: '22310', country: 'US' }],
};

async function ghlCreateAndSendInvoice({ contactId, contactName, contactEmail, name, items }) {
  const numRes = await ghl.get('/invoices/generate-invoice-number', { params: { altId: CFG.locationId, altType: 'location' } });
  const invoiceNumber = numRes.data?.invoiceNumber;
  const due = new Date(); due.setDate(due.getDate() + 7);
  const createRes = await ghl.post('/invoices/', {
    altId: CFG.locationId, altType: 'location',
    name, invoiceNumber, currency: 'USD',
    issueDate: new Date().toISOString().split('T')[0],
    dueDate: due.toISOString().split('T')[0],
    businessDetails: GHL_BUSINESS,
    contactDetails: { id: contactId, name: contactName || '', email: contactEmail || '' },
    discount: { type: 'percentage', value: 0 },
    items: items.map(i => ({ ...i, taxes: [], taxInclusive: false })),
  });
  const invoiceId = createRes.data?._id || createRes.data?.invoice?._id;
  if (!invoiceId) throw new Error('Invoice created but no ID returned — ' + JSON.stringify(createRes.data).slice(0, 200));
  await ghl.post(`/invoices/${invoiceId}/send`, {
    altId: CFG.locationId, altType: 'location',
    action: 'email', liveMode: true, userId: GHL_TOMMY_USER_ID,
  });
  return { invoiceId, invoiceNumber };
}

// ─── GHL Invoices — retainer (auto-sends with contract) ──────────────────────
app.post('/api/ghl/send-retainer-invoice', async (req, res) => {
  const { contactId, retainerAmount, contactName, contactEmail } = req.body || {};
  if (!contactId || !retainerAmount) return res.status(400).json({ ok: false, error: 'contactId and retainerAmount required' });
  const amount = parseFloat(String(retainerAmount).replace(/[^0-9.]/g, ''));
  if (!amount || isNaN(amount)) return res.status(400).json({ ok: false, error: 'Invalid retainer amount' });
  try {
    const { invoiceId } = await ghlCreateAndSendInvoice({
      contactId, contactName, contactEmail,
      name: `Monthly Retainer — ${contactName || 'Client'}`,
      items: [{ name: 'Monthly Management Retainer', description: 'TikTok Shop affiliate management, content strategy, weekly reporting, bi-weekly syncs.', qty: 1, amount, currency: 'USD' }],
    });
    res.json({ ok: true, invoiceId, amount });
  } catch (err) {
    console.error('send-retainer-invoice:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── GHL Invoices — monthly GMV performance fee ───────────────────────────────
app.post('/api/ghl/send-gmv-invoice', async (req, res) => {
  const { contactId, contactName, contactEmail, gmvAmount, gmvPercent, month } = req.body || {};
  if (!contactId || !gmvAmount || !gmvPercent) return res.status(400).json({ ok: false, error: 'contactId, gmvAmount, gmvPercent required' });
  const gmv = parseFloat(String(gmvAmount).replace(/[^0-9.]/g, ''));
  const pct = parseFloat(String(gmvPercent).replace(/[^0-9.]/g, ''));
  const fee = Math.round(gmv * (pct / 100) * 100) / 100;
  if (!fee || isNaN(fee)) return res.status(400).json({ ok: false, error: 'Invalid GMV or percent' });
  const label = month || new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  try {
    const { invoiceId } = await ghlCreateAndSendInvoice({
      contactId, contactName, contactEmail,
      name: `GMV Performance Fee — ${label}`,
      items: [{ name: `${pct}% GMV Performance Fee — ${label}`, description: `${pct}% of $${gmv.toLocaleString()} TikTok Shop GMV generated in ${label}.`, qty: 1, amount: fee, currency: 'USD' }],
    });
    res.json({ ok: true, invoiceId, gmv, pct, fee });
  } catch (err) {
    console.error('send-gmv-invoice:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── Shopify product scraper (public /products.json — no auth needed) ─────────
async function scrapeShopifyProducts(context) {
  const domains = [];

  // 1. Pull domains from any https:// URLs in the context
  const urlMatches = [...(context.matchAll(/https?:\/\/(?:www\.)?([a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})/g))];
  domains.push(...urlMatches.map(m => m[1]));

  // 2. Pull domains from email addresses (e.g. john@orionbrand.com → orionbrand.com)
  const emailMatches = [...(context.matchAll(/[a-zA-Z0-9._%+\-]+@([a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})/g))];
  domains.push(...emailMatches.map(m => m[1]));

  // 3. Try to extract brand name for domain guessing
  const brandMatch = context.match(/brand[:\s]+([A-Za-z0-9 &]+)/i) ||
                     context.match(/company[:\s]+([A-Za-z0-9 &]+)/i);
  if (brandMatch) {
    const slug = brandMatch[1].trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    domains.push(`${slug}.com`, `shop${slug}.com`, `${slug}.myshopify.com`, `try${slug}.com`);
  }

  for (const domain of [...new Set(domains)]) {
    // Skip obviously non-brand domains
    if (/google|gmail|zoom|calendly|meet\.|loom|slack|notion|drive\.|docs\.|youtube|instagram|tiktok|linkedin|twitter|facebook/.test(domain)) continue;
    try {
      const { data } = await axios.get(`https://${domain}/products.json?limit=10`, {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research bot)' },
      });
      if (data?.products?.length > 0) {
        const products = data.products.slice(0, 12).map(p => {
          // Collect all variant prices to find the real range
          const prices = p.variants.map(v => parseFloat(v.price || 0)).filter(x => x > 0);
          const comparePrices = p.variants.map(v => parseFloat(v.compare_at_price || 0)).filter(x => x > 0);
          const minPrice = prices.length ? Math.min(...prices) : 0;
          const maxPrice = prices.length ? Math.max(...prices) : 0;
          const avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100 : 0;
          const compareAtPrice = comparePrices.length ? Math.max(...comparePrices) : null;
          return {
            title: p.title,
            priceRange: minPrice === maxPrice ? `$${minPrice}` : `$${minPrice}–$${maxPrice}`,
            typicalPrice: avgPrice, // average across all variants = best AOV estimate
            compareAtPrice: compareAtPrice,
            variantCount: p.variants?.length || 1,
          };
        });
        console.log(`[shopify] found ${products.length} products on ${domain}`);
        return { domain, products };
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

// ─── AI Proposal generator ────────────────────────────────────────────────────
// ── Step 1: Extract metrics from transcript + Shopify ───────���─────────────────
app.post('/api/ai/extract-metrics', async (req, res) => {
  try {
    const { context } = req.body;
    if (!context) return res.status(400).json({ error: 'context required' });
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const shopifyData = await scrapeShopifyProducts(context);
    const shopifyBlock = shopifyData
      ? `\nSHOPIFY PRODUCT DATA (from ${shopifyData.domain}):\n` +
        shopifyData.products.map(p =>
          `- ${p.title}: typicalPrice=$${p.typicalPrice}${p.compareAtPrice ? `, compareAtPrice=$${p.compareAtPrice}` : ''}${p.variantCount > 1 ? ` (${p.variantCount} variants)` : ''}`
        ).join('\n')
      : '\nNo Shopify data found.';

    const SYSTEM = `You are a data extraction assistant for a TikTok Shop agency. Extract structured metrics from a sales call transcript and Shopify product data. Return ONLY valid JSON — no markdown, no explanation.

Schema:
{
  "brandName": "string",
  "heroProduct": "string — most relevant product for TikTok Shop (specific name)",
  "metrics": {
    "listPrice": number or null,
    "promoPct": number or null,
    "shippingPerUnit": number or null,
    "cogsPerUnit": number or null,
    "affiliateCommPct": number or null,
    "avgViews": number or null,
    "monthlySamples": number or null,
    "affiliateRetainers": number or null
  },
  "sources": {
    "listPrice": "shopify"|"transcript"|"ai"|"missing",
    "promoPct": "shopify"|"transcript"|"ai"|"missing",
    "shippingPerUnit": "shopify"|"transcript"|"ai"|"missing",
    "cogsPerUnit": "shopify"|"transcript"|"ai"|"missing",
    "affiliateCommPct": "shopify"|"transcript"|"ai"|"missing",
    "avgViews": "shopify"|"transcript"|"ai"|"missing",
    "monthlySamples": "shopify"|"transcript"|"ai"|"missing",
    "affiliateRetainers": "shopify"|"transcript"|"ai"|"missing"
  }
}

Source meanings: "shopify"=from product data, "transcript"=explicitly stated, "ai"=reasonable estimate you filled in, "missing"=cannot determine.

RULES — follow exactly:
listPrice: Shopify typicalPrice of most relevant product → source "shopify". If no Shopify, only use price explicitly stated in transcript → "transcript". Otherwise null/"missing". NEVER infer or guess.
promoPct (whole number): If Shopify compareAtPrice > typicalPrice → promoPct = round((1 - typicalPrice/compareAtPrice)*100), source "shopify". If discount mentioned in transcript → "transcript". If no info → 0, source "ai".
cogsPerUnit: null/"missing" UNLESS explicitly stated. Almost never mentioned.
shippingPerUnit: null/"missing" UNLESS explicitly stated.
affiliateCommPct: If mentioned → "transcript". Else 25, source "ai".
avgViews: 2000, source "ai" — this represents estimated monthly views per creator. Do NOT pull from brand's own TikTok stats; it's an industry benchmark for new-to-TikTok-Shop creators.
monthlySamples: If mentioned → "transcript". Else estimate conservatively by brand size: very small/new brand=25-40, small=50, mid=75, large=100. Source "ai". Err on the low side — better to under-promise.
affiliateRetainers: If mentioned → "transcript". Else 1000, source "ai".`;

    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Extract metrics.${shopifyBlock}\n\nTRANSCRIPT:\n${context}\n\nReturn ONLY valid JSON.` }],
    });

    const raw = msg.content[0].text.trim();
    const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const extracted = JSON.parse(jsonStr);
    res.json({ ...extracted, shopifyData: shopifyData || null });
  } catch (err) {
    console.error('extract-metrics:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Step 2: Generate proposal narrative (metrics already confirmed) ─────────────
app.post('/api/ai/propose', async (req, res) => {
  try {
    const { context, retainer, gmv, confirmedMetrics } = req.body;
    if (!context) return res.status(400).json({ error: 'context required' });
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const retainerNum = parseInt(String(retainer || '2500').replace(/[^0-9]/g, '')) || 2500;
    const gmvNum = parseFloat(String(gmv || '5').replace(/[^0-9.]/g, '')) || 5;
    const breakEvenGMV = Math.round(retainerNum / (gmvNum / 100));

    // If confirmed metrics provided (two-step flow), skip Shopify scrape — already done in Step 1
    const shopifyData = confirmedMetrics ? null : await scrapeShopifyProducts(context);

    // Build economics summary from confirmed metrics so AI writes accurate narrative
    let economicsSummary = '';
    if (confirmedMetrics) {
      const { listPrice, promoPct = 0, shippingPerUnit = 6, cogsPerUnit = 0, affiliateCommPct = 25, monthlySamples = 75 } = confirmedMetrics;
      const sellingPrice = listPrice * (1 - promoPct / 100);
      const affComm = sellingPrice * affiliateCommPct / 100;
      const tikTokFee = sellingPrice * 0.06;
      const grossProfit = sellingPrice - (shippingPerUnit || 0) - (cogsPerUnit || 0) - affComm - tikTokFee;
      const grossMarginPct = sellingPrice > 0 ? grossProfit / sellingPrice : 0;
      const isViable = grossMarginPct >= 0.05;
      economicsSummary = `\nCONFIRMED UNIT ECONOMICS (use these exact figures, do not invent different numbers):
List price: $${listPrice} | Promo: ${promoPct}% | Selling price: $${sellingPrice.toFixed(2)}
COGS: $${cogsPerUnit || '?'} | Shipping: $${shippingPerUnit || '?'} | Aff commission: ${affiliateCommPct}%
Gross margin: ${(grossMarginPct * 100).toFixed(1)}% ${isViable ? '(VIABLE — write growth narrative)' : '(NEGATIVE — write diagnostic/fix narrative, no GMV growth claims)'}
Monthly samples at velocity: ${monthlySamples}`;
    }

    const SYSTEM = `You are Tommy Lynch, founder of Cult Content (cultcontent.cc), a TikTok Shop social commerce agency. You write proposals for potential brand clients.

Output ONLY a valid JSON object — no markdown, no code blocks, no explanation. Return raw JSON only.

Schema (follow exactly):
{
  "brandName": "string — extract carefully from notes. Use exact brand name.",
  "tagline": "string — one sharp sentence: the core business opportunity or question. Frame as a business decision.",
  "strategicQuestion": "string — 2-3 punchy sentences. What decision does this brand face re: TikTok Shop? What does success/failure mean for them? Reference their specific situation.",
  "currentStateMetrics": [
    {"label": "string", "value": "string"}
  ],
  "financialBreakdown": {
    "sellingPrice": number or null,
    "tikTokFeePercent": 6,
    "affiliateCommissionPercent": 12,
    "cogsPercent": number or null,
    "contributionMarginPercent": number or null,
    "narrativeLine": "string — 1-2 sentences on what the math means for this brand"
  },
  "roadmap": {
    "month1Bullets": ["string"],
    "months12Bullets": ["string"],
    "month3plusBullets": ["string"]
  },
  "nextSteps": ["string", "string", "string"],
  "profitabilityFix": {
    "isUnprofitable": boolean,
    "primaryIssue": "string — one sharp sentence on the core unit economics problem",
    "targetAOV": number or null,
    "targetProduct": "string — specific product or SKU to push as hero",
    "bundleIdea": "string — concrete bundle recommendation with products and price point",
    "strategySteps": ["string", "string", "string"]
  },
  "projections": {
    "aov": number,
    "cogsPercent": number,
    "creatorCommissionPct": number,
    "monthlyGMVGoals": [number, number, number, number, number, number, number, number, number, number, number, number]
  },
}

STYLE RULES:
- Short, punchy sentences. Zero filler words.
- Confident assertions: "This will" not "this should"
- Reference specific details from the notes — product, price point, pain points
- CRITICAL: When referencing products, use ONLY the exact product name/description from the notes. Never infer or assume materials, ingredients, or product type. If the notes say "microfiber towel", say "microfiber towel" — do not rephrase as "bamboo towel", "cotton towel", or any other material you weren't told.
- Never be generic. Every sentence should only make sense for THIS brand.
- For currentStateMetrics: ONLY include values explicitly stated in the meeting notes. Do NOT infer, estimate, or fabricate values. Omit any metric not mentioned. Examples: {"label":"Active SKUs","value":"2"}, {"label":"AOV","value":"$74"}.
- For monthlyGMVGoals: realistic 12-month ramp based on CONFIRMED UNIT ECONOMICS above. If economics are viable, ramp aggressively. If negative/diagnostic, show conservative ramp based on fixing pricing first.
- For profitabilityFix: use the CONFIRMED UNIT ECONOMICS above to determine viability. If grossMarginPct >= 5%, set isUnprofitable=false. If negative, set isUnprofitable=true with concrete AOV fix strategy — specific bundle name, specific price point that achieves 35% GM, 3 actionable steps. Do not invent a different price than what was confirmed.`;

    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2500,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Generate a proposal for this brand.

Meeting notes / context:
${context}
${economicsSummary}
${shopifyData ? `\nSHOPIFY DATA (${shopifyData.domain}):\n${shopifyData.products.map(p => `- ${p.title}: typicalPrice=$${p.typicalPrice}${p.compareAtPrice ? `, compareAt=$${p.compareAtPrice}` : ''}`).join('\n')}` : ''}

Agency pricing:
Retainer: $${retainerNum.toLocaleString()}/mo
GMV share: ${gmvNum}%
Break-even GMV: $${breakEvenGMV.toLocaleString()}

Return ONLY valid JSON. No other text.` }],
    });

    const raw = msg.content[0].text.trim();
    // Strip any accidental markdown code fences
    const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const proposal = JSON.parse(jsonStr);
    proposal.pricing = { retainer: retainerNum, gmvPct: gmvNum, breakEvenGMV };
    res.json({ proposal, shopifyData: shopifyData || null });
  } catch (err) {
    console.error('propose:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: volume disk audit ─────────────────────────────────────────────────
// GET /api/admin/disk — lists every file in DATA_DIR with size + queue status
// Protected by bearer token (WEBHOOK_SECRET) so it can be called outside CF Access
app.get('/api/admin/disk', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (token !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const queue = loadQueue();
    const queueMap = Object.fromEntries(queue.map(v => [v.filename, v.status]));

    function scanDir(dir, base = '') {
      const entries = [];
      if (!fs.existsSync(dir)) return entries;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel  = base ? `${base}/${name}` : name;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          entries.push(...scanDir(full, rel));
        } else {
          entries.push({
            path:    rel,
            size:    stat.size,
            sizeMB:  +(stat.size / 1024 / 1024).toFixed(2),
            mtime:   stat.mtime.toISOString(),
            status:  queueMap[name] || null,
          });
        }
      }
      return entries;
    }

    const files = scanDir(DATA_DIR).sort((a, b) => b.size - a.size);
    const totalMB = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024;
    res.json({ totalMB: +totalMB.toFixed(1), fileCount: files.length, files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Client Onboarding Pipeline ─────────────────────────────────────────────

const ONBOARD_PENDING_FILE         = path.join(DATA_DIR, 'onboard-pending.json');
const RESOURCE_HUB_TEMPLATE_TOKEN  = 'RuLZdNSSkouiinxp340uXfEgtjg';  // Lark doc token
const RESOURCE_HUB_TEMPLATE_WIKI   = 'WH89wl1s7i2W1ZkxAHIu3g2stsb';  // wiki node token
const LARK_WIKI_SPACE_ID           = '7527434423529111564';

function loadPendingOnboards() {
  try { return JSON.parse(fs.readFileSync(ONBOARD_PENDING_FILE, 'utf8')); }
  catch(_) { return []; }
}
function savePendingOnboards(data) {
  fs.writeFileSync(ONBOARD_PENDING_FILE, JSON.stringify(data, null, 2));
}

// Scrape Shopify store for brand + product info
async function scrapeShopify(websiteUrl) {
  if (!websiteUrl) return { brand: {}, products: [] };
  const domain  = websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
  const base    = `https://${domain}`;
  const result  = { brand: {}, products: [], domain };
  const ua      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // Shopify products JSON — usually publicly accessible
  try {
    const r = await axios.get(`${base}/products.json?limit=20`, { timeout: 12000, headers: { 'User-Agent': ua } });
    if (r.data?.products?.length) {
      result.products = r.data.products.slice(0, 8).map(p => ({
        title:          p.title,
        handle:         p.handle,
        url:            `${base}/products/${p.handle}`,
        description:    (p.body_html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 800),
        imageUrl:       p.images?.[0]?.src || null,
        price:          p.variants?.[0]?.price || null,
        compareAtPrice: p.variants?.[0]?.compare_at_price || null,
        tags:           Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || ''),
      }));
    }
  } catch(e) { console.log(`[shopify] products.json failed for ${domain}:`, e.message); }

  // Homepage — meta description, og:description, title
  try {
    const r = await axios.get(base, { timeout: 12000, headers: { 'User-Agent': ua } });
    const html = r.data || '';
    result.brand.metaDescription =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,}?)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']{10,}?)["'][^>]+name=["']description["']/i)?.[1] ||
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,}?)["']/i)?.[1] || '';
    result.brand.ogTitle =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/\s*[\|—–-].*$/, '').trim() || '';
    result.brand.ogImage =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';
    result._html = html; // used by color extractor below, deleted after
  } catch(e) { console.log(`[shopify] homepage scrape failed for ${domain}:`, e.message); }

  // Retry homepage without SSL verification (handles expired certs)
  if (!result.brand.metaDescription && !result.brand.ogTitle) {
    try {
      const https = require('https');
      const r2 = await axios.get(base, { timeout: 12000, headers: { 'User-Agent': ua }, httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
      const html = r2.data || '';
      result.brand.metaDescription =
        html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,}?)["']/i)?.[1] ||
        html.match(/<meta[^>]+content=["']([^"']{10,}?)["'][^>]+name=["']description["']/i)?.[1] ||
        html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,}?)["']/i)?.[1] || '';
      result.brand.ogTitle =
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
        html.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/\s*[\|—–-].*$/, '').trim() || '';
      result.brand.ogImage =
        html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';
      result._html = html;
      console.log(`[shopify] homepage retried without SSL verification for ${domain}`);
    } catch(e2) { console.log(`[shopify] homepage retry also failed for ${domain}:`, e2.message); }
  }

  // Extract brand primary/button color from theme CSS variables
  if (result._html) {
    const colorPatterns = [
      /--color-button[^:]*:\s*(#[0-9a-fA-F]{3,6})/i,
      /--colors-accent-[12][^:]*:\s*(#[0-9a-fA-F]{3,6})/i,
      /--color-accent[^:]*:\s*(#[0-9a-fA-F]{3,6})/i,
      /--color-primary[^:]*:\s*(#[0-9a-fA-F]{3,6})/i,
      /--c-theme-button[^:]*:\s*(#[0-9a-fA-F]{3,6})/i,
    ];
    for (const pat of colorPatterns) {
      const m = result._html.match(pat);
      if (m) { result.brand.primaryColor = m[1]; break; }
    }
    delete result._html;
  }

  return result;
}

function buildIncentiveSummary(compensation) {
  if (!compensation) return '';
  const parts = [];
  const ordinals = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th'];
  if (compensation.cashback?.enabled) {
    const amt = compensation.cashback.target || compensation.cashback.amount;
    if (amt) parts.push(`$${amt} cashback when you hit $${amt} GMV`);
  }
  if (compensation.leaderboard?.enabled) {
    const places = compensation.leaderboard.places || compensation.leaderboard.prizes || [];
    const tiers  = places.map((amt, i) => `${ordinals[i]||i+1+'th'}: $${amt}`).join(', ');
    parts.push(`Leaderboard challenge${compensation.leaderboard.threshold ? ` (min $${compensation.leaderboard.threshold} GMV)` : ''} — ${tiers}`);
  }
  if (compensation.volumeBonus?.enabled) {
    const bonus = compensation.volumeBonus.bonus || compensation.volumeBonus.bonusAmount;
    const qty   = compensation.volumeBonus.quantity || compensation.volumeBonus.videoCount;
    parts.push(`$${bonus} bonus for ${qty}+ videos`);
  }
  if (compensation.retainer?.enabled)
    parts.push(`Creator retainer: $${compensation.retainer.budget}/mo for ${compensation.retainer.postsRequired} posts`);
  return parts.join('\n• ');
}

// Scrape Amazon brand store or product page for product names, descriptions, prices
async function scrapeAmazonProducts(amazonUrl) {
  if (!amazonUrl) return { brand: {}, products: [], domain: '' };
  try {
    const res = await axios.get(amazonUrl, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const html = res.data || '';
    const products = [];

    // Brand store grid — product titles appear in data-cy="title" spans or h2 tags
    const titleRe = /data-cy="title"[^>]*>([^<]{5,120})<\/span>|<h2[^>]*class="[^"]*product-title[^"]*"[^>]*>\s*([^<]{5,120})\s*<\/h2>/gi;
    let m;
    while ((m = titleRe.exec(html)) !== null && products.length < 8) {
      const title = (m[1] || m[2] || '').trim().replace(/&amp;/g,'&').replace(/&#\d+;/g,'');
      if (title.length > 4) products.push({ name: title, description: '', price: '', url: amazonUrl });
    }

    // If brand store scrape found nothing, try single product page (ASIN in URL)
    if (!products.length) {
      const nameMatch = html.match(/<span id="productTitle"[^>]*>\s*([^<]{5,200})\s*<\/span>/i);
      const priceMatch = html.match(/<span class="a-price-whole">(\d+)<\/span>/i);
      const descMatch = html.match(/<div id="feature-bullets"[^>]*>([\s\S]{20,600}?)<\/div>/i);
      if (nameMatch) {
        const desc = descMatch ? descMatch[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,200) : '';
        products.push({ name: nameMatch[1].trim(), description: desc, price: priceMatch ? priceMatch[1] : '', url: amazonUrl });
      }
    }

    const domain = amazonUrl.replace(/^https?:\/\//,'').split('/')[0];
    console.log(`[amazon-scrape] Found ${products.length} products from ${domain}`);
    return { brand: {}, products, domain };
  } catch (e) {
    console.warn('[amazon-scrape] Failed:', e.message);
    return { brand: {}, products: [], domain: '' };
  }
}

// AI — generate all content for the pipeline
async function generateOnboardingContent(formData, shopifyData) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const formProducts = formData.products || [];
  const shopProducts = shopifyData.products || [];
  // Merge: prefer form-supplied products (they have TikTok Shop links), enrich from Shopify
  const mergedProducts = formProducts.length ? formProducts.map(fp => {
    const match = shopProducts.find(sp => sp.title.toLowerCase().includes((fp.name||'').toLowerCase().slice(0,6)));
    return { ...fp, shopifyDescription: match?.description || '', shopifyImageUrl: match?.imageUrl || '', price: match?.price || '' };
  }) : shopProducts.slice(0, 3).map(sp => ({ name: sp.title, url: sp.url, shopifyDescription: sp.description, shopifyImageUrl: sp.imageUrl, price: sp.price }));

  const brandCtx = `Brand: ${formData.brandName}
Website: ${formData.website}
Mission/Story provided: ${formData.brandMission || 'not provided'}
Site meta description: ${shopifyData.brand?.metaDescription || 'N/A'}
Products: ${mergedProducts.map(p => `${p.name}${p.shopifyDescription ? ' — ' + p.shopifyDescription.slice(0,200) : ''}`).join('\n')}
Monthly TikTok Shop GMV: ${formData.tiktokGmv || 'N/A'}
Running TikTok ads: ${formData.tiktokAds || 'N/A'}
Sending free samples: ${formData.sendSamples || 'Yes'}`;

  const incentiveLine = buildIncentiveSummary(formData.compensation);

  // --- Resource Hub content ---
  let resourceHub = null;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 8000,
      messages: [{ role: 'user', content: `You are building an Affiliate Resource Hub for TikTok Shop creators promoting ${formData.brandName} products.

${brandCtx}

For each of the top 3 products, generate:
1. A compelling brand mission & story (2–3 sentences)
2. Product description (2–3 sentences, benefit-focused, not feature-focused)
3. Problem & Solution (the core pain point + exactly how the product solves it)
4. 5 Unique Selling Points (short bullets)
5. 8 TikTok hook ideas (varied: curiosity, pain-point, transformation, controversy, POV — each under 15 words)
6. 5 full video scripts (30–60 seconds spoken, each with a hook, problem, solution, CTA)

Return ONLY valid JSON, no explanation:
{"brandMission":"...","products":[{"name":"...","description":"...","problemSolution":"...","usps":["..."],"hooks":["..."],"scripts":["..."]}]}` }]
    });
    resourceHub = JSON.parse(msg.content[0].text.trim().replace(/^```json\n?/,'').replace(/\n?```$/,''));
  } catch(e) { console.error('[onboard] resource hub gen error:', e.message); }

  // --- Reacher copy per product ---
  const reacherCopy = {};
  for (const product of (resourceHub?.products || mergedProducts).slice(0, 3)) {
    const pName = product.name;
    const pDesc = product.description || product.shopifyDescription || '';
    const pProblem = product.problemSolution || '';
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 3000,
        messages: [{ role: 'user', content: `Write TikTok Shop affiliate outreach messages for ${formData.brandName} — ${pName}.

Brand: ${formData.brandName}
Product: ${pName}
Description: ${pDesc}
Problem solved: ${pProblem}
${incentiveLine ? `Creator incentives:\n• ${incentiveLine}` : ''}

Write these 11 messages and return ONLY valid JSON with these exact keys:
- tc_message: Target Collaboration invite (MAX 500 chars). Attention-grabbing, mentions problem/solution, offers to send scripts/resources. Use {{creators username}}.
- dm_message: DM sent simultaneously (MAX 2000 chars). Includes brand mission, invites creator to be part of it${incentiveLine ? ', includes incentive details' : ''}. Use {creator_name}.
- followup_message: Follow-up after 2 days no reply (MAX 400 chars). Re-engage, friendly.
- sample_requested: Thank you after sample requested. Simple, we'll decide shortly.
- sample_approved: Sample approved and shipping soon. Express excitement.
- sample_rejected: Sample denied. Regretful but keep door open for future.
- sample_shipped: Sample shipped. Build excitement.
- sample_delivered: Sample delivered. Invite to use creative brief, mention community/discord.
- video_posted: Thank creator for posting. Encourage more videos.
- video_unfulfilled: Politely nudge late creator to post.
- retainer_offer: Ask GMV-generating creator to hop on a call about a retainer deal.

Return ONLY valid JSON.` }]
      });
      reacherCopy[pName] = JSON.parse(msg.content[0].text.trim().replace(/^```json\n?/,'').replace(/\n?```$/,''));
    } catch(e) { console.error(`[onboard] reacher copy error for ${pName}:`, e.message); }
  }

  // --- Creator page pitch ---
  let creatorPitch = `We're looking for TikTok creators to promote ${formData.brandName} products on TikTok Shop.${incentiveLine ? ` We offer:\n• ${incentiveLine}.` : ''} Apply below and our team will reach out within 48 hours.`;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 300,
      messages: [{ role: 'user', content: `Write a 2–3 sentence creator opportunity pitch for ${formData.brandName}. Compelling for TikTok Shop creators. Mention the product opportunity${incentiveLine ? ` and highlight these incentives: ${incentiveLine}` : ''}. Punchy, exciting, no fluff.` }]
    });
    creatorPitch = msg.content[0].text.trim();
  } catch(_) {}

  return { resourceHub, reacherCopy, creatorPitch, mergedProducts };
}

// Generates a structured creative brief for creators — hooks, frameworks, scripts, talking points
async function generateCreatorBrief(formData, shopifyData, aiContent) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const products    = aiContent?.mergedProducts || shopifyData?.products?.slice(0, 3) || [];
  const resourceHub = aiContent?.resourceHub;
  const brandName   = formData.brandName || 'this brand';

  const productCtx = products.map(p =>
    `${p.name}: ${(p.shopifyDescription || p.description || '').slice(0, 180)}`
  ).join('\n');

  // Use explicit brand-supplied creative context when available — more reliable than scraped data
  const audienceCtx    = formData.targetAudience   || 'general consumer';
  const problemCtx     = formData.mainProblem       || resourceHub?.products?.[0]?.problemSolution || 'improves daily life';
  const objectionsCtx  = formData.buyerObjections   || '';
  const resultsCtx     = formData.customerResults   || '';

  const prompt = `You are building a TikTok creator content brief for a brand. Generate a structured brief that gives creators everything they need to make high-converting TikTok Shop videos.

BRAND:
Name: ${brandName}
Mission: ${formData.brandMission || resourceHub?.brandMission || 'not provided'}
Products:
${productCtx || 'not provided'}
Target audience: ${audienceCtx}
Main problem solved: ${problemCtx}${objectionsCtx ? `\nCommon buyer objections: ${objectionsCtx}` : ''}${resultsCtx ? `\nResults customers report: ${resultsCtx}` : ''}

HOOK TEMPLATES (fill in blanks with this brand's specific details — every hook must be complete and ready to use):
- _____ don't want you to know this, but [brand secret/benefit]
- [Product] is the only thing I use for [problem this solves] anymore and here's why
- [Target audience], this is your answer to [main problem]
- [Target audience], DON'T make the same mistake as me with [category]
- Everything you know about [product category] is WRONG
- After [time struggling with problem] I finally [desired outcome] with this
- Don't waste your money on [old solution] — do this instead
- [Timeframe] ago I discovered something that changed my [relevant life area] forever
- Biggest myths about [problem this product solves]
- My honest review of [product name] — is it worth it?
- 3 reasons you need [product name] in your life
- I'm never going back to [old solution] again
- Best way to [desired outcome] in [year]
- Why [target audience] are switching to [product name]
- Five signs you should stop using [alternative product]
- Did you know that [surprising fact about the problem/product]?

UGC FRAMEWORKS TO CHOOSE FROM:
- Problem → Solution: Hook with pain point, agitate it, introduce product as the fix, CTA
- Before / After: Show transformation — life before product vs. after, visual or verbal
- Why I Switched: Personal story of moving from old solution to this product, with reason
- My Honest Review: Authentic pros/cons walkthrough with personal experience and verdict
- 3 Reasons Why: Three tight, benefit-focused arguments for the product
- POV You're Obsessed: First-person immersive experience of discovering and loving the product
- Industry Secret: Position product as insider knowledge most people don't know about
- Stop Wasting Your [X]: Call out wrong/old solution, introduce better one
- Reply to Comment: TikTok comment overlay format — address an objection or common question
- Features Focused: Walk through 3-5 key features with quick demonstrations

COPYWRITING FRAMEWORKS:
- PAS (Problem-Agitate-Solution): Name the problem, make it feel urgent, present the product as relief
- BAB (Before-After-Bridge): Where viewer is now → where they could be → how the product bridges the gap
- AIDA (Attention-Interest-Desire-Action): Stop scroll, build curiosity, create desire, direct to buy
- FAB (Features-Advantages-Benefits): What it does → why that matters → how it improves their life

Generate this EXACT JSON (no markdown, no explanation):
{
  "niche": "single word (Beauty/Fashion/Health/Food/Home/Pet/Accessories/etc)",
  "targetAudience": "2-sentence description of the exact viewer this content is for",
  "mainProblem": "the single core problem this product solves, in 1 sentence",
  "hooks": [
    { "text": "completely filled-in hook, ready to record, specific to this brand/product", "type": "curiosity|pain-point|transformation|social-proof|controversy|myth-bust" },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." }
  ],
  "frameworks": [
    { "name": "Framework Name", "why": "1 sentence why this format works best for this product", "outline": ["Step 1 specific to this product", "Step 2", "Step 3"] },
    { "name": "...", "why": "...", "outline": ["...", "...", "..."] },
    { "name": "...", "why": "...", "outline": ["...", "...", "..."] }
  ],
  "sampleScripts": [
    {
      "framework": "PAS",
      "title": "Short descriptive title",
      "duration": "~30 seconds",
      "script": "Full word-for-word script. Label sections: [HOOK] [PROBLEM] [SOLUTION] [CTA]. Write it as spoken dialogue, conversational and natural."
    },
    {
      "framework": "BAB",
      "title": "Short descriptive title",
      "duration": "~30 seconds",
      "script": "Full word-for-word script. Label sections: [BEFORE] [AFTER] [BRIDGE] [CTA]."
    }
  ],
  "talkingPoints": {
    "benefits": ["benefit 1", "benefit 2", "benefit 3", "benefit 4", "benefit 5"],
    "objections": ["common objection: how to handle it in the video"],
    "powerPhrases": ["memorable phrase 1", "memorable phrase 2", "memorable phrase 3"]
  },
  "doAndDont": {
    "dos": ["specific do for this product/niche", "do 2", "do 3"],
    "donts": ["specific dont for this product/niche", "dont 2", "dont 3"]
  },
  "benchmarks": {
    "hookRate": ">30% (impressions ÷ 3-second plays)",
    "holdRate": ">10-15% (thruplays ÷ 3-second plays)",
    "ctr": ">1-1.5% (clicks ÷ impressions)"
  }
}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  return JSON.parse(msg.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
}

// Copy Lark Affiliate Resource Hub template and return {token, url, name}
async function createLarkResourceHub(formData) {
  try {
    const larkToken = await getLarkTenantToken();
    if (!larkToken) { console.error('[onboard] No Lark tenant token'); return null; }

    // Use wiki node copy API — drive copy API doesn't handle wiki-type docs properly
    // target_parent_token omitted → places copy at root of the same wiki space
    const copyBody = { title: `${formData.brandName} - Affiliate Resource Hub` };
    console.log(`[onboard] Lark copy attempt: space=${LARK_WIKI_SPACE_ID} node=${RESOURCE_HUB_TEMPLATE_WIKI}`);
    const r = await axios.post(
      `https://open.larksuite.com/open-apis/wiki/v2/spaces/${LARK_WIKI_SPACE_ID}/nodes/${RESOURCE_HUB_TEMPLATE_WIKI}/copy`,
      copyBody,
      { headers: { Authorization: `Bearer ${larkToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[onboard] Lark copy raw response: ${JSON.stringify(r.data)}`);
    const node = r.data?.data?.node;
    if (!node) { console.error('[onboard] Lark wiki copy failed:', JSON.stringify(r.data)); return null; }
    const url = node.url || `https://cedw5xj2shl.usttp.larksuite.com/wiki/${node.node_token}`;
    console.log(`[onboard] Created resource hub: ${url}`);
    return { token: node.obj_token, wikiToken: node.node_token, url, name: `${formData.brandName} - Affiliate Resource Hub` };
  } catch(e) {
    console.error(`[onboard] createLarkResourceHub error: ${JSON.stringify(e.response?.data) || e.message}`);
    return null;
  }
}

// Create a public Lark group chat for a brand's creator community
async function createLarkCreatorGroup(brandName) {
  try {
    const larkToken = await getLarkTenantToken();
    if (!larkToken) { console.error('[lark] No Lark tenant token for createLarkCreatorGroup'); return null; }

    // Step 1 — Create the group chat
    const createRes = await axios.post(
      'https://open.larksuite.com/open-apis/im/v1/chats',
      {
        name: `${brandName} — Creator Community`,
        description: `TikTok Shop creator affiliate community for ${brandName}`,
        chat_mode: 'group',
        chat_type: 'public',
      },
      { headers: { Authorization: `Bearer ${larkToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[lark] createLarkCreatorGroup create response: ${JSON.stringify(createRes.data)}`);
    const chatId = createRes.data?.data?.chat_id;
    if (!chatId) { console.error('[lark] createLarkCreatorGroup: no chat_id in response:', JSON.stringify(createRes.data)); return null; }

    // Step 2 — Generate a permanent join link
    const linkRes = await axios.post(
      `https://open.larksuite.com/open-apis/im/v1/chats/${chatId}/link`,
      { validity_period: 'permanently' },
      { headers: { Authorization: `Bearer ${larkToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[lark] createLarkCreatorGroup link response: ${JSON.stringify(linkRes.data)}`);
    const shareLink = linkRes.data?.data?.share_link;
    if (!shareLink) { console.error('[lark] createLarkCreatorGroup: no share_link in response:', JSON.stringify(linkRes.data)); return null; }

    return { chatId, shareLink };
  } catch(e) {
    console.error(`[lark] createLarkCreatorGroup error: ${JSON.stringify(e.response?.data) || e.message}`);
    return null;
  }
}

// Send comprehensive Lark alert via Railway /command
async function sendLarkOnboardingAlert(formData, shopifyData, aiContent, larkDoc, creatorPage) {
  try {
    const brandName      = formData.brandName;
    const incentiveLine  = buildIncentiveSummary(formData.compensation);
    const products       = (aiContent?.mergedProducts || formData.products || []).map(p => p.name || p.title).filter(Boolean);

    let text = `🎉 *New Client Onboarded: ${brandName}*\n\n`;
    text += `👤 ${formData.firstName} ${formData.lastName}  |  ${formData.email}  |  ${formData.phone || '—'}\n`;
    text += `🌐 ${formData.website}\n`;
    text += `📦 Products: ${products.join(', ') || 'TBD'}\n`;
    text += `💰 Monthly Budget: ${formData.monthlyBudget ? '$' + formData.monthlyBudget : 'TBD'}  |  GMV Goal: ${formData.gmvGoal ? '$' + formData.gmvGoal : 'TBD'}\n`;
    text += `🛍 TikTok Shop GMV: ${formData.tiktokGmv || 'N/A'}  |  Ads: ${formData.tiktokAds || 'N/A'}\n`;
    text += `📮 Sending Samples: ${formData.sendSamples || 'Yes'}\n`;

    if (incentiveLine) {
      text += `\n🏆 *Creator Incentive Program:*\n• ${incentiveLine}\n`;
    }

    if (larkDoc?.url) {
      text += `\n📄 *Affiliate Resource Hub (copy & fill):* ${larkDoc.url}\n`;
    }

    if (creatorPage?.publicUrl) {
      text += `🎯 *Creator Interest Page (DRAFT — approve in dashboard):* ${creatorPage.publicUrl}\n`;
    }

    // Reacher copy per product
    if (aiContent?.reacherCopy && Object.keys(aiContent.reacherCopy).length) {
      text += `\n${'─'.repeat(40)}\n📣 *Generated Reacher Copy:*\n`;
      for (const [pName, copy] of Object.entries(aiContent.reacherCopy)) {
        text += `\n*${pName}*\n\n`;
        text += `📌 TC Message:\n${copy.tc_message || '—'}\n\n`;
        text += `💬 DM Message:\n${copy.dm_message || '—'}\n\n`;
        text += `🔁 Follow-Up:\n${copy.followup_message || '—'}\n`;
        text += `${'─'.repeat(30)}\n`;
      }
    }

    text += `\n✅ Review & approve everything: https://manifest.cultcontent.cc`;

    await axios.post(`${CFG.railwayUrl}/command`,
      { text, context: 'Client Onboarding', source: 'Command Center' },
      { timeout: 10000 }
    );
    console.log(`[onboard] Lark alert sent for ${brandName}`);
  } catch(e) {
    console.error('[onboard] sendLarkOnboardingAlert:', e.response?.data || e.message);
  }
}

// Full async pipeline — runs after form submission responds
async function runOnboardingPipeline(formData) {
  const brandName = formData.brandName;
  console.log(`[onboard] Pipeline start: ${brandName}`);

  // Save a stub entry immediately so the submission is never lost even if the process is killed
  const entryId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const stubEntry = { id: entryId, createdAt: new Date().toISOString(), status: 'processing', formData, shopifyData: null, aiContent: null, ghlContactId: null, larkDoc: null, creatorPage: null };
  const stubPending = loadPendingOnboards();
  stubPending.unshift(stubEntry);
  savePendingOnboards(stubPending);

  function updatePendingEntry(fields) {
    const all = loadPendingOnboards();
    const idx = all.findIndex(e => e.id === entryId);
    if (idx !== -1) { Object.assign(all[idx], fields); savePendingOnboards(all); }
  }

  // 1. Scrape product data — try shopifyUrl first, fall back to website, then Amazon
  const scrapeTarget = formData.shopifyUrl || formData.website;
  let shopifyData = await scrapeShopify(scrapeTarget).catch(() => ({ brand:{}, products:[] }));

  // If Shopify scrape returned nothing and Amazon URL was provided, try scraping that
  if (!shopifyData.products?.length && formData.amazonUrl) {
    shopifyData = await scrapeAmazonProducts(formData.amazonUrl).catch(() => shopifyData);
    console.log(`[onboard] Amazon fallback scraped ${shopifyData.products?.length || 0} products`);
  }

  console.log(`[onboard] Scraped ${shopifyData.products.length} products from ${shopifyData.domain || scrapeTarget}`);
  updatePendingEntry({ shopifyData });

  // 2. Generate AI content
  const aiContent = await generateOnboardingContent(formData, shopifyData).catch(e => {
    console.error('[onboard] AI gen error:', e.message); return null;
  });
  updatePendingEntry({ aiContent });

  // 2b. Generate creator brief (hooks, frameworks, scripts)
  const creatorBrief = await generateCreatorBrief(formData, shopifyData, aiContent).catch(e => {
    console.error('[onboard] creator brief gen error:', e.message); return null;
  });

  // 3. Create GHL contact (or update if duplicate)
  let ghlContactId = null;
  try {
    const cr = await ghl.post('/contacts/', {
      locationId: CFG.locationId,
      firstName: formData.firstName, lastName: formData.lastName,
      email: formData.email, phone: formData.phone || '',
      tags: ['client-onboarding', `client-${slugify(brandName)}`],
      source: 'Client Onboarding Form',
    });
    ghlContactId = cr.data?.contact?.id;
    console.log(`[onboard] GHL contact created: ${ghlContactId}`);
  } catch(e) {
    // GHL rejects duplicate contacts — extract the existing contactId and tag them instead
    const existingId = e.response?.data?.meta?.contactId;
    if (existingId) {
      ghlContactId = existingId;
      console.log(`[onboard] GHL contact already exists (${existingId}), tagging`);
      await ghl.post(`/contacts/${existingId}/tags`, { tags: ['client-onboarding', `client-${slugify(brandName)}`] }).catch(() => {});
    } else {
      console.error('[onboard] GHL contact error:', e.response?.data || e.message);
    }
  }

  // 4. Copy Lark resource hub template
  const larkDoc = await createLarkResourceHub(formData).catch(e => {
    console.error('[onboard] lark doc error:', e.message); return null;
  });

  // 5. Create draft creator page (always first so URL exists for automations)
  let creatorPage = null;
  try {
    const slug          = slugify(brandName);
    const incentiveLine = buildIncentiveSummary(formData.compensation);
    const pitch         = aiContent?.creatorPitch || `We're looking for TikTok creators to promote ${brandName} products on TikTok Shop.${incentiveLine ? `\n\nCreator incentive program:\n• ${incentiveLine}` : ''}\n\nApply below and our team will reach out within 48 hours.`;

    const brandsData = loadBrands();
    let brand = brandsData.clients.find(b => slugify(b.name) === slug);
    if (!brand) {
      brand = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), name: brandName, createdAt: new Date().toISOString() };
      brandsData.clients.push(brand);
    }
    brand.contactName = `${formData.firstName} ${formData.lastName}`;
    if (formData.email && !brand.loginEmail) brand.loginEmail = formData.email.toLowerCase().trim();
    brand.website     = formData.website;
    if (formData.logoUrl) brand.logoUrl = formData.logoUrl;
    brand.creatorPage = {
      slug, tagName: `creator-interested-${slug}`, active: true,
      headline: `Partner with ${brandName}`,
      subheadline: 'Join our TikTok Shop creator affiliate program',
      pitch, accentColor: shopifyData?.brand?.primaryColor || '#00f2ea',
      incentives: formData.compensation,
      usps: [formData.usp1, formData.usp2, formData.usp3].filter(Boolean),
      talkingPoints: formData.talkingPoints || '',
      products: formData.products || [],
      tiktokHandle: formData.tiktokHandle || '',
      tcCommission:   formData.tcCommission   ? parseFloat(formData.tcCommission)   : null,
      openCommission: formData.openCommission ? parseFloat(formData.openCommission) : null,
      targetAudience:  formData.targetAudience  || '',
      mainProblem:     formData.mainProblem     || '',
      buyerObjections: formData.buyerObjections || '',
      customerResults: formData.customerResults || '',
      competitorVideos: Array.isArray(formData.competitorVideos) ? formData.competitorVideos : [],
      campaigns: {},
      dmAutomationId: null,
      brief: creatorBrief || null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    saveBrands(brandsData);
    creatorPage = { slug, publicUrl: `${CREATOR_BASE_URL}/creators/${slug}`, active: true };
    console.log(`[onboard] Creator page live: ${creatorPage.publicUrl}`);
  } catch(e) { console.error('[onboard] creator page error:', e.message); }

  // 5b. Auto-match Reacher shop by brand name (fuzzy)
  let matchedShopId = null;
  try {
    const shopsResp = await axios.get(`${CFG.railwayUrl}/affiliate/shops`, { timeout: 10000 });
    const shops = shopsResp.data?.data || shopsResp.data || [];
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const nb = norm(brandName);
    const match = shops.find(s => {
      const ns = norm(s.shop_name);
      return ns === nb || ns.includes(nb) || nb.includes(ns);
    });
    if (match) {
      matchedShopId = match.shop_id;
      const bd = loadBrands();
      const bi = bd.clients.findIndex(b => slugify(b.name) === slugify(brandName));
      if (bi !== -1 && !bd.clients[bi].shopId) {
        bd.clients[bi].shopId = matchedShopId;
        saveBrands(bd);
        console.log(`[onboard] Reacher auto-match: ${match.shop_name} → shopId ${matchedShopId}`);
      }
    } else {
      console.log(`[onboard] No Reacher shop match for: ${brandName}`);
    }
  } catch(e) { console.error('[onboard] Reacher shop lookup error:', e.message); }

  // 5c. Create comprehensive creator outreach DM automation in Reacher
  if (matchedShopId && creatorPage?.publicUrl) {
    try {
      const inc = formData.compensation || {};
      const incentiveLine = buildIncentiveSummary(inc);
      const firstProductName = (aiContent?.mergedProducts || formData.products || [])[0]?.name || '';
      const aiDm = firstProductName && aiContent?.reacherCopy?.[firstProductName]?.dm_message;

      let dmMessage;
      if (aiDm) {
        // AI-generated copy — append signup link if not already present
        dmMessage = aiDm.includes(creatorPage.publicUrl)
          ? aiDm
          : `${aiDm}\n\nSign up here: ${creatorPage.publicUrl}`;
      } else {
        // Built-in fallback
        const incentiveBlock = incentiveLine
          ? `\n\nCreator Incentive Program:\n• ${incentiveLine}`
          : '';
        dmMessage = `Hey {creator_name}! 👋 We're ${brandName} — ${shopifyData?.brand?.metaDescription?.slice(0,120) || 'a fast-growing brand'} — and we're building our TikTok Shop creator team.${incentiveBlock}\n\nIf you're interested in collaborating, sign up here and we'll get you set up right away:\n${creatorPage.publicUrl}`;
      }

      const resp = await axios.post(
        `${CFG.railwayUrl}/affiliate/shops/${matchedShopId}/automations/outreach-dm`,
        {
          name:    `${brandName} — Creator Outreach`,
          message: dmMessage.slice(0, 2000),
          creatorPageUrl: creatorPage.publicUrl,
        },
        { timeout: 15000 }
      );
      const dmAutomationId = resp.data?.automation_id || resp.data?.id || null;
      if (dmAutomationId) {
        const bd = loadBrands();
        const bi = bd.clients.findIndex(b => slugify(b.name) === slugify(brandName));
        if (bi !== -1) {
          if (!bd.clients[bi].creatorPage) bd.clients[bi].creatorPage = {};
          bd.clients[bi].creatorPage.dmAutomationId = dmAutomationId;
          saveBrands(bd);
        }
        console.log(`[onboard] Creator outreach DM automation created: ${dmAutomationId}`);
      }
    } catch(e) { console.error('[onboard] DM automation error:', e.message); }
  }

  // 6. Finalise pending review entry (was saved as stub at pipeline start)
  updatePendingEntry({ status: 'pending', ghlContactId, larkDoc, creatorPage });

  // 7. Send comprehensive Lark alert
  await sendLarkOnboardingAlert(formData, shopifyData, aiContent, larkDoc, creatorPage);

  // 8. Sync to Ops Engine (fire-and-forget)
  try {
    const { syncClientToOpsEngine } = require('./lib/ops-engine-sync');
    await syncClientToOpsEngine(formData, {
      brandSlug: (formData.brandName||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),
      ghlContactId: typeof ghlContactId !== 'undefined' ? ghlContactId : null,
      larkDocUrl: typeof larkDoc !== 'undefined' ? (larkDoc?.url||larkDoc||null) : null,
      creatorPageUrl: typeof creatorPage !== 'undefined' ? (creatorPage?.url||null) : null
    });
  } catch (e) { console.error('[ops-engine] sync error:', e.message); }

  // 9. Create per-client Lark group chat (fire-and-forget)
  try {
    const { syncClientChat } = require('./lib/client-chat-sync');
    await syncClientChat(formData, {
      brandSlug: (formData.brandName||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),
      larkDocUrl: typeof larkDoc !== 'undefined' ? (larkDoc?.url||larkDoc||null) : null,
      creatorPageUrl: typeof creatorPage !== 'undefined' ? (creatorPage?.url||null) : null,
      affiliateLink: formData.affiliateLink || null
    });
  } catch (e) { console.error('[client-chat] sync error:', e.message); }

  console.log(`[onboard] Pipeline complete: ${brandName} (id: ${entryId})`);
}

// GET /api/onboard/pending
app.get('/api/onboard/pending', requireAuth, (req, res) => res.json(loadPendingOnboards()));

// PATCH /api/onboard/:id — edit generated copy before approval
app.patch('/api/onboard/:id', requireAuth, (req, res) => {
  const pending = loadPendingOnboards();
  const idx = pending.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  pending[idx] = { ...pending[idx], ...req.body, updatedAt: new Date().toISOString() };
  savePendingOnboards(pending);
  res.json({ ok: true });
});

// POST /api/onboard/:id/approve — activate creator page + mark approved
// Body (optional): { shopId: number }
app.post('/api/onboard/:id/approve', requireAuth, express.json(), async (req, res) => {
  const pending = loadPendingOnboards();
  const idx = pending.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  const entry = pending[idx];
  try {
    if (entry.creatorPage?.slug) {
      const brandsData = loadBrands();
      const brand = brandsData.clients.find(b => b.creatorPage?.slug === entry.creatorPage.slug);
      if (brand) {
        if (brand.creatorPage) brand.creatorPage.active = true;
        // Save manually-selected Reacher shopId if provided (overrides auto-match)
        if (req.body?.shopId) brand.shopId = req.body.shopId;
        saveBrands(brandsData);
      }
    }
    pending[idx].status = 'approved';
    pending[idx].approvedAt = new Date().toISOString();
    savePendingOnboards(pending);
    res.json({ ok: true, message: 'Creator page is now live', publicUrl: entry.creatorPage?.publicUrl });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/onboard/:id
app.delete('/api/onboard/:id', requireAuth, (req, res) => {
  savePendingOnboards(loadPendingOnboards().filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});

// ─── Creator Interest Pages ──────────────────────────────────────────────────

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function hexToRgb(hex) {
  const m = (hex || '#00f2ea').replace('#', '').match(/.{2}/g);
  return m ? `${parseInt(m[0],16)},${parseInt(m[1],16)},${parseInt(m[2],16)}` : '0,242,234';
}

function extractTikTokVideoId(url) {
  // handles https://www.tiktok.com/@user/video/1234567890 and vm.tiktok.com short links
  const m = url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function renderOpportunitiesPage() {
  const brands = loadBrands();
  const opportunities = (brands.clients || []).filter(b => b.creatorPage?.slug && b.creatorPage?.active !== false && b.creatorPage?.listed !== false);

  const cards = opportunities.map(brand => {
    const cp         = brand.creatorPage;
    const accent     = cp.accentColor || '#00f2ea';
    const ar         = hexToRgb(accent);
    const inc        = cp.incentives || {};
    const pills      = [];
    if (cp.tcCommission)          pills.push(`${cp.tcCommission}% commission`);
    if (inc.cashback?.enabled) {
      const amt = inc.cashback.target || inc.cashback.amount || inc.cashback.gmvTarget;
      pills.push(amt ? `$${amt} cashback` : 'Cashback program');
    }
    if (inc.volumeBonus?.enabled) {
      const bonus = inc.volumeBonus.bonus || inc.volumeBonus.bonusAmount;
      const qty   = inc.volumeBonus.quantity || inc.volumeBonus.videoCount;
      pills.push(bonus && qty ? `$${bonus} for ${qty} videos` : 'Video bonus');
    }
    if (inc.leaderboard?.enabled) pills.push('Monthly prizes');
    const pillHtml     = pills.map(p => `<span style="background:rgba(${ar},.12);color:${accent};border:1px solid rgba(${ar},.25);border-radius:100px;padding:3px 10px;font-size:11px;font-weight:700;white-space:nowrap;">${p}</span>`).join('');
    const headline     = cp.headline    || `Partner with ${brand.name}`;

    return `
    <a href="/creators/${cp.slug}" style="text-decoration:none;display:flex;flex-direction:column;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:20px;overflow:hidden;transition:border-color .2s,transform .15s,box-shadow .2s;cursor:pointer;" class="opp-card">
      <div style="height:3px;background:linear-gradient(90deg,${accent},transparent);flex-shrink:0;"></div>
      <div style="padding:22px 22px 18px;flex:1;display:flex;flex-direction:column;gap:14px;">
        <!-- Brand name -->
        <div style="font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${accent};">${brand.name || 'Brand'}</div>
        <!-- Headline -->
        <div style="font-size:17px;font-weight:900;line-height:1.25;color:#fff;letter-spacing:-.01em;">${headline}</div>
        <!-- Pills -->
        ${pillHtml ? `<div style="display:flex;flex-wrap:wrap;gap:6px;">${pillHtml}</div>` : ''}
        <!-- CTA -->
        <div style="margin-top:auto;display:flex;align-items:center;justify-content:space-between;padding-top:14px;border-top:1px solid rgba(255,255,255,.05);">
          <span style="font-size:13px;font-weight:700;color:${accent};">View opportunity</span>
          <span style="font-size:18px;color:${accent};opacity:.7;">→</span>
        </div>
      </div>
    </a>`;
  }).join('');

  const emptyState = `
    <div style="grid-column:1/-1;text-align:center;padding:80px 20px;color:rgba(255,255,255,.25);">
      <div style="font-size:48px;margin-bottom:16px;">🌱</div>
      <div style="font-size:16px;font-weight:700;">Opportunities coming soon</div>
      <div style="font-size:13px;margin-top:8px;">New brands are being onboarded. Check back shortly.</div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manifest Abundance — TikTok Creator Opportunities</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#080610;color:#fff;min-height:100vh}
.hero{background:linear-gradient(160deg,#0d0b18 0%,#100e1c 50%,#080610 100%);padding:80px 24px 64px;text-align:center;position:relative;overflow:hidden;}
.hero::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 800px 400px at 50% 0%,rgba(0,242,234,.06) 0%,transparent 70%);pointer-events:none;}
.eyebrow{display:inline-flex;align-items:center;gap:8px;background:rgba(0,242,234,.08);border:1px solid rgba(0,242,234,.2);border-radius:100px;padding:6px 18px;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#00f2ea;margin-bottom:28px;}
h1{font-family:'Montserrat',sans-serif;font-size:clamp(36px,6vw,68px);font-weight:900;line-height:1.04;letter-spacing:-.03em;margin-bottom:18px;background:linear-gradient(135deg,#fff 0%,rgba(255,255,255,.6) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.hero-sub{font-size:clamp(14px,2vw,18px);color:rgba(255,255,255,.4);max-width:560px;margin:0 auto;line-height:1.65;}
.count-badge{display:inline-block;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:100px;padding:4px 14px;font-size:12px;font-weight:700;color:rgba(255,255,255,.5);margin-top:28px;}
.grid-wrap{max-width:1100px;margin:0 auto;padding:56px 24px 80px;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;}
.opp-card:hover{border-color:rgba(255,255,255,.18)!important;transform:translateY(-3px);box-shadow:0 16px 40px rgba(0,0,0,.35);}
footer{border-top:1px solid rgba(255,255,255,.05);padding:24px;text-align:center;font-size:11px;color:rgba(255,255,255,.18);}
footer a{color:#00f2ea;text-decoration:none;}
.site-nav{display:flex;align-items:center;padding:16px 24px;border-bottom:1px solid rgba(255,255,255,.05);}
.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none;}
.nav-logo img{width:36px;height:36px;border-radius:8px;object-fit:cover;}
.nav-logo-text{font-size:.9rem;font-weight:800;color:#00f2ea;letter-spacing:-.01em;}
</style>
</head>
<body>

<nav class="site-nav">
  <a class="nav-logo" href="https://cultcontent.cc" target="_blank">
    <img src="https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png" alt="Cult Content">
    <span class="nav-logo-text">Cult Content</span>
  </a>
</nav>

<div class="hero">
  <div class="eyebrow">✦ TikTok Shop Creator Program</div>
  <h1>Manifest Abundance</h1>
  <p class="hero-sub">Find the opportunity that is most aligned with who you are — and start earning.</p>
  <div class="count-badge">${opportunities.length} brand${opportunities.length !== 1 ? 's' : ''} currently partnering</div>
  <p style="margin-top:20px;font-size:12px;color:rgba(255,255,255,.25);">Select a brand below to connect your TikTok account and join their creator program.</p>
</div>

<div class="grid-wrap">
  <div class="grid">
    ${cards || emptyState}
  </div>
</div>

<footer>Powered by <a href="https://cultcontent.cc" target="_blank">Cult Content</a> — TikTok Shop Creator Agency &nbsp;·&nbsp; <a href="/terms" target="_blank">Terms of Service</a> &nbsp;·&nbsp; <a href="/privacy" target="_blank">Privacy Policy</a></footer>

<script src="/ic-nav.js" defer></script>
</body>
</html>`;
}

function renderCreatorPage(brand, cp) {
  const accent   = cp.accentColor || '#00f2ea';
  const ar       = hexToRgb(accent);
  const name     = brand.name || 'Brand';
  const inc      = cp.incentives || {};

  // Brand video embed (data-driven). Supports YouTube, Vimeo, or direct video file.
  let videoEmbedHtml = '';
  if (cp.videoUrl) {
    const vurl = String(cp.videoUrl).trim();
    const yt = vurl.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([\w-]{11})/);
    const gdrive = vurl.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
    const tiktok = vurl.match(/tiktok\.com\/.*\/video\/(\d+)/) || vurl.match(/tiktok\.com\/(?:v|t)\/(\w+)/);
    const vimeo = vurl.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    let inner = '';
    if (yt) {
      inner = `<iframe src="https://www.youtube.com/embed/${yt[1]}?rel=0&modestbranding=1&playsinline=1" title="${name} creator video" frameborder="0" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
    } else if (vimeo) {
      inner = `<iframe src="https://player.vimeo.com/video/${vimeo[1]}" title="${name} creator video" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
    } else if (/\.(mp4|webm|mov)(\?.*)?$/i.test(vurl)) {
      inner = `<video src="${vurl}" controls playsinline preload="metadata"></video>`;
    } else if (gdrive) {
      inner = `<iframe src="https://drive.google.com/file/d/${gdrive[1]}/preview" title="${name} creator video" frameborder="0" allow="autoplay" allowfullscreen></iframe>`;
    } else if (tiktok) {
      inner = `<iframe src="https://www.tiktok.com/embed/v2/${tiktok[1]}" title="${name} creator video" frameborder="0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
    }
    if (inner) {
      const vTitle = cp.videoTitle || 'Watch this first';
      const vSub   = cp.videoSub   || `See how creators are winning with ${name}.`;
      videoEmbedHtml = `
<hr class="divider">
<div class="section">
  <div class="section-inner">
    <div class="section-label">Watch</div>
    <div class="section-title">${vTitle}</div>
    <div class="section-sub">${vSub}</div>
    <div class="video-embed">${inner}</div>
  </div>
</div>`;
    }
  }

  // Reference images — "Use These Pictures" (data-driven). Supports static images + gifs.
  let imagesEmbedHtml = '';
  {
    const imgs = Array.isArray(cp.referenceImages) ? cp.referenceImages.filter(i => i && i.url) : [];
    if (imgs.length) {
      const cards = imgs.map(i => {
        const u = String(i.url).trim().replace(/"/g, '&quot;');
        const cap = i.caption ? '<div class="refimg-cap">' + String(i.caption).replace(/</g, '&lt;') + '</div>' : '';
        return '<div class="refimg-item"><img src="' + u + '" alt="' + name + ' reference" loading="lazy">' + cap + '</div>';
      }).join('');
      const iTitle = cp.imagesTitle || 'Use these pictures';
      const iSub   = cp.imagesSub   || ('The exact visuals winning creators are using for ' + name + ' — drop them straight into your videos.');
      imagesEmbedHtml = `
<hr class="divider">
<div class="section">
  <div class="section-inner">
    <div class="section-label">Assets</div>
    <div class="section-title">${iTitle}</div>
    <div class="section-sub">${iSub}</div>
    <div class="refimg-grid">${cards}</div>
  </div>
</div>`;
    }
  }

  // Auto-generate reward copy lines
  const rewardLines = [];
  if (cp.tcCommission) rewardLines.push({ val: `${cp.tcCommission}%`, desc: 'commission on every sale you drive' });
  if (inc.cashback?.enabled) {
    const amt = inc.cashback.target || inc.cashback.amount || inc.cashback.gmvTarget;
    if (amt) rewardLines.push({ val: `$${amt} cashback`, desc: `hit $${amt} GMV and earn it back as cash` });
  }
  if (inc.volumeBonus?.enabled) {
    const bonus = inc.volumeBonus.bonus || inc.volumeBonus.bonusAmount;
    const qty   = inc.volumeBonus.quantity || inc.volumeBonus.videoCount;
    if (bonus && qty) rewardLines.push({ val: `$${bonus} bonus`, desc: `post ${qty} videos and earn a one-time cash bonus` });
  }
  if (inc.leaderboard?.enabled) {
    const places = inc.leaderboard.places || inc.leaderboard.prizes || [];
    const topPrize = places[0];
    if (topPrize) {
      const ordinals = ['1st', '2nd', '3rd'];
      const extraTiers = places.length > 1
        ? places.slice(1).map((p, i) => `${ordinals[i + 1] || `${i+2}nd`} $${p}`).join(', ')
        : '';
      const descParts = [`monthly leaderboard`];
      if (inc.leaderboard.threshold) descParts.push(`$${Number(inc.leaderboard.threshold).toLocaleString()} min GMV`);
      if (extraTiers) descParts.push(extraTiers);
      rewardLines.push({ val: `$${topPrize} top prize`, desc: descParts.join(' — ') });
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Partner with ${name} — Creator Program</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#fff;min-height:100vh}
.hero{background:linear-gradient(160deg,#0d0b14 0%,#12101e 60%,#0a0a0f 100%);border-bottom:1px solid rgba(255,255,255,.06);padding:72px 20px 60px;text-align:center}
.brand-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(${ar},.1);border:1px solid rgba(${ar},.25);border-radius:100px;padding:6px 16px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${accent};margin-bottom:24px}
.live-dot{width:6px;height:6px;border-radius:50%;background:${accent};box-shadow:0 0 6px ${accent};animation:pulse 2s ease-in-out infinite;display:inline-block}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
h1{font-size:clamp(26px,5vw,50px);font-weight:900;line-height:1.06;letter-spacing:-.02em;max-width:720px;margin:0 auto 16px}
.hero-sub{font-size:clamp(13px,2vw,16px);color:rgba(255,255,255,.45);max-width:500px;margin:0 auto 40px;line-height:1.7}
.section{padding:56px 20px}
.section-inner{max-width:860px;margin:0 auto}
.section-label{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px}
.section-title{font-size:clamp(18px,3vw,28px);font-weight:900;margin-bottom:8px;letter-spacing:-.01em}
.section-sub{font-size:13px;color:rgba(255,255,255,.4);line-height:1.6;margin-bottom:32px}
.divider{border:none;border-top:1px solid rgba(255,255,255,.06);margin:0}
.refimg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}
.refimg-item{position:relative;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)}
.refimg-item img{display:block;width:100%;height:auto;object-fit:cover}
.refimg-cap{font-size:12px;color:rgba(255,255,255,.55);padding:8px 10px;line-height:1.4}
/* rewards */
.rewards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.reward-card{background:rgba(${ar},.08);border:1.5px solid rgba(${ar},.22);border-radius:14px;padding:20px 18px;display:flex;flex-direction:column;gap:6px}
.reward-val{font-size:22px;font-weight:900;color:${accent};line-height:1.1}
.reward-desc{font-size:13px;color:rgba(255,255,255,.5);line-height:1.45}
.video-embed{position:relative;width:100%;max-width:860px;margin:0 auto;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.08);background:#000;aspect-ratio:16/9}
.video-embed iframe,.video-embed video{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
/* form */
.form-card{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:40px;max-width:560px;margin:0 auto}
.form-head{font-size:22px;font-weight:900;margin-bottom:6px}
.form-sub{font-size:13px;color:rgba(255,255,255,.4);margin-bottom:28px;line-height:1.6}
.f-row{margin-bottom:16px}
.f-row label{display:block;font-size:10px;font-weight:700;color:rgba(255,255,255,.38);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px}
.f-row input{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#fff;font-size:14px;padding:12px 14px;outline:none;transition:border-color .18s;width:100%;font-family:inherit}
.f-row input::placeholder{color:rgba(255,255,255,.2)}
.f-row input:focus{border-color:${accent}}
.f-hint{font-size:11px;color:rgba(255,255,255,.25);margin-top:5px}
.btn-submit{width:100%;background:${accent};color:#000;border:none;border-radius:10px;font-size:16px;font-weight:900;padding:16px;cursor:pointer;margin-top:8px;transition:opacity .2s,transform .1s;letter-spacing:.01em}
.btn-submit:hover{opacity:.88}
.btn-submit:active{transform:scale(.98)}
.btn-submit:disabled{opacity:.45;cursor:not-allowed}
.f-err{color:#ff5b5b;font-size:12px;margin-top:10px;display:none}
footer{border-top:1px solid rgba(255,255,255,.06);padding:24px 20px;text-align:center;font-size:11px;color:rgba(255,255,255,.2)}
footer a{color:${accent};text-decoration:none}
</style>
</head>
<body>

<div class="hero">
  ${brand.logoUrl ? `<img src="${brand.logoUrl}" alt="${name}" style="max-height:60px;max-width:160px;object-fit:contain;margin-bottom:14px;border-radius:8px">` : ''}
  <div class="brand-badge"><span class="live-dot"></span>&nbsp;${name} Creator Program</div>
  <h1>${cp.headline || `Partner with ${name} on TikTok Shop`}</h1>
  <div class="hero-sub">Join our affiliate creator program and start earning. Sign up below to get access to all campaigns and your Discord role.</div>
</div>

${rewardLines.length ? `
<hr class="divider">
<div class="section" style="background:rgba(${ar},.02)">
  <div class="section-inner">
    <div class="section-label">Creator Rewards</div>
    <div class="section-title">How you get paid</div>
    <div class="section-sub">Stack multiple income streams every month.</div>
    <div class="rewards-grid">${rewardLines.map(r => `<div class="reward-card"><div class="reward-val">${r.val}</div><div class="reward-desc">${r.desc}</div></div>`).join('')}</div>
  </div>
</div>` : ''}
${videoEmbedHtml}
${imagesEmbedHtml}

<hr class="divider">
<div class="section" id="signup">
  <div class="section-inner">
    <div class="form-card" id="formCard">
      <div class="form-head">Join the ${name} Creator Program</div>
      <div class="form-sub">Takes 30 seconds. You'll get instant access to all campaigns and your Verified Creator role in our Discord community.</div>
      <form id="cpForm">
        <div class="f-row"><label>Full Name *</label><input name="name" required placeholder="Jane Smith" autocomplete="name"></div>
        <div class="f-row"><label>TikTok Handle *</label><input name="tiktokHandle" required placeholder="@yourhandle"></div>
        <div class="f-row"><label>Email *</label><input name="email" type="email" required placeholder="jane@email.com" autocomplete="email"></div>
        <div class="f-row"><label>Phone *</label><input name="phone" type="tel" required placeholder="+1 555-000-0000" autocomplete="tel"></div>
        <div class="f-row">
          <label>Discord Username</label>
          <input name="discordUsername" placeholder="yourname">
          <div class="f-hint">Needed to unlock your Verified Creator role.</div>
        </div>
        <input type="hidden" name="tiktokOpenId" id="tiktokOpenIdField">
        <div class="f-err" id="cpErr"></div>
        <button type="submit" class="btn-submit" id="cpBtn">Join Now</button>
      </form>
    </div>
  </div>
</div>

<footer>Powered by <a href="https://cultcontent.cc" target="_blank">Cult Content</a> — TikTok Shop Creator Agency &nbsp;·&nbsp; <a href="/terms" target="_blank">Terms of Service</a> &nbsp;·&nbsp; <a href="/privacy" target="_blank">Privacy Policy</a></footer>

<script>
var _ttOpenId = '';
var FORM_KEY = 'creator_form_${cp.slug}';

function saveForm() {
  var data = {};
  document.querySelectorAll('#cpForm input, #cpForm textarea, #cpForm select').forEach(function(el) {
    if (el.name && el.type !== 'hidden') data[el.name] = el.value;
  });
  sessionStorage.setItem(FORM_KEY, JSON.stringify(data));
}

function restoreForm() {
  try {
    var saved = JSON.parse(sessionStorage.getItem(FORM_KEY) || '{}');
    Object.keys(saved).forEach(function(k) {
      var el = document.querySelector('#cpForm [name="' + k + '"]');
      if (el && saved[k]) el.value = saved[k];
    });
  } catch(_) {}
}

function showConnected(openId, handle) {
  _ttOpenId = openId;
  document.getElementById('tiktokOpenIdField').value = openId;
  document.getElementById('ttConnectedBadge').style.display = 'flex';
  document.getElementById('ttConnectBtn').style.display = 'none';
  if (handle) {
    document.getElementById('ttHandleDisplay').textContent = '@' + handle + ' connected ✓';
    var hField = document.querySelector('input[name="tiktokHandle"]');
    if (hField && !hField.value) hField.value = '@' + handle;
  }
  // Enable the Join Now button now that TikTok is connected
  var btn = document.getElementById('cpBtn');
  btn.disabled = false;
  btn.style.opacity = '1';
}

function connectTikTok() {
  // Save form state so we can restore it after the redirect
  saveForm();
  // Full-page redirect to TikTok OAuth (works on mobile, no popup needed)
  window.location.href = '/api/creator/connect/auth?slug=${cp.slug}';
}

// On page load: check for OAuth return params or error
(function() {
  var params = new URLSearchParams(window.location.search);
  var oid    = params.get('tt_oid');
  var handle = params.get('tt_handle');
  var ttErr  = params.get('tt_error');

  if (oid) {
    // Restore form, then show connected state
    restoreForm();
    showConnected(oid, handle || '');
    sessionStorage.removeItem(FORM_KEY);
    // Clean URL so refreshing doesn't re-trigger
    history.replaceState({}, '', window.location.pathname);
  } else if (ttErr) {
    var err = document.getElementById('cpErr');
    err.textContent = 'TikTok connection failed: ' + ttErr + ' — please try again.';
    err.style.display = 'block';
    restoreForm();
    history.replaceState({}, '', window.location.pathname);
  }

})();

document.getElementById('cpForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  var btn = document.getElementById('cpBtn');
  var err = document.getElementById('cpErr');
  btn.disabled = true; btn.textContent = 'Submitting...'; err.style.display = 'none';
  var data = Object.fromEntries(new FormData(this));
  data.brandSlug = '${cp.slug}';
  try {
    var r = await fetch('/api/creator-pages/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    var d = await r.json();
    if (d.ok && d.welcomeUrl) { window.location.href = d.welcomeUrl; }
    else if (d.ok) { btn.textContent = 'Done!'; }
    else { throw new Error(d.error || 'Unknown error'); }
  } catch(ex) {
    btn.disabled = false; btn.textContent = 'Join Now';
    err.textContent = ex.message || 'Something went wrong — please try again.';
    err.style.display = 'block';
  }
});
</script>
<script src="/ic-nav.js" defer></script>
</body>
</html>`;
}

function renderWelcomePage(brand, cp, creatorHandle = '') {
  const accent   = cp.accentColor || '#00f2ea';
  const ar       = hexToRgb(accent);
  const name     = brand.name || 'Brand';
  const campaigns = cp.campaigns || {};
  const discordInvite = process.env.DISCORD_INVITE_URL || 'https://discord.gg/cultcontent';

  const products = (cp.products || []).filter(p => p.name);
  const usps     = (cp.usps || []).filter(Boolean);
  const talking  = (cp.talkingPoints || '').split('\n').map(s => s.trim()).filter(Boolean);
  const videos   = (cp.competitorVideos || []).filter(Boolean);
  const brief    = cp.brief || null;

  const campaignBtns = [];
  if (campaigns.blitzUrl)         campaignBtns.push({ label: campaigns.blitzLabel || '🚀 Blitz Launch Campaign', sub: campaigns.blitzSub || 'Post your videos on launch day — bonus for first-15-day GMV', url: campaigns.blitzUrl });
  if (campaigns.cashbackUrl)      campaignBtns.push({ label: 'Cashback Campaign',        sub: 'Earn cashback on every sale you drive',       url: campaigns.cashbackUrl });
  if (campaigns.quantityVideoUrl) campaignBtns.push({ label: 'Video Quantity Challenge', sub: 'Post 10 videos and earn a cash bonus',        url: campaigns.quantityVideoUrl });
  if (campaigns.sprintUrl)        campaignBtns.push({ label: 'Freedom Sprint Challenge', sub: 'Hit your GMV target and earn a cash bonus',   url: campaigns.sprintUrl });
  if (campaigns.leaderboardUrl)   campaignBtns.push({ label: 'Leaderboard Challenge',    sub: 'Compete for top GMV and win monthly prizes',  url: campaigns.leaderboardUrl });
  if (campaigns.reimbursementUrl) campaignBtns.push({ label: 'Sample Reimbursement Form', sub: 'Bought your own sample? Submit your order for a full refund.', url: campaigns.reimbursementUrl });

  const btnsHtml = campaignBtns.map(c => `
    <a href="${c.url}" target="_blank" rel="noopener" class="camp-btn">
      <div class="camp-btn-text">
        <div class="camp-btn-label">${c.label}</div>
        <div class="camp-btn-sub">${c.sub}</div>
      </div>
      <div class="camp-btn-arrow">&#8594;</div>
    </a>`).join('');

  // Inline incentive cards — shown when incentives are configured (with or without external URLs)
  const inc = cp.incentives || {};
  const incentiveCards = [];
  if (inc.cashback?.enabled && inc.cashback.amount) {
    const url = campaigns.cashbackUrl || null;
    const target = inc.cashback.target ? `Hit $${Number(inc.cashback.target).toLocaleString()} GMV and earn it back as cash` : 'Earn cashback on every sale you drive';
    incentiveCards.push({ emoji: '💵', label: `$${Number(inc.cashback.amount).toLocaleString()} Cashback`, sub: target, url });
  }
  if (inc.volumeBonus?.enabled && inc.volumeBonus.bonus) {
    const url = campaigns.quantityVideoUrl || null;
    incentiveCards.push({ emoji: '🎬', label: `$${Number(inc.volumeBonus.bonus).toLocaleString()} Video Bonus`, sub: `Post ${inc.volumeBonus.quantity || 10} videos and earn a one-time cash bonus`, url });
  }
  if (inc.leaderboard?.enabled && (inc.leaderboard.places || []).length) {
    const url = campaigns.leaderboardUrl || null;
    const top = inc.leaderboard.places[0];
    const threshold = inc.leaderboard.threshold;
    const placesStr = (inc.leaderboard.places || []).map((p, i) => `${['1st','2nd','3rd'][i]||`${i+1}th`}: $${Number(p).toLocaleString()}`).join(' · ');
    incentiveCards.push({ emoji: '🏆', label: `$${Number(top).toLocaleString()} Top Prize`, sub: `Monthly leaderboard${threshold ? ` — $${Number(threshold).toLocaleString()} min GMV` : ''} — ${placesStr}`, url });
  }

  const incentiveCardsHtml = incentiveCards.length ? incentiveCards.map(c => c.url
    ? `<a href="${c.url}" target="_blank" rel="noopener" class="inc-card inc-card-link"><span class="inc-emoji">${c.emoji}</span><div class="inc-text"><div class="inc-label">${c.label}</div><div class="inc-sub">${c.sub}</div></div><div class="camp-btn-arrow">&#8594;</div></a>`
    : `<div class="inc-card"><span class="inc-emoji">${c.emoji}</span><div class="inc-text"><div class="inc-label">${c.label}</div><div class="inc-sub">${c.sub}</div></div></div>`
  ).join('') : '';

  // ── Brief sections ────────────────────────────────────────��─────────────────
  const typeLabel = { curiosity:'Curiosity', 'pain-point':'Pain Point', transformation:'Transformation', 'social-proof':'Social Proof', controversy:'Controversy', 'myth-bust':'Myth Bust' };

  const hooksHtml = brief?.hooks?.length ? `
<hr class="page-divider">
<div class="section">
  <div class="section-inner">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Content Brief</div>
    <div class="section-title">Your hook library</div>
    <div class="section-sub">Copy any of these word-for-word as your video's first 3 seconds. The hook makes or breaks your stop-rate.</div>
    <div class="hooks-grid">${brief.hooks.map(h => `
      <div class="hook-card">
        <div class="hook-text">${h.text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
        <div class="hook-type">${typeLabel[h.type] || h.type}</div>
      </div>`).join('')}
    </div>
  </div>
</div>` : '';

  const frameworksHtml = brief?.frameworks?.length ? `
<hr class="page-divider">
<div class="section" style="background:rgba(255,255,255,.015)">
  <div class="section-inner" style="max-width:680px">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Video Formats</div>
    <div class="section-title">Recommended UGC frameworks</div>
    <div class="section-sub">These formats work best for this product. Pick one and follow the structure.</div>
    <div class="frameworks-list">${brief.frameworks.map(f => `
      <div class="fw-card">
        <div class="fw-name">${f.name.replace(/</g,'&lt;')}</div>
        <div class="fw-why">${f.why.replace(/</g,'&lt;')}</div>
        <ol class="fw-steps">${(f.outline||[]).map((s,i) => `<li class="fw-step"><span class="fw-num">${i+1}</span><span>${s.replace(/</g,'&lt;')}</span></li>`).join('')}</ol>
      </div>`).join('')}
    </div>
  </div>
</div>` : '';

  const scriptsHtml = brief?.sampleScripts?.length ? `
<hr class="page-divider">
<div class="section">
  <div class="section-inner" style="max-width:680px">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Sample Scripts</div>
    <div class="section-title">Ready-to-record scripts</div>
    <div class="section-sub">Use these as-is or riff off them. Tap to expand.</div>
    <div class="scripts-list">${brief.sampleScripts.map((s,i) => `
      <div class="script-card" id="sc${i}">
        <div class="script-header" onclick="toggleScript(${i})">
          <span class="script-fw-badge">${s.framework}</span>
          <span class="script-title">${(s.title||'Script').replace(/</g,'&lt;')}</span>
          <span class="script-duration">${s.duration||'~30s'}</span>
          <span class="script-toggle">&#8964;</span>
        </div>
        <div class="script-body">${(s.script||'').replace(/</g,'&lt;').replace(/\n/g,'\n')}</div>
      </div>`).join('')}
    </div>
  </div>
</div>` : '';

  const tpHtml = brief?.talkingPoints ? `
<hr class="page-divider">
<div class="section" style="background:rgba(255,255,255,.015)">
  <div class="section-inner" style="max-width:720px">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Talking Points</div>
    <div class="section-title">What to say</div>
    <div class="section-sub">Key benefits to weave into your video, plus power phrases that drive action.</div>
    ${brief.talkingPoints.benefits?.length ? `<ul class="brief-benefits">${brief.talkingPoints.benefits.map(b=>`<li class="brief-benefit">${b.replace(/</g,'&lt;')}</li>`).join('')}</ul>` : ''}
    ${brief.talkingPoints.powerPhrases?.length ? `<div style="margin-top:4px"><div style="font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:rgba(255,255,255,.3);margin-bottom:10px">Power Phrases</div><div class="power-phrases">${brief.talkingPoints.powerPhrases.map(p=>`<span class="power-phrase">${p.replace(/</g,'&lt;')}</span>`).join('')}</div></div>` : ''}
  </div>
</div>` : '';

  const ddHtml = (brief?.doAndDont?.dos?.length || brief?.doAndDont?.donts?.length) ? `
<hr class="page-divider">
<div class="section">
  <div class="section-inner" style="max-width:720px">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Creator Guidelines</div>
    <div class="section-title">Do's and don'ts</div>
    <div class="section-sub">Follow these to maximise your conversion rate.</div>
    <div class="dd-grid">
      <div class="dd-col dos">
        <div class="dd-label">Do</div>
        <ul class="dd-list">${(brief.doAndDont.dos||[]).map(d=>`<li class="dd-item">${d.replace(/</g,'&lt;')}</li>`).join('')}</ul>
      </div>
      <div class="dd-col donts">
        <div class="dd-label">Don't</div>
        <ul class="dd-list">${(brief.doAndDont.donts||[]).map(d=>`<li class="dd-item">${d.replace(/</g,'&lt;')}</li>`).join('')}</ul>
      </div>
    </div>
  </div>
</div>` : '';

  const benchmarksHtml = brief?.benchmarks ? `
<hr class="page-divider">
<div class="section" style="background:rgba(255,255,255,.015)">
  <div class="section-inner" style="max-width:600px">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Performance Targets</div>
    <div class="section-title">What good looks like</div>
    <div class="section-sub">These are the benchmarks we use to gauge whether a video is performing. Aim for these on every post.</div>
    <div class="benchmarks-row">
      <div class="bm-card"><div class="bm-metric">&gt;30%</div><div class="bm-label">Hook Rate</div></div>
      <div class="bm-card"><div class="bm-metric">&gt;10%</div><div class="bm-label">Hold Rate</div></div>
      <div class="bm-card"><div class="bm-metric">&gt;1%</div><div class="bm-label">Click-Through Rate</div></div>
    </div>
  </div>
</div>` : '';

  const productsHtml = products.map(p => `
    <div class="product-card">
      <div class="product-name">${p.name}</div>
      ${p.minPrice ? `<div class="product-price">From $${Number(p.minPrice).toFixed(2)}</div>` : ''}
      ${p.url ? `<a href="${p.url}" target="_blank" rel="noopener" class="product-link">View on TikTok Shop</a>` : ''}
    </div>`).join('');

  const uspHtml     = usps.map(u => `<li class="usp-item"><span class="usp-check">&#10003;</span>${u}</li>`).join('');
  const talkingHtml = talking.map(t => `<li class="talking-item">${t}</li>`).join('');
  const videosHtml  = videos.map(url => {
    const vid = extractTikTokVideoId(url);
    if (!vid) return '';
    return `<div class="video-wrap"><iframe src="https://www.tiktok.com/embed/v2/${vid}" width="325" height="576" style="border:none;border-radius:12px;max-width:100%" allow="fullscreen;autoplay" scrolling="no" loading="lazy"></iframe></div>`;
  }).filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome — ${name} Creator Program</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#fff;min-height:100vh;padding:48px 20px}
.top{display:flex;flex-direction:column;align-items:center;text-align:center;max-width:520px;margin:0 auto 48px}
.card{width:100%;max-width:520px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:48px 40px;margin:0 auto}
@media(max-width:560px){.card{padding:36px 24px}}
.success-icon{font-size:52px;margin-bottom:22px}
.brand-logo{max-height:64px;max-width:180px;object-fit:contain;margin-bottom:16px;border-radius:8px}
h1{font-size:clamp(22px,4vw,30px);font-weight:900;letter-spacing:-.02em;margin-bottom:10px}
.welcome-sub{font-size:14px;color:rgba(255,255,255,.42);line-height:1.7;margin-bottom:0;max-width:380px}
.section-label{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:14px;text-align:left}
.camp-btn{display:flex;align-items:center;gap:14px;background:rgba(${ar},.07);border:1.5px solid rgba(${ar},.25);border-radius:14px;padding:18px 20px;color:#fff;text-decoration:none;margin-bottom:10px;transition:background .18s,transform .1s,border-color .18s;text-align:left}
.camp-btn:hover{background:rgba(${ar},.15);border-color:rgba(${ar},.5);transform:translateY(-1px)}
.camp-btn-text{flex:1}
.camp-btn-label{font-size:14px;font-weight:900;margin-bottom:3px}
.camp-btn-sub{font-size:12px;color:rgba(255,255,255,.42);line-height:1.4}
.camp-btn-arrow{font-size:18px;color:${accent};opacity:.7;flex-shrink:0}
.inc-card{display:flex;align-items:center;gap:14px;background:rgba(${ar},.06);border:1.5px solid rgba(${ar},.18);border-radius:14px;padding:16px 20px;margin-bottom:10px;color:#fff}
.inc-card-link{text-decoration:none;transition:background .18s,transform .1s,border-color .18s;cursor:pointer}
.inc-card-link:hover{background:rgba(${ar},.14);border-color:rgba(${ar},.45);transform:translateY(-1px)}
.inc-emoji{font-size:26px;flex-shrink:0;width:36px;text-align:center}
.inc-text{flex:1}
.inc-label{font-size:15px;font-weight:900;color:${accent};margin-bottom:3px}
.inc-sub{font-size:12px;color:rgba(255,255,255,.45);line-height:1.45}
.discord-btn{display:flex;align-items:center;justify-content:center;gap:10px;background:#5865F2;color:#fff;text-decoration:none;border-radius:14px;padding:16px 24px;font-size:14px;font-weight:900;letter-spacing:.03em;margin-top:24px;transition:transform .15s,box-shadow .15s}
.discord-btn:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(88,101,242,.35)}
.discord-icon{width:20px;height:20px;fill:#fff;flex-shrink:0}
.lark-btn{display:flex;align-items:center;justify-content:center;gap:10px;background:rgba(${ar},.12);border:1.5px solid rgba(${ar},.3);color:#fff;text-decoration:none;border-radius:14px;padding:16px 24px;font-size:14px;font-weight:900;letter-spacing:.03em;margin-top:12px;transition:transform .15s,box-shadow .15s,background .15s}
.lark-btn:hover{background:rgba(${ar},.22);border-color:rgba(${ar},.55);transform:translateY(-1px);box-shadow:0 6px 24px rgba(${ar},.2)}
.lark-icon{width:20px;height:20px;flex-shrink:0}
.divider{border:none;border-top:1px solid rgba(255,255,255,.06);margin:28px 0}
/* products */
.section{padding:48px 20px}
.section-inner{max-width:860px;margin:0 auto}
.section-title{font-size:clamp(18px,3vw,26px);font-weight:900;margin-bottom:8px;letter-spacing:-.01em}
.section-sub{font-size:13px;color:rgba(255,255,255,.4);line-height:1.6;margin-bottom:28px}
.page-divider{border:none;border-top:1px solid rgba(255,255,255,.06);margin:0}
.products-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.product-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px}
.product-name{font-size:15px;font-weight:700;margin-bottom:6px}
.product-price{font-size:13px;color:${accent};font-weight:700;margin-bottom:10px}
.product-link{font-size:12px;color:${accent};text-decoration:none;font-weight:600}
/* usps */
.usp-list{list-style:none;display:flex;flex-direction:column;gap:12px}
.usp-item{display:flex;align-items:flex-start;gap:12px;font-size:15px;font-weight:600;line-height:1.4}
.usp-check{flex-shrink:0;width:22px;height:22px;background:rgba(${ar},.15);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;color:${accent};font-weight:900}
/* videos */
.videos-scroll{display:flex;gap:16px;overflow-x:auto;padding-bottom:8px;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
.video-wrap{flex-shrink:0}
/* talking points */
.talking-list{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.talking-item{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:14px 16px 14px 32px;font-size:14px;color:rgba(255,255,255,.7);line-height:1.5;position:relative}
.talking-item::before{content:'';position:absolute;left:14px;top:18px;width:6px;height:6px;border-radius:50%;background:${accent}}
/* brief — hooks */
.hooks-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.hook-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:8px}
.hook-text{font-size:15px;font-weight:600;color:#fff;line-height:1.45}
.hook-type{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(${ar},.8);background:rgba(${ar},.1);border-radius:100px;padding:3px 10px;align-self:flex-start}
/* brief — frameworks */
.frameworks-list{display:flex;flex-direction:column;gap:14px}
.fw-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px 22px}
.fw-name{font-size:14px;font-weight:900;margin-bottom:4px;color:${accent}}
.fw-why{font-size:13px;color:rgba(255,255,255,.5);margin-bottom:12px;line-height:1.5}
.fw-steps{list-style:none;display:flex;flex-direction:column;gap:6px}
.fw-step{display:flex;gap:10px;font-size:13px;color:rgba(255,255,255,.75);line-height:1.4}
.fw-num{flex-shrink:0;width:20px;height:20px;border-radius:50%;background:rgba(${ar},.15);color:${accent};font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;margin-top:1px}
/* brief — scripts */
.scripts-list{display:flex;flex-direction:column;gap:16px}
.script-card{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;overflow:hidden}
.script-header{display:flex;align-items:center;gap:12px;padding:16px 20px;cursor:pointer;user-select:none;background:rgba(255,255,255,.02)}
.script-header:hover{background:rgba(255,255,255,.04)}
.script-fw-badge{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;background:rgba(${ar},.12);color:${accent};border-radius:100px;padding:4px 12px;flex-shrink:0}
.script-title{font-size:14px;font-weight:700;flex:1}
.script-duration{font-size:11px;color:rgba(255,255,255,.3);flex-shrink:0}
.script-toggle{font-size:16px;color:rgba(255,255,255,.3);flex-shrink:0;transition:transform .2s}
.script-body{display:none;padding:0 20px 20px;font-size:13.5px;color:rgba(255,255,255,.7);line-height:1.75;white-space:pre-wrap}
.script-card.open .script-toggle{transform:rotate(180deg)}
.script-card.open .script-body{display:block}
/* brief — talking points */
.brief-benefits{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:20px}
.brief-benefit{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:12px 14px 12px 32px;font-size:13px;color:rgba(255,255,255,.75);line-height:1.4;position:relative}
.brief-benefit::before{content:'✓';position:absolute;left:11px;top:12px;font-size:11px;font-weight:900;color:${accent}}
.power-phrases{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.power-phrase{background:rgba(${ar},.08);border:1px solid rgba(${ar},.2);border-radius:100px;padding:6px 14px;font-size:12px;font-weight:600;color:rgba(255,255,255,.8)}
/* brief — do/dont */
.dd-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:560px){.dd-grid{grid-template-columns:1fr}}
.dd-col{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:18px}
.dd-col.dos{border-color:rgba(0,210,122,.15)}
.dd-col.donts{border-color:rgba(255,60,60,.12)}
.dd-label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px}
.dd-col.dos .dd-label{color:#00d27a}
.dd-col.donts .dd-label{color:#ff6060}
.dd-list{list-style:none;display:flex;flex-direction:column;gap:8px}
.dd-item{font-size:13px;color:rgba(255,255,255,.7);line-height:1.4;padding-left:18px;position:relative}
.dd-item::before{position:absolute;left:0;font-size:12px;font-weight:900}
.dd-col.dos .dd-item::before{content:'✓';color:#00d27a}
.dd-col.donts .dd-item::before{content:'✕';color:#ff6060}
/* benchmarks */
.benchmarks-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
@media(max-width:520px){.benchmarks-row{grid-template-columns:1fr}}
.bm-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;text-align:center}
.bm-metric{font-size:22px;font-weight:900;color:${accent};margin-bottom:4px}
.bm-label{font-size:11px;font-weight:700;color:rgba(255,255,255,.4);letter-spacing:.05em;text-transform:uppercase}
footer{border-top:1px solid rgba(255,255,255,.06);padding:24px 20px;text-align:center;font-size:11px;color:rgba(255,255,255,.18)}
footer a{color:${accent};text-decoration:none}
/* earn pill */
.earn-pill{display:inline-flex;align-items:center;gap:8px;background:rgba(${ar},.12);border:1px solid rgba(${ar},.3);border-radius:100px;padding:8px 20px;font-size:13px;font-weight:700;color:${accent};margin-top:16px}
/* next steps */
.steps-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:20px 24px;margin-top:20px;text-align:left;width:100%;max-width:520px}
.steps-label{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:14px}
.steps-list{list-style:none;display:flex;flex-direction:column;gap:10px}
.step-item{display:flex;align-items:flex-start;gap:12px;font-size:14px;color:rgba(255,255,255,.8);line-height:1.4}
.step-num{flex-shrink:0;width:22px;height:22px;border-radius:50%;background:rgba(${ar},.15);color:${accent};font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;margin-top:1px}
/* blitz tiers */
.blitz-tiers{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.blitz-tier{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(${ar},.06);border:1px solid rgba(${ar},.15);border-radius:10px;font-size:13px}
.blitz-tier-gmv{font-weight:700;color:rgba(255,255,255,.7)}
.blitz-tier-bonus{font-weight:900;color:${accent}}
</style>
</head>
<body>

<div class="top">
  ${brand.logoUrl ? `<img src="${brand.logoUrl}" alt="${name} logo" class="brand-logo">` : '<div class="success-icon">&#127881;</div>'}
  <h1>Welcome to the ${name} Creator Program</h1>
  <div class="welcome-sub">${cp.welcomeMessage || 'You\'re officially in. Sign up for the campaigns below and join the creator community.'}</div>
  ${cp.earnPotential ? `<div class="earn-pill">💰 Up to $${Number(cp.earnPotential).toLocaleString()} in bonuses${cp.tcCommission ? ` + ${cp.tcCommission}% commission` : ''}</div>` : ''}
  ${(cp.welcomeSteps || []).length ? `
  <div class="steps-card">
    <div class="steps-label">Your next steps</div>
    <ol class="steps-list">${(cp.welcomeSteps || []).map((s, i) => `
      <li class="step-item"><span class="step-num">${i + 1}</span><span>${s}</span></li>`).join('')}
    </ol>
  </div>` : ''}
</div>

<div class="card">
  ${btnsHtml ? `
  <div class="section-label">Sign Up for Campaigns</div>
  <div style="font-size:13px;color:rgba(255,255,255,.55);margin:-4px 0 14px">Click the buttons below to join.</div>
  ${btnsHtml}
  ${(cp.blitzTiers || []).length ? `
  <div style="margin-top:4px;margin-bottom:16px">
    <div style="font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:8px">Blitz Bonus Tiers — First 15 Days</div>
    <div class="blitz-tiers">${(cp.blitzTiers || []).map(t => `
      <div class="blitz-tier">
        <span class="blitz-tier-gmv">$${Number(t.gmv).toLocaleString()}+ GMV</span>
        <span class="blitz-tier-bonus">+$${Number(t.bonus).toLocaleString()} cash</span>
      </div>`).join('')}
    </div>
  </div>` : ''}
  <div class="divider"></div>` : ''}

  <div class="section-label">Join the Community</div>
  <a href="${discordInvite}" target="_blank" rel="noopener" class="discord-btn">
    <svg class="discord-icon" viewBox="0 0 127.14 96.36" xmlns="http://www.w3.org/2000/svg"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>
    Join the Discord
  </a>
  ${cp.larkGroupUrl ? `
  <a href="${cp.larkGroupUrl}" target="_blank" rel="noopener" class="lark-btn">
    <svg class="lark-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="${accent}"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.5 14.5l-5-3V7h1.5v5.75l4.25 2.5-.75 1.25z"/></svg>
    Join the ${name} Creator Community on Lark
  </a>` : ''}
</div>

${hooksHtml}
${frameworksHtml}
${scriptsHtml}
${tpHtml}
${ddHtml}
${benchmarksHtml}

${productsHtml ? `
<hr class="page-divider">
<div class="section">
  <div class="section-inner">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Products to Promote</div>
    <div class="section-title">What you'll be featuring</div>
    <div class="section-sub">High-converting products with strong customer reviews.</div>
    <div class="products-grid">${productsHtml}</div>
  </div>
</div>` : ''}

${uspHtml ? `
<hr class="page-divider">
<div class="section" style="background:rgba(255,255,255,.02)">
  <div class="section-inner" style="max-width:600px">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Why creators love ${name}</div>
    <div class="section-title">Built to convert</div>
    <div class="section-sub">Products your audience will actually want to buy.</div>
    <ul class="usp-list">${uspHtml}</ul>
  </div>
</div>` : ''}

${videosHtml ? `
<hr class="page-divider">
<div class="section">
  <div class="section-inner">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Content That Converts</div>
    <div class="section-title">Examples to inspire your videos</div>
    <div class="section-sub">High-performing content formats for this niche.</div>
    <div class="videos-scroll">${videosHtml}</div>
  </div>
</div>` : ''}

${talkingHtml ? `
<hr class="page-divider">
<div class="section" style="background:rgba(255,255,255,.02)">
  <div class="section-inner">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Creator Brief</div>
    <div class="section-title">Key talking points</div>
    <div class="section-sub">Weave these into your content for the best results.</div>
    <ul class="talking-list">${talkingHtml}</ul>
  </div>
</div>` : ''}

${(() => { const guideUrl = cp.guideUrl || (brief && brief.guideUrl) || ''; if (!guideUrl) return ''; return `
<hr class="page-divider">
<div class="section">
  <div class="section-inner">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">The Full Playbook</div>
    <div class="section-title">Go deeper</div>
    <div class="section-sub">The complete creator guide — hooks, scripts, FAQs, do\u0027s and don\u0027ts, and how to use the product on camera.</div>
    <a href="${guideUrl}" target="_blank" rel="noopener" class="camp-btn" style="margin-top:16px">
      <div class="camp-btn-text">
        <div class="camp-btn-label">\ud83d\udcd6 Read the full ${name} playbook</div>
        <div class="camp-btn-sub">Everything you need to make content that converts</div>
      </div>
      <div class="camp-btn-arrow">\u2192</div>
    </a>
  </div>
</div>`; })()}

${cp.productRequestEnabled ? `
<hr class="page-divider">
<div class="section">
  <div class="section-inner" style="max-width:600px">
    <div class="section-label" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px">Product Requests</div>
    <div class="section-title">Want to try something specific?</div>
    <div class="section-sub">Select a product below or tell us what you'd like from the catalog. We'll get it sorted.</div>
    <form id="product-req-form" style="margin-top:20px">
      ${creatorHandle ? `<input type="hidden" id="pr-handle" value="${creatorHandle.replace(/"/g,'&quot;')}">` : `
      <div style="margin-bottom:14px">
        <label style="display:block;font-size:12px;font-weight:700;color:rgba(255,255,255,.5);margin-bottom:6px;letter-spacing:.04em;text-transform:uppercase">Your TikTok Handle</label>
        <input id="pr-handle" type="text" placeholder="@yourhandle" style="width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;color:#fff;font-size:14px;outline:none" required>
      </div>`}
      ${(cp.catalogProducts || []).length ? `
      <div style="margin-bottom:14px">
        <div style="font-size:12px;font-weight:700;color:rgba(255,255,255,.5);margin-bottom:10px;letter-spacing:.04em;text-transform:uppercase">Available Products</div>
        <div id="pr-products" style="display:flex;flex-direction:column;gap:8px">
          ${(cp.catalogProducts || []).map((p, i) => `
          <label style="display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.03);border:1.5px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 16px;cursor:pointer;transition:border-color .15s" class="pr-product-label" data-i="${i}">
            <input type="checkbox" name="product" value="${p.name.replace(/"/g,'&quot;')}" style="width:16px;height:16px;accent-color:${accent};flex-shrink:0">
            <div>
              <div style="font-size:14px;font-weight:700">${p.name}</div>
              ${p.description ? `<div style="font-size:12px;color:rgba(255,255,255,.4);margin-top:2px;line-height:1.4">${p.description}</div>` : ''}
            </div>
          </label>`).join('')}
        </div>
      </div>` : ''}
      <div style="margin-bottom:14px">
        <label style="display:block;font-size:12px;font-weight:700;color:rgba(255,255,255,.5);margin-bottom:6px;letter-spacing:.04em;text-transform:uppercase">Other products from the catalog?</label>
        <input id="pr-other" type="text" placeholder="e.g. Collagen, Keto supplement…" style="width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;color:#fff;font-size:14px;outline:none">
      </div>
      <div style="margin-bottom:20px">
        <label style="display:block;font-size:12px;font-weight:700;color:rgba(255,255,255,.5);margin-bottom:6px;letter-spacing:.04em;text-transform:uppercase">Anything else to add?</label>
        <textarea id="pr-note" rows="3" placeholder="Content angles you're planning, audience info, special requests…" style="width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;color:#fff;font-size:14px;outline:none;resize:vertical;line-height:1.5"></textarea>
      </div>
      <button type="submit" id="pr-submit" style="width:100%;background:${accent};color:#000;font-size:14px;font-weight:900;border:none;border-radius:12px;padding:16px;cursor:pointer;letter-spacing:.02em;transition:opacity .15s">
        Send Request
      </button>
      <div id="pr-success" style="display:none;text-align:center;padding:20px;background:rgba(0,210,122,.08);border:1px solid rgba(0,210,122,.2);border-radius:12px;margin-top:4px">
        <div style="font-size:22px;margin-bottom:8px">✅</div>
        <div style="font-size:15px;font-weight:700;color:#00d27a">Request sent!</div>
        <div style="font-size:13px;color:rgba(255,255,255,.5);margin-top:4px">We'll follow up within 24 hours.</div>
      </div>
    </form>
  </div>
</div>` : ''}

<footer>Powered by <a href="https://cultcontent.cc" target="_blank">Cult Content</a> &nbsp;·&nbsp; <a href="/terms" target="_blank">Terms of Service</a> &nbsp;·&nbsp; <a href="/privacy" target="_blank">Privacy Policy</a></footer>

<script>
function toggleScript(i){
  var c=document.getElementById('sc'+i);
  if(c)c.classList.toggle('open');
}
// Product request form
(function(){
  var form=document.getElementById('product-req-form');
  if(!form)return;
  // Highlight selected product cards
  document.querySelectorAll('.pr-product-label').forEach(function(lbl){
    var cb=lbl.querySelector('input[type=checkbox]');
    if(cb)cb.addEventListener('change',function(){
      lbl.style.borderColor=cb.checked?'rgba(${ar},.5)':'rgba(255,255,255,.08)';
    });
  });
  form.addEventListener('submit',async function(e){
    e.preventDefault();
    var btn=document.getElementById('pr-submit');
    var handleEl=document.getElementById('pr-handle');
    var handle=(handleEl?handleEl.value:'').replace(/^@/,'').trim();
    if(!handle){handleEl&&(handleEl.style.borderColor='rgba(255,80,80,.6)');return;}
    var products=Array.from(document.querySelectorAll('#pr-products input:checked')).map(function(c){return c.value;});
    var other=(document.getElementById('pr-other')||{}).value||'';
    var note=(document.getElementById('pr-note')||{}).value||'';
    btn.disabled=true;btn.textContent='Sending…';
    try{
      var r=await fetch('/api/creator-pages/${cp.slug || ''}/product-request',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({handle,products,otherProducts:other,note}),
      });
      if(r.ok){
        form.style.display='none';
        document.getElementById('pr-success').style.display='block';
      }else{btn.disabled=false;btn.textContent='Send Request';}
    }catch(_){btn.disabled=false;btn.textContent='Send Request';}
  });
})();
</script>
<script src="/ic-nav.js" defer></script>
</body>
</html>`;
}

// (Public /creators/:brandSlug and /api/creator-pages/submit are registered before requireAuth above)

// POST /api/creator-pages/:slug/product-request — creator requests a product from the catalog
// Pings the Cult Content ops Lark channel with the request details
app.post('/api/creator-pages/:slug/product-request', async (req, res) => {
  const { slug } = req.params;
  const { handle = '', products = [], otherProducts = '', note = '' } = req.body || {};
  const cleanHandle = handle.replace(/^@/, '').trim();
  if (!cleanHandle) return res.status(400).json({ ok: false, error: 'handle required' });

  const brands = loadBrands();
  const brand  = (brands.clients || []).find(b => b.creatorPage?.slug === slug);
  if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

  const lines = [
    `📦 Product Request — ${brand.name}`,
    `Creator: @${cleanHandle}`,
  ];
  if (products.length)  lines.push(`Products: ${products.join(', ')}`);
  if (otherProducts)    lines.push(`Other: ${otherProducts}`);
  if (note)             lines.push(`Note: ${note}`);

  try {
    await axios.post(`${CFG.railwayUrl}/command`, {
      text:    lines.join('\n'),
      context: 'Product Request',
      source:  'Creator Welcome Page',
    }, { timeout: 10000 });
    console.log(`[product-request] ${brand.name} — @${cleanHandle}: ${[...products, otherProducts].filter(Boolean).join(', ')}`);
    // Also persist to a Lark Bitable sheet (non-blocking, env-gated)
    try {
      const APP_TOKEN = process.env.CREATOR_REQUEST_BITABLE_APP_TOKEN;
      const TABLE_ID  = process.env.CREATOR_REQUEST_BITABLE_TABLE_ID;
      const L_ID = process.env.LARK_APP_ID, L_SECRET = process.env.LARK_APP_SECRET;
      if (APP_TOKEN && TABLE_ID && L_ID && L_SECRET) {
        const { data: authData } = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', { app_id: L_ID, app_secret: L_SECRET });
        const ltoken = authData.tenant_access_token;
        if (ltoken) {
          await axios.post(
            `https://open.larksuite.com/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`,
            { fields: {
                'Brand':    brand.name,
                'Creator':  `@${cleanHandle}`,
                'Products': [...products, otherProducts].filter(Boolean).join(', '),
                'Note':     note || '',
                'Submitted': Date.now(),
            } },
            { headers: { Authorization: `Bearer ${ltoken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
          );
          console.log(`[product-request] saved to Bitable for ${brand.name}`);
        }
      }
    } catch (be) { console.error('[product-request] Bitable save failed (non-fatal):', be.response?.data?.msg || be.message); }
    res.json({ ok: true });
  } catch(e) {
    console.error('[product-request] Lark error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to send request' });
  }
});

// GET /api/creator-pages/:slug/brief — public, returns the generated creator brief for a brand
app.get('/api/creator-pages/:slug/brief', (req, res) => {
  const brands = loadBrands();
  const brand  = (brands.clients || []).find(b => b.creatorPage?.slug === req.params.slug);
  if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });
  res.json({ ok: true, brief: brand.creatorPage?.brief || null, brandName: brand.name });
});

// GET /api/creator-pages — List all brands with creator page status
app.get('/api/creator-pages', requireAuth, (req, res) => {
  const brands  = loadBrands();
  const baseUrl = PUBLIC_BASE_URL;
  const pages   = (brands.clients || []).map(b => ({
    id:        b.id,
    name:      b.name,
    creatorPage: b.creatorPage || null,
    publicUrl: b.creatorPage?.slug ? `${CREATOR_BASE_URL}/creators/${b.creatorPage.slug}` : null,
  }));
  res.json({ ok: true, pages, baseUrl });
});

// POST /api/creator-pages/:brandId/setup — Create or update creator page for a brand
app.post('/api/creator-pages/:brandId/setup', requireAuth, (req, res) => {
  const data = loadBrands();
  const idx  = data.clients.findIndex(b => b.id === req.params.brandId);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Brand not found' });

  const brand   = data.clients[idx];
  const slug    = req.body.slug || slugify(brand.name);
  const tagName = `creator-interested-${slug}`;

  data.clients[idx].creatorPage = {
    slug,
    tagName,
    active:      true,
    headline:    req.body.headline    || `Partner with ${brand.name}`,
    subheadline: req.body.subheadline || `Join our TikTok Shop creator affiliate program`,
    pitch:       req.body.pitch       || `We're looking for TikTok creators to promote ${brand.name} products on TikTok Shop. Our team will review your application and reach out within 48 hours.`,
    accentColor: req.body.accentColor || '#00f2ea',
    createdAt:   brand.creatorPage?.createdAt || new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };

  saveBrands(data);
  const publicUrl = `${CREATOR_BASE_URL}/creators/${slug}`;
  console.log(`[creator-pages] Setup page for ${brand.name}: ${publicUrl}`);

  // Create Lark creator community group (fire-and-forget, don't block response)
  const setupBrandId = req.params.brandId;
  const setupBrandName = brand.name;
  createLarkCreatorGroup(setupBrandName).then(group => {
    if (group?.shareLink) {
      const d = loadBrands();
      const i = d.clients.findIndex(b => b.id === setupBrandId);
      if (i !== -1) {
        d.clients[i].creatorPage.larkGroupUrl = group.shareLink;
        d.clients[i].creatorPage.larkChatId  = group.chatId;
        saveBrands(d);
        console.log(`[lark] Creator group created for ${setupBrandName}: ${group.shareLink}`);
      }
    }
  }).catch(e => console.error('[lark] creator group error:', e.message));

  res.json({ ok: true, brand: data.clients[idx], publicUrl });
});

// PUT /api/creator-pages/:brandId — Update creator page content / toggle active
app.put('/api/creator-pages/:brandId', requireAuth, (req, res) => {
  const data = loadBrands();
  const idx  = data.clients.findIndex(b => b.id === req.params.brandId);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Brand not found' });
  if (!data.clients[idx].creatorPage) return res.status(400).json({ ok: false, error: 'No creator page set up yet' });

  data.clients[idx].creatorPage = {
    ...data.clients[idx].creatorPage,
    ...req.body,
    updatedAt: new Date().toISOString(),
  };
  saveBrands(data);
  const publicUrl = `${CREATOR_BASE_URL}/creators/${data.clients[idx].creatorPage.slug}`;
  res.json({ ok: true, brand: data.clients[idx], publicUrl });
});

// PATCH /api/brands/:brandId/campaign-links — save Reacher campaign URLs + competitor videos
app.patch('/api/brands/:brandId/campaign-links', requireAuth, express.json(), (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  if (!brands.clients[idx].creatorPage) brands.clients[idx].creatorPage = {};
  const cp = brands.clients[idx].creatorPage;
  if (!cp.campaigns) cp.campaigns = {};
  const { cashbackUrl, quantityVideoUrl, leaderboardUrl, sprintUrl, reimbursementUrl, competitorVideos } = req.body;
  if (cashbackUrl     !== undefined) cp.campaigns.cashbackUrl     = cashbackUrl     || null;
  if (quantityVideoUrl !== undefined) cp.campaigns.quantityVideoUrl = quantityVideoUrl || null;
  if (leaderboardUrl  !== undefined) cp.campaigns.leaderboardUrl  = leaderboardUrl  || null;
  if (sprintUrl       !== undefined) cp.campaigns.sprintUrl       = sprintUrl       || null;
  if (reimbursementUrl !== undefined) cp.campaigns.reimbursementUrl = reimbursementUrl || null;
  if (competitorVideos !== undefined) cp.competitorVideos = (Array.isArray(competitorVideos) ? competitorVideos : []).slice(0, 8).filter(Boolean);
  cp.updatedAt = new Date().toISOString();
  saveBrands(brands);
  console.log(`[campaign-links] Updated for brand ${req.params.brandId}`);
  res.json({ ok: true, campaigns: cp.campaigns, competitorVideos: cp.competitorVideos });
});

// POST /api/brands/:brandId/activate-dm — activate the paused outreach DM automation
app.post('/api/brands/:brandId/activate-dm', requireAuth, express.json(), async (req, res) => {
  const brands = loadBrands();
  const brand = (brands.clients || []).find(b => b.id === req.params.brandId);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  const automationId = brand.creatorPage?.dmAutomationId;
  const shopId = brand.shopId;
  if (!automationId) return res.status(400).json({ error: 'No DM automation found — run onboarding pipeline first' });
  if (!shopId) return res.status(400).json({ error: 'No Reacher shop linked to this brand' });
  try {
    const { data } = await axios.patch(
      `${CFG.railwayUrl}/affiliate/shops/${shopId}/automations/${automationId}/activate`,
      { dailyCap: req.body.dailyCap || 20 },
      { timeout: 15000 }
    );
    console.log(`[activate-dm] Activated automation ${automationId} for ${brand.name}`);
    res.json({ ok: true, automationId, result: data });
  } catch(e) {
    console.error('[activate-dm] error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.detail || e.message });
  }
});

// GET /api/creator-pages/:brandId/competitor-videos
app.get('/api/creator-pages/:brandId/competitor-videos', requireAuth, (req, res) => {
  const brands = loadBrands();
  const brand = (brands.clients || []).find(b => b.id === req.params.brandId);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  res.json({ videos: brand.creatorPage?.competitorVideos || [] });
});

// PUT /api/creator-pages/:brandId/competitor-videos
app.put('/api/creator-pages/:brandId/competitor-videos', requireAuth, express.json(), (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
  if (!brands.clients[idx].creatorPage) brands.clients[idx].creatorPage = {};
  brands.clients[idx].creatorPage.competitorVideos = (req.body.videos || []).slice(0, 8);
  brands.clients[idx].creatorPage.updatedAt = new Date().toISOString();
  saveBrands(brands);
  res.json({ ok: true });
});

// ─── Brand Logo Upload ─────────────────────────��───────────────────────────────

// Multer instance for images (jpg/png/gif/webp/svg)
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
      const ext  = path.extname(file.originalname) || '.jpg';
      const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
      cb(null, `${Date.now()}_${base}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_, file, cb) => {
    const ok = /image\//i.test(file.mimetype) || /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(file.originalname);
    cb(null, ok);
  },
});

// Multer instance for product media (images + videos, up to 20 files)
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
      const ext  = path.extname(file.originalname) || '.jpg';
      const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
      cb(null, `${Date.now()}_${base}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /image\//i.test(file.mimetype)
            || /video\//i.test(file.mimetype)
            || /\.(jpe?g|png|gif|webp|svg|avif|mp4|mov|avi|webm|mkv)$/i.test(file.originalname)
            || file.mimetype === 'application/octet-stream';
    cb(null, ok);
  },
});

// POST /api/brands/:brandId/logo — upload or replace brand logo
app.post('/api/brands/:brandId/logo', requireAuth, imageUpload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file received' });
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });

  // Delete old logo file if it exists
  const oldLogoUrl = brands.clients[idx].logoUrl;
  if (oldLogoUrl) {
    const oldFilename = path.basename(oldLogoUrl.split('?')[0]);
    const oldPath = path.join(UPLOAD_DIR, oldFilename);
    if (oldPath.startsWith(UPLOAD_DIR)) fs.unlink(oldPath, () => {});
  }

  const logoUrl = `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`;
  brands.clients[idx].logoUrl = logoUrl;
  saveBrands(brands);
  res.json({ ok: true, logoUrl });
});

// DELETE /api/brands/:brandId/logo — remove brand logo
app.delete('/api/brands/:brandId/logo', requireAuth, (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });

  const logoUrl = brands.clients[idx].logoUrl;
  if (logoUrl) {
    const filename = path.basename(logoUrl.split('?')[0]);
    const filePath = path.join(UPLOAD_DIR, filename);
    if (filePath.startsWith(UPLOAD_DIR)) fs.unlink(filePath, () => {});
  }
  delete brands.clients[idx].logoUrl;
  saveBrands(brands);
  res.json({ ok: true });
});

// NOTE: POST/DELETE /api/client/logo moved BEFORE app.use(requireAuth) — see ~L5010.
// They were unreachable here: requireAuth (Cloudflare Access) 401d client sessions first.

// ─── Product Media Upload ───────────────────────────────────────────────────────

// POST /api/brands/:brandId/product-media — upload up to 20 images/videos
app.post('/api/brands/:brandId/product-media', requireAuth, mediaUpload.array('media', 20), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files received' });
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });

  if (!brands.clients[idx].productMedia) brands.clients[idx].productMedia = [];

  const newFiles = req.files.map(f => {
    const isVideo = /video\//i.test(f.mimetype) || /\.(mp4|mov|avi|webm|mkv)$/i.test(f.originalname);
    return {
      url: `${PUBLIC_BASE_URL}/uploads/${f.filename}`,
      filename: f.filename,
      originalName: f.originalname,
      type: isVideo ? 'video' : 'image',
      uploadedAt: new Date().toISOString(),
    };
  });

  brands.clients[idx].productMedia.push(...newFiles);
  saveBrands(brands);
  res.json({ ok: true, media: newFiles });
});

// GET /api/brands/:brandId/product-media — list all product media
app.get('/api/brands/:brandId/product-media', requireAuth, (req, res) => {
  const brands = loadBrands();
  const brand = (brands.clients || []).find(b => b.id === req.params.brandId);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  res.json({ ok: true, media: brand.productMedia || [] });
});

// DELETE /api/brands/:brandId/product-media/:filename — remove one item
app.delete('/api/brands/:brandId/product-media/:filename', requireAuth, (req, res) => {
  const brands = loadBrands();
  const idx = (brands.clients || []).findIndex(b => b.id === req.params.brandId);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });

  const filename = req.params.filename;
  const filePath = path.join(UPLOAD_DIR, filename);
  if (filePath.startsWith(UPLOAD_DIR)) fs.unlink(filePath, () => {});

  brands.clients[idx].productMedia = (brands.clients[idx].productMedia || []).filter(m => m.filename !== filename);
  saveBrands(brands);
  res.json({ ok: true });
});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'dashboard' }));

// ── Startup: ensure known contact names are set on manually-added brands ──────���
(function migrateContactNames() {
  try {
    const data = loadBrands();
    // Known contacts from onboarding — fill in if missing
    const knownContacts = { 'Approved Science': 'Lenea' };
    let changed = false;
    for (const brand of (data.clients || [])) {
      if (knownContacts[brand.name] && !brand.contactName) {
        brand.contactName = knownContacts[brand.name];
        changed = true;
        console.log(`[startup] Set contactName "${knownContacts[brand.name]}" for brand "${brand.name}"`);
      }
    }
    if (changed) saveBrands(data);
  } catch(e) { console.error('[startup] migrateContactNames:', e.message); }
})();

// ─── AI Post Synthesizer — extract insight + captions from transcript ────────
app.post('/api/ai/synthesize-post', async (req, res) => {
  const { transcript, brand = 'tommy' } = req.body || {};
  if (!transcript) return res.status(400).json({ ok: false, error: 'transcript required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });

  const brandCtx = brand === 'cc'
    ? 'Cult Content (a TikTok Shop affiliate marketing agency that helps brands scale with creators)'
    : 'Tommy Lynch (entrepreneur, TikTok Shop expert, lives in a school bus — personal brand with raw, authentic voice)';

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1200,
      system: `You are a social media content strategist for ${brandCtx}. Extract the single most compelling insight from this transcript and craft platform-native captions. Return ONLY valid JSON:
{
  "quote": "The single most quotable line (verbatim or lightly cleaned, max 15 words)",
  "insight": "The core idea in one punchy sentence",
  "caption_linkedin": "Professional insight-driven caption, 150-250 chars, end with 3-4 hashtags",
  "caption_twitter": "Hook-first tweet, max 240 chars, 2-3 hashtags",
  "caption_instagram": "Conversational caption with strong hook, max 160 chars, 5-7 hashtags",
  "image_prompt": "DALL-E 3 prompt for a dark cosmic surrealist image that visually represents this insight. Style: deep purples and teals, ethereal mist, symbolic objects floating in void, dramatic chiaroscuro lighting, no text or words, painterly digital art"
}`,
      messages: [{ role: 'user', content: `Transcript:\n${transcript.slice(0, 8000)}` }],
    });

    let raw = msg.content?.[0]?.text || '';
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(raw);
    res.json({ ok: true, ...parsed });
  } catch(e) {
    console.error('[synthesize-post]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ─── AI Image Generation — DALL-E 3 ──────────────────────────────────────────
app.post('/api/ai/generate-image', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY not configured' });

  try {
    const r = await axios.post('https://api.openai.com/v1/images/generations', {
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      response_format: 'url',
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 90000,
    });
    const imageUrl = r.data?.data?.[0]?.url;
    res.json({ ok: true, url: imageUrl, revised_prompt: r.data?.data?.[0]?.revised_prompt });
  } catch(e) {
    console.error('[generate-image]', e.response?.data || e.message);
    res.json({ ok: false, error: e.response?.data?.error?.message || e.message });
  }
});

// Startup migration: activate any creator pages stuck as false, fix old Railway publicUrls
(function migrateCreatorPages() {
  try {
    const OLD_RAILWAY = 'https://cult-command-center-production.up.railway.app';
    // Fix brands.json — set active: true on any page that was created (active===false from old default)
    const brandsData = loadBrands();
    let brandsDirty = false;
    for (const b of (brandsData.clients || [])) {
      if (b.creatorPage && b.creatorPage.active === false) {
        b.creatorPage.active = true;
        if (b.creatorPage.publicUrl?.startsWith(OLD_RAILWAY)) {
          b.creatorPage.publicUrl = b.creatorPage.publicUrl.replace(OLD_RAILWAY, PUBLIC_BASE_URL);
        }
        brandsDirty = true;
      }
    }
    if (brandsDirty) { saveBrands(brandsData); console.log('[migrate] Activated existing creator pages'); }

    // Fix onboard-pending.json — patch old Railway publicUrls
    const pending = loadPendingOnboards();
    let pendingDirty = false;
    for (const p of pending) {
      if (p.creatorPage?.publicUrl?.startsWith(OLD_RAILWAY)) {
        p.creatorPage.publicUrl = p.creatorPage.publicUrl.replace(OLD_RAILWAY, PUBLIC_BASE_URL);
        pendingDirty = true;
      }
    }
    if (pendingDirty) { savePendingOnboards(pending); console.log('[migrate] Patched creator page URLs in pending onboards'); }
  } catch(e) { console.error('[migrate] creator pages:', e.message); }
})();

// ─── Brand Call Schedules (Inner Circle weekly calls) ────────────
// Admin-only CRUD for per-brand weekly creator call schedules. Drives automated
// SMS reminders + recording association. Backed by the inner_circle.db SQLite
// volume (shared handle from ./db/inner-circle). Registered BEFORE app.listen().
let icDb;
try { ({ db: icDb } = require('./db/inner-circle')); }
catch (e) {
  console.error('[db/inner-circle] load failed:', e.message);
  const _noOp = { all: () => [], get: () => null, run: () => ({}) };
  icDb = { prepare: () => _noOp };
}

// Allowed day values (lowercase). NULL = TBD is permitted.
const VALID_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// GET /api/inner-circle/brand-schedules — all rows (admin only)
app.get('/api/inner-circle/brand-schedules', requirePortalAdmin, (req, res) => {
  try {
    const rows = icDb.prepare(
      `SELECT id, shop_id, brand_id, brand_name, call_day, call_time, timezone,
              duration_minutes, meeting_url, active, created_at, updated_at
       FROM brand_call_schedules
       ORDER BY active DESC, brand_name ASC`
    ).all();
    res.json({ schedules: rows });
  } catch (e) {
    console.error('[brand-schedules] list failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/inner-circle/brand-schedules/:id — update mutable fields (admin only)
app.put('/api/inner-circle/brand-schedules/:id', requirePortalAdmin, express.json(), (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const existing = icDb.prepare(`SELECT * FROM brand_call_schedules WHERE id = ?`).get(id);
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    const b = req.body || {};

    // Validate call_day (allow null/empty to clear)
    let call_day = existing.call_day;
    if ('call_day' in b) {
      if (b.call_day === null || b.call_day === '') {
        call_day = null;
      } else if (typeof b.call_day === 'string' && VALID_DAYS.includes(b.call_day.toLowerCase())) {
        call_day = b.call_day.toLowerCase();
      } else {
        return res.status(400).json({ error: `call_day must be one of ${VALID_DAYS.join(', ')} or null` });
      }
    }

    // Validate call_time HH:MM 24h (allow null/empty to clear)
    let call_time = existing.call_time;
    if ('call_time' in b) {
      if (b.call_time === null || b.call_time === '') {
        call_time = null;
      } else if (typeof b.call_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.call_time)) {
        call_time = b.call_time;
      } else {
        return res.status(400).json({ error: 'call_time must be HH:MM (24h) or null' });
      }
    }

    // timezone (non-empty string)
    let timezone = existing.timezone;
    if ('timezone' in b) {
      if (typeof b.timezone === 'string' && b.timezone.trim()) {
        timezone = b.timezone.trim();
      } else {
        return res.status(400).json({ error: 'timezone must be a non-empty string' });
      }
    }

    // duration_minutes (positive integer)
    let duration_minutes = existing.duration_minutes;
    if ('duration_minutes' in b) {
      const d = parseInt(b.duration_minutes, 10);
      if (Number.isInteger(d) && d > 0 && d <= 600) {
        duration_minutes = d;
      } else {
        return res.status(400).json({ error: 'duration_minutes must be a positive integer (<=600)' });
      }
    }

    // meeting_url (allow null/empty to clear)
    let meeting_url = existing.meeting_url;
    if ('meeting_url' in b) {
      meeting_url = (b.meeting_url === null || b.meeting_url === '') ? null : String(b.meeting_url).trim();
    }

    // active (coerce truthy/0/1/string → 1/0)
    let active = existing.active;
    if ('active' in b) {
      if (b.active === true || b.active === 1 || b.active === '1' || b.active === 'true') active = 1;
      else if (b.active === false || b.active === 0 || b.active === '0' || b.active === 'false') active = 0;
      else return res.status(400).json({ error: 'active must be boolean (0/1)' });
    }

    icDb.prepare(
      `UPDATE brand_call_schedules
         SET call_day = ?, call_time = ?, timezone = ?, duration_minutes = ?,
             meeting_url = ?, active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(call_day, call_time, timezone, duration_minutes, meeting_url, active, id);

    const updated = icDb.prepare(
      `SELECT id, shop_id, brand_id, brand_name, call_day, call_time, timezone,
              duration_minutes, meeting_url, active, created_at, updated_at
       FROM brand_call_schedules WHERE id = ?`
    ).get(id);

    res.json({ ok: true, schedule: updated });
  } catch (e) {
    console.error('[brand-schedules] update failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(CFG.port, () => {
  console.log(`\n⚡ Cult Content Command Center`);
  console.log(`   http://localhost:${CFG.port}\n`);

  // One-time fix — correct Lode WTR cashback target 96 → 100
  try {
    const bd = loadBrands();
    const lode = (bd.clients || []).find(b => (b.name || '').toLowerCase().includes('lode'));
    if (lode?.creatorPage?.incentives?.cashback?.target == 96) {
      lode.creatorPage.incentives.cashback.target = 100;
      saveBrands(bd);
      console.log('[startup] Fixed Lode WTR cashback target: 96 → 100');
    }
    // Also fix in pending onboards
    const po = loadPendingOnboards();
    let poDirty = false;
    for (const e of po) {
      if ((e.formData?.brandName || '').toLowerCase().includes('lode') && e.formData?.compensation?.cashback?.target == 96) {
        e.formData.compensation.cashback.target = 100;
        if (e.aiContent) e.aiContent = null; // re-gen on approve
        poDirty = true;
      }
    }
    if (poDirty) { savePendingOnboards(po); console.log('[startup] Fixed Lode WTR cashback in pending onboards'); }
  } catch(e) { console.error('[startup] Lode WTR cashback fix error:', e.message); }

  // One-time fix — AS Inner Circle July Freedom leaderboard: update stale places/threshold
  try {
    const bd = loadBrands();
    const as = (bd.clients || []).find(b => (b.brandSlug || b.name || '').toLowerCase().includes('approved-science') || (b.name || '').toLowerCase().includes('approved science'));
    const lb = as?.creatorPage?.incentives?.leaderboard;
    if (lb && (JSON.stringify(lb.places) !== JSON.stringify([1500,1000,500]) || lb.threshold !== 2000)) {
      lb.places = [1500, 1000, 500];
      lb.threshold = 2000;
      saveBrands(bd);
      console.log('[startup] Fixed AS Inner Circle leaderboard: places=[1500,1000,500] threshold=2000');
    }
  } catch(e) { console.error('[startup] AS leaderboard fix error:', e.message); }

  // One-time cleanup — remove stale placeholder brands and internal test brands
  try {
    const testNames = ['test brand', 'test'];
    const internalIds = new Set(['orgsocsmarketing001', 'dnoor001']);
    const bd = loadBrands();
    const before = (bd.clients || []).length;
    bd.clients = (bd.clients || []).filter(b =>
      !testNames.includes((b.name || '').toLowerCase().trim()) &&
      !internalIds.has(b.id)
    );
    if (bd.clients.length < before) {
      saveBrands(bd);
      console.log(`[startup] Removed ${before - bd.clients.length} test/internal brand(s)`);
    }
  } catch(e) { console.error('[startup] test brand cleanup error:', e.message); }


  // Backfill Reacher shopIds, TC config, and billing defaults for known brands (idempotent — skips if already set)
  try {
    const BRAND_DEFAULTS = {
      'diamandia':            { shopId: 8595, contractValue: 1500, commissionRate: 0.1, tc: { commission: 25, heroProductId: '1729491556857975130' } },
      'trusted rituals':      { shopId: 8974, contractValue: 1500, commissionRate: 0.1, tc: { commission: 25, heroProductId: '1732230831415267648' } },
      'approved science':     { shopId: 8913, contractValue: 1500, commissionRate: 0.1, tc: { commission: 20, heroProductId: '1731392689812508843' } },
      'lode wtr':             { contractValue: 1500, commissionRate: 0.1 },
      'the perfect haircare': { contractValue: 1500, commissionRate: 0.1 },
      'yuglo':                { contractValue: 1500, commissionRate: 0.1, billingEmail: 'evaaadee1@gmail.com', proratedFirstRetainer: 1150 },
      'roots by ga':          { contractValue: 1500, commissionRate: 0.1, billingEmail: 'carla@rootsbyga.com', proratedFirstRetainer: 950 },
    };
    const bd = loadBrands(); let dirty = false;
    for (const client of (bd.clients || [])) {
      const key = (client.name || '').toLowerCase().trim();
      const defaults = BRAND_DEFAULTS[key];
      if (!defaults) continue;
      if (defaults.shopId && !client.shopId) {
        client.shopId = defaults.shopId;
        dirty = true;
        console.log(`[startup] Set shopId=${defaults.shopId} for ${client.name}`);
      }
      if (defaults.contractValue != null && client.contractValue == null && client.retainer == null) {
        client.contractValue = defaults.contractValue;
        dirty = true;
        console.log(`[startup] Set contractValue=${defaults.contractValue} for ${client.name}`);
      }
      if (defaults.commissionRate != null && client.commissionRate == null) {
        client.commissionRate = defaults.commissionRate;
        dirty = true;
        console.log(`[startup] Set commissionRate=${defaults.commissionRate} for ${client.name}`);
      }
      if (defaults.tc) {
        const cp = client.creatorPage || {};
        if (!cp.tcCommission || !cp.tcHeroProductId) {
          client.creatorPage = {
            ...cp,
            tcCommission:    cp.tcCommission    ?? defaults.tc.commission,
            tcHeroProductId: cp.tcHeroProductId ?? defaults.tc.heroProductId,
          };
          dirty = true;
          console.log(`[startup] Set TC config for ${client.name}: ${defaults.tc.commission}% commission, hero=${defaults.tc.heroProductId}`);
        }
      }
    }
    // Backfill billingEmail + proratedFirstRetainer for Yuglo if it exists
    for (const client of (bd.clients || [])) {
      if ((client.name || '').toLowerCase().trim() !== 'yuglo') continue;
      if (!client.billingEmail) { client.billingEmail = 'evaaadee1@gmail.com'; dirty = true; }
      if (client.proratedFirstRetainer == null && !client.lastInvoicedAt) { client.proratedFirstRetainer = 1150; dirty = true; }
    }
    if (dirty) saveBrands(bd);
  } catch(e) { console.error('[startup] brand defaults backfill error:', e.message); }


  // Add Roots by GA if not yet in brands.json
  try {
    const bd = loadBrands();
    const exists = (bd.clients || []).some(b => (b.name || '').toLowerCase().trim() === 'roots by ga');
    if (!exists) {
      bd.clients = bd.clients || [];
      bd.clients.push({
        id:                    'rootsbyga001',
        createdAt:             '2026-06-12T00:00:00.000Z',
        name:                  'Roots by GA',
        billingEmail:          'carla@rootsbyga.com',
        contractValue:         1500,
        commissionRate:        0.10,
        proratedFirstRetainer: 950,
        pipelineStage:         'Contract Signed',
        startDate:             '2026-06-12',
        contacts:              'Carla Brenner (carla@rootsbyga.com)',
        industry:              'TBD — to be completed during onboarding',
        products:              'TBD',
        audience:              'TBD',
        voice:                 'TBD',
        contentPillars:        'TBD',
        tiktokHandle:          'TBD',
        cta:                   'TBD',
      });
      saveBrands(bd);
      console.log('[startup] Added Roots by GA to brands.json');
    }
  } catch(e) { console.error('[startup] Roots by GA setup error:', e.message); }

  // Roots by GA — campaign links (video posting challenge + sample reimbursement form)
  // Preserves any existing creatorPage/campaigns fields; only fills these two if unset.
  try {
    const bd = loadBrands();
    const roots = (bd.clients || []).find(b => (b.name || '').toLowerCase().trim() === 'roots by ga');
    if (roots) {
      if (!roots.creatorPage) roots.creatorPage = {};
      if (!roots.creatorPage.campaigns) roots.creatorPage.campaigns = {};
      const cam = roots.creatorPage.campaigns;
      let dirty = false;
      if (!cam.quantityVideoUrl) { cam.quantityVideoUrl = 'https://creator.reacherapp.com/campaigns/10091/2500-7bfb78'; dirty = true; }
      if (!cam.reimbursementUrl) { cam.reimbursementUrl = 'https://cedw5xj2shl.usttp.larksuite.com/share/base/form/shrutTGz9ks0kgrAXSXF2tTsGad'; dirty = true; }
      if (dirty) {
        saveBrands(bd);
        console.log('[startup] Set Roots by GA campaign links (video challenge + reimbursement form)');
      }
    }
  } catch(e) { console.error('[startup] Roots by GA campaign links error:', e.message); }

  // Roots by GA — fix: prior deploy mislabeled the Reacher link as a leaderboard challenge
  // (it's actually a video-posting challenge) and the bonus copy was wrong ($730 vs $2,600).
  try {
    const bd = loadBrands();
    const roots = (bd.clients || []).find(b => (b.name || '').toLowerCase().trim() === 'roots by ga');
    if (roots?.creatorPage) {
      const cp = roots.creatorPage;
      if (!cp.campaigns) cp.campaigns = {};
      let dirty = false;
      const reacherUrl = 'https://creator.reacherapp.com/campaigns/10091/2500-7bfb78';
      if (cp.campaigns.leaderboardUrl === reacherUrl) {
        cp.campaigns.leaderboardUrl = null;
        if (!cp.campaigns.quantityVideoUrl) cp.campaigns.quantityVideoUrl = reacherUrl;
        dirty = true;
      }
      if (cp.earnPotential === 730) {
        cp.earnPotential = 2600;
        dirty = true;
      }
      if (dirty) {
        saveBrands(bd);
        console.log('[startup] Fixed Roots by GA: video challenge link + $2,600 bonus copy');
      }
    }
  } catch(e) { console.error('[startup] Roots by GA link/copy fix error:', e.message); }

  // Roots by GA — full creator page + Peptide Longevity Stack brief
  try {
    const bd = loadBrands();
    const roots = (bd.clients || []).find(b => (b.name || '').toLowerCase().trim() === 'roots by ga');
    if (roots && !roots.creatorPage?.brief) {
      const existingCp = roots.creatorPage || {};
      roots.creatorPage = {
        ...existingCp,
        slug:            existingCp.slug || 'roots-by-ga',
        active:          true,
        listed:          true,
        accentColor:     '#C8975A',
        headline:        'Earn Commission + Up to $2,600 in Bonuses',
        subheadline:     'Join the Roots by GA TikTok Shop Creator Program',
        tcCommission:    20,
        earnPotential:   existingCp.earnPotential || 2600,
        welcomeMessage:  'You\'re officially in the Roots by GA Creator Program. Your sample ships soon — explore the brief below to understand the two-step system and start planning your content.',
        welcomeSteps: [
          'Apply for the campaigns below to unlock your cash bonuses',
          'Look out for your free sample — Peptide Longevity Stack (shampoo + serum)',
          'Read the brief: the GHK-Cu skincare crossover is your strongest hook',
          'Post your first video and start earning 20% on every sale',
          'Track shedding and density on camera — 8–12 week progress content converts',
        ],
        incentives: {
          cashback:    { enabled: false, amount: 0 },
          volumeBonus: { enabled: true, bonus: 500, videoCount: 10 },
          leaderboard: { enabled: false },
        },
        campaigns: {
          quantityVideoUrl: existingCp.campaigns?.quantityVideoUrl || '',
          reimbursementUrl: existingCp.campaigns?.reimbursementUrl || '',
        },
        products: [
          {
            name:        'Peptide Longevity Stack',
            description: 'Two-step hair growth system: Conditioning Shampoo with Copper Peptides (wash days) + Multi-Peptide Hair Serum (daily). GHK-Cu in both products — follicle repair on wash day and every day.',
            minPrice:    125,
            url:         existingCp.products?.[0]?.url || 'https://rootsbyga.shop/products/peptide-shampoo-and-serum-stack',
          },
          {
            name:        'Multi-Peptide Hair Serum',
            description: '28+ clinically active ingredients: 5 peptide complexes, 7 growth factors (EGF, KGF-2, VEGF), longevity molecules NMN, PDRN, ergothioneine. Daily treatment.',
            minPrice:    76,
            url:         existingCp.products?.[1]?.url || 'https://rootsbyga.shop/products/peptide-shampoo-and-serum-stack',
          },
          {
            name:        'Conditioning Shampoo with Copper Peptides',
            description: 'Treatment-first shampoo: GHK-Cu, saw palmetto, red clover, rosemary oil, biotin, Panthenol. Non-stripping, sulfate-free. Signature blue tint from the copper peptides.',
            minPrice:    49,
            url:         existingCp.products?.[2]?.url || 'https://rootsbyga.shop/products/peptide-shampoo-and-serum-stack',
          },
        ],
        usps: [
          'GHK-Cu in both products — the skincare-famous copper peptide, now formulated for your scalp',
          'Two-step system: shampoo preps on wash days, serum treats every day',
          '5 peptide complexes + 7 medical-grade growth factors in the serum',
          'Longevity molecules NMN, PDRN, ergothioneine — targeting follicle signaling and cellular energy',
          '46% improvement in anagen-to-telogen ratio in ingredient-level clinical study*',
          'Sulfate-free, paraben-free, silicone-free — safe alongside Rx topicals, microneedling, PRP',
          'Signature blue tint = visible proof of the copper peptide (great on camera)',
        ],
        talkingPoints: 'GHK-Cu is one of the most talked-about peptides in premium anti-aging skincare — and your scalp is skin\nDHT, inflammation, and nutrient deprivation are the three compounding threats to follicles — one product can\'t cover all three\nThe shampoo isn\'t just a cleanse — it\'s follicle support: GHK-Cu signals repair, saw palmetto + red clover defend DHT-vulnerable follicles\nA serum can\'t do its job on a stripped, inflamed scalp — wash-day prep is the missing step\n28+ clinically active ingredients in the serum: peptide complexes, growth factors, longevity molecules\nNMN and PDRN in the serum are the same longevity molecules people take for aging — formulated for follicles\nThe blue tint in the shampoo is actual copper peptides — not dye (great on-camera proof point)\nExpect visible improvement in 8–12 weeks of consistency — set that expectation honestly',
        brief: {
          niche:          'Hair Growth & Scalp Health',
          targetAudience: 'Women and men 25–45 experiencing thinning, postpartum shedding, stress-related hair loss, or androgenetic alopecia. Skincare-educated consumers who already know peptides and are ready to apply that knowledge to their scalp.',
          mainProblem:    'Follicles don\'t stop producing hair overnight — they miniaturize slowly under DHT, inflammation, and nutrient deprivation. One product can\'t address all three. The Stack works as a system: shampoo defends and preps on wash days, serum rebuilds and reactivates every day.',
          hooks: [
            { text: 'You\'ve heard of GHK-Cu for your face. Your scalp is skin too — it\'s been aging the same way', type: 'curiosity' },
            { text: 'I used a growth serum for months before I found out what I was doing wrong on wash day', type: 'pain-point' },
            { text: 'The peptide your esthetician charges $300 for in a facial? It belongs on your scalp too', type: 'myth-bust' },
            { text: 'This is longevity science for your scalp — the same molecules people take for aging, formulated for your follicles', type: 'curiosity' },
            { text: 'Most shampoos stop at clean. This one is a treatment. Here\'s the difference', type: 'myth-bust' },
            { text: 'The blue tint? That\'s actual copper peptides — not dye. Let me explain what that means for your hair', type: 'curiosity' },
            { text: 'Skincare taught us peptides rebuild collagen. Your follicles sit in collagen. Connect the dots', type: 'curiosity' },
            { text: 'POV: you finally found a two-step hair routine that\'s actually doing something', type: 'transformation' },
          ],
          frameworks: [
            {
              name:    'The Skincare Crossover',
              why:     'Most of your audience already trusts peptides from skincare — especially GHK-Cu from facial serums and microneedling. The bridge ("your scalp is skin too") is the most credible, highest-converting angle for this product because it transfers existing trust to a new application.',
              outline: [
                'Hook: "You already know GHK-Cu from your skincare routine — collagen, elastin, repair, anti-aging." (Show a face serum or mention an esthetician treatment)',
                'Bridge: "Your scalp is skin. It\'s an extension of your face. Same biology, same collagen, same follicle scaffolding that thins over time."',
                'Product reveal: "Roots by GA put GHK-Cu in both the shampoo AND the serum — so you\'re getting that repair signal on wash day AND every day."',
                'Blue tint moment: "And see this? That blue tint in the shampoo is the copper peptide. Not dye — the actual ingredient."',
                'CTA: "Link in bio — the Stack comes with both so you\'re not leaving either step out."',
              ],
            },
            {
              name:    'The Missing Step',
              why:     'Creators who\'ve already tried growth serums are a huge segment. The "missing step" angle validates their existing behavior while adding the shampoo as the gap they never knew about — makes the purchase feel like completion, not replacement.',
              outline: [
                'Hook: "I was using a hair growth serum every day for months. But I was doing it wrong."',
                'The problem: "My scalp was stripped and inflamed on wash days — the serum was trying to treat a compromised surface."',
                'The solution: "The shampoo preps your scalp — GHK-Cu, saw palmetto, rosemary oil. Non-stripping so your scalp is actually ready for treatment."',
                'The system: "Wash day: shampoo. Every day: serum. Two steps, two products, one system. They\'re designed to work together."',
                'CTA: "Link in bio — $125 for both or grab them separately."',
              ],
            },
            {
              name:    'Two-Step Routine Demo',
              why:     'Visual routine content converts for haircare. Show the actual textures — blue-tinted lather + dropper serum — the "how to use" beats drive the purchase decision more than any product claim.',
              outline: [
                'Wash day: massage shampoo into scalp 1–2 min — "leave it on another 1–2 minutes before rinsing — this is when the copper peptides actually absorb"',
                'Show the blue lather: "See the blue? That\'s the GHK-Cu. Not a dye."',
                'Serum step: "Every morning or night — 1–2 dropperfuls, massage into thinning areas."',
                'Name the ingredients briefly: "GHK-Cu for repair, Biotinoyl for anchoring, Acetyl Tetrapeptides for thickness, Zinc Thymulin to wake follicles back up."',
                'CTA: "8–12 weeks of consistency — I\'m tracking mine. Link in bio."',
              ],
            },
            {
              name:    'Science Explainer: Peptide Breakdown',
              why:     'Educational content performs strongly on TikTok for haircare — viewers bookmark ingredient explainers. Breaking down each peptide as a different "message to the follicle" makes complex science feel actionable and memorable.',
              outline: [
                'Setup: "The serum has 5 different peptide complexes. Each one is a different message to the follicle."',
                'GHK-Cu: "Repair signal — same one from skincare, supports collagen around the follicle and blood flow to the root."',
                'Biotinoyl Tripeptide-1: "Hold on signal — strengthens the anchor at the root so hair sheds less."',
                'Acetyl Tetrapeptides: "Grow thicker signal — supports follicle density and shaft thickness."',
                'Zinc Thymulin: "Wake up signal — helps reactivate follicles sitting in the resting phase."',
                'CTA: "That\'s the Stack — shampoo preps, serum delivers all four messages. Link in bio."',
              ],
            },
          ],
          sampleScripts: [
            {
              framework: 'Skincare Crossover',
              title:     'The GHK-Cu Bridge',
              duration:  '~40 seconds',
              script:    '[HOOK] You\'ve probably seen GHK-Cu on every premium face serum and anti-aging cream for the last few years. It\'s the peptide that signals collagen production, wound healing, tissue repair. Estheticians use it. Microneedling serums are full of it.\n\n[BRIDGE] But here\'s what nobody told you — your scalp is skin. It\'s literally an extension of your face. Same collagen. Same repair biology. Same scaffolding that thins as you age and your GHK-Cu levels drop.\n\n[PRODUCT] Roots by GA put copper peptides in both the shampoo AND the serum. So you\'re getting that repair signal every wash day when the shampoo sits on your scalp for two minutes — you can literally see the blue tint, that\'s the copper peptide, not dye — and then again every single day with the serum.\n\n[CTA] It\'s a two-step system, $125 for the Stack. Link in bio. If you already believe in peptides for your face, it\'s time to give your scalp the same treatment.',
            },
            {
              framework: 'PAS',
              title:     'The Missing Step',
              duration:  '~35 seconds',
              script:    '[HOOK] I used a hair growth serum every single day for three months and barely saw a difference. Turns out I was missing the most important step.\n\n[PROBLEM] On wash days I was stripping my scalp with a regular sulfate shampoo — drying it out, inflaming it, then immediately trying to treat it with an active serum. That doesn\'t work. A serum can\'t do its job on a compromised scalp.\n\n[SOLUTION] The Roots by GA shampoo has GHK-Cu, saw palmetto, rosemary oil — it defends and preps on wash days so your scalp is actually ready to absorb treatment. Then the serum every day: 5 peptide complexes, 7 growth factors, longevity molecules NMN and PDRN. Two steps, designed to work together.\n\n[CTA] This is the two-step system I wish I had from the start. Link in bio — $125 for the Stack or grab them separately.',
            },
          ],
          talkingPoints: {
            benefits: [
              'GHK-Cu in both products — the repair signal on wash day AND daily, not just once',
              'Two-step system addresses all three follicle threats: DHT defense (shampoo), inflammation reduction, nutrient delivery (serum)',
              '5 peptide complexes in the serum: repair, anchor, thickness, growth-phase activation',
              '7 medical-grade growth factors: EGF, IGF-2, VEGF, bFGF, KGF-2, aFGF, SCF',
              'Longevity molecules NMN (NAD+ support), PDRN (microcirculation), ergothioneine (follicle stem cell protection)',
              'Ingredient study: 46% improvement in anagen-to-telogen ratio and ~29% reduction in telogen hair vs placebo*',
              'Sulfate-free shampoo primes the scalp — not strips it — so the serum can actually absorb',
              'Safe alongside prescription topicals, microneedling, PRP — won\'t interfere with what you\'re already using',
            ],
            powerPhrases: [
              '"Your scalp is an extension of your face — start treating it like it"',
              '"GHK-Cu on wash day and every day"',
              '"Shampoo preps. Serum treats. That\'s the system."',
              '"The blue tint is the copper peptide — not dye"',
              '"This is longevity science for your scalp"',
            ],
          },
          doAndDont: {
            dos: [
              'Lead with GHK-Cu — if your audience is skincare-literate, this is your fastest trust bridge',
              'Show the blue tint in the shampoo on camera — it\'s the most memorable visual proof point',
              'Demonstrate the massage-and-wait technique (1–2 min leave-on) — this is how the copper peptides absorb',
              'Use supportive language: "supports," "helps," "improves the appearance of density," "designed to"',
              'Disclose the partnership (#ad or paid-partnership label) on every post — FTC requirement',
              'Attribute the clinical stat to the ingredient study, not to the product or your own results',
              'Set an honest timeline: visible improvement in 8–12 weeks of consistency',
            ],
            donts: [
              'Don\'t claim the products cure or reverse hair loss, guarantee regrowth, or replace prescription treatment',
              'Don\'t use the "+17% hair density" or "78% more hairs" stats — these can\'t be sourced and are removed from creator use',
              'Don\'t attach a growth percentage to sunflower sprout extract — pending supplier documentation',
              'Don\'t skip the shampoo story — it\'s not just a cleanse, and treating it like one misses the whole system angle',
            ],
          },
          benchmarks: {
            hookRate: '>30%',
            holdRate: '>10%',
            ctr:      '>1%',
          },
        },
      };
      saveBrands(bd);
      console.log('[startup] Roots by GA — full creator page + Peptide Longevity Stack brief configured');
    }
  } catch(e) { console.error('[startup] Roots by GA creator page error:', e.message); }

  // Add Yuglo if not yet in brands.json
  try {
    const bd = loadBrands();
    const exists = (bd.clients || []).some(b => (b.name || '').toLowerCase().trim() === 'yuglo');
    if (!exists) {
      bd.clients = bd.clients || [];
      bd.clients.push({
        id:                   'yuglo001',
        createdAt:            '2026-06-08T00:00:00.000Z',
        name:                 'Yuglo',
        billingEmail:         'evaaadee1@gmail.com',
        contractValue:        1500,
        commissionRate:       0.10,
        proratedFirstRetainer: 1150,
        pipelineStage:        'Contract Signed',
        startDate:            '2026-06-08',
        contacts:             'Eva Dee (evaaadee1@gmail.com)',
        industry:             'TBD — to be completed during onboarding',
        products:             'TBD',
        audience:             'TBD',
        voice:                'TBD',
        contentPillars:       'TBD',
        tiktokHandle:         'TBD',
        cta:                  'TBD',
      });
      saveBrands(bd);
      console.log('[startup] Added Yuglo to brands.json');
    }
  } catch(e) { console.error('[startup] Yuglo setup error:', e.message); }

  // Trusted Rituals — full brand config + creator page setup (runs if brief not yet set)
  try {
    const bd = loadBrands();
    const tr = (bd.clients || []).find(b => (b.name || '').toLowerCase().trim() === 'trusted rituals');
    if (tr && (!tr.creatorPage?.brief || tr.creatorPage?.incentives?.cashback?.target === 6)) {
      // Brand-level fields
      Object.assign(tr, {
        industry:       'Wellness supplements — respiratory health & lung support',
        products:       'Hero product: Mullein Honey Sticks — 30 individually packed honey sticks with 2,000mg Himalayan mullein + pure honey in ginger lemon flavor. Supports respiratory health, lung detox, seasonal allergy relief, and throat soothing. First-ever mullein honey stick on market (no direct competition). Additional wellness products available.',
        audience:       'Adults 20–45 with seasonal allergies, pollen sensitivity, or who smoke/vape and want natural lung support. Health-conscious consumers who\'ve tried mullein but found tinctures, pills, or tea bags too inconvenient to stick with. Also resonates with general respiratory wellness seekers.',
        voice:          'Science-backed but accessible and founder-led. Conversational, mission-driven, transparent. Yash (founder) draws on his own experience as a smoker. Confident and disruptive — proud to be first-to-market. Inclusive "we\'re in this together" energy.',
        contentPillars: 'Allergy season & pollen relief, Smoking/vaping cessation & lung recovery, Respiratory health education, Product demos & unboxing, Before/after breathing improvement stories',
        proofPoints:    'VC-backed with 3-year funding runway. Amazon bestseller. First-ever mullein honey stick — zero direct competition on TikTok Shop. 2,000mg per stick (full therapeutic dose). Premium Himalayan high-altitude sourcing, rosette-stage leaves (first-year harvest = max potency). Pure honey, no added sugar. 60M Americans have seasonal allergies. 50M+ smoke or vape.',
        cta:            'Link in bio — grab yours',
      });
      // Creator page — preserves any existing slug + campaign URLs already set
      const existingCp = tr.creatorPage || {};
      tr.creatorPage = {
        ...existingCp,
        slug:            existingCp.slug || 'trusted-rituals',
        active:          true,
        listed:          true,
        accentColor:     '#F5A623',
        headline:        'Earn 25% Commission + Up to $2,850 in Bonuses',
        subheadline:     'Join the Trusted Rituals TikTok Shop Creator Program',
        tcCommission:    25,
        tcHeroProductId: '1732230831415267648', // Mullein Honey Sticks
        earnPotential:   2850,
        welcomeMessage:  'You\'re officially in the Trusted Rituals Creator Program. Your sample ships May 29 — use the hooks and scripts below to make content that converts.',
        welcomeSteps:    [
          'Apply for all 4 campaigns using the links below',
          'Look for your free sample on or around May 29',
          'Prep your 3 blitz videos before launch day',
          'Post on launch day for the algorithmic push (and the $650 tier)',
          'Keep posting through June 30 for the video volume bonus + leaderboard',
        ],
        blitzTiers:      [{ gmv: 1000, bonus: 650 }, { gmv: 750, bonus: 500 }, { gmv: 375, bonus: 250 }],
        incentives: {
          cashback:    { enabled: true,  amount: 100, unitsRequired: 6 },
          volumeBonus: { enabled: true,  bonus: 100,  videoCount: 10 },
          leaderboard: { enabled: true,  places: [2000], threshold: 5000 },
        },
        campaigns: {
          blitzUrl:         existingCp.campaigns?.blitzUrl         || '',
          blitzLabel:       '🚀 Blitz Launch Campaign',
          blitzSub:         'Post 3 videos on launch day — earn up to $650 in the first 15 days',
          cashbackUrl:      existingCp.campaigns?.cashbackUrl      || '',
          quantityVideoUrl: existingCp.campaigns?.quantityVideoUrl || '',
          leaderboardUrl:   existingCp.campaigns?.leaderboardUrl   || '',
        },
        products: [
          {
            name:        'Mullein Honey Sticks (30 Pack)',
            description: '2,000mg premium Himalayan mullein + pure honey in ginger lemon flavor. Supports respiratory health, clears mucus, soothes throat. First-ever mullein honey stick — nothing else like it on the market.',
            minPrice:    null,
            url:         existingCp.products?.[0]?.url || '',
          },
        ],
        usps: [
          '2,000mg of mullein per stick — a full therapeutic dose every time',
          'First-ever mullein honey stick — zero direct competition on TikTok Shop',
          'Premium Himalayan sourcing: rosette-stage, first-year harvest (max potency)',
          'Pure honey masks bitterness naturally — it actually tastes good',
          'Portable & mess-free — tear, sip, done. No dropper, no brewing, no prep',
          'VC-backed brand with 3-year runway — reliable payouts, long-term opportunity',
        ],
        talkingPoints: '60M Americans deal with seasonal allergies every year\n50M+ people in the US smoke or vape\nMullein is a 2,000-year-old proven herb for respiratory health\nExisting formats are terrible — bitter tinctures, hard pills, 25-min tea bags\nHoney naturally soothes throat + masks mullein bitterness\nGinger lemon flavor with warm herbal finish — you\'ll actually take it daily\n30 sticks per box, individually packed, carry anywhere\nAmazon bestseller with proven product-market fit',
        brief: {
          niche:          'Health',
          targetAudience: 'Adults 20–45 dealing with seasonal allergies, pollen sensitivity, or looking to support their lungs after smoking/vaping. Health-conscious buyers who\'ve heard of mullein but find tinctures, pills, and tea bags too bitter, messy, or inconvenient to stick with.',
          mainProblem:    'Mullein is one of the most proven natural herbs for respiratory health — but every existing format is bitter, messy, and hard to turn into a daily habit.',
          hooks: [
            { text: 'Seasonal allergies were ruining my spring — then I found this and everything changed', type: 'transformation' },
            { text: '60 million Americans suffer from seasonal allergies and nobody is talking about this natural fix', type: 'curiosity' },
            { text: 'I quit vaping 3 months ago and these honey sticks are the reason my lungs feel clean again', type: 'social-proof' },
            { text: 'Everything you know about mullein supplements is wrong — and that\'s why nothing has worked for you', type: 'myth-bust' },
            { text: 'Why are you still brewing mullein tea for 25 minutes when you can literally just do this?', type: 'pain-point' },
            { text: 'POV: You finally found the thing that actually works during pollen season', type: 'transformation' },
            { text: 'This herb has been used for 2,000 years for lung health — and someone finally made it taste like honey', type: 'curiosity' },
            { text: 'Stop wasting money on gross mullein tinctures — there is a way better option and it\'s finally here', type: 'pain-point' },
          ],
          frameworks: [
            {
              name: 'Problem → Solution',
              why:  'The gap between mullein\'s proven benefits and every existing format\'s awful UX is the entire pitch — make viewers feel the frustration before you reveal the honey stick as the obvious fix',
              outline: [
                'Hook: Lead with the pain — allergy season, can\'t breathe, or physically show a gross tincture dropper',
                'Agitate: "I tried pills (forgot to take them), tinctures (disgusting), tea bags (who has 25 minutes?)"',
                'Introduce: "Then I found Trusted Rituals Mullein Honey Sticks — 2,000mg per stick, ginger lemon honey, just tear and sip"',
                'CTA: "They have a launch promo with free samples right now — link in bio"',
              ],
            },
            {
              name: 'Why I Switched',
              why:  'Personal switch stories convert at the highest rate for wellness products — a genuine comparison makes the product feel like a discovery, not an ad',
              outline: [
                'What I was using before: tinctures, pills, or just suffering through allergy season with no solution',
                'Why I switched: too bitter, too inconvenient, too easy to forget',
                'The discovery: show the honey stick — "tear it open and just sip it. It tastes like warm honey with a herbal finish"',
                'The result: "This is my morning ritual now and I\'m genuinely never going back"',
              ],
            },
            {
              name: 'Unboxing + Demo',
              why:  'The visual of tearing open a honey stick and sipping it is this product\'s best asset �� novel, satisfying, and immediately communicates the convenience advantage over messy tinctures',
              outline: [
                'Show the box — 30 sticks, clean individual packaging',
                'Tear one stick open on camera — contrast it with a dropper (no mess, no measuring)',
                'Mix into coffee or tea, or sip directly — let the viewer see how effortless it is',
                'State the dose: "2,000mg of Himalayan mullein in literally one honey stick"',
              ],
            },
          ],
          sampleScripts: [
            {
              framework: 'PAS',
              title:     'The Allergy Season Script',
              duration:  '~35 seconds',
              script:    '[HOOK] Pollen season almost broke me this year. I was sneezing constantly, congested all day, just couldn\'t breathe properly no matter what I tried.\n\n[PROBLEM] I heard mullein was a natural herb that could actually help with respiratory health so I went looking for supplements. But everything was awful — tinctures that taste disgusting, pills I kept forgetting to take, tea bags that take 20 minutes to brew. I gave up.\n\n[SOLUTION] Then I found Trusted Rituals Mullein Honey Sticks. 2,000mg of mullein sourced from the Himalayas — in a single honey stick. I just tear it open and sip it directly or mix it into my morning coffee. Ginger lemon flavor. It actually tastes good. It\'s my morning ritual now.\n\n[CTA] They\'re running a launch promotion with free samples right now — link is in my bio before they run out.',
            },
            {
              framework: 'BAB',
              title:     'The Lung Recovery Script',
              duration:  '~30 seconds',
              script:    '[BEFORE] Six months ago I was vaping almost every day. My lungs felt wrecked — tight, congested, just not right.\n\n[AFTER] Today I wake up and I can actually breathe clearly. Three months vape-free and my respiratory health genuinely feels different.\n\n[BRIDGE] The thing that kept me consistent? Trusted Rituals Mullein Honey Sticks. Mullein has been used for centuries to support lung health and clear mucus. 2,000mg per stick, pure honey, no bitterness — it became the daily ritual that kept me on track.\n\n[CTA] If you\'re trying to quit or just want to breathe better this pollen season — grab it through my link.',
            },
          ],
          talkingPoints: {
            benefits: [
              '2,000mg of mullein per stick — a full clinical therapeutic dose in every single use',
              'First-ever mullein honey stick on the market — zero direct competition on TikTok Shop',
              'Premium Himalayan sourcing: rosette-stage, first-year harvest mullein at maximum potency',
              'Pure honey soothes throat irritation naturally — no added sugar, no fillers',
              'Ginger lemon flavor eliminates the bitterness — you\'ll actually want to take it every day',
              'One stick = complete convenience — carry anywhere, no dropper, no measuring, no brewing',
            ],
            objections: [
              '"Is this just a gimmick?" — Mullein has been used since Greek times, 2,000mg is a real therapeutic dose, and there is literally no other product like this on the market. Address it head-on.',
              '"Does it actually taste good?" — Yes. The honey completely masks mullein\'s natural bitterness. Taste it on camera and let your genuine reaction do the selling.',
              '"Why pay more than pills?" — Convenience and habit-formation premium. Same dose, but pills are easy to skip. The honey stick ritual is what makes people actually stick with it.',
            ],
            powerPhrases: [
              '"The only mullein supplement you\'ll actually remember to take"',
              '"2,000mg. Pure honey. Zero competition."',
              '"Respiratory health that tastes like honey"',
            ],
          },
          doAndDont: {
            dos: [
              'Lead with the pain — allergy season, pollen, smoking/vaping recovery. Hook the viewer\'s problem before showing the product',
              'Show the product in use — tear the stick open on camera, sip directly or stir into a hot drink',
              'Call out 2,000mg + Himalayan sourcing — these are the premium proof points that justify the price',
              'Use the "first-ever" angle — there is literally nothing else like this on TikTok Shop right now',
              'Lean into ritual language — this is a daily wellness practice, not a one-off supplement',
            ],
            donts: [
              'Don\'t make medical claims about treating or curing conditions — use "supports respiratory health" and "seasonal wellness"',
              'Don\'t skip the taste reveal — it actually tastes like honey, and that\'s the #1 objection handler',
              'Don\'t only target smokers — seasonal allergy sufferers are a much larger audience and just as receptive',
              'Don\'t rush past the unboxing — the stick format is visually novel, let viewers appreciate the convenience',
            ],
          },
          benchmarks: {
            hookRate: '>30% (impressions ÷ 3-second plays)',
            holdRate: '>10-15% (thruplays ÷ 3-second plays)',
            ctr:      '>1-1.5% (clicks ÷ impressions)',
          },
        },
      };
      saveBrands(bd);
      console.log('[startup] Trusted Rituals full creator page configured');
    }
  } catch(e) { console.error('[startup] Trusted Rituals setup error:', e.message); }

  // Ensure TikTok TC test brand exists (hidden from /creators index via listed:false)
  // Approved Science — full creator page setup
  try {
    const bd = loadBrands();
    const as = (bd.clients || []).find(b => (b.name || '').toLowerCase().trim() === 'approved science');
    const asNeedsUpdate = !as?.creatorPage?.productRequestEnabled
      || (as?.creatorPage?.catalogProducts || []).some(p => /shilajit|parastrin/i.test(p.name))
      || as?.creatorPage?.earnPotential !== 1700;
    if (as && asNeedsUpdate) {
      const existingCp = as.creatorPage || {};
      Object.assign(as, {
        industry:       'Health supplements — 10-year-old brand, Amazon-first, expanding to TikTok Shop',
        products:       'Hero: Parastrin (science-backed parasite cleanse, 60 capsules). 100+ samples/month budget. Additional catalog products available on request.',
        audience:       'Health-conscious adults 25–45 interested in gut health, detox, energy, and weight management. Predominantly Amazon buyers already familiar with the brand.',
        voice:          'Science-backed, credibility-forward. Lab-coat confidence without being cold — Approved Science has 10 years of proof points. Accessible and educational.',
        contentPillars: 'Parasite cleanse awareness & gut health education, Digestive health & detox, Supplement unboxing & demos, Before/after transformation stories, Gut health myth-busting',
        proofPoints:    '10+ years in market. Strong Amazon presence with thousands of verified reviews. Science-backed formulas. Manufactured in the USA. Multiple supplement categories with proven product-market fit.',
        cta:            'Link in bio to shop',
      });
      as.shopId = as.shopId || 8913;
      as.creatorPage = {
        ...existingCp,
        slug:            existingCp.slug || 'approved-science',
        active:          true,
        listed:          true,
        accentColor:     '#2E7EFB',
        headline:        'Earn $1,700+ in Bonuses + 20% Commission on the July Freedom Challenge',
        subheadline:     'Join the Approved Science TikTok Shop Creator Program',
        tcCommission:    20,
        tcHeroProductId: '1731392689812508843', // Parastrin
        earnPotential:   1700,
        welcomeMessage:  'You\'re in the Approved Science Creator Program. Your sample is on its way — explore the full catalog and request any products you want to feature.',
        welcomeSteps: [
          'Apply for the campaigns below to unlock your cash bonuses',
          'Your sample will ship within 3–5 business days',
          'Request any additional products from the catalog using the form below',
          'Post your first video and start earning 20% commission on every sale',
        ],
        incentives: {
          cashback:    { enabled: false, amount: 0, unitsRequired: 0, description: '' },
          volumeBonus: { enabled: true, bonus: 200, videoCount: 10, description: 'Post 10 videos and earn a one-time $200 cash bonus' },
          leaderboard: { enabled: true, places: [1500, 1000, 500], threshold: 2000, description: 'Monthly leaderboard — $2,000 min GMV to qualify' },
        },
        campaigns: {
          cashbackUrl:      existingCp.campaigns?.cashbackUrl      || '',
          quantityVideoUrl: existingCp.campaigns?.quantityVideoUrl || '',
          sprintUrl:        existingCp.campaigns?.sprintUrl        || 'https://creator.reacherapp.com/campaigns/8913/2128-70b915',
          leaderboardUrl:   existingCp.campaigns?.leaderboardUrl   || 'https://creator.reacherapp.com/campaigns/8913/2129-5d80bb',
        },
        productRequestEnabled: true,
        catalogProducts: [], // Parastrin is the default for all creators — this form is for requesting other catalog products
        products: [
          { name: 'Parastrin (60 Capsules)', description: 'Science-backed parasite cleanse and digestive support formula', url: existingCp.products?.[0]?.url || '' },
        ],
        usps: [
          '10+ years of proven Amazon sales — thousands of verified reviews',
          '20% commission on every sale you drive',
          'Free Parastrin sample shipped directly to you',
          'Science-backed formula manufactured in the USA',
          'Request other products from the full catalog',
          'Monthly cash bonuses for top performers',
        ],
        talkingPoints: 'Parasites affect up to 1 in 3 people globally — most don\'t know they have one\nGut health is the #1 health trend on TikTok — parasite cleanse content goes viral\nParastrin uses science-backed ingredients in clinical doses\n10+ years of real customer reviews on Amazon backing every product\nMade in the USA to strict supplement manufacturing standards\nBloating, fatigue, brain fog — all potential signs of gut imbalance\n60 capsules — a full 30-day cleanse protocol',
        brief: {
          niche:          'Health & Wellness Supplements',
          targetAudience: 'Health-conscious adults 25–45 interested in gut health, energy, and weight management. Amazon shoppers who trust established supplement brands.',
          mainProblem:    'Most people don\'t associate their bloating, fatigue, brain fog, or digestive issues with parasites — yet it\'s one of the most overlooked root causes. Parastrin makes the parasite cleanse conversation approachable and science-backed.',
          hooks: [
            { text: 'Doctors won\'t tell you this but 1 in 3 people have a parasite and don\'t know it', type: 'curiosity' },
            { text: 'I did a parasite cleanse for 30 days and the results shocked me', type: 'transformation' },
            { text: 'If you have constant bloating, fatigue, or brain fog — watch this', type: 'pain-point' },
            { text: 'The gut health trend everyone is talking about and the science behind it', type: 'curiosity' },
            { text: 'Why I switched from random gut supplements to a proper parasite cleanse protocol', type: 'transformation' },
            { text: 'This is what Approved Science Parastrin actually does to your digestive system', type: 'curiosity' },
            { text: 'POV: you finally figured out why your stomach has been off for months', type: 'social-proof' },
            { text: 'The supplement brand with 10 years of Amazon reviews that most TikTok creators haven\'t found yet', type: 'myth-bust' },
          ],
          frameworks: [
            {
              name:    'Symptom → Root Cause → Solution',
              why:     'Parasite cleanse content converts best when the viewer recognizes their own symptoms first — make them think "that\'s literally me" before you introduce the product',
              outline: [
                'Hook: List 3–5 symptoms (bloating, fatigue, brain fog, skin issues, cravings) — "if you have any of these you need to hear this"',
                'Root cause reveal: "Most of the time it\'s gut health. And one of the most overlooked causes is parasites — 1 in 3 people have them"',
                'Introduce Parastrin: "Approved Science has a science-backed cleanse formula. 10 years on Amazon, thousands of reviews, and it\'s now on TikTok Shop"',
                'Social proof: "I\'ve been using it for 30 days and here\'s what I noticed…"',
                'CTA: "Link in bio — they offer free samples right now"',
              ],
            },
            {
              name:    'Trust Bridge (Amazon → TikTok Shop)',
              why:     'Approved Science has massive Amazon credibility that most TikTok viewers don\'t know about — this bridge makes the product feel established rather than trendy',
              outline: [
                'Open with Amazon proof: "This brand has been on Amazon for over 10 years with thousands of verified reviews"',
                '"They just launched on TikTok Shop and creators can get free samples right now"',
                'Show the product: unbox it, explain what it does simply',
                '"20% commission — I genuinely recommend this to everyone asking me about gut health"',
                'CTA with urgency: "Free samples are limited — grab yours through my link"',
              ],
            },
            {
              name:    '30-Day Results Check-In',
              why:     'Supplement content that follows a creator\'s personal journey over 30 days builds trust and drives consistent engagement — viewers tune back in to see the update',
              outline: [
                'Hook: "I\'ve been doing a parasite cleanse for 30 days — here\'s my honest update"',
                'Context: "I picked Parastrin by Approved Science — 10+ years on Amazon, thousands of reviews, science-backed formula"',
                'Timeline: briefly walk through days 1, 2, and week 4 — what changed, what you noticed',
                'Honest take: "I\'m not going to oversell this. Here\'s exactly what I experienced…"',
                'CTA: "Free samples available through my link — worth trying if you\'ve been dealing with gut issues"',
              ],
            },
          ],
          sampleScripts: [
            {
              framework: 'PAS',
              title:     'The Parasite Cleanse Reveal',
              duration:  '~35 seconds',
              script:    '[HOOK] If you have unexplained bloating, constant fatigue, brain fog, or weird skin stuff — I need you to hear this.\n\n[PROBLEM] Most people write these off as stress or diet. But one of the most overlooked root causes is parasites. Up to 1 in 3 people have them and genuinely don\'t know.\n\n[SOLUTION] I\'ve been using Approved Science Parastrin for 30 days. It\'s a science-backed parasite cleanse formula that\'s been on Amazon for over 10 years �� thousands of real reviews. And it just launched on TikTok Shop with free samples.\n\n[CTA] Link in my bio before the free samples run out. Your gut health is worth the 30 seconds it takes to grab it.',
            },
            {
              framework: 'Trust Bridge',
              title:     'The Amazon-to-TikTok Discovery',
              duration:  '~30 seconds',
              script:    '[HOOK] This supplement brand has been on Amazon for over 10 years and most TikTok creators have no idea it exists.\n\n[BRIDGE] Approved Science just launched on TikTok Shop and they\'re offering free samples to creators right now. Their Parastrin is a proper science-backed parasite cleanse — 60 capsules, clinical doses, manufactured in the USA.\n\n[CREDIBILITY] Thousands of verified Amazon reviews over a decade. This isn\'t a random drop-shipped supplement. It\'s a brand with a real track record.\n\n[CTA] Free samples and 20% commission through my link. If you\'ve been dealing with gut issues — this is worth a look.',
            },
          ],
          talkingPoints: {
            benefits: [
              'Parastrin: science-backed parasite cleanse for digestive & intestinal support',
              '60 capsules — a complete 30-day cleanse protocol',
              'Clinical doses of science-backed ingredients — not underdosed fillers',
              '10+ years of Amazon sales — real verified reviews at scale',
              'Made in the USA to strict supplement manufacturing standards',
              '20% commission + free samples for all creators',
            ],
            objections: [
              '"Is this a real brand?" — Yes. 10+ years on Amazon, thousands of verified reviews, proven product-market fit before TikTok existed.',
              '"Do I need a parasite cleanse?" — Frame it as gut health optimization, not something scary. The content angle is curiosity and self-care.',
              '"Why not just buy a cheaper supplement?" — Approved Science uses quality ingredients at clinical doses. The Amazon reviews prove it delivers.',
            ],
            powerPhrases: [
              '10 years of Amazon proof',
              'Science-backed, not trendy',
              '1 in 3 people have a parasite and don\'t know it',
            ],
          },
          doAndDont: {
            dos: [
              'Lead with relatable symptoms — make viewers self-identify before introducing the product',
              'Use your personal results as the credibility anchor — "I\'ve been taking this for X days and here\'s what I noticed" outperforms any brand claim',
              'Show the capsules on camera — the physical product on screen increases purchase intent',
              'Be honest about your timeline — gradual, real progress is more convincing than overnight transformations',
              'Drive to the shop link with urgency — limited stock, a discount, or a time-bound offer converts better than a generic "link in bio"',
            ],
            donts: [
              'Don\'t make direct disease or cure claims — stick to "supports", "promotes", "may help"',
              'Don\'t sensationalize parasites in a fear-based way — keep it educational and empowering',
              'Don\'t skip the credibility hook — the 10-year Amazon history is what separates this from random supplements',
              'Don\'t rush the content — supplement trust videos need at least 30 seconds to build credibility',
            ],
          },
          benchmarks: { hookRate: '>30%', holdRate: '>10-15%', ctr: '>1-1.5%' },
        },
      };
      saveBrands(bd);
      console.log('[startup] Approved Science creator page configured');
    }
  } catch(e) { console.error('[startup] Approved Science setup error:', e.message); }

  // Remove TC Test Brand (no longer needed)
  try {
    const bd = loadBrands();
    const before = (bd.clients || []).length;
    bd.clients = (bd.clients || []).filter(b => b.id !== 'tctestbrand001' && b.name !== 'TC Test Brand');
    if (bd.clients.length < before) {
      saveBrands(bd);
      console.log('[startup] Removed TC Test Brand');
    }
  } catch(e) { console.error('[startup] TC test brand removal error:', e.message); }

  // Startup diagnostics — log data file sizes so we can verify persistence
  try {
    const mData = loadClientMeetings();
    const bData = loadBrands();
    const mCount = (mData.meetings || []).length;
    const cCount = (bData.clients || []).length;
    const clientNames = (bData.clients || []).map(c => c.name).join(', ') || '(none)';
    console.log(`[startup] client-meetings.json: ${mCount} meeting(s)`);
    console.log(`[startup] brands.json: ${cCount} client(s) — ${clientNames}`);
    if (mCount > 0) {
      const firstDate = mData.meetings[mData.meetings.length - 1]?.date || 'unknown';
      const lastDate  = mData.meetings[0]?.date || 'unknown';
      console.log(`[startup] meeting range: ${firstDate} → ${lastDate}`);
    }
  } catch(e) {
    console.error('[startup] diagnostic error:', e.message);
  }

  // Resume any pipeline runs that were interrupted by a restart/deploy
  try {
    const all = loadPendingOnboards();
    const interrupted = all.filter(e => e.status === 'processing');
    if (interrupted.length) {
      // Remove the stale stubs — runOnboardingPipeline will create fresh ones
      savePendingOnboards(all.filter(e => e.status !== 'processing'));
      console.log(`[startup] Resuming ${interrupted.length} interrupted onboarding pipeline(s)...`);
      for (const entry of interrupted) {
        runOnboardingPipeline(entry.formData).catch(e => console.error(`[startup] resume pipeline error (${entry.formData?.brandName}):`, e.message));
      }
    }
  } catch(e) {
    console.error('[startup] resume pipelines error:', e.message);
  }

  // ─── Ensure Stripe billing products exist (idempotent) ─────────────────────
  if (stripe) {
    (async () => {
      try {
        const STRIPE_META_FILE = path.join(DATA_DIR, 'stripe-products.json');
        let meta = {};
        if (fs.existsSync(STRIPE_META_FILE)) {
          try { meta = JSON.parse(fs.readFileSync(STRIPE_META_FILE, 'utf8')); } catch(_) {}
        }

        const ensureProduct = async (key, name, description) => {
          if (meta[key]) return meta[key]; // already created
          // Search for existing product by metadata key
          const list = await stripe.products.search({ query: `metadata['cc_product_key']:'${key}'`, limit: 1 });
          if (list.data.length > 0) {
            meta[key] = list.data[0].id;
            return meta[key];
          }
          const prod = await stripe.products.create({ name, description, metadata: { cc_product_key: key, source: 'cult-content-billing' } });
          meta[key] = prod.id;
          console.log(`[stripe] Created product: ${name} (${prod.id})`);
          return prod.id;
        };

        await ensureProduct('retainer',  'Monthly Retainer',   'Cult Content monthly management retainer fee');
        await ensureProduct('gmv_share', 'GMV Revenue Share',  'Cult Content performance-based TikTok Shop GMV share');

        // Create a Stripe product for each billing tier
        for (const tier of BILLING_TIERS) {
          const tierKey = `tier_${tier.retainer}_${Math.round(tier.commRate * 100)}pct`;
          const tierName = `Cult Content — $${tier.retainer.toLocaleString()}/mo + ${Math.round(tier.commRate * 100)}% GMV`;
          const tierDesc = `Monthly retainer: $${tier.retainer.toLocaleString()} | GMV revenue share: ${Math.round(tier.commRate * 100)}%`;
          await ensureProduct(tierKey, tierName, tierDesc);
        }

        fs.writeFileSync(STRIPE_META_FILE, JSON.stringify(meta, null, 2));
        console.log('[stripe] Billing products verified ✓');
      } catch(e) {
        console.error('[stripe] Product setup error:', e.message);
      }
    })();
  }
});

// ============================================
