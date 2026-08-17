import { useState } from 'react';
import { Alert, Button, Card, Input, Label, ListBox, ListBoxItem, Select, Switch, TextArea } from '@heroui/react';
import Topbar from '../components/Topbar';
import { deactivateAccount, requestEmailChange, saveProfile, updateNotifications, updateTier } from '../api';

function NotifyRow({ label, hint, checked, onChange }) {
  return (
    <Switch isSelected={checked} onChange={onChange} className="mb-3">
      <Switch.Content className="flex items-center gap-3">
        <Switch.Control><Switch.Thumb /></Switch.Control>
        <span>
          <span className="block text-sm font-medium">{label}</span>
          <span className="block text-xs text-zinc-500">{hint}</span>
        </span>
      </Switch.Content>
    </Switch>
  );
}

export default function SettingsScreen({ person, onSaved }) {
  const [form, setForm] = useState({
    first_name: person.first_name || '', last_name: person.last_name || '', phone: person.phone || '',
    handle: person.handle || '', brand_name: person.brand_name || '', category: person.category || '',
    bio: person.bio || '', looking_for: person.looking_for || '',
    links: (person.links || []).map((l) => l.url).join('\n'),
  });
  const [saved, setSaved] = useState(false);
  const [profileErr, setProfileErr] = useState('');

  const [notify, setNotify] = useState({
    notify_request: !!person.notify_request, notify_approval: !!person.notify_approval, notify_message: !!person.notify_message,
  });
  const [notifySaved, setNotifySaved] = useState(false);

  const [tier, setTier] = useState(person.tier || 'general');
  const [tierSaved, setTierSaved] = useState(false);

  const [newEmail, setNewEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [emailErr, setEmailErr] = useState('');

  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleProfileSubmit(e) {
    e.preventDefault();
    setProfileErr('');
    const payload = {
      first_name: form.first_name, last_name: form.last_name, phone: form.phone,
      category: form.category, bio: form.bio, looking_for: form.looking_for,
      ...(person.role === 'creator' ? { handle: form.handle } : { brand_name: form.brand_name }),
      links: form.links.split('\n').map((s) => s.trim()).filter(Boolean).map((url) => ({ label: 'Link', url })),
    };
    const j = await saveProfile(payload);
    if (!j.ok) { setProfileErr(j.error || 'Save failed.'); return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    onSaved?.();
  }

  async function handleNotifyChange(key, value) {
    const next = { ...notify, [key]: value };
    setNotify(next);
    await updateNotifications(next);
    setNotifySaved(true);
    setTimeout(() => setNotifySaved(false), 2000);
  }

  async function handleTierChange(value) {
    setTier(value);
    const j = await updateTier(value);
    if (j.ok) {
      setTierSaved(true);
      setTimeout(() => setTierSaved(false), 2000);
      onSaved?.();
    }
  }

  async function handleEmailSubmit(e) {
    e.preventDefault();
    setEmailErr('');
    const j = await requestEmailChange(newEmail);
    if (!j.ok) { setEmailErr(j.error || 'Could not start email change.'); return; }
    setEmailSent(true);
  }

  async function handleDeactivate() {
    await deactivateAccount();
    window.location.href = '/ccc-network/login';
  }

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-2xl mx-auto px-5 pb-20">
        <h1 className="text-3xl font-extrabold tracking-tight mb-7">Settings</h1>

        {/* Profile fields */}
        <Card variant="default" className="p-6 sm:p-7 mb-5">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500 mb-4">Edit profile</div>
          {profileErr && <Alert status="danger" className="mb-4"><Alert.Description>{profileErr}</Alert.Description></Alert>}
          <form onSubmit={handleProfileSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>First name</Label><Input value={form.first_name} onChange={set('first_name')} fullWidth /></div>
              <div><Label>Last name</Label><Input value={form.last_name} onChange={set('last_name')} fullWidth /></div>
            </div>
            <div><Label>Phone</Label><Input value={form.phone} onChange={set('phone')} fullWidth /></div>
            {person.role === 'creator' ? (
              <div><Label>TikTok / IG handle</Label><Input value={form.handle} onChange={set('handle')} fullWidth /></div>
            ) : (
              <div><Label>Brand name</Label><Input value={form.brand_name} onChange={set('brand_name')} fullWidth /></div>
            )}
            <div><Label>{person.role === 'creator' ? 'Content niche' : 'Product category'}</Label><Input value={form.category} onChange={set('category')} fullWidth /></div>
            <div><Label>Bio</Label><TextArea value={form.bio} onChange={set('bio')} fullWidth /></div>
            <div><Label>What are you looking for?</Label><TextArea value={form.looking_for} onChange={set('looking_for')} fullWidth /></div>
            <div><Label>Links (one per line)</Label><TextArea value={form.links} onChange={set('links')} fullWidth /></div>
            <div className="flex items-center gap-4 pt-1">
              <Button type="submit" variant="primary">Save Profile</Button>
              {saved && <span className="text-sm font-medium text-cyan-400">Saved ✓</span>}
            </div>
          </form>
        </Card>

        {/* Email */}
        <Card variant="default" className="p-6 sm:p-7 mb-5">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500 mb-4">Email</div>
          <p className="text-sm text-zinc-400 mb-3">Current: <span className="text-zinc-200 font-medium">{person.email}</span></p>
          {emailSent ? (
            <p className="text-sm text-cyan-400">Check <strong>{newEmail}</strong> for a confirmation link — it expires in 30 minutes.</p>
          ) : (
            <form onSubmit={handleEmailSubmit} className="flex items-end gap-3">
              <div className="flex-1">
                <Label>New email</Label>
                <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="new@example.com" fullWidth />
              </div>
              <Button type="submit" variant="outline" isDisabled={!newEmail}>Send verification link</Button>
            </form>
          )}
          {emailErr && <p className="text-xs text-red-400 mt-2">{emailErr}</p>}
        </Card>

        {/* Notifications */}
        <Card variant="default" className="p-6 sm:p-7 mb-5">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500 mb-4 flex items-center gap-2">
            Notifications {notifySaved && <span className="text-cyan-400 normal-case font-normal">Saved ✓</span>}
          </div>
          <NotifyRow label="Connection requests" hint="Email me when someone wants to connect" checked={notify.notify_request} onChange={(v) => handleNotifyChange('notify_request', v)} />
          <NotifyRow label="Approvals" hint="Email me when someone accepts my request" checked={notify.notify_approval} onChange={(v) => handleNotifyChange('notify_approval', v)} />
          <NotifyRow label="Messages" hint="Email me when I get a new message" checked={notify.notify_message} onChange={(v) => handleNotifyChange('notify_message', v)} />
        </Card>

        {/* Tier (brands only) */}
        {person.role === 'brand' && (
          <Card variant="default" className="p-6 sm:p-7 mb-5">
            <div className="text-xs font-bold uppercase tracking-wide text-zinc-500 mb-4 flex items-center gap-2">
              Sponsorship tier {tierSaved && <span className="text-cyan-400 normal-case font-normal">Saved ✓</span>}
            </div>
            <Select.Root selectedKey={tier} onSelectionChange={handleTierChange} aria-label="Sponsorship tier" fullWidth>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBoxItem id="general">Booth / Community Vendor / Other</ListBoxItem>
                  <ListBoxItem id="priority">Marketplace or Carnival Sponsor (priority access)</ListBoxItem>
                  <ListBoxItem id="executive">Executive Experience</ListBoxItem>
                </ListBox>
              </Select.Popover>
            </Select.Root>
            <p className="text-[11px] text-zinc-500 mt-1.5">Self-reported — Tommy's team can still correct this at review.</p>
          </Card>
        )}

        {/* Danger zone */}
        <Card variant="default" className="p-6 sm:p-7 border-red-900">
          <div className="text-xs font-bold uppercase tracking-wide text-red-400 mb-3">Deactivate account</div>
          <p className="text-sm text-zinc-400 mb-4">Removes you from the roster and directory. This can be undone by Tommy's team if you change your mind.</p>
          {!confirmDeactivate ? (
            <Button variant="danger" onPress={() => setConfirmDeactivate(true)}>Deactivate my account</Button>
          ) : (
            <div className="flex items-center gap-3">
              <Button variant="danger" onPress={handleDeactivate}>Yes, deactivate</Button>
              <Button variant="outline" onPress={() => setConfirmDeactivate(false)}>Cancel</Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
