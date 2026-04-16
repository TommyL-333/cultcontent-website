/**
 * Cult Content — Consultant Onboarding Webhook
 * Triggered by GHL form submission (form: yKOFTYIE2Li3eLxxSXpW)
 *
 * What this does per submission:
 *  1. Parse & normalise form data
 *  2. Create GHL team-member user account
 *  3. Create personal calendar → get booking URL
 *  4. Create product (their 1-on-1 service)
 *  5. Generate profile page HTML from template
 *  6. Create + publish GHL funnel page at /consultants/<slug>
 *  7. Send consultant a welcome email with their booking link
 *  8. Send Tommy an internal notification
 */

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// ─── Config ──────────────────────────────────────────────────────────────────
const CFG = {
  ghlApiKey:        process.env.GHL_API_KEY   || 'pit-012c1650-1032-46f0-b293-72720e727a0b',
  locationId:       process.env.GHL_LOC_ID    || 'c216j58Vx9XxYa7WYMiA',
  companyId:        process.env.GHL_CO_ID     || 't9Y1zmM2krEFUOt2uVob',
  consultantFunnelId: process.env.FUNNEL_ID   || '',   // set after first run
  tommyEmail:       process.env.NOTIFY_EMAIL  || 'tommy@cultcontent.cc',
  port:             process.env.PORT          || 3456,
  baseUrl:          process.env.BASE_URL      || 'https://cultcontent.cc',
};

// Axios client pre-configured for GHL API v2
const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization:  `Bearer ${CFG.ghlApiKey}`,
    'Content-Type': 'application/json',
    Version:        '2021-07-28',
  },
});

// Load template once at startup
const TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'consultant-template.html'),
  'utf8'
);

// ─── Specialty → service card mapping ────────────────────────────────────────
const SPECIALTY_MAP = {
  'Shop Ops & Management': {
    icon: 'fa-solid fa-store',
    name: 'Shop Operations',
    desc: 'Full TikTok Shop setup, optimisation, and ongoing management to maximise revenue.',
  },
  'Affiliate Management': {
    icon: 'fa-solid fa-people-group',
    name: 'Affiliate Management',
    desc: 'Recruit, activate, and manage affiliates to drive consistent GMV at scale.',
  },
  'Short Video': {
    icon: 'fa-solid fa-video',
    name: 'Short Video Strategy',
    desc: 'Content strategy and scripting for high-converting TikTok Shop videos.',
  },
  'Paid Media': {
    icon: 'fa-solid fa-bullhorn',
    name: 'Paid Media & Ads',
    desc: 'TikTok Ads campaigns built to scale product revenue with measurable ROAS.',
  },
  'Live Video': {
    icon: 'fa-solid fa-circle-dot',
    name: 'TikTok Live',
    desc: 'Live selling strategy, scripting, and execution to convert viewers into buyers.',
  },
  'Omni-channel Strategy': {
    icon: 'fa-solid fa-diagram-project',
    name: 'Omni-Channel Strategy',
    desc: 'Unified commerce strategy across TikTok, Amazon, Shopify, and beyond.',
  },
  'Community Management': {
    icon: 'fa-solid fa-comments',
    name: 'Community Management',
    desc: 'Build and manage engaged communities that drive organic growth and loyalty.',
  },
  'Software & Systems': {
    icon: 'fa-solid fa-gears',
    name: 'Software & Systems',
    desc: 'Tech stack setup and automation workflows for TikTok Shop operators and agencies.',
  },
  'Creator Coaching': {
    icon: 'fa-solid fa-chalkboard-user',
    name: 'Creator Coaching',
    desc: 'Personal coaching for creators looking to monetise on TikTok Shop.',
  },
  'Executive Leadership': {
    icon: 'fa-solid fa-chart-line',
    name: 'Executive Leadership',
    desc: 'Strategic advisory for brands and agencies navigating TikTok Shop growth.',
  },
};

