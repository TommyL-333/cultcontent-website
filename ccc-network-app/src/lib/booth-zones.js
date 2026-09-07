// Where a brand is on site. The three named areas match the venue plan.
// `freedom-way` is the historical id for what's now labelled American Way —
// kept because live paid reservations and its Stripe link both reference it,
// and renaming the id would orphan them.
export const BOOTH_ZONES = [
  { id: 'freedom-way', label: 'American Way' },
  { id: 'capitol-canopy', label: 'Capital Canopy' },
  { id: 'belvedere', label: 'The Belvedere' },
  { id: 'other', label: 'Other' },
];

export function zoneLabel(person) {
  if (!person?.booth_zone) return '';
  return BOOTH_ZONES.find((z) => z.id === person.booth_zone)?.label || '';
}
