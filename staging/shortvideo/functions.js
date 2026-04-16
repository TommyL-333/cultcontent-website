// ─── Short Video Agent — functions.js ────────────────────────────────────────
// Call svInitActors() and renderShortVideo() on tab init.
//
// IMPORTANT: This file MUST be loaded after the main dashboard JS.
// It reuses all existing globals: _arcadsActors, _arcadsJobs, _arcadsFolders,
// _bufferChannels, queueFromArcads(), loadBufferChannels(), x(), fmtDate(), el()
// ─────────────────────────────────────────────────────────────────────────────

// ── New globals for Short Video Agent ────────────────────────────────────────
let _svActors     = [];          // separate copy fetched for this tab's grid
let _svSelectedId = null;        // currently selected actor ID in SV tab
let _svHooks      = JSON.parse(localStorage.getItem('svHooks') || '[]');
let _svScripts    = [];          // cached from /api/arcads/stats for performance table

// ─── SECTION 1: Stats ────────────────────────────────────────────────────────

async function svLoadStats() {
  try {
    const stats = await fetch('/api/arcads/stats').then(r => r.json());
    if (!stats.connected) return;
    const done    = document.getElementById('svStatDone');
    const pending = document.getElementById('svStatPending');
    const scripts = document.getElementById('svStatScripts');
    if (done)    done.textContent    = stats.totals.done;
    if (pending) pending.textContent = stats.totals.pending;
    if (scripts) scripts.textContent = stats.totals.scripts;
    // cache for script table
    _svScripts = stats.scripts || [];
    svRenderScriptTable(_svScripts);
  } catch(e) { console.error('svLoadStats:', e); }
}

// ─── SECTION 2: Actor Browser ────────────────────────────────────────────────

async function svInitActors() {
  try {
    const [actorsRes, scriptsRes] = await Promise.all([
      fetch('/api/arcads/actors').then(r => r.json()),
      fetch('/api/arcads/scripts').then(r => r.json()),
    ]);

    if (!actorsRes.connected) {
      const grid = document.getElementById('svActorGrid');
      if (grid) grid.innerHTML = '<div style="font-size:12px;color:var(--muted);font-style:italic;grid-column:1/-1;padding:12px 0">Arcads not connected.</div>';
      return;
    }

    _svActors = actorsRes.items || [];

    // Populate folder select
    const sel = document.getElementById('svFolderSel');
    const folders = scriptsRes.folders || [];
    if (sel && folders.length) {
      sel.innerHTML = folders.map(f => `<option value="${f.id}">${x(f.name)}</option>`).join('');
    } else if (sel) {
      sel.innerHTML = '<option value="">No folders found</option>';
    }

    svRenderActorGrid('');
  } catch(e) {
    console.error('svInitActors:', e);
    const grid = document.getElementById('svActorGrid');
    if (grid) grid.innerHTML = '<div style="font-size:12px;color:var(--red);grid-column:1/-1;padding:8px 0">Failed to load actors.</div>';
  }
}

