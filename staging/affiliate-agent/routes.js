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
