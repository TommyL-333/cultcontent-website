import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Topbar from '../components/Topbar';
import AreaMap, { MAP_AREAS } from '../components/AreaMap';
import { getExhibitors } from '../api';

/**
 * Who's exhibiting, grouped by zone.
 *
 * Reads straight from the booth signups (ccc_booth_signups) rather than a
 * maintained list, so a vendor who reserves and pays appears here on their
 * own and the count tracks confirmations as they land through the week.
 *
 * The map above the list is area-level on purpose: booth_type is the finest
 * grain the signup data records, so plotting individual booths would mean
 * inventing and hand-maintaining an assignment nobody has. Tapping an area
 * filters the list; the list is the authoritative answer, the map is
 * orientation.
 */
export default function ExhibitorsScreen({ person }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [zoneFilter, setZoneFilter] = useState(null);

  useEffect(() => {
    getExhibitors().then((j) => (j.ok ? setData(j) : setError(true))).catch(() => setError(true));
  }, []);

  const results = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.exhibitors.filter((e) => {
      if (zoneFilter && e.zone !== zoneFilter) return false;
      if (!q) return true;
      return `${e.brand_name} ${e.category}`.toLowerCase().includes(q);
    });
  }, [data, query, zoneFilter]);

  // Drives the count badge on each area of the map.
  const countsByZone = useMemo(() => {
    const counts = {};
    (data?.exhibitors ?? []).forEach((e) => { counts[e.zone] = (counts[e.zone] || 0) + 1; });
    return counts;
  }, [data]);

  const selectedArea = MAP_AREAS.find((a) => a.id === zoneFilter);

  if (error) {
    return (
      <div>
        <Topbar person={person} />
        <div className="max-w-3xl mx-auto px-5 py-16 text-center text-sm text-muted-foreground">
          Couldn&rsquo;t load the exhibitor list. Refresh and try again.
        </div>
      </div>
    );
  }

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-3xl mx-auto px-5 pb-20">
        <span className="pill-glow pill-glow-gold mb-4 -rotate-2">National Harbor, MD</span>
        <h1 className="font-display text-3xl sm:text-4xl font-black tracking-tight leading-[0.95] mb-2">Exhibitors</h1>
        <p className="text-sm text-muted-foreground mb-5 leading-relaxed max-w-md">
          Brands confirmed on the floor. This updates as booths are confirmed, so check back through the week.
        </p>
        <div className="candy-stripe w-24 mb-7" aria-hidden />

        {!data ? (
          <div className="space-y-3">{[0, 1, 2, 3].map((i) => <div key={i} className="h-16 rounded-md border border-border bg-card animate-pulse" />)}</div>
        ) : (
          <>
            <AreaMap
              selected={zoneFilter}
              onSelect={(id) => setZoneFilter(id)}
              counts={countsByZone}
            />

            {/* The stage has no exhibitors — send people to the schedule
                instead of showing them an empty list. */}
            {selectedArea?.kind === 'stage' && (
              <div className="mt-4 rounded-md border border-border bg-card p-4">
                <div className="text-sm font-bold mb-1">Main Stage</div>
                <p className="text-[13px] text-foreground/80 leading-relaxed">
                  All the day&rsquo;s programming happens here, 10am to 5pm.
                </p>
                <RouterLink to="/schedule" className="inline-block mt-2.5 text-xs font-bold underline" style={{ color: 'var(--color-accent-2)' }}>
                  See the schedule &rarr;
                </RouterLink>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 mb-5 mt-6">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search exhibitors"
                className="flex-1 min-w-[200px] rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              <button
                type="button" onClick={() => setZoneFilter(null)}
                className={`rounded-lg px-3 py-2 text-xs font-bold ${zoneFilter === null ? 'bg-foreground text-background' : 'border border-border text-muted-foreground hover:text-foreground'}`}
              >
                All
              </button>
              {data.zones.map((z) => (
                <button
                  key={z.id} type="button"
                  onClick={() => setZoneFilter(zoneFilter === z.id ? null : z.id)}
                  className={`rounded-lg px-3 py-2 text-xs font-bold ${zoneFilter === z.id ? 'bg-foreground text-background' : 'border border-border text-muted-foreground hover:text-foreground'}`}
                >
                  {z.label}
                </button>
              ))}
            </div>

            <div className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground mb-3">
              {results.length} confirmed
            </div>

            {results.length === 0 ? (
              <div className="rounded-md border border-dashed border-border py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  {query || zoneFilter ? 'No exhibitors match that.' : 'No booths confirmed yet — check back soon.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border overflow-hidden">
                {results.map((e) => (
                  <li key={`${e.zone}-${e.brand_name}`} className="px-4 py-3.5">
                    <div className="text-sm font-bold">{e.brand_name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {e.category ? `${e.category} · ` : ''}{e.zone_label}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
