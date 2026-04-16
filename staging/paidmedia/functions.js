// ─── Paid Media Agent — functions.js ─────────────────────────────────────────
//
// STATE:  Add S.paidMedia = null to the S object in index.html
//         Add loadPaidMedia() to fetchAll() and renderAll() to renderPaidMedia()
//
// GLOBALS used: S, x, fmtNum, fmtMoney, fmtDate, el
// ─────────────────────────────────────────────────────────────────────────────

// ─── Local state ─────────────────────────────────────────────────────────────
const PM = {
  platform:   'tiktok',   // 'tiktok' | 'meta'
  range:      '7d',       // '7d' | '30d' | 'custom'
  sortField:  'spend',    // 'spend' | 'ctr' | 'impressions'
  sortDir:    'desc',
};

// ─── Date helpers ─────────────────────────────────────────────────────────────
function getPmDateRange(range) {
  const now   = new Date();
  const end   = now.toISOString().slice(0, 10);
  const start = new Date(now);
  if (range === '7d')  start.setDate(start.getDate() - 7);
  if (range === '30d') start.setDate(start.getDate() - 30);
  return { start_date: start.toISOString().slice(0, 10), end_date: end };
}

function daysLeftInMonth() {
  const now  = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return last.getDate() - now.getDate();
}

function daysElapsedInMonth() {
  return new Date().getDate();
}

// ─── Platform switcher ───────────────────────────────────────────────────────
function switchPlatform(platform) {
  PM.platform = platform;
  ['tiktok', 'meta'].forEach(p => {
    const btn = document.getElementById('pmBtn-' + p);
    if (btn) btn.classList.toggle('active', p === platform);
  });
  renderPaidMedia();
}

// ─── Date range selector ─────────────────────────────────────────────────────
function setPmRange(range) {
  PM.range = range;
  ['7d', '30d', 'custom'].forEach(r => {
    const btn = document.getElementById('pmRange-' + r);
    if (btn) btn.classList.toggle('active', r === range);
  });
  const customRow = document.getElementById('pmCustomRange');
  if (customRow) customRow.style.display = range === 'custom' ? 'block' : 'none';
  if (range !== 'custom') loadPaidMedia(true);
}

// ─── Load / fetch ─────────────────────────────────────────────────────────────
async function loadPaidMedia(force = false) {
  const btn = document.getElementById('pmRefreshBtn');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Loading…'; }

  try {
    const url = PM.platform === 'tiktok'
      ? '/api/paidmedia/tiktok/summary'
      : '/api/paidmedia/meta/summary';

    const res  = await fetch(url);
    const data = await res.json();
    S.paidMedia = data;
  } catch (e) {
    S.paidMedia = { connected: false, error: e.message };
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↺ Refresh'; }
    const ts = document.getElementById('pmLastUpdated');
    if (ts) ts.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    renderPaidMedia();
  }
}

// Report with custom date range
async function loadPmReport() {
  const from = document.getElementById('pmDateFrom')?.value;
  const to   = document.getElementById('pmDateTo')?.value;
  if (!from || !to) return;
  try {
    const res  = await fetch(`/api/paidmedia/tiktok/report?start_date=${from}&end_date=${to}`);
    const data = await res.json();
    S.paidMedia = data;
  } catch (e) {
    S.paidMedia = { connected: false, error: e.message };
  }
  renderPaidMedia();
}

// ─── Main render ─────────────────────────────────────────────────────────────
function renderPaidMedia() {
  const container = document.getElementById('pmContent');
  if (!container) return;

  const d = S.paidMedia;

  // Not yet loaded
  if (!d) {
    container.innerHTML = `<div style="color:var(--muted);font-style:italic;padding:40px 0;text-align:center;font-size:13px;">Loading Paid Media data…</div>`;
    loadPaidMedia();
    return;
  }

  // Not connected
  if (!d.connected) {
    container.innerHTML = renderConnectionCards();
    return;
  }

  const totals    = d.totals    || {};
  const campaigns = d.campaigns || [];
  const ads       = d.topAds   || [];
  const budget    = d.monthlyBudget || 0;
  const spent     = totals.spend   || 0;

  container.innerHTML = `
    ${renderKpiRow(totals)}
    ${renderPacingCard(spent, budget)}
    ${renderCampaignTableCard(campaigns)}
    ${renderTopCreativeCard(ads)}
    ${renderQuickActionsCard()}
  `;
}

