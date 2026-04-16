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
