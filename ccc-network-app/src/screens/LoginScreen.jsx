import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Button, Card, Input, Label } from '@heroui/react';
import { requestLogin } from '../api';

const BRAND_LOGO = 'https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email) return;
    setSubmitting(true);
    await requestLogin(email);
    setSubmitting(false);
    setSent(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm text-center">
        <a href="https://cultcontent.cc" className="flex items-center justify-center gap-2.5 mb-10">
          <img src={BRAND_LOGO} alt="Cult Content" className="h-6" />
          <span className="text-[11px] font-bold uppercase tracking-[.14em] text-zinc-400">Creator Carnival</span>
        </a>

        {sent ? (
          <Card variant="default" className="p-8">
            <h1 className="text-lg font-bold mb-2">Check your inbox</h1>
            <p className="text-sm text-zinc-400 leading-relaxed">If that email is on the roster, a login link is on its way — it expires in 30 minutes.</p>
          </Card>
        ) : (
          <>
            <h1 className="text-2xl font-extrabold tracking-tight mb-2.5">Welcome back.</h1>
            <p className="text-sm text-zinc-400 leading-relaxed mb-6">Enter the email you registered with — we&rsquo;ll send you a one-click login link.</p>
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
              <RouterLink to="/" className="text-[13px] text-zinc-400 hover:text-cyan-400 transition-colors">Not on the roster yet? Sign up &rarr;</RouterLink>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