// ─── Connection cards ─────────────────────────────────────────────────────────
function renderConnectionCards() {
  const platforms = [
    {
      icon:  '♪',
      name:  'TikTok Ads',
      vars:  ['TIKTOK_ADS_ACCESS_TOKEN', 'TIKTOK_ADS_ADVERTISER_ID'],
      docs:  'https://business-api.tiktok.com/portal/docs?id=1738373141733378',
    },
    {
      icon:  'f',
      name:  'Meta Ads',
      vars:  ['META_ADS_ACCESS_TOKEN', 'META_ADS_ACCOUNT_ID'],
      docs:  'https://developers.facebook.com/docs/marketing-api/get-started',
    },
  ];

  const cards = platforms.map(p => `
    <div class="connect-card">
      <div class="connect-icon">${p.icon}</div>
      <div class="connect-title">${p.name}</div>
      <div class="connect-desc" style="margin-bottom:14px;">
        Add these to your <code style="background:rgba(0,0,0,0.06);padding:1px 5px;border-radius:3px;">.env</code> file:
      </div>
      ${p.vars.map(v => `
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;background:rgba(0,0,0,0.04);
             border-radius:6px;padding:6px 10px;margin-bottom:6px;text-align:left;color:var(--soft);">
          ${v}=your_token_here
        </div>`).join('')}
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:16px;">
        <span class="badge b-draft">Not connected</span>
        <a href="${p.docs}" target="_blank"
           style="font-size:11px;color:var(--teal);text-decoration:none;">Get API key ↗</a>
      </div>
    </div>
  `).join('');

  return `
    <div class="mb16" style="color:var(--muted);font-size:13px;font-weight:700;padding:2px 0;">
      Connect a platform to start tracking paid media performance.
    </div>
    <div class="two-col mb24">${cards}</div>
  `;
}

// ─── KPI row (6 cards) ────────────────────────────────────────────────────────
function renderKpiRow(t) {
  const ctr  = t.ctr  != null ? t.ctr.toFixed(2)  + '%' : '—';
  const cpc  = t.cpc  != null ? fmtMoney(t.cpc)         : '—';
  const roas = t.roas != null ? t.roas.toFixed(2) + 'x'  : '—';
  const conv = t.conversions != null ? fmtNum(t.conversions) : '—';

  return `
    <div class="kpi-row mb24">
      <div class="kpi-card">
        <div class="kpi-label">Total Spend</div>
        <div class="kpi-value gold">${t.spend != null ? fmtMoney(t.spend) : '—'}</div>
        <div class="kpi-sub">${PM.range === '7d' ? 'Last 7 days' : 'Last 30 days'}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Impressions</div>
        <div class="kpi-value">${t.impressions != null ? fmtNum(t.impressions) : '—'}</div>
        <div class="kpi-sub">total reach</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Clicks</div>
        <div class="kpi-value">${t.clicks != null ? fmtNum(t.clicks) : '—'}</div>
        <div class="kpi-sub">link clicks</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">CTR</div>
        <div class="kpi-value green">${ctr}</div>
        <div class="kpi-sub">click-through rate</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">CPC</div>
        <div class="kpi-value gold">${cpc}</div>
        <div class="kpi-sub">cost per click</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">${t.roas != null ? 'ROAS' : 'Conversions'}</div>
        <div class="kpi-value green">${t.roas != null ? roas : conv}</div>
        <div class="kpi-sub">${t.roas != null ? 'return on ad spend' : 'total conversions'}</div>
      </div>
    </div>
  `;
}

