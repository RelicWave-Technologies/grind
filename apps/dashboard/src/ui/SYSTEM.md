# Grind Dashboard — Design System ("Quiet Datasheet")

> **SINGLE SOURCE OF TRUTH.** Every one of the 13 pages (Home, Overview, MeToday, Team,
> Teams, Users, Approvals, Attendance, Shifts, Payroll, Flags, Policy, Login) is composed
> from the kit in this file. A page file contributes **layout only** — which components go
> where, in what grid. It may **not** introduce a color, font, radius, shadow, or bespoke
> component variant. If you reach for a hardcoded value, stop: it belongs here as a token
> first, or it does not belong at all.
>
> **Reference bar.** Linear · Vercel · Stripe · Things · Height. Very minimal, very clean,
> very premium, strictly consistent, easy to understand. **Not** decorative pastels; **not**
> flat pure black-and-white. Restrained palette, generous whitespace, hairline structure,
> minimal shadow, tasteful micro-motion.
>
> **Adoption.** This is a *token swap* over the existing `apps/dashboard/src/styles.css`:
> retire the `--fg-*` pastel-editorial block and the `--violet*`/`--c-*` legacy aliases;
> introduce the tokens in §2; extract the components in §5 into `apps/dashboard/src/ui/`.
> The per-page CSS files (`home.css`, `payroll.css`, `users.css`, `overview.css`, …) and
> every ad-hoc class (`fg-*`, `pay-stat`, `atd-stat`, `apv-row`, `tms-*`, `usr-*`) are
> **deleted** and replaced by the components here. Keep `Inter` + `JetBrains Mono`, the 4px
> spacing scale, and the `page-rise` mount keyframe.

---

## 0. Decision record — debate & settlement

Three proposals were judged **strictly against the mandate** (minimal · clean · premium ·
CONSISTENT · easy). All three independently converged on the same correct spine — one accent,
three surfaces, hairline structure, flat-by-one-shadow, mono-for-data — which tells us that
spine is right. They differ in palette temperature, the one "memorable" motif, and how
strictly they fence off page-builders. The mandate makes *consistency* the tie-breaker.

**Proposal 1 — "Blueprint" (Swiss).**
*Strengths:* the single best idea in the set — **the mono eyebrow** + **all data in tabular
mono** turns 13 screens into one engineered datasheet, which is exactly the "looks like ONE
product" the mandate demands; rigorous 8-grid; decisive accent rationing ("color a surface
and you've broken the system"); the **StatRow** (N stats divided by hairlines in *one* card,
not N boxes) is more premium and less busy than a grid of tiles.
*Weaknesses against the mandate:* cobalt `#2D5BFF` is too saturated/loud for "very calm,
premium" — it reads consumer-tech, not Linear-quiet; "a mono label above *every* value"
becomes visual noise if taken literally in dense tables; fewer explicit anti-bespoke
guardrails than P2, so 13 builders could still drift.

**Proposal 2 — "Soft Premium SaaS."**
*Strengths:* the **most strictly systematized**, which is precisely what 13 independent
page-builders need: a fixed 5-status taxonomy mapped 1:1 across Tag / table-rail / chart;
"one of each control, variants only"; an explicit *accent is rationed* rule; a hard
3-surface ceiling; depth-by-tone-not-shadow. Calm indigo `#5B5BD6` lands "premium, not loud"
far better than P1's cobalt or P3's ink-blue. Hierarchy by *weight + ink-step* (small size
jumps) is the most restrained type approach.
*Weaknesses:* its metric block and overall personality are a touch generic — less memorable
than P1's datasheet motif; the `--r-xl:20` / pill-tag instincts drift toward stock SaaS;
its neutrals lean a hair cool and could feel clinical without care.

**Proposal 3 — "Editorial Quiet."**
*Strengths:* the warmest, most genuinely *premium-paper* feel (warm-neutral surfaces,
color-stepped ink which is crisper than alpha-on-white); the only proposal that explicitly
maps its token *names* onto the real `styles.css` for low-risk adoption; the "every page is
a document" rule (left-aligned margins, one hairline rule under each title) is a strong,
cheap consistency device.
*Weaknesses:* ink-blue `#3A5BC7` is muddy/dated next to the references; "type-only, almost
no borders" **under-structures** the dense ops tables (Payroll, Attendance, Users) where
hairline scaffolding genuinely aids scanning — a real liability for "easy to understand";
32px page gutter/`title 22` is slightly heavier than the trimmer Linear feel.

### Settlement

**Spine = Proposal 2 (strict taxonomy + accent rationing + one-of-each-control).** It is the
strongest *guarantee of consistency*, and consistency is the mandate's deciding axis.

Grafts, with every conflict resolved to **one** canonical answer:

- **From P1 — the memorable motif, applied with restraint.** Adopt the **uppercase mono
  Eyebrow** as the one repeated micro-label (page context, card kicker, table column heads,
  stat labels, field labels) and **all data in mono + `tabular-nums`**. *Restraint clause:*
  the eyebrow labels a **group** (a stat, a column, a section) — **never** every individual
  cell. Also adopt P1's **StatRow** (hairline-divided stats in one card) and the table
  **density toggle**.
