---
name: tiktok-shop-content-pipeline
description: >
  Builds a complete TikTok Shop content pipeline dashboard from scratch for any brand.
  Handles the full workflow: Brief → Trend Analysis → Script Ideas → AI Script Writing →
  Video Upload → TikTok Shop publishing via Storista → multi-platform scheduling via Buffer.
  Use this skill whenever someone asks to set up a content pipeline, build a TikTok Shop
  dashboard, or wants to automate their video content workflow. Also triggers on "content
  command center", "video pipeline", "TikTok content system", or "build me a dashboard".
---

# TikTok Shop Content Pipeline — Installer

You are setting up a production-ready content pipeline dashboard. Follow these phases in order. Be conversational — this takes ~20 minutes of back-and-forth with the user, so keep momentum.

## What you're building

A self-hosted Express.js web app with:
- **5-step video pipeline**: Brief → Trend Analysis → AI Script Ideas → Script Writing + Voice Feedback → Upload
- **Calendar**: schedule posts with one-click publishing to TikTok Shop (Storista) or any social via Buffer
- **AI video generation** with Arcads
- **Performance analytics** from TikTok via Apify
- **Team access** secured by Cloudflare Access (Google OAuth, free)
- **Deployed to Railway** with persistent storage

---

## Phase 1 — Account Setup

Walk the user through signing up for each required service. **Open every affiliate link in the browser** — this is important, do not skip it. Use the Bash tool: `open "URL"` on Mac, or `start "URL"` on Windows.

Say something like: *"Let's get your accounts set up first. I'll open each signup page — grab your API key once you're in."*

### Required services (open these URLs)

Open each one, then wait for the user to confirm they have the key before moving on:

1. **Anthropic API** (script generation — required)
   ```bash
   open "https://console.anthropic.com"
   ```
   Key name in .env: `ANTHROPIC_API_KEY`

2. **Storista** — TikTok Shop video publishing (required)
   ```bash
   open "https://storista.io/?ref=tommy"
   ```
   - Sign up for Pro plan ($19/mo) to get API access
   - After signup: Settings → API → copy your token
   - Key name: `STORISTA_API_KEY`
   - **Important**: After getting the key, also connect your TikTok Shop **Seller** account AND **Creator** account from the Storista dashboard. Both are needed — Seller for product tagging, Creator for posting.

3. **Buffer** — Multi-platform social scheduling (required)
   ```bash
   open "https://join.buffer.com/tommy-lynch"
   ```
   - Connect all the social accounts you want to post to (TikTok, Instagram, YouTube, etc.)
   - Settings → API → create a personal access token
   - Key name: `BUFFER_ACCESS_TOKEN`

4. **Arcads** — AI video generation (optional but recommended)
   ```bash
   open "https://arcads.ai/?via=tommy-lynch"
   ```
   - Key name: `ARCADS_API_KEY`

5. **Apify** — TikTok trend data & analytics (optional)
   ```
   open "https://apify.com"
   ```
   - Key name: `APIFY_API_KEY`

6. **Railway** — Hosting (required for deployment)
   ```bash
   open "https://railway.app"
   ```
   - Free tier works. Just create an account — no key needed yet.

7. **OpenAI** — Voice transcription fallback (optional)
   ```bash
   open "https://platform.openai.com"
   ```
   - Key name: `OPENAI_API_KEY`

Collect all keys in a list before moving to Phase 2. Tell the user: *"You can always add missing keys later — the dashboard degrades gracefully without them."*

---

## Phase 2 — Brand Interview

Ask the user these questions. Keep it conversational — you can ask 2-3 at a time:

1. **Brand name** — What's the name of your brand or store?
2. **What you sell** — Describe your products, price range, and any bestsellers
3. **Target audience** — Who buys from you? Age, interests, lifestyle
4. **Brand voice** — How do you talk to your audience? (e.g. "professional and direct", "fun and casual", "educational and authoritative")
5. **Content pillars** — What 4-5 topics do you consistently make content about?
6. **TikTok handle** — Your @username on TikTok
7. **What to avoid** — Any topics, tones, or formats that are off-brand?
8. **CTA** — What do you want viewers to do? (e.g. "tap the cart below", "link in bio")