// Filter button click handler — clears active state, re-renders
function svFilterActors(btn, gender) {
  document.querySelectorAll('#svActorFilters .actor-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  svRenderActorGrid(gender);
}

function svRenderActorGrid(genderFilter) {
  const grid = document.getElementById('svActorGrid');
  if (!grid) return;
  const actors = _svActors
    .filter(a => !genderFilter || a.actor?.gender === genderFilter)
    .filter(a => a.talkingActorEnabled !== false)
    .slice(0, 24);

  if (!actors.length) {
    grid.innerHTML = '<div style="font-size:12px;color:var(--muted);font-style:italic;grid-column:1/-1;padding:8px 0">No actors found.</div>';
    return;
  }

  grid.innerHTML = actors.map(a => {
    const sel     = _svSelectedId === a.id;
    const emotion = (a.emotions || [])[0] || '';
    const tag     = (a.tags || [])[0] || '';
    return `<div class="actor-card ${sel ? 'selected' : ''}" onclick="svSelectActor('${a.id}','${x(a.actor?.name || 'Actor')}')">
      <div class="actor-card-name">${x(a.actor?.name || 'Actor')} <span style="font-size:10px;color:var(--muted)">${a.actor?.gender || ''}</span></div>
      <div class="actor-card-tags">${emotion}${tag ? ' · ' + tag : ''}</div>
    </div>`;
  }).join('');
}

function svSelectActor(id, name) {
  _svSelectedId = id;
  const label = document.getElementById('svActorSelLabel');
  const btn   = document.getElementById('svGenerateBtn');
  if (label) label.textContent = '✓ Selected: ' + name;
  if (btn)   btn.disabled = false;
  svRenderActorGrid(
    document.querySelector('#svActorFilters .actor-filter.active')?.dataset.gender || ''
  );
}

// ─── SECTION 2: Script Editor + Generate ─────────────────────────────────────

function svShowGenerateMsg(msg, color) {
  const el = document.getElementById('svGenerateResult');
  if (!el) return;
  el.style.display = 'block';
  el.style.color   = color || 'var(--teal)';
  el.textContent   = msg;
}

async function svGenerate() {
  const name     = document.getElementById('svScriptName')?.value.trim();
  const text     = document.getElementById('svScriptText')?.value.trim();
  const folderId = document.getElementById('svFolderSel')?.value;
  const btn      = document.getElementById('svGenerateBtn');

  if (!name || !text)   { svShowGenerateMsg('Script name and text are required.', 'var(--red)'); return; }
  if (!_svSelectedId)   { svShowGenerateMsg('Select an actor first.', 'var(--red)'); return; }

  btn.disabled     = true;
  btn.textContent  = '⏳ Creating script…';
  const resEl = document.getElementById('svGenerateResult');
  if (resEl) resEl.style.display = 'none';

  try {
    // Step 1: create script
    const createRes = await fetch('/api/arcads/scripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text, situationIds: [_svSelectedId], folderId }),
    }).then(r => r.json());

    if (!createRes.ok) {
      svShowGenerateMsg('✗ ' + (createRes.error?.message || JSON.stringify(createRes.error)), 'var(--red)');
      btn.disabled = false; btn.textContent = '🎬 Generate Video';
      return;
    }

    const scriptId = createRes.script?.id;
    btn.textContent = '⏳ Triggering generation…';

    // Step 2: trigger generation
    await fetch(`/api/arcads/scripts/${scriptId}/generate`, { method: 'POST' }).then(r => r.json());

    // Step 3: add to the SHARED _arcadsJobs so pollArcadsJob works
    const job = {
      scriptId,
      name,
      actorId: _svSelectedId,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    _arcadsJobs.unshift(job);
    if (_arcadsJobs.length > 20) _arcadsJobs.splice(20);
    localStorage.setItem('arcadsJobs', JSON.stringify(_arcadsJobs));

    svShowGenerateMsg('✓ Generation started! Polling for completion…', 'var(--green)');

    // Clear form
    const nameEl = document.getElementById('svScriptName');
    const textEl = document.getElementById('svScriptText');
    if (nameEl) nameEl.value = '';
    if (textEl) textEl.value = '';

    svRenderJobs();

    // Reuse existing poll function — it updates _arcadsJobs and calls renderArcadsJobs()
    // We also hook renderArcadsJobs to trigger svRenderJobs via the shared data
    pollArcadsJob(scriptId);

  } catch(e) {
    svShowGenerateMsg('✗ ' + e.message, 'var(--red)');
  }

  btn.disabled    = false;
  btn.textContent = '🎬 Generate Video';
}

// ─── SECTION 3: Hook Library ──────────────────────────────────────────────────

function svToggleSaveHookForm() {
  const form = document.getElementById('svSaveHookForm');
  if (!form) return;
  const isHidden = form.style.display === 'none';
  form.style.display = isHidden ? 'block' : 'none';

  // Pre-fill from script editor when opening
  if (isHidden) {
    const name = document.getElementById('svScriptName')?.value.trim();
    const nameEl = document.getElementById('svHookName');
    if (nameEl && name) nameEl.value = name;
    const note = document.getElementById('svHookNote');
    if (note) note.value = '';
    const msgEl = document.getElementById('svSaveHookMsg');
    if (msgEl) msgEl.style.display = 'none';
  }
}

function svSaveHook() {
  const name = document.getElementById('svHookName')?.value.trim();
  const tag  = document.getElementById('svHookTag')?.value || 'Hook';
  const note = document.getElementById('svHookNote')?.value.trim() || '';
  const text = document.getElementById('svScriptText')?.value.trim() || '';
  const msg  = document.getElementById('svSaveHookMsg');

  if (!name) {
    if (msg) { msg.style.display = 'inline'; msg.style.color = 'var(--red)'; msg.textContent = 'Hook name is required.'; }
    return;
  }
  if (!text) {
    if (msg) { msg.style.display = 'inline'; msg.style.color = 'var(--red)'; msg.textContent = 'Script text is empty — write a script first.'; }
    return;
  }

  const hook = {
    id:        'h_' + Date.now(),
    name,
    tag,
    text,
    note,
    createdAt: new Date().toISOString(),
  };

  _svHooks.unshift(hook);
  localStorage.setItem('svHooks', JSON.stringify(_svHooks));

  if (msg) { msg.style.display = 'inline'; msg.style.color = 'var(--green)'; msg.textContent = '✓ Saved!'; }

  svRenderHookLibrary();
  svPopulateHookSelect();

  // Close form after a beat
  setTimeout(() => svToggleSaveHookForm(), 1200);
}

function svLoadHook(id) {
  const hook = _svHooks.find(h => h.id === id);
  if (!hook) return;
  const nameEl = document.getElementById('svScriptName');
  const textEl = document.getElementById('svScriptText');
  if (nameEl) nameEl.value = hook.name;
  if (textEl) textEl.value = hook.text;
  // Reset hook select back to placeholder
  const sel = document.getElementById('svHookSelect');
  if (sel) sel.value = '';
}

function svDeleteHook(id) {
  _svHooks = _svHooks.filter(h => h.id !== id);
  localStorage.setItem('svHooks', JSON.stringify(_svHooks));
  svRenderHookLibrary();
  svPopulateHookSelect();
}

// Quick-load from the dropdown in the script editor
function svQuickLoadHook(id) {
  if (!id) return;
  svLoadHook(id);
}

function svPopulateHookSelect() {
  const sel = document.getElementById('svHookSelect');
  if (!sel) return;
  if (!_svHooks.length) {
    sel.innerHTML = '<option value="">💡 Load from Hook Library…</option>';
    return;
  }
  sel.innerHTML =
    '<option value="">💡 Load from Hook Library…</option>' +
    _svHooks.map(h => `<option value="${h.id}">[${h.tag}] ${x(h.name)}</option>`).join('');
}

const SV_TAG_COLOR = {
  Hook:        'rgba(0,242,234,0.12)',
  CTA:         'rgba(255,0,80,0.10)',
  Story:       'rgba(201,168,76,0.12)',
  Educational: 'rgba(0,210,122,0.10)',
  Promo:       'rgba(0,0,0,0.06)',
};
const SV_TAG_TEXT = {
  Hook:        'var(--teal)',
  CTA:         'var(--pink)',
  Story:       'var(--gold)',
  Educational: 'var(--green)',
  Promo:       'var(--muted)',
};

function svRenderHookLibrary() {
  const grid = document.getElementById('svHookGrid');
  if (!grid) return;

  if (!_svHooks.length) {
    grid.innerHTML = '<div style="font-size:12px;color:var(--muted);font-style:italic;grid-column:1/-1;padding:12px 0;text-align:center;">No saved hooks yet. Generate a video and save the script.</div>';
    return;
  }

  grid.innerHTML = _svHooks.map(h => {
    const preview = h.text.length > 60 ? h.text.slice(0, 60) + '…' : h.text;
    const bg   = SV_TAG_COLOR[h.tag] || 'rgba(0,0,0,0.06)';
    const clr  = SV_TAG_TEXT[h.tag]  || 'var(--muted)';
    const date = new Date(h.createdAt).toLocaleDateString();
    return `<div style="border:1px solid var(--border);border-radius:10px;padding:14px;background:rgba(255,255,255,0.6);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <span style="font-weight:700;font-size:13px;">${x(h.name)}</span>
        <span style="font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;background:${bg};color:${clr};text-transform:uppercase;letter-spacing:0.05em;">${h.tag}</span>
      </div>
      <div style="font-size:11px;color:var(--soft);line-height:1.5;margin-bottom:8px;">${x(preview)}</div>
      ${h.note ? `<div style="font-size:10px;color:var(--muted);font-style:italic;margin-bottom:8px;">${x(h.note)}</div>` : ''}
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;">${date}</span>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-teal" style="font-size:10px;padding:3px 9px;" onclick="svLoadHook('${h.id}')">Load</button>
          <button class="btn btn-ghost" style="font-size:10px;padding:3px 8px;color:var(--red);" onclick="svDeleteHook('${h.id}')">✕</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ─── SECTION 4: Active Jobs ───────────────────────────────────────────────────

function svRenderJobs() {
  const el = document.getElementById('svJobsList');
  if (!el) return;

  if (!_arcadsJobs.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--muted);font-style:italic;">No active jobs this session.</div>';
    return;
  }

  el.innerHTML = _arcadsJobs.slice(0, 10).map(j => `
    <div class="gen-job">
      <span class="gen-status ${j.status}">${j.status}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${x(j.name)}</div>
        <div style="font-size:10px;color:var(--muted);">${new Date(j.createdAt).toLocaleString()}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        ${j.downloadUrl
          ? `<a href="${j.downloadUrl}" target="_blank" class="btn btn-ghost" style="font-size:11px;padding:4px 8px;">⬇ Download</a>`
          : ''}
        ${j.downloadUrl
          ? `<button class="btn btn-teal" style="font-size:11px;padding:4px 8px;" onclick="queueFromArcads('${j.scriptId}','${x(j.name)}','${j.downloadUrl}')">+ Queue</button>`
          : ''}
      </div>
    </div>`).join('');
}

function svClearDoneJobs() {
  // Remove completed jobs from the shared _arcadsJobs array
  const before = _arcadsJobs.length;
  // Reassign — _arcadsJobs is a let in the parent scope; we splice in place to preserve reference
  const remaining = _arcadsJobs.filter(j => j.status !== 'done');
  _arcadsJobs.splice(0, _arcadsJobs.length, ...remaining);
  localStorage.setItem('arcadsJobs', JSON.stringify(_arcadsJobs));
  svRenderJobs();
  // Also refresh the Agents & Ops tab tracker if it's rendered
  if (typeof renderArcadsJobs === 'function') renderArcadsJobs();
}

// ─── SECTION 4: Script Performance Table ─────────────────────────────────────

let _svCurrentSort = 'done';

function svSortScripts(sortBy) {
  _svCurrentSort = sortBy;
  svRenderScriptTable(_svScripts);
}

function svRenderScriptTable(scripts) {
  const tbody = document.getElementById('svScriptTableBody');
  if (!tbody) return;

  if (!scripts || !scripts.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="6">No scripts found.</td></tr>';
    return;
  }

  const sorted = [...scripts].sort((a, b) => {
    if (_svCurrentSort === 'name') return a.name.localeCompare(b.name);
    return b.done - a.done; // default: most done
  });

  tbody.innerHTML = sorted.map(s => {
    const statusDot = s.done > 0
      ? `<span style="color:var(--green)">●</span>`
      : s.pending > 0
        ? `<span style="color:var(--yellow)">●</span>`
        : `<span style="color:var(--muted)">○</span>`;
    const actions = s.firstUrl
      ? `<div style="display:flex;gap:4px;">
           <a href="${s.firstUrl}" target="_blank" class="btn btn-ghost" style="font-size:10px;padding:3px 7px;">▶ Watch</a>
           <button class="btn btn-teal" style="font-size:10px;padding:3px 7px;" onclick="queueFromArcads('${s.id}','${x(s.name)}','${s.firstUrl}')">+ Queue</button>
         </div>`
      : '<span style="font-size:11px;color:var(--muted);">—</span>';

    return `<tr>
      <td><span style="font-size:12px;font-weight:700;">${statusDot} ${x(s.name)}</span></td>
      <td><span class="muted" style="font-size:11px;">${x(s.folderName || '—')}</span></td>
      <td style="text-align:center;color:var(--green);font-weight:800;">${s.done}</td>
      <td style="text-align:center;color:var(--gold);font-weight:800;">${s.pending}</td>
      <td style="text-align:center;color:var(--red);font-weight:800;">${s.failed}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

// ─── SECTION 5: Upload Queue (sv-prefixed) ────────────────────────────────────
// These mirror initUpload / submitUpload / cancelUpload / renderUploadQueue
// but use svDropZone, svFileInput, svUploadForm, etc.

let _svPendingFile = null;

function svInitUpload() {
  const zone  = document.getElementById('svDropZone');
  const input = document.getElementById('svFileInput');
  if (!zone || !input) return;

  zone.onclick = () => input.click();
  zone.ondragover  = (e) => { e.preventDefault(); zone.classList.add('drag-over'); };
  zone.ondragleave = ()  => zone.classList.remove('drag-over');
  zone.ondrop = (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) svShowUploadForm(f);
  };
  input.onchange = () => { if (input.files[0]) svShowUploadForm(input.files[0]); };
}

function svShowUploadForm(file) {
  _svPendingFile = file;
  const fname = document.getElementById('svUploadFileName');
  const title = document.getElementById('svUploadTitle');
  const form  = document.getElementById('svUploadForm');
  const zone  = document.getElementById('svDropZone');

  if (fname) fname.textContent = `${file.name}  (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
  if (title) title.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
  if (form)  form.style.display = 'block';
  if (zone)  zone.style.display = 'none';
}

function svCancelUpload() {
  _svPendingFile = null;
  const form  = document.getElementById('svUploadForm');
  const zone  = document.getElementById('svDropZone');
  const input = document.getElementById('svFileInput');
  if (form)  form.style.display  = 'none';
  if (zone)  zone.style.display  = 'block';
  if (input) input.value         = '';
}

async function svSubmitUpload() {
  if (!_svPendingFile) return;
  const btn = document.getElementById('svUploadSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Uploading…'; }

  const platforms = [...document.querySelectorAll('#svPlatformCheckboxes input:checked')]
    .map(i => i.value).join(',');

  const fd = new FormData();
  fd.append('video',       _svPendingFile);
  fd.append('title',       document.getElementById('svUploadTitle')?.value.trim() || '');
  fd.append('description', document.getElementById('svUploadDesc')?.value.trim() || '');
  fd.append('platforms',   platforms);

  try {
    const r    = await fetch('/api/upload/video', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.ok) {
      svCancelUpload();
      svRenderUploadQueue();
      // Also refresh the original upload queue in Content Studio tab if visible
      if (typeof renderUploadQueue === 'function') renderUploadQueue();
    } else {
      alert('Upload failed: ' + (data.error || 'Unknown error'));
    }
  } catch(e) {
    alert('Upload error: ' + e.message);
  }

  if (btn) { btn.disabled = false; btn.textContent = '📤 Add to Queue'; }
}

async function svRenderUploadQueue() {
  const el = document.getElementById('svUploadQueue');
  if (!el) return;

  // Ensure buffer channels are loaded (reuse shared global + loader)
  if (!_bufferChannels.length && typeof loadBufferChannels === 'function') {
    await loadBufferChannels();
  }

  try {
    const q = await fetch('/api/upload/queue').then(r => r.json());
    if (!q.length) {
      el.innerHTML = '<div class="muted" style="font-size:12px;font-style:italic;">No videos staged yet.</div>';
      return;
    }

    const SICONS = { tiktok: '♪', instagram: '📸', youtube: '▶', twitter: '𝕏', linkedin: 'in', facebook: 'f' };

    el.innerHTML = q.map(v => {
      const videoUrl   = v.arcadsUrl || (v.localUrl ? `http://localhost:${location.port || 3457}${v.localUrl}` : '');
      const displayUrl = v.arcadsUrl || v.localUrl || '';
      const channelOpts = _bufferChannels.map(c =>
        `<option value="${c.id}">${SICONS[c.service] || '○'} ${x(c.name)}</option>`
      ).join('');

      return `
      <div class="upload-item" id="svqi-${v.id}">
        <div style="font-size:22px;flex-shrink:0;">${v.source === 'arcads' ? '🎬' : '🎥'}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${x(v.title)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;">
            ${(v.platforms || []).map(p => `<span>${SICONS[p] || p}</span>`).join(' ')} ·
            ${v.source === 'arcads' ? 'Arcads AI' : 'Upload'} ·
            ${new Date(v.uploadedAt).toLocaleDateString()}
          </div>
          ${displayUrl ? `<div style="margin-top:4px;display:flex;align-items:center;gap:4px;">
            <span style="font-size:10px;font-family:'JetBrains Mono',monospace;color:var(--teal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;">${displayUrl.replace(/^https?:\/\/[^/]+/, '')}</span>
            <button class="btn btn-ghost" style="font-size:10px;padding:2px 6px;flex-shrink:0;" onclick="navigator.clipboard.writeText('${encodeURIComponent(videoUrl)}')">Copy</button>
          </div>` : ''}
        </div>
        <span class="upload-status ${v.status}">${v.status}</span>
        <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;">
          ${videoUrl ? `<a href="${videoUrl}" target="_blank" class="btn btn-ghost" style="font-size:11px;padding:4px 8px;">⬇</a>` : ''}
          ${v.status === 'staged' && _bufferChannels.length ? `
            <select id="svBufChan-${v.id}" class="agent-input" style="width:130px;padding:3px 6px;font-size:11px;">
              <option value="">Pick channel…</option>${channelOpts}
            </select>
            <button class="btn btn-teal" style="font-size:11px;padding:4px 8px;" onclick="svPostToBuffer('${v.id}','${encodeURIComponent(videoUrl || '')}','${encodeURIComponent(v.title || '')}')">Post ↗</button>
          ` : ''}
          ${v.status === 'staged' ? `<button class="btn btn-ghost" style="font-size:11px;padding:4px 8px;" onclick="markPublished('${v.id}');svRenderUploadQueue();">✓</button>` : ''}
          <button class="btn btn-ghost" style="font-size:11px;padding:4px 8px;color:var(--red);" onclick="removeUpload('${v.id}');svRenderUploadQueue();">✕</button>
        </div>
      </div>`;
    }).join('');

  } catch(e) {
    el.innerHTML = '<div class="muted" style="font-size:12px;">Could not load queue.</div>';
  }
}

