import { useEffect, useMemo, useState } from 'react';
import { Card } from '@heroui/react';
import Topbar from '../components/Topbar';
import HarborMap, { boothPins } from '../components/HarborMap';
import { getEvent } from '../api';

export default function MapScreen({ person }) {
  const [event, setEvent] = useState(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [zoneFilter, setZoneFilter] = useState(null);

  useEffect(() => { getEvent().then(setEvent).catch(() => setError(true)); }, []);

  const allBooths = useMemo(() => {
    if (!event) return [];
    return event.zones.flatMap((zone) =>
      boothPins(zone, event.overrides ?? {}).map((pin) => ({ ...pin, vendor: event.vendors?.[pin.id] ?? null })),
    );
  }, [event]);

  // A number typed on its own means "booth 47" — that's how someone reads a
  // booth sign — so match it exactly rather than as a substring, which would
  // otherwise surface 4, 47, 147 for the same query.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = allBooths;
    if (zoneFilter) list = list.filter((b) => b.zoneId === zoneFilter);
    if (!q) return list;
    if (/^\d+$/.test(q)) return list.filter((b) => String(b.number) === q);
    return list.filter((b) =>
      b.vendor?.name?.toLowerCase().includes(q) ||
      b.vendor?.category?.toLowerCase().includes(q) ||
      b.zoneLabel.toLowerCase().includes(q));
  }, [allBooths, query, zoneFilter]);

  const selectedBooth = allBooths.find((b) => b.id === selected) ?? null;

  if (error) {
    return (
      <div>
        <Topbar person={person} />
        <div className="max-w-3xl mx-auto px-5 py-16 text-center text-sm text-muted-foreground">
          Couldn&rsquo;t load the site map. Refresh and try again.
        </div>
      </div>
    );
  }

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-3xl mx-auto px-5 pb-20">
        <span className="pill-glow pill-glow-gold mb-4 -rotate-2">National Harbor, MD</span>
        <h1 className="font-display text-3xl sm:text-4xl font-black tracking-tight leading-[0.95] mb-2">Site Map</h1>
        <p className="text-sm text-muted-foreground mb-5 leading-relaxed max-w-md">
          Every booth is numbered. Tap a number on the map, or search for a brand.
        </p>
        <div className="candy-stripe w-24 mb-7" aria-hidden />

        {!event ? (
          <div className="rounded-md border border-border bg-card animate-pulse" style={{ aspectRatio: '1200 / 520' }} />
        ) : (
          <>
            <HarborMap event={event} selected={selected} onSelect={setSelected} highlightZone={zoneFilter} />

            {selectedBooth && (
              <Card variant="default" className="card-glow-red rounded-md p-5 mt-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground mb-1">
                      {selectedBooth.zoneLabel}
                    </div>
                    <div className="font-display text-2xl font-black tracking-tight">
                      Booth {selectedBooth.number}
                    </div>
                    <div className="text-sm mt-1.5">
                      {selectedBooth.vendor
                        ? <><span className="font-bold">{selectedBooth.vendor.name}</span>
                            {selectedBooth.vendor.category && <span className="text-muted-foreground"> — {selectedBooth.vendor.category}</span>}</>
                        : <span className="text-muted-foreground">Not yet assigned</span>}
                    </div>
                  </div>
                  <button type="button" onClick={() => setSelected(null)} className="text-xs text-muted-foreground hover:text-foreground shrink-0">
                    Close
                  </button>
                </div>
              </Card>
            )}

            <div className="flex flex-wrap items-center gap-2 mt-7 mb-4">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search a brand, or type a booth number"
                className="flex-1 min-w-[220px] rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setZoneFilter(null)}
                className={`rounded-lg px-3 py-2 text-xs font-bold ${zoneFilter === null ? 'bg-foreground text-background' : 'border border-border text-muted-foreground hover:text-foreground'}`}
              >
                All
              </button>
              {event.zones.map((z) => (
                <button
                  key={z.id}
                  type="button"
                  onClick={() => setZoneFilter(zoneFilter === z.id ? null : z.id)}
                  className={`rounded-lg px-3 py-2 text-xs font-bold ${zoneFilter === z.id ? 'bg-foreground text-background' : 'border border-border text-muted-foreground hover:text-foreground'}`}
                >
                  {z.label}
                </button>
              ))}
            </div>

            <div className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground mb-3">
              {results.length} {results.length === 1 ? 'booth' : 'booths'}
            </div>

            <ul className="divide-y divide-border rounded-md border border-border overflow-hidden">
              {results.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(b.id)}
                    className={`w-full flex items-center gap-3.5 px-4 py-3 text-left hover:bg-white/[.03] ${selected === b.id ? 'bg-white/[.05]' : ''}`}
                  >
                    <span
                      className="shrink-0 w-9 h-7 rounded-[3px] border grid place-items-center text-[11px] font-bold tabular-nums"
                      style={{ borderColor: b.zoneId === 'capitol-canopy' ? 'var(--color-accent-2)' : 'var(--color-accent)' }}
                    >
                      {b.number}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold truncate">
                        {b.vendor?.name ?? <span className="text-muted-foreground font-normal">Unassigned</span>}
                      </span>
                      <span className="block text-xs text-muted-foreground truncate">
                        {b.vendor?.category ? `${b.vendor.category} · ${b.zoneLabel}` : b.zoneLabel}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {results.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-muted-foreground">No booths match that.</li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