Store all answers — you'll embed them directly into the server code as the brand profile so Claude always has full context when generating scripts.

---

## Phase 3 — Scaffold the Project

Create the project directory and all files. Build everything from scratch based on the brand info collected.

### Directory structure
```
content-pipeline/
├── server.js
├── package.json
├── .env
├── .env.example
├── .gitignore
├── dashboard/
│   └── index.html
└── uploads/         (auto-created at runtime)
```

### package.json
```json
{
  "name": "content-pipeline",
  "version": "1.0.0",
  "description": "TikTok Shop Content Pipeline",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "axios": "^1.7.2",
    "dotenv": "^16.0.0",
    "express": "^4.19.2",
    "express-rate-limit": "^7.5.0",
    "helmet": "^8.0.0",
    "multer": "^1.4.5-lts.1"
  }
}
```

### .gitignore
```
node_modules/
.env
uploads/
*.log
.DS_Store
upload-queue.json
```

### Server (server.js)

Build a complete Express server with these capabilities. Inject the brand profile from Phase 2 directly into `BRAND_PROFILE` — this is what Claude uses for all script generation.

#### Core structure
```javascript
require('dotenv').config();
const express   = require('express');
const axios     = require('axios');
const path      = require('path');
const fs        = require('fs');
const multer    = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const DATA_DIR   = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const QUEUE_FILE = path.join(DATA_DIR, 'upload-queue.json');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1);

// HTTPS redirect in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https')
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  next();
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
```

#### Brand profile (populated from Phase 2 answers)
```javascript
const BRAND = {
  name:           "{{BRAND_NAME}}",
  products:       "{{PRODUCTS}}",
  audience:       "{{AUDIENCE}}",
  voice:          "{{VOICE}}",
  contentPillars: {{CONTENT_PILLARS_ARRAY}},
  tiktokHandle:   "{{TIKTOK_HANDLE}}",
  avoidTopics:    "{{AVOID_TOPICS}}",
  cta:            "{{CTA}}",
};
```

#### Auth middleware
```javascript
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || '').split(',').map(d => d.trim()).filter(Boolean);

function requireAuth(req, res, next) {
  if (!process.env.CF_ACCESS_AUD) return next();
  const email = req.headers['cf-access-authenticated-user-email'];
  if (!email) return res.status(401).sendFile(path.join(__dirname, 'dashboard', '401.html'));
  const domain = email.split('@')[1]?.toLowerCase();
  if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.includes(domain))
    return res.status(403).send('Access denied.');
  req.userEmail = email;
  next();
}

app.use(express.json());
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'dashboard')));
app.use('/uploads', express.static(UPLOAD_DIR));
```

#### API routes to implement

**Pipeline routes:**
- `POST /api/pipeline/analyze` — Apify TikTok trend scrape for the brand's niche; falls back to Claude-generated trend analysis if no Apify key
- `POST /api/pipeline/ideas` — Claude generates 8 video ideas based on trends + brand profile
- `POST /api/pipeline/scripts` — Claude writes full scripts (hook / intro / beats / CTA) for selected ideas
- `POST /api/pipeline/rewrite-scripts` — Claude rewrites scripts applying voice feedback
- `POST /api/whisper-transcribe` — OpenAI Whisper transcription for voice feedback (multer upload)

**Video upload:**
- `POST /api/upload/video` — multer upload, saves to UPLOAD_DIR, adds to queue JSON
- `GET /api/upload/queue` — return queue
- `DELETE /api/upload/queue/:id` — remove from queue + delete file
- `PATCH /api/upload/queue/:id` — update metadata/status

