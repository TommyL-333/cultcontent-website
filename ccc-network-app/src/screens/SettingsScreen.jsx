import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, Button, Card, Input, Label, ListBox, ListBoxItem, Select, Switch, TextArea } from '@heroui/react';
import Topbar from '../components/Topbar';
import { BOOTH_ZONES } from '../lib/booth-zones';
import PhotoUrlPreview from '../components/PhotoUrlPreview';
import { Link as RouterLink } from 'react-router-dom';
import { deactivateAccount, requestEmailChange, saveProfile, updateContactSharing, updateNotifications } from '../api';

function NotifyRow({ label, hint, checked, onChange }) {
  return (
    <Switch isSelected={checked} onChange={onChange} className="mb-3">
      <Switch.Content className="flex items-center gap-3">
        <Switch.Control><Switch.Thumb /></Switch.Control>
        <span>
          <span className="block text-sm font-medium">{label}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
      </Switch.Content>
    </Switch>
  );
}

export default function SettingsScreen({ person, onSaved }) {
  const [form, setForm] = useState({
    first_name: person.first_name || '', last_name: person.last_name || '', phone: person.phone || '',
    tiktok_handle: person.tiktok_handle || '', instagram_handle: person.instagram_handle || '', brand_name: person.brand_name || '', category: person.category || '',
    bio: person.bio || '', looking_for: person.looking_for || '',
    photo_url: person.photo_url || '',
    booth_zone: person.booth_zone || 'capitol-canopy', booth_note: person.booth_note || '',
    rate_videos: person.rate_videos || '', rate_price: person.rate_price || '', rate_terms: person.rate_terms || '',
    links: (person.links || []).map((l) => l.url).join('\n'),
  });
  const [saved, setSaved] = useState(false);
  const [profileErr, setProfileErr] = useState('');

  const [shareContact, setShareContact] = useState(!!person.share_contact);
  const [sharingSaved, setSharingSaved] = useState(false);
  const [notify, setNotify] = useState({
    notify_request: !!person.notify_request, notify_approval: !!person.notify_approval, notify_message: !!person.notify_message,
  });
  const [notifySaved, setNotifySaved] = useState(false);


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
      category: form.category, bio: form.bio, looking_for: form.looking_for, photo_url: form.photo_url,
      // updateProfile writes every column it's given, so omitting these would
      // blank a creator's saved rates on any unrelated profile save.
      ...(person.role === 'creator'
        ? {
            tiktok_handle: form.tiktok_handle, instagram_handle: form.instagram_handle,
            rate_videos: form.rate_videos, rate_price: form.rate_price, rate_terms: form.rate_terms,
          }
        : { brand_name: form.brand_name, booth_zone: form.booth_zone, booth_note: form.booth_zone === 'other' ? form.booth_note : '' }),
      links: form.links.split('\n').map((s) => s.trim()).filter(Boolean).map((url) => ({ label: 'Link', url })),
    };
    const j = await saveProfile(payload);
    if (!j.ok) { setProfileErr(j.error || 'Save failed.'); toast.error(j.error || 'Save failed.'); return; }
    setSaved(true);
    toast.success('Profile saved.');
    setTimeout(() => setSaved(false), 2500);
    onSaved?.();
  }

  async function handleSharingChange(value) {
    setShareContact(value);
    await updateContactSharing(value);
    setSharingSaved(true);
    setTimeout(() => setSharingSaved(false), 2000);
  }

  async function handleNotifyChange(key, value) {
    const next = { ...notify, [key]: value };
    setNotify(next);
    await updateNotifications(next);
    setNotifySaved(true);
    toast.success('Notification preferences saved.');
    setTimeout(() => setNotifySaved(false), 2000);
  }


  async function handleEmailSubmit(e) {
    e.preventDefault();
    setEmailErr('');
    const j = await requestEmailChange(newEmail);
    if (!j.ok) { setEmailErr(j.error || 'Could not start email change.'); toast.error(j.error || 'Could not start email change.'); return; }
    setEmailSent(true);
    toast.success(`Verification link sent to ${newEmail}.`);
  }

  async function handleDeactivate() {
    await deactivateAccount();
    toast('Account deactivated.');
    window.location.href = '/ccc-network/login';
  }

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-2xl mx-auto px-5 pb-20">
        <h1 className="font-display text-3xl font-bold mb-7">Settings</h1>

        {/* Profile fields */}
        <Card variant="default" className="p-6 sm:p-7 mb-5">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-4">Edit profile</div>
          {profileErr && <Alert status="danger" className="mb-4"><Alert.Description>{profileErr}</Alert.Description></Alert>}
          <form onSubmit={handleProfileSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>First name</Label><Input value={form.first_name} onChange={set('first_name')} fullWidth /></div>
              <div><Label>Last name</Label><Input value={form.last_name} onChange={set('last_name')} fullWidth /></div>
            </div>
            <div><Label>Phone</Label><Input value={form.phone} onChange={set('phone')} fullWidth /></div>
            {person.role === 'creator' ? (
              <div className="grid grid-cols-2 gap-3">
                <div><Label>TikTok handle</Label><Input value={form.tiktok_handle} onChange={set('tiktok_handle')} fullWidth /></div>
                <div><Label>Instagram handle</Label><Input value={form.instagram_handle} onChange={set('instagram_handle')} fullWidth /></div>
              </div>
            ) : (
              <div><Label>Brand name</Label><Input value={form.brand_name} onChange={set('brand_name')} fullWidth /></div>
            )}
            <div>
              <Label>{person.role === 'creator' ? 'Headshot / profile photo URL' : 'Logo or photo URL'}</Label>
              <Input value={form.photo_url} onChange={set('photo_url')} placeholder="https://…" fullWidth />
              {/* The old hint recommended a Drive or Dropbox *share* link,
                  which serves an HTML page rather than an image and so never
                  displays. Drive and Dropbox links are now rewritten on save,
                  but the advice should point at the thing that always works. */}
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                Paste a direct link to the image file — right-click a photo and choose
                &ldquo;Copy image address&rdquo;. Google Drive and Dropbox share links are converted
                automatically, as long as the file is shared publicly.
              </p>
              <PhotoUrlPreview url={form.photo_url} />
            </div>
            <div><Label>{person.role === 'creator' ? 'Content niche' : 'Product category'}</Label><Input value={form.category} onChange={set('category')} fullWidth /></div>
            <div><Label>Bio</Label><TextArea value={form.bio} onChange={set('bio')} fullWidth /></div>
            <div><Label>What are you looking for?</Label><TextArea value={form.looking_for} onChange={set('looking_for')} fullWidth /></div>
            {person.role === 'creator' && (
              <div className="rounded-md border border-border bg-background/40 p-4 space-y-3.5">
                <div>
                  <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Rates &amp; ideal terms</div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Only shown to brands whose connection request you&rsquo;ve accepted — never in the directory, and never in a
                    sponsor export. Leave blank to discuss it live instead.
                  </p>
                </div>
                <div>
                  <Label>Typical package</Label>
                  <Input value={form.rate_videos} onChange={set('rate_videos')} placeholder="e.g. 4 videos a month" fullWidth />
                </div>
                <div>
                  <Label>Your rate</Label>
                  <Input value={form.rate_price} onChange={set('rate_price')} placeholder="e.g. $500 per video, or $1,800 for 4" fullWidth />
                </div>
                <div>
                  <Label>Ideal contract terms</Label>
                  <TextArea value={form.rate_terms} onChange={set('rate_terms')} placeholder="Usage rights, exclusivity, turnaround, whitelisting — whatever matters to you" fullWidth />
                </div>
              </div>
            )}
            {person.role === 'brand' && (
              <div>
                <Label>Where will you be at the Carnival?</Label>
                <Select.Root
                  selectedKey={form.booth_zone || 'capitol-canopy'}
                  onSelectionChange={(v) => setForm((f) => ({ ...f, booth_zone: v }))}
                  aria-label="Booth location"
                  fullWidth
                >
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {BOOTH_ZONES.map((z) => <ListBoxItem key={z.id} id={z.id}>{z.label}</ListBoxItem>)}
                    </ListBox>
                  </Select.Popover>
                </Select.Root>
                {form.booth_zone === 'other' && (
                  <div className="mt-3">
                    <Label>Tell us your situation</Label>
                    <TextArea
                      value={form.booth_note}
                      onChange={set('booth_note')}
                      placeholder="e.g. Marketplace Sponsor, activation partner, or attending to meet creators without a booth"
                      fullWidth
                    />
                  </div>
                )}
              </div>
            )}
            <div><Label>Links (one per line)</Label><TextArea value={form.links} onChange={set('links')} fullWidth /></div>
            <div className="flex items-center gap-4 pt-1">
              <Button type="submit" variant="primary">Save Profile</Button>
              {saved && <span className="text-sm font-medium text-accent-2">Saved ✓</span>}
            </div>
          </form>
        </Card>

        {/* Email */}
        <Card variant="default" className="p-6 sm:p-7 mb-5">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-4">Email</div>
          <p className="text-sm text-muted-foreground mb-3">Current: <span className="text-foreground font-medium">{person.email}</span></p>
          {emailSent ? (
            <p className="text-sm text-accent-2">Check <strong>{newEmail}</strong> for a confirmation link — it expires in 30 minutes.</p>
          ) : (
            <form onSubmit={handleEmailSubmit} className="flex items-end gap-3">
              <div className="flex-1">
                <Label>New email</Label>
                <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="new@example.com" fullWidth />
              </div>
              <Button type="submit" variant="outline" isDisabled={!newEmail}>Send verification link</Button>
            </form>
          )}
          {emailErr && <p className="text-xs text-primary mt-2">{emailErr}</p>}
        </Card>

        {/* Notifications */}
        <Card variant="default" className="p-6 sm:p-7 mb-5">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-4 flex items-center gap-2">
            Notifications {notifySaved && <span className="text-accent-2 normal-case font-normal">Saved ✓</span>}
          </div>
          <NotifyRow label="Connection requests" hint="Email me when someone wants to connect" checked={notify.notify_request} onChange={(v) => handleNotifyChange('notify_request', v)} />
          <NotifyRow label="Approvals" hint="Email me when someone accepts my request" checked={notify.notify_approval} onChange={(v) => handleNotifyChange('notify_approval', v)} />
          <NotifyRow label="Messages" hint="Email me when I get a new message" checked={notify.notify_message} onChange={(v) => handleNotifyChange('notify_message', v)} />
        </Card>

        {/* Contact sharing — the switch that decides whether this person can
            ever appear in a sponsor's contact export. Off by default. */}
        <Card variant="default" className="p-6 sm:p-7 mb-5">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-4 flex items-center gap-2">
            Contact sharing {sharingSaved && <span className="text-accent-2 normal-case font-normal">Saved ✓</span>}
          </div>
          <NotifyRow
            label={person.role === 'brand' ? 'Let creators contact me directly' : 'Let sponsors export my contact details'}
            hint={person.role === 'brand'
              ? 'Creators can see your email and phone without connecting first'
              : "Your email and phone can be included in sponsoring brands' contact exports"}
            checked={shareContact}
            onChange={handleSharingChange}
          />
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            Off by default. People whose connection request you accept always see your contact details — this
            controls {person.role === 'brand' ? 'whether creators can skip that step' : 'the sponsor export'}. See the{' '}
            <RouterLink to="/terms" className="underline">roster terms</RouterLink>.
          </p>
        </Card>

        {/* Sponsorship level is read-only here — it controls early roster
            access and the contact export, so it's staff-assigned. */}
        {person.role === 'brand' && (
          <Card variant="default" className="p-6 sm:p-7 mb-5">
            <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">Sponsorship level</div>
            <p className="text-sm text-foreground font-medium capitalize mb-1.5">{person.tier || 'general'}</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Set by Tommy&rsquo;s team based on what you booked. If this looks wrong, email{' '}
              <a href="mailto:tommy@cultcontent.cc" className="underline">tommy@cultcontent.cc</a>.
            </p>
          </Card>
        )}

        {/* Danger zone */}
        <Card variant="default" className="p-6 sm:p-7 border-primary/40">
          <div className="text-xs font-bold uppercase tracking-wide text-primary mb-3">Deactivate account</div>
          <p className="text-sm text-muted-foreground mb-4">Removes you from the roster and directory. This can be undone by Tommy's team if you change your mind.</p>
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
