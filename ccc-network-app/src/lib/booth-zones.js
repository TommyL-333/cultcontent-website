// Where a brand is on site. Ids match lib/ccc-booths.js so a profile answer
// and a paid booth reservation describe the same place — `freedom-way` is
// the historical id for what's now labelled American Way, kept because live
// reservations and its Stripe link both reference it.
export const BOOTH_ZONES = [
  { id: 'capitol-canopy', label: 'Capitol Canopy' },
  { id: 'freedom-way', label: 'American Way' },
  { id: 'other', label: 'Other' },
];

export function zoneLabel(person) {
  if (!person?.booth_zone) return '';
  if (person.booth_zone === 'other') return person.booth_note || 'Other';
  return BOOTH_ZONES.find((z) => z.id === person.booth_zone)?.label || '';
}
