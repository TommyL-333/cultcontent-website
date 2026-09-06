import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Card, Chip, Input } from '@heroui/react';
import Topbar from '../components/Topbar';
import ProfilePhoto from '../components/ProfilePhoto';
import { connect, getChallenges, getDirectory } from '../api';
import { orgOf } from '../lib/avatar';
import { zoneLabel } from '../lib/booth-zones';

// Connect is a request, not an instant reveal — the button reflects
// pending/accepted state (best-effort from this click; a fresh page load
// still shows "Connect →" for an existing request until clicked again,
// since the directory listing doesn't carry relationship state — clicking
// again is harmless, the backend just returns the current status).
function PersonCard({ person, briefs }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null); // null | 'pending' | 'accepted'
  const [busy, setBusy] = useState(false);
  const org = orgOf(person);
  const name = `${person.first_name} ${person.last_name || ''}`.trim();
  const isBrand = person.role === 'brand';

  async function handleConnect() {
    setBusy(true);
    const j = await connect(person.uuid);
    setBusy(false);
    if (!j.ok) { toast.error(j.error || 'Could not connect.'); return; }
    setStatus(j.status);
    toast.success(j.status === 'accepted' ? `You're already connected with ${name}` : `Request sent to ${name}`);
  }

  return (
    <Card variant="default" className={`p-5 ${isBrand ? 'card-glow-cyan' : ''}`}>
      <div className="flex items-start gap-3.5">
        <ProfilePhoto person={person} size="md" />
        <div className="min-w-0 flex-1">
          <Chip color={isBrand ? 'warning' : 'accent'} size="sm">{isBrand ? 'Brand' : 'Creator'}</Chip>
          <div className="text-base font-bold mt-2 truncate">
            {isBrand && person.brand_name ? person.brand_name : `${person.first_name} ${person.last_name || ''}`.trim()}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">
            {[person.category, !isBrand && org].filter(Boolean).join(' · ')}
          </div>
          {isBrand && zoneLabel(person) && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--color-gold)' }}>
              <span aria-hidden>📍</span>{zoneLabel(person)}
            </div>
          )}
        </div>
      </div>

      {person.bio && <div className="text-[13px] text-foreground/80 leading-relaxed mt-3.5">{person.bio}</div>}

      {/* For a brand this is the whole point of the listing — it's what a
          creator is scanning for. Given its own block, not a trailing line. */}
      {person.looking_for && (
        <div className="mt-3 rounded-md border border-border bg-background/40 px-3.5 py-2.5">
          <div className="text-[9px] font-bold uppercase tracking-[.14em] text-muted-foreground mb-1">
            {isBrand ? 'Looking for' : 'Wants to work with'}
          </div>
          <div className="text-[13px] text-foreground/85 leading-relaxed">{person.looking_for}</div>
        </div>
      )}

      {briefs > 0 && (
        <button
          type="button"
          onClick={() => navigate(`/people/${person.uuid}`)}
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold underline"
          style={{ color: 'var(--color-accent-2)' }}
        >
          {briefs} open {briefs === 1 ? 'brief' : 'briefs'} &rarr;
        </button>
      )}

      <div className="mt-4 flex items-center gap-2">
        {status === 'accepted' ? (
          <Button size="sm" variant="outline" onPress={() => navigate(`/people/${person.uuid}`)}>Connected — view profile &rarr;</Button>
        ) : status === 'pending' ? (
          <Button size="sm" variant="outline" isDisabled>Request sent</Button>
        ) : (
          <>
            <Button size="sm" variant="primary" isDisabled={busy} onPress={handleConnect}>
              {busy ? 'Sending…' : 'Connect →'}
            </Button>
            <Button size="sm" variant="ghost" onPress={() => navigate(`/people/${person.uuid}`)}>View profile</Button>
          </>
        )}
      </div>
    </Card>
  );
}

