/**
 * Creator Carnival — Networking Hub, server-rendered pages
 *
 * Same technique already used elsewhere in dashboard-server.js for
 * /creators/* (renderOpportunitiesPage / renderCreatorPage / renderWelcomePage):
 * build an HTML string, res.send() it. Split into this file so
 * dashboard-server.js doesn't grow further.
 *
 * Styling: Tailwind CDN (no build step, matches every other page in this repo)
 * with a small shadcn/Watermelon-UI-style token set — see HEAD below. Plain
 * HTML/CSS, not literal Watermelon UI React components (this repo has no
 * React/bundler anywhere), just the same visual language: bg-card/bg-background
 * tokens, rounded-md/xl, shadow-sm, ring-based focus states.
 */

const HEAD = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
          colors: {
            background: '#0a0a0b', foreground: '#f4f4f5',
            card: '#141416', 'card-foreground': '#f4f4f5',
            border: '#26262b', input: '#26262b', ring: '#00c2cb',
            primary: '#00c2cb', 'primary-foreground': '#04121a',
            secondary: '#1c1c1f', 'secondary-foreground': '#f4f4f5',
            muted: '#1c1c1f', 'muted-foreground': '#9a9aa2',
            accent: '#1c1c1f', 'accent-foreground': '#f4f4f5',
            destructive: '#f0506e', 'destructive-foreground': '#fff1f3',
            gold: '#d4af37',
          },
        },
      },
    };
  </script>
