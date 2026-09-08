/**
 * Site map of the Creator Carnival footprint at National Harbor.
 *
 * Traced from the venue whiteboard (Lark doc RHDHddTa0onVsRx2iKnu5XgLtje).
 * The viewBox is the whiteboard's own coordinate space, so every shape below
 * carries the numbers the plan actually uses — there is no transcription step
 * to get wrong, and a change to the plan is a numbers-only edit here.
 *
 * Booths are drawn individually now. The earlier version deliberately showed
 * areas only, because the two booth tiers totalled 141 slots with no numbering
 * anywhere in the data. The plan now lays out 16 numbered booths, which is
 * both plottable and what someone standing on American Way will see on the
 * signs — so it draws them.
 *
 * Which brand is in which booth is still not something the app knows:
 * ccc_booth_signups records a booth_type, never a number. The numbers here are
 * positions, and the exhibitor list below the map stays the answer to "where
 * is this brand".
 */

// The whiteboard's bounding box, used verbatim.
const VIEW = { x: -1005, y: -791, width: 4307, height: 1623 };

const WATER = { x: -1005, y: -791, width: 1689, height: 1643 };
const LAND = { x: 685, y: -791, width: 2617, height: 1643 };

// Grey throughout, matching the plan. The two vertical streets are drawn from
// their real extents rather than rotated, so nothing depends on transform order.
const STREETS = [
  { id: 'national-plaza', label: 'National Plaza', x: 1214, y: -790, width: 60, height: 1618, vertical: true },
  { id: 'waterfront-st', label: 'Waterfront Street', x: 1658, y: -789, width: 90, height: 1622, vertical: true },
  { id: 'mariners-passage', label: 'Mariners Passage', x: 1154, y: 762, width: 2147, height: 70 },
];

// American Way is two carriageways with the booth rows and the Drop TV
// activation between them.
const AVENUE_BARS = [
  { x: 1630, y: -60, width: 1671, height: 40 },
  { x: 1630, y: 130, width: 1671, height: 40 },
];

// Fixed structures. Labelled, but not tappable — nothing to filter by.
const STRUCTURES = [
  { id: 'capital-wheel', label: 'Capital Wheel', x: -849, y: 265, width: 193, height: 183 },
  { id: 'pier', label: 'Pier', x: -656, y: 297, width: 1341, height: 81 },
  { id: 'karaoke', label: 'K Live Karaoke', x: 815, y: -730, width: 273, height: 374 },
  { id: 'tickets', label: 'Tickets', x: 689, y: 276, width: 78, height: 81, small: true },
  { id: 'unskrypted', label: 'Unskrypted', x: 1060, y: -66, width: 90, height: 191, rotate: true },
  { id: 'stairs-n', label: 'Stairs', x: 1223, y: -90, width: 293, height: 81 },
  { id: 'stairs-s', label: 'Stairs', x: 1223, y: 141, width: 293, height: 81 },
  { id: 'food-n', label: 'Food Truck', x: 3112, y: -87, width: 189, height: 75 },
  { id: 'food-s', label: 'Food Truck', x: 3112, y: 114, width: 189, height: 75 },
];

// Tenants inside the Belvedere, drawn over it.
const BELVEDERE_TENANTS = [
  { id: 'sohal', label: 'Sohal Bar', x: 1216, y: 35, width: 61, height: 61, round: true },
  { id: 'zenjoy', label: 'Zenjoy', x: 1262, y: 13, width: 101, height: 44 },
  { id: 'movement', label: 'Movement Retail', x: 1271, y: 79, width: 101, height: 44 },
];

// 74x77 each, two rows. Labelled with the number alone — "Booth 16" does not
// fit inside 74 units at a legible size, and the corridor is captioned anyway.
const BOOTHS = [
  { n: 1, x: 1742, y: 111 }, { n: 2, x: 1869, y: 111 }, { n: 3, x: 1996, y: 111 }, { n: 4, x: 2123, y: 111 },
  { n: 5, x: 2258, y: 111 }, { n: 6, x: 2385, y: 111 }, { n: 7, x: 2512, y: 111 }, { n: 8, x: 2639, y: 111 },
  { n: 9, x: 2639, y: -86 }, { n: 10, x: 2512, y: -86 }, { n: 11, x: 2385, y: -86 }, { n: 12, x: 2258, y: -86 },
  { n: 13, x: 2123, y: -79 }, { n: 14, x: 1996, y: -79 }, { n: 15, x: 1869, y: -79 }, { n: 16, x: 1742, y: -79 },
];
const BOOTH_SIZE = { width: 74, height: 77 };

