# Grind — Design System

> The single source of truth for how Grind looks and feels. Every screen — desktop agent **and** web dashboard — follows this. If a value isn't here, add it here first, then use it. Tokens live in `apps/agent/src/renderer/styles.css` (`:root`); this doc is the spec behind them.

**Aesthetic in one line:** light, premium, calm — with a **violet signature**, **rounded display numerals**, colorful per-project chips, and a **day-timeline ribbon** as the hero data visual. Not a generic Electron web app; not a toy.

---

## 1. Principles

1. **Show real data, not fake progress.** We count time *up*, so we never use a progress ring or any metaphor that implies a target. The signature visual is the **day-timeline ribbon** (real sessions placed at their real time of day).
2. **Calm by default, color with intent.** Lots of white/light-gray, one accent (violet). Color earns its place: project identity, status, category — never decoration for its own sake.
3. **Quiet interactions.** Subtle hover fills, soft shadows, gentle 130–360ms motion, keyboard-only focus rings. Nothing bounces or shouts.
4. **Consistency over creativity.** Use the tokens and components below. Don't hardcode hex, px, or one-off fonts.
5. **Light theme only** (for now). No dark mode in v1.

---

## 2. Design Tokens

All tokens are CSS variables on `:root`. **Never hardcode** — reference the variable.

### Color — surfaces
| Token | Value | Use |
|---|---|---|
| `--bg-app` | `#f4f4f7` | App canvas (content area) |
| `--bg-sidebar` | `#ffffff` | Sidebar chrome |
| `--bg-card` | `#ffffff` | Cards, rows, fields-on-card |
| `--ink` | `#15131c` | Near-black (running hero, "now" marker, primary text) |

### Color — text (ink with alpha for hierarchy)
| Token | Value |
|---|---|
| `--label-primary` | `#15131c` |
| `--label-secondary` | `rgba(40,36,56,.56)` |
| `--label-tertiary` | `rgba(40,36,56,.36)` |
| `--on-dark` / `--on-dark-soft` | `#fff` / `rgba(255,255,255,.62)` |

### Color — accent (violet) & status
| Token | Value | Use |
|---|---|---|
| `--violet` | `#7c5cff` | Primary accent |
| `--violet-700` | `#5b39d8` | Pressed / text-on-tint |
| `--violet-tint` | `rgba(124,92,255,.10)` | Selected nav, soft button, play chip |
| `--grad-violet` | `linear-gradient(135deg,#9b7bff,#6d3bf0)` | Brand mark, prominent buttons, login logo |
| `--ring-from`/`--ring-to` | `#b69bff` → `#6d3bf0` | Gradient strokes / chart line |
| `--success` | `#21c17a` | Running pulse, success |
| `--danger` | `#ff4d6a` | Stop, destructive |

### Color — category palette (per-project / per-tag)
Six-color set; a project is assigned one **deterministically** via `projectStyle(id)` (hash → palette) so it's always the same color + icon. Tokens: `--c-violet`, `--c-rose`, `--c-orange`, `--c-green`, `--c-blue`, `--c-slate`, each with a matching `*-bg` soft tint for tags.

### Separators / fills
`--separator` `rgba(40,36,56,.08)` · `--separator-strong` `rgba(40,36,56,.12)` · `--fill-hover` `rgba(124,92,255,.06)` · `--fill-press` `rgba(124,92,255,.10)`.

