import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Chip, Input } from '@heroui/react';
import Topbar from '../components/Topbar';
import { connect, getDirectory } from '../api';

function PersonCard({ person }) {
  const [connecting, setConnecting] = useState(false);
  const [contact, setContact] = useState(null);
  const [err, setErr] = useState('');
  const org = person.role === 'brand' ? person.brand_name : (person.handle ? `@${person.handle.replace(/^@/, '')}` : '');

  async function handleConnect() {
    setConnecting(true);
    setErr('');
    const j = await connect(person.uuid);
    setConnecting(false);
    if (!j.ok) { setErr(j.error || 'Could not connect.'); return; }
    setContact(j.otherPerson);
  }

  return (
    <Card variant="default" className="p-5">
      <Chip color={person.role === 'brand' ? 'warning' : 'accent'} size="sm">{person.role === 'brand' ? 'Brand' : 'Creator'}</Chip>
      <div className="text-base font-bold mt-2.5">{person.first_name} {person.last_name} {org ? `· ${org}` : ''}</div>
      <div className="text-xs text-zinc-500 mt-0.5 mb-3">{person.category}</div>
      {person.bio && <div className="text-[13px] text-zinc-300 leading-relaxed mb-2.5">{person.bio}</div>}
      {person.looking_for && (
        <div className="text-xs text-zinc-400 mb-3.5">
          <b className="text-zinc-300 font-semibold">Looking for:</b> {person.looking_for}
        </div>
      )}
      {contact ? (
        <div className="rounded-md border border-cyan-500/25 bg-cyan-500/5 px-3.5 py-2.5 text-[13px]">
          Email: {contact.email}
          {contact.phone ? <><br />Phone: {contact.phone}</> : null}
        </div>
      ) : (
        <>
          <Button size="sm" variant="primary" isDisabled={connecting} onPress={handleConnect}>
            {connecting ? 'Connecting…' : 'Connect →'}
          </Button>
          {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
        </>
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
      [p.first_name, p.last_name, p.brand_name, p.handle, p.category, p.looking_for, p.bio].join(' ').toLowerCase().includes(term)
    );
  }, [data, q]);

  if (!data) {
    return (
      <div>
        <Topbar person={person} />
        <div className="text-center text-sm text-zinc-500 py-20">Loading…</div>
      </div>
    );
  }

  if (data.gated) {
    return (
      <div>
        <Topbar person={person} />
        <div className="max-w-2xl mx-auto px-5 pb-20">
          <Card variant="default" className="p-10 text-center">
            <h1 className="text-2xl font-extrabold tracking-tight mb-3">Priority sponsors get first pick.</h1>
            <p className="text-sm text-zinc-400 leading-relaxed max-w-sm mx-auto">
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
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">The roster</h1>
        <p className="text-sm text-zinc-400 mb-6">
          {person.role === 'creator' ? 'Brands and fellow creators' : 'Creators looking to collab'} — search, filter, and connect. Connecting shares contact info both ways.
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
            ? <div className="text-center text-sm text-zinc-500 py-14">No matches yet.</div>
            : filtered.map((p) => <PersonCard key={p.uuid} person={p} />)}
        </div>
      </div>
    </div>
  );
}
