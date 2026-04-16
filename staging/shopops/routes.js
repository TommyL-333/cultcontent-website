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
