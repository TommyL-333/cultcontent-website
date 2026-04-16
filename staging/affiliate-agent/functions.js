// ─────────────────────────────────────────────────────────────────────────────
// Affiliate Agent — functions.js
// Replaces the Reacher JS block in dashboard/index.html.
//
// RENAME NOTE: renderReacher() is kept as an alias of renderAffiliate() for
// backwards-compat with any callers that invoke it directly (e.g. the global
// refresh loop). Both names work — prefer renderAffiliate() going forward.
//
// Global helpers used from index.html (already defined there):
//   x(s)            — HTML-escape a string
//   fmtNum(n)       — locale number string
//   fmtMoney(n)     — "$1.2k" compact format
//   fmtDate(ts)     — relative time string
//   el(id)          — getElementById with silent fallback
//   S               — global state object
//   statCell(val,label) — mini stat box HTML string
// ─────────────────────────────────────────────────────────────────────────────

// ── Date-range state ────────────────────────────────────────────────────────
const RNG = { mode: '30d' };   // persisted across renders

function getAffiliateDates() {
  if (RNG.mode === 'custom') {
    return {
      start_date: document.getElementById('reacherDateStart')?.value || '',
      end_date:   document.getElementById('reacherDateEnd')?.value   || '',
    };
  }
  const days  = RNG.mode === '7d' ? 7 : RNG.mode === '30d' ? 30 : 90;
  const end   = new Date();
  const start = new Date(Date.now() - days * 86_400_000);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date:   end.toISOString().slice(0, 10),
  };
}

function setAffiliateRange(btn, mode) {
  RNG.mode = mode;
  document.querySelectorAll('[data-rng]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const customEl = document.getElementById('reacherCustomDates');
  if (customEl) customEl.style.display = mode === 'custom' ? 'flex' : 'none';
  const labels = { '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days', 'custom': 'custom range' };
  const labelEl = document.getElementById('reacherDateLabel');
  if (labelEl) labelEl.textContent = labels[mode] || '';
  if (mode !== 'custom') loadAffiliate(true);
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadAffiliate(force = false) {
  const statusEl = document.getElementById('reacherRefreshStatus');
  if (statusEl) statusEl.textContent = 'Fetching…';

  const { start_date, end_date } = getAffiliateDates();
  const params = new URLSearchParams();
  if (start_date) params.set('start_date', start_date);
  if (end_date)   params.set('end_date',   end_date);

  try {
    const data = await fetch(`/api/reacher/stats?${params}`).then(r => r.json());
    S.reacher = data;
    renderAffiliate();
    loadAffiliateTimeseries(start_date, end_date);
    if (statusEl) statusEl.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch(e) {
    if (statusEl) statusEl.textContent = 'Error: ' + e.message;
  }
}

async function loadAffiliateTimeseries(start_date, end_date) {
  const chartStatus = document.getElementById('reacherChartStatus');
  if (chartStatus) chartStatus.textContent = 'Loading chart…';
  try {
    const data = await fetch('/api/reacher/timeseries', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ start_date, end_date, granularity: 'day' }),
    }).then(r => r.json());
    S.reacherTimeseries = data;
    renderAffiliateChart();
    if (chartStatus) chartStatus.textContent = '';
  } catch(e) {
    if (chartStatus) chartStatus.textContent = 'Chart unavailable';
    S.reacherTimeseries = null;
  }
}

