import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Card, Chip, Input } from '@heroui/react';
import Topbar from '../components/Topbar';
import { connect, getDirectory } from '../api';
import { orgOf } from '../lib/avatar';

// Connect is now a request, not an instant reveal — the button reflects
// pending/accepted state (best-effort from this click; a fresh page load
// still shows "Connect →" for an existing request until clicked again,
// since the directory listing doesn't carry relationship state — clicking
// again is harmless, the backend just returns the current status).
function PersonCard({ person }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null); // null | 'pending' | 'accepted'
  const [busy, setBusy] = useState(false);
  const org = orgOf(person);
  const name = `${person.first_name} ${person.last_name || ''}`.trim();

  async function handleConnect() {
    setBusy(true);
    const j = await connect(person.uuid);
    setBusy(false);
    if (!j.ok) { toast.error(j.error || 'Could not connect.'); return; }
    setStatus(j.status);
    toast.success(j.status === 'accepted' ? `You're already connected with ${name}` : `Request sent to ${name}`);
  }

  return (
    <Card variant="default" className="p-5">
      <Chip color={person.role === 'brand' ? 'warning' : 'accent'} size="sm">{person.role === 'brand' ? 'Brand' : 'Creator'}</Chip>
      <div className="text-base font-bold mt-2.5">{person.first_name} {person.last_name} {org ? `· ${org}` : ''}</div>
      <div className="text-xs text-muted-foreground mt-0.5 mb-3">{person.category}</div>
      {person.bio && <div className="text-[13px] text-foreground/80 leading-relaxed mb-2.5">{person.bio}</div>}
      {person.looking_for && (
        <div className="text-xs text-muted-foreground mb-3.5">
          <b className="text-foreground/80 font-semibold">Looking for:</b> {person.looking_for}
        </div>
      )}
      {status === 'accepted' ? (
        <Button size="sm" variant="outline" onPress={() => navigate(`/people/${person.uuid}`)}>Connected — view profile &rarr;</Button>
      ) : status === 'pending' ? (
        <Button size="sm" variant="outline" isDisabled>Request sent</Button>
      ) : (
        <Button size="sm" variant="primary" isDisabled={busy} onPress={handleConnect}>
          {busy ? 'Sending…' : 'Connect →'}
        </Button>
      )}
    </Card>
  );
}

export default function DirectoryScreen({ person }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => { getDirectory().then(setData); }, []);

  const filtered = useMemo(() => {
    if (!data?.people) return [];
    const term = q.trim().toLowerCase();
    if (!term) return data.people;
    return data.people.filter((p) =>
      [p.first_name, p.last_name, p.brand_name, p.tiktok_handle, p.instagram_handle, p.category, p.looking_for, p.bio].join(' ').toLowerCase().includes(term)
    );
  }, [data, q]);

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

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-3xl mx-auto px-5 pb-20">
        <h1 className="font-display text-3xl font-bold mb-2">The roster</h1>
        <p className="text-sm text-muted-foreground mb-6">
          {person.role === 'creator' ? 'Brands and fellow creators' : 'Creators looking to collab'} — search, filter, and connect. Connecting sends a request; contact info unlocks once they accept.
        </p>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, category, or what they're looking for…"
          fullWidth
          className="mb-6"
        />
        <div className="grid gap-3.5">
          {filtered.length === 0
            ? <div className="text-center text-sm text-muted-foreground py-14">No matches yet.</div>
            : filtered.map((p) => <PersonCard key={p.uuid} person={p} />)}
        </div>
      </div>
    </div>
  );
}