// ─── Spend pacing card ────────────────────────────────────────────────────────
function renderPacingCard(spent, budget) {
  if (!budget) {
    return `
      <div class="card mb24">
        <div class="card-label">Spend Pacing</div>
        <div style="color:var(--muted);font-size:12px;font-style:italic;">
          No monthly budget set. Add <code style="background:rgba(0,0,0,0.06);padding:1px 5px;border-radius:3px;">budget</code>
          to campaign or set TIKTOK_MONTHLY_BUDGET in .env.
        </div>
      </div>
    `;
  }

  const pct         = Math.min((spent / budget) * 100, 100);
  const daysElapsed = daysElapsedInMonth();
  const daysLeft    = daysLeftInMonth();
  const daysTotal   = daysElapsed + daysLeft;
  const dailyBurn   = daysElapsed > 0 ? spent / daysElapsed : 0;
  const projected   = dailyBurn * daysTotal;
  const pacingPct   = budget > 0 ? (projected / budget) * 100 : 0;

  // Color logic: green = on track, gold = 10% over pace, red = 20% over
  let barColor = 'var(--green)';
  let statusLabel = 'On track';
  let statusClass = 'green';
  if (pacingPct > 120) { barColor = 'var(--red)';  statusLabel = 'Over pace'; statusClass = 'off'; }
  else if (pacingPct > 110) { barColor = 'var(--gold)'; statusLabel = 'Slightly over'; statusClass = 'idle'; }

  return `
    <div class="card mb24">
      <div class="card-label" style="display:flex;align-items:center;justify-content:space-between;">
        <span>Spend Pacing — This Month</span>
        <span class="status-row ${statusClass}" style="font-size:11px;">
          <span class="dot ${statusClass}"></span>${statusLabel}
        </span>
      </div>

      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;">
        <div>
          <span style="font-family:'Montserrat',sans-serif;font-weight:900;font-size:28px;color:var(--gold);">${fmtMoney(spent)}</span>
          <span style="font-size:12px;color:var(--muted);margin-left:6px;">of ${fmtMoney(budget)} budget</span>
        </div>
        <div style="text-align:right;font-size:12px;color:var(--muted);">
          <div>${daysLeft} day${daysLeft !== 1 ? 's' : ''} left</div>
          <div>${fmtMoney(dailyBurn)}/day burn</div>
        </div>
      </div>

      <!-- Progress bar -->
      <div style="background:rgba(0,0,0,0.07);border-radius:100px;height:10px;overflow:hidden;margin-bottom:12px;">
        <div style="width:${pct.toFixed(1)}%;height:100%;background:${barColor};border-radius:100px;
             transition:width 0.4s ease;"></div>
      </div>

      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);">
        <span>${pct.toFixed(1)}% spent</span>
        <span>Projected EOM: <strong style="color:${barColor};">${fmtMoney(projected)}</strong></span>
      </div>
    </div>
  `;
}

