import { useCallback, useEffect, useState } from 'react';
import { Card } from '@heroui/react';
import { toast } from 'sonner';
import Topbar from '../components/Topbar';
import {
  getChallenges, createChallenge, setChallengeStatus,
  enterChallenge, withdrawFromChallenge, getChallengeEntries,
} from '../api';

const ERRORS = {
  bad_url: 'That doesn’t look like a link. Paste the full URL to your post.',
  closed: 'This challenge has closed.',
  creators_only: 'Only creators can enter challenges.',
  brands_only: 'Only brands can post challenges.',
  title_required: 'Give the challenge a title.',
  too_many_open: 'You already have the maximum number of open challenges. Close one first.',
  not_found: 'That challenge no longer exists.',
  not_yours: 'That isn’t your challenge.',
};
const explain = (e) => ERRORS[e] ?? 'Something went wrong. Try again.';

function BrandCreateForm({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', reward: '', deadline: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const r = await createChallenge(form);
    setBusy(false);
    if (!r.ok) return toast.error(explain(r.error));
    toast.success('Challenge posted.');
    setForm({ title: '', description: '', reward: '', deadline: '' });
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
          <input value={form.reward} onChange={set('reward')} placeholder="Reward (e.g. $500 + product)" className="rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none" />
          <input value={form.deadline} onChange={set('deadline')} type="date" className="rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-muted-foreground focus:border-primary focus:outline-none" />
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

function EntryForm({ challenge, onDone }) {
  const [url, setUrl] = useState(challenge.my_entry_url ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const r = await enterChallenge(challenge.uuid, { url, note });
    setBusy(false);
    if (!r.ok) return toast.error(explain(r.error));
    toast.success(challenge.my_entry_url ? 'Link updated.' : 'Entry submitted.');
    onDone();
  }

  return (
    <form onSubmit={submit} className="mt-4 pt-4 border-t border-border space-y-2.5">
      <label className="block text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">
        {challenge.my_entry_url ? 'Your entry' : 'Link your post'}
      </label>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          required value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://tiktok.com/@you/video/..."
          className="flex-1 rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none"
        />
        <button type="submit" disabled={busy} className="rounded-lg px-4 py-2.5 text-sm font-extrabold shrink-0 disabled:opacity-50" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}>
          {busy ? '…' : challenge.my_entry_url ? 'Update' : 'Submit'}
        </button>
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note to the brand" className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-xs focus:border-primary focus:outline-none" />
      {challenge.my_entry_url && (
        <button
          type="button"
          onClick={async () => { await withdrawFromChallenge(challenge.uuid); toast.success('Entry withdrawn.'); onDone(); }}
          className="text-[11px] text-muted-foreground hover:text-foreground underline"
        >
          Withdraw my entry
        </button>
      )}
    </form>
  );
}

function EntryList({ uuid }) {
  const [state, setState] = useState({ loading: true, entries: [] });
  useEffect(() => {
    getChallengeEntries(uuid).then((r) => setState({ loading: false, entries: r.ok ? r.entries : [] }));
  }, [uuid]);

  if (state.loading) return <p className="mt-4 pt-4 border-t border-border text-xs text-muted-foreground">Loading entries…</p>;
  if (!state.entries.length) return <p className="mt-4 pt-4 border-t border-border text-xs text-muted-foreground">No entries yet.</p>;

  return (
    <ul className="mt-4 pt-4 border-t border-border space-y-2.5">
      {state.entries.map((e) => (
        <li key={e.uuid} className="flex items-start justify-between gap-3 text-sm">
          <div className="min-w-0">
            <div className="font-semibold truncate">{e.first_name} {e.last_name}</div>
            {e.tiktok_handle && <div className="text-[11px] text-muted-foreground truncate">@{e.tiktok_handle.replace(/^@/, '')}</div>}
            {e.note && <div className="text-[11px] text-foreground/70 mt-0.5">{e.note}</div>}
          </div>
          {/* rel=noreferrer on a creator-supplied URL — these are pasted links,
              so don't leak the roster referrer or hand over window.opener. */}
          <a href={e.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-xs font-bold underline" style={{ color: 'var(--color-accent-2)' }}>
            View post &rarr;
          </a>
        </li>
      ))}
    </ul>
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

  const mine = (c) => isBrand && c.brand_uuid === person.uuid;

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-3xl mx-auto px-5 pb-20">
        <span className="pill-glow pill-glow-red mb-4 -rotate-2">Briefs &amp; bounties</span>
        <h1 className="font-display text-3xl sm:text-4xl font-black tracking-tight leading-[0.95] mb-2">Challenges</h1>
        <p className="text-sm text-muted-foreground mb-5 leading-relaxed max-w-md">
          {isBrand
            ? 'Post a brief. Creators link their posts back to it, and you get every entry in one place.'
            : 'Briefs from brands at the Carnival. Make the post, paste the link, get on their radar.'}
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
              const owned = mine(c);
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
                    {c.reward && <span><span className="opacity-60">Reward</span> <span className="font-bold text-foreground">{c.reward}</span></span>}
                    {c.deadline && <span><span className="opacity-60">By</span> <span className="font-bold text-foreground">{c.deadline}</span></span>}
                    <span><span className="font-bold text-foreground">{c.entry_count}</span> {c.entry_count === 1 ? 'entry' : 'entries'}</span>
                  </div>

                  {!isBrand && isOpen && <EntryForm challenge={c} onDone={load} />}
                  {!isBrand && !isOpen && c.my_entry_url && (
                    <p className="mt-4 pt-4 border-t border-border text-xs text-muted-foreground">You entered this one.</p>
                  )}

                  {owned && (
                    <div className="mt-4 pt-4 border-t border-border flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === c.uuid ? null : c.uuid)}
                        className="text-xs font-bold underline"
                        style={{ color: 'var(--color-accent-2)' }}
                      >
                        {expanded === c.uuid ? 'Hide entries' : `View ${c.entry_count} ${c.entry_count === 1 ? 'entry' : 'entries'}`}
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
                  {owned && expanded === c.uuid && <EntryList uuid={c.uuid} />}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
