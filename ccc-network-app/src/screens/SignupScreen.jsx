import { useState } from 'react';
import { BOOTH_ZONES } from '../lib/booth-zones';
import { Link as RouterLink } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Alert, Button, Card, Input, Label, ListBox, ListBoxItem, Select, Tabs, TextArea } from '@heroui/react';
import { signup } from '../api';

const BRAND_LOGO = 'https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png';

// Matches the actual required-field check in handleSubmit below — first
// name, email, looking_for always; brand_name only for role === 'brand'.
// Without this, clicking submit with any of those blank just shows a
// small inline error and nothing else happens, which reads as "the
// button doesn't work" if you don't know which fields are mandatory.
function Req() {
  return <span className="text-primary" aria-hidden="true"> *</span>;
}

const initialForm = {
  first_name: '', last_name: '', email: '', phone: '',
  tiktok_handle: '', instagram_handle: '', brand_name: '', category: '', bio: '', looking_for: '', links: '',
};

// Copy for every non-fresh-signup outcome of submitting an email that's
// already in ccc_people. This app is passwordless (magic-link only) —
// there's no "forgot password" to offer, so "log in" (send me a fresh
// link) is the actual equivalent. rejected/deactivated have no self-serve
// way back in at all: createMagicLink only ever issues a link for an
// approved account, so pointing those two at /login would be its own
// silent dead end — same class of bug just fixed on the confirmation-link
// error page.
const DUPLICATE_COPY = {
  approved: {
    title: 'You already have an account.',
    body: "This app doesn't use passwords — just log in and we'll email you a one-click link.",
    cta: 'login',
  },
  rejected: {
    title: "This email's application wasn't approved.",
    body: 'If you think that\'s a mistake, reach out to Tommy\'s team to sort it out.',
    cta: null,
  },
  deactivated: {
    title: 'This account has been deactivated.',
    body: "To reactivate it, reach out to Tommy's team — there's no self-serve way to undo a deactivation.",
    cta: null,
  },
};

