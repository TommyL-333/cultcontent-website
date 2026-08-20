import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Avatar, Button, Card, Tabs } from '@heroui/react';
import Topbar from '../components/Topbar';
import { acceptConnection, declineConnection, getConnections } from '../api';
import { initialsOf, colorOf, displayName, orgOf } from '../lib/avatar';

function PersonRow({ p, onClick, right }) {
  return (
    <Card variant="default" className="p-4 flex items-center gap-3.5 cursor-pointer hover:border-accent-2/40 transition-colors" onClick={onClick}>
      <Avatar color={colorOf(p)} size="sm"><Avatar.Fallback>{initialsOf(p)}</Avatar.Fallback></Avatar>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold truncate">{displayName(p)}</div>
        <div className="text-xs text-muted-foreground truncate">{orgOf(p)}{p.category ? ` · ${p.category}` : ''}</div>
      </div>
      {right}
    </Card>
  );
}

export default function ConnectionsScreen({ person }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState('current');
  const [data, setData] = useState(null);
  const [busyUuid, setBusyUuid] = useState(null);

  function load() {
    getConnections().then((j) => { if (j.ok) setData(j); });
  }
  useEffect(load, []);

  // Accept/Decline buttons sit inside a wrapping div whose native onClick
  // already stops propagation before it reaches the row's onClick (below) —
  // React Aria's onPress event isn't a native DOM event, so that's done at
  // the real DOM level rather than relying on e.stopPropagation() here.
  async function handleAccept(uuid, name) {
    setBusyUuid(uuid);
    const j = await acceptConnection(uuid);
    setBusyUuid(null);
    if (j.ok) toast.success(`Connected with ${name} — you can now message them.`);
    else toast.error(j.error || 'Could not accept.');
    load();
  }
  async function handleDecline(uuid, name) {
    setBusyUuid(uuid);
    const j = await declineConnection(uuid);
    setBusyUuid(null);
    if (j.ok) toast(`Declined ${name}'s request.`);
    else toast.error(j.error || 'Could not decline.');
    load();
  }

  const lists = {
    current: data?.current || [],
    incoming: data?.incoming || [],
    outgoing: data?.outgoing || [],
  };
  const active = lists[tab] || [];

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-2xl mx-auto px-5 pb-20">
        <h1 className="font-display text-3xl font-bold mb-2">Connections</h1>
        <p className="text-sm text-muted-foreground mb-6">Manage who you&rsquo;re connected with. Click anyone to view their full profile.</p>

        <Tabs selectedKey={tab} onSelectionChange={setTab} className="mb-5">
          <Tabs.List>
            <Tabs.Tab id="current">Current {lists.current.length > 0 && `(${lists.current.length})`}</Tabs.Tab>
            <Tabs.Tab id="incoming">Awaiting Approval {lists.incoming.length > 0 && `(${lists.incoming.length})`}</Tabs.Tab>
            <Tabs.Tab id="outgoing">Sent {lists.outgoing.length > 0 && `(${lists.outgoing.length})`}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel id="current" />
          <Tabs.Panel id="incoming" />
          <Tabs.Panel id="outgoing" />
        </Tabs>

        {!data ? (
          <div className="text-center text-sm text-muted-foreground py-14">Loading…</div>
        ) : active.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-14">
            {tab === 'current' && "No connections yet — head to the Directory to start some."}
            {tab === 'incoming' && 'No requests waiting on you right now.'}
            {tab === 'outgoing' && "You haven't sent any requests yet."}
          </div>
        ) : (
          <div className="grid gap-2.5">
            {active.map((p) => (
              <PersonRow
                key={p.uuid}
                p={p}
                onClick={() => navigate(`/people/${p.uuid}`)}
                right={tab === 'incoming' ? (
                  <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" variant="primary" isDisabled={busyUuid === p.uuid} onPress={() => handleAccept(p.uuid, displayName(p))}>Accept</Button>
                    <Button size="sm" variant="outline" isDisabled={busyUuid === p.uuid} onPress={() => handleDecline(p.uuid, displayName(p))}>Decline</Button>
                  </div>
                ) : tab === 'outgoing' ? (
                  <span className="text-xs text-muted-foreground">Pending</span>
                ) : null}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