// ── Chart ─────────────────────────────────────────────────────────────────────
function renderAffiliateChart() {
  const ts  = S.reacherTimeseries;
  const ctx = document.getElementById('reacherChart')?.getContext('2d');
  if (!ctx) return;

  if (window._reacherChart) { window._reacherChart.destroy(); window._reacherChart = null; }

  const shopSel      = document.getElementById('reacherChartShop');
  const selectedShop = shopSel?.value || 'all';

  // Populate shop selector from live data (first time only)
  if (S.reacher?.shops && shopSel && shopSel.options.length <= 1) {
    S.reacher.shops.forEach(s => {
      if (!s.error) {
        const opt = document.createElement('option');
        opt.value       = String(s.shop_id);
        opt.textContent = s.shop_name;
        shopSel.appendChild(opt);
      }
    });
  }

  let rows = [];
  if (ts) {
    if (selectedShop === 'all') {
      rows = ts.timeline || [];
    } else {
      const shopData  = (ts.per_shop || []).find(s => String(s.shop_id) === selectedShop);
      const metricData = shopData?.data?.data || {};
      const byDate = {};
      ['gmv', 'video_views', 'videos_posted'].forEach(m => {
        (metricData[m] || []).forEach(pt => {
          if (!byDate[pt.date]) byDate[pt.date] = { date: pt.date, gmv: 0, video_views: 0, videos_posted: 0 };
          byDate[pt.date][m] = pt.value || 0;
        });
      });
      rows = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  if (!rows.length) { ctx.canvas.style.opacity = '0.3'; return; }
  ctx.canvas.style.opacity = '1';

  const labels   = rows.map(r => new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const gmvData  = rows.map(r => r.gmv          || 0);
  const viewData = rows.map(r => r.video_views  || 0);

  window._reacherChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'GMV ($)', data: gmvData,
          borderColor: '#00d27a', backgroundColor: 'rgba(0,210,122,0.07)',
          borderWidth: 2, fill: true, tension: 0.4, pointRadius: 2,
          yAxisID: 'yGmv',
        },
        {
          label: 'Video Views', data: viewData,
          borderColor: '#00f2ea', backgroundColor: 'rgba(0,242,234,0.05)',
          borderWidth: 2, fill: false, tension: 0.4, pointRadius: 2,
          yAxisID: 'yViews',
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => c.datasetIndex === 0
              ? ' GMV: $' + c.parsed.y.toLocaleString()
              : ' Views: ' + c.parsed.y.toLocaleString(),
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#7a7268', font: { size: 9 }, maxRotation: 30, maxTicksLimit: 10 },
          grid:  { color: 'rgba(20,18,16,0.05)' },
        },
        yGmv: {
          type: 'linear', position: 'left',
          ticks: { color: '#00d27a', font: { size: 9 }, callback: v => '$' + (v >= 1000 ? v / 1000 + 'k' : v) },
          grid:  { color: 'rgba(20,18,16,0.05)' },
        },
        yViews: {
          type: 'linear', position: 'right',
          ticks: { color: '#00f2ea', font: { size: 9 }, callback: v => v >= 1000 ? v / 1000 + 'k' : v },
          grid:  { display: false },
        },
      },
    },
  });
}

// ── Agency Insights bar ───────────────────────────────────────────────────────
function renderAffiliateInsights(shops, totals) {
  if (!shops || !shops.length) return;

  // Top performing shop by GMV
  const activeShops = shops.filter(s => !s.error);
  const topShop     = activeShops.reduce((best, s) => {
    return (s.metrics?.gmv || 0) > (best?.metrics?.gmv || 0) ? s : best;
  }, null);

  const topShopEl    = document.getElementById('insightTopShop');
  const topShopGmvEl = document.getElementById('insightTopShopGmv');
  if (topShop && topShopEl) {
    topShopEl.textContent    = topShop.shop_name || 'Unknown';
    if (topShopGmvEl) topShopGmvEl.textContent = fmtMoney(topShop.metrics?.gmv || 0) + ' GMV';
  }

  // Shops at risk: GMV < $500 OR funnel conversion < 10%
  const atRisk = activeShops.filter(s => {
    const gmv = s.metrics?.gmv || 0;
    const funnel = s.funnel || {};
    const requests = funnel['sample-requests'] || 0;
    const posted   = funnel['content-posted']  || 0;
    const conv     = requests > 0 ? (posted / requests) * 100 : 0;
    return gmv < 500 || conv < 10;
  });
  const atRiskEl = document.getElementById('insightAtRisk');
  if (atRiskEl) atRiskEl.textContent = atRisk.length + ' shop' + (atRisk.length !== 1 ? 's' : '');

  // Estimated commission payout (~15% of total GMV)
  const totalGmv      = totals?.total_gmv || 0;
  const commissionEl  = document.getElementById('insightCommission');
  if (commissionEl) commissionEl.textContent = fmtMoney(totalGmv * 0.15);

  // Automation coverage: % of shops with at least 1 active automation
  const shopsWithAuto = activeShops.filter(s => (s.active_automations || 0) > 0).length;
  const coveragePct   = activeShops.length > 0 ? Math.round((shopsWithAuto / activeShops.length) * 100) : 0;
  const coverageEl    = document.getElementById('insightAutoCoverage');
  if (coverageEl) coverageEl.textContent = coveragePct + '%';
}

