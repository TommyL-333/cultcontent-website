// STATE: Add S.shopOps = null to S object in main fetchAll

// ─── Main render ──────────────────────────────────────────────────────────────

function renderShopOps() {
  const d = S.reacher;
  if (!d || d.error) {
    document.getElementById('shopopsHealthGrid').innerHTML =
      `<div class="card agent-card" style="grid-column:1/-1;text-align:center;padding:28px;color:var(--red);font-size:13px;">
        ⚠ ${x(d?.error || 'Could not load shop data — Railway server may be offline')}
      </div>`;
    return;
  }

  const totals = d.totals || {};
  const shops  = d.shops  || [];

  // ── KPI bar ──
  const totalGmv    = totals.total_gmv || 0;
  const totalShops  = shops.length;
  const activeShops = shops.filter(s => (s.status || '').toLowerCase() === 'active').length;

  // Avg creator conversion: sum(posted) / sum(requests) * 100
  let totalPosted   = 0;
  let totalRequests = 0;
  shops.forEach(s => {
    const f = s.funnel || {};
    totalPosted   += f['content-posted']    || 0;
    totalRequests += f['sample-requests']   || 0;
  });
  const avgConversion = totalRequests > 0 ? (totalPosted / totalRequests * 100) : 0;

  // Shops needing attention: GMV < 500 OR conversion < 10%
  const needsAttention = shops.filter(s => {
    const gmv  = (s.metrics || {}).gmv || 0;
    const f    = s.funnel || {};
    const req  = f['sample-requests'] || 0;
    const post = f['content-posted']  || 0;
    const conv = req > 0 ? (post / req * 100) : 0;
    return gmv < 500 || conv < 10;
  }).length;

  el('shopopsKpiGmv').textContent        = fmtMoney(totalGmv);
  el('shopopsKpiShops').textContent      = activeShops;
  el('shopopsKpiShopsSub').textContent   = `of ${totalShops} total`;
  el('shopopsKpiConversion').textContent = avgConversion.toFixed(1) + '%';
  el('shopopsKpiAlert').textContent      = needsAttention;
  el('shopopsShopCount').textContent     = `${totalShops} shop${totalShops !== 1 ? 's' : ''}`;

  // ── Last updated ──
  el('shopopsLastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();

  // ── Grids ──
  el('shopopsHealthGrid').innerHTML = renderShopHealthGrid(shops);

  // ── Promotions table ──
  renderPromotionsTable();

  // ── Ops pipeline ──
  renderOpsPipeline(shops);

  // ── Populate shop dropdown in promo form ──
  const sel = document.getElementById('promoShopId');
  if (sel) {
    sel.innerHTML = '<option value="">Select shop…</option>' +
      shops.map(s => `<option value="${x(String(s.shop_id))}">${x(s.shop_name || 'Shop ' + s.shop_id)}</option>`).join('');
  }
}

// ─── Load (fetches fresh data via existing Reacher endpoint) ──────────────────

async function loadShopOps() {
  el('shopopsLastUpdated').textContent = 'Refreshing…';
  try {
    const res  = await fetch('/api/reacher/stats');
    const data = await res.json();
    S.reacher  = data;
    renderShopOps();
  } catch (e) {
    el('shopopsLastUpdated').textContent = 'Error loading data';
    console.error('[ShopOps] loadShopOps error:', e);
  }
}

// ─── Health score computation ─────────────────────────────────────────────────
// Returns 0–100
// 40% weight: GMV relative to avg (capped at 2x avg = full score)
// 30% weight: creator conversion rate (posted/requests), full score at ≥30%
// 30% weight: automation coverage (active/total), full score at 100%

function computeShopHealth(shop, avgGmv) {
  const m    = shop.metrics || {};
  const f    = shop.funnel  || {};
  const gmv  = m.gmv || 0;

  // GMV component (40%)
  const gmvRatio    = avgGmv > 0 ? Math.min(gmv / (avgGmv * 2), 1) : 0;
  const gmvScore    = gmvRatio * 40;

  // Conversion component (30%)
  const requests    = f['sample-requests'] || 0;
  const posted      = f['content-posted']  || 0;
  const convRate    = requests > 0 ? (posted / requests) : 0;
  const convScore   = Math.min(convRate / 0.30, 1) * 30;

  // Automation coverage component (30%)
  const totalAuto   = shop.total_automations  || 0;
  const activeAuto  = shop.active_automations || 0;
  const autoRatio   = totalAuto > 0 ? Math.min(activeAuto / totalAuto, 1) : 0;
  const autoScore   = autoRatio * 30;

  return Math.round(gmvScore + convScore + autoScore);
}

// ─── Shop Health Grid HTML ────────────────────────────────────────────────────

function renderShopHealthGrid(shops) {
  if (!shops.length) {
    return `<div class="agent-card card" style="grid-column:1/-1;text-align:center;padding:28px;color:var(--muted);font-style:italic;">
      No shops found.
    </div>`;
  }

  const gmvValues = shops.map(s => (s.metrics || {}).gmv || 0);
  const avgGmv    = gmvValues.length ? gmvValues.reduce((a, b) => a + b, 0) / gmvValues.length : 0;
  const targetGmv = avgGmv * 1.2;

  return shops.map(s => {
    if (s.error) {
      return `<div class="card agent-card" style="opacity:0.6;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <div class="dot off"></div>
          <div class="agent-name">${x(s.shop_name || 'Shop ' + s.shop_id)}</div>
        </div>
        <div style="font-size:11px;color:var(--red);">Error: ${x(s.error)}</div>
      </div>`;
    }

    const m           = s.metrics  || {};
    const f           = s.funnel   || {};
    const shopId      = s.shop_id;
    const shopName    = s.shop_name || 'Shop ' + shopId;
    const gmv         = m.gmv || 0;
    const score       = computeShopHealth(s, avgGmv);
    const requests    = f['sample-requests']  || 0;
    const approved    = f['approved-samples'] || 0;
    const posted      = f['content-posted']   || 0;
    const funnelGmv   = f['generated-gmv']    || 0;
    const activeAuto  = s.active_automations  || 0;
    const totalAuto   = s.total_automations   || 0;

    // Health color
    const scoreColor  = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--gold)' : 'var(--red)';
    const dotClass    = score >= 70 ? 'on' : score >= 40 ? 'idle' : 'off';
    const scoreBadge  = score >= 70 ? 'b-active' : score >= 40 ? 'b-new' : 'b-lost';

    // GMV bar
    const gmvPct      = targetGmv > 0 ? Math.min(Math.round(gmv / targetGmv * 100), 100) : 0;
    const gmvBarColor = gmvPct >= 80 ? 'var(--green)' : gmvPct >= 40 ? 'var(--gold)' : 'var(--red)';

    // Funnel mini-bars (relative to requests as 100%)
    const funnelMax   = Math.max(requests, 1);
    const mkBar = (val, color) => {
      const pct = Math.min(Math.round(val / funnelMax * 100), 100);
      return `<div style="height:4px;background:rgba(0,0,0,0.07);border-radius:3px;flex:1;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width 0.4s;"></div>
      </div>`;
    };

    const statusText  = (s.status || 'unknown').toLowerCase();
    const convRate    = requests > 0 ? (posted / requests * 100).toFixed(1) : '0.0';

    return `<div class="card agent-card" id="shopops-card-${x(String(shopId))}">
      <!-- Name + status + score -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;">
          <span class="dot ${dotClass}"></span>
          <span class="agent-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${x(shopName)}">${x(shopName)}</span>
        </div>
        <span class="badge ${scoreBadge}" style="font-size:11px;flex-shrink:0;margin-left:8px;">
          ${score}/100
        </span>
      </div>

      <!-- Shop status label -->
      <div style="font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px;">
        ${x(statusText)} · Conv ${convRate}% · ${activeAuto}/${totalAuto} automations
      </div>

      <!-- GMV progress bar -->
      <div style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px;">
          <span style="color:var(--muted);font-weight:700;">GMV vs Target</span>
          <span class="mono" style="color:${gmvBarColor};">${fmtMoney(gmv)} <span style="color:var(--muted);">/ ${fmtMoney(targetGmv)}</span></span>
        </div>
        <div style="height:6px;background:rgba(0,0,0,0.07);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${gmvPct}%;background:${gmvBarColor};border-radius:4px;transition:width 0.4s;"></div>
        </div>
      </div>

      <!-- Creator funnel mini-bars -->
      <div style="margin-bottom:12px;">
        <div style="font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.09em;margin-bottom:6px;">Creator Funnel</div>
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:3px;">
          ${mkBar(requests, 'var(--teal)')}
          ${mkBar(approved, 'var(--gold)')}
          ${mkBar(posted,   'var(--green)')}
          ${mkBar(funnelGmv > 0 ? posted : 0, 'var(--green)')}
        </div>
        <div style="display:flex;gap:4px;font-size:9px;color:var(--muted);font-weight:700;">
          <span style="flex:1;text-align:center;">${funnelMax > 1 ? requests : '—'} Req</span>
          <span style="flex:1;text-align:center;">${approved} Appr</span>
          <span style="flex:1;text-align:center;">${posted} Post</span>
          <span style="flex:1;text-align:center;">${fmtMoney(funnelGmv)}</span>
        </div>
      </div>

      <!-- Action buttons -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
        <button class="btn btn-teal" style="height:30px;font-size:11px;padding:0 12px;"
          onclick="shopopsOutreach('${x(String(shopId))}', this)">⚡ Outreach</button>
        <button class="btn btn-ghost" style="height:30px;font-size:11px;padding:0 12px;"
          onclick="shopopsReport('${x(String(shopId))}')">📊 Report</button>
        <button class="btn btn-ghost" style="height:30px;font-size:11px;padding:0 12px;margin-left:auto;"
          onclick="toggleShopExpand('${x(String(shopId))}')" id="shopops-expand-btn-${x(String(shopId))}">
          ▾ Details
        </button>
      </div>

      <!-- Expand panel (hidden by default) -->
      <div id="shopops-expand-${x(String(shopId))}" style="display:none;border-top:1px solid var(--border);padding-top:12px;margin-top:4px;">
        <div class="agent-section-label" style="margin-bottom:10px;">Full Funnel Breakdown</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">
          ${[
            ['sample-requests',    'Sample Requests',  'var(--teal)'],
            ['approved-samples',   'Approved Samples', 'var(--gold)'],
            ['content-pending',    'Content Pending',  'var(--yellow)'],
            ['content-unfulfilled','Unfulfilled',      'var(--red)'],
            ['content-posted',     'Content Posted',   'var(--green)'],
            ['generated-gmv',      'Generated GMV',    'var(--green)'],
          ].map(([key, label, color]) => {
            const val     = key === 'generated-gmv' ? fmtMoney(f[key] || 0) : fmtNum(f[key] || 0);
            const rawVal  = f[key] || 0;
            const maxVal  = Math.max(f['sample-requests'] || 1, 1);
            const pct     = key === 'generated-gmv' ? 0 : Math.min(Math.round(rawVal / maxVal * 100), 100);
            return `<div>
              <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
                <span style="color:var(--soft);font-weight:700;">${label}</span>
                <span class="mono" style="color:${color};">${val}</span>
              </div>
              ${key !== 'generated-gmv' ? `
              <div style="height:4px;background:rgba(0,0,0,0.07);border-radius:3px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width 0.4s;"></div>
              </div>` : ''}
            </div>`;
          }).join('')}
        </div>
        <div style="background:rgba(0,0,0,0.03);border-radius:8px;padding:10px 12px;font-size:11px;color:var(--muted);font-style:italic;">
          📋 Promotion history — coming soon
        </div>
      </div>
    </div>`;
  }).join('');
}

