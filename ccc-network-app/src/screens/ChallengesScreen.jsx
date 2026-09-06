import { useCallback, useEffect, useState } from 'react';
import { Card } from '@heroui/react';
import { toast } from 'sonner';
import Topbar from '../components/Topbar';
import {
  getChallenges, createChallenge, setChallengeStatus,
  enterChallenge, removeChallengeLink, withdrawFromChallenge,
  getChallengeEntries, reviewChallengeEntry, setChallengeEntryPaid,
} from '../api';

const ERRORS = {
  bad_url: 'That doesn’t look like a link. Paste the full URL to your post.',
  duplicate_link: 'You’ve already submitted that link.',
  too_many_links: 'That’s the maximum number of links for one entry.',
  closed: 'This challenge has closed.',
  creators_only: 'Only creators can enter challenges.',
  brands_only: 'Only brands can post challenges.',
  title_required: 'Give the challenge a title.',
  too_many_open: 'You already have the maximum number of open challenges. Close one first.',
  not_found: 'That challenge no longer exists.',
  not_yours: 'That isn’t your challenge.',
  bad_status: 'Unknown review status.',
};
const explain = (e) => ERRORS[e] ?? 'Something went wrong. Try again.';

const STATUS_STYLE = {
  submitted: { label: 'Submitted', color: 'var(--color-muted-foreground)' },
  accepted: { label: 'Accepted', color: 'var(--color-accent-2)' },
  winner: { label: 'Winner', color: 'var(--color-gold)' },
  rejected: { label: 'Not selected', color: 'var(--color-muted-foreground)' },
};

function StatusChip({ status }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.submitted;
  return (
    <span
      className="shrink-0 rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[.1em]"
      style={{ color: s.color, border: `1px solid ${s.color}` }}
    >
      {s.label}
    </span>
  );
}

