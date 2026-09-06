import { useEffect, useMemo, useState } from 'react';
import Topbar from '../components/Topbar';
import { getEvent } from '../api';

// Times in ccc-event.json are wall-clock at the venue. Formatting them with a
// fixed zone rather than the device's keeps the printed schedule identical for
// a creator flying in from LA and a brand rep already in DC — a schedule that
// silently shifts by three hours is worse than no schedule.
function formatTime(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(Date.UTC(2026, 8, 12, h, m));
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    .format(d)
    .replace(':00', '');
}

// The run of show's own arc: MOVE → CONNECT → CULTURE → BELIEVE → BUILD →
// CARNIVAL → OPPORTUNITY → UNSKRYPTED → WHAT'S NEXT → CELEBRATE. Colours only;
// the chip text comes from the data, so a new segment needs no code change.
const SEGMENT_COLORS = {
  Move: 'var(--color-accent-2)',
  Connect: 'var(--color-accent-2)',
  Culture: 'var(--color-gold)',
  Kickoff: 'var(--color-accent)',
  Believe: 'var(--color-accent)',
  Build: 'var(--color-accent)',
  Carnival: 'var(--color-gold)',
  Opportunity: 'var(--color-accent-2)',
  Unskrypted: 'var(--color-accent-2)',
  Celebration: 'var(--color-gold)',
};
const colorFor = (segment) => SEGMENT_COLORS[segment] ?? 'var(--color-gold)';

export default function ScheduleScreen({ person }) {
  const [event, setEvent] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => { getEvent().then(setEvent).catch(() => setError(true)); }, []);

  const items = useMemo(
    () => (event ? [...event.schedule].sort((a, b) => a.start.localeCompare(b.start)) : []),
    [event],
  );

  if (error) {
    return (
      <div>
        <Topbar person={person} />
        <div className="max-w-3xl mx-auto px-5 py-16 text-center text-sm text-muted-foreground">
          Couldn&rsquo;t load the schedule. Refresh and try again.
        </div>
      </div>
    );
  }

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-3xl mx-auto px-5 pb-20">
        <span className="pill-glow pill-glow-cyan mb-4 -rotate-2">Saturday, September 12</span>
        <h1 className="font-display text-3xl sm:text-4xl font-black tracking-tight leading-[0.95] mb-2">Schedule</h1>
        {event && (
          <p className="text-sm text-muted-foreground mb-1.5 leading-relaxed max-w-md">
            {event.event.doors} · {event.event.venue}. All times Eastern.
          </p>
        )}
        {event?.event?.host && (
          <p className="text-sm text-muted-foreground mb-1.5">
            Hosted by <span className="font-bold text-foreground">{event.event.host}</span>
          </p>
        )}
        {event?.event?.note && (
          <p className="text-[13px] text-foreground/70 mb-5 leading-relaxed max-w-md">{event.event.note}</p>
        )}
        <div className="candy-stripe w-24 mb-8" aria-hidden />

        {!event ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-md border border-border bg-card animate-pulse" />)}
          </div>
        ) : (
          <ol className="relative">
            {/* The spine is decorative; every row carries its own time so the
                list still reads correctly with images or CSS off. */}
            <span className="absolute left-[62px] top-2 bottom-2 w-px bg-border" aria-hidden />
            {items.map((s, i) => {
              const color = colorFor(s.segment);
              return (
                <li key={s.id} className="relative flex gap-4 pb-5">
                  <div className="w-[54px] shrink-0 pt-3 text-right">
                    <div className="font-display text-[15px] font-black tabular-nums leading-none">{formatTime(s.start)}</div>
                    {s.end && <div className="text-[10px] text-muted-foreground tabular-nums mt-1">to {formatTime(s.end)}</div>}
                  </div>

                  <span
                    className="absolute left-[57px] top-[18px] h-[11px] w-[11px] rounded-full border-2"
                    style={{ background: 'var(--color-background, #0c0a09)', borderColor: color }}
                    aria-hidden
                  />

                  <div className={`flex-1 rounded-md border border-border bg-card p-4 ${i % 3 === 1 ? 'rotate-[0.25deg]' : ''}`}>
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <span
                        className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.1em]"
                        style={{ color, border: `1px solid ${color}`, opacity: 0.9 }}
                      >
                        {s.segment}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{s.location}</span>
                    </div>

                    <h2 className="font-display text-lg font-black tracking-tight leading-tight">{s.title}</h2>
                    {s.subtitle && (
                      <p className="text-[12px] text-muted-foreground italic leading-snug mt-0.5 mb-1.5">{s.subtitle}</p>
                    )}

                    <p className="text-[13px] text-foreground/80 leading-relaxed mt-1.5">{s.description}</p>

                    {s.people?.length > 0 && (
                      <ul className="flex flex-wrap gap-1.5 mt-3">
                        {s.people.map((p) => (
                          <li key={p} className="rounded-md border border-border bg-background/50 px-2 py-1 text-[11px] font-semibold">
                            {p}
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* Says so plainly rather than quietly listing a partial
                        lineup as if it were the whole thing. */}
                    {s.lineup_tbc && (
                      <p className="text-[11px] text-muted-foreground mt-2.5">
                        {s.people?.length ? 'More guests to be announced.' : 'Lineup to be announced.'}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