- **From P3 — warmth + adoption path.** Surfaces are **barely-warm neutral** (a hair off
  pure white/gray), and ink is **color-stepped near-black**, not alpha — crisper on paper,
  more premium. Keep P3's token-swap-onto-`styles.css` adoption discipline. *But reject* P3's
  "almost no borders": hairlines are our **primary** structural device, especially in tables.

**Conflicts → final calls (one answer each):**

| Conflict | Decision | Why |
|---|---|---|
| Accent hue | **Indigo-violet `#5B5BD6`** | P2's calm violet; not P1 cobalt (loud), not P3 ink-blue (muddy). Reads Linear/Stripe-premium. |
| Surface temperature | **Barely-warm neutral** (P3 lean, P2 discipline) | Warm = premium-paper, not clinical; kept *subtle* so it still feels Vercel-crisp. |
| Ink | **Color-stepped** `#1A1A17 / #5C5C54 / #8C8C82` | Crisper than alpha; matches warm surfaces; "weight + ink-step, small size jumps." |
| Tag shape | **`--r-sm` 6px rounded-rect, never pill** | Pills read playful/generic; squared-soft reads Linear/Height. `--r-full` is avatars/dots only. |
| Control height | **One height: 32px** (sm 28 / lg 36) | One rhythm everywhere. |
| Two tab systems | **Tabs (underline)** = page sections · **Segmented (track+thumb)** = view/range switch. Never both for one job. | Eliminates the most common drift between page-builders. |
| Shadow count | **Exactly ONE** (`--shadow-pop`), floating layers only | A shadow on the page *means* "this floats." Cards/tables never lift. |
| Accent budget | **≤ 3 accent hits per viewport** (one primary action · active nav · ≤1 data emphasis). Status is **never** accent. | Keeps the eye calm; status colour stays meaningful. |
| Radii family | **6 / 10 / 14** (+ `--r-full` avatars) | One geometry; no `--r-xl` 20–32. |
| Page gutter / title | **gutter 32, title 19** | Trimmer than P3; generous but not heavy. |

**Result — small and strict by construction:** one accent · three surface tones · five status
tints · two fonts · one shadow · one control height · one of each component · the mono Eyebrow
as the connective tissue. The name **"Quiet Datasheet"** captures it: P2's quiet surface,
P1's datasheet rigor.

---

## 1. Principles (the rules that keep 13 pages identical)

1. **Every page = `<PageHeader>` + body, inside `<Page>`** (`max-width: 1180px`, centered,
   gutter `--sp-8`). No page styles its own title, gutter, or header chrome. Context → header
   eyebrow; actions/filters → the header `actions` slot.
2. **Structure is hairline + tone, never elevation.** Group with `--line` and whitespace
   first; reach for a `Card` second. The single shadow is reserved for *floating* layers
   (menus, popovers, toasts). **Cards and tables never cast a shadow and never lift on hover.**
3. **Three surface tones only** — `--surface-sunken` behind panels, `--surface` for panels,
   `--surface-inset` for wells/hover/zebra. A fourth gray is forbidden.
4. **Accent is rationed — ≤ 3 hits per viewport:** the one primary action, the active nav
   item, and at most one data emphasis. **Status is never accent.**
5. **Fixed status taxonomy** (`success | warn | danger | info | neutral`) maps **1:1** to
   `Tag`, table left-rail, banner, ribbon/heatmap legend, and chart series. The same hue
   means the same thing on every page.
6. **All data is mono + tabular.** Numbers, durations (`6h 42m`), %, timestamps, IDs →
   `--font-mono`, `tabular-nums`, right-aligned in tables. **All prose, titles, and buttons
   are Inter.** Decide which a string is, and its type is automatic.
7. **The uppercase mono Eyebrow** is the one shared micro-label — it marks page context, card
   kickers, table columns, stat labels, and field labels, giving all 13 pages one cadence.
   It labels a **group**, never every cell.
8. **One of each control.** One Button (variants only), one Tabs, one Segmented, one Field,
   one Tag, one Table, one Stat. No per-screen reinventions.
9. **Fixed primitives.** Controls 32px, rows 44px (compact 36), radius 6 / 10 / 14, spacing on
   the 4px grid. A new page composes existing tokens; it never introduces a value.
10. **Reduced motion is honored.** All motion degrades to instant under `prefers-reduced-motion`.

---

## 2. Tokens — the EXACT set (CSS custom properties)

Drop this into `:root` (replacing the legacy block in `styles.css`). These names are
canonical; reference them by `var(--…)` everywhere. **Nothing outside this list exists.**

