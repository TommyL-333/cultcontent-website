import { Link as RouterLink } from 'react-router-dom';
import Topbar from '../components/Topbar';

/**
 * How to actually use the roster.
 *
 * Role-aware: a creator and a brand are doing almost opposite things here,
 * and a single merged list of steps makes both of them read past half of it.
 *
 * VIDEOS is intentionally empty and rendered only when populated — walkthrough
 * videos are being recorded separately. Drop {title, url} entries in and the
 * section appears; no other change needed.
 */

const VIDEOS = [];

const STEPS = {
  creator: [
    {
      h: 'Finish your profile',
      p: 'Photo, bio, niche, handles, and what you want out of the day. Brands browse the roster before the event and a blank profile gets scrolled past. Your home screen tracks what’s still missing.',
      to: '/settings',
      cta: 'Edit profile',
    },
    {
      h: 'Set your rates — privately',
      p: 'Add your typical package, your rate, and the contract terms you want. This is never shown in the directory and never included in a sponsor export. Only a brand whose connection request you’ve accepted can see it, so you don’t get filtered on price before a conversation.',
      to: '/settings',
      cta: 'Add rates',
    },
    {
      h: 'Browse brands and connect',
      p: 'The Directory opens on Brands. Each listing says what that brand is looking for — some want a specific campaign, some just want to meet creators. Connecting sends a request; nobody’s contact details are revealed until it’s accepted on both sides.',
      to: '/directory',
      cta: 'Browse brands',
    },
    {
      h: 'Take on a brief',
      p: 'Brands post briefs with a reward and a deadline. Make the post, paste the link, and it lands in that brand’s entry list with your handles attached. You can swap the link or withdraw any time while the brief is open.',
      to: '/challenges',
      cta: 'See briefs',
    },
    {
      h: 'Plan your day',
      p: 'Creator early access opens at 10am, an hour before general admission — that’s your window on the floor before the crowd. Check the Exhibitors list for who’s confirmed.',
      to: '/schedule',
      cta: 'See the schedule',
    },
  ],
  brand: [
    {
      h: 'Finish your brand profile',
      p: 'Logo, category, what your brand does, and — most importantly — what you’re looking for. Be specific. "Designing a content campaign around our Costco launch" gets far better inbound than "looking to connect with creators".',
      to: '/settings',
      cta: 'Edit profile',
    },
    {
      h: 'Post a brief',
      p: 'A brief is a concrete ask: what to make, what you’re paying, by when. Creators link their posts back to it and every entry lands in one place with their handles. Open briefs show on your directory listing, so they pull creators toward you rather than you chasing them.',
      to: '/challenges',
      cta: 'Post a brief',
    },
    {
      h: 'Browse creators and connect',
      p: 'The Directory opens on Creators. Connecting sends a request — once they accept, you both see contact details, and their rates and ideal terms if they’ve set them.',
      to: '/directory',
      cta: 'Browse creators',
    },
    {
      h: 'Message the people who accept',
      p: 'Messaging only opens between people with an accepted connection, so your inbox stays signal. Sort out the details there before the day.',
      to: '/inbox',
      cta: 'Open inbox',
    },
  ],
};

const FAQ = [
  {
    q: 'Why is there no password?',
    a: 'There isn’t one anywhere in the system. Logging in emails you a one-click link that expires in 30 minutes — that link is both the login and the recovery. If nothing arrives, check spam, then sign up again with the same email: that works whether you’re brand new or just never confirmed your address.',
  },
  {
    q: 'Who can see my email and phone?',
    a: 'Only people whose connection request you’ve accepted — accepting is what releases them. Sponsoring brands can also include them in a contact export, but only if you’ve ticked that box; it’s off unless you turn it on, in Settings.',
  },
  {
    q: 'Does an account here get me into the event?',
    a: 'No. The roster is for finding people and setting things up beforehand. Tickets and booths are separate.',
  },
  {
    q: 'Where’s the site map?',
    a: 'Not published yet — the floor plan isn’t final, and a wrong map sends people to the wrong end of the site. The Exhibitors list shows who’s confirmed in the meantime, and the map goes up once the layout is locked.',
  },
];

export default function GuideScreen({ person }) {
  const steps = STEPS[person.role] ?? STEPS.creator;

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-2xl mx-auto px-5 pb-20">
        <span className="pill-glow pill-glow-cyan mb-4 -rotate-2">
          {person.role === 'brand' ? 'For brands' : 'For creators'}
        </span>
        <h1 className="font-display text-3xl sm:text-4xl font-black tracking-tight leading-[0.95] mb-2">How this works</h1>
        <p className="text-sm text-muted-foreground mb-5 leading-relaxed max-w-md">
          Five minutes of setup now is worth more than an hour on the floor. Here&rsquo;s the order to do it in.
        </p>
        <div className="candy-stripe w-24 mb-9" aria-hidden />

        {VIDEOS.length > 0 && (
          <div className="mb-10">
            <div className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground mb-3">Walkthroughs</div>
            <div className="space-y-2">
              {VIDEOS.map((v) => (
                <a
                  key={v.url} href={v.url} target="_blank" rel="noreferrer"
                  className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm font-semibold hover:border-primary"
                >
                  <span aria-hidden>▶</span> {v.title}
                </a>
              ))}
            </div>
          </div>
        )}

        <ol className="space-y-4 mb-12">
          {steps.map((s, i) => (
            <li key={s.h} className="flex gap-4">
              <span
                className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-black tabular-nums"
                style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
                aria-hidden
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 rounded-md border border-border bg-card p-4">
                <h2 className="font-display text-lg font-black tracking-tight mb-1.5">{s.h}</h2>
                <p className="text-[13px] text-foreground/80 leading-relaxed">{s.p}</p>
                <RouterLink
                  to={s.to}
                  className="inline-block mt-3 text-xs font-bold underline"
                  style={{ color: 'var(--color-accent-2)' }}
                >
                  {s.cta} &rarr;
                </RouterLink>
              </div>
            </li>
          ))}
        </ol>

        <h2 className="font-display text-2xl font-black tracking-tight mb-4">Common questions</h2>
        <div className="space-y-5">
          {FAQ.map((f) => (
            <div key={f.q}>
              <h3 className="text-sm font-bold mb-1.5">{f.q}</h3>
              <p className="text-[13px] text-foreground/80 leading-relaxed">{f.a}</p>
            </div>
          ))}
        </div>

        <p className="mt-10 pt-6 border-t border-border text-xs text-muted-foreground">
          Stuck on something? <a href="mailto:tommy@cultcontent.cc" className="underline">tommy@cultcontent.cc</a>
        </p>
      </div>
    </div>
  );
}
