/**
 * Orientation map of the Creator Carnival footprint at National Harbor.
 *
 * Areas, not booths. `ccc_booth_signups` records a booth_type and has never
 * recorded a booth number, so area is the finest grain the data actually
 * supports — and pin-level precision would be a promise that breaks the first
 * time a vendor moves on the day. Tap an area to filter the exhibitor list.
 *
 * North-up and orthogonal, traced from a marked-up Apple Maps screenshot. An
 * earlier version was built from an angled satellite view and drew the street
 * grid on a diagonal, which is why it read as completely wrong.
 *
 * Only the labels left uncrossed on that markup appear here: the four streets,
 * and a few fixed businesses people navigate by. Everything else is deleted so
 * the map carries only what someone standing there needs.
 */

const VIEW = { w: 1000, h: 700 };

// Fixed geography. Streets don't move, which is what makes this safe to draw.
// Framed tight on the event footprint — an earlier pass gave 40% of the canvas
// to empty water, which left everything else unreadable on a phone.
const STREETS = [
  // Label suppressed: the American Way *area* is drawn over this street and
  // carries the name in its own colour, so printing it twice just crowds it.
  { id: 'american-way', label: 'American Way', x1: 470, y1: 300, x2: 1000, y2: 300, vertical: false, hideLabel: true },
  { id: 'mariner-passage', label: 'Mariner Passage', x1: 560, y1: 528, x2: 1000, y2: 528, vertical: false },
  { id: 'waterfront-st', label: 'Waterfront St', x1: 560, y1: 0, x2: 560, y2: 700, vertical: true },
  { id: 'fleet-st', label: 'Fleet St', x1: 862, y1: 0, x2: 862, y2: 700, vertical: true },
];

// Uncrossed labels from the markup — orientation points, not zones.
const LANDMARKS = [
  { id: 'karaoke', label: 'Live K Karaoke', x: 372, y: 108 },
  { id: 'mahogany', label: 'MahoganyBooks', x: 648, y: 366 },
  { id: 'ac-hotel', label: 'AC Hotel', x: 648, y: 428 },
  { id: 'capital-wheel', label: 'The Capital Wheel', x: 96, y: 244, labelSide: 'right' },
];

// City blocks between the streets, so the land doesn't read as empty space.
const BLOCKS = [
  { x: 580, y: 24, w: 258, h: 252 },
  { x: 886, y: 24, w: 114, h: 252 },
  { x: 580, y: 324, w: 258, h: 180 },
  { x: 886, y: 324, w: 114, h: 180 },
  { x: 580, y: 552, w: 258, h: 124 },
  { x: 886, y: 552, w: 114, h: 124 },
  { x: 300, y: 24, w: 240, h: 252 },
];

export const MAP_AREAS = [
  {
    id: 'freedom-way', // historical id; labelled American Way since the rename
    label: 'American Way',
    accent: 'accent',
    shape: { x: 478, y: 268, w: 512, h: 64 },
    labelAt: { x: 734, y: 244 },
    kind: 'booths',
  },
  {
    id: 'capitol-canopy',
    label: 'Capitol Canopy',
    accent: 'accent-2',
    shape: { x: 54, y: 386, w: 244, h: 92 },
    labelAt: { x: 176, y: 504 },
    kind: 'booths',
  },
  {
    id: 'main-stage',
    label: 'Main Stage',
    accent: 'gold',
    shape: { x: 336, y: 300, w: 128, h: 76 },
    labelAt: { x: 400, y: 396 },
    kind: 'stage',
  },
];

const accentVar = (a) =>
  a === 'accent-2' ? 'var(--color-accent-2)' : a === 'gold' ? 'var(--color-gold)' : 'var(--color-accent)';