```css
:root {
  /* ── Surfaces — barely-warm neutral, layered. THREE tones, no more. ───────── */
  --surface-sunken: #F7F7F5;   /* app background behind panels */
  --surface:        #FFFFFF;   /* default panel / card / table / sidebar */
  --surface-inset:  #F2F2EF;   /* input wells, table zebra-on-hover, code, tracks */
  --surface-raised: #FFFFFF;   /* popovers/menus — same fill, gains --shadow-pop + --line */

  /* ── Ink — warm-neutral, color-stepped (crisper on paper than alpha). ────── */
  --ink:          #1A1A17;     /* headings, key numbers, primary text */
  --ink-2:        #5C5C54;     /* body secondary, row sublines, labels */
  --ink-3:        #8C8C82;     /* captions, placeholders, column heads, meta */
  --ink-disabled: #B6B6AC;
  --on-accent:    #FFFFFF;     /* text on accent fill */

  /* ── Hairlines — the PRIMARY structural device. Two working weights + faint. */
  --line:        #E6E5E0;      /* default 1px structure: cards, rows, header rule */
  --line-strong: #D6D5CC;      /* input borders, active/emphasis dividers */
  --line-faint:  #F0EFEA;      /* interior table dividers, nested groupings */

  /* ── Accent — ONE calm indigo-violet. Identity pointer only, never decor. ── */
  --accent:        #5B5BD6;    /* primary action, active nav, ≤1 data emphasis */
  --accent-hover:  #4F4FC9;
  --accent-press:  #4646B8;
  --accent-tint:   #EEEEFB;    /* selected row/nav wash, soft-button bg */
  --accent-tint-2: #E2E2F7;    /* soft-button hover, denser wash */
  --accent-ring:   rgba(91, 91, 214, 0.30);   /* focus ring */

  /* ── Semantic status — the FIXED taxonomy. Each: soft tint bg + readable ink
        + a solid hue for dots/bars/legends. Status ONLY — never decoration,
        never the accent's job. ────────────────────────────────────────────── */
  --success-ink: #1B7A47;  --success-bg: #E7F4EC;  --success-solid: #22A35A;
  --warn-ink:    #8A5A12;  --warn-bg:    #FBF1DE;  --warn-solid:    #D9920C;
  --danger-ink:  #B42332;  --danger-bg:  #FCEBEC;  --danger-solid:  #E5484D;
  --info-ink:    #2C5BA8;  --info-bg:    #EAF1FB;  --info-solid:    #3E7BD6;
  --neutral-ink: #5C5C54;  --neutral-bg: #EEEDE9;  --neutral-solid: #8C8C82;

  /* ── Overlay (modal scrim — the ONLY full-bleed dark). ───────────────────── */
  --overlay: rgba(26, 26, 23, 0.40);

  /* ── Type families. (Existing font links stay: Inter + JetBrains Mono.) ──── */
  --font-sans: 'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;

  /* ── Spacing — 4px base. Use these; never raw px. ────────────────────────── */
  --sp-1: 2px;  --sp-2: 4px;  --sp-3: 8px;  --sp-4: 12px; --sp-5: 16px;
  --sp-6: 20px; --sp-7: 24px; --sp-8: 32px; --sp-9: 40px; --sp-10: 48px; --sp-12: 64px;

  /* ── Radii — restrained. Three working radii + full (avatars/dots only). ─── */
  --r-sm:   6px;    /* inputs, buttons, tags, chips, segmented */
  --r-md:  10px;    /* cards, panels */
  --r-lg:  14px;    /* modals, popovers */
  --r-full: 999px;  /* avatars and status dots ONLY */

  /* ── Elevation — flat by default. Exactly ONE shadow in the product. ─────── */
  --shadow-pop: 0 8px 24px -6px rgba(20, 20, 15, 0.12),
                0 2px 6px rgba(20, 20, 15, 0.06);   /* popovers/menus/toasts only */
  --focus-ring: 0 0 0 3px var(--accent-ring);

  /* ── Motion — quiet. No springs, no bounce, no card-lift. ────────────────── */
  --ease:     cubic-bezier(0.32, 0.72, 0, 1);
  --dur-fast: 120ms;   /* hover / press: bg + border tween only */
  --dur-base: 180ms;   /* control state changes, tab/segment slide */
  --dur-slow: 240ms;   /* page mount */

  /* ── Layout constants. ───────────────────────────────────────────────────── */
  --sidebar-width: 240px;
  --page-max:      1180px;
  --control-h:      32px;   /* the one control height (sm 28 / lg 36) */
  --row-h:          44px;   /* table/list row (compact 36) */
}

@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 0ms; --dur-base: 0ms; --dur-slow: 0ms; }
}
```

**Token usage law:** components reference only these variables. No literal hex and no literal
px outside this block (the sole exceptions: `1px` hairline borders, and `0`). Charts, heatmaps
and ribbons draw their series **only** from the `*-solid` status hues and `--accent` — see §4.

---

## 3. Type scale

**Inter** for everything; **JetBrains Mono** *only* for data (numbers, durations, %,
timestamps, IDs) and for the uppercase **Eyebrow**. Never mono for prose. Hierarchy leans on
**weight + ink-step**, minimizing size jumps. Apply `font-variant-numeric: tabular-nums` to
every mono value (the `.mono` utility does this).

