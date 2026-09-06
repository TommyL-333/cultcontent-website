import { useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Button, Card, Input, Label } from '@heroui/react';
import { requestLogin } from '../api';

const BRAND_LOGO = 'https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png';

export default function LoginScreen() {
  // Lets SignupScreen deep-link here with ?email=... when someone tries to
  // sign up with an address that already has an approved account — saves
  // retyping it.
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState(searchParams.get('email') || '');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email) return;
    setSubmitting(true);
    await requestLogin(email);
    setSubmitting(false);
    setSent(true);
    toast.success('Check your inbox for a login link.');
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm text-center">
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

        <AnimatePresence mode="wait">
          {sent ? (
            <motion.div key="sent" initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.4, ease: 'easeOut' }}>
              <Card variant="default" className="p-8">
                <h1 className="font-display text-lg font-bold mb-2">Check your inbox</h1>
                <p className="text-sm text-muted-foreground leading-relaxed">If that email is on the roster, a login link is on its way — it expires in 30 minutes.</p>
                {/* Login sends nothing at all for an address with no account, or
                    one that never confirmed its email. Both are silent by design
                    (we don't confirm whether an address is registered), so the
                    only way out is to say what to do when nothing arrives. */}
                <p className="text-[13px] text-muted-foreground leading-relaxed mt-4 pt-4 border-t border-border">
                  Nothing after a minute? Check spam — then{' '}
                  <RouterLink to="/" className="underline font-semibold" style={{ color: 'var(--color-accent-2)' }}>
                    sign up with the same email
                  </RouterLink>
                  . That works whether you&rsquo;re brand new or just never confirmed your address, and it&rsquo;ll tell you which.
                </p>
              </Card>
            </motion.div>
          ) : (
            <motion.div key="form" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.3 }}>
              <h1 className="font-display text-2xl font-bold mb-2.5">Welcome back.</h1>
              <p className="text-sm text-muted-foreground leading-relaxed mb-6">Enter the email you registered with — we&rsquo;ll send you a one-click login link.</p>
              <Card variant="default" className="p-6 text-left">
                <form onSubmit={handleSubmit}>
                  <Label>Email</Label>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" fullWidth />
                  <Button type="submit" variant="primary" fullWidth className="mt-4" isDisabled={submitting}>
                    {submitting ? 'Sending…' : 'Send Login Link →'}
                  </Button>
                </form>
              </Card>
              <div className="mt-6">
                <RouterLink to="/" className="text-[13px] text-muted-foreground hover:text-accent-2 transition-colors">Not on the roster yet? Sign up &rarr;</RouterLink>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
