import { useEffect, useMemo, useState } from 'react';
import Topbar from '../components/Topbar';
import { getEvent } from '../api';

// Times in ccc-event.json are wall-clock at the venue. Formatting them with a
// fixed timeZone rather than the device's keeps the printed schedule identical
// for a creator flying in from LA and a brand rep already in DC — a schedule
// that silently shifts by three hours is worse than no schedule.
function formatTime(hhmm, timeZone) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(Date.UTC(2026, 8, 12, h, m));
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  }).format(d).replace(':00', '');
}

const TRACK_STYLE = {
  access:      { label: 'Access',      color: 'var(--color-accent)' },
  marketplace: { label: 'Marketplace', color: 'var(--color-accent-2)' },
  stage:       { label: 'Main Stage',  color: 'var(--color-gold)' },
  vip:         { label: 'VIP',         color: 'var(--color-gold)' },
};

export default function ScheduleScreen({ person }) {
  const [event, setEvent] = useState(null);
  const [error, setError] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);

  useEffect(() => { getEvent().then(setEvent).catch(() => setError(true)); }, []);

  const items = useMemo(() => {
    if (!event) return [];
    const list = [...event.schedule].sort((a, b) => a.start.localeCompare(b.start));
    if (!mineOnly) return list;
    return list.filter((s) => !s.audience || s.audience.includes(person.role));
  }, [event, mineOnly, person.role]);

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
        <p className="text-sm text-muted-foreground mb-5 leading-relaxed max-w-md">
          How the day runs, gate to after-party. All times Eastern.
        </p>
        <div className="candy-stripe w-24 mb-6" aria-hidden />

        <label className="inline-flex items-center gap-2.5 mb-7 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(e) => setMineOnly(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          <span className="text-xs font-bold uppercase tracking-[.1em] text-muted-foreground">
            Only what applies to me
          </span>
        </label>

        {!event ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-md border border-border bg-card animate-pulse" />)}
          </div>
        ) : (
          <ol className="relative">
            {/* The spine is decorative; each row carries its own time so the
                list still reads correctly with images or CSS off. */}
            <span className="absolute left-[62px] top-2 bottom-2 w-px bg-border" aria-hidden />
            {items.map((s, i) => {
              const track = TRACK_STYLE[s.track] ?? TRACK_STYLE.access;
              const start = formatTime(s.start, event.event.timezone);
              const end = formatTime(s.end, event.event.timezone);
              return (
                <li key={s.id} className="relative flex gap-4 pb-5">
                  <div className="w-[54px] shrink-0 pt-3 text-right">
                    <div className="font-display text-[15px] font-black tabular-nums leading-none">{start}</div>
                    {end && <div className="text-[10px] text-muted-foreground tabular-nums mt-1">to {end}</div>}
                  </div>

                  <span
                    className="absolute left-[57px] top-[18px] h-[11px] w-[11px] rounded-full border-2"
                    style={{ background: 'var(--color-background, #0c0a09)', borderColor: track.color }}
                    aria-hidden
                  />

                  <div className={`flex-1 rounded-md border border-border bg-card p-4 ${i % 3 === 1 ? 'rotate-[0.25deg]' : ''}`}>
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <span
                        className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.1em]"
                        style={{ color: track.color, border: `1px solid ${track.color}`, opacity: 0.9 }}
                      >
                        {track.label}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{s.location}</span>
                    </div>
                    <h2 className="font-display text-lg font-black tracking-tight leading-tight mb-1.5">{s.title}</h2>
                    <p className="text-[13px] text-foreground/80 leading-relaxed">{s.description}</p>
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
