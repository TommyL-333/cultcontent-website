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
  return name || (person?.role === 'brand' ? person?.brand_name : person?.handle) || 'Someone';
}

export function orgOf(person) {
  return person?.role === 'brand' ? person?.brand_name : (person?.handle ? `@${person.handle.replace(/^@/, '')}` : '');
}
