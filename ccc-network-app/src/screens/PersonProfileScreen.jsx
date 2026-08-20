import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@heroui/react';
import Topbar from '../components/Topbar';
import PersonDetailCard from '../components/PersonDetailCard';
import { acceptConnection, connect, declineConnection, getPersonProfile } from '../api';

export default function PersonProfileScreen({ person }) {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function load() {
    getPersonProfile(uuid).then((j) => { if (j.ok) setTarget(j.person); else setErr(j.error || 'Not found'); });
  }
  useEffect(load, [uuid]);

  useEffect(() => {
    if (target?.relationship === 'self') navigate('/profile', { replace: true });
  }, [target, navigate]);

  const name = target ? `${target.first_name} ${target.last_name || ''}`.trim() : '';

  async function handleConnect() {
    setBusy(true);
    const j = await connect(uuid);
    setBusy(false);
    if (j.ok) { toast.success(`Request sent to ${name}`); load(); } else toast.error(j.error || 'Could not connect.');
  }
  async function handleAccept() {
    setBusy(true);
    const j = await acceptConnection(uuid);
    setBusy(false);
    if (j.ok) { toast.success(`Connected with ${name} — you can now message them.`); load(); } else toast.error(j.error || 'Could not accept.');
  }
  async function handleDecline() {
    setBusy(true);
    const j = await declineConnection(uuid);
    setBusy(false);
    if (j.ok) { toast(`Declined ${name}'s request.`); load(); } else toast.error(j.error || 'Could not decline.');
  }

  if (err && !target) {
    return (
      <div>
        <Topbar person={person} />
        <div className="max-w-2xl mx-auto px-5 pb-20 text-center text-sm text-muted-foreground py-20">{err}</div>
      </div>
    );
  }
  if (!target) {
    return (
      <div>
        <Topbar person={person} />
        <div className="text-center text-sm text-muted-foreground py-20">Loading…</div>
      </div>
    );
  }

  let actions;
  if (target.relationship === 'accepted') {
    actions = <Button variant="primary" onPress={() => navigate(`/inbox/${uuid}`)}>Message &rarr;</Button>;
  } else if (target.relationship === 'incoming') {
    actions = (
      <>
        <Button variant="primary" isDisabled={busy} onPress={handleAccept}>Accept</Button>
        <Button variant="outline" isDisabled={busy} onPress={handleDecline}>Decline</Button>
      </>
    );
  } else if (target.relationship === 'outgoing') {
    actions = <Button variant="outline" isDisabled>Request sent</Button>;
  } else {
    actions = <Button variant="primary" isDisabled={busy} onPress={handleConnect}>Connect &rarr;</Button>;
  }

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-2xl mx-auto px-5 pb-20">
        <PersonDetailCard
          person={target}
          actions={actions}
          extra={err && <p className="text-xs text-primary mb-3">{err}</p>}
        />
      </div>
    </div>
  );
}