export default function SignupScreen() {
  const [role, setRole] = useState('creator');
  // Tier is no longer self-reported — it decides who gets early roster access
  // and the contact export, so staff assign it in the admin. Brands now say
  // where they are on site instead, which is what other members actually want.
  const [boothZone, setBoothZone] = useState('capitol-canopy');
  const [boothNote, setBoothNote] = useState('');
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState(null); // { status } | null — approved/rejected/deactivated email already exists
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [resent, setResent] = useState(false); // true when this "done" was a resend to an already-pending signup, not a first one
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // Sharing contact details with sponsors is opt-in and starts off. The
  // server defaults share_contact to 0 too — the checkbox is the only way it
  // ever becomes 1, so an unchecked box and a skipped field behave the same.
  const [shareContact, setShareContact] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setDuplicate(null);
    if (!form.first_name || !form.email || !form.looking_for) {
      setError("First name, email, and what you're looking for are required.");
      return;
    }
    if (role === 'brand' && !form.brand_name) {
      setError('Brand name is required.');
      return;
    }
    if (!acceptedTerms) {
      setError('Please accept the roster terms to continue.');
      return;
    }

    setSubmitting(true);
    const payload = {
      role,
      booth_zone: role === 'brand' ? boothZone : '',
      booth_note: role === 'brand' && boothZone === 'other' ? boothNote : '',
      first_name: form.first_name,
      last_name: form.last_name,
      email: form.email,
      phone: form.phone,
      tiktok_handle: form.tiktok_handle,
      instagram_handle: form.instagram_handle,
      brand_name: form.brand_name,
      category: form.category,
      bio: form.bio,
      looking_for: form.looking_for,
      links: form.links.split('\n').map((s) => s.trim()).filter(Boolean).map((url) => ({ label: 'Link', url })),
      terms_accepted: acceptedTerms,
      share_contact: shareContact,
    };
    const j = await signup(payload);
    setSubmitting(false);
    if (j.ok) {
      toast.success(j.resent ? 'Sent a fresh confirmation link to your email.' : 'Check your email to confirm and activate your account.');
      setResent(!!j.resent);
      setDone(true);
      return;
    }
    if (j.error === 'already_registered') {
      setDuplicate({ status: j.status });
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
            <h2 className="font-display text-xl font-bold mb-2">{resent ? 'Already had you down.' : 'Almost there.'}</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {resent
                ? <>Looks like you&rsquo;d started signing up with this email before but never confirmed it — we&rsquo;ve sent a fresh confirmation link to <span className="text-foreground font-semibold">{form.email}</span>, and updated your details to what you just entered.</>
                : <>We&rsquo;ve sent a confirmation link to <span className="text-foreground font-semibold">{form.email}</span> — click it to activate your account and start connecting. No approval wait.</>
              } Didn&rsquo;t get it? Check spam, or it expires in 30 minutes and you can sign up again.
            </p>
          </Card>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center px-5 py-16">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[300px] sm:h-[360px] overflow-hidden">
        <img
          src="/ccc-network/carnival-hero.jpg"
          alt=""
          className="h-full w-full object-cover object-center opacity-60"
        />
        {/* Fades the photo into the page rather than ending on a hard edge. */}
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(to bottom, rgba(12,10,9,.35) 0%, rgba(12,10,9,.75) 55%, var(--color-background, #0c0a09) 100%)' }}
        />
      </div>

      <div className="relative w-full max-w-xl">
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
          <h1 className="font-display text-4xl sm:text-[2.75rem] font-black tracking-tight leading-[1.05] mb-4">
            Creator Carnival Marketplace
          </h1>
          <p className="text-sm text-foreground/75 leading-relaxed max-w-md mx-auto">
            Use this application to get the most out of your carnival experience — view the map, see the itinerary, and connect with creators &amp; brands.
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

          {duplicate && (
            <Alert status="danger" className="mb-4">
              <Alert.Title>{DUPLICATE_COPY[duplicate.status]?.title || 'That email is already on the roster.'}</Alert.Title>
              <Alert.Description>
                {DUPLICATE_COPY[duplicate.status]?.body || `Current status: ${duplicate.status}.`}
                {DUPLICATE_COPY[duplicate.status]?.cta === 'login' && (
                  <>
                    {' '}
                    <RouterLink to={`/login?email=${encodeURIComponent(form.email)}`} className="font-semibold underline">
                      Log in &rarr;
                    </RouterLink>
                  </>
                )}
              </Alert.Description>
            </Alert>
          )}

          <p className="text-[11px] text-muted-foreground mb-4">
            <span className="text-primary">*</span> Required
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>First name<Req /></Label><Input value={form.first_name} onChange={set('first_name')} placeholder="Jane" fullWidth /></div>
              <div><Label>Last name</Label><Input value={form.last_name} onChange={set('last_name')} placeholder="Smith" fullWidth /></div>
            </div>

            <div><Label>Email<Req /></Label><Input type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" fullWidth /></div>
            <div><Label>Phone (optional)</Label><Input value={form.phone} onChange={set('phone')} placeholder="(555) 555-5555" fullWidth /></div>

            <AnimatePresence mode="wait">
              <motion.div key={role} initial={{ opacity: 0, x: role === 'creator' ? -8 : 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2 }}>
                {role === 'creator' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div><Label>TikTok handle</Label><Input value={form.tiktok_handle} onChange={set('tiktok_handle')} placeholder="@yourhandle" fullWidth /></div>
                    <div><Label>Instagram handle (optional)</Label><Input value={form.instagram_handle} onChange={set('instagram_handle')} placeholder="@yourhandle" fullWidth /></div>
                  </div>
                ) : (
                  <div><Label>Brand name<Req /></Label><Input value={form.brand_name} onChange={set('brand_name')} placeholder="Your Brand" fullWidth /></div>
                )}
              </motion.div>
            </AnimatePresence>

            <div>
              <Label>{role === 'creator' ? 'Content niche' : 'Product category'}</Label>
              <Input value={form.category} onChange={set('category')} placeholder="e.g. Beauty, Fitness, Tech" fullWidth />
            </div>

            {role === 'brand' && (
              <div>
                <Label>Where will you be at the Carnival?</Label>
                <Select.Root selectedKey={boothZone} onSelectionChange={setBoothZone} aria-label="Booth location" fullWidth>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {BOOTH_ZONES.map((z) => <ListBoxItem key={z.id} id={z.id}>{z.label}</ListBoxItem>)}
                    </ListBox>
                  </Select.Popover>
                </Select.Root>

                {boothZone === 'other' && (
                  <div className="mt-3">
                    <Label>Tell us your situation</Label>
                    <TextArea
                      value={boothNote}
                      onChange={(e) => setBoothNote(e.target.value)}
                      placeholder="e.g. Marketplace Sponsor, activation partner, or attending to meet creators without a booth"
                      fullWidth
                    />
                  </div>
                )}

                <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                  Shown on your listing so creators can find you on the day. Sponsorship level is set by Tommy&rsquo;s team, not here.
                </p>
              </div>
            )}

            <div><Label>{role === 'creator' ? 'Short bio' : 'About the brand'}</Label><TextArea value={form.bio} onChange={set('bio')} placeholder="A couple sentences" fullWidth /></div>
            <div>
              <Label>{role === 'creator' ? 'What brands are you looking to work with?' : 'What kind of creators are you looking for?'}<Req /></Label>
              <TextArea value={form.looking_for} onChange={set('looking_for')} placeholder="e.g. Brands to collab with in the wellness space" fullWidth />
            </div>
            <div><Label>Links (one per line — portfolio, website, socials)</Label><TextArea value={form.links} onChange={set('links')} placeholder="https://..." fullWidth /></div>

            <div className="space-y-3 rounded-md border border-border bg-background/40 p-4">
              <label className="flex gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="text-[13px] leading-relaxed">
                  I agree to the{' '}
                  <RouterLink to="/terms" target="_blank" className="underline font-semibold" style={{ color: 'var(--color-accent-2)' }}>
                    roster terms
                  </RouterLink>
                  .<Req />
                </span>
              </label>

              <label className="flex gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={shareContact}
                  onChange={(e) => setShareContact(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="text-[13px] leading-relaxed">
                  Sponsoring brands can include my email and phone in their contact export.
                  <span className="block text-[11px] text-muted-foreground mt-0.5">
                    Optional. Leave this off and only people whose connection request you accept ever get your contact details. You can change it later in Settings.
                  </span>
                </span>
              </label>
            </div>

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