### Typography
- **UI font** `--font-sans`: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`. Base **13px**, line-height 1.45.
- **Display font** `--font-round`: `ui-rounded, "SF Pro Rounded", "SF Pro Display", -apple-system, sans-serif` — used for the **brand name, big timer numerals, section titles, stat values**. Gives warmth/character while staying native.
- Scale (helpers): `.h1` 26/700, `.h2` 19/700, `.h3` 15/600, `.body` 13/400, `.callout` 12, `.small` 11. Emphasis = **600**, rarely 700.
- Numerals that change live use `font-variant-numeric: tabular-nums` (`.tabular`).

### Spacing — 8pt grid (4pt fine)
`--sp-1..10` = 2, 4, 8, 12, 16, 20, 24, 32, 40, 48. Tight within a component (4–8), generous between (16–24).

### Radii
`--radius-sm` 8 (buttons/fields/segmented) · `--radius-md` 12 (chips, brand mark) · `--radius-lg` 18 (cards) · `--radius-xl` 24 (hero, login). Child radius < parent radius.

### Shadows (soft, low-opacity, slightly cool)
`--shadow-sm`, `--shadow-card` (default card), `--shadow-hero` (violet-tinted, near-black hero), `--shadow-lift` (hover), `--focus-ring` `0 0 0 3px rgba(124,92,255,.4)`.

### Motion
Eases: `--ease` `cubic-bezier(.4,0,.2,1)`, `--spring` `cubic-bezier(.34,1.56,.64,1)` (for round-button hover, play-chip pop). Durations: `--dur-fast` 130ms · `--dur-base` 220ms · `--dur-slow` 360ms. Honor `prefers-reduced-motion` (all durations → 0). Page content rises in on mount via `.rise` (+ `.rise-1/2/3` stagger delays).

### Layout constants
`--sidebar-width` 232 · `--toolbar-height` 58.

---

## 3. Components

### Button — `.btn`
Variants: default (white + 1px inset border), `.btn-prominent` (violet gradient, white text, glow), `.btn-soft` (violet tint), `.btn-ghost` (transparent), `.btn-danger` (red text). Sizes: default 34px, `.btn-lg` 44px. `.btn-block` full width.
States: hover = tint fill / brightness; active = `scale(.98)`; disabled = .45 opacity; focus-visible = focus ring. Icon + label gap 4px.

### Text field — `.field`
38px, `--bg-app` fill with inset border, 8px radius. Focus = violet inset border + focus ring + white fill. Label = `.field-label` (12/600 secondary); append `.field-optional` (400, tertiary) for an "optional" hint. Textareas reuse `.field` with `height:auto` + `resize:vertical`. Add `.selectable` to inputs (chrome is otherwise non-selectable).

### Inline form card — `.create-card`
A card (`--radius-lg`, `--shadow-card`, `--sp-5` padding) holding stacked `.create-field` groups (label + control, `--sp-2` gap). Footer is a `.create-row` (align-items:flex-end, space-between): secondary controls left, the primary `.btn-prominent.btn-lg` action right. Inline error via `.create-error` (rose, 12px). Used for the "New Lark task" quick-create on Today.

### Sidebar nav item — `.nav-item`
38px row, icon (18px, 2px stroke) + label. Default = secondary text, tertiary icon. Hover = `--fill-hover`. **Active = `--violet-tint` bg + `--violet-700` text + violet icon, weight 600.**

### Task card — `.task`
The project/session row. Layout: **icon chip** (42px, `--radius-md`, project color bg, white 20px icon) · title (14/600) + **tag** row · trailing **play chip** (`.task-play`, 34px circle, violet tint → fills gradient on hover with spring pop). Card hover = lift (`translateY(-1px)` + `--shadow-lift`). Active/running variant: play chip turns red (Stop).

### Tag — `.tag`
19px pill, 11/600, soft category bg + matching fg. One per row by default.

### Stat card — `.stat`
Card with a colored **stat-chip** (34px, 10px radius, white icon) + two-line label, then a big `.stat-value` (rounded display, 30/700) with `.unit` spans for h/m.

### Segmented control — `.segmented` / `.seg`
Pill track (`rgba(40,36,56,.06)`), 28px segments; active = white thumb + `--shadow-sm`. For Day/Week and similar view switches.

### Round action button — `.round-btn`
64px circle, white, `--shadow-card`; hover lift (spring). `.round-btn.danger` = red icon (Stop). Labeled below via `.round-btn-label`. Used in the focus (running) view.

### Empty state — `.empty`
Centered: 56px tinted `.empty-icon`, `.h3` title, `.callout.secondary` line.

---

## 4. Signature patterns

### Day-timeline ribbon — `DayTimeline` (`components/DayTimeline.tsx`)
**The hero visual.** A horizontal track representing today; each segment sits at its real time-of-day, **colored by project** (work), blue (meeting), gray (idle/trimmed). The open segment extends to a black **"now" marker** and **pulses** (`.dt-seg-live`). Hour ticks (`1a`, `2a`…) on the axis below; legend (Work/Meeting/Idle) under it. Never a ring/donut — we count up, not down.

### Running ("focus") view
Vertically centered: big **72px rounded** elapsed time + colored dot + project, then the timeline in a `.focus-card`, then round **Pause / Stop** buttons.

### Near-black running hero — `.hero-running`
On the idle Today screen: a dark gradient card with a violet radial glow, showing the current/last state. Sets the premium tone at the top of the page.

### Line chart — `LineChart` (`components/LineChart.tsx`)
Smooth gradient **area line** (violet), rounded cap, peak marker, faint gridlines. For Reports (Day/Week).

---

## 5. Do's & Don'ts

| ✅ Do | ❌ Don't |
|---|---|
| Use tokens (`var(--…)`) | Hardcode hex / px / fonts |
| One violet accent + category colors with meaning | Rainbow UI or random colors |
| Rounded display font for big numbers/titles | Bold body text everywhere |
| Day-timeline / real data visuals | Progress rings or fake "% complete" |
| Quiet hovers, soft shadows, `:focus-visible` rings | Underline-on-hover, big color flips, focus ring on click |
| Generous space between groups | Cramped, evenly-gray layouts |
| Lucide icons, 1.75–2px stroke, 16–20px | Emoji or Material icons |
| Honor `prefers-reduced-motion` | Bouncy/constant animations |

---

## 6. Icons
**Lucide** (`lucide-react`), MIT. 16px in rows/nav, 18px sidebar, 20px task chips, ~2px stroke. Color = category/accent on chips, `--label-secondary`/`tertiary` otherwise. Never ship SF Symbols (Apple license forbids non-Apple-platform use).

---

## 7. Adding to the system
1. Need a value? Add a **token** first, then reference it.
2. Need a UI element? Check this doc for an existing component/variant before inventing one.
3. New reusable component → document it here (variants, states, tokens used) — "if it's not documented, it doesn't exist."
4. Keep desktop agent and web dashboard visually identical — they share this system.
