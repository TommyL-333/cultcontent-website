import { useMemo, useState } from 'react';

/**
 * Schematic site map of the Creator Carnival footprint at National Harbor.
 *
 * Deliberately NOT a real map tile or a traced satellite image — it takes the
 * *shape* of the harbor (the waterfront edge, the marina, the diagonal street
 * grid) and drops everything else, so the only text on it is what someone
 * standing there actually needs: two street names, the stage, the hotel, and
 * a booth number. See DESIGN.md — this is round 2 (festival), not a
 * transit-map register.
 *
 * All positions live in /ccc-event.json. Nothing here is hard-coded except
 * the coastline and building blocks, which are fixed geography.
 */

const VIEW = { w: 1200, h: 520 };

// ─── Fixed geography, traced for silhouette only ────────────────────────────────
const WATER = 'M0,0 L300,0 L258,88 L325,145 L292,205 L352,248 L408,338 L432,430 L418,520 L0,520 Z';

const PIERS = [
  { x: 24, y: 214, w: 118, h: 7 },
  { x: 18, y: 262, w: 104, h: 7 },
  { x: 30, y: 312, w: 122, h: 7 },
  { x: 44, y: 364, w: 96, h: 7 },
];

// The floating pavilion off the boardwalk — a distinctive silhouette people
// navigate by, so it stays even though it is not labelled.
const PAVILION = 'M158,150 L262,132 L276,206 L172,224 Z';

// City blocks, drawn to the same diagonal grain as the streets.
const BLOCKS = [
  'M556,404 L636,392 L706,116 L628,128 Z',
  'M760,404 L1136,332 L1160,404 L784,470 Z',
  'M762,150 L1004,88 L1030,168 L788,232 Z',
  'M470,470 L560,452 L588,520 L494,520 Z',
];

function lerp(a, b, t) { return a + (b - a) * t; }

// Booth pins are computed from a zone's `layout` strip rather than stored one
// by one: moving a whole vendor run is a two-coordinate edit in the JSON,
// and `overrides` still lets a single awkward booth be nudged by hand.
export function boothPins(zone, overrides = {}) {
  const { from, to, rows, rowGap, count } = zone.layout;
  const [x1, y1] = from;
  const [x2, y2] = to;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const px = -uy; // unit perpendicular — offsets booths to either side of the aisle
  const py = ux;
  const perRow = Math.ceil(count / rows);

  const pins = [];
  for (let i = 0; i < count; i += 1) {
    const row = i % rows;                       // odds one side, evens the other
    const along = Math.floor(i / rows);
    const t = perRow > 1 ? along / (perRow - 1) : 0.5;
    const offset = (row - (rows - 1) / 2) * rowGap;
    const number = i + 1;
    const o = overrides[`${zone.id}-${number}`];
    pins.push({
      id: `${zone.id}-${number}`,
      number,
      zoneId: zone.id,
      zoneLabel: zone.label,
      x: o?.x ?? lerp(x1, x2, t) + px * offset,
      y: o?.y ?? lerp(y1, y2, t) + py * offset,
    });
  }
  return pins;
}

function StreetLabel({ street }) {
  const [x1, y1] = street.from;
  const [x2, y2] = street.to;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  let angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  if (angle < -90) angle += 180;
  if (angle > 90) angle -= 180;
  return (
    <text
      x={mx} y={my} transform={`rotate(${angle} ${mx} ${my})`}
      textAnchor="middle" dominantBaseline="middle"
      className="text-[11px] font-bold uppercase"
      fill="rgba(255,255,255,.62)"
      style={{ letterSpacing: '.14em', paintOrder: 'stroke', stroke: '#12100e', strokeWidth: 3 }}
    >
      {street.label}
    </text>
  );
}