`;

const INPUT_CLS = 'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const LABEL_CLS = 'block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide';
const BTN_PRIMARY_CLS = 'inline-flex items-center justify-center gap-2 rounded-md h-10 px-5 text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const BTN_OUTLINE_CLS = 'inline-flex items-center justify-center gap-2 rounded-md h-10 px-5 text-sm font-semibold border border-input bg-background hover:bg-accent transition-colors';
const BTN_PRIMARY_SM_CLS = 'inline-flex items-center justify-center gap-2 rounded-md h-9 px-4 text-[13px] font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:pointer-events-none disabled:opacity-50';
const CARD_CLS = 'rounded-xl border border-border bg-card shadow-sm';

function topbar(person) {
  return `
  <div class="max-w-3xl mx-auto flex items-center justify-between px-5 py-5">
    <a class="flex items-center gap-2.5" href="/culture-commerce-carnival">
      <img src="https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png" alt="Cult Content" class="h-5" />
      <span class="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Creator Carnival</span>
    </a>
    <div class="flex items-center gap-5 text-[13px] font-medium">
      <a href="/ccc-network/directory" class="text-muted-foreground hover:text-foreground transition-colors">Directory</a>
      <a href="/ccc-network/profile" class="text-muted-foreground hover:text-foreground transition-colors">My Profile</a>
      ${person.role === 'brand' && ['priority','executive'].includes(person.tier) ? '<a href="/ccc-network/contacts.csv" class="text-muted-foreground hover:text-foreground transition-colors">Export Contacts</a>' : ''}
      <a href="/ccc-network/logout" class="text-muted-foreground hover:text-foreground transition-colors">Log out</a>
    </div>
  </div>`;
}

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} — Creator Carnival Networking</title>${HEAD}</head><body class="bg-background text-foreground font-sans antialiased min-h-screen">${body}</body></html>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderProfilePage(person) {
  const links = (person.links || []).map(l => l.url).join('\n');
  const body = `
  ${topbar(person)}
  <div class="max-w-2xl mx-auto px-5 pb-20">
    <h1 class="text-3xl font-extrabold tracking-tight mb-2">Your profile</h1>
    <p class="text-sm text-muted-foreground mb-7">This is what the rest of the roster sees when they browse the directory.</p>

    <div class="${CARD_CLS} p-6 sm:p-7 mb-5">
      <div id="err" class="hidden rounded-md border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive mb-4"></div>
      <form id="profileForm" class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div><label class="${LABEL_CLS}">First name</label><input id="f-first" value="${esc(person.first_name)}" required class="${INPUT_CLS}" /></div>
          <div><label class="${LABEL_CLS}">Last name</label><input id="f-last" value="${esc(person.last_name)}" class="${INPUT_CLS}" /></div>
        </div>
        <div><label class="${LABEL_CLS}">Phone</label><input id="f-phone" value="${esc(person.phone)}" class="${INPUT_CLS}" /></div>
        ${person.role === 'creator'
          ? `<div><label class="${LABEL_CLS}">TikTok / IG handle</label><input id="f-handle" value="${esc(person.handle)}" class="${INPUT_CLS}" /></div>
             <div><label class="${LABEL_CLS}">Content niche</label><input id="f-category" value="${esc(person.category)}" class="${INPUT_CLS}" /></div>`
          : `<div><label class="${LABEL_CLS}">Brand name</label><input id="f-brandname" value="${esc(person.brand_name)}" class="${INPUT_CLS}" /></div>
             <div><label class="${LABEL_CLS}">Product category</label><input id="f-category" value="${esc(person.category)}" class="${INPUT_CLS}" /></div>`}
        <div><label class="${LABEL_CLS}">Bio</label><textarea id="f-bio" class="${INPUT_CLS} min-h-[80px] resize-y">${esc(person.bio)}</textarea></div>
        <div><label class="${LABEL_CLS}">What are you looking for?</label><textarea id="f-looking" class="${INPUT_CLS} min-h-[80px] resize-y">${esc(person.looking_for)}</textarea></div>
        <div><label class="${LABEL_CLS}">Links (one per line)</label><textarea id="f-links" class="${INPUT_CLS} min-h-[70px] resize-y">${esc(links)}</textarea></div>
        <div class="flex items-center gap-4 pt-1">
          <button class="${BTN_PRIMARY_CLS}" type="submit">Save Profile</button>
          <span class="hidden text-sm font-medium text-primary" id="saved">Saved ✓</span>
        </div>
      </form>
    </div>
    <a class="${BTN_OUTLINE_CLS}" href="/ccc-network/directory">Browse the directory &rarr;</a>
  </div>
  <script>
  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err'); err.classList.add('hidden');
    const payload = {
      first_name: document.getElementById('f-first').value.trim(),
      last_name: document.getElementById('f-last').value.trim(),
      phone: document.getElementById('f-phone').value.trim(),
      category: document.getElementById('f-category').value.trim(),
      bio: document.getElementById('f-bio').value.trim(),
      looking_for: document.getElementById('f-looking').value.trim(),
      ${person.role === 'creator' ? "handle: document.getElementById('f-handle').value.trim()," : "brand_name: document.getElementById('f-brandname').value.trim(),"}
      links: document.getElementById('f-links').value.split('\\n').map(s => s.trim()).filter(Boolean).map(url => ({ label: 'Link', url })),
    };
    try {
      const r = await fetch('/ccc-network/profile', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Save failed');
      const saved = document.getElementById('saved');
      saved.classList.remove('hidden');
      setTimeout(() => saved.classList.add('hidden'), 2500);
    } catch (e2) {
      err.textContent = e2.message; err.classList.remove('hidden');
    }
  });
  </script>`;
  return page('My Profile', body);
}

function renderDirectoryPage(person, gated, opensAt) {
  if (gated) {
    const body = `
    ${topbar(person)}
    <div class="max-w-2xl mx-auto px-5 pb-20">
      <div class="${CARD_CLS} p-10 text-center">
        <i class="fa-solid fa-lock text-3xl text-primary mb-5 block"></i>
        <h1 class="text-2xl font-extrabold tracking-tight mb-3">Priority sponsors get first pick.</h1>
        <p class="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto">Marketplace and Carnival sponsors have early access to the roster. General access opens ${opensAt ? esc(new Date(opensAt).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })) : 'soon'} — check back then.</p>
      </div>
    </div>`;
    return page('Directory', body);
  }

  const body = `
  ${topbar(person)}
  <div class="max-w-3xl mx-auto px-5 pb-20">
    <h1 class="text-3xl font-extrabold tracking-tight mb-2">The roster</h1>
    <p class="text-sm text-muted-foreground mb-6">${person.role === 'creator' ? 'Brands and fellow creators' : 'Creators looking to collab'} — search, filter, and connect. Connecting shares contact info both ways.</p>
    <div class="relative mb-6">
      <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm"></i>
      <input id="q" placeholder="Search by name, category, or what they're looking for…" class="${INPUT_CLS} pl-10 h-11" />
    </div>
    <div id="grid" class="grid gap-3.5"><div class="text-center text-sm text-muted-foreground py-14">Loading…</div></div>
  </div>
  <script>
  let PEOPLE = [];
  function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  function card(p) {
    const org = p.role === 'brand' ? p.brand_name : (p.handle ? '@' + p.handle.replace(/^@/,'') : '');
    const badgeCls = p.role === 'brand' ? 'border-gold/25 bg-gold/10 text-gold' : 'border-primary/20 bg-primary/10 text-primary';
    return \`<div class="${CARD_CLS} p-5">
      <span class="inline-flex items-center rounded-full border \${badgeCls} px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">\${p.role === 'brand' ? 'Brand' : 'Creator'}</span>
      <div class="text-base font-bold mt-2.5">\${esc(p.first_name)} \${esc(p.last_name || '')} \${org ? '· ' + esc(org) : ''}</div>
      <div class="text-xs text-muted-foreground mt-0.5 mb-3">\${esc(p.category || '')}</div>
      \${p.bio ? '<div class="text-[13px] text-foreground/85 leading-relaxed mb-2.5">' + esc(p.bio) + '</div>' : ''}
      \${p.looking_for ? '<div class="text-xs text-muted-foreground mb-3.5"><b class="text-foreground/80 font-semibold">Looking for:</b> ' + esc(p.looking_for) + '</div>' : ''}
      <button class="${BTN_PRIMARY_SM_CLS} connect-btn" onclick="connect('\${p.uuid}', this)">Connect &rarr;</button>
      <div class="contact-box hidden mt-3 rounded-md border border-primary/25 bg-primary/5 px-3.5 py-2.5 text-[13px]"></div>
    </div>\`;
  }
  function render(list) {
    const grid = document.getElementById('grid');
    if (!list.length) { grid.innerHTML = '<div class="text-center text-sm text-muted-foreground py-14">No matches yet.</div>'; return; }
    grid.innerHTML = list.map(card).join('');
  }
  async function connect(uuid, btn) {
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const r = await fetch('/ccc-network/connect/' + uuid, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Could not connect');
      btn.textContent = 'Connected ✓';
      const box = btn.parentElement.querySelector('.contact-box');
      box.classList.remove('hidden');
      box.innerHTML = 'Email: ' + esc(j.otherPerson.email) + (j.otherPerson.phone ? '<br>Phone: ' + esc(j.otherPerson.phone) : '');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Connect →';
      alert(e.message);
    }
  }
  fetch('/api/ccc-network/directory.json').then(r => r.json()).then(j => {
    PEOPLE = j.people || [];
    render(PEOPLE);
  });
  document.getElementById('q').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    render(PEOPLE.filter(p => [p.first_name, p.last_name, p.brand_name, p.handle, p.category, p.looking_for, p.bio].join(' ').toLowerCase().includes(q)));
  });
  </script>`;
  return page('Directory', body);
}

module.exports = { renderProfilePage, renderDirectoryPage };