export default function DirectoryScreen({ person }) {
  const [data, setData] = useState(null);
  const [briefCounts, setBriefCounts] = useState({});
  const [q, setQ] = useState('');
  // Default to the other side of the marketplace — a creator opens this
  // wanting brands, a brand wanting creators. That's the whole reason
  // they're here, so don't make them pick a tab first.
  const [tab, setTab] = useState(person.role === 'creator' ? 'brand' : 'creator');

  useEffect(() => { getDirectory().then(setData); }, []);

  useEffect(() => {
    // Brief counts come from the challenges feed rather than a new endpoint —
    // it's already scoped to approved brands and cheap at this roster size.
    getChallenges()
      .then((j) => {
        if (!j.ok) return;
        const counts = {};
        j.challenges.filter((c) => c.status === 'open').forEach((c) => {
          counts[c.brand_uuid] = (counts[c.brand_uuid] || 0) + 1;
        });
        setBriefCounts(counts);
      })
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    if (!data?.people) return [];
    const term = q.trim().toLowerCase();
    return data.people
      .filter((p) => (tab === 'all' ? true : p.role === tab))
      .filter((p) => !term || [p.first_name, p.last_name, p.brand_name, p.tiktok_handle, p.instagram_handle, p.category, p.looking_for, p.bio]
        .join(' ').toLowerCase().includes(term));
  }, [data, q, tab]);

  const counts = useMemo(() => {
    const people = data?.people ?? [];
    return {
      brand: people.filter((p) => p.role === 'brand').length,
      creator: people.filter((p) => p.role === 'creator').length,
      all: people.length,
    };
  }, [data]);

  if (!data) {
    return (
      <div>
        <Topbar person={person} />
        <div className="text-center text-sm text-muted-foreground py-20">Loading…</div>
      </div>
    );
  }

  if (data.gated) {
    return (
      <div>
        <Topbar person={person} />
        <div className="max-w-2xl mx-auto px-5 pb-20">
          <Card variant="default" className="p-10 text-center">
            <h1 className="font-display text-2xl font-bold mb-3">Priority sponsors get first pick.</h1>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto">
              Marketplace and Carnival sponsors have early access to the roster. General access opens{' '}
              {data.opensAt ? new Date(data.opensAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'soon'} — check back then.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  const TABS = [
    { id: 'brand', label: 'Brands' },
    { id: 'creator', label: 'Creators' },
    { id: 'all', label: 'Everyone' },
  ];

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-3xl mx-auto px-5 pb-20">
        <span className="pill-glow pill-glow-red mb-4 -rotate-2">The roster</span>
        <h1 className="font-display text-3xl sm:text-4xl font-black tracking-tight leading-[0.95] mb-2">
          {tab === 'brand' ? 'Brands' : tab === 'creator' ? 'Creators' : 'Everyone'}
        </h1>
        <p className="text-sm text-muted-foreground mb-5 leading-relaxed max-w-md">
          {tab === 'brand'
            ? 'Who’s here, and what they’re looking for. Connecting sends a request — contact details unlock once they accept.'
            : 'Creators on the roster. Connecting sends a request — contact details and rates unlock once they accept.'}
        </p>
        <div className="candy-stripe w-24 mb-6" aria-hidden />

        <div className="flex flex-wrap gap-2 mb-4">
          {TABS.map((t) => (
            <button
              key={t.id} type="button" onClick={() => setTab(t.id)}
              className={`rounded-lg px-3.5 py-2 text-xs font-bold ${tab === t.id ? 'bg-foreground text-background' : 'border border-border text-muted-foreground hover:text-foreground'}`}
            >
              {t.label} <span className="opacity-60">{counts[t.id]}</span>
            </button>
          ))}
        </div>

        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, category, or what they're looking for…"
          fullWidth
          className="mb-6"
        />

        <div className="grid gap-3.5">
          {filtered.length === 0
            ? <div className="text-center text-sm text-muted-foreground py-14">
                {q ? 'No matches yet.' : `No ${tab === 'all' ? 'members' : tab === 'brand' ? 'brands' : 'creators'} on the roster yet.`}
              </div>
            : filtered.map((p) => <PersonCard key={p.uuid} person={p} briefs={briefCounts[p.uuid] || 0} />)}
        </div>
      </div>
    </div>
  );
}
