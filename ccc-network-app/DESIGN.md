# Creator Carnival Network — Design System

Source of truth for visual decisions in this app. Written to stop the app
from drifting back to default HeroUI/Tailwind-agent output (Inter,
`rounded-xl` + `shadow-sm` on everything, a stray teal accent, uniform
3-card grids). Extend this file before extending a screen.

## Why this exists

The app previously used Inter for all text, a generic teal accent
unrelated to the brand, `rounded-xl border shadow-sm` on every card, and a
uniform icon/stat grid — the standard tells of an unstyled AI scaffold.
`culture-commerce-carnival.html` (the actual event marketing page) already
has a real brand: `--red: #FF0050`, `--cyan: #00F2EA`, `--gold: #F5A623`
on near-black. The network app should look like it belongs to that event,
not like a generic SaaS dashboard bolted on next to it.

Metaphor for the whole app: **a physical event pass / ticket stub**, not a
"dashboard." Countdown, facts, and stats should read like the front of a
festival ticket — condensed numerals, a perforated tear line, ink-stamp
accent marks — rather than rounded cards in a grid.

## Typography

Two fonts, never Inter — and never a bold display grotesk either (Space
Grotesk / Bricolage Grotesque / Sora have become their own AI-scaffold
tell; nearly every vibecoded landing page reaches for one now):

- **Display / numerals / headlines** — `Source Serif 4`, a serif. Used
  for every screen's `h1`/`h2`, the countdown digits, and any large
  standalone number — app-wide, not just one screen. Serif headlines are
  a register almost no AI-generated app uses (they default to
  sans-everything), and a serif is the classic trust signal — it's what
  news mastheads, financial institutions, and credential/ID documents use
  to read as authoritative rather than "startup demo." Chose Source
  Serif over a more decorative serif (e.g. Fraunces) deliberately: its
  terminals are straight and restrained rather than soft/bubbly — reads
  professional/institutional, not boutique-editorial. Use `font-bold`,
  not `font-normal`/`font-extrabold` — serifs need more weight than sans
  at display sizes to hold up, but Source Serif's own bold is already
  assertive enough without going heavier. Don't pair it with
  `tracking-tight` — that's a sans/grotesk convention that fights a
  serif's natural proportions.
- **Body / UI text** — `Public Sans`. Used for paragraphs, labels,
  buttons, nav. Not a random pick: it's the official typeface of the
  U.S. federal government's web design system (USWDS), built explicitly
  for institutional trust and accessibility — and it's outside the
  standard AI-tool font rotation (Inter/Roboto/Poppins/Manrope/DM Sans).

Tailwind utilities: `font-display` (Bricolage Grotesque) and `font-sans`
(Public Sans, the default — no class needed for body text).

Type scale (use these, not arbitrary `text-[Npx]` values, except for the
countdown digits which are intentionally huge):

| Token | Size / line-height | Use |
|---|---|---|
| `text-xs` | 12px / 16px | eyebrow labels, meta |
| `text-sm` | 14px / 20px | body, form labels |
| `text-base` | 16px / 24px | primary body copy |
| `text-xl` | 20px / 28px | card headings |
| `text-3xl` | 30px / 36px | screen H1 |
| `text-6xl`+ | 60px+ | countdown digits, hero numerals only |

Eyebrow labels (`COUNTING DOWN TO...`, `LOCATION`, etc.) stay uppercase +
letter-spaced, but in `font-sans` at `text-xs font-bold tracking-[.14em]`
— never the display font at small sizes, it gets illegible.

## Color

Dark, warm, and rooted in the existing brand — not a cool gray "AI dark
mode." Defined as CSS variables in `index.css`, consumed via Tailwind
tokens (`bg-background`, `text-foreground`, `bg-accent`, etc.).

| Token | Value | Use |
|---|---|---|
| `--background` | `#0c0a09` (warm near-black) | page background |
| `--foreground` | `#f5f1ea` (warm cream, "ticket paper") | primary text |
| `--surface` | `#161311` | cards |
| `--surface-secondary` | `#1e1a17` | nested/secondary surfaces |
| `--border` | `#2b2622` | hairlines, dividers |
| `--muted` | `#9c9188` (warm gray) | secondary text — **not** `text-zinc-*`, which is a cool gray left over from the default scaffold |
| `--accent` (red) | `#FF0050` | primary CTA, live/urgent state |
| `--accent-2` (cyan) | `#00F2EA` | secondary highlight, links, active nav |
| `--gold` | `#F5A623` | tertiary accent — badges, stamps, dividers |

Rules:
- One accent leads per screen/component. Don't rainbow every element —
  red for the primary action, cyan for a secondary highlight or link,
  gold used sparingly as a detail (a stamp, a dot, a divider), never as a
  large fill.
- No purple/indigo, no gradient-on-white-card default. The one permitted
  gradient is a tight radial "spotlight" behind a focal element, using an
  actual brand color, not a generic violet blob.
- Existing `text-zinc-400`/`text-zinc-500` utility classes are legacy from
  the scaffold — replace with `text-muted-foreground` as each screen is
  touched, don't leave both systems mixed within one file.

## Shape & depth

- Base radius is tighter than the HeroUI default: `6px`, not `8–12px`.
  Nothing gets `rounded-xl`/`rounded-2xl`/`rounded-full` except things
  that are actually circular (avatars, unread badges).
- Depth comes from a **hard offset shadow**, not a soft ambient blur:
  `shadow-[3px_3px_0_0_var(--color-border)]` (or the accent color on a
  highlighted element) instead of `shadow-sm`. This reads as a printed
  ticket/card, not a floating SaaS panel. Use it on the 1–2 focal
  elements per screen, not on every card — restraint is what makes it
  read as intentional.
- A perforated divider (`border-dashed` circles via
  `repeating-linear-gradient`, see `HomeScreen.jsx`'s `.ticket-perf`
  class) marks a literal tear-line between sections of the event-pass
  card. This is the one deliberately "unusual" component — use it once
  per screen at most.

## Motion

Keep using `motion` (Framer Motion), but:
- Entrances: `y: 10–14px, opacity 0 → 1`, `duration 0.3–0.45s`,
  `ease: 'easeOut'`. Stagger children at `0.05–0.08s`.
- Numeral changes (countdown, stats): the existing slot-machine digit
  roll in `HomeScreen.jsx` is the pattern — reuse it for any live-updating
  number, don't just re-render in place.
- No motion for motion's sake — a spinning gradient blob is exactly the
  kind of "AI demo" flourish this system avoids. Prefer a static
  spotlight or none.

## Layout patterns to avoid

- Centered hero + single CTA + three identical icon cards below it.
- Every card the same `rounded-xl border shadow-sm p-6` shape.
- A stat grid where every cell is visually identical (same border, same
  radius, same weight) — vary at least one shape/axis (e.g. a horizontal
  ticket strip with tick marks, not a 2×3 card grid).

## Status

Typography (fonts + `font-display` on every screen headline) is applied
app-wide. The rest of the system — ticket/pass shape language, offset
shadows, brand color usage, layout patterns — is only applied to
`HomeScreen.jsx` (pilot) so far. Remaining screens (`LoginScreen`,
`SignupScreen`, `DirectoryScreen`, `ConnectionsScreen`,
`PersonProfileScreen`, `InboxScreen`, `ProfileScreen`, `SettingsScreen`,
`Topbar`, `PersonDetailCard`) still use the old teal/`rounded-xl`/
`shadow-sm` look for everything but headline type and should be brought
in line with the rest of this doc next.