// `boothZone` ties an area to booth_type in ccc_booth_signups, so its count and
// list filter come from real paid signups. Areas without one are programming or
// activations — real places nobody reserves a booth in.
export const MAP_AREAS = [
  {
    id: 'freedom-way',
    boothZone: 'freedom-way',
    label: 'American Way',
    caption: 'Booths 1–16',
    accent: 'accent',
    shape: { x: 1706, y: -122, width: 1010, height: 350 },
    labelAt: { x: 2211, y: -168 },
    kind: 'booths',
  },
  {
    id: 'capitol-canopy',
    boothZone: 'capitol-canopy',
    label: 'Capital Canopy',
    accent: 'accent-2',
    shape: { x: 336, y: 374, width: 305, height: 201 },
    labelAt: { x: 488, y: 620 },
    kind: 'booths',
  },
  {
    id: 'check-in',
    label: 'Check In',
    accent: 'gold',
    shape: { x: 827, y: -507, width: 104, height: 100 },
    labelAt: { x: 879, y: -560 },
    kind: 'arrival',
    detailText: 'Start here — pick up your pass, then head down to the floor.',
  },
  {
    id: 'plaza-stage',
    label: 'Plaza Stage',
    accent: 'gold',
    shape: { x: 641, y: -144, width: 183, height: 313 },
    labelAt: { x: 732, y: -190 },
    kind: 'stage',
  },
  {
    id: 'belvedere',
    label: 'The Belvedere',
    accent: 'gold',
    shape: { x: 1216, y: -9, width: 293, height: 150 },
    labelAt: { x: 1362, y: 262 },
    detail: 'Sohal Bar · Zenjoy · Movement Retail',
    kind: 'activation',
  },
  {
    id: 'drop-tv',
    label: 'Drop TV',
    accent: 'accent-2',
    shape: { x: 2541, y: -1, width: 212, height: 104 },
    labelAt: { x: 2647, y: 34 },
    detail: 'Activation Zone',
    kind: 'activation',
  },
];

const accentVar = (a) =>
  a === 'accent-2' ? 'var(--color-accent-2)' : a === 'gold' ? 'var(--color-gold)' : 'var(--color-accent)';

function Label({ x, y, size, fill, weight = 'font-semibold', children, halo = '#15130f' }) {
  return (
    <text
      x={x} y={y}
      textAnchor="middle" dominantBaseline="middle"
      className={`pointer-events-none ${weight}`}
      fontSize={size}
      fill={fill}
      style={{ paintOrder: 'stroke', stroke: halo, strokeWidth: size * 0.28 }}
    >
      {children}
    </text>
  );
}