// ─── Campaign table ───────────────────────────────────────────────────────────
function renderCampaignTableCard(campaigns) {
  const sortedCampaigns = sortCampaignsBy(campaigns, PM.sortField, PM.sortDir);

  const thStyle = (field) => {
    const active = PM.sortField === field;
    return `style="cursor:pointer;${active ? 'color:var(--teal);' : ''}"
            onclick="pmSort('${field}')"`;
  };

  const rows = sortedCampaigns.length
    ? sortedCampaigns.map(c => renderCampaignRow(c)).join('')
    : `<tr class="empty"><td colspan="8">No campaigns found</td></tr>`;

  return `
    <div class="card mb24">
      <div class="card-label" style="display:flex;align-items:center;justify-content:space-between;">
        <span>Campaigns</span>
        <span class="muted" style="font-size:11px;">${sortedCampaigns.length} campaign${sortedCampaigns.length !== 1 ? 's' : ''}</span>
      </div>
      <div style="overflow-x:auto;">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:24px;"></th>
              <th>Campaign</th>
              <th>Budget/day</th>
              <th ${thStyle('spend')}>Spend ${PM.sortField === 'spend' ? (PM.sortDir === 'desc' ? '↓' : '↑') : ''}</th>
              <th ${thStyle('impressions')}>Impr. ${PM.sortField === 'impressions' ? (PM.sortDir === 'desc' ? '↓' : '↑') : ''}</th>
              <th ${thStyle('ctr')}>CTR ${PM.sortField === 'ctr' ? (PM.sortDir === 'desc' ? '↓' : '↑') : ''}</th>
              <th>CPC</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="pmCampaignTableBody">
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderCampaignRow(c) {
  const statusMap = {
    ENABLE:  { cls: 'on',   label: 'Active' },
    DISABLE: { cls: 'off',  label: 'Paused' },
    DELETE:  { cls: 'off',  label: 'Deleted' },
    ENDED:   { cls: 'off',  label: 'Ended' },
    // fallbacks
    active:  { cls: 'on',   label: 'Active' },
    paused:  { cls: 'off',  label: 'Paused' },
    ended:   { cls: 'off',  label: 'Ended' },
  };
  const st     = statusMap[c.status] || { cls: 'idle', label: c.status || '—' };
  const canAct = c.status === 'ENABLE' || c.status === 'DISABLE' || c.status === 'active' || c.status === 'paused';
  const nextStatus = (c.status === 'ENABLE' || c.status === 'active') ? 'DISABLE' : 'ENABLE';
  const actionLabel = nextStatus === 'DISABLE' ? 'Pause' : 'Resume';
  const budget = c.budget != null ? fmtMoney(c.budget) : '—';
  const spend  = c.spend  != null ? fmtMoney(c.spend)  : '—';
  const impr   = c.impressions != null ? fmtNum(c.impressions)    : '—';
  const ctr    = c.ctr   != null ? c.ctr.toFixed(2) + '%' : '—';
  const cpc    = c.cpc   != null ? fmtMoney(c.cpc)             : '—';

  return `
    <tr>
      <td><span class="dot ${st.cls}" title="${st.label}"></span></td>
      <td>
        <div style="font-weight:700;font-size:12px;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
             title="${x(c.name || '')}">${x(c.name || '—')}</div>
        <div class="mono muted" style="font-size:10px;">${x(c.id || '')}</div>
      </td>
      <td class="mono" style="font-size:12px;">${budget}</td>
      <td class="mono gold" style="font-size:12px;">${spend}</td>
      <td class="mono" style="font-size:12px;">${impr}</td>
      <td class="mono green" style="font-size:12px;">${ctr}</td>
      <td class="mono" style="font-size:12px;">${cpc}</td>
      <td>
        ${canAct ? `
          <button class="btn btn-ghost" style="height:26px;padding:0 10px;font-size:11px;"
                  onclick="toggleCampaignStatus('${x(c.id)}', '${c.status}')">
            ${actionLabel}
          </button>
        ` : '<span class="muted" style="font-size:11px;">—</span>'}
      </td>
    </tr>
  `;
}

// ─── Sort campaigns client-side ───────────────────────────────────────────────
function sortCampaignsBy(campaigns, field, dir) {
  return [...campaigns].sort((a, b) => {
    const av = a[field] ?? -1;
    const bv = b[field] ?? -1;
    return dir === 'desc' ? bv - av : av - bv;
  });
}

// Toggle sort column (called from table headers)
function pmSort(field) {
  if (PM.sortField === field) {
    PM.sortDir = PM.sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    PM.sortField = field;
    PM.sortDir   = 'desc';
  }
  // Re-render just the table body for performance
  if (S.paidMedia?.campaigns) {
    const sorted = sortCampaignsBy(S.paidMedia.campaigns, PM.sortField, PM.sortDir);
    const tbody = document.getElementById('pmCampaignTableBody');
    if (tbody) {
      tbody.innerHTML = sorted.length
        ? sorted.map(c => renderCampaignRow(c)).join('')
        : `<tr class="empty"><td colspan="8">No campaigns found</td></tr>`;
    }
    // Also update column header arrows
    renderPaidMedia();
  }
}

// ─── Toggle campaign status ───────────────────────────────────────────────────
async function toggleCampaignStatus(id, currentStatus) {
  const nextStatus = (currentStatus === 'ENABLE' || currentStatus === 'active') ? 'DISABLE' : 'ENABLE';
  try {
    const res  = await fetch(`/api/paidmedia/tiktok/campaign/${id}/status`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: nextStatus }),
    });
    const data = await res.json();
    if (data.ok) {
      // Optimistically update local state
      if (S.paidMedia?.campaigns) {
        const camp = S.paidMedia.campaigns.find(c => c.id === id);
        if (camp) camp.status = nextStatus;
      }
      renderPaidMedia();
    } else {
      alert('Failed to update campaign: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Network error: ' + e.message);
  }
}

// ─── Top Creative card ────────────────────────────────────────────────────────
function renderTopCreativeCard(ads) {
  if (!ads || ads.length === 0) {
    return `
      <div class="card mb24">
        <div class="card-label">Top Creative Performance</div>
        <div style="color:var(--muted);font-size:12px;font-style:italic;">No ad creative data available.</div>
      </div>
    `;
  }

  function ctrColor(ctr) {
    if (ctr >= 3)  return 'var(--green)';
    if (ctr >= 1)  return 'var(--gold)';
    return 'var(--red)';
  }

  const top5 = ads.slice(0, 5);
  const cards = top5.map(ad => `
    <div class="card" style="padding:14px;">
      <!-- Thumbnail placeholder -->
      <div style="width:100%;aspect-ratio:9/16;background:rgba(0,0,0,0.06);border-radius:8px;
           display:flex;align-items:center;justify-content:center;margin-bottom:12px;
           color:var(--muted);font-size:11px;text-align:center;padding:10px;overflow:hidden;">
        <span style="line-height:1.4;">${x((ad.name || '').slice(0, 60))}</span>
      </div>
      <!-- CTR badge -->
      <div style="margin-bottom:8px;">
        <span class="badge" style="background:${ctrColor(ad.ctr || 0)}22;
              color:${ctrColor(ad.ctr || 0)};font-size:10px;">
          CTR ${ad.ctr != null ? ad.ctr.toFixed(2) + '%' : '—'}
        </span>
      </div>
      <!-- Ad name -->
      <div style="font-size:11px;font-weight:700;color:var(--soft);margin-bottom:4px;
           white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${x(ad.name || '')}">
        ${x(ad.name || 'Unnamed Ad')}
      </div>
      <!-- Stats -->
      <div style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;">
        <span class="gold">${ad.spend != null ? fmtMoney(ad.spend) : '—'}</span>
        &nbsp;·&nbsp;
        ${ad.impressions != null ? fmtNum(ad.impressions) : '—'} impr.
      </div>
    </div>
  `).join('');

  return `
    <div class="card mb24">
      <div class="card-label">Top Creative Performance</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;">
        ${cards}
      </div>
    </div>
  `;
}

// ─── Quick Actions card ───────────────────────────────────────────────────────
function renderQuickActionsCard() {
  return `
    <div class="card mb24">
      <div class="card-label">Quick Actions</div>
      <div class="flex-wrap">
        <button class="btn btn-ghost" onclick="pmPauseAll()"
                style="border-color:rgba(255,59,48,0.3);color:var(--red);">
          ⏸ Pause All
        </button>
        <button class="btn btn-ghost" onclick="pmExportReport()">
          ↓ Export Report
        </button>
        <a href="https://ads.tiktok.com" target="_blank" class="btn btn-teal">
          ♪ New TikTok Campaign ↗
        </a>
        <a href="https://www.facebook.com/adsmanager" target="_blank" class="btn btn-ghost">
          f New Meta Campaign ↗
        </a>
      </div>
    </div>
  `;
}

// ─── Quick action stubs ───────────────────────────────────────────────────────
async function pmPauseAll() {
  if (!confirm('Pause ALL active campaigns? This cannot be undone from this dashboard.')) return;
  try {
    const res  = await fetch('/api/paidmedia/tiktok/pause-all', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      await loadPaidMedia(true);
    } else {
      alert('Pause All: ' + (data.message || data.error || 'Response received'));
    }
  } catch (e) {
    alert('Network error: ' + e.message);
  }
}

function pmExportReport() {
  // Stub — show "Coming soon" inline
  const btn = event.target;
  const orig = btn.textContent;
  btn.textContent = '✓ Coming soon';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
}