| Class        | Size / Line / Weight / Tracking          | Font  | Use                                            |
|--------------|------------------------------------------|-------|------------------------------------------------|
| `.t-display` | 28 / 1.15 / 650 / -0.4px                 | sans  | Stat hero value, page-level hero number        |
| `.t-title`   | 19 / 1.25 / 640 / -0.3px                 | sans  | `PageHeader` title, `Card` title               |
| `.t-h3`      | 15 / 1.4 / 600 / -0.1px                  | sans  | Sub-section heading inside a card              |
| `.t-strong`  | 14 / 1.5 / 600 / -0.1px                  | sans  | Row primary text, emphasized body              |
| `.t-body`    | 14 / 1.5 / 450 / 0                        | sans  | Default text                                   |
| `.t-small`   | 12.5 / 1.45 / 450 / 0                     | sans  | Secondary text, sublines, captions, help       |
| `.t-eyebrow` | 11 / 1 / 600 / +0.08em / **UPPERCASE**   | mono  | Page context, card kicker, column head, labels |
| `.mono`      | inherit size / 450 / `tabular-nums`      | mono  | Any numeric / temporal value (inline)          |
| `.t-num`     | 28 / 1.1 / 650 / -0.4px / `tabular-nums` | mono  | Big tabular metric numeral (Stat value)        |

Color via ink tokens (`--ink`, `--ink-2`, `--ink-3`). **Eyebrow is always `--ink-3`.** Never
use `opacity` to dim text — step the ink token instead.

---

## 4. Spacing · radii · hairline · elevation · motion · data-viz

- **Page gutter** `--sp-8` (32) · **section gap** `--sp-7` (24) · **card padding**
  `20px 24px` (`--sp-6 --sp-7`) · **row height** `--row-h` (44; compact 36) · **control
  height** `--control-h` (32).
- **Radii:** controls/tags `--r-sm` (6) · cards/panels `--r-md` (10) · modals/popovers
  `--r-lg` (14) · avatars/dots `--r-full`. No other radii.
- **Hairlines:** `--line` is the default 1px structure (cards, row dividers, header rule).
  `--line-strong` for input borders + active/emphasis. `--line-faint` for interior table
  dividers. **Never double-border** — adjacent panels share one line.
- **Elevation:** flat. Cards/tables = hairline, no shadow, no hover-lift. The only shadow
  `--shadow-pop` appears on `Popover` / `Menu` / `Toast`. Focus = `--focus-ring`.
- **Motion:** `--ease` for all easing. Hover/press = bg/border tween (`--dur-fast`); no scale,
  no lift on cards. State changes / tab slide = `--dur-base`. **Page mount** = 6px rise + fade
  over `--dur-slow` (`page-rise`; stagger groups with `.rise-1/-2/-3`). Reduced-motion →
  instant.

```css
@keyframes page-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.rise   { animation: page-rise var(--dur-slow) var(--ease) both; }
.rise-1 { animation: page-rise var(--dur-slow) var(--ease) both; animation-delay: 40ms; }
.rise-2 { animation: page-rise var(--dur-slow) var(--ease) both; animation-delay: 80ms; }
.rise-3 { animation: page-rise var(--dur-slow) var(--ease) both; animation-delay: 120ms; }
```

**Data-visualization contract (binds `ActivityHeatmap`, `DayRibbon`, `AppUsagePanel`, and any
chart).** Visualizations are part of the system, not an exception — they may use **only**:
- **Category encoding** → the `*-solid` taxonomy hues. The activity kinds map fixed:
  `work → --accent` · `meeting → --info-solid` · `manual → --warn-solid` · `idle → --neutral-solid`
  · `flagged → --danger-solid`. (This is the one place `--accent` legitimately fills an area;
  it counts toward the ≤3 budget.)
- **Sequential / intensity** (e.g. heatmap density) → a single-hue ramp of `--accent` at
  fixed steps: `--accent-tint` → `--accent-tint-2` → `color-mix(in srgb, var(--accent) 55%, white)`
  → `--accent`. No multi-hue gradients, no rainbow.
- **Axes / gridlines / labels** → `--line-faint` (grid), `--ink-3` (`.t-eyebrow` / `.mono`
  labels). Tooltips render in a `Popover`.
No chart introduces a hue outside this set. A legend is a row of `Tag … dot` using the same
taxonomy, so legend and series always agree.

---

## 5. Component API

Each component is the **only** sanctioned way to render its pattern. Build pages by composing
these — passing data and layout, not styles. React components live in
`apps/dashboard/src/ui/`; CSS classes live in the shared stylesheet.

> **Convention.** Every component accepts `className` (extra **layout** classes only) and
> forwards `...rest`. Interactive elements expose the documented `variant` / `size` / state
> props **and nothing that alters the palette** (no `color`, `bg`, `border`, `radius`,
> `shadow` props). Layout-affecting props (`span`, `align`, `density`) are fine.

The kit is **17 components**:
`Page` · `PageHeader` · `Card` · `Stat`/`StatRow` · `Table` · `List`/`ListRow` · `Button` ·
`Tabs`/`Segmented` · `Field` (+ controls) · `Tag` · `Avatar`/`Identity` · `Toolbar` ·
`EmptyState` · `Skeleton`/`Spinner` · `Banner` · `Popover`/`Menu`/`Toast` · `AppShell`/`Sidebar`.

---