// Buffer post helper scoped to svUploadQueue (reads svBufChan- selects)
async function svPostToBuffer(videoId, encodedUrl, encodedTitle) {
  const chanEl = document.getElementById(`svBufChan-${videoId}`);
  if (!chanEl || !chanEl.value) { alert('Pick a Buffer channel first.'); return; }
  // Delegate to the shared postToBuffer function (same API surface)
  if (typeof postToBuffer === 'function') {
    // Temporarily copy the channel select value so postToBuffer can read bufChan-{id}
    // The cleanest approach: call the API directly here
    const channelId   = chanEl.value;
    const videoUrl    = decodeURIComponent(encodedUrl);
    const title       = decodeURIComponent(encodedTitle);
    try {
      const r = await fetch('/api/buffer/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, text: title, mediaUrl: videoUrl }),
      });
      const data = await r.json();
      if (data.ok || data.data) {
        await fetch('/api/upload/queue/' + videoId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'published' }),
        });
        svRenderUploadQueue();
        if (typeof renderUploadQueue === 'function') renderUploadQueue();
      } else {
        alert('Buffer post failed: ' + (data.error || JSON.stringify(data)));
      }
    } catch(e) { alert('Buffer error: ' + e.message); }
  }
}

// ─── Main render ──────────────────────────────────────────────────────────────

async function renderShortVideo() {
  svLoadStats();        // fetches stats + renders performance table
  svRenderJobs();       // reads _arcadsJobs (shared global)
  svRenderHookLibrary();
  svPopulateHookSelect();
  svRenderUploadQueue();
}

// ─── Tab init (called by tab-switcher when shortvideo tab is activated) ────────
// Wire this up in the tab-btn click handler:
//
//   case 'shortvideo':
//     svInitActors();      // fetch actors once
//     renderShortVideo();  // stats, jobs, hooks, queue
//     break;
//
// Or add to the existing initArcads() / page-load block:
//   svInitActors().then(() => renderShortVideo());