// Tag colours cycle — first specialty gets teal, second blue, etc.
const TAG_COLORS = ['tag-teal', 'tag-blue', 'tag-purple', 'tag-pink', 'tag-gold', 'tag-green'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** "Tommy Lynch" → "tommy-lynch" */
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Parse "1M GMV Generated, 4+ Years in the space, 100+ Brands Helped"
 * into [{ value: "1M", label: "GMV Generated" }, ...]
 */
function parseMetrics(raw = '') {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map(metric => {
      const [value, ...rest] = metric.split(' ');
      return { value, label: rest.join(' ') };
    });
}

/** Parse GHL webhook contact — handles both flat and customFields array formats */
function parseContact(body) {
  const c = body.contact || body;

  // Custom fields may arrive as an array or as flat keys
  const cf = {};
  if (Array.isArray(c.customFields)) {
    c.customFields.forEach(f => {
      // key might be fieldKey like "contact.headline_descriptor" or the field id
      const key = (f.fieldKey || f.key || f.id || '').replace('contact.', '');
      cf[key] = f.value || f.fieldValue || '';
    });
  }

  return {
    id:          c.id || c.contactId || '',
    firstName:   c.firstName || c.first_name || '',
    lastName:    c.lastName  || c.last_name  || '',
    email:       c.email     || '',
    phone:       c.phone     || '',
    headline:    c.headline_descriptor    || cf.headline_descriptor    || '',
    bio:         c.description_text       || cf.description_text       || '',
    metrics:     c.impressive_metrics     || cf.impressive_metrics     || '',
    photoUrl:    c.headshot_image         || cf.headshot_image         || '',
    specialties: c.specialties            || cf.specialties            || '',
    hourlyRate:  Number(c.hourly_rate     || cf.hourly_rate            || 0),
  };
}

/** Build the filled HTML for the consultant profile page */
function buildProfilePage(contact, bookingUrl) {
  const fullName    = `${contact.firstName} ${contact.lastName}`.trim();
  const stats       = parseMetrics(contact.metrics);
  const specialties = contact.specialties
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Expertise tag HTML
  const expertiseTags = specialties
    .map((s, i) => `<span class="expertise-tag ${TAG_COLORS[i % TAG_COLORS.length]}">${s}</span>`)
    .join('\n            ');

  // Service cards (up to 6) from selected specialties
  const serviceCards = specialties.slice(0, 6).map(s => {
    const info = SPECIALTY_MAP[s] || {
      icon: 'fa-solid fa-star',
      name: s,
      desc: `Expert guidance on ${s} for TikTok Shop brands and agencies.`,
    };
    return `
        <div class="service-card">
          <div class="service-icon"><i class="${info.icon}"></i></div>
          <div class="service-name">${info.name}</div>
          <p class="service-desc">${info.desc}</p>
        </div>`;
  }).join('');

  // Pad to 6 cards (empty hidden ones) so grid layout stays consistent
  // (just leave fewer cards — CSS grid handles it fine)

  let html = TEMPLATE;

  // Basic fields
  html = html.replace(/\{\{CONSULTANT_NAME\}\}/g,     fullName);
  html = html.replace(/\{\{CONSULTANT_TITLE\}\}/g,    contact.headline  || '');
  html = html.replace(/\{\{CONSULTANT_BIO_SHORT\}\}/g, contact.bio      || '');
  html = html.replace(/\{\{CONSULTANT_PHOTO_URL\}\}/g, contact.photoUrl || '');
  html = html.replace(/\{\{BOOKING_LINK\}\}/g,         bookingUrl);
  html = html.replace(/\{\{CONTACT_LINK\}\}/g,        `mailto:${contact.email}`);

  // Social links — blank until consultant fills them in
  html = html.replace(/\{\{CONSULTANT_LINKEDIN\}\}/g,  '#');
  html = html.replace(/\{\{CONSULTANT_TIKTOK\}\}/g,    '#');
  html = html.replace(/\{\{CONSULTANT_INSTAGRAM\}\}/g, '#');
  html = html.replace(/\{\{CONSULTANT_YOUTUBE\}\}/g,   '#');

  // Stats (up to 4)
  for (let i = 0; i < 4; i++) {
    const s = stats[i] || { value: '—', label: '' };
    html = html.replace(new RegExp(`\\{\\{STAT_${i+1}_VALUE\\}\\}`, 'g'), s.value);
    html = html.replace(new RegExp(`\\{\\{STAT_${i+1}_LABEL\\}\\}`, 'g'), s.label);
  }

  // Expertise tags (dynamic)
  html = html.replace('{{EXPERTISE_TAGS}}', expertiseTags);

  // Services intro
  html = html.replace(/\{\{SERVICES_INTRO\}\}/g,
    `Here's how I help TikTok Shop brands, sellers, and agencies get results.`);

  // Service cards — replace the whole service grid content
  html = html.replace(
    /<!-- Service 1 -->[\s\S]*?<!-- Service 6 \(optional\) -->[\s\S]*?<\/div>/,
    serviceCards
  );

  // Case study — placeholder values (consultant fills these in later)
  html = html.replace(/\{\{CASE_BRAND\}\}/g,         'Case Study');
  html = html.replace(/\{\{CASE_HEADLINE\}\}/g,      'Results coming soon');
  html = html.replace(/\{\{CASE_BODY\}\}/g,
    `${contact.firstName} is currently onboarding. Check back soon for detailed case studies.`);
  html = html.replace(/\{\{CASE_IMAGE_URL\}\}/g,     '');
  html = html.replace(/\{\{CASE_STAT_1_VALUE\}\}/g,  '');
  html = html.replace(/\{\{CASE_STAT_1_LABEL\}\}/g,  '');
  html = html.replace(/\{\{CASE_STAT_2_VALUE\}\}/g,  '');
  html = html.replace(/\{\{CASE_STAT_2_LABEL\}\}/g,  '');
  html = html.replace(/\{\{CASE_STAT_3_VALUE\}\}/g,  '');
  html = html.replace(/\{\{CASE_STAT_3_LABEL\}\}/g,  '');

  // Testimonial — placeholder
  html = html.replace(/\{\{TESTIMONIAL_TEXT\}\}/g,
    `Testimonials from ${contact.firstName}'s clients will appear here soon.`);
  html = html.replace(/\{\{TESTIMONIAL_AVATAR_URL\}\}/g,   '');
  html = html.replace(/\{\{TESTIMONIAL_INITIALS\}\}/g,
    (contact.firstName[0] || '') + (contact.lastName[0] || ''));
  html = html.replace(/\{\{TESTIMONIAL_AUTHOR_NAME\}\}/g,  'Client');
  html = html.replace(/\{\{TESTIMONIAL_AUTHOR_TITLE\}\}/g, 'TikTok Shop Brand');

  // Booking section copy
  html = html.replace(/\{\{BOOKING_BODY\}\}/g,
    `Book a ${contact.hourlyRate > 0 ? `$${contact.hourlyRate}/hr` : ''} session with ${contact.firstName} and leave with a clear action plan.`.trim());

  return html;
}

// ─── GHL API calls ────────────────────────────────────────────────────────────

async function createUser(contact) {
  console.log(`[GHL] Creating user for ${contact.email}…`);
  const { data } = await ghl.post('/users/', {
    companyId:  CFG.companyId,
    email:      contact.email,
    firstName:  contact.firstName,
    lastName:   contact.lastName,
    name:       `${contact.firstName} ${contact.lastName}`,
    phone:      contact.phone,
    type:       'account',
    role:       'user',
    locationIds: [CFG.locationId],
    permissions: {
      calendarsEnabled:      true,
      appointmentsEnabled:   true,
      contactsEnabled:       true,
      dashboardStatsEnabled: true,
      // everything billing/marketing off
      campaignsEnabled:      false,
      workflowsEnabled:      false,
      bulkRequestsEnabled:   false,
      marketingEnabled:      false,
      settingsEnabled:       false,
      tagsEnabled:           false,
      leadSourcesEnabled:    false,
      opportunitiesEnabled:  false,
      membershipEnabled:     false,
      onlineListingsEnabled: false,
      phoneCallEnabled:      false,
      reviewsEnabled:        false,
      leadValueEnabled:      false,
      agentReportingEnabled: false,
    },
  });
  console.log(`[GHL] User created: ${data.id}`);
  return data;
}

async function createCalendar(contact, userId) {
  console.log(`[GHL] Creating calendar for ${contact.firstName}…`);
  const { data } = await ghl.post('/calendars/', {
    locationId:           CFG.locationId,
    name:                 `${contact.firstName} ${contact.lastName} — Consulting`,
    description:          contact.headline || '',
    calendarType:         'personal',
    slotDuration:         60,
    appoinmentPerSlot:    1,
    appoinmentPerDay:     8,
    allowBookingAfter:    1,
    allowBookingAfterUnit: 'days',
    isActive:             true,
    teamMembers: [{
      userId,
      priority:            1,
      meetingLocationType: 'zoom',
      isPrimary:           true,
    }],
  });
  console.log(`[GHL] Calendar created: ${data.id}`);
  return data;
}

async function createProduct(contact) {
  console.log(`[GHL] Creating product for ${contact.firstName}…`);
  const { data } = await ghl.post('/products/', {
    locationId:   CFG.locationId,
    name:         `${contact.firstName} ${contact.lastName} — 1-on-1 Consulting`,
    description:  contact.bio || contact.headline || '',
    productType:  'SERVICE',
    variants: [{
      name: '1-Hour Session',
      prices: [{
        name:      '1-Hour Session',
        amount:    contact.hourlyRate * 100,   // GHL prices are in cents
        currency:  'USD',
        recurring: { interval: 'day', intervalCount: 0 },
        type:      'one_time',
      }],
    }],
    availableInStore: false,
  });
  console.log(`[GHL] Product created: ${data.id}`);
  return data;
}

async function ensureConsultantFunnel() {
  // If funnel ID is already saved in env, use it
  if (CFG.consultantFunnelId) return CFG.consultantFunnelId;

  console.log('[GHL] Looking for existing Consultants funnel…');
  const { data } = await ghl.get('/funnels/', {
    params: { locationId: CFG.locationId, limit: 100 },
  });
  const funnels = data.funnels || data.data || [];
  const existing = funnels.find(f =>
    f.name?.toLowerCase().includes('consultant')
  );
  if (existing) {
    console.log(`[GHL] Found funnel: ${existing.id}`);
    CFG.consultantFunnelId = existing.id;
    return existing.id;
  }

  console.log('[GHL] Creating Consultants funnel…');
  const { data: created } = await ghl.post('/funnels/', {
    locationId: CFG.locationId,
    name:       'Cult Consultants',
    domain:     'cultcontent.cc',
    urlPath:    '/consultants',
  });
  CFG.consultantFunnelId = created.id;
  console.log(`[GHL] Funnel created: ${created.id}`);
  return created.id;
}

async function createAndPublishPage(contact, html, funnelId) {
  const slug    = slugify(`${contact.firstName} ${contact.lastName}`);
  const pageUrl = `/consultants/${slug}`;
  console.log(`[GHL] Creating page at ${pageUrl}…`);

  const { data } = await ghl.post('/funnels/page', {
    locationId:  CFG.locationId,
    funnelId,
    name:        `${contact.firstName} ${contact.lastName} — Consultant`,
    url:         slug,
    title:       `${contact.firstName} ${contact.lastName} — Cult Content Consultant`,
    description: contact.headline || '',
    contentHTML: html,
    keywords:    'TikTok Shop, consultant, ' + contact.specialties,
  });
  console.log(`[GHL] Page created: ${data.id} — publishing…`);

  // Publish the page
  await ghl.put(`/funnels/page/${data.id}`, {
    locationId: CFG.locationId,
    status:     'published',
  });
  console.log('[GHL] Page published.');

  return {
    pageId:  data.id,
    pageUrl: `${CFG.baseUrl}${pageUrl}`,
  };
}

async function updateContactPageUrl(contactId, pageUrl) {
  await ghl.put(`/contacts/${contactId}`, {
    locationId:    CFG.locationId,
    customFields: [{
      key:   'consultant_page_url',
      value: pageUrl,
    }],
  });
}

async function sendWelcomeEmail(contact, bookingUrl, pageUrl) {
  console.log(`[GHL] Sending welcome email to ${contact.email}…`);
  await ghl.post('/conversations/messages/outbound', {
    type:       'Email',
    locationId: CFG.locationId,
    contactId:  contact.id,
    subject:    `You're live, ${contact.firstName} — here's your booking link`,
    html: `
<p>Hey ${contact.firstName},</p>

<p>Welcome to the Cult Content Consultant Network! Everything's been set up for you automatically.</p>

<h3>Your links:</h3>
<ul>
  <li><strong>Your booking page:</strong> <a href="${pageUrl}">${pageUrl}</a></li>
  <li><strong>Direct calendar link:</strong> <a href="${bookingUrl}">${bookingUrl}</a></li>
</ul>

<p>Your profile page is live now. Once you've got a case study or testimonial to add, just let us know and we'll update it.</p>

<p>Next steps:</p>
<ol>
  <li>Log into your GHL account (invite coming to ${contact.email}) and set your calendar availability</li>
  <li>Share your booking page link on your socials</li>
  <li>Join the Discord if you haven't already</li>
</ol>

<p>Welcome to the cult ;)</p>
<p>— Tommy</p>
    `,
  });
}

async function sendInternalNotification(contact, pageUrl, bookingUrl) {
  console.log('[GHL] Sending internal notification…');
  await ghl.post('/conversations/messages/outbound', {
    type:       'Email',
    locationId: CFG.locationId,
    toEmail:    CFG.tommyEmail,
    subject:    `New consultant onboarded: ${contact.firstName} ${contact.lastName}`,
    html: `
<p><strong>New consultant just onboarded via the form.</strong></p>
<table>
  <tr><td><strong>Name</strong></td><td>${contact.firstName} ${contact.lastName}</td></tr>
  <tr><td><strong>Email</strong></td><td>${contact.email}</td></tr>
  <tr><td><strong>Phone</strong></td><td>${contact.phone}</td></tr>
  <tr><td><strong>Title</strong></td><td>${contact.headline}</td></tr>
  <tr><td><strong>Specialties</strong></td><td>${contact.specialties}</td></tr>
  <tr><td><strong>Rate</strong></td><td>$${contact.hourlyRate}/hr</td></tr>
  <tr><td><strong>Profile page</strong></td><td><a href="${pageUrl}">${pageUrl}</a></td></tr>
  <tr><td><strong>Booking link</strong></td><td><a href="${bookingUrl}">${bookingUrl}</a></td></tr>
</table>
    `,
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

app.post('/consultant-onboard', async (req, res) => {
  console.log('\n[WEBHOOK] Received consultant onboarding submission');

  try {
    const contact = parseContact(req.body);
    if (!contact.email) {
      return res.status(400).json({ error: 'No email in payload' });
    }
    console.log(`[INFO] Processing: ${contact.firstName} ${contact.lastName} <${contact.email}>`);

    // 1. Create GHL user
    const user = await createUser(contact).catch(err => {
      // User may already exist — not fatal
      console.warn('[WARN] createUser failed (may already exist):', err.response?.data || err.message);
      return { id: null };
    });

    // 2. Create calendar
    const calendar = await createCalendar(contact, user.id);
    const bookingUrl = `https://app.profitibull.com/widget/bookings/${calendar.id}`;

    // 3. Create product
    const product = await createProduct(contact).catch(err => {
      console.warn('[WARN] createProduct failed:', err.response?.data || err.message);
      return { id: null };
    });

    // 4. Build profile page HTML
    const profileHtml = buildProfilePage(contact, bookingUrl);

    // 5. Ensure consultant funnel exists
    const funnelId = await ensureConsultantFunnel();

    // 6. Create + publish page
    const { pageUrl } = await createAndPublishPage(contact, profileHtml, funnelId);

    // 7. Save page URL back to GHL contact
    if (contact.id) {
      await updateContactPageUrl(contact.id, pageUrl).catch(err =>
        console.warn('[WARN] updateContactPageUrl failed:', err.message)
      );
    }

    // 8. Send emails
    await sendWelcomeEmail(contact, bookingUrl, pageUrl);
    await sendInternalNotification(contact, pageUrl, bookingUrl);

    console.log(`[SUCCESS] ${contact.firstName} ${contact.lastName} fully onboarded`);
    console.log(`  Booking URL: ${bookingUrl}`);
    console.log(`  Profile page: ${pageUrl}`);

    res.json({
      success:    true,
      consultant: `${contact.firstName} ${contact.lastName}`,
      bookingUrl,
      pageUrl,
      calendarId: calendar.id,
      productId:  product?.id || null,
      userId:     user?.id    || null,
    });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[ERROR] Onboarding failed:', detail);
    res.status(500).json({ error: 'Onboarding failed', detail });
  }
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'consultant-webhook' }));

app.listen(CFG.port, () => {
  console.log(`\nCult Content Consultant Webhook`);
  console.log(`Listening on port ${CFG.port}`);
  console.log(`POST http://localhost:${CFG.port}/consultant-onboard`);
  console.log(`Location: ${CFG.locationId}\n`);
});
