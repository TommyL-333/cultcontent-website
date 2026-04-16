/**
 * Cult Content — Command Center Dashboard Server
 * Serves the dashboard UI and proxies API calls to GHL, Railway, and stubs.
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const crypto  = require('crypto');
const SNAP_FILE   = path.join(__dirname, 'snapshots.json');
const QUEUE_FILE  = path.join(__dirname, 'upload-queue.json');
const AGENTS_FILE = path.join(__dirname, 'agents.json');
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dashboard')));
app.use('/uploads', express.static(UPLOAD_DIR)); // serve staged videos by URL

const CFG = {
  ghlApiKey:  process.env.GHL_API_KEY  || 'pit-012c1650-1032-46f0-b293-72720e727a0b',
  locationId: process.env.GHL_LOC_ID   || 'c216j58Vx9XxYa7WYMiA',
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
  try {
    const data = await cached('conversations', 60_000, async () => {
      const { data } = await ghl.get('/conversations/search', {
        params: { locationId: CFG.locationId, limit: 10 },
      });
      return data;
    });
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

      // TikTok profiles via Apify
      if (SOCIAL_HANDLES.tiktok.length > 0) {
        try {
          const { data: runData } = await axios.post(
            `https://api.apify.com/v2/acts/clockworks~free-tiktok-scraper/run-sync-get-dataset-items?token=${token}&timeout=60&memory=256`,
            { profiles: SOCIAL_HANDLES.tiktok.map(h => h.handle), resultsType: 'profiles', maxProfilesPerQuery: 1 },
            { timeout: 90000 }
          );
          results.tiktok = (runData || []).map(item => {
            const h = item.authorMeta?.name;
            const config = SOCIAL_HANDLES.tiktok.find(s => s.handle === h);
            return {
              label: config?.label || item.authorMeta?.nickName,
              handle: h,
              followers: item.authorMeta?.fans || 0,
              likes: item.authorMeta?.heart || 0,
              videos: item.authorMeta?.video || 0,
              avatar: item.authorMeta?.avatar,
            };
          });
          results.tiktok.forEach(a => recordSnap('tiktok', a.handle, { followers: a.followers, likes: a.likes, videos: a.videos }));
        } catch (e) {
          const status = e.response?.status;
          console.error('TikTok Apify error:', e.response?.data || e.message);
          if (status === 402) results.apifyBillingRequired = true;
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
  fileFilter: (_, file, cb) => cb(null, /video|mp4|mov|avi|webm/i.test(file.mimetype + file.originalname)),
});

// POST /api/upload/video
app.post('/api/upload/video', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const localUrl = `/uploads/${req.file.filename}`;
  const meta = {
    id:          req.file.filename,
    originalName: req.file.originalname,
    filename:    req.file.filename,
    size:        req.file.size,
    title:       req.body.title        || path.basename(req.file.originalname, path.extname(req.file.originalname)),
    description: req.body.description  || '',
    platforms:   req.body.platforms    ? req.body.platforms.split(',').map(s => s.trim()) : [],
    status:      'staged',
    uploadedAt:  new Date().toISOString(),
    path:        req.file.path,
    localUrl,
  };
  const q = loadQueue();
  q.unshift(meta);
  saveQueue(q);
  res.json({ ok: true, video: meta });
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

// POST /api/buffer/post — post a video or text to Buffer from staging queue
app.post('/api/buffer/post', async (req, res) => {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.json({ ok: false, error: 'No Buffer token' });
  try {
    const { channelId, text, mediaUrl, scheduledAt } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    const orgId = process.env.BUFFER_ORG_ID || '69d6ddee1fcceb5bb1faa168';
    const input = {
      organizationId: orgId,
      channelIds: [channelId],
      content: {
        text: text || '',
        ...(mediaUrl ? { mediaUrls: [mediaUrl] } : {}),
      },
      ...(scheduledAt ? { scheduledAt } : { dueAt: null }),
    };
    const { data: gql } = await axios.post(
      'https://api.buffer.com/graphql',
      {
        query: `mutation CreatePost($input: CreatePostInput!) {
          createPost(input: $input) { post { id dueAt status channelService } }
        }`,
        variables: { input },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (gql.errors) return res.json({ ok: false, error: gql.errors[0]?.message });
    res.json({ ok: true, post: gql.data?.createPost?.post });
  } catch (e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
});

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


// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'dashboard' }));

app.listen(CFG.port, () => {
  console.log(`\n⚡ Cult Content Command Center`);
  console.log(`   http://localhost:${CFG.port}\n`);
});