**Storista:**
- `GET /api/storista/accounts` — proxy to `https://api-v2.storista.io/v1/tiktok/accounts`
- `GET /api/storista/products/:account` — proxy to `/v1/tiktok/<account>/products`
- `POST /api/storista/upload` — pre-sign → S3 PUT → media create (full flow below)
- `POST /api/storista/publish` — create + publish video to TikTok Shop
- `GET /api/storista/status/:account/:videoId` — poll publish status

**Storista upload flow** (implement carefully):
```javascript
// 1. POST /v1/media/pre-sign  body: {filename, content_type, size}  (flat JSON, NOT nested)
// 2. PUT presign.upload_url with raw file binary
//    Headers: Content-Type: video/mp4, x-amz-content-sha256: UNSIGNED-PAYLOAD
// 3. POST /v1/media/  body: {data: {upload_id: presign.upload_id, name: filename}}
//    (note: THIS endpoint uses nested data wrapper unlike pre-sign)
// Returns: {media_id, presign.public_url}  — store public_url for Buffer reuse
```

**Buffer:**
- `GET /api/buffer/channels` — GraphQL query for channels list (cache 1hr)
- `POST /api/buffer/post-to-channels` — body: `{channelIds[], text, mediaUrl?, scheduledAt?}` — iterate and post to each

**Arcads:**
- `GET /api/arcads/actors` — list available AI actors
- `POST /api/arcads/generate` — generate video from script

**Health:**
- `GET /health` — returns `{status: "ok"}`

#### Script generation prompt (use this verbatim in all pipeline Claude calls)

```
You are a TikTok content strategist writing for ${BRAND.name}.

BRAND CONTEXT:
- Products: ${BRAND.products}
- Audience: ${BRAND.audience}
- Voice: ${BRAND.voice}
- Content pillars: ${BRAND.contentPillars.join(', ')}
- Avoid: ${BRAND.avoidTopics}
- CTA: ${BRAND.cta}

RULES:
- Never fabricate statistics, testimonials, or product claims not in the brief
- Every script must have a pattern-interrupt hook in the first 2 seconds
- Scripts should feel native to TikTok — direct, fast-paced, no corporate speak
- Always end with the CTA
```

---

### Dashboard (dashboard/index.html)

Build a clean, dark-theme single-page app. Use these CSS variables:
```css
:root {
  --bg: #0a0a0f; --card: #13131a; --border: #1e1e2e;
  --text: #e8e8f0; --muted: #6b6b8a; --teal: #00f2ea;
  --green: #00d27a; --gold: #c9a84c; --red: #ff5050;
}
```

#### Navigation tabs (top bar)
- 📹 **Pipeline** — the 5-step video production wizard
- 📅 **Calendar** — scheduled posts with Storista + Buffer publish buttons
- 🎭 **Arcads** — AI video generation
- 📊 **Performance** — TikTok analytics from Apify

#### Pipeline tab — 5 steps