export default function HarborMap({ event, selected, onSelect, highlightZone }) {
  const [zoom, setZoom] = useState(1);

  const zones = event?.zones ?? [];
  const pinsByZone = useMemo(
    () => zones.map((z) => ({ zone: z, pins: boothPins(z, event?.overrides ?? {}) })),
    [zones, event],
  );

  // Zooming re-centres on the selected booth when there is one, so tapping a
  // pin and then zooming in keeps it under your thumb instead of drifting off.
  const focus = selected
    ? pinsByZone.flatMap((g) => g.pins).find((p) => p.id === selected)
    : null;
  const cx = focus ? focus.x : VIEW.w / 2;
  const cy = focus ? focus.y : VIEW.h / 2;
  const vw = VIEW.w / zoom;
  const vh = VIEW.h / zoom;
  const vx = Math.max(0, Math.min(VIEW.w - vw, cx - vw / 2));
  const vy = Math.max(0, Math.min(VIEW.h - vh, cy - vh / 2));

  const accentVar = (a) => (a === 'accent-2' ? 'var(--color-accent-2)' : 'var(--color-accent)');

  return (
    <div className="relative">
      <svg
        viewBox={`${vx} ${vy} ${vw} ${vh}`}
        className="w-full rounded-md border border-border bg-[#0b1418] touch-manipulation"
        style={{ aspectRatio: `${VIEW.w} / ${VIEW.h}` }}
        role="img"
        aria-label="Site map of the Creator Carnival footprint at National Harbor"
      >
        <defs>
          <pattern id="ripple" width="18" height="18" patternUnits="userSpaceOnUse">
            <path d="M0,9 q4.5,-4 9,0 t9,0" fill="none" stroke="rgba(0,242,234,.16)" strokeWidth="1" />
          </pattern>
        </defs>

        <rect x="0" y="0" width={VIEW.w} height={VIEW.h} fill="#12100e" />
        <path d={WATER} fill="#07272c" />
        <path d={WATER} fill="url(#ripple)" />

        {PIERS.map((p) => (
          <rect key={`${p.x}-${p.y}`} {...p} rx="3" fill="#4a3a2c" />
        ))}
        {/* The waterfront pavilion, drawn with its ridge line so it reads as a
            tent rather than as a stray grey rectangle. */}
        <g opacity=".9">
          <path d={PAVILION} fill="#d8d2c8" />
          <path d="M158,150 L262,132 M172,224 L276,206 M165,187 L269,169" stroke="#a8a096" strokeWidth="1.2" fill="none" />
        </g>

        {BLOCKS.map((d) => (
          <path key={d} d={d} fill="#1c1917" stroke="#2c2724" strokeWidth="1.5" />
        ))}

        {/* Streets: a wide dark casing under a light centre reads as a road
            at any zoom without needing separate styling per level. */}
        {(event?.streets ?? []).map((s) => (
          <line
            key={s.id}
            x1={s.from[0]} y1={s.from[1]} x2={s.to[0]} y2={s.to[1]}
            stroke="#37302b" strokeWidth="26" strokeLinecap="round"
          />
        ))}
        {/* Vendor runs — a tinted strip behind the pins so a zone reads as one
            block of the event even when the individual numbers are too small. */}
        {pinsByZone.map(({ zone }) => {
          const dim = highlightZone && highlightZone !== zone.id;
          return (
            <line
              key={`strip-${zone.id}`}
              x1={zone.layout.from[0]} y1={zone.layout.from[1]}
              x2={zone.layout.to[0]} y2={zone.layout.to[1]}
              stroke={accentVar(zone.accent)}
              strokeWidth={zone.layout.rowGap * (zone.layout.rows - 1) + 20}
              strokeLinecap="round"
              opacity={dim ? 0.05 : 0.13}
            />
          );
        })}

        {(event?.streets ?? []).map((s) => (
          <StreetLabel key={`${s.id}-label`} street={s} />
        ))}

        {pinsByZone.map(({ zone, pins }) => {
          const dim = highlightZone && highlightZone !== zone.id;
          return (
            <g key={zone.id} opacity={dim ? 0.25 : 1}>
              {pins.map((p) => {
                const isSel = p.id === selected;
                return (
                  <g
                    key={p.id}
                    onClick={() => onSelect?.(isSel ? null : p.id)}
                    className="cursor-pointer"
                    role="button"
                    tabIndex={0}
                    aria-label={`Booth ${p.number}, ${zone.label}`}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(isSel ? null : p.id); } }}
                  >
                    <rect
                      x={p.x - 8} y={p.y - 5} width="16" height="10" rx="2"
                      fill={isSel ? accentVar(zone.accent) : '#0c0a09'}
                      stroke={accentVar(zone.accent)}
                      strokeWidth={isSel ? 2 : 1.2}
                    />
                    <text
                      x={p.x} y={p.y + 0.5}
                      textAnchor="middle" dominantBaseline="middle"
                      className="pointer-events-none text-[7px] font-bold tabular-nums"
                      fill={isSel ? '#0c0a09' : 'rgba(255,255,255,.72)'}
                    >
                      {p.number}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}

        {(event?.landmarks ?? []).map((l) => (
          <g key={l.id}>
            <circle cx={l.x} cy={l.y} r="7" fill="var(--color-gold)" />
            <circle cx={l.x} cy={l.y} r="12" fill="none" stroke="var(--color-gold)" strokeWidth="1" opacity=".45" />
            <text
              x={l.x + (l.labelSide === 'left' ? -17 : 17)} y={l.y + 1}
              textAnchor={l.labelSide === 'left' ? 'end' : 'start'}
              dominantBaseline="middle"
              className="text-[12px] font-black"
              fill="var(--color-gold)"
              style={{ paintOrder: 'stroke', stroke: '#12100e', strokeWidth: 3.5 }}
            >
              {l.label}
            </text>
          </g>
        ))}
      </svg>

      <div className="absolute right-3 top-3 flex flex-col gap-1.5">
        {[['+', () => setZoom((z) => Math.min(4, z * 1.5))], ['−', () => setZoom((z) => Math.max(1, z / 1.5))]].map(([sym, fn]) => (
          <button
            key={sym} type="button" onClick={fn}
            className="h-8 w-8 rounded-md border border-border bg-card/90 text-sm font-black text-foreground backdrop-blur hover:border-primary"
            aria-label={sym === '+' ? 'Zoom in' : 'Zoom out'}
          >
            {sym}
          </button>
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {(event?.zones ?? []).map((z) => (
          <span key={z.id} className="inline-flex items-center gap-1.5 text-[11px] font-bold">
            <span
              className="h-2.5 w-2.5 rounded-[2px]"
              style={{ background: z.accent === 'accent-2' ? 'var(--color-accent-2)' : 'var(--color-accent)' }}
              aria-hidden
            />
            {z.label}
            <span className="font-normal text-muted-foreground">{z.layout.count} booths</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--color-gold)' }} aria-hidden />
          Landmark
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {event?.event?.mapNote}
      </p>
    </div>
  );
}
