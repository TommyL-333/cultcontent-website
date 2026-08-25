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

**Second source of truth, added later and now the tie-breaker on tone:**
the actual event marketing page, live at `culture-commerce-carnival.html`
(and mirrored at `ccc.cultcontent.cc/culture-commerce-carnival`). Earlier
revisions of this doc picked a *restrained, institutional* register
(serif headlines, one accent leading at a time) reasoning abstractly from
"what does an AI scaffold never do." That's a reasonable heuristic in a
vacuum, but it invented a tone unrelated to the brand that already
exists. The marketing page is the real Creator Carnival identity: full
black, all three accents used together, huge black-weight sans
headlines, glowing pill badges, gradient-washed feature cards, emoji used
as icons. Festival/event energy, not fintech-trust energy. Match *that*,
not an abstract "looks less like AI" heuristic — a real existing brand
beats an invented one every time they conflict.

## Typography

One font, never Inter, never a second serif/display face paired in:

- **`Public Sans`, at its heaviest weight, is both the body and the
  display face.** Headlines, the countdown digits, and any large
  standalone number use `font-black` (900) or `font-extrabold` (800)
  with `tracking-tight` and big `text-4xl`+ sizing — never a separate
  typeface. This is deliberately how the marketing page gets its punch
  (`font-weight: 900`, `letter-spacing: -.02em` to `-.03em`, `clamp(42px,
  7vw, 76px)` headline sizing) on a plain system sans, not an unusual
  font choice — the excitement comes from scale + weight + contrast, not
  from typeface personality. (This reverses an earlier version of this
  doc that used `Source Serif 4` for headlines — see the note above.)
- Body copy, labels, nav stay at normal/medium Public Sans weights —
  the contrast between a 400-weight paragraph and a 900-weight headline
  is what makes the headline read as loud, not the headline alone.

Tailwind utilities: `font-display` and `font-sans` currently resolve to
the same family (Public Sans) — `font-display` exists as a token so a
real second face could be swapped in later without touching every
screen, not because one is in use today.

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
- **All three accents can appear together on one screen** — the
  marketing page does this constantly (a cyan pill badge next to a red
  featured-card glow next to a gold sponsor tag, all in one viewport).
  An earlier version of this doc said "one accent leads per screen";
  that was too conservative once the actual brand reference showed
  otherwise. Keep each accent's *meaning* consistent though: cyan =
  primary/default action, red = featured/urgent/VIP, gold = premium/
  sponsor/detail. Don't reassign what a color means screen to screen.
- Two reusable patterns, both lifted directly from the marketing page —
  see `index.css`:
  - `.pill-glow-{cyan,red,gold}` — a tinted translucent fill + tinted
    border in one accent, for labels/badges/chips. Not a flat solid chip.
  - `.card-glow-{cyan,red,gold}` — a diagonal corner gradient wash on a
    card, for the one option per section that should read as
    highlighted (a featured ticket tier, a live/urgent state).
- No purple/indigo, no gradient-on-white-card default.
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

Two rounds so far. Round 1 (restrained/institutional: Source Serif 4,
one-accent-leads) got applied app-wide for typography, but only piloted
on `HomeScreen.jsx` for the rest. Round 2 (this version — festival
energy matched to the actual marketing page: heavy-weight Public Sans,
layered accents, `.pill-glow`/`.card-glow`) has only been applied to
`HomeScreen.jsx` so far, replacing round 1's treatment there. Every other
screen (`LoginScreen`, `SignupScreen`, `DirectoryScreen`,
`ConnectionsScreen`, `PersonProfileScreen`, `InboxScreen`,
`ProfileScreen`, `SettingsScreen`, `Topbar`, `PersonDetailCard`) is still
on round 1's typography (`font-display` headlines, now silently
resolving to Public Sans instead of the removed serif — so they didn't
break, but they don't have the new weight/pill/glow treatment either)
and should be brought in line with this version next.