### 5.1 `Page` — page frame
- **Purpose:** the centered column every page lives in. Sets max-width, gutter, mount
  animation. **Every page's root.**
- **Component:** `<Page>` · props: `children`.
- **Class:** `.page` — `max-width: var(--page-max); margin: 0 auto; padding: var(--sp-8);
  animation: page-rise var(--dur-slow) var(--ease) both`.
- **States:** none.
```tsx
<Page>
  <PageHeader … />
  {/* sections */}
</Page>
```

### 5.2 `PageHeader` — the universal header (all 13 pages)
- **Purpose:** the single header construct. Eyebrow (context) → Title → optional subtitle on
  the left; `actions` slot (a `Toolbar`) on the right; an optional `tabs` row docks to the
  bottom hairline. **No page renders its own title treatment.**
- **Component:** `<PageHeader title eyebrow? subtitle? actions? tabs?>`.
- **Classes:** `.page-head` (flex, `align-items: flex-end`, `justify-content: space-between`,
  bottom `1px var(--line)`, `padding-bottom: var(--sp-5)`, `margin-bottom: var(--sp-7)`),
  `.page-head__text`, `.page-head__title` (`.t-title`), `.page-head__eyebrow` (`.t-eyebrow`,
  `margin-bottom: var(--sp-2)`), `.page-head__sub` (`.t-small`, `--ink-2`),
  `.page-head__actions`, `.page-head__tabs` (sits on the bottom rule).
- **States:** none.
```tsx
<PageHeader
  eyebrow="Payroll" title="June 2026" subtitle="Draft — closes Jun 30"
  actions={<Toolbar><Segmented … /><Button variant="primary">Export</Button></Toolbar>}
/>
```

### 5.3 `Card` — surface container
- **Purpose:** group related content on `--surface` with a hairline. The default container; no
  shadow, no hover-lift.
- **Component:** `<Card title? action? variant?>` · `variant: 'default' | 'flush' | 'quiet'`.
  `flush` = padding 0 (host a `Table` or `StatRow`); `quiet` = borderless, on app ground, for
  pure grouping.
- **Classes:** `.card` (`--surface`, `1px var(--line)`, `--r-md`, padding `20px 24px`),
  `.card--flush`, `.card--quiet`, `.card__head` (optional: `.t-title` + right `action`,
  divided from body by `1px var(--line-faint)`, `padding-bottom: var(--sp-4)`,
  `margin-bottom: var(--sp-5)`), `.card__body`.
- **States:** none.
```tsx
<Card title="Recent activity" action={<Button variant="ghost" size="sm">View all</Button>}>
  <List>…</List>
</Card>
```

### 5.4 `Stat` + `StatRow` — the metric pattern
- **Purpose:** one headline number with label and optional delta. The canonical KPI block on
  Home, Overview, MeToday, Payroll, Attendance. **Replaces every `*-stat` page class.**
- **Components:** `<Stat label value unit? delta? hint?>`; `<StatRow>` groups N `Stat`s inside
  **one** `Card variant="flush"`, divided by **vertical hairlines** (not separate boxes). A
  `.stat-grid` utility (`repeat(auto-fit, minmax(220px, 1fr))`) exists for the rarer boxed-card
  layout.
- **Anatomy:** Eyebrow label (`.t-eyebrow`, `--ink-3`) → value (`.t-num`, mono, `--ink`) with
  optional small `--ink-2` `unit` → optional **delta** = `▲`/`▼` glyph + figure in
  `--success-ink` (up) / `--danger-ink` (down), **tint-free** (no chip). No rings, no default
  sparkline chrome.
- **Classes:** `.stat`, `.stat__label`, `.stat__value`, `.stat__unit`, `.stat__delta`,
  `.stat__delta--up`, `.stat__delta--down`; `.stat-row` (flex; children divided by `--line`
  via `:not(:last-child){ border-right: 1px solid var(--line) }`, equal padding); `.stat-grid`.
- **States:** none.
```tsx
<Card variant="flush"><StatRow>
  <Stat label="Tracked" value="6h 42m" delta={{ dir: 'up',   value: '+12%' }} />
  <Stat label="Active"  value="91" unit="%" />
  <Stat label="Idle"    value="38m"   delta={{ dir: 'down', value: '-5%' }} />
</StatRow></Card>
```

### 5.5 `Table` — data grid
- **Purpose:** the one tabular surface (Users, Attendance, Payroll, Flags, Approvals detail).
  Hosted in a `Card variant="flush"`.
- **Components:** `<Table density?>` (`'comfortable' | 'compact'`), `<THead>`, `<Th sortable?
  align? sortDir?>`, `<Tbody>`, `<Tr selected? rail? onClick?>`, `<Td align? mono?>`.
- **Anatomy / classes:**
  - Header `.table__head` — `.t-eyebrow` labels, `--ink-3`, **transparent** (no fill bar),
    bottom `1px var(--line)`. `Th[sortable]` shows a caret on hover; active → `--accent` +
    filled caret.
  - Rows `.table__row` — height `--row-h` (`.table--compact` → 36), divider `1px
    var(--line-faint)` (last row none), hover `--surface-inset`, `.is-selected` →
    `--accent-tint`.
  - **Identity/status via a 3px inset left-rail** on the first cell:
    `.table__row--rail-{success|warn|danger|info|accent}` (e.g. self = `accent`, pending =
    `warn`). **Never tint a full row** beyond the selected wash.
  - Numbers `.td--num` — right-aligned, `--font-mono`, `tabular-nums`.
  - Sticky helpers: `.table--sticky-col`, `.table--sticky-head`.