export default function AreaMap({ selected, onSelect, counts = {} }) {
  return (
    <div>
      <svg
        viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
        className="w-full rounded-md border border-border bg-[#0d1a1f]"
        style={{ aspectRatio: `${VIEW.w} / ${VIEW.h}` }}
        role="img"
        aria-label="Areas of the Creator Carnival site at National Harbor"
      >
        <rect x="0" y="0" width={VIEW.w} height={VIEW.h} fill="#15130f" />

        {/* Water to the west, with the dock Capitol Canopy sits on. */}
        <rect x="0" y="0" width="292" height={VIEW.h} fill="#0b3a45" />
        {/* The dock Capitol Canopy sits on, jutting west off the shoreline. */}
        <rect x="44" y="376" width="262" height="112" rx="5" fill="#e6e1d8" opacity=".26" />

        {BLOCKS.map((b) => (
          <rect key={`${b.x}-${b.y}`} {...b} rx="3" fill="#221f1b" stroke="#2f2a25" strokeWidth="1.5" />
        ))}

        {STREETS.map((s) => (
          <line key={s.id} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="#3a332d" strokeWidth="34" strokeLinecap="butt" />
        ))}

        {STREETS.filter((s) => !s.hideLabel).map((s) => {
          const mx = (s.x1 + s.x2) / 2;
          const my = (s.y1 + s.y2) / 2;
          return (
            <text
              key={`${s.id}-l`}
              x={mx} y={my}
              transform={s.vertical ? `rotate(-90 ${mx} ${my})` : undefined}
              textAnchor="middle" dominantBaseline="middle"
              className="text-[17px] font-bold uppercase"
              fill="rgba(255,255,255,.55)"
              style={{ letterSpacing: '.12em', paintOrder: 'stroke', stroke: '#15130f', strokeWidth: 3 }}
            >
              {s.label}
            </text>
          );
        })}

        {MAP_AREAS.map((a) => {
          const color = accentVar(a.accent);
          const isSel = selected === a.id;
          const n = counts[a.id];
          return (
            <g
              key={a.id}
              onClick={() => onSelect?.(isSel ? null : a.id)}
              className="cursor-pointer"
              role="button"
              tabIndex={0}
              aria-label={`${a.label}${typeof n === 'number' ? `, ${n} exhibitors` : ''}`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(isSel ? null : a.id); } }}
            >
              <rect
                {...a.shape} rx="6"
                fill={color}
                fillOpacity={isSel ? 0.55 : 0.32}
                stroke={color}
                strokeWidth={isSel ? 4 : 2.5}
              />
              <text
                x={a.labelAt.x} y={a.labelAt.y}
                textAnchor="middle" dominantBaseline="middle"
                className="pointer-events-none text-[22px] font-black"
                fill={color}
                style={{ paintOrder: 'stroke', stroke: '#15130f', strokeWidth: 4 }}
              >
                {a.label}{typeof n === 'number' && n > 0 ? ` · ${n}` : ''}
              </text>
            </g>
          );
        })}

        {LANDMARKS.map((l) => (
          <g key={l.id}>
            <circle cx={l.x} cy={l.y} r="6" fill="rgba(255,255,255,.5)" />
            <text
              x={l.x + 13} y={l.y + 1}
              dominantBaseline="middle"
              className="text-[15px] font-semibold"
              fill="rgba(255,255,255,.6)"
              style={{ paintOrder: 'stroke', stroke: '#15130f', strokeWidth: 3 }}
            >
              {l.label}
            </text>
          </g>
        ))}

        {/* North arrow — the map is north-up and that's worth stating. */}
        <g transform="translate(948, 44)" aria-hidden>
          <path d="M0,-16 L7,10 L0,4 L-7,10 Z" fill="rgba(255,255,255,.6)" />
          <text x="0" y="26" textAnchor="middle" className="text-[11px] font-bold" fill="rgba(255,255,255,.6)">N</text>
        </g>
      </svg>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Areas, not exact booth positions — find the area, then look for the sign. Not to scale.
      </p>
    </div>
  );
}
