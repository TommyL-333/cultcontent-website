import { Link } from 'react-router-dom';

/**
 * Plain-English terms for the Networking Roster.
 *
 * Scoped deliberately narrowly: this covers what the *app* does with a
 * person's data (who can see what, when contact details are released, how to
 * get out). It is not event terms, ticket terms, or booth-vendor terms —
 * those live with the ticketing and booth contracts.
 *
 * Reachable without a session, because someone has to be able to read it
 * before they agree to it on the signup form.
 */

const SECTIONS = [
  {
    h: 'What this is',
    p: [
      'The Creator Carnival Networking Roster is a directory that lets creators and brands attending Creator Carnival (September 12, 2026, National Harbor, MD) find each other, request connections, and message each other before and during the event.',
      'It is operated by Cult Content. Creating an account here is not a ticket to the event and does not register you for it.',
    ],
  },
  {
    h: 'What other people can see',
    p: [
      'Your name, role, brand name, category, bio, social handles, links, and what you’re looking for are visible to every approved member of the roster. Treat your profile as public within the event.',
      'Your email address and phone number are not shown in the directory.',
    ],
  },
  {
    h: 'When your contact details get shared',
    p: [
      'Your email and phone are released in exactly two situations:',
    ],
    list: [
      'To someone you have an accepted connection with. A connection request has to be accepted by both sides before either of you sees the other’s contact details — accepting a request is what releases them.',
      'If you’re a creator: to sponsoring brands, in a contact export, but only if you have ticked the contact-sharing box. That box is off by default. If you never tick it, your details are never included in any export, no matter who asks.',
      'If you’re a brand: to creators browsing the roster, but only if you have ticked the box saying creators can contact you directly. That box is off by default, and it releases your details to creators only — other brands still have to send you a connection request.',
    ],
    after: [
      'You can turn contact sharing on or off at any time in Settings. Turning it off stops your details appearing in any future export. It cannot claw back an export a sponsor already downloaded.',
    ],
  },
  {
    h: 'Messaging',
    p: [
      'You can only message people you have an accepted connection with. Messages are stored so the thread is there when you come back, and are readable by Cult Content staff for moderation and support.',
      'Don’t use the messaging to send bulk pitches, spam, or anything you wouldn’t say to someone at their booth.',
    ],
  },
  {
    h: 'Challenges',
    p: [
      'Brands can post challenges. If you enter one by linking a post, the brand that posted that challenge sees your name, your handles, your note, and the link you submitted. Other brands do not.',
      'Linking a post doesn’t transfer any rights in it. Whatever a brand may do with your content is between you and that brand — any paid or licensed use needs its own agreement, and this roster isn’t one.',
      'You can withdraw an entry at any time while the challenge is open.',
    ],
  },
  {
    h: 'Your account',
    p: [
      'Login is passwordless — we email you a link. Keep access to your email address secure, since anyone who can read your inbox can sign in as you.',
      'You can deactivate your account in Settings at any time, which removes you from the directory and stops any further sharing.',
      'We may remove or deactivate an account that is spamming, impersonating someone, or otherwise abusing the roster.',
    ],
  },
  {
    h: 'Data and email',
    p: [
      'We store what you enter on the signup and profile forms, your connections, and your messages. Transactional email (confirmation and notification) is sent through Resend. Your contact record may also be synced to our CRM so our team can support you around the event.',
      'To get a copy of your data or have it deleted, email tommy@cultcontent.cc.',
    ],
  },
  {
    h: 'The boring part',
    p: [
      'The roster is provided as-is for the purposes of the event. We don’t guarantee any particular connection, deal, or outcome from using it, and we’re not a party to whatever you and another member agree between yourselves.',
      'If these terms change in a way that affects how your data is shared, we’ll tell you by email before it takes effect.',
    ],
  },
];

export default function TermsScreen() {
  return (
    <div className="max-w-2xl mx-auto px-5 py-12 pb-24">
      <Link to="/" className="text-xs font-bold text-muted-foreground hover:text-foreground">&larr; Back</Link>

      <div className="mt-7 mb-4">
        <span className="pill-glow pill-glow-gold -rotate-2">Creator Carnival</span>
      </div>
      <h1 className="font-display text-3xl sm:text-4xl font-black tracking-tight leading-[0.95] mb-2">
        Roster Terms
      </h1>
      <p className="text-sm text-muted-foreground mb-1">
        The short version: your profile is visible to the roster, your contact details are not — unless you accept a connection, or opt in to sponsor sharing.
      </p>
      <p className="text-[11px] text-muted-foreground mb-6">Last updated 6 September 2026.</p>
      <div className="candy-stripe w-24 mb-9" aria-hidden />

      <div className="space-y-8">
        {SECTIONS.map((s) => (
          <section key={s.h}>
            <h2 className="font-display text-lg font-black tracking-tight mb-2.5">{s.h}</h2>
            {s.p.map((para) => (
              <p key={para} className="text-[13px] text-foreground/80 leading-relaxed mb-2.5">{para}</p>
            ))}
            {s.list && (
              <ul className="space-y-2 my-3">
                {s.list.map((li) => (
                  <li key={li} className="flex gap-2.5 text-[13px] text-foreground/80 leading-relaxed">
                    <span className="shrink-0 mt-[7px] h-1.5 w-1.5 rounded-full" style={{ background: 'var(--color-accent)' }} aria-hidden />
                    <span>{li}</span>
                  </li>
                ))}
              </ul>
            )}
            {s.after?.map((para) => (
              <p key={para} className="text-[13px] text-foreground/80 leading-relaxed mb-2.5">{para}</p>
            ))}
          </section>
        ))}
      </div>

      <p className="mt-12 pt-6 border-t border-border text-xs text-muted-foreground">
        Questions about any of this: <a href="mailto:tommy@cultcontent.cc" className="underline">tommy@cultcontent.cc</a>
      </p>
    </div>
  );
}
