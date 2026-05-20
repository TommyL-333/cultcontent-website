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

// ─── Data directory — use Railway Volume in prod, __dirname locally ───────────
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SNAP_FILE          = path.join(DATA_DIR, 'snapshots.json');
const QUEUE_FILE         = path.join(DATA_DIR, 'upload-queue.json');
const AGENTS_FILE        = path.join(DATA_DIR, 'agents.json');
const TIKTOK_TOKENS_FILE = path.join(DATA_DIR, '.tiktok-tokens.json');
const TASKS_FILE         = path.join(DATA_DIR, 'tasks.json');
const UPLOAD_DIR         = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Public-facing Railway URL — returned in upload responses so Buffer (and browsers) can fetch files
// without hitting Cloudflare's 100 MB limit.  Override via PUBLIC_BASE_URL env var.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.DASHBOARD_URL || 'https://cult-command-center-production.up.railway.app').replace(/\/$/, '');

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

// ─── Security: Cloudflare Access authentication ───────────────────────────────
// Cloudflare Access injects CF-Access-Authenticated-User-Email on every request.
// If CF_ACCESS_AUD is set, we enforce this header — unauthenticated requests get 401.
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'cultcontent.cc')
  .split(',').map(d => d.trim().toLowerCase());

function requireAuth(req, res, next) {
  // Skip auth in local dev (no CF_ACCESS_AUD configured)
  if (!process.env.CF_ACCESS_AUD) return next();

  const email = req.headers['cf-access-authenticated-user-email'];
  if (!email) {
    return res.status(401).sendFile(path.join(__dirname, 'dashboard', '401.html'));
  }

  const domain = email.split('@')[1]?.toLowerCase();
  if (!ALLOWED_DOMAINS.includes(domain)) {
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
    express.json()(req, res, next);
  }
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

// Public routes — registered BEFORE requireAuth so no login needed
app.use('/uploads', express.static(UPLOAD_DIR));

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

// POST /api/onboard/submit — public, responds immediately then runs pipeline async
app.post('/api/onboard/submit', express.json({ limit: '2mb' }), async (req, res) => {
  const { brandName, email } = req.body || {};
  if (!brandName || !email) return res.status(400).json({ ok: false, error: 'Brand name and email required' });
  res.json({ ok: true, message: `Welcome to the cult, ${brandName}! Our team will be in touch within 24 hours.` });
  runOnboardingPipeline(req.body).catch(e => console.error('[onboard] pipeline error:', e.message));
});

// GET /creators/:brandSlug — public creator interest page
// active flag only hides the page if explicitly set to false; omitted or true = visible
app.get('/creators/:brandSlug', (req, res) => {
  const brands = loadBrands();
  const brand  = (brands.clients || []).find(b => b.creatorPage?.slug === req.params.brandSlug);
  if (!brand?.creatorPage || brand.creatorPage.active === false) {
    return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not found</title></head><body style="font-family:sans-serif;text-align:center;padding:80px 20px;background:#0d0b14;color:#fff"><h1 style="margin-bottom:12px">Page not found</h1><p style="color:#666">This creator page doesn't exist or has been taken down.</p></body></html>`);
  }
  res.set('Content-Type', 'text/html');
  res.send(renderCreatorPage(brand, brand.creatorPage));
});

// POST /api/creator-pages/submit — public creator interest form submission
app.post('/api/creator-pages/submit', express.json(), async (req, res) => {
  try {
    const { brandSlug, firstName, lastName, email, phone, tiktokHandle, followerRange, gmv, niche, message } = req.body || {};
    if (!brandSlug || !firstName || !email) return res.status(400).json({ ok: false, error: 'Missing required fields' });
    const brands = loadBrands();
    const brand  = (brands.clients || []).find(b => b.creatorPage?.slug === brandSlug);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });
    const tagName = brand.creatorPage?.tagName || `creator-interested-${brandSlug}`;
    let contactId = null;
    try {
      const sr = await ghl.get('/contacts/', { params: { locationId: CFG.locationId, query: email, limit: 1 } });
      contactId = sr.data?.contacts?.[0]?.id || null;
    } catch(_) {}
    const payload = { locationId: CFG.locationId, firstName: firstName||'', lastName: lastName||'', email, phone: phone||'', tags: [tagName, 'creator-interest-form'], source: `Creator Interest Page — ${brand.name}` };
    if (contactId) {
      await ghl.put(`/contacts/${contactId}`, payload).catch(() => {});
      await ghl.post(`/contacts/${contactId}/tags`, { tags: [tagName, 'creator-interest-form'] }).catch(() => {});
    } else {
      const cr = await ghl.post('/contacts/', payload);
      contactId = cr.data?.contact?.id;
    }
    if (contactId) {
      const noteLines = [
        `TikTok Handle: ${tiktokHandle||'not provided'}`,
        `Followers: ${followerRange||'not provided'}`,
        `Monthly GMV: ${gmv||'not provided'}`,
        `Niche: ${niche||'not provided'}`,
        `Interested in brand: ${brand.name}`,
        message ? `Message: ${message}` : null
      ].filter(Boolean);
      await ghl.post(`/contacts/${contactId}/notes`, { body: noteLines.join('\n'), userId: '' }).catch(() => {});
    }
    console.log(`[creator-pages] Submission for ${brand.name}: ${email} (${tiktokHandle||'no handle'})`);
    res.json({ ok: true, contactId });
  } catch(e) {
    console.error('[creator-pages/submit]', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: 'Submission failed — please try again' });
  }
});

// POST /api/proposals/publish — public so prospects can be linked directly
// Registered BEFORE requireAuth so it doesn't need a CF Access session
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

// ── HEVC → H.264 auto-conversion ─────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────────────────────

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