// ── Main render ───────────────────────────────────────────────────────────────
function renderAffiliate() {
  const d        = S.reacher;
  const statusEl = document.getElementById('reacherRefreshStatus');

  if (!d || d.error) {
    const msg = d?.error || 'Could not load — Railway server may be offline';
    document.getElementById('reacherShopsGrid').innerHTML =
      `<div class="card" style="grid-column:1/-1;padding:20px;text-align:center;color:var(--red);font-size:13px;">⚠ ${x(msg)}</div>`;
    if (statusEl && d?.error) statusEl.textContent = 'Error';
    return;
  }

  const totals = d.totals || {};
  const shops  = d.shops  || [];

  // ── Agency KPIs ──
  el('reacherKpiGmv').textContent      = fmtMoney(totals.total_gmv           || 0);
  el('reacherKpiCreators').textContent = fmtNum(totals.total_creators         || 0);
  el('reacherKpiViews').textContent    = fmtNum(totals.total_video_views      || 0);
  el('reacherKpiVideos').textContent   = fmtNum(totals.total_videos           || 0);
  el('reacherKpiSamples').textContent  = fmtNum(totals.total_samples          || 0);
  el('reacherKpiAuto').textContent     = fmtNum(totals.active_automations     || 0);

  // ── Agency Insights bar ──
  renderAffiliateInsights(shops, totals);

  // ── Populate promo shop selector ──
  _populatePromoShopSelect(shops);

  // ── Agency funnel (aggregate) ──
  const funnelEl = document.getElementById('reacherFunnelViz');
  if (funnelEl) {
    const agencyFunnel = {};
    shops.forEach(s => {
      Object.entries(s.funnel || {}).forEach(([stage, count]) => {
        agencyFunnel[stage] = (agencyFunnel[stage] || 0) + (count || 0);
      });
    });
    const funnelStages = Object.entries(agencyFunnel);
    const maxVal = Math.max(...funnelStages.map(([, v]) => v), 1);
    const STAGE_LABELS = {
      'sample-requests':    'Sample Requests',
      'approved-samples':   'Approved Samples',
      'content-pending':    'Content Pending',
      'content-unfulfilled':'Unfulfilled',
      'content-posted':     'Content Posted',
      'generated-gmv':      'Generated GMV',
    };
    funnelEl.innerHTML = funnelStages.length
      ? funnelStages.map(([stage, count]) => {
          const pct   = Math.round((count / maxVal) * 100);
          const label = STAGE_LABELS[stage] || stage.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          const isGmv = stage === 'generated-gmv';
          return `<div>
            <div style="display:flex;justify-content:space-between;margin-bottom:3px;font-size:11px;">
              <span style="color:var(--soft);font-weight:700;">${label}</span>
              <span style="font-family:'JetBrains Mono',monospace;color:${isGmv ? 'var(--green)' : 'var(--teal)'};">${fmtNum(count)}</span>
            </div>
            <div style="height:6px;background:rgba(0,0,0,0.06);border-radius:4px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:${isGmv ? 'var(--green)' : 'var(--teal)'};border-radius:4px;transition:width 0.4s ease;"></div>
            </div>
          </div>`;
        }).join('')
      : '<div style="color:var(--muted);font-style:italic;font-size:12px;">No funnel data</div>';
  }

  // ── Per-shop cards ──
  const grid = document.getElementById('reacherShopsGrid');
  if (!shops.length) {
    grid.innerHTML = '<div class="card" style="grid-column:1/-1;padding:20px;text-align:center;color:var(--muted);font-style:italic;">No shops found.</div>';
    return;
  }

  grid.innerHTML = shops.map(s => _renderShopCard(s)).join('');

  if (statusEl) statusEl.textContent = 'Updated ' + new Date(d.generated_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Per-shop card renderer ────────────────────────────────────────────────────
function _renderShopCard(s) {
  if (s.error) {
    return `<div class="card agent-card" style="opacity:0.6">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div class="agent-icon" style="background:rgba(255,0,80,0.08);color:var(--pink)">🛍️</div>
        <div>
          <div class="agent-name">${x(s.shop_name || 'Shop ' + s.shop_id)}</div>
          <div style="font-size:11px;color:var(--red)">Error: ${x(s.error)}</div>
        </div>
      </div>
    </div>`;
  }

  const m          = s.metrics       || {};
  const gmv        = fmtMoney(m.gmv  || 0);
  const videoViews = fmtNum(m.video_views    || 0);
  const videos     = fmtNum(m.videos_posted  || 0);
  const samples    = fmtNum(m.sample_requests|| 0);
  const creators   = fmtNum(s.total_creators || 0);
  const activeAuto = s.active_automations || 0;
  const totalAuto  = s.total_automations  || 0;
  const isPro      = s.status === 'active' || s.status?.startsWith('pro');
  const statusColor = isPro ? 'var(--green)' : 'var(--muted)';
  const statusDot   = `<span class="dot" style="background:${statusColor};flex-shrink:0"></span>`;
  const autoLabel   = totalAuto > 0
    ? `<span style="color:${activeAuto > 0 ? 'var(--teal)' : 'var(--muted)'}">${activeAuto} running</span><span style="color:var(--muted)"> / ${totalAuto} total</span>`
    : '<span style="color:var(--muted)">No automations</span>';

  // Mini funnel bars
  const funnelHtml = (() => {
    const f      = s.funnel || {};
    const stages = Object.entries(f).filter(([, v]) => v > 0);
    if (!stages.length) return '';
    const maxF = Math.max(...stages.map(([, v]) => v), 1);
    const SLABELS = {
      'sample-requests':    'Requests',
      'approved-samples':   'Approved',
      'content-pending':    'Pending',
      'content-unfulfilled':'Unfulfilled',
      'content-posted':     'Posted',
      'generated-gmv':      'Has GMV',
    };
    return `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
      <div style="font-size:10px;font-weight:700;color:var(--muted);letter-spacing:0.06em;margin-bottom:6px;">CREATOR FUNNEL</div>
      ${stages.map(([stage, count]) => {
        const pct   = Math.round((count / maxF) * 100);
        const lbl   = SLABELS[stage] || stage.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
        const isGmv = stage === 'generated-gmv';
        return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <div style="width:72px;font-size:9px;color:var(--muted);text-align:right;flex-shrink:0;">${lbl}</div>
          <div style="flex:1;height:5px;background:rgba(0,0,0,0.06);border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${isGmv ? 'var(--green)' : 'var(--teal)'};border-radius:3px;"></div>
          </div>
          <div style="width:32px;font-size:9px;font-weight:700;font-family:'JetBrains Mono',monospace;color:${isGmv ? 'var(--green)' : 'var(--soft)'};">${count}</div>
        </div>`;
      }).join('')}
    </div>`;
  })();

  // Creator tier breakdown (derived from funnel data or stubbed)
  const funnel     = s.funnel || {};
  const topEarners = funnel['generated-gmv']   || 0;
  const newCreators= funnel['approved-samples'] || 0;
  const atRisk     = Math.max(0, (funnel['content-pending'] || 0) - (funnel['content-posted'] || 0));

  const shopId = String(s.shop_id);

  return `<div class="card agent-card" id="shopCard-${shopId}">
    <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;">
      <div class="agent-icon" style="background:rgba(0,242,234,0.08);color:var(--teal);font-size:18px">🛍️</div>
      <div style="flex:1;min-width:0;">
        <div class="agent-name" style="display:flex;align-items:center;gap:6px;">${statusDot}${x(s.shop_name)}</div>
        <div style="font-size:10px;color:${isPro ? 'var(--green)' : 'var(--muted)'};margin-top:2px;text-transform:capitalize;font-weight:700">${x(s.status || '')}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
        <div style="text-align:right;">
          <div style="font-size:20px;font-weight:900;color:var(--green)">${gmv}</div>
          <div style="font-size:9px;color:var(--muted);font-weight:700;letter-spacing:0.06em">GMV</div>
        </div>
        <button class="btn btn-ghost" style="font-size:10px;padding:3px 10px;height:auto;"
          onclick="toggleShopManage('${shopId}')">Manage ▾</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px;">
      ${statCell(videoViews, 'VIEWS')}
      ${statCell(videos,     'VIDEOS')}
      ${statCell(samples,    'SAMPLES')}
      ${statCell(creators,   'CREATORS')}
    </div>

    <div style="font-size:11px;display:flex;align-items:center;gap:6px;">
      <span style="color:var(--muted);font-weight:700;letter-spacing:0.04em;">AUTO:</span>${autoLabel}
    </div>

    ${funnelHtml}

    <!-- ── Manage panel (collapsed by default) ── -->
    <div id="shopManage-${shopId}" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--border);">

      <!-- Active promotions -->
      <div style="margin-bottom:12px;">
        <div style="font-size:10px;font-weight:700;color:var(--muted);letter-spacing:0.06em;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;">
          <span>ACTIVE PROMOTIONS</span>
          <button class="btn btn-ghost" style="font-size:10px;padding:2px 8px;height:auto;"
            onclick="openCreatePromoForShop('${shopId}','${x(s.shop_name)}')">+ New</button>
        </div>
        <div id="shopPromos-${shopId}" style="font-size:12px;color:var(--muted);font-style:italic;">
          Loading promotions…
        </div>
      </div>

      <!-- Creator tier breakdown -->
      <div style="margin-bottom:12px;">
        <div style="font-size:10px;font-weight:700;color:var(--muted);letter-spacing:0.06em;margin-bottom:6px;">CREATOR TIERS</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
          <div style="background:rgba(0,210,122,0.07);border-radius:7px;padding:8px;text-align:center;">
            <div style="font-size:16px;font-weight:900;color:var(--green);">${topEarners}</div>
            <div style="font-size:9px;color:var(--muted);font-weight:700;margin-top:2px;">TOP EARNERS</div>
          </div>
          <div style="background:rgba(0,242,234,0.06);border-radius:7px;padding:8px;text-align:center;">
            <div style="font-size:16px;font-weight:900;color:var(--teal);">${newCreators}</div>
            <div style="font-size:9px;color:var(--muted);font-weight:700;margin-top:2px;">NEW</div>
          </div>
          <div style="background:rgba(255,59,48,0.05);border-radius:7px;padding:8px;text-align:center;">
            <div style="font-size:16px;font-weight:900;color:var(--red);">${atRisk}</div>
            <div style="font-size:9px;color:var(--muted);font-weight:700;margin-top:2px;">AT RISK</div>
          </div>
        </div>
      </div>

      <!-- Quick outreach button -->
      <button class="btn btn-teal" style="font-size:11px;width:100%;"
        onclick="fireShopOutreach('${shopId}','${x(s.shop_name)}')">
        ⚡ Fire Outreach for ${x(s.shop_name)}
      </button>
      <div id="shopOutreachStatus-${shopId}" style="font-size:11px;color:var(--muted);margin-top:6px;text-align:center;"></div>

    </div>
  </div>`;
}

// ── Shop manage panel toggle ──────────────────────────────────────────────────
function toggleShopManage(shopId) {
  const panel = document.getElementById('shopManage-' + shopId);
  if (!panel) return;
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (isHidden) _loadShopPromos(shopId);
}

async function _loadShopPromos(shopId) {
  const el = document.getElementById('shopPromos-' + shopId);
  if (!el) return;
  try {
    const data = await fetch('/api/affiliate/promotions/' + shopId).then(r => r.json());
    const promos = data.promotions || [];
    if (!promos.length) {
      el.innerHTML = '<span style="color:var(--muted);font-style:italic;">No active promotions</span>';
    } else {
      el.innerHTML = promos.map(p => `
        <div class="gen-job">
          <span class="gen-status done">${x(p.type || 'promo')}</span>
          <span style="flex:1;color:var(--soft);">${x(p.label || p.promoId)}</span>
          <span style="color:var(--muted);font-size:10px;">${x(p.commission || '')}%</span>
        </div>`).join('');
    }
  } catch(e) {
    el.innerHTML = '<span style="color:var(--red);font-size:11px;">Could not load promotions</span>';
  }
}

// Prefill promo card from shop manage panel
function openCreatePromoForShop(shopId, shopName) {
  const sel = document.getElementById('promoShop');
  if (sel) {
    // Find or create option
    let opt = Array.from(sel.options).find(o => o.value === shopId);
    if (!opt) {
      opt = new Option(shopName, shopId);
      sel.appendChild(opt);
    }
    sel.value = shopId;
  }
  // Scroll to promo card
  document.querySelector('[onclick="createPromotion()"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Fire outreach for a specific shop ────────────────────────────────────────
async function fireShopOutreach(shopId, shopName) {
  const statusEl = document.getElementById('shopOutreachStatus-' + shopId);
  if (statusEl) statusEl.textContent = 'Sending…';
  try {
    const r = await fetch('/api/affiliate/blast', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        message:  `Hey [name], we have updates for ${shopName} — check in!`,
        audience: 'all_funnel',
        channel:  'reacher_dm',
        shopId,
      }),
    }).then(r => r.json());
    if (r.ok && statusEl) {
      statusEl.style.color = 'var(--green)';
      statusEl.textContent = `✓ Blast sent to ${r.sent || '?'} creators`;
      setTimeout(() => { if (statusEl) { statusEl.style.color = ''; statusEl.textContent = ''; } }, 4000);
    }
  } catch(e) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ Error: ' + e.message; }
  }
}

// ── Creator Blast ─────────────────────────────────────────────────────────────
async function fireCreatorBlast() {
  const message  = document.getElementById('blastMessage')?.value?.trim();
  const audience = document.getElementById('blastAudience')?.value;
  const channel  = document.getElementById('blastChannel')?.value;
  const btn      = document.getElementById('blastBtn');
  const statusEl = document.getElementById('blastStatus');
  const resultEl = document.getElementById('blastResult');
  const resultText = document.getElementById('blastResultText');

  if (!message) { if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Message required'; } return; }

  btn.disabled = true;
  btn.textContent = '⏳ Sending…';
  if (statusEl) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = 'Firing blast…'; }
  if (resultEl) resultEl.style.display = 'none';

  try {
    const r = await fetch('/api/affiliate/blast', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, audience, channel }),
    }).then(res => res.json());

    if (r.ok) {
      if (statusEl) { statusEl.style.color = 'var(--green)'; statusEl.textContent = '✓ Blast fired'; }
      if (resultText) resultText.innerHTML = `<span style="color:var(--green);font-weight:800;">✓ Blast sent to ${r.sent} creators</span> via <span style="color:var(--teal);">${channel.replace('_', ' ')}</span>`;
      if (resultEl)  { resultEl.style.display = 'block'; resultEl.style.background = 'rgba(0,210,122,0.07)'; resultEl.style.borderColor = 'rgba(0,210,122,0.2)'; }
      setTimeout(() => { if (statusEl) { statusEl.style.color = ''; statusEl.textContent = ''; } }, 4000);
    } else {
      if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ ' + (r.error || 'Failed'); }
    }
  } catch(e) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ Network error'; }
  }

  btn.disabled = false;
  btn.textContent = '🚀 Fire Blast';
}

// ── Create Promotion ──────────────────────────────────────────────────────────
async function createPromotion() {
  const shopId     = document.getElementById('promoShop')?.value;
  const commission = document.getElementById('promoCommission')?.value;
  const type       = document.getElementById('promoType')?.value;
  const duration   = document.getElementById('promoDuration')?.value;
  const btn        = document.getElementById('promoBtn');
  const statusEl   = document.getElementById('promoStatus');
  const resultEl   = document.getElementById('promoResult');
  const resultText = document.getElementById('promoResultText');

  if (!shopId)     { if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Select a shop'; } return; }
  if (!commission || commission < 5 || commission > 40) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Commission must be 5–40%'; }
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Creating…';
  if (statusEl) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = 'Creating…'; }
  if (resultEl) resultEl.style.display = 'none';

  try {
    const r = await fetch('/api/affiliate/promotion', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ shopId, commission: Number(commission), type, duration: Number(duration) }),
    }).then(res => res.json());

    if (r.ok) {
      if (statusEl) { statusEl.style.color = 'var(--green)'; statusEl.textContent = '✓ Created'; }
      if (resultText) resultText.innerHTML = `<span style="color:var(--green);font-weight:800;">✓ Promo created</span> <span class="mono">${x(r.promoId)}</span>`;
      if (resultEl)   { resultEl.style.display = 'block'; resultEl.style.background = 'rgba(0,210,122,0.07)'; resultEl.style.border = '1px solid rgba(0,210,122,0.2)'; }
      // Reload promos in manage panel if open
      const managePanel = document.getElementById('shopManage-' + shopId);
      if (managePanel?.style.display !== 'none') _loadShopPromos(shopId);
      setTimeout(() => { if (statusEl) { statusEl.style.color = ''; statusEl.textContent = ''; } }, 4000);
    } else {
      if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ ' + (r.error || 'Failed'); }
      if (resultEl)   { resultEl.style.display = 'block'; resultEl.style.background = 'rgba(255,59,48,0.05)'; resultEl.style.border = '1px solid rgba(255,59,48,0.15)'; }
      if (resultText) resultText.innerHTML = `<span style="color:var(--red);">✗ ${x(r.error || 'Unknown error')}</span>`;
    }
  } catch(e) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ Network error'; }
  }

  btn.disabled = false;
  btn.textContent = '💰 Create Promo';
}

// ── Populate the promo shop <select> from live data ───────────────────────────
function _populatePromoShopSelect(shops) {
  const sel = document.getElementById('promoShop');
  if (!sel) return;
  // Clear and rebuild (keep placeholder)
  while (sel.options.length > 1) sel.remove(1);
  (shops || []).forEach(s => {
    if (!s.error) {
      const opt = new Option(s.shop_name, String(s.shop_id));
      sel.appendChild(opt);
    }
  });
}

// ── Lark Command box ──────────────────────────────────────────────────────────
// (Kept identical to existing implementation — functions.js owns the full copy)
const _cmdLog = [];

async function sendCommand() {
  const text     = document.getElementById('commandText')?.value?.trim();
  const context  = document.getElementById('commandContext')?.value || '';
  const btn      = document.getElementById('commandSendBtn');
  const statusEl = document.getElementById('commandSendStatus');

  if (!text) return;

  btn.disabled = true;
  btn.textContent = '⏳';
  if (statusEl) statusEl.textContent = 'Sending…';

  try {
    const r = await fetch('/api/command', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text, context }),
    }).then(r => r.json());

    if (r.ok) {
      document.getElementById('commandText').value = '';
      if (statusEl) { statusEl.style.color = 'var(--green)'; statusEl.textContent = '✓ Sent to Lark'; }
      _cmdLog.unshift({ text, context, ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), ok: true });
      if (_cmdLog.length > 10) _cmdLog.pop();
      renderCommandLog();
      setTimeout(() => { if (statusEl) { statusEl.style.color = ''; statusEl.textContent = ''; } }, 3000);
    } else {
      if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ ' + (r.error || 'Failed'); }
    }
  } catch(e) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ Network error'; }
  }

  btn.disabled = false;
  btn.textContent = 'Fire →';
}

function renderCommandLog() {
  const logEl = document.getElementById('commandLog');
  if (!logEl || !_cmdLog.length) return;
  logEl.style.display = 'block';
  logEl.innerHTML =
    `<div style="font-size:10px;font-weight:700;color:var(--muted);letter-spacing:0.06em;margin-bottom:6px;padding-top:10px;border-top:1px solid var(--border);">RECENTLY SENT</div>` +
    _cmdLog.map(c => `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;">
        <span style="color:var(--green);flex-shrink:0;">✓</span>
        ${c.context ? `<span style="color:var(--gold);font-weight:700;flex-shrink:0;font-size:11px;">${x(c.context)}</span>` : ''}
        <span style="flex:1;color:var(--soft);">${x(c.text)}</span>
        <span style="color:var(--muted);font-size:10px;flex-shrink:0;">${c.ts}</span>
      </div>`).join('');
}

// ── Compatibility alias ───────────────────────────────────────────────────────
// The global refresh loop and any legacy callers that reference renderReacher()
// or loadReacher() will still work without modification.
const renderReacher = renderAffiliate;
const loadReacher   = loadAffiliate;
