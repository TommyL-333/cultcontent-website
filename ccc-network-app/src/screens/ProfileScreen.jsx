import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Input, Label, TextArea } from '@heroui/react';
import Topbar from '../components/Topbar';
import { saveProfile } from '../api';

export default function ProfileScreen({ person, onSaved }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    first_name: person.first_name || '',
    last_name: person.last_name || '',
    phone: person.phone || '',
    handle: person.handle || '',
    brand_name: person.brand_name || '',
    category: person.category || '',
    bio: person.bio || '',
    looking_for: person.looking_for || '',
    links: (person.links || []).map((l) => l.url).join('\n'),
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = {
      first_name: form.first_name,
      last_name: form.last_name,
      phone: form.phone,
      category: form.category,
      bio: form.bio,
      looking_for: form.looking_for,
      ...(person.role === 'creator' ? { handle: form.handle } : { brand_name: form.brand_name }),
      links: form.links.split('\n').map((s) => s.trim()).filter(Boolean).map((url) => ({ label: 'Link', url })),
    };
    const j = await saveProfile(payload);
    if (!j.ok) { setError(j.error || 'Save failed.'); return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    onSaved?.();
  }

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-2xl mx-auto px-5 pb-20">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">Your profile</h1>
        <p className="text-sm text-zinc-400 mb-7">This is what the rest of the roster sees when they browse the directory.</p>

        <Card variant="default" className="p-6 sm:p-7 mb-5">
          {error && (
            <Alert status="danger" className="mb-4">
              <Alert.Description>{error}</Alert.Description>
            </Alert>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
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
            <div>
              <Label>{person.role === 'creator' ? 'Content niche' : 'Product category'}</Label>
              <Input value={form.category} onChange={set('category')} fullWidth />
            </div>
            <div><Label>Bio</Label><TextArea value={form.bio} onChange={set('bio')} fullWidth /></div>
            <div><Label>What are you looking for?</Label><TextArea value={form.looking_for} onChange={set('looking_for')} fullWidth /></div>
            <div><Label>Links (one per line)</Label><TextArea value={form.links} onChange={set('links')} fullWidth /></div>
            <div className="flex items-center gap-4 pt-1">
              <Button type="submit" variant="primary">Save Profile</Button>
              {saved && <span className="text-sm font-medium text-cyan-400">Saved ✓</span>}
            </div>
          </form>
        </Card>

        <Button variant="outline" onPress={() => navigate('/directory')}>Browse the directory &rarr;</Button>
      </div>
    </div>
  );
}
