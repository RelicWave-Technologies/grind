---
version: 1
name: Timo, in the EMIAC house style
description: >-
  Timo is an EMIAC product, and it looks like the family it belongs to. Light and quiet: a white
  page, one variable typeface at 400–560 and never bold, greys for everything secondary, and Azure
  (EMIAC blue, one step lighter) for the one primary action and for tracked time. Data sits on white cards with a hairline
  border and 20px corners. Gradient and grain appear on the named marketing surfaces and nowhere
  near a number. The logo is a capital T whose bar is a day ribbon, with the moment, now, in blue at its end.
source: >-
  The EMIAC house style as written for Crux (Crux repo, docs/architecture/DESIGN.md, version 2,
  2026-09-26), itself read value by value from the EMIAC landing page. Carried into Timo on
  2026-09-27. On 2026-09-28 the accent moved from EMIAC blue (#005cb1) to Azure (#2f6fd0), EMIAC
  blue one step lighter, chosen by Abhishek from six options reviewed on the desktop app. The
  systems it replaces are archived in docs/archive/.

colors:
  white: "#ffffff"
  ink: "#111111"
  ink-2: "#2a2d31"
  body: "#45484d"
  muted: "#63676d"
  faint: "#9a9ea4"
  sheet: "#f4f5f6"
  sheet-soft: "#f9fafb"
  sheet-2: "#eceef1"
  line: "#e4e6e9"
  line-soft: "#eef0f2"
  line-strong: "#d3d7dc"
  brand: "#2f6fd0"
  brand-deep: "#2459ad"
  brand-hi: "#5b93e3"
  brand-wash: "#edf3fd"
  brand-edge: "#c0d5f4"
  dark: "#0f1216"
  dark-line: "#262b33"
  on-dark-muted: "#8a93a0"
  good: "#15803d"
  good-wash: "#eaf6ee"
  bad: "#b91c1c"
  bad-wash: "#fdecec"
  bad-edge: "#f3c7c7"
  wait: "#6b5400"
  wait-wash: "#fff4c4"
  teal: "#0f6b63"
  tint-teal: "#dff6f2"
  tint-coral: "#fde4e4"
  tint-rose: "#fbe4f1"
  tint-orange: "#ffeedd"
  sky-top: "#d6e6fb"
  sky-mid: "#e9f1fd"
  sky-low: "#f4f8fd"
  tone-negative: "#e5564e"
  tone-neutral: "#eda100"
  tone-positive: "#1baf7a"
  series-1: "{brand}"
  series-2: "#eb6834"
  series-3: "#1baf7a"
  series-4: "#eda100"
  series-5: "#e87ba4"
  series-6: "#4a3aa7"
  heat-0: "{sheet-2}"
  heat-1: "{brand-edge}"
  heat-2: "#8db1ea"
  heat-3: "{brand-hi}"
  heat-4: "{brand}"
  ribbon-work: "{brand}"
  ribbon-meeting: "{brand-edge}"
  ribbon-manual: "{brand-wash}"
  ribbon-manual-stripe: "{brand-hi}"
  ribbon-pending: "{wait-wash}"
  ribbon-pending-edge: "{wait}"
  ribbon-idle: "{sheet-2}"
  ribbon-gap-edge: "{line-strong}"

fonts:
  sans: '"Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
  mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace'

typography:
  display:
    fontSize: 40px
    fontWeight: 440
    lineHeight: 1.1
    letterSpacing: -0.02em
  page-title:
    fontSize: 36px
    fontWeight: 460
    lineHeight: 1.08
    letterSpacing: -0.02em
  title:
    fontSize: 28px
    fontWeight: 460
    lineHeight: 1.15
    letterSpacing: -0.02em
  section-title:
    fontSize: 22px
    fontWeight: 460
    lineHeight: 1.2
    letterSpacing: -0.015em
  card-title:
    fontSize: 17px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: -0.01em
  timer:
    fontSize: 48px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: -0.03em
  figure:
    fontSize: 36px
    fontWeight: 420
    lineHeight: 1.05
    letterSpacing: -0.03em
  lede:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.55
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.55
  body-lg-strong:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  body-sm-strong:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.45
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.4
  micro:
    fontSize: 12px
    fontWeight: 450
    lineHeight: 1.4
  overline:
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.06em
  button:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
  kicker:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
    fontFamily: mono
  index:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.7
    fontFamily: mono

rounded:
  xs: 4px
  sm: 6px
  md: 10px
  lg: 12px
  xl: 16px
  card: 20px
  feature: 24px
  frame: 28px
  full: 999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 20px
  xl: 24px
  xxl: 32px
  xxxl: 40px
  section-sm: 48px
  section: 64px
  section-lg: 96px
  hero: 120px

control:
  height-sm: 28px
  height: 36px
  height-lg: 44px

layout:
  rail-width: 264px
  desktop-rail-width: 232px
  desktop-toolbar-height: 48px
  page-max: 1280px
  page-gutter: 32px

motion:
  duration-fast: 150ms
  duration-base: 200ms
  duration-slow: 320ms
  ease-standard: cubic-bezier(0.2, 0.7, 0.2, 1)
  ease-emphasised: cubic-bezier(0.22, 1, 0.36, 1)

elevation:
  none: none
  "1": 0 1px 2px rgb(17 17 17 / 0.06)
  "2": 0 6px 16px -6px rgb(0 30 70 / 0.18)
  "3": 0 1px 2px rgb(17 17 17 / 0.06), 0 40px 90px -40px rgb(0 30 70 / 0.42)
  "4": 0 16px 44px rgb(17 17 17 / 0.08), 0 2px 6px rgb(17 17 17 / 0.04)
  chip: 0 10px 30px rgb(0 30 70 / 0.12)
---

# Timo — design system

**This file is the sole authority on how Timo looks**, on both surfaces: the web dashboard
(`apps/dashboard`) and the desktop app (`apps/agent`). Every value in the front matter becomes a
CSS custom property through `packages/design/scripts/generate-tokens.ts`, and both apps import the
same `@grind/design` stylesheet. A colour, size, radius or shadow that is not here does not exist
in either app. The file is written before the component, never after.

A value written as `"{name}"` is a reference to another colour in this file and is emitted as
`var(--color-name)`, so a role (the ribbon, the heatmap) can never drift from the palette it is
drawn from.

## 1. Where it comes from

Timo is an EMIAC product, sold and supported next to Crux. The EMIAC house style is calm,
confident, blue and white. Timo used to wear three systems at once: a violet one, a black-and-white
"Figma editorial" one with pastel blocks, and a "Quiet Datasheet" kit layered over both. This
system replaces all three (archived in `docs/archive/`) with the house materials: the palette,
typeface, corners, chips and frames that Crux already wears.

**Translation rule: keep the materials, change nothing a person relies on.** The revamp that
introduced this file changes **how Timo looks, never what it shows**: every screen keeps its
blocks, words and behaviour exactly as they were. A redesign of a flow is a separate decision.

## 2. The idea in five lines

1. **White and quiet.** The page is white, text is near-black, everything secondary is grey.
2. **Blue means tracked, and the one thing to press.** Azure marks tracked time — the ribbon's
   work blocks, the heatmap, the running timer's progress — and the one primary action on a
   screen. It is never decoration.
3. **Never bold.** One variable typeface, 400–560. Hierarchy comes from size and grey, not weight.
4. **Soft corners, thin lines.** Cards are 20px round with a 1px hairline and no shadow. Only
   things that float get a shadow.
5. **Colour is earned.** Gradient and grain live on the named marketing surfaces (§9) and never
   behind a number.

## 3. Colour

| Role | Tokens | Where |
| --- | --- | --- |
| Primary action | `brand`, hover `brand-deep` | One per screen: `button-primary`, a checked checkbox, a switch that is on |
| Tracked time | `brand` → `brand-edge` → `brand-wash` | Ribbon work / meeting / manual blocks, heatmap, the timer's live dot ring |
| You | `brand-wash`, `brand-edge` | Your own row in a team table, the current person in a picker |
| Text | `ink` → `ink-2` → `body` → `muted` | Heading → strong copy → copy → labels and table headers |
| Placeholder, absent | `faint` | Placeholders, "—", disabled. **Never information** (2.69:1) |
| Surface | `white`, `sheet-soft`, `sheet`, `sheet-2` | Page and cards → quiet panels → fills → chips and hover |
| Line | `line-soft`, `line`, `line-strong` | Row dividers → card borders → control borders |
| Good / bad | `good` + `good-wash`, `bad` + `bad-wash` + `bad-edge` | Approved, tracking, on time / rejected, failed, late, deleting |
| Waiting | `wait` on `wait-wash` | Pending approval, paused, needs attention — waiting, not wrong |
| Tints | `tint-teal`, `tint-coral`, `tint-rose`, `tint-orange` | Identity only: the tile behind a task's icon, the initial behind a missing avatar or app icon. Never status |
| Tone | `tone-negative`, `tone-neutral`, `tone-positive` | A three-band bar, always beside its numbers |
| Series | `series-1` … `series-6` | Chart lines and bars, in a fixed order (§10) |
| Sky | `sky-top`, `sky-mid`, `sky-low` | The sky frame only (§9) |
| Dark | `dark`, `dark-line`, `on-dark-muted` | The toast and the tour offer — the only dark surfaces |
| Mark | `ink`, `brand`, `white`, `brand-hi`, `dark` | The Timo logo (§9 The logo) |

**Measured contrast on white:**

| Text colour | Ratio |
| --- | --- |
| `ink` | 18.9:1 |
| `ink-2` | 13.8:1 |
| `body` | 9.2:1 |
| `muted` | 5.7:1 (5.2:1 on `sheet`, 4.9:1 on `sheet-2`) |
| `brand` | 4.9:1 (4.4:1 on `brand-wash`: use `brand-deep` for text on a wash) |
| `brand-deep` on `brand-wash` | 6.1:1 |
| `good` on `good-wash` | 4.5:1 |
| `bad` on `bad-wash` | 5.7:1 |
| `wait` on `wait-wash` | 6.6:1 |
| white on `brand` | 4.9:1 |

**Rules.**

- `muted` is the floor for anything a person must read.
- Status never travels on colour alone. "Approved" says approved, a late arrival says late, a flag
  says its risk in words.
- No pastel colour blocks. The old lime, lilac, cream, mint, coral and pink zones are gone; a KPI is
  a white card.

## 4. Type

**Instrument Sans**, variable, weights **400–560**, served from `packages/design/fonts/` (OFL 1.1)
so the desktop app, which cannot reach the internet for a font, draws the same letters as the
dashboard. **Nothing is 600 or 700.** **Geist Mono** is used for the `kicker` and `index` steps and
for times, dates and codes where a screen already sets them apart.

| Step | Size / weight | Use |
| --- | --- | --- |
| `display` | 40 / 440 | Sign-in and marketing titles |
| `page-title` | 36 / 460 | One per dashboard screen |
| `title` | 28 / 460 | A page-state heading; **the screen title inside the desktop window** (sections under it use `card-title`) |
| `section-title` | 22 / 460 | A titled card or section |
| `card-title` | 17 / 500 | A card's own name, a drawer panel, a prompt's question |
| `timer` | 48 / 400, tabular | The running timer on Today (smaller surfaces scale it down, §9) |
| `figure` | 36 / 420, tabular | A stat card's number |
| `lede` | 17 / 400 | The sentence under a title |
| `body-lg` | 16 / 400 | Page copy |
| `body-sm` | 14 / 400 | Table cells, most controls |
| `body-sm-strong` | 14 / 500 | Names in a list, row titles |
| `caption` | 13 / 400 | Hints, notes, secondary lines |
| `label` | 13 / 500 | Chips, badges, table header text |
| `micro` | 12 / 450 | Counts in a tab, tiny meta, axis labels |
| `overline` | 11 / 500, uppercase, 0.06em | Group labels, a stat card's name |
| `button` | 14 / 500 | Every button |
| `kicker`, `index` | Geist Mono 12 | Times on a ribbon axis, a date code, the `01` chip |

Headings balance their lines. **Every number, time and duration uses
`font-variant-numeric: tabular-nums`**, so a ticking timer never jitters.

## 5. Layout

### The dashboard shell

```
┌────────────┬─────────────────────────────────────────────────────────┐
│ ◉ Timo     │                                                         │
│            │   Page title                                   [Action] │
│ ⌂ Home     │   The sentence that says what this screen is for.       │
│ ◎ Overview │                                                         │
│ ◷ Edit Time│   ┌──────── card: white, 1px line, 20px ─────┐ ┌──────┐ │
│ ▤ Reports  │   │                                          │ │      │ │
│ ▢ Approvals│   └──────────────────────────────────────────┘ └──────┘ │
│ …          │                                                         │
│ ────────── │                                                         │
│ (AV) Name  │   max 1280px, 32px gutters, 20–24px between cards       │
└────────────┴─────────────────────────────────────────────────────────┘
```
- **Rail.** White, a hairline on its right, `layout.rail-width` (264px).
  - Top: the logo mark at 28px beside "Timo" in `card-title`.
  - Items are 34px, `md` round, `body-sm` in `body` with a Lucide icon, and hover to `sheet`.
    **The current screen is `sheet-2` with `ink` text and icon.** Blue stays for tracked time and
    the primary action.
  - The foot is the account: avatar or initials in an `ink-2` circle, name and role, sign-out.
    The desktop-app download sits above it as a quiet `button-secondary`.
- **No top bar.** The dashboard never had one and the revamp adds nothing a screen did not show;
  the page title is the first thing in the content column.
- **The page.** `layout.page-max` (1280px) with `layout.page-gutter` (32px). Title, then content.
  Sections sit 24px apart and cards 20px apart.
- **Mobile (<1024px).** The rail becomes a horizontal strip across the top: the mark, the items in a
  row, the account at the end.

### The desktop window

The main window (960×640, min 720×460) is the same shell at desktop density:

- **Rail.** White, `layout.desktop-rail-width` (232px), a hairline on its right. Its top row is
  `layout.desktop-toolbar-height` (48px) tall, so the logo and "Timo" sit on the same line as the
  macOS traffic lights, and leave 76px for them. Items, the current item and the account foot are
  the dashboard rail's (§5).
- **Toolbar.** `layout.desktop-toolbar-height` (48px), white, no hairline: the screen's title and its
  one or two actions. It is the window's drag handle.
- **Content.** White, 32px side gutters, a 720px column for Today and Tasks. The window
background is `white`, not macOS grey. A screen's title is `title` (28px), not `page-title`.

## 6. Elevation

Level 0 is a 1px `line` border, on every card, table and tile. Shadow is reserved:

| Token | Only on |
| --- | --- |
| `elevation-1` | A slider thumb, a switch knob, a mark sitting on a plot |
| `elevation-2` | A decorative element lifted inside a sky frame |
| `elevation-3` | The window-like frame inside a sky frame; drawers |
| `elevation-4` | Every popover: menus, pickers, hover cards, modals, the lightbox, the toast |
| `elevation-chip` | A chip floating over a sky frame |

A flat card never gets a shadow. A desktop overlay window (popover, floating bar, prompts) gets its
shadow from the operating system, not from CSS: its card fills the window, and a CSS shadow would be
clipped by the window's edge.

## 7. Shape

Corners grow with the size of the thing:

| Radius | On |
| --- | --- |
| `xs` 4 | Focus rings, ribbon blocks, heatmap cells, tiny marks |
| `sm` 6 | Flags, small chips, screenshot thumbnails |
| `md` 10 | Rail items, inputs, options, menu items |
| `lg` 12 | Tiles, the account menu, the ribbon's track |
| `xl` 16 | Popovers, drawer panels, desktop overlay cards |
| `card` 20 | Every card and notice |
| `feature` 24 | A large feature panel on a marketing surface |
| `frame` 28 | The sky frame |
| `full` | Buttons, pills, badges, segmented controls, the floating bar, the toast |

Nothing in between.

## 8. Motion

- Curve: `ease-standard` (the landing's `cubic-bezier(0.2, 0.7, 0.2, 1)`).
- Timing: `duration-fast` 150ms for colour and borders, `duration-base` 200ms for panels and
  chevrons, `duration-slow` 320ms for disclosures.
- Rows settle in with a 6px rise.
- The live tracking dot breathes (opacity 1 → 0.45 over 1.8s). Nothing else loops.
- Under `prefers-reduced-motion`, everything shows its finished state and the dot holds still.

## 9. Components

Each spec names the classes it styles where they already exist. The class is the seam: markup keeps
its classes, and the design lives in the rule.

### Buttons

Pills, `control.height` (36px; `height-sm` 28px inside dense rows and small overlays), `button`
type, `full` round, 0 16px padding.

| Button | Look |
| --- | --- |
| Primary | `brand` fill, white text, `brand-deep` on hover |
| Primary danger | `bad` fill, at a confirmation step only, and it stays red on hover |
| Secondary | White, 1px `line-strong` border, `ink` text; the border turns `ink` on hover |
| Ghost | No border, `ink-2` text, `sheet` on hover |
| Link | `brand` text, underlined |
| Icon | A 32px circle, ghost by default |
| Disabled | Drains to `sheet` with `faint` text. It never turns a paler blue |

**Start / Stop.** The timer's start button is the screen's primary (blue). While tracking, Stop is
a secondary button, and Pause/Resume sit beside it as ghosts. Stopping is not a danger.

### Pills, menus and pickers

- **Pill.** 34px, white, 1px `line-strong` border, `full` round, `label` type. When open, the
  border is `ink`.
- **Panel.** White, 1px `line`, `xl` round, `elevation-4`, 8px padding.
- **Option.** A row in the panel: `md` round, `sheet` on hover, a tick in `brand` when chosen.
- **Time picker and task picker** (`tp-*`, `tc-*`). Panels. The chosen time fills `ink` with white
  text; times outside the allowed window are `faint`.
- **Date stepper.** A secondary pill holding ‹ date ›; the date in `body-sm-strong`.

### Tabs — segmented control

A `sheet` track, 4px padding, `full` round, as wide as its tabs. Items are 28px pills in `label`
type and `body` colour. The chosen item is filled `ink` with white text, with its count in `micro`.
No rule is drawn under a tab row. Page tabs and segmented toggles are the same control.

### Cards and stats

- **Card.** White, 1px `line`, `card` round, 24px padding, no shadow. A card's head is its
  `card-title` with a `caption` link or note on the right.
- **Stat.** A white card (or a cell in a row of them, divided by hairlines): `overline` name in
  `muted`, `figure` number in `ink`, unit in `body-lg` `muted`, a `caption` line under it. A
  clickable stat shows a chevron and turns its border `line-strong` on hover.
- **Notice.** A card-shaped message: `sheet-soft`, 1px `line-soft`, `card` round, `body` text.
  Error notices are `bad-wash` with a `bad-edge` border and `bad` text; waiting notices are
  `wait-wash` with `wait` text; a confirmation is `good-wash` with `good` text. A one-line notice
  (a banner inside a page) is `lg` round rather than `card`, so it does not read as a pill.
- **A card never sits inside a card.** Parts inside a card are divided by hairlines.

### Tables and lists

- No outer border inside a card.
- Header cells in `label` type, `muted`, sentence case, on a 1px `line` underline.
- Rows divided by `line-soft`, cells 12px × 16px, hover `sheet-soft`.
- Numbers, times and durations right-aligned and tabular.
- Your own row and selected rows fill `brand-wash`.
- A table that is a screen's main content sits in a card and runs edge to edge inside it.

### Badges and status

| Meaning | Look |
| --- | --- |
| Neutral (role, count, tag) | `sheet-2` / `muted`, `full` round, `label` type |
| Approved, resolved, on time, tracking | `good-wash` / `good` |
| Rejected, failed, late, high risk | `bad-wash` / `bad` |
| Pending, paused, medium risk, needs attention | `wait-wash` / `wait` |
| Cancelled, low risk, off | `sheet-2` / `muted` |
| You | `brand-wash` / `brand-deep` with a `brand-edge` ring |

- **Tracking state** is the word with a 7px dot: `good` for Tracking (breathing, §8), `wait` for
  Paused, an empty `faint` ring for Not tracking.
- A status card or row may carry a 3px left rule in its status colour. Never a coloured card fill.

### Inputs

- **Text input.** `control.height` (36px), so it lines up with the buttons beside it; white, 1px
  `line-strong` border, `md` round, `body-sm`. On focus, a `brand` border and a 3px `brand` ring at
  12%. Placeholder `faint`.
- **Checkbox and radio.** 18px, `xs` round (radio `full`), `brand` fill when checked.
- **Switch.** A 32×18 `full` track, `sheet-2` off and `brand` on, a white knob with `elevation-1`.
- **Select.** A text input carrying the chevron in `muted`.

### Drawers, modals, lightbox

- **Scrim.** `ink` at 20%.
- **Drawers.** Slide from the right. White, `xl` round on the leading corners, `elevation-3`.
- **Modals.** White, `xl` round, `elevation-4`. Title `section-title`, body a column with a `lg`
  gap, actions right-aligned at the foot on a `line-soft` rule.
- **Screenshot lightbox.** The scrim deepens to `dark` at 80%; the image sits `lg` round; its time
  and activity in `caption` on white chips beneath.

### Popovers — menus, hover cards, the account menu

White, 1px `line`, `lg`/`xl` round, `elevation-4`, `caption` type. Items are `md` round rows;
"Sign out" is last, after a `line-soft` rule, in `bad`.

### App states

- **Empty.** A quiet line in `muted`, centred in the card that would hold the data, with the way
  forward as a secondary button when there is one. Never a big illustration.
- **Loading.** Skeleton bars on `sheet-2`, `xs` round, pulsing 1 → 0.45 over 1.8s.
  `role="status"` with a label.
- **Error.** A notice-error with one sentence and a retry.
- **Toast.** `ink` background, white text, `full` round, `elevation-4`, bottom centre. An error
  toast is `bad`. A confirmation leaves after 5s; an error stays.

### The day ribbon — `DayRibbon`, `DayTimeline`

The day's honest picture, and the one place colour carries meaning at a glance. It is the same on
both surfaces.

- **Track.** 40px, `md` round, `sheet-soft` with a 1px `line-soft` edge. The assigned shift is the
  part of the track drawn `white`, edged left and right by 1px `line`; outside the shift the
  track stays `sheet-soft`. Time still to come is hatched in `line-soft`.
- **Blocks** are `xs` round with 1px of white between neighbours:

| Kind | Fill | Legend word |
| --- | --- | --- |
| Tracked work | `ribbon-work` (solid `brand`) | Tracked |
| Meeting | `ribbon-meeting` (`brand-edge`) | Meeting |
| Approved manual time | `ribbon-manual` with 45° `ribbon-manual-stripe` hatching | Manual |
| Pending request | `ribbon-pending` with a 1px dashed `ribbon-pending-edge` | Pending |
| Idle, trimmed | `ribbon-idle` | Idle |
| Gap (untracked, in shift) | White with a 1px dashed `ribbon-gap-edge` | Untracked |

- **Now** is a 2px `ink` line with a 6px `ink` dot on top. Not red.
- **The live block** (the segment being tracked right now) breathes like the tracking dot (§8).
- **Axis.** Hours in 11px Instrument Sans, tabular, `muted`, every 3 hours.
- **Legend.** A row of 8px `xs`-round swatches with their words in `caption` `body`. The ribbon
  never relies on colour alone: every kind has its legend word and its hover card.
- A block's hover card is a popover: kind, times in mono, duration, task.

### Activity heatmap — `ActivityHeatmap`

Ten-minute cells, `xs` round, 2px apart, on the sequential blue ramp `heat-0` (no activity) →
`heat-4` (full). The legend is the five swatches with "Less" and "More" in `micro`. A cell's hover
card gives the time and the percentage.

### Screenshots

- **Grid.** Thumbnails `sm` round with a 1px `line` edge, in a responsive grid, 12px apart. Under
  each: the time in `kicker`, activity as `micro` `muted` ("Keys 42% · Mouse 18%").
- **Upload state** is a `badge` on the thumbnail's corner only when it is not uploaded: `wait` for
  uploading, `bad` for failed.

### Charts

See §10.

### Desktop surfaces

Each overlay window is transparent and frameless; the card fills the window and the OS draws the
shadow (§6). All of them are white with a 1px `line` edge.

- **The timer card** (Today). A white card: the time in `timer` (48) tabular `ink`; under it the
  tracking dot and the task name in `body-sm` `body`. Its actions are 44px circles on the right:
  Start and Resume are primary (`brand`), Stop is secondary (white, `line-strong` edge, an `ink`
  square). Stopping is not a danger and is never red.
- **Task rows.** White tiles, `xl` round, 1px `line`, 16px padding: a 40px `md`-round identity
  tile (a tint, §3) with its icon in `ink-2`, the title in `body-sm-strong`, meta in `caption`
  `muted`, then badges. The row being tracked has a `brand` edge. The row's action is a 34px
  circle: secondary at rest, `brand` on hover for Start, `ink` edge for Stop.
- **Tray popover** (300×340). `xl` round. The timer in `figure` (36) tabular; the task in
  `caption` `body` behind the tracking dot; Resume is primary and Stop secondary, full width. When
  idle: today's total on a `sheet-soft` panel, a search pill, then `option` rows with a 28px start
  circle.
- **Floating bar** (268×44). A `full`-round pill, white, 1px `line-strong`, no blur. From the
  left: a drag grip in `faint`, the tracking dot (§ Badges), the time in `body-lg-strong` tabular,
  the task name in `caption` `muted` with an ellipsis, then Pause (a `sheet` circle) or Resume (a
  `brand` circle) and Close (ghost), all 28px.
- **Prompts** — idle warning, idle, away, permission (340–480 wide). `xl` round, 20px padding. The
  question in `card-title`, the explanation in `body-sm` `body`. The countdown in `figure`
  tabular. Actions at the foot: the safe choice is `button-primary`, the rest secondary.
- **Ready to work** (320×168). The same card: the logo at 32px, the question in `card-title`, two
  buttons.
- **Banners inside the window** (update ready, recovery, syncing) are notices (§ Cards), full
  width at the top of the content.

### The logo

The Timo mark is **T ribbon**: a capital T whose bar is a day ribbon, with a gap and then a short
blue pill at its end, the moment that is now. The T is black; now is blue, the same rule as the
rest of Timo (§2). Chosen 2026-10-04 from three rounds (it replaced "Ribbon · stacked", which had
retired a character mascot).

- **Drawn once**, on a 64 grid, in `apps/agent/src/renderer/assets/timo-logo.svg`: the bar 30 × 12
  and the moment 16 × 12 with a 4 gap between them, the stem 12 × 29 under the middle of the mark,
  every end fully round. `pnpm --filter @grind/agent icon` makes every other asset from it.
- **Wordmark.** "Timo", capital T, in Instrument Sans at `card-title` (17 / 500) beside the mark in
  the app; 22 / 500 at −0.02em in a lockup. Never lowercase, never bold.
- **Colour.** On white: the T in `ink`, the moment in `brand`. On `dark`: the T in `white`, the
  moment in `brand-hi`. In one colour (a template image, a fax-flat print): all of it in that
  colour, the gap still setting the moment apart. Never a gradient on the mark, never outlined.
- **The app icon** is a `dark` tile on Apple's 1024 grid (an 824 body, 185 corner) shading from
  `ink-2` at the top to `dark`, with a 1px white hairline at 8% round its edge and the mark in
  white and `brand-hi` at 56% of the body. The favicon is the same tile.
- **The menu-bar icon** is the mark redrawn on a 16 grid (4px bar and stem, 1px gap, whole pixels)
  as a black template image the system tints; Windows gets the same grid in `ink` with a `brand`
  moment.

| Where | Size |
| --- | --- |
| Rail and window headers, beside "Timo" | 28px |
| Prompts and the tray popover | 28–40px |
| Sign-in | 56–96px |
| Menu bar | 16pt template |

### The colour surfaces

Only these may use a gradient or grain. They are the marketing and sign-in surfaces; the app
behind sign-in has none.

| Surface | Treatment |
| --- | --- |
| Welcome page hero and feature panels (`welcome-*`) | Sky frame |
| Changelog release cards' header art (`changelog-*`) | Sky frame, `feature` round |
| Sign-in aside (`login-*`) | Sky frame, `frame` round |

**Sky frame.** Three layers:
- `radial-gradient(120% 90% at 85% 0%, brand-hi at 30%, transparent 60%)`
- `radial-gradient(90% 70% at 0% 100%, brand at 12%, transparent 60%)`
- `linear-gradient(180deg, sky-top, sky-mid 55%, sky-low)`

Over them, a 48px grid of `white` at 55% lines, masked to fade downward. A product screenshot or
GIF inside a sky frame sits in a white window frame, `lg` round, `elevation-3`.

## 10. Charts

- **Series order is fixed and never cycled.** `series-1` (`brand`) is always tracked time or the
  person the chart is about; comparison series take `series-2` to `series-6` in the order the
  screen lists them. A filter that hides a series does not repaint the others.
- **Drawing.** Lines are 2px (the subject 2.5px) with round caps. Markers carry a 2px white ring.
  Bars are `xs` round at the top. The grid is `line-soft` and the axes `muted` `micro`. One y-axis
  only.
- `series-3`, `series-4` and `series-5` sit under 3:1 against white as strokes, so a chart with
  more than one series labels each line at its end and carries a legend.

## 11. Do and don't

**Do**
- Let white space and grey do the hierarchy.
- Mark tracked time in blue everywhere.
- Put one primary button on a screen.
- Keep numbers tabular.
- Say "not enough data" in words, never as `0`.

**Don't**
- Bold anything.
- Put a gradient behind data.
- Use pastel colour blocks.
- Nest cards.
- Give a flat card a shadow.
- Use blur or glass.
- Use emoji as icons.
- Invent a value this file does not list.
- Change what a screen shows in the name of how it looks.

## 12. Icons

Lucide at a **1.6px stroke** (the landing's), set once in `@grind/design`'s foundation. An icon
takes the colour of the text beside it.

## 13. Known gaps

- **Dark mode is not specified.** It is out of scope for v1 (docs/product.md).
- **The native tray menu, OS notifications and system dialogs** are drawn by the operating system
  and do not take this system.
- **Three chart series are under 3:1 as strokes** (§10). Labels and legends carry identity.
