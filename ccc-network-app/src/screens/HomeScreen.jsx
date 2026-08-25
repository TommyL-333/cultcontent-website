import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Card } from '@heroui/react';
import Topbar from '../components/Topbar';

// Noon ET on event day — matches the facts already live on the public
// marketing page (culture-commerce-carnival.html).
const EVENT_DATE = new Date('2026-09-12T12:00:00-04:00');

function useCountdown(target) {
  const [remaining, setRemaining] = useState(() => Math.max(0, target - Date.now()));
  useEffect(() => {
    const id = setInterval(() => setRemaining(Math.max(0, target - Date.now())), 1000);
    return () => clearInterval(id);
  }, [target]);
  const totalSeconds = Math.floor(remaining / 1000);
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    isPast: remaining <= 0,
  };
}

function TimeBlock({ value, label }) {
  return (
    <div className="flex flex-col items-center overflow-hidden">
      {/*
        Width is set in `ch` here, on the same element that carries the
        font/size/weight classes — `ch` measures against *this* element's
        own font metrics, not its child's. Setting it on the wrapper
        instead (with the text classes only on the child) sized the box
        against the inherited body font, not the actual displayed digits,
        and clipped them once the display font got bigger/bolder.
      */}
      <div className="relative h-12 sm:h-16 w-[2.2ch] font-display text-5xl sm:text-6xl font-black tracking-tight">
        <AnimatePresence mode="popLayout">
          <motion.div
            key={value}
            initial={{ y: 18, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -18, opacity: 0 }}
            transition={{ duration: 0.28, ease: 'easeOut' }}
            className="absolute inset-0 tabular-nums text-center"
          >
            {String(value).padStart(2, '0')}
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground mt-1.5">{label}</div>
    </div>
  );
}

// A rubber-stamp-style badge — a signature touch borrowed from a physical
// event pass, not a generic icon. See DESIGN.md.
function StampBadge() {
  return (
    <div
      aria-hidden
      className="absolute -right-2 -top-2 sm:right-4 sm:top-4 flex h-16 w-16 rotate-[9deg] items-center justify-center rounded-full border border-dashed text-center"
      style={{ borderColor: 'var(--color-gold)', color: 'var(--color-gold)' }}
    >
      <span className="text-[8px] font-bold uppercase leading-tight tracking-[.1em]">
        Nat&rsquo;l
        <br />
        Harbor
        <br />
        MD
      </span>
    </div>
  );
}

const PRIMARY_FACTS = [
  { label: 'Location', value: 'National Harbor, MD' },
  { label: 'Date', value: 'Sept 12, 2026' },
  { label: 'Attendees', value: '3,000+' },
];

const DETAIL_FACTS = [
  { label: 'Vendors', value: '100 On-Site' },
  { label: 'Samples', value: '20,000+' },
  { label: 'Broadcast', value: 'Live Streamed' },
];

// Same emoji vocabulary as the "what happens" cards on the actual event
// page (culture-commerce-carnival.html) — one visual language across
// both surfaces, not a coincidence.
const COVERAGE = [
  { emoji: '🎪', text: '100+ booths from beauty, wellness, food, apparel, and tech brands — all commerce-enabled on TikTok Shop, Amazon, or Shopify' },
  { emoji: '📸', text: 'Branded photo booths, activations, and moments designed to be filmed' },
  { emoji: '🎤', text: 'Creator matchmaking with brands, main stage panels & performances' },
  { emoji: '💸', text: 'Live from the floor — tag products, earn commission' },
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
};

export default function HomeScreen({ person }) {
  const t = useCountdown(EVENT_DATE.getTime());

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-3xl mx-auto px-5 pb-20">
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <span className="pill-glow pill-glow-cyan mb-4 -rotate-2">National Harbor, MD — 2026</span>
          <h1 className="font-display text-4xl sm:text-5xl font-black tracking-tight leading-[0.95] mb-3">
            Creator Carnival
          </h1>
          <p className="text-sm text-muted-foreground mb-5 leading-relaxed max-w-md">
            An outdoor carnival where creators meet brands, make connections, go live, and get paid.
          </p>
          <div className="candy-stripe w-24 mb-8" aria-hidden />
        </motion.div>

        {/* Ticket card — marquee lights, countdown, die-cut perforated tear line, ticket-stub facts below */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.1, ease: 'easeOut' }}
          className="card-glow-red relative rounded-md border border-border bg-card mb-4 overflow-hidden"
          style={{ boxShadow: '4px 4px 0 0 var(--color-accent-2)' }}
        >
          <div className="marquee-lights" aria-hidden />
          <StampBadge />

          <div className="relative px-6 sm:px-8 pt-7 pb-6 text-center">
            {t.isPast ? (
              <div className="font-display text-xl font-black text-primary">It&rsquo;s happening — see you on the floor.</div>
            ) : (
              <>
                <div className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground mb-4">
                  Counting down to Creator Carnival
                </div>
                <div className="flex items-center justify-center gap-5 sm:gap-8">
                  <TimeBlock value={t.days} label="Days" />
                  <TimeBlock value={t.hours} label="Hrs" />
                  <TimeBlock value={t.minutes} label="Min" />
                  <TimeBlock value={t.seconds} label="Sec" />
                </div>
              </>
            )}
          </div>

          <div className="relative">
            <span className="ticket-notch ticket-notch-left" aria-hidden />
            <span className="ticket-notch ticket-notch-right" aria-hidden />
            <hr className="ticket-perf" />
          </div>

          <div className="relative grid grid-cols-3 divide-x divide-border">
            {PRIMARY_FACTS.map((f) => (
              <div key={f.label} className="px-3 py-4 text-center">
                <div className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground mb-1">{f.label}</div>
                <div className="text-sm font-black">{f.value}</div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Detail facts — small chips, deliberately not the same shape as the ticket-stub row above.
            Alternating tilts on purpose — a perfectly level row of identical pills is exactly
            the too-tidy grid look that reads as machine-generated. */}
        <motion.div variants={container} initial="hidden" animate="show" className="flex flex-wrap gap-3 mb-8">
          {DETAIL_FACTS.map((f, i) => (
            <motion.div
              key={f.label}
              variants={item}
              className={`pill-glow pill-glow-gold ${i % 2 === 0 ? 'rotate-1' : '-rotate-1'}`}
            >
              <span className="opacity-70">{f.label}</span>
              <span>{f.value}</span>
            </motion.div>
          ))}
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.5 }}>
          <Card variant="default" className="card-glow-cyan rounded-md p-6">
            <div className="text-xs font-bold uppercase tracking-[.14em] text-muted-foreground mb-4">What the day covers</div>
            <ul className="space-y-3.5">
              {COVERAGE.map((line) => (
                <li key={line.text} className="flex gap-3 text-sm text-foreground/90 leading-relaxed">
                  <span className="shrink-0 text-lg leading-none" aria-hidden>{line.emoji}</span>
                  <span>{line.text}</span>
                </li>
              ))}
            </ul>
            <a
              href="/culture-commerce-carnival"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 mt-6 rounded-lg px-5 py-2.5 text-sm font-extrabold tracking-tight"
              style={{ background: 'var(--color-accent-2)', color: 'var(--color-accent-2-foreground)' }}
            >
              Full event details &rarr;
            </a>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