- **States:** row hover, `is-selected`, `Th` sort active.
```tsx
<Card variant="flush"><Table density="comfortable">
  <THead><Tr>
    <Th sortable>Member</Th><Th align="right" sortable>Tracked</Th><Th align="right">Active</Th>
  </Tr></THead>
  <Tbody>
    <Tr rail="accent" selected>
      <Td><Identity name="A. Suman" subtitle="Engineering" avatar={<Avatar name="A. Suman" />} /></Td>
      <Td mono align="right">6h 42m</Td><Td mono align="right">91%</Td>
    </Tr>
  </Tbody>
</Table></Card>
```

### 5.6 `List` + `ListRow` — lightweight row stack
- **Purpose:** feeds, members, settings groups, Approvals/Teams/Shifts cards — lighter than a
  `Table`. **Replaces `apv-row`, `tm-legend-item`, etc.**
- **Components:** `<List>`; `<ListRow leading? title subtitle? meta? trailing? rail? onClick?>`.
- **Anatomy / classes:** `.list`, `.list-row` (height `--row-h`, `1px var(--line)` divider,
  hover `--surface-inset`, optional `.list-row--rail-{status}`), `.list-row__leading`
  (Avatar/icon), `.list-row__main` (title `.t-strong` + subtitle `.t-small` `--ink-2`),
  `.list-row__meta` (`.mono`, `--ink-2`), `.list-row__trailing` (Tag / Button / chevron).
- **States:** hover; `[role=button]` + pointer when `onClick`.
```tsx
<List>
  <ListRow leading={<Avatar name="A. Suman" />} title="A. Suman" subtitle="Engineering"
           meta="6h 42m" trailing={<Tag status="success">Approved</Tag>} />
</List>
```

### 5.7 `Button` — the only button
- **Purpose:** all actions. **One primary fill per viewport.** Replaces every `*-btn`/`fg-pill`.
- **Component:** `<Button variant size block? icon? loading? disabled?>` ·
  `variant: 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger'` ·
  `size: 'sm' | 'md' | 'lg'` (28 / **32** / 36px). `<IconButton>` = `Button` with `icon`, no
  label, square, ghost by default.
- **Variants (flat — no gradient/glow/shadow), `--r-sm`, Inter 600 @13, icon gap `--sp-2`:**
  - `primary`: `--accent` bg, `--on-accent`; hover `--accent-hover`, press `--accent-press`.
  - `secondary` (default): `--surface`, `1px var(--line-strong)`, `--ink`; hover
    `--surface-inset`.
  - `soft`: `--accent-tint` bg, `--accent` text; hover `--accent-tint-2`.
  - `ghost`: transparent, `--ink-2`; hover `--surface-inset` + `--ink`.
  - `danger`: `--surface`, `--danger-ink` text + `1px --danger-ink` border; hover `--danger-bg`.
- **Classes:** `.btn`, `.btn--primary|secondary|soft|ghost|danger`, `.btn--sm|md|lg`,
  `.btn--block`, `.btn--icon`, `.is-loading`.
- **States:** hover, press (`translateY(0)` — no scale), focus (`--focus-ring`), disabled
  (`--ink-disabled`, sunken, no fill), loading (14px `Spinner`, label dimmed).
```tsx
<Button variant="primary">Save</Button>
<IconButton icon={<Icon.More/>} aria-label="More" />
```

### 5.8 `Tabs` and `Segmented` — view switching (two patterns, never mixed for one job)
- **`Tabs` — page sections.** Underline style. `<Tabs items value onChange>`; classes `.tabs`
  (baseline `1px var(--line)`), `.tab` (`--ink-3`, `--dur-base`), `.tab.is-active` (`--ink`,
  2px `--accent` underline). Use in `PageHeader.tabs` for switching **page sections**.
- **`Segmented` — view/range switches.** Track + thumb. `<Segmented items value onChange size?>`;
  classes `.seg` (track `--surface-inset`, `--r-sm`, 3px pad), `.seg__item` (`--ink-2`, height
  28/32), `.seg__item.is-active` (thumb `--surface`, `--ink`, `1px var(--line)` — **no
  shadow**, slides `--dur-base`). Use in toolbars for date ranges, status filters.
```tsx
<Tabs value={tab} onChange={setTab}
      items={[{ value: 'people', label: 'People' }, { value: 'invites', label: 'Invites' }]} />
<Segmented value={range} onChange={setRange}
           items={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} />
```

### 5.9 `Field` (+ `Input` / `Select` / `Textarea` / `Toggle` / `Checkbox` / `Radio`) — forms
- **Purpose:** all inputs (Policy, Shifts, Settings, Login). **Replaces `usr-field`/`usr-input`.**
- **Components:** `<Field label hint? error? children>` wraps any control. Controls: `<Input>`,
  `<Select>`, `<Textarea>`, `<Toggle checked onChange>`, `<Checkbox>`, `<Radio>`.
