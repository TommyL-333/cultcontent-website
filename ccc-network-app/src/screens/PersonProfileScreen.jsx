import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@heroui/react';
import Topbar from '../components/Topbar';
import PersonDetailCard from '../components/PersonDetailCard';
import { acceptConnection, connect, declineConnection, getChallenges, getPersonProfile } from '../api';

export default function PersonProfileScreen({ person }) {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [briefs, setBriefs] = useState([]);

  function load() {
    getPersonProfile(uuid).then((j) => { if (j.ok) setTarget(j.person); else setErr(j.error || 'Not found'); });
  }
  useEffect(load, [uuid]);

  useEffect(() => {
    if (target?.relationship === 'self') navigate('/profile', { replace: true });
  }, [target, navigate]);

  // A brand's open briefs are the substance of their listing — "what are you
  // actually looking for" answered concretely rather than as a bio line.
  useEffect(() => {
    if (target?.role !== 'brand') return;
    getChallenges()
      .then((j) => j.ok && setBriefs(j.challenges.filter((c) => c.brand_uuid === uuid && c.status === 'open')))
      .catch(() => {});
  }, [target, uuid]);

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
          contactLabel={target.contact_is_public ? 'This brand is open to being contacted directly' : undefined}
          showCheckmark={!target.contact_is_public}
          extra={
            <>
              {briefs.length > 0 && (
                <div className="mb-4">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-2">
                    Open {briefs.length === 1 ? 'brief' : 'briefs'}
                  </div>
                  <div className="space-y-2.5">
                    {briefs.map((b) => (
                      <div key={b.uuid} className="rounded-md border border-border bg-background/40 px-4 py-3">
                        <div className="text-sm font-bold">{b.title}</div>
                        {b.description && <div className="text-[13px] text-foreground/80 leading-relaxed mt-1">{b.description}</div>}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-muted-foreground">
                          {b.reward && <span><span className="opacity-60">Reward</span> <span className="font-bold text-foreground">{b.reward}</span></span>}
                          {b.deadline && <span><span className="opacity-60">By</span> <span className="font-bold text-foreground">{b.deadline}</span></span>}
                        </div>
                      </div>
                    ))}
                  </div>
                  {person.role === 'creator' && (
                    <button
                      type="button" onClick={() => navigate('/challenges')}
                      className="mt-2.5 text-xs font-bold underline"
                      style={{ color: 'var(--color-accent-2)' }}
                    >
                      Enter a brief &rarr;
                    </button>
                  )}
                </div>
              )}
              {err && <p className="text-xs text-primary mb-3">{err}</p>}
            </>
          }
        />
      </div>
    </div>
  );
}
