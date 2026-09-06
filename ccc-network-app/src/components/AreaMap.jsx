/**
 * Site map of the Creator Carnival footprint at National Harbor.
 *
 * Traced directly from the venue whiteboard (Lark doc RHDHddTa0onVsRx2iKnu5XgLtje).
 * The viewBox is the whiteboard's own coordinate space, so every shape below
 * carries the numbers the plan actually uses — no hand-transcription, and a
 * change to the plan is a numbers-only edit. Two earlier versions were built
 * by inference and were both wrong.
 *
 * Areas, not booths. ccc_booth_signups records a booth_type and has never
 * recorded a booth number, so area is the finest grain the data supports —
 * and pin precision would break the first time a vendor moves on the day.
 */

// The whiteboard's bounding box, used verbatim as the viewBox.
const VIEW = { x: -199, y: -509, width: 3764, height: 1361 };

const WATER = { x: -199, y: -509, width: 884, height: 1361 };
const LAND = { x: 685, y: -508, width: 2880, height: 1360 };

// Both run north–south on the plan.
const STREETS = [
  { id: 'national-plaza', label: 'National Plaza', x: 1070, y: -508, width: 62, height: 1359 },
  { id: 'waterfront-st', label: 'Waterfront Street', x: 1531, y: -507, width: 62, height: 1359 },
];

// The two carriageways of American Way, with the activation zone between them.
const AVENUE_BARS = [
  { x: 1531, y: 115, width: 2034, height: 40 },
  { x: 1531, y: 305, width: 2034, height: 40 },
];

const LANDMARKS = [
  { id: 'capital-wheel', label: 'Capital Wheel', x: 133, y: 299, width: 110, height: 104 },
  { id: 'pier', label: 'Pier', x: 240, y: 325, width: 444, height: 53 },
  { id: 'karaoke', label: 'K Live Karaoke', x: 946, y: -508, width: 347, height: 199 },
  { id: 'stairs-n', label: 'Stairs', x: 1123, y: 85, width: 293, height: 81 },
  { id: 'stairs-s', label: 'Stairs', x: 1116, y: 316, width: 293, height: 81 },
];

// `boothZone` ties an area to booth_type in ccc_booth_signups so the exhibitor
// count and the list filter come from real paid signups. Areas without one are
// activations and programming — real places, but nobody signs up for a booth there.
export const MAP_AREAS = [
  {
    id: 'freedom-way',
    boothZone: 'freedom-way',
    label: 'American Way',
    accent: 'accent',
    shape: { x: 1531, y: 115, width: 2034, height: 230 },
    labelAt: { x: 1790, y: 230 },
    repeatLabelAt: [{ x: 3220, y: 230 }],
    kind: 'booths',
  },
  {
    id: 'capitol-canopy',
    boothZone: 'capitol-canopy',
    label: 'Capital Canopy',
    accent: 'accent-2',
    shape: { x: 365, y: 374, width: 245, height: 183 },
    labelAt: { x: 487, y: 606 },
    kind: 'booths',
  },
  {
    id: 'plaza-stage',
    label: 'Plaza Stage',
    accent: 'gold',
    shape: { x: 680, y: 64, width: 212, height: 314 },
    labelAt: { x: 786, y: 24 },
    kind: 'stage',
  },
  {
    id: 'belvedere',
    label: 'The Belvedere',
    accent: 'gold',
    shape: { x: 1116, y: 166, width: 293, height: 150 },
    labelAt: { x: 1262, y: 462 },
    detail: 'Movement Retail + Zenjoy',
    kind: 'activation',
  },
  {
    id: 'drop-tv',
    label: 'Drop TV',
    accent: 'accent-2',
    shape: { x: 2305, y: 178, width: 269, height: 104 },
    labelAt: { x: 2440, y: 208 },
    detailOffset: 44,
    detail: 'Activation Zone',
    kind: 'activation',
  },
];

const accentVar = (a) =>
  a === 'accent-2' ? 'var(--color-accent-2)' : a === 'gold' ? 'var(--color-gold)' : 'var(--color-accent)';