- **Anatomy / classes:** `.field` → `.field__label` (`.t-eyebrow`, `--ink-3`, `margin-bottom:
  var(--sp-2)`) → control → optional `.field__hint` (`.t-small`, `--ink-3`) or `.field__error`
  (`.t-small`, `--danger-ink`). Controls share `.control`: height `--control-h`, `--surface`,
  `1px var(--line-strong)`, `--r-sm`, padding `0 var(--sp-4)`; **focus** = `--accent` border +
  `--focus-ring`; **error** = `--danger-ink` border. `.select` adds a caret glyph and opens a
  `Popover` menu. `.toggle` = 36×20 track, `--line-strong` off → `--accent` on, 16px white
  knob, `--dur-base`. `.checkbox`/`.radio` = 16px, `--accent` when checked.
- **States:** rest, hover, focus, error, disabled.
```tsx
<Field label="Daily hours" hint="Used for overtime">
  <Input type="number" value={h} onChange={…} />
</Field>
<Field label="Notifications"><Toggle checked={on} onChange={setOn} /></Field>
```

### 5.10 `Tag` — status & labels
- **Purpose:** status pills, counts, kinds. The visual face of the §2 taxonomy.
- **Component:** `<Tag status? dot? mono?>` ·
  `status: 'success'|'warn'|'danger'|'info'|'neutral'` (default `neutral`). `dot` =
  low-emphasis variant (6px solid dot + plain `--ink-2` text) for dense tables / legends.
  `mono` for counts/IDs.
- **Classes:** `.tag`, `.tag--{status}` (tint `bg` + tint `ink`, `--r-sm` — **not pill** —
  height 20, 11px/600, pad `2px 8px`), `.tag--dot`, `.tag--mono`. The `*-solid` hue drives the
  dot and any matching ribbon/heatmap/chart legend.
- **States:** none.
```tsx
<Tag status="warn">Pending</Tag>
<Tag status="danger" dot>Flagged</Tag>
<Tag mono>#1042</Tag>
```

### 5.11 `Avatar` + `AvatarGroup` + `Identity`
- **Purpose:** people. The lone `--r-full` (circle) surface.
- **Components:** `<Avatar name|src size?>` (24/32/40); `<AvatarGroup max?>` (-8px overlap,
  `2px var(--surface)` ring, `+N` mono overflow chip); `<Identity name subtitle? avatar />`
  (avatar + name `.t-strong` + subtitle `.t-small` `--ink-2`) for table first-cells.
- **Classes:** `.avatar`, `.avatar--24|32|40`, `.avatar-group`, `.identity`. Initials in Inter
  500 on `--accent-tint` / `--accent` (no gradient); photos get a `1px var(--line)` ring.
- **States:** none.
```tsx
<Identity name="A. Suman" subtitle="Engineering" avatar={<Avatar name="A. Suman" />} />
<AvatarGroup max={4}>{members.map(m => <Avatar key={m.id} name={m.name} />)}</AvatarGroup>
```

### 5.12 `Toolbar` — header / table-top control cluster
- **Purpose:** the right-side cluster in `PageHeader` and the filter bar above tables. Keeps
  every page's controls aligned and ordered.
- **Component:** `<Toolbar>` (flex, `gap: var(--sp-3)`, `align-items: center`, all children
  32px tall). **Canonical order:** `Tabs/Segmented` → `Select`s → `DateStepper` → primary
  `Button`. `<DateStepper value onPrev onNext>` = two `IconButton`s + a `--surface-inset` date
  pill.
- **Classes:** `.toolbar`, `.toolbar__divider` (`1px var(--line)`), `.date-stepper`,
  `.date-stepper__pill` (`.mono`).
```tsx
<Toolbar>
  <Segmented … /><Select … /><DateStepper … /><Button variant="primary">New</Button>
</Toolbar>
```

### 5.13 `EmptyState`
- **Purpose:** the one empty/zero-data treatment for every empty list/table/page.
- **Component:** `<EmptyState icon? title description? action? tone?>` ·
  `tone: 'default' | 'danger'` (danger reuses this for page-level errors).
- **Classes:** `.empty` (centered, 48px vertical pad, on `--surface-sunken`, no border),
  `.empty__icon` (48px `--surface-inset` `--r-md`, `--ink-3` line-art glyph), `.empty__title`
  (`.t-h3`), `.empty__desc` (`.t-small`, `--ink-2`), `.empty__action`.
```tsx
<EmptyState icon={<Icon.Inbox/>} title="No approvals" description="You're all caught up."
            action={<Button variant="soft">Refresh</Button>} />
```

### 5.14 `Skeleton` + `Spinner` — loading
- **Purpose:** the only loading treatments. **Never a full-page spinner** — page chrome
  renders; content fills with skeletons sized to the final element.