export default function AreaMap({ selected, onSelect, counts = {} }) {
  return (
    <div>
      {/* The real footprint is about 2.65:1, so on a phone it scrolls sideways
          rather than shrinking the type past reading. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <svg
          viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}
          className="block bg-[#0d1a1f]"
          style={{ width: '100%', minWidth: 1100, aspectRatio: `${VIEW.width} / ${VIEW.height}` }}
          role="img"
          aria-label="Site map of the Creator Carnival at National Harbor"
        >
          <rect x={LAND.x} y={LAND.y} width={LAND.width} height={LAND.height} fill="#1b1815" />
          <rect x={WATER.x} y={WATER.y} width={WATER.width} height={WATER.height} fill="#0b3a45" />

          {STREETS.map((s) => (
            <rect key={s.id} x={s.x} y={s.y} width={s.width} height={s.height} fill="#3a332d" />
          ))}
          {AVENUE_BARS.map((b) => (
            <rect key={b.y} x={b.x} y={b.y} width={b.width} height={b.height} fill="#3a332d" />
          ))}

          {STRUCTURES.map((st) => (
            <g key={st.id}>
              <rect x={st.x} y={st.y} width={st.width} height={st.height} rx="10" fill="#2b2621" stroke="#413a32" strokeWidth="5" />
              {st.rotate ? (
                <text
                  x={st.x + st.width / 2} y={st.y + st.height / 2}
                  transform={`rotate(-90 ${st.x + st.width / 2} ${st.y + st.height / 2})`}
                  textAnchor="middle" dominantBaseline="middle"
                  className="pointer-events-none font-semibold" fontSize="34"
                  fill="rgba(255,255,255,.7)"
                >
                  {st.label}
                </text>
              ) : (
                <Label x={st.x + st.width / 2} y={st.y + st.height / 2} size={st.small ? 22 : 34} fill="rgba(255,255,255,.7)" halo="#2b2621">
                  {st.label}
                </Label>
              )}
            </g>
          ))}

          {/* Street names on top of the streets, after the structures so a
              building never covers the name of the road it sits on. */}
          {STREETS.map((s) => {
            const cx = s.x + s.width / 2;
            const cy = s.y + s.height / 2;
            return (
              <text
                key={`${s.id}-label`}
                x={cx} y={cy}
                transform={s.vertical ? `rotate(-90 ${cx} ${cy})` : undefined}
                textAnchor="middle" dominantBaseline="middle"
                className="pointer-events-none font-bold uppercase" fontSize="44"
                fill="rgba(255,255,255,.62)"
                style={{ letterSpacing: '.12em', paintOrder: 'stroke', stroke: '#3a332d', strokeWidth: 12 }}
              >
                {s.label}
              </text>
            );
          })}

          {/* Highlighted areas sit under the booths so a booth number is never
              washed out by the corridor tint over it. */}
          {MAP_AREAS.map((a) => {
            const color = accentVar(a.accent);
            const isSel = selected === a.id;
            return (
              <rect
                key={`${a.id}-fill`}
                x={a.shape.x} y={a.shape.y} width={a.shape.width} height={a.shape.height}
                rx="14"
                fill={color} fillOpacity={isSel ? 0.5 : 0.26}
                stroke={color} strokeWidth={isSel ? 11 : 6}
              />
            );
          })}

          {BOOTHS.map((b) => (
            <g key={b.n}>
              <rect x={b.x} y={b.y} width={BOOTH_SIZE.width} height={BOOTH_SIZE.height} rx="8" fill="#0c0a09" stroke="var(--color-accent)" strokeWidth="4" />
              <Label x={b.x + BOOTH_SIZE.width / 2} y={b.y + BOOTH_SIZE.height / 2} size={38} weight="font-black" fill="rgba(255,255,255,.9)" halo="#0c0a09">
                {b.n}
              </Label>
            </g>
          ))}

          {BELVEDERE_TENANTS.map((t) => (
            <g key={t.id}>
              {t.round
                ? <circle cx={t.x + t.width / 2} cy={t.y + t.height / 2} r={t.width / 2} fill="#0c0a09" stroke="var(--color-gold)" strokeWidth="4" />
                : <rect x={t.x} y={t.y} width={t.width} height={t.height} rx="6" fill="#0c0a09" stroke="var(--color-gold)" strokeWidth="4" />}
            </g>
          ))}

          {/* Tenant names are set beneath the Belvedere rather than inside it —
              three labels in a 293x150 box overlap into mush. */}
          <Label x={1362} y={200} size={30} fill="var(--color-gold)" halo="#0d1a1f">
            Sohal Bar · Zenjoy · Movement Retail
          </Label>

          {/* Hit areas and labels last, so nothing is drawn over a tap target. */}
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
                aria-label={`${a.label}${a.caption ? `, ${a.caption}` : ''}${a.detail ? `, ${a.detail}` : ''}${typeof n === 'number' ? `, ${n} exhibitors` : ''}`}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(isSel ? null : a.id); } }}
              >
                <rect
                  x={a.shape.x} y={a.shape.y} width={a.shape.width} height={a.shape.height}
                  fill="transparent"
                />
                <Label x={a.labelAt.x} y={a.labelAt.y} size={a.id === 'drop-tv' ? 38 : 52} weight="font-black" fill={color} halo="#0d1a1f">
                  {a.label}{typeof n === 'number' && n > 0 ? ` · ${n}` : ''}
                </Label>
                {a.caption && (
                  <Label x={a.labelAt.x} y={a.labelAt.y + 46} size={32} fill="rgba(255,255,255,.7)" halo="#0d1a1f">
                    {a.caption}
                  </Label>
                )}
                {a.detail && a.id === 'drop-tv' && (
                  <Label x={a.labelAt.x} y={a.labelAt.y + 38} size={26} fill="rgba(255,255,255,.75)" halo="#0d1a1f">
                    {a.detail}
                  </Label>
                )}
              </g>
            );
          })}

          <g transform={`translate(${VIEW.x + VIEW.width - 140}, ${VIEW.y + 130})`} aria-hidden>
            <path d="M0,-58 L26,36 L0,14 L-26,36 Z" fill="rgba(255,255,255,.6)" />
            <text x="0" y="92" textAnchor="middle" fontSize="46" className="font-bold" fill="rgba(255,255,255,.6)">N</text>
          </g>
        </svg>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Booth numbers are positions on the plan, not brand assignments — search the list below to find a brand.
        Scroll sideways for the full site.
      </p>
    </div>
  );
}
