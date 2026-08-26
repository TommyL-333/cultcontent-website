// Shared initials-avatar helpers — no photo upload, just a colored circle
// with the person's initials (Slack/Discord-style fallback), derived
// deterministically from their uuid so the same person always gets the
// same color across screens.
const COLORS = ['default', 'accent', 'danger', 'success', 'warning'];

export function initialsOf(person) {
  const a = (person?.first_name || '?')[0] || '?';
  const b = (person?.last_name || '')[0] || '';
  return (a + b).toUpperCase();
}

export function colorOf(person) {
  const key = person?.uuid || person?.email || '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

export function displayName(person) {
  const name = `${person?.first_name || ''} ${person?.last_name || ''}`.trim();
  return name || (person?.role === 'brand' ? person?.brand_name : person?.tiktok_handle || person?.instagram_handle) || 'Someone';
}

function atHandle(h) {
  return h ? `@${h.replace(/^@/, '')}` : '';
}

// A creator's "org" line used to be one handle; now there can be two.
// Prefer TikTok (the event's primary platform) as the lead handle, with
// Instagram appended only if it's actually different from TikTok's.
export function orgOf(person) {
  if (person?.role === 'brand') return person?.brand_name || '';
  const tiktok = atHandle(person?.tiktok_handle);
  const instagram = atHandle(person?.instagram_handle);
  if (tiktok && instagram) return `${tiktok} · ${instagram} (IG)`;
  return tiktok || instagram;
}