The pipeline uses a stepper UI. Steps are clickable for free navigation (don't force sequential flow).

**Step 1 — Brief**
- Text inputs: campaign goal, key message, special offer/hook
- "Start Analysis →" button

**Step 2 — Trend Analysis**
- Calls `/api/pipeline/analyze`
- Shows top trending sounds, hashtags, competitor tactics from Apify
- If no Apify key: Claude generates trend insights based on niche
- "Generate Ideas →" button

**Step 3 — Video Ideas**
- Calls `/api/pipeline/ideas`
- Shows 8 idea cards (title + hook preview + format tag)
- User selects ideas to turn into full scripts (checkboxes)
- "Write Scripts →" button

**Step 4 — Scripts**
- Calls `/api/pipeline/scripts` for selected ideas
- Each script shows: Hook / Intro / Body beats / CTA in expandable cards
- **Voice feedback** — microphone button uses Web Speech API (SpeechRecognition)
  - Fallback: record audio → POST to `/api/whisper-transcribe` if no native speech support
  - Feedback text feeds into `/api/pipeline/rewrite-scripts` to revise all scripts
- "Continue to Production →" and "Skip to Calendar →" buttons for free navigation

**Step 5 — Upload**
- Drag-and-drop video upload area
- Each slot shows: filename, thumbnail, editable title
- Upload sends to `/api/upload/video`
- "+ Add Video" button for additional slots
- "Go to Calendar →" button

#### Calendar tab

Each entry shows:
- Video title (editable)
- Date picker
- **🛍 TikTok Shop** button → Storista publish modal
- **📱 Other Socials** button → Buffer channel picker modal

**Storista modal:**
- Account selector (from `/api/storista/accounts`)
- Product dropdown (from `/api/storista/products/:account`)
- Caption (pre-filled from script hook + CTA)
- Product link text field
- Upload & Publish button → uploads to S3, publishes, polls every 5s for READY status

**Buffer modal:**
- Channel grid — all connected channels as clickable cards with avatar/icon
- Multi-select (click to toggle, button updates to "Post to N Channels")
- Caption field (pre-filled)
- Optional schedule datetime
- Posts to all selected channels, shows per-channel result

Service icons for Buffer: `{tiktok:'🎵', instagram:'📸', youtube:'▶️', twitter:'𝕏', linkedin:'💼', facebook:'👤', threads:'🧵'}`

#### Arcads tab
- Actor grid with headshots
- Script input (pre-fill from pipeline if scripts exist)
- Generate button → polls for completion
- Download/preview generated video

#### Performance tab
- Apify TikTok scrape for the brand's handle
- Show: follower growth, top videos by views, average engagement rate, best posting times
- Refresh button with last-updated timestamp

---

## Phase 4 — Configure & Deploy

### .env file
Generate this with the user's actual keys:
```
ANTHROPIC_API_KEY=
PORT=3457
DATA_DIR=

CF_ACCESS_AUD=
ALLOWED_EMAIL_DOMAINS=

STORISTA_API_KEY=
BUFFER_ACCESS_TOKEN=
ARCADS_API_KEY=
APIFY_API_KEY=
OPENAI_API_KEY=
WEBHOOK_SECRET=
```

### Install dependencies
```bash
npm install
```

### Test locally
```bash
npm run dev
```
Open `http://localhost:3457` — confirm the dashboard loads and the brand name appears correctly.

### Deploy to Railway

1. Init git repo:
```bash
git init && git add . && git commit -m "Initial commit — content pipeline"
```

2. Create GitHub repo and push (use `gh` CLI if available):
```bash
gh repo create content-pipeline --private --push --source .
```

3. Deploy to Railway:
```bash
railway login
railway init
railway up
```

4. Set env vars in Railway (use Railway MCP or CLI):
```bash
railway variables set ANTHROPIC_API_KEY="..." STORISTA_API_KEY="..." BUFFER_ACCESS_TOKEN="..." ...
```

5. Add a Railway Volume at `/data` mount path, then set `DATA_DIR=/data` — this persists the upload queue across deploys.

6. Generate a custom domain or use the Railway-provided URL.

### Optional: Cloudflare Access auth (team access)

If the user wants to restrict access to specific email domains:

1. Move your domain to Cloudflare nameservers (free — just change nameservers at your registrar)
2. In Cloudflare Zero Trust → Access → Applications → Add app
3. Set the app domain to their Railway URL (via CNAME)
4. Add a Google OAuth policy allowing `*@theirdomain.com`
5. Copy the AUD tag → set `CF_ACCESS_AUD=<tag>` and `ALLOWED_EMAIL_DOMAINS=theirdomain.com` in Railway

---

## Finishing touches

After deploy:
1. Have the user connect their TikTok accounts in Storista (Seller + Creator)
2. Connect social channels in Buffer
3. Test the pipeline end-to-end with one real video
4. Walk them through the full workflow once: Brief → Scripts → Upload → Post to Shop

Tell the user: *"Your content pipeline is live. The core loop is: run the pipeline to generate scripts, film your videos, upload them in Step 5, then hit 🛍 TikTok Shop or 📱 Other Socials in the Calendar to publish."*