// ─── Client Portal ────────────────────────────────────────────────────────────
// ── Client portal bug reporter ────────────────────────────────────────────────
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
  max: 10,
  message: { error: 'Too many login attempts — try again in 15 minutes.' },
});

function requireClientSession(req, res, next) {
  if (!req.session?.clientBrandId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
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
    const brand = (brands.clients || []).find(
      b => b.loginEmail && b.loginEmail.toLowerCase() === email.toLowerCase().trim()
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
    const idx = (brands.clients || []).findIndex(
      b => b.loginEmail && b.loginEmail.toLowerCase() === email.toLowerCase().trim()
    );
    if (idx === -1) return res.status(401).json({ error: 'No account found for that email.' });
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

    // TikTok Shop stats — use brand's own token if available, else skip
    let tiktokStats = null, tiktokFunnel = null, tiktokConnected = false;
    if (brand.tiktokShopToken?.access_token) {
      tiktokConnected = true;
      try {
        const now   = Math.floor(Date.now() / 1000);
        const start = now - 30 * 24 * 60 * 60;
        const [ordersRes, creatorsRes] = await Promise.allSettled([
          ttsBrandPost(brand, brands, brandIdx, '/affiliate/seller/202309/orders/search', {
            create_time_ge: start,
            create_time_lt: now,
            page_size: 100,
          }),
          ttsBrandPost(brand, brands, brandIdx, '/affiliate/seller/202309/creators/search', {
            page_size: 50,
          }),
        ]);

        let gmv = 0, orderCount = 0;
        const creatorMap = {};
        if (ordersRes.status === 'fulfilled') {
          const affOrders = ordersRes.value?.data?.affiliate_orders || ordersRes.value?.data?.orders || [];
          orderCount = affOrders.length;
          for (const o of affOrders) {
            const amt = parseFloat(o.sale_amount ?? o.payment_info?.original_total_product_price ?? o.total_amount ?? 0);
            gmv += amt;
            const handle = o.creator_handle || o.creator_username || o.creator_open_id;
            if (handle) {
              if (!creatorMap[handle]) creatorMap[handle] = { handle, gmv: 0, orders: 0 };
              creatorMap[handle].gmv    += amt;
              creatorMap[handle].orders += 1;
            }
          }
        }

        let activeCreators = 0;
        const allCreators = [];
        if (creatorsRes.status === 'fulfilled') {
          const list = creatorsRes.value?.data?.creators || [];
          activeCreators = list.length;
          for (const c of list) {
            allCreators.push({
              handle: c.creator_handle || c.username || c.creator_open_id,
              gmv:    parseFloat(c.sale_amount ?? c.gmv ?? 0),
            });
          }
        }

        tiktokStats = { gmv, orders: orderCount, active_creators: activeCreators };

        // Top creators: merge affiliate orders map with creator list, sort by GMV
        const topCreatorsArr = Object.values(creatorMap).sort((a, b) => b.gmv - a.gmv).slice(0, 6);
        if (!topCreatorsArr.length) {
          allCreators.sort((a, b) => b.gmv - a.gmv);
          topCreatorsArr.push(...allCreators.slice(0, 6));
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
        referralCode: brand.referralCode,
        commissionRate: brand.commissionRate ?? 0.10,
        referralUrl,
        estimatedCommission: brand.estimatedCommission || 0,
        referrals: brand.referrals || [],
        affiliatePageUrl: brand.affiliatePageUrl || '',
      },
      tiktok: { connected: tiktokConnected, stats: tiktokStats, funnel: tiktokFunnel },
      tasks,
    });
  } catch (e) {
    const brands = loadBrands();
    const brand = (brands.clients || []).find(b => b.id === req.session?.clientBrandId);
    sendClientBugReport({ brandName: brand?.name, brandId: req.session?.clientBrandId, route: 'GET /api/client/me', error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/client/settings — update sample budget + full compensation config
app.patch('/api/client/settings', requireClientSession, express.json(), async (req, res) => {
  try {
    const brands = loadBrands();
    const idx = (brands.clients || []).findIndex(b => b.id === req.session.clientBrandId);
    if (idx === -1) return res.status(404).json({ error: 'Brand not found' });
    const brand = brands.clients[idx];
    const { sampleBudget, compensation, affiliatePageUrl } = req.body || {};
    if (sampleBudget !== undefined) brand.sampleBudget = Number(sampleBudget) || 0;
    if (compensation && typeof compensation === 'object') {
      if (!brand.creatorPage) brand.creatorPage = {};
      brand.creatorPage.incentives = compensation;
    }
    if (affiliatePageUrl !== undefined) brand.affiliatePageUrl = affiliatePageUrl || '';
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
    res.status(400).json({ error: `unknown action: ${action}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Client portal: Buffer channel proxy ─────────────────────────────────────
// GET /api/client/buffer/channels
app.get('/api/client/buffer/channels', requireClientSession, async (req, res) => {
  try {
    const token = process.env.BUFFER_ACCESS_TOKEN;
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
    const token = process.env.BUFFER_ACCESS_TOKEN;
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
    const appKey = process.env.ARCADS_APP_KEY || process.env.ARCADS_CLIENT_ID;
    const appSecret = process.env.ARCADS_API_KEY;
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
    const appKey = process.env.ARCADS_APP_KEY || process.env.ARCADS_CLIENT_ID;
    const appSecret = process.env.ARCADS_API_KEY;
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
    const appKey = process.env.ARCADS_APP_KEY || process.env.ARCADS_CLIENT_ID;
    const appSecret = process.env.ARCADS_API_KEY;
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
  if (state) {
    try { brandId = JSON.parse(Buffer.from(state, 'base64').toString()).brandId; } catch (_) {}
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
    const tokenData = {
      access_token:  data.data.access_token,
      refresh_token: data.data.refresh_token,
      expires_at:    Date.now() + (data.data.access_token_expire_in || 86400) * 1000,
      open_id:       data.data.open_id,
    };
    // Fetch shop info
    let shopName = 'Unknown';
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
      }
    } catch (e) { console.warn('[tiktokshop] shop cipher fetch failed:', e.message); }

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

app.use(requireAuth); // all other routes require auth in production

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
  locationId: process.env.GHL_LOC_ID,
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

// ─── Simple TTL cache ──────────────────────────────────────────────────────────
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

// ─── TikTok token helpers ──────────────────────────────────────────────────────
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';
const tiktokAuthState = new Map(); // PKCE state store (short-lived, in-memory)

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

// ─── Cache control ─────────────────────────────────────────────────────────────
app.post('/api/clear-cache', (req, res) => {
  cache.clear();
  res.json({ ok: true });
});

// ─── Buffer content pipeline ───────────────────────────────────────────────────
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

// ─── Twitter / X stats (via Apify pratikdani~twitter-profile-scraper) ──────────
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

// ─── Reacher / TikTok Affiliate Manager ───────────────────────────────────────
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

// ─── Creator Database endpoints ───────────────────────────────────────────────

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
// Searches for contacts tagged "Reacher:" and maps handle → {id, name, phone, email, tags}
app.get('/api/creators/ghl-map', async (req, res) => {
  try {
    const data = await cached('creators_ghl_map', 10 * 60_000, async () => {
      // GHL contacts/search — fetch contacts tagged with Reacher
      let page = 1;
      const allContacts = [];
      while (true) {
        let contacts = [];
        try {
          const { data: sr } = await ghl.post('/contacts/search', {
            locationId: CFG.locationId,
            filters: [{ group: 'AND', filters: [{ field: 'tags', operator: 'contains', value: 'Reacher:' }] }],
            page,
            pageLimit: 100,
          });
          contacts = sr?.contacts || sr?.data || [];
        } catch (_) {
          // Fallback: tag-based search via GET
          const { data: tr } = await ghl.get('/contacts/', {
            params: { locationId: CFG.locationId, tags: 'Reacher', limit: 100, skip: (page - 1) * 100 },
          });
          contacts = tr?.contacts || [];
        }
        if (!contacts.length) break;
        allContacts.push(...contacts);
        if (contacts.length < 100) break;
        page++;
      }

      // Build handle → contact map
      const TIKTOK_FIELD = '39UVa4ENm3OeOiafUU1c';
      const map = {};
      for (const c of allContacts) {
        const ttUrl = (c.customFields || []).find(f => f.id === TIKTOK_FIELD)?.value || '';
        if (!ttUrl) continue;
        // Extract handle: https://www.tiktok.com/@handle or @handle
        const match = ttUrl.match(/@([\w.]+)/);
        if (!match) continue;
        const handle = match[1].toLowerCase();
        map[handle] = {
          id:    c.id,
          name:  `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.name || handle,
          phone: c.phone || '',
          email: c.email || '',
          tags:  c.tags  || [],
        };
      }
      return map;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ─── Skool community stats (scrape public about page) ─────────────────────────
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

// ─── Affiliate Agent routes ──────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
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

// ── POST /api/affiliate/blast ─────────────────────────────────────────────────
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


// ─── Paid Media Agent routes ─────────────────────────────────────────────────
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

// ── Shared TikTok POST helper ─────────────────────────────────────────────────
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

      // ── 2. Fetch integrated report (last 30 days) ───────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
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


// ─────────────────────────────────────────────────────────────────────────────
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

// GET /api/client-meetings  — all meetings + aggregated intel
app.get('/api/client-meetings', (req, res) => {
  const data = loadClientMeetings();
  const meetings = data.meetings || [];
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

// POST /api/client-meetings  — add a meeting with AI analysis
app.post('/api/client-meetings', async (req, res) => {
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

// DELETE /api/client-meetings/:id
app.delete('/api/client-meetings/:id', (req, res) => {
  const data = loadClientMeetings();
  const before = data.meetings.length;
  data.meetings = data.meetings.filter(m => m.id !== req.params.id);
  if (data.meetings.length === before) return res.status(404).json({ ok: false, error: 'Not found' });
  saveClientMeetings(data);
  res.json({ ok: true });
});

// PATCH /api/client-meetings/:id/action/:idx  — edit fields or quick status toggle
// Edit:   body with any of { task, assignee, client, priority, status, notes }
// Toggle: body with { toggleStatus: true } — cycles open→in-progress→closed
app.patch('/api/client-meetings/:id/action/:idx', async (req, res) => {
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

// DELETE /api/client-meetings/:id/action/:idx — remove a single action item
app.delete('/api/client-meetings/:id/action/:idx', (req, res) => {
  const data = loadClientMeetings();
  const m = data.meetings.find(m => m.id === req.params.id);
  if (!m) return res.status(404).json({ ok: false, error: 'Not found' });
  const idx = parseInt(req.params.idx, 10);
  if (!m.actionItems[idx]) return res.status(404).json({ ok: false, error: 'Action not found' });
  m.actionItems.splice(idx, 1);
  saveClientMeetings(data);
  res.json({ ok: true });
});

// POST /api/client-meetings/reanalyze — re-run AI on all stored meetings with current client list
app.post('/api/client-meetings/reanalyze', requireAuth, async (req, res) => {
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

// POST /api/client-meetings/import-fireflies — import a single transcript by Fireflies URL or ID
// e.g. https://app.fireflies.ai/view/Trusted-Rituals-Onboarding::01KRGPSQ4XHFNB1KZY0Z8B3EB5
app.post('/api/client-meetings/import-fireflies', requireAuth, async (req, res) => {
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

// POST /api/client-meetings/sync-fireflies — pull recent Fireflies transcripts into Meeting Intel
app.post('/api/client-meetings/sync-fireflies', requireAuth, async (req, res) => {
  try {
    const keys = [process.env.FIREFLIES_API_KEY, process.env.FIREFLIES_API_KEY_2].filter(Boolean);
    if (!keys.length) return res.status(400).json({ ok: false, error: 'FIREFLIES_API_KEY not set' });

    const days  = req.body?.days || 90; // default 90 days to catch older meetings
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
    const { data } = await storistaClient().get(`/v1/tiktok/${req.params.account}/products`);
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
    const { data: media } = await s.post('/v1/media/', {
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
    const { data: created } = await s.post(`/v1/tiktok/${account}/videos`, {
      video_id,
      product_id: product_id || '',
      product:    product    || '',
      product_link: product_link || '',
      caption:    caption    || '',
    });

    const vid_id = created.id || created.video_id;

    // 2. Publish it
    await s.post(`/v1/tiktok/${account}/videos/${vid_id}/publish`);

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
      `/v1/tiktok/${req.params.account}/videos/${req.params.videoId}`
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

// ═══════════════════════════════════════════════════════════════════════════════
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
// 4. HMAC-SHA256(app_secret, base_string) → uppercase hex
function signTTShop(apiPath, params, body = '') {
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET || '';
  const sorted = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'access_token')
    .sort();
  const paramStr = sorted.map(k => `${k}${params[k]}`).join('');
  const bodyStr  = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
  const base     = `${appSecret}${apiPath}${paramStr}${bodyStr}`;
  return crypto.createHmac('sha256', appSecret).update(base).digest('hex').toUpperCase();
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
      tokens.shop = {
        ...shopTok,
        access_token:  data.data.access_token,
        refresh_token: data.data.refresh_token || shopTok.refresh_token,
        expires_at:    Date.now() + (data.data.access_token_expire_in || 86400) * 1000,
      };
      saveTikTokTokens(tokens);
      return true;
    }
  } catch (e) {
    console.error('[tiktokshop] token refresh failed:', e.message);
  }
  return false;
}

// ── ttsGet / ttsPost helpers that auto-refresh expired tokens ─────────────────
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
      brand.tiktokShopToken = {
        ...t,
        access_token:  data.data.access_token,
        refresh_token: data.data.refresh_token || t.refresh_token,
        expires_at:    Date.now() + (data.data.access_token_expire_in || 86400) * 1000,
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
    app_key:     process.env.TIKTOK_SHOP_APP_KEY || '',
    timestamp:   Math.floor(Date.now() / 1000),
    shop_cipher: brandToken.shop_cipher,
    ...params,
  };
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

async function ttsBrandGet(brand, brands, brandIdx, apiPath, params = {}) {
  let t = brand.tiktokShopToken;
  if (!t?.access_token) throw new Error('No TikTok Shop token for brand');
  if (t.expires_at && Date.now() > t.expires_at - 120_000) {
    await refreshBrandShopToken(brand, brands, brandIdx);
    t = brands.clients[brandIdx].tiktokShopToken;
  }
  return ttsBrandRequest(t, 'GET', apiPath, params);
}

async function ttsBrandPost(brand, brands, brandIdx, apiPath, body = {}, params = {}) {
  let t = brand.tiktokShopToken;
  if (!t?.access_token) throw new Error('No TikTok Shop token for brand');
  if (t.expires_at && Date.now() > t.expires_at - 120_000) {
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
      const allParams = {
        app_key:   process.env.TIKTOK_SHOP_APP_KEY || '',
        timestamp: Math.floor(Date.now() / 1000),
      };
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

    const params = { order_status, page_size, sort_field, sort_order };
    if (cursor) params.cursor = cursor;

    const data = await ttsPost('/order/202309/orders/search', {}, params);
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

    const data = await ttsPost('/finance/202309/orders/search', {}, params);
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

// ─── Video — Generate caption ──────────────────────────────────────────────────
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

// ─── Fireflies.ai — recent meeting list ──────────────────────────────────────
app.get('/api/fireflies/meetings', async (req, res) => {
  const keys = [process.env.FIREFLIES_API_KEY, process.env.FIREFLIES_API_KEY_2].filter(Boolean);
  if (!keys.length) return res.json({ connected: false, error: 'FIREFLIES_API_KEY not set' });

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 7);
  const fromDateStr = fromDate.toISOString().split('T')[0]; // YYYY-MM-DD

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
    return r.data?.data?.transcripts || [];
  };

  try {
    // Fetch from all configured Fireflies accounts in parallel
    const results = await Promise.allSettled(keys.map(fetchFromKey));
    const seen = new Set();
    const allMeetings = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const t of result.value) {
        if (seen.has(t.id)) continue; // dedupe across accounts
        seen.add(t.id);
        allMeetings.push(t);
      }
    }
    // Sort newest first
    allMeetings.sort((a, b) => (b.date || 0) - (a.date || 0));
    const meetings = allMeetings.map((t, i) => ({
      _idx:         i,
      id:           t.id,
      title:        t.title || 'Untitled Meeting',
      date:         t.date,
      participants: t.participants || [],
      summary:      t.summary || {},
    }));
    res.json({ connected: true, meetings, fromDate: fromDateStr, accountCount: keys.length });
  } catch (err) {
    console.error('fireflies:', err.response?.data || err.message);
    res.json({ connected: false, error: err.response?.data?.message || err.message });
  }
});

// ─── Fireflies.ai — full transcript for one meeting ──────────────────────────
app.get('/api/fireflies/transcript/:id', async (req, res) => {
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
      { query, variables: { id: req.params.id } },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }
    );
    return r.data?.data?.transcript || null;
  };
  try {
    // Try all accounts — transcript may live on any of them
    let t = null;
    for (const key of keys) {
      t = await tryFetch(key).catch(() => null);
      if (t?.sentences?.length) break; // found it
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
// ── Step 1: Extract metrics from transcript + Shopify ─────────────────────────
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
  } catch(e) { console.log(`[shopify] homepage scrape failed for ${domain}:`, e.message); }

  return result;
}

function buildIncentiveSummary(compensation) {
  if (!compensation) return '';
  const parts = [];
  const ordinals = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th'];
  if (compensation.cashback?.enabled)
    parts.push(`$${compensation.cashback.amount} cashback per video`);
  if (compensation.leaderboard?.enabled) {
    const places = compensation.leaderboard.places || [];
    const tiers  = places.map((amt, i) => `${ordinals[i]||i+1+'th'}: $${amt}`).join(', ');
    parts.push(`Leaderboard challenge (min $${compensation.leaderboard.threshold} GMV) — ${tiers}`);
  }
  if (compensation.volumeBonus?.enabled)
    parts.push(`$${compensation.volumeBonus.bonus} bonus for ${compensation.volumeBonus.quantity}+ videos`);
  if (compensation.retainer?.enabled)
    parts.push(`Creator retainer: $${compensation.retainer.budget}/mo for ${compensation.retainer.postsRequired} posts`);
  return parts.join('\n• ');
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
      model: 'claude-sonnet-4-6', max_tokens: 4000,
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

  // 1. Scrape Shopify
  const shopifyData = await scrapeShopify(formData.website).catch(() => ({ brand:{}, products:[] }));
  console.log(`[onboard] Scraped ${shopifyData.products.length} products from ${shopifyData.domain}`);

  // 2. Generate AI content
  const aiContent = await generateOnboardingContent(formData, shopifyData).catch(e => {
    console.error('[onboard] AI gen error:', e.message); return null;
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

  // 4b. Auto-create Reacher automations based on incentive program
  if (formData.compensation && shopData?.shopId) {
    const { cashback, leaderboard, volumeBonus } = formData.compensation;
    const autoPromises = [];

    if (cashback?.enabled) {
      const msg = `Hi! I'm reaching out from ${brandName}. We have an exciting cashback program — if you generate $${cashback.target} in GMV, you receive that same amount back as a cash bonus. Interested in learning more?`;
      autoPromises.push(
        axios.post(`${CFG.railwayUrl}/affiliate/shops/${shopData.shopId}/automation/tc`,
          { name: `${brandName} — GMV Cashback Outreach`, message: msg.slice(0, 500), trigger: 'new_signup' },
          { timeout: 10000 }
        ).catch(e => console.error('[onboard] cashback auto error:', e.message))
      );
    }
    if (leaderboard?.enabled) {
      const msg = `Join the ${brandName} creator leaderboard! Top performers this month win cash prizes. Post videos and climb the ranks — the more you sell, the more you earn.`;
      autoPromises.push(
        axios.post(`${CFG.railwayUrl}/affiliate/shops/${shopData.shopId}/automation/dm`,
          { name: `${brandName} — Leaderboard Challenge`, message: msg, trigger: 'active_posters' },
          { timeout: 10000 }
        ).catch(e => console.error('[onboard] leaderboard auto error:', e.message))
      );
    }
    if (volumeBonus?.enabled) {
      const msg = `Great news! ${brandName} offers a volume bonus — post ${volumeBonus.quantity || 'X'} videos and earn an extra $${volumeBonus.bonus || '?'} bonus. Keep posting!`;
      autoPromises.push(
        axios.post(`${CFG.railwayUrl}/affiliate/shops/${shopData.shopId}/automation/tc`,
          { name: `${brandName} — Volume Bonus`, message: msg.slice(0, 500), trigger: 'active_posters' },
          { timeout: 10000 }
        ).catch(e => console.error('[onboard] volume auto error:', e.message))
      );
    }
    if (autoPromises.length) {
      await Promise.allSettled(autoPromises);
      console.log(`[onboard] Created ${autoPromises.length} Reacher automation(s) for ${brandName}`);
    }
  }

  // 5. Create draft creator page (inactive until approved)
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
    brand.website     = formData.website;
    brand.creatorPage = {
      slug, tagName: `creator-interested-${slug}`, active: true,
      headline: `Partner with ${brandName}`,
      subheadline: 'Join our TikTok Shop creator affiliate program',
      pitch, accentColor: '#00f2ea',
      incentives: formData.compensation,
      usps: [formData.usp1, formData.usp2, formData.usp3].filter(Boolean),
      talkingPoints: formData.talkingPoints || '',
      products: formData.products || [],
      tiktokHandle: formData.tiktokHandle || '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    saveBrands(brandsData);
    creatorPage = { slug, publicUrl: `${PUBLIC_BASE_URL}/creators/${slug}`, active: true };
    console.log(`[onboard] Creator page draft: ${creatorPage.publicUrl}`);
  } catch(e) { console.error('[onboard] creator page error:', e.message); }

  // 5b. Auto-match Reacher shop by brand name (fuzzy)
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
      const bd = loadBrands();
      const bi = bd.clients.findIndex(b => slugify(b.name) === slugify(brandName));
      if (bi !== -1 && !bd.clients[bi].shopId) {
        bd.clients[bi].shopId = match.shop_id;
        saveBrands(bd);
        console.log(`[onboard] Reacher auto-match: ${match.shop_name} → shopId ${match.shop_id}`);
      }
    } else {
      console.log(`[onboard] No Reacher shop match for: ${brandName}`);
    }
  } catch(e) { console.error('[onboard] Reacher shop lookup error:', e.message); }

  // 6. Save pending review entry
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    createdAt: new Date().toISOString(),
    status: 'pending',
    formData, shopifyData, aiContent, ghlContactId, larkDoc, creatorPage,
  };
  const pending = loadPendingOnboards();
  pending.unshift(entry);
  savePendingOnboards(pending);

  // 7. Send comprehensive Lark alert
  await sendLarkOnboardingAlert(formData, shopifyData, aiContent, larkDoc, creatorPage);

  console.log(`[onboard] Pipeline complete: ${brandName} (id: ${entry.id})`);
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

function renderCreatorPage(brand, cp) {
  const accent    = cp.accentColor || '#00f2ea';
  const ar        = hexToRgb(accent);
  const name      = brand.name || 'Brand';
  const incentives = cp.incentives || {};
  const products  = (cp.products || []).filter(p => p.name);
  const usps      = (cp.usps || []).filter(Boolean);
  const talking   = (cp.talkingPoints || '').split('\n').map(s => s.trim()).filter(Boolean);
  const videos    = (cp.competitorVideos || []).filter(Boolean);
  const tiktokHandle = cp.tiktokHandle || brand.tiktokHandle || '';

  // Build incentive pills + section
  const pills = [];
  let incentiveHtml = '';
  if (incentives.cashback?.enabled) {
    pills.push(`${incentives.cashback.percent || ''}% Cashback`);
    incentiveHtml += `
    <div class="incentive-card">
      <div class="incentive-icon">💰</div>
      <div class="incentive-label">CASHBACK RATE</div>
      <div class="incentive-value">${incentives.cashback.percent || '—'}%</div>
      <div class="incentive-sub">on every sale you drive${incentives.cashback.gmvTarget ? ` · $${Number(incentives.cashback.gmvTarget).toLocaleString()} GMV target` : ''}</div>
    </div>`;
  }
  if (incentives.leaderboard?.enabled && incentives.leaderboard.prizes?.length) {
    pills.push('Monthly Leaderboard');
    const prizes = incentives.leaderboard.prizes;
    incentiveHtml += `
    <div class="incentive-card">
      <div class="incentive-icon">🏆</div>
      <div class="incentive-label">MONTHLY LEADERBOARD</div>
      <div class="incentive-value">${prizes[0] || '—'}</div>
      <div class="incentive-sub">top prize · ${prizes.slice(1).filter(Boolean).map((p,i)=>`${['2nd','3rd'][i]}: ${p}`).join(' · ')}${incentives.leaderboard.threshold ? ` · $${Number(incentives.leaderboard.threshold).toLocaleString()} min GMV` : ''}</div>
    </div>`;
  }
  if (incentives.volumeBonus?.enabled) {
    pills.push(`$${incentives.volumeBonus.bonusAmount} Volume Bonus`);
    incentiveHtml += `
    <div class="incentive-card">
      <div class="incentive-icon">🎯</div>
      <div class="incentive-label">VOLUME BONUS</div>
      <div class="incentive-value">$${incentives.volumeBonus.bonusAmount || '—'}</div>
      <div class="incentive-sub">post ${incentives.volumeBonus.videoCount || '—'} videos and earn a bonus on top of cashback</div>
    </div>`;
  }

  const productsHtml = products.map(p => `
    <div class="product-card">
      <div class="product-name">${p.name}</div>
      ${p.minPrice ? `<div class="product-price">From $${Number(p.minPrice).toFixed(2)}</div>` : ''}
      ${p.url ? `<a href="${p.url}" target="_blank" rel="noopener" class="product-link">View on TikTok Shop →</a>` : ''}
    </div>`).join('');

  const uspHtml = usps.map(u => `<li class="usp-item"><span class="usp-check">✓</span>${u}</li>`).join('');

  const talkingHtml = talking.map(t => `<li class="talking-item">${t}</li>`).join('');

  const videosHtml = videos.map(url => {
    const vid = extractTikTokVideoId(url);
    if (!vid) return '';
    return `<div class="video-wrap">
      <iframe src="https://www.tiktok.com/embed/v2/${vid}"
        width="325" height="576"
        style="border:none;border-radius:12px;max-width:100%"
        allow="fullscreen;autoplay"
        scrolling="no"
        loading="lazy">
      </iframe>
    </div>`;
  }).filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Partner with ${name} — TikTok Shop Affiliate Program</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#fff;min-height:100vh}
/* ── Hero ── */
.hero{background:linear-gradient(160deg,#0d0b14 0%,#12101e 60%,#0a0a0f 100%);border-bottom:1px solid rgba(255,255,255,.06);padding:72px 20px 60px;text-align:center}
.brand-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(${ar},.1);border:1px solid rgba(${ar},.25);border-radius:100px;padding:6px 16px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${accent};margin-bottom:24px}
h1{font-size:clamp(28px,5vw,52px);font-weight:900;line-height:1.06;margin-bottom:16px;letter-spacing:-.02em;max-width:760px;margin-left:auto;margin-right:auto}
.hero-sub{font-size:clamp(13px,2vw,17px);color:rgba(255,255,255,.45);max-width:520px;margin:0 auto 32px;line-height:1.65}
.pills{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:0}
.pill{background:rgba(${ar},.1);color:${accent};border:1px solid rgba(${ar},.25);border-radius:100px;padding:6px 16px;font-size:12px;font-weight:700}
/* ── Sections ── */
.section{padding:60px 20px}
.section-inner{max-width:900px;margin:0 auto}
.section-label{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px}
.section-title{font-size:clamp(20px,3vw,30px);font-weight:900;margin-bottom:8px;letter-spacing:-.01em}
.section-sub{font-size:14px;color:rgba(255,255,255,.45);line-height:1.6;margin-bottom:36px}
.divider{border:none;border-top:1px solid rgba(255,255,255,.06);margin:0}
/* ── Incentives ── */
.incentives-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.incentive-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px;text-align:center;transition:border-color .2s}
.incentive-card:hover{border-color:rgba(${ar},.4)}
.incentive-icon{font-size:28px;margin-bottom:10px}
.incentive-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:6px}
.incentive-value{font-size:32px;font-weight:900;color:${accent};line-height:1;margin-bottom:6px}
.incentive-sub{font-size:12px;color:rgba(255,255,255,.4);line-height:1.5}
/* ── Products ── */
.products-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.product-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px}
.product-name{font-size:15px;font-weight:700;margin-bottom:6px}
.product-price{font-size:13px;color:${accent};font-weight:700;margin-bottom:10px}
.product-link{font-size:12px;color:${accent};text-decoration:none;font-weight:600}
.product-link:hover{text-decoration:underline}
/* ── USPs ── */
.usp-list{list-style:none;display:flex;flex-direction:column;gap:14px}
.usp-item{display:flex;align-items:flex-start;gap:12px;font-size:16px;font-weight:600;line-height:1.4}
.usp-check{flex-shrink:0;width:24px;height:24px;background:rgba(${ar},.15);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;color:${accent};font-weight:900}
/* ── Videos ── */
.videos-scroll{display:flex;gap:16px;overflow-x:auto;padding-bottom:8px;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
.video-wrap{flex-shrink:0}
/* ── Talking Points ── */
.talking-list{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.talking-item{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:14px 16px;font-size:14px;color:rgba(255,255,255,.75);line-height:1.5;position:relative;padding-left:30px}
.talking-item::before{content:'→';position:absolute;left:12px;color:${accent};font-weight:900}
/* ── Form ── */
.form-wrap{max-width:600px;margin:0 auto}
.form-head{font-size:22px;font-weight:900;margin-bottom:6px}
.form-sub{font-size:13px;color:rgba(255,255,255,.4);margin-bottom:28px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.row.full{grid-template-columns:1fr}
@media(max-width:500px){.row{grid-template-columns:1fr}}
.field{display:flex;flex-direction:column;gap:5px}
label{font-size:10px;font-weight:700;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.06em}
input,select,textarea{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#fff;font-size:14px;padding:12px 14px;outline:none;transition:border-color .18s;width:100%;font-family:inherit}
input::placeholder,textarea::placeholder{color:rgba(255,255,255,.2)}
input:focus,select:focus,textarea:focus{border-color:${accent}}
select option{background:#12101e;color:#fff}
.btn-submit{width:100%;background:${accent};color:#000;border:none;border-radius:10px;font-size:16px;font-weight:900;padding:16px;cursor:pointer;margin-top:10px;transition:opacity .2s,transform .1s;letter-spacing:.01em}
.btn-submit:hover{opacity:.88}
.btn-submit:active{transform:scale(.98)}
.btn-submit:disabled{opacity:.45;cursor:not-allowed}
.err{color:#ff5b5b;font-size:12px;margin-top:8px;display:none}
.success{display:none;text-align:center;padding:56px 0}
.success-icon{font-size:56px;margin-bottom:20px}
.success-title{font-size:24px;font-weight:900;margin-bottom:10px}
.success-msg{font-size:14px;color:rgba(255,255,255,.45);line-height:1.7}
/* ── Footer ── */
footer{border-top:1px solid rgba(255,255,255,.06);padding:24px 20px;text-align:center;font-size:11px;color:rgba(255,255,255,.2)}
footer a{color:${accent};text-decoration:none}
</style>
</head>
<body>

<!-- ── HERO ── -->
<div class="hero">
  <div class="brand-badge">${name} × Cult Content</div>
  <h1>Partner with <span style="color:${accent}">${name}</span> on TikTok Shop</h1>
  <div class="hero-sub">Join our affiliate creator program — earn cashback on every sale you drive plus monthly bonuses.</div>
  ${pills.length ? `<div class="pills">${pills.map(p=>`<span class="pill">${p}</span>`).join('')}</div>` : ''}
</div>

${incentiveHtml ? `
<hr class="divider">
<!-- ── INCENTIVES ── -->
<div class="section" style="background:rgba(${ar},.03)">
  <div class="section-inner">
    <div class="section-label">Creator Incentive Program</div>
    <div class="section-title">How you get paid</div>
    <div class="section-sub">Stack multiple income streams every month.</div>
    <div class="incentives-grid">${incentiveHtml}</div>
  </div>
</div>` : ''}

${productsHtml ? `
<hr class="divider">
<!-- ── PRODUCTS ── -->
<div class="section">
  <div class="section-inner">
    <div class="section-label">Products to Promote</div>
    <div class="section-title">What you'll be featuring</div>
    <div class="section-sub">High-converting products with strong customer reviews.</div>
    <div class="products-grid">${productsHtml}</div>
  </div>
</div>` : ''}

${uspHtml ? `
<hr class="divider">
<!-- ── WHY THIS BRAND ── -->
<div class="section" style="background:rgba(255,255,255,.02)">
  <div class="section-inner" style="max-width:640px">
    <div class="section-label">Why creators love ${name}</div>
    <div class="section-title">Built to convert</div>
    <div class="section-sub">Products your audience will actually want to buy.</div>
    <ul class="usp-list">${uspHtml}</ul>
  </div>
</div>` : ''}

${videosHtml ? `
<hr class="divider">
<!-- ── EXAMPLE CONTENT ── -->
<div class="section">
  <div class="section-inner">
    <div class="section-label">Content That Converts</div>
    <div class="section-title">Examples to inspire your videos</div>
    <div class="section-sub">High-performing content formats for this niche.</div>
    <div class="videos-scroll">${videosHtml}</div>
  </div>
</div>` : ''}

${talkingHtml ? `
<hr class="divider">
<!-- ── TALKING POINTS ── -->
<div class="section" style="background:rgba(255,255,255,.02)">
  <div class="section-inner">
    <div class="section-label">Creator Brief</div>
    <div class="section-title">Key talking points</div>
    <div class="section-sub">Weave these into your content for the best results.</div>
    <ul class="talking-list">${talkingHtml}</ul>
  </div>
</div>` : ''}

<hr class="divider">
<!-- ── APPLY FORM ── -->
<div class="section">
  <div class="section-inner">
    <div class="form-wrap">
      <div id="formWrap">
        <div class="form-head">Apply to partner with ${name}</div>
        <div class="form-sub">Takes 2 minutes — our team reviews every application within 48 hours.</div>
        <form id="form">
          <div class="row">
            <div class="field"><label>First name *</label><input name="firstName" required placeholder="Jane"></div>
            <div class="field"><label>Last name *</label><input name="lastName" required placeholder="Smith"></div>
          </div>
          <div class="row">
            <div class="field"><label>Email *</label><input name="email" type="email" required placeholder="jane@email.com"></div>
            <div class="field"><label>Phone</label><input name="phone" type="tel" placeholder="+1 555-000-0000"></div>
          </div>
          <div class="row">
            <div class="field"><label>TikTok handle *</label><input name="tiktokHandle" required placeholder="@yourhandle"></div>
            <div class="field">
              <label>Follower count *</label>
              <select name="followerRange" required>
                <option value="" disabled selected>Select range</option>
                <option>1K – 10K</option><option>10K – 50K</option>
                <option>50K – 100K</option><option>100K – 500K</option><option>500K+</option>
              </select>
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label>Monthly TikTok GMV</label>
              <select name="gmv">
                <option value="">No shop / not sure</option>
                <option>&lt;$1K/mo</option><option>$1K–$5K/mo</option>
                <option>$5K–$20K/mo</option><option>$20K+/mo</option>
              </select>
            </div>
            <div class="field">
              <label>Primary niche</label>
              <select name="niche">
                <option value="">Select niche</option>
                <option>Beauty &amp; Skincare</option><option>Health &amp; Wellness</option>
                <option>Fashion &amp; Style</option><option>Home &amp; Lifestyle</option>
                <option>Food &amp; Beverage</option><option>Fitness</option><option>Tech &amp; Gadgets</option><option>Other</option>
              </select>
            </div>
          </div>
          <div class="row full">
            <div class="field">
              <label>Anything else? (optional)</label>
              <textarea name="message" placeholder="Tell us about your content or why you're excited to partner…" rows="3"></textarea>
            </div>
          </div>
          <div class="err" id="formErr"></div>
          <button type="submit" class="btn-submit" id="submitBtn">Apply Now →</button>
        </form>
      </div>
      <div class="success" id="successWrap">
        <div class="success-icon">🎉</div>
        <div class="success-title">Application submitted!</div>
        <div class="success-msg">Thanks! Our team will review your application and reach out within 48 hours.${tiktokHandle ? `<br><br>Follow <strong style="color:${accent}">@${tiktokHandle}</strong> on TikTok for updates.` : ''}</div>
      </div>
    </div>
  </div>
</div>

<footer>Powered by <a href="https://cultcontent.cc" target="_blank">Cult Content</a> — TikTok Shop Creator Agency</footer>
<script>
document.getElementById('form').addEventListener('submit',async function(e){
  e.preventDefault();
  const btn=document.getElementById('submitBtn'),err=document.getElementById('formErr');
  btn.disabled=true;btn.textContent='Submitting…';err.style.display='none';
  const body=Object.fromEntries(new FormData(this));
  body.brandSlug='${cp.slug}';
  try{
    const r=await fetch('/api/creator-pages/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(d.ok){document.getElementById('formWrap').style.display='none';document.getElementById('successWrap').style.display='block';}
    else throw new Error(d.error||'Unknown error');
  }catch(ex){
    btn.disabled=false;btn.textContent='Apply Now →';
    err.textContent='Something went wrong — please try again or email hello@cultcontent.cc';
    err.style.display='block';
  }
});
</script>
</body>
</html>`;
}

// (Public /creators/:brandSlug and /api/creator-pages/submit are registered before requireAuth above)

// GET /api/creator-pages — List all brands with creator page status
app.get('/api/creator-pages', requireAuth, (req, res) => {
  const brands  = loadBrands();
  const baseUrl = PUBLIC_BASE_URL;
  const pages   = (brands.clients || []).map(b => ({
    id:        b.id,
    name:      b.name,
    creatorPage: b.creatorPage || null,
    publicUrl: b.creatorPage?.slug ? `${baseUrl}/creators/${b.creatorPage.slug}` : null,
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
  const publicUrl = `${PUBLIC_BASE_URL}/creators/${slug}`;
  console.log(`[creator-pages] Setup page for ${brand.name}: ${publicUrl}`);
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
  const publicUrl = `${PUBLIC_BASE_URL}/creators/${data.clients[idx].creatorPage.slug}`;
  res.json({ ok: true, brand: data.clients[idx], publicUrl });
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

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'dashboard' }));

// ── Startup: ensure known contact names are set on manually-added brands ───────
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

app.listen(CFG.port, () => {
  console.log(`\n⚡ Cult Content Command Center`);
  console.log(`   http://localhost:${CFG.port}\n`);
});