// ─── Expand/collapse shop detail panel ───────────────────────────────────────

function toggleShopExpand(shopId) {
  const panel = document.getElementById('shopops-expand-' + shopId);
  const btn   = document.getElementById('shopops-expand-btn-' + shopId);
  if (!panel) return;
  const open  = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '▴ Details' : '▾ Details';
}

// ─── Promotion form ───────────────────────────────────────────────────────────

function openPromoForm() {
  const form = document.getElementById('shopopsPromoForm');
  const btn  = document.getElementById('shopopsPromoToggleBtn');
  if (!form) return;
  form.style.display = 'block';
  if (btn) btn.style.display = 'none';
  document.getElementById('promoFeedback').textContent = '';
}

function closePromoForm() {
  const form = document.getElementById('shopopsPromoForm');
  const btn  = document.getElementById('shopopsPromoToggleBtn');
  if (!form) return;
  form.style.display = 'none';
  if (btn) btn.style.display = '';
}

async function submitPromo() {
  const shopId     = document.getElementById('promoShopId').value;
  const type       = document.getElementById('promoType').value;
  const commission = parseInt(document.getElementById('promoCommission').value, 10);
  const duration   = document.getElementById('promoDuration').value;
  const tier       = document.getElementById('promoTier').value;
  const feedback   = document.getElementById('promoFeedback');
  const submitBtn  = document.getElementById('promoSubmitBtn');

  if (!shopId) {
    feedback.style.color = 'var(--red)';
    feedback.textContent = '⚠ Please select a shop.';
    return;
  }
  if (!commission || commission < 5 || commission > 40) {
    feedback.style.color = 'var(--red)';
    feedback.textContent = '⚠ Commission must be 5–40%.';
    return;
  }

  submitBtn.disabled   = true;
  feedback.style.color = 'var(--muted)';
  feedback.textContent = 'Launching…';

  try {
    const res  = await fetch('/api/shopops/promotion', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ shopId, type, commission, duration, tier }),
    });
    const data = await res.json();
    if (data.ok) {
      feedback.style.color = 'var(--green)';
      feedback.textContent = '✓ Promotion launched!';
      setTimeout(() => {
        closePromoForm();
        renderPromotionsTable();
      }, 1200);
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (e) {
    feedback.style.color = 'var(--red)';
    feedback.textContent = '⚠ ' + e.message;
  } finally {
    submitBtn.disabled = false;
  }
}