function BrandCreateForm({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', reward: '', deadline: '', deliverables: 1, reward_model: 'completion' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const r = await createChallenge(form);
    setBusy(false);
    if (!r.ok) return toast.error(explain(r.error));
    toast.success('Challenge posted.');
    setForm({ title: '', description: '', reward: '', deadline: '', deliverables: 1, reward_model: 'completion' });
    setOpen(false);
    onCreated();
  }

  if (!open) {
    return (
      <button
        type="button" onClick={() => setOpen(true)}
        className="w-full rounded-md border border-dashed border-border py-4 text-sm font-bold text-muted-foreground hover:border-primary hover:text-foreground mb-6"
      >
        + Post a challenge
      </button>
    );
  }

  return (
    <Card variant="default" className="card-glow-cyan rounded-md p-5 mb-6">
      <form onSubmit={submit} className="space-y-3">
        <input required value={form.title} onChange={set('title')} placeholder="Challenge title *" className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none" />
        <textarea value={form.description} onChange={set('description')} rows={3} placeholder="What should creators actually make?" className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none resize-y" />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input value={form.reward} onChange={set('reward')} placeholder="Reward (e.g. $30)" className="rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none" />
          <input value={form.deadline} onChange={set('deadline')} type="date" className="rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-muted-foreground focus:border-primary focus:outline-none" />
        </div>

        {/* Deliverable count is structured rather than buried in the
            description, so creators see progress and you can tell at a glance
            who actually finished. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground mb-1.5">How many posts?</span>
            <input
              type="number" min="1" max="10" value={form.deliverables}
              onChange={(e) => setForm((f) => ({ ...f, deliverables: e.target.value }))}
              className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground mb-1.5">Who gets paid?</span>
            <select
              value={form.reward_model}
              onChange={(e) => setForm((f) => ({ ...f, reward_model: e.target.value }))}
              className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none"
            >
              <option value="completion">Everyone who completes it</option>
              <option value="winners">Winners I pick</option>
            </select>
          </label>
        </div>

        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy} className="rounded-lg px-5 py-2.5 text-sm font-extrabold disabled:opacity-50" style={{ background: 'var(--color-accent-2)', color: 'var(--color-accent-2-foreground)' }}>
            {busy ? 'Posting…' : 'Post challenge'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-4 py-2.5 text-sm font-bold text-muted-foreground hover:text-foreground">Cancel</button>
        </div>
      </form>
    </Card>
  );
}

// A creator's own submission: every link they've added, progress against the
// brief, and the brand's verdict once it lands.
function MySubmission({ challenge, onDone }) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const entry = challenge.my_entry;
  const links = entry?.links ?? [];
  const needed = challenge.deliverables || 1;
  const done = Math.min(links.length, needed);
  const reviewed = entry && entry.status !== 'submitted';

  async function add(e) {
    e.preventDefault();
    setBusy(true);
    const r = await enterChallenge(challenge.uuid, { url, note });
    setBusy(false);
    if (!r.ok) return toast.error(explain(r.error));
    setUrl(''); setNote('');
    toast.success('Link added.');
    onDone();
  }

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <span className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">
          Your submission
        </span>
        <span className="text-[11px] font-bold tabular-nums" style={{ color: done >= needed ? 'var(--color-accent-2)' : 'var(--color-muted-foreground)' }}>
          {done} of {needed} {needed === 1 ? 'post' : 'posts'}
        </span>
      </div>

      {/* Progress against the brief — the number a creator actually cares
          about when a brief asks for three videos. */}
      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden mb-3.5" role="presentation">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${(done / needed) * 100}%`, background: done >= needed ? 'var(--color-accent-2)' : 'var(--color-accent)' }}
        />
      </div>

      {links.length > 0 && (
        <ul className="space-y-1.5 mb-3">
          {links.map((l, i) => (
            <li key={l.id} className="flex items-center gap-2.5 text-[13px]">
              <span className="shrink-0 text-[10px] font-bold tabular-nums text-muted-foreground w-4">{i + 1}</span>
              <a href={l.url} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate underline" style={{ color: 'var(--color-accent-2)' }}>
                {l.url}
              </a>
              {!reviewed && (
                <button
                  type="button"
                  onClick={async () => { await removeChallengeLink(challenge.uuid, l.id); toast('Link removed.'); onDone(); }}
                  className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                  aria-label={`Remove link ${i + 1}`}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {reviewed ? (
        <div className="rounded-md border border-border bg-background/40 px-3.5 py-3">
          <div className="flex items-center gap-2.5 mb-1">
            <StatusChip status={entry.status} />
            {entry.paid_at && (
              <span className="text-[10px] font-bold uppercase tracking-[.1em]" style={{ color: 'var(--color-accent-2)' }}>Paid</span>
            )}
          </div>
          {entry.brand_note && <p className="text-[13px] text-foreground/80 leading-relaxed mt-1.5">“{entry.brand_note}”</p>}
        </div>
      ) : (
        <form onSubmit={add} className="space-y-2.5">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              required value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://tiktok.com/@you/video/…"
              className="flex-1 rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none"
            />
            <button type="submit" disabled={busy} className="rounded-lg px-4 py-2.5 text-sm font-extrabold shrink-0 disabled:opacity-50" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}>
              {busy ? '…' : links.length ? 'Add another' : 'Submit'}
            </button>
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note to the brand" className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-xs focus:border-primary focus:outline-none" />
          {links.length > 0 && (
            <button
              type="button"
              onClick={async () => { await withdrawFromChallenge(challenge.uuid); toast('Entry withdrawn.'); onDone(); }}
              className="text-[11px] text-muted-foreground hover:text-foreground underline"
            >
              Withdraw my whole entry
            </button>
          )}
        </form>
      )}
    </div>
  );
}

function ReviewRow({ challenge, entry, onChanged }) {
  const [note, setNote] = useState(entry.brand_note || '');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isWinnerModel = challenge.reward_model === 'winners';

  async function review(status) {
    setBusy(true);
    const r = await reviewChallengeEntry(challenge.uuid, entry.uuid, { status, brand_note: note });
    setBusy(false);
    if (!r.ok) return toast.error(explain(r.error));
    toast.success('Reviewed — the creator has been emailed.');
    onChanged();
  }

  return (
    <li className="rounded-md border border-border bg-background/40 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-bold truncate">{entry.first_name} {entry.last_name}</div>
          {entry.tiktok_handle && <div className="text-[11px] text-muted-foreground truncate">@{entry.tiktok_handle.replace(/^@/, '')}</div>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {entry.paid_at && <span className="text-[10px] font-bold uppercase tracking-[.1em]" style={{ color: 'var(--color-accent-2)' }}>Paid</span>}
          <StatusChip status={entry.status} />
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2 text-[11px]">
        <span className="font-bold tabular-nums" style={{ color: entry.complete ? 'var(--color-accent-2)' : 'var(--color-accent)' }}>
          {entry.links.length} of {challenge.deliverables}
        </span>
        <span className="text-muted-foreground">{entry.complete ? 'complete' : 'incomplete'}</span>
      </div>

      <ul className="mt-2 space-y-1">
        {entry.links.map((l, i) => (
          <li key={l.id} className="flex items-center gap-2 text-[12px]">
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground w-3">{i + 1}</span>
            <a href={l.url} target="_blank" rel="noreferrer noopener" className="truncate underline" style={{ color: 'var(--color-accent-2)' }}>{l.url}</a>
          </li>
        ))}
      </ul>
      {entry.note && <p className="text-[12px] text-foreground/70 mt-1.5">“{entry.note}”</p>}

      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="mt-3 text-xs font-bold underline" style={{ color: 'var(--color-accent-2)' }}>
          Review &rarr;
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <input
            value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note back to them"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus:border-primary focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => review(isWinnerModel ? 'winner' : 'accepted')} className="rounded-lg px-3.5 py-2 text-xs font-extrabold disabled:opacity-50" style={{ background: 'var(--color-accent-2)', color: 'var(--color-accent-2-foreground)' }}>
              {isWinnerModel ? 'Pick as winner' : 'Accept'}
            </button>
            <button type="button" disabled={busy} onClick={() => review('rejected')} className="rounded-lg border border-border px-3.5 py-2 text-xs font-bold text-muted-foreground hover:text-foreground disabled:opacity-50">
              Not this one
            </button>
            <button
              type="button" disabled={busy}
              onClick={async () => { await setChallengeEntryPaid(challenge.uuid, entry.uuid, !entry.paid_at); onChanged(); }}
              className="rounded-lg border border-border px-3.5 py-2 text-xs font-bold text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {entry.paid_at ? 'Mark unpaid' : 'Mark paid'}
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Accepting or passing emails the creator. &ldquo;Paid&rdquo; is just a record — no money moves through the app.
          </p>
        </div>
      )}
    </li>
  );
}

function EntryList({ challenge, onChanged }) {
  const [state, setState] = useState({ loading: true, entries: [] });

  const load = useCallback(() => {
    getChallengeEntries(challenge.uuid).then((r) => setState({ loading: false, entries: r.ok ? r.entries : [] }));
  }, [challenge.uuid]);
  useEffect(() => { load(); }, [load]);

  if (state.loading) return <p className="mt-4 pt-4 border-t border-border text-xs text-muted-foreground">Loading entries…</p>;
  if (!state.entries.length) return <p className="mt-4 pt-4 border-t border-border text-xs text-muted-foreground">No entries yet.</p>;

  const complete = state.entries.filter((e) => e.complete).length;

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground mb-2.5">
        {state.entries.length} {state.entries.length === 1 ? 'entry' : 'entries'} · {complete} complete
      </div>
      <ul className="space-y-2.5">
        {state.entries.map((e) => (
          <ReviewRow
            key={e.uuid} challenge={challenge} entry={e}
            onChanged={() => { load(); onChanged(); }}
          />
        ))}
      </ul>
    </div>
  );
}

export default function ChallengesScreen({ person }) {
  const [challenges, setChallenges] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const isBrand = person.role === 'brand';

  const load = useCallback(() => {
    getChallenges().then((r) => setChallenges(r.ok ? r.challenges : []));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-3xl mx-auto px-5 pb-20">
        <span className="pill-glow pill-glow-red mb-4 -rotate-2">Briefs &amp; bounties</span>
        <h1 className="font-display text-3xl sm:text-4xl font-black tracking-tight leading-[0.95] mb-2">Challenges</h1>
        <p className="text-sm text-muted-foreground mb-5 leading-relaxed max-w-md">
          {isBrand
            ? 'Post a brief, say how many posts it takes, and review every entry in one place.'
            : 'Briefs from brands at the Carnival. Make the posts, paste the links, get on their radar.'}
        </p>
        <div className="candy-stripe w-24 mb-7" aria-hidden />

        {isBrand && <BrandCreateForm onCreated={load} />}

        {challenges === null ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-32 rounded-md border border-border bg-card animate-pulse" />)}</div>
        ) : challenges.length === 0 ? (
          <p className="text-sm text-muted-foreground py-10 text-center">
            No challenges posted yet.{isBrand ? ' Be the first.' : ' Check back closer to the event.'}
          </p>
        ) : (
          <div className="space-y-3.5">
            {challenges.map((c) => {
              const owned = isBrand && c.brand_uuid === person.uuid;
              const isOpen = c.status === 'open';
              return (
                <Card key={c.uuid} variant="default" className={`rounded-md p-5 ${isOpen ? 'card-glow-red' : 'opacity-70'}`}>
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground mb-1">
                        {c.brand_name || `${c.first_name} ${c.last_name}`}
                      </div>
                      <h2 className="font-display text-xl font-black tracking-tight leading-tight">{c.title}</h2>
                    </div>
                    <span
                      className="shrink-0 rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[.1em]"
                      style={isOpen
                        ? { color: 'var(--color-accent-2)', border: '1px solid var(--color-accent-2)' }
                        : { color: 'var(--color-muted-foreground)', border: '1px solid var(--color-border)' }}
                    >
                      {isOpen ? 'Open' : 'Closed'}
                    </span>
                  </div>

                  {c.description && <p className="text-[13px] text-foreground/80 leading-relaxed mb-3">{c.description}</p>}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
                    <span><span className="opacity-60">Wants</span> <span className="font-bold text-foreground">{c.deliverables} {c.deliverables === 1 ? 'post' : 'posts'}</span></span>
                    {c.reward && <span><span className="opacity-60">Reward</span> <span className="font-bold text-foreground">{c.reward}</span></span>}
                    <span className="opacity-60">{c.reward_model === 'winners' ? 'Winners picked' : 'Everyone who completes'}</span>
                    {c.deadline && <span><span className="opacity-60">By</span> <span className="font-bold text-foreground">{c.deadline}</span></span>}
                    <span><span className="font-bold text-foreground">{c.entry_count}</span> {c.entry_count === 1 ? 'entry' : 'entries'}</span>
                  </div>

                  {!isBrand && isOpen && <MySubmission challenge={c} onDone={load} />}
                  {!isBrand && !isOpen && c.my_entry && (
                    <div className="mt-4 pt-4 border-t border-border flex items-center gap-2.5">
                      <StatusChip status={c.my_entry.status} />
                      {c.my_entry.paid_at && <span className="text-[10px] font-bold uppercase tracking-[.1em]" style={{ color: 'var(--color-accent-2)' }}>Paid</span>}
                      {c.my_entry.brand_note && <span className="text-[12px] text-foreground/70">“{c.my_entry.brand_note}”</span>}
                    </div>
                  )}

                  {owned && (
                    <div className="mt-4 pt-4 border-t border-border flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === c.uuid ? null : c.uuid)}
                        className="text-xs font-bold underline"
                        style={{ color: 'var(--color-accent-2)' }}
                      >
                        {expanded === c.uuid ? 'Hide entries' : `Review ${c.entry_count} ${c.entry_count === 1 ? 'entry' : 'entries'}`}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const r = await setChallengeStatus(c.uuid, isOpen ? 'closed' : 'open');
                          if (!r.ok) return toast.error(explain(r.error));
                          toast.success(isOpen ? 'Challenge closed.' : 'Challenge reopened.');
                          load();
                        }}
                        className="text-xs font-bold text-muted-foreground hover:text-foreground underline"
                      >
                        {isOpen ? 'Close' : 'Reopen'}
                      </button>
                    </div>
                  )}
                  {owned && expanded === c.uuid && <EntryList challenge={c} onChanged={load} />}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