export default function AreaMap({ selected, onSelect, counts = {} }) {
  return (
    <div>
      {/* The real footprint is nearly 3:1, so on a phone it scrolls sideways
          rather than shrinking the type to nothing. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <svg
          viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}
          className="block bg-[#0d1a1f]"
          style={{ width: '100%', minWidth: 900, aspectRatio: `${VIEW.width} / ${VIEW.height}` }}
          role="img"
          aria-label="Site map of the Creator Carnival at National Harbor"
        >
          <rect {...LAND} fill="#1b1815" />
          <rect {...WATER} fill="#0b3a45" />

          {STREETS.map((s) => (
            <g key={s.id}>
              <rect x={s.x} y={s.y} width={s.width} height={s.height} fill="#3a332d" />
              <text
                x={s.x + s.width / 2} y={s.y + s.height / 2}
                transform={`rotate(-90 ${s.x + s.width / 2} ${s.y + s.height / 2})`}
                textAnchor="middle" dominantBaseline="middle"
                className="font-bold uppercase" fontSize="46"
                fill="rgba(255,255,255,.6)"
                style={{ letterSpacing: '.1em', paintOrder: 'stroke', stroke: '#1b1815', strokeWidth: 10 }}
              >
                {s.label}
              </text>
            </g>
          ))}

          {AVENUE_BARS.map((b) => <rect key={b.y} {...b} fill="#3a332d" />)}

          {LANDMARKS.map((l) => (
            <g key={l.id}>
              <rect x={l.x} y={l.y} width={l.width} height={l.height} rx="10" fill="#2b2621" stroke="#3d372f" strokeWidth="4" />
              <text
                x={l.x + l.width / 2} y={l.y + l.height / 2}
                textAnchor="middle" dominantBaseline="middle"
                className="font-semibold" fontSize="40"
                fill="rgba(255,255,255,.62)"
              >
                {l.label}
              </text>
            </g>
          ))}

          {MAP_AREAS.map((a) => {
            const color = accentVar(a.accent);
            const isSel = selected === a.id;
            const n = a.boothZone ? counts[a.boothZone] : undefined;
            return (
              <g
                key={a.id}
                onClick={() => onSelect?.(isSel ? null : a.id)}
                className="cursor-pointer"
                role="button"
                tabIndex={0}
                aria-label={`${a.label}${a.detail ? `, ${a.detail}` : ''}${typeof n === 'number' ? `, ${n} exhibitors` : ''}`}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(isSel ? null : a.id); } }}
              >
                <rect
                  {...a.shape} rx="12"
                  fill={color} fillOpacity={isSel ? 0.55 : 0.3}
                  stroke={color} strokeWidth={isSel ? 10 : 6}
                />
                <text
                  x={a.labelAt.x} y={a.labelAt.y}
                  textAnchor="middle" dominantBaseline="middle"
                  className="pointer-events-none font-black" fontSize="54"
                  fill={color}
                  style={{ paintOrder: 'stroke', stroke: '#0d1a1f', strokeWidth: 12 }}
                >
                  {a.label}{typeof n === 'number' && n > 0 ? ` · ${n}` : ''}
                </text>
                {a.repeatLabelAt?.map((pos) => (
                  <text
                    key={`${pos.x}-${pos.y}`}
                    x={pos.x} y={pos.y}
                    textAnchor="middle" dominantBaseline="middle"
                    className="pointer-events-none font-black" fontSize="54"
                    fill={color}
                    style={{ paintOrder: 'stroke', stroke: '#0d1a1f', strokeWidth: 12 }}
                  >
                    {a.label}
                  </text>
                ))}
                {a.detail && (
                  <text
                    x={a.labelAt.x} y={a.labelAt.y + (a.detailOffset ?? 56)}
                    textAnchor="middle" dominantBaseline="middle"
                    className="pointer-events-none font-semibold" fontSize="40"
                    fill="rgba(255,255,255,.65)"
                    style={{ paintOrder: 'stroke', stroke: '#0d1a1f', strokeWidth: 10 }}
                  >
                    {a.detail}
                  </text>
                )}
              </g>
            );
          })}

          <g transform={`translate(${VIEW.x + VIEW.width - 150}, ${VIEW.y + 130})`} aria-hidden>
            <path d="M0,-58 L26,36 L0,14 L-26,36 Z" fill="rgba(255,255,255,.6)" />
            <text x="0" y="92" textAnchor="middle" fontSize="46" className="font-bold" fill="rgba(255,255,255,.6)">N</text>
          </g>
        </svg>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Areas, not exact booth positions — find the area, then look for the sign. Scroll sideways to see the full site.
      </p>
    </div>
  );
}
