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
      <div className="relative h-10 sm:h-12 w-[2ch]">
        <AnimatePresence mode="popLayout">
          <motion.div
            key={value}
            initial={{ y: 18, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -18, opacity: 0 }}
            transition={{ duration: 0.28, ease: 'easeOut' }}
            className="absolute inset-0 text-3xl sm:text-4xl font-extrabold tabular-nums tracking-tight text-center"
          >
            {String(value).padStart(2, '0')}
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 mt-1">{label}</div>
    </div>
  );
}

const FACTS = [
  { label: 'Location', value: 'National Harbor, MD' },
  { label: 'Date', value: 'Sept 12, 2026' },
  { label: 'Attendees', value: '3,000+' },
  { label: 'Vendors', value: '100 On-Site' },
  { label: 'Samples', value: '20,000+' },
  { label: 'Broadcast', value: 'Live Streamed' },
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
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-2">Creator Carnival</h1>
          <p className="text-sm text-zinc-400 mb-8">National Harbor, MD — an outdoor carnival where creators meet brands, make connections, go live, and get paid.</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.45, delay: 0.1, ease: 'easeOut' }}
          className="relative rounded-xl border border-border bg-card shadow-sm p-6 sm:p-8 mb-6 text-center overflow-hidden"
        >
          <motion.div
            aria-hidden
            className="pointer-events-none absolute -inset-24 opacity-30"
            style={{ background: 'radial-gradient(circle, rgba(0,194,203,0.35), transparent 60%)' }}
            animate={{ rotate: 360 }}
            transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
          />
          <div className="relative">
            {t.isPast ? (
              <div className="text-lg font-bold text-primary">It&rsquo;s happening — see you on the floor.</div>
            ) : (
              <>
                <div className="text-[11px] font-bold uppercase tracking-wide text-zinc-500 mb-4">Counting down to Creator Carnival</div>
                <div className="flex items-center justify-center gap-5 sm:gap-8">
                  <TimeBlock value={t.days} label="Days" />
                  <TimeBlock value={t.hours} label="Hrs" />
                  <TimeBlock value={t.minutes} label="Min" />
                  <TimeBlock value={t.seconds} label="Sec" />
                </div>
              </>
            )}
          </div>
        </motion.div>

        <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
          {FACTS.map((f) => (
            <motion.div key={f.label} variants={item}>
              <Card variant="default" className="p-4 text-center">
                <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500 mb-1">{f.label}</div>
                <div className="text-sm font-bold">{f.value}</div>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.5 }}>
          <Card variant="default" className="p-6">
            <div className="text-xs font-bold uppercase tracking-wide text-zinc-500 mb-3">What the day covers</div>
            <ul className="space-y-2 text-sm text-zinc-300 leading-relaxed list-disc list-inside">
              <li>100+ booths from beauty, wellness, food, apparel, and tech brands — all commerce-enabled on TikTok Shop, Amazon, or Shopify</li>
              <li>Branded photo booths, activations, and moments designed to be filmed</li>
              <li>Creator matchmaking with brands, main stage panels &amp; performances</li>
              <li>Live from the floor — tag products, earn commission</li>
            </ul>
            <a href="/culture-commerce-carnival" target="_blank" rel="noreferrer" className="inline-block mt-4 text-sm text-primary hover:underline">Full event details &rarr;</a>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