// ─── Promotions table ─────────────────────────────────────────────────────────

async function renderPromotionsTable() {
  const tbody = document.getElementById('shopopsPromoTbody');
  if (!tbody) return;

  try {
    const res  = await fetch('/api/shopops/promotions');
    const data = await res.json();
    const rows = (data.promotions || []);

    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty">
        <td colspan="6" style="text-align:center;padding:28px;color:var(--muted);font-style:italic;">
          No active promotions — launch one above to get started
        </td>
      </tr>`;
      return;
    }

    tbody.innerHTML = rows.map(p => `<tr>
      <td style="font-weight:700;">${x(p.shopName || p.shopId || '—')}</td>
      <td><span class="badge b-new">${x(p.type || '—')}</span></td>
      <td class="mono green">${p.commission || '—'}%</td>
      <td class="muted">${x(p.duration || '—')}</td>
      <td><span class="badge ${p.status === 'active' ? 'b-active' : 'b-draft'}">${x(p.status || 'draft')}</span></td>
      <td class="mono">${p.performance || '—'}</td>
    </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr class="empty"><td colspan="6" style="color:var(--red);text-align:center;padding:20px;">Error loading promotions</td></tr>`;
  }
}

// ─── Operations Pipeline (agency funnel bars) ─────────────────────────────────

function renderOpsPipeline(shops) {
  const funnelEl = document.getElementById('shopopsFunnelBars');
  if (!funnelEl) return;

  const STAGES = [
    { key: 'sample-requests',    label: 'Sample Requests',  color: 'var(--teal)'   },
    { key: 'approved-samples',   label: 'Approved Samples', color: 'var(--gold)'   },
    { key: 'content-pending',    label: 'Content Pending',  color: 'var(--yellow)' },
    { key: 'content-unfulfilled',label: 'Unfulfilled',      color: 'var(--red)'    },
    { key: 'content-posted',     label: 'Content Posted',   color: 'var(--green)'  },
    { key: 'generated-gmv',      label: 'Generated GMV',    color: 'var(--green)'  },
  ];

  // Aggregate all shops
  const agg = {};
  STAGES.forEach(s => { agg[s.key] = 0; });
  shops.forEach(shop => {
    const f = shop.funnel || {};
    STAGES.forEach(s => { agg[s.key] += (f[s.key] || 0); });
  });

  const nonGmvVals = STAGES.filter(s => s.key !== 'generated-gmv').map(s => agg[s.key]);
  const maxVal     = Math.max(...nonGmvVals, 1);

  // Stuck creators = content-pending + content-unfulfilled
  const stuckCount = (agg['content-pending'] || 0) + (agg['content-unfulfilled'] || 0);
  const stuckBadge = document.getElementById('shopopsStuckBadge');
  const stuckNum   = document.getElementById('shopopsStuckCount');
  const reengageBtn = document.getElementById('shopopsReengageBtn');

  if (stuckCount > 0) {
    if (stuckBadge) stuckBadge.style.display = '';
    if (stuckNum)   stuckNum.textContent = stuckCount;
    if (reengageBtn) reengageBtn.style.display = '';
  } else {
    if (stuckBadge)  stuckBadge.style.display  = 'none';
    if (reengageBtn) reengageBtn.style.display = 'none';
  }

  funnelEl.innerHTML = STAGES.map(({ key, label, color }) => {
    const val    = agg[key];
    const isGmv  = key === 'generated-gmv';
    const pct    = isGmv ? 0 : Math.min(Math.round(val / maxVal * 100), 100);
    const isStuck = key === 'content-pending' || key === 'content-unfulfilled';
    const display = isGmv ? fmtMoney(val) : fmtNum(val);

    return `<div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:11px;font-weight:700;color:var(--soft);min-width:130px;">${label}</span>
          ${isStuck && val > 0 ? `<span class="badge b-lost" style="font-size:9px;">needs action</span>` : ''}
        </div>
        <span class="mono" style="font-size:12px;color:${color};">${display}</span>
      </div>
      ${!isGmv ? `
      <div style="height:8px;background:rgba(0,0,0,0.07);border-radius:5px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:5px;transition:width 0.5s ease;opacity:${isStuck && val > 0 ? '1' : '0.85'};"></div>
      </div>` : ''}
    </div>`;
  }).join('');
}

// ─── Outreach action ──────────────────────────────────────────────────────────

async function shopopsOutreach(shopId, btnEl) {
  if (!shopId) return;
  const orig = btnEl.textContent;
  btnEl.disabled    = true;
  btnEl.textContent = '…';
  try {
    const res  = await fetch(`/api/shopops/outreach/${encodeURIComponent(shopId)}`, { method: 'POST' });
    const data = await res.json();
    btnEl.textContent = data.ok ? `✓ ${data.queued || 0} queued` : '⚠ Error';
    btnEl.style.background = data.ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => {
      btnEl.disabled        = false;
      btnEl.textContent     = orig;
      btnEl.style.background = '';
    }, 2500);
  } catch (e) {
    btnEl.textContent = '⚠ Failed';
    setTimeout(() => { btnEl.disabled = false; btnEl.textContent = orig; btnEl.style.background = ''; }, 2500);
  }
}

// ─── Report stub ──────────────────────────────────────────────────────────────

function shopopsReport(shopId) {
  // STUB — future: open a modal or navigate to a report view
  alert(`Report for shop ${shopId} — coming soon.`);
}

// ─── Re-engage stuck creators ─────────────────────────────────────────────────

async function shopopsReengage() {
  const btn      = document.getElementById('shopopsReengageBtn');
  const feedback = document.getElementById('shopopsReengageFeedback');
  if (!btn) return;
  btn.disabled    = true;
  if (feedback) { feedback.style.color = 'var(--muted)'; feedback.textContent = 'Sending re-engagement…'; }
  try {
    const res  = await fetch('/api/shopops/reengage', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      if (feedback) { feedback.style.color = 'var(--green)'; feedback.textContent = `✓ Re-engaged ${data.count || 0} creators.`; }
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (e) {
    if (feedback) { feedback.style.color = 'var(--red)'; feedback.textContent = '⚠ ' + e.message; }
  } finally {
    btn.disabled = false;
    setTimeout(() => { if (feedback) feedback.textContent = ''; }, 4000);
  }
}