- **Components:** `<Skeleton w? h? radius?>` (`--surface-inset`, 1.4s shimmer to
  `--line-faint`; static under reduced-motion); `<Spinner size?>` (14px `--ink-3` ring) for
  inline button-busy only. Helpers: `<SkeletonTable rows>`, `<SkeletonStat>`.
- **Classes:** `.skeleton`, `.skeleton--shimmer`, `.spinner`.
```tsx
{loading ? <SkeletonTable rows={5} /> : <Table>…</Table>}
```

### 5.15 `Banner` — inline notice
- **Purpose:** inline error/warn/info/success notices within a page (failed save, policy
  warning). Distinct from the floating `Toast`.
- **Component:** `<Banner status action? children>` · `status: 'danger'|'warn'|'info'|'success'`.
- **Classes:** `.banner`, `.banner--{status}` (status `bg` + `1px` status `ink` border,
  `--r-sm`, status `ink` text, leading status glyph), `.banner__action` (right-aligned ghost
  button, e.g. Retry).
```tsx
<Banner status="danger" action={<Button variant="ghost" size="sm">Retry</Button>}>
  Couldn’t load timesheet.
</Banner>
```

### 5.16 `Popover` / `Menu` / `Toast` — the floating layers
- **Purpose:** the **only** components that use `--shadow-pop`. Dropdowns, action menus, select
  menus, transient toasts.
- **Components:** `<Popover trigger>{content}</Popover>`; `<Menu items>` (`MenuItem` destructive?
  disabled?); `<Toast status>` (bottom-right, `--surface-raised`, `--shadow-pop`, 4px semantic
  left-rail, auto-dismiss).
- **Classes:** `.popover` / `.menu` (`--surface-raised`, `--shadow-pop`, `1px var(--line)`,
  `--r-lg`), `.menu-item` (hover `--surface-inset`; `.menu-item--danger` → `--danger-ink`),
  `.toast`, `.toast--{status}`. Modals (if any) reuse `.popover` chrome centered over
  `--overlay`.
```tsx
<Popover trigger={<IconButton icon={<Icon.More/>} aria-label="Actions" />}>
  <Menu items={[{ label: 'Edit' }, { label: 'Delete', danger: true }]} />
</Popover>
```

### 5.17 `AppShell` + `Sidebar` + `NavItem` — chrome
- **Purpose:** the persistent frame around all 13 pages. (Login renders **without** the shell:
  a centered `Card` on `--surface-sunken`.)
- **Components:** `<AppShell>` (grid `var(--sidebar-width) 1fr`); `<Sidebar>` (brand → grouped
  nav → `me` footer); `<NavItem to label icon active>`; `<NavSection label>` (eyebrow group
  head).
- **Classes:** `.app-shell`, `.sidebar` (`--surface`, right `1px var(--line)`),
  `.sidebar__brand` (24px `--accent` mark + wordmark `.t-strong`), `.nav`, `.nav-section`
  (`.t-eyebrow`), `.nav-item` (36px, `--r-sm`, `--ink-2`; hover `--surface-inset`; **active** =
  `--accent-tint` bg + `--accent` text + 2px `--accent` left-rail), `.sidebar__foot` (Avatar +
  name + sign-out ghost). **One active item only.**
```tsx
<AppShell>
  <Sidebar>
    <NavSection label="Workspace" />
    <NavItem to="/" label="Home" icon={<Icon.Home/>} active />
  </Sidebar>
  <main><Page>…</Page></main>
</AppShell>
```

---

## 6. Composition contract for the 13 page-builders

```tsx
// EVERY page follows this skeleton. Differences are content & grid only.
export function SomePage() {
  return (
    <Page>
      <PageHeader
        eyebrow="Section" title="Page title" subtitle="optional"
        actions={<Toolbar>{/* filters + ONE primary Button */}</Toolbar>}
        tabs={/* optional <Tabs/> for page sections */}
      />

      {/* KPIs */}
      <Card variant="flush"><StatRow>{/* <Stat/>… */}</StatRow></Card>

      {/* Body: compose Card + Table | List | Field — no page-specific styling */}
      <Card title="…" action={/* ghost Button */}>
        {loading ? <SkeletonTable rows={5} /> :
         empty   ? <EmptyState … /> :
         error   ? <Banner status="danger" … /> :
                   <Table>{/* … */}</Table>}
      </Card>
    </Page>
  );
}
```

**Allowed in a page file:** which components, their props/data, and *layout* (grid columns,
`span`, `gap` via spacing tokens, `.stat-grid`, simple flex). **Forbidden in a page file:** any
color / border / radius / shadow / font value; any new component variant; any `fg-*`,
`*-stat`, `*-row`, `*-field`, `*-btn`, `tms-*`, `usr-*`-style bespoke class. If a page seems to
*need* a new look, the fix is a new token or a new shared component **in this file**, reviewed
once — never a one-off in the page.

**Self-check before merging a page:** (1) Only `var(--…)` colors/spacing? (2) ≤ 3 accent hits
in any viewport? (3) Every number mono + tabular (right-aligned in tables)? (4) One primary
Button per viewport? (5) Status only via the 5-tint taxonomy (and charts only via §4)? (6)
Header is `PageHeader`, frame is `Page`? If any answer is no, it is not consistent yet.
