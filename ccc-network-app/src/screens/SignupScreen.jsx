import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Alert, Button, Card, Input, Label, ListBox, ListBoxItem, Select, Tabs, TextArea } from '@heroui/react';
import { signup } from '../api';

const BRAND_LOGO = 'https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png';

const initialForm = {
  first_name: '', last_name: '', email: '', phone: '',
  handle: '', brand_name: '', category: '', bio: '', looking_for: '', links: '',
};

export default function SignupScreen() {
  const [role, setRole] = useState('creator');
  const [tier, setTier] = useState('general');
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!form.first_name || !form.email || !form.looking_for) {
      setError("First name, email, and what you're looking for are required.");
      return;
    }
    if (role === 'brand' && !form.brand_name) {
      setError('Brand name is required.');
      return;
    }

    setSubmitting(true);
    const payload = {
      role,
      tier,
      first_name: form.first_name,
      last_name: form.last_name,
      email: form.email,
      phone: form.phone,
      handle: form.handle,
      brand_name: form.brand_name,
      category: form.category,
      bio: form.bio,
      looking_for: form.looking_for,
      links: form.links.split('\n').map((s) => s.trim()).filter(Boolean).map((url) => ({ label: 'Link', url })),
    };
    const j = await signup(payload);
    setSubmitting(false);
    if (j.ok) { toast.success('Check your email to confirm and activate your account.'); setDone(true); return; }
    if (j.error === 'already_registered') {
      setError(`That email is already on the roster (status: ${j.status}). Try logging in instead.`);
    } else {
      setError(j.error || 'Something went wrong.');
      toast.error(j.error || 'Something went wrong.');
    }
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center px-5 py-16">
        <motion.div
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="w-full max-w-xl text-center"
        >
          <Card variant="default" className="p-8">
            <h2 className="font-display text-xl font-bold mb-2">Almost there.</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              We&rsquo;ve sent a confirmation link to <span className="text-foreground font-semibold">{form.email}</span> — click it to activate your account and start connecting. No approval wait. Didn&rsquo;t get it? Check spam, or it expires in 30 minutes and you can sign up again.
            </p>
          </Card>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-16">
      <div className="w-full max-w-xl">
        <motion.a
          href="https://cultcontent.cc"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="flex items-center justify-center gap-2.5 mb-10"
        >
          <img src={BRAND_LOGO} alt="Cult Content" className="h-6" />
          <span className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Creator Carnival</span>
        </motion.a>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05 }} className="text-center mb-8">
          <h1 className="font-display text-4xl sm:text-[2.75rem] font-bold leading-[1.08] mb-4">Meet your collab era.</h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-md mx-auto">
            1,000+ creators and 100+ brands, all in one roster. Sign up, confirm your email, and start connecting before you even set foot on the floor.
          </p>
        </motion.div>

        <Tabs selectedKey={role} onSelectionChange={setRole} className="mb-5">
          <Tabs.List>
            <Tabs.Tab id="creator">I&rsquo;m a Creator</Tabs.Tab>
            <Tabs.Tab id="brand">I&rsquo;m a Brand</Tabs.Tab>
          </Tabs.List>
          {/* Role switching drives the form fields below directly via state —
              these panels stay empty, they just satisfy Tabs' expected structure. */}
          <Tabs.Panel id="creator" />
          <Tabs.Panel id="brand" />
        </Tabs>

        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }}>
        <Card variant="default" className="p-6 sm:p-7">
          {error && (
            <Alert status="danger" className="mb-4">
              <Alert.Description>{error}</Alert.Description>
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>First name</Label><Input value={form.first_name} onChange={set('first_name')} placeholder="Jane" fullWidth /></div>
              <div><Label>Last name</Label><Input value={form.last_name} onChange={set('last_name')} placeholder="Smith" fullWidth /></div>
            </div>

            <div><Label>Email</Label><Input type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" fullWidth /></div>
            <div><Label>Phone (optional)</Label><Input value={form.phone} onChange={set('phone')} placeholder="(555) 555-5555" fullWidth /></div>

            <AnimatePresence mode="wait">
              <motion.div key={role} initial={{ opacity: 0, x: role === 'creator' ? -8 : 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2 }}>
                {role === 'creator' ? (
                  <div><Label>TikTok / IG handle</Label><Input value={form.handle} onChange={set('handle')} placeholder="@yourhandle" fullWidth /></div>
                ) : (
                  <div><Label>Brand name</Label><Input value={form.brand_name} onChange={set('brand_name')} placeholder="Your Brand" fullWidth /></div>
                )}
              </motion.div>
            </AnimatePresence>

            <div>
              <Label>{role === 'creator' ? 'Content niche' : 'Product category'}</Label>
              <Input value={form.category} onChange={set('category')} placeholder="e.g. Beauty, Fitness, Tech" fullWidth />
            </div>

            {role === 'brand' && (
              <div>
                <Label>Which sponsorship did you book?</Label>
                <Select.Root selectedKey={tier} onSelectionChange={setTier} aria-label="Sponsorship tier" fullWidth>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBoxItem id="general">Booth / Community Vendor / Other</ListBoxItem>
                      <ListBoxItem id="priority">Marketplace or Carnival Sponsor (priority access)</ListBoxItem>
                      <ListBoxItem id="executive">Executive Experience</ListBoxItem>
                    </ListBox>
                  </Select.Popover>
                </Select.Root>
                <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">This is self-reported — Tommy's team can adjust it later if needed.</p>
              </div>
            )}

            <div><Label>{role === 'creator' ? 'Short bio' : 'About the brand'}</Label><TextArea value={form.bio} onChange={set('bio')} placeholder="A couple sentences" fullWidth /></div>
            <div>
              <Label>{role === 'creator' ? 'What brands are you looking to work with?' : 'What kind of creators are you looking for?'}</Label>
              <TextArea value={form.looking_for} onChange={set('looking_for')} placeholder="e.g. Brands to collab with in the wellness space" fullWidth />
            </div>
            <div><Label>Links (one per line — portfolio, website, socials)</Label><TextArea value={form.links} onChange={set('links')} placeholder="https://..." fullWidth /></div>

            <Button type="submit" variant="primary" fullWidth isDisabled={submitting}>
              {submitting ? 'Submitting…' : 'Join the Roster →'}
            </Button>
          </form>

          <div className="text-center mt-5">
            <RouterLink to="/login" className="text-[13px] text-muted-foreground hover:text-accent-2 transition-colors">Already have an account? Log in &rarr;</RouterLink>
          </div>
        </Card>
        </motion.div>

        <div className="text-center mt-8 text-[11px] text-muted-foreground tracking-wide">
          September 12, 2026 · National Harbor, MD &nbsp;&middot;&nbsp;
          <a href="/culture-commerce-carnival" className="hover:text-accent-2 transition-colors"> Full event details</a>
        </div>
      </div>
    </div>
  );
}
