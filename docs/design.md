# Grind — Design System (Figma editorial)

> The single source of truth for how the Grind **web dashboard** looks and feels. Derived from the Figma marketing-site analysis in [`/DESIGN.md`](../DESIGN.md). Tokens live in `apps/dashboard/src/styles.css` (`:root`, the `--fg-*` set, with the legacy names aliased to Figma values). If a value isn't here, add a token first, then use it.
>
> **Scope note:** the dashboard implements this system. The desktop **agent** (`apps/agent`) still runs the legacy violet system — migrating it to Figma is a tracked follow-up; until then the two surfaces diverge intentionally.

**Aesthetic in one line:** a confident black‑and‑white **editorial frame** — Inter for prose, JetBrains Mono for taxonomy, white canvas, 1px hairlines, pill buttons, **no shadows** — punctuated by deliberate **pastel colour blocks**. Technical and calm; a tool for serious work, never candy.

**Brand mark:** the product-facing brand is **Timo**, represented by a transparent teal floating mascot with white eyes and black editorial linework. Use it directly on white or the single soft-lime accent block (`--fg-lime`); never place it inside a decorative badge/card unless the host OS requires a mask. Keep it small, crisp, and calm rather than sticker-like.

---

## 1. Principles

1. **Monochrome frame, colour with intent.** Ink on white is the default. At most **one pastel colour‑zone per viewport** (a KPI band, a summary block); everything else stays monochrome. Colour is the section break, not decoration.
2. **Weight, not opacity, carries hierarchy.** No mid‑gray text. Express emphasis with Inter weights (320–600) and size — never `opacity`/gray fills.
3. **Mono is taxonomy.** JetBrains Mono, UPPERCASE, positive tracking — for eyebrows, labels, tags, ages, captions, dates/times. Never for body copy.
4. **Pills only.** Every button is a pill; every icon button is a circle. No square buttons.
5. **Shadow‑light.** Hairlines (1px `#e6e6e6`) and colour blocks carry depth. Keep a soft shadow only for genuine floating layers (popovers/menus).
6. **No gradients, no violet.** The accent is black. Light theme only.

---

## 2. Tokens — `--fg-*` (`apps/dashboard/src/styles.css :root`)

**Never hardcode** — reference the variable. Legacy names (`--violet`, `--bg-app`, `--font-sans`, `--separator`, `--shadow-*`, `--c-*`) are **aliased** to Figma values so every shared component inherits the system centrally.

### Surfaces & ink
| Token | Value | Use |
|---|---|---|
| `--fg-canvas` | `#ffffff` | Page canvas, cards |
| `--fg-ink` | `#000000` | All text + the single accent |
| `--fg-hairline` | `#e6e6e6` | 1px borders, dividers |
| `--fg-hairline-soft` | `#f1f1f1` | Row separators inside cards |
| `--fg-surface-soft` | `#f7f7f5` | Quiet fills, chip grounds |

### Pastel blocks (the colour vocabulary)
`--fg-lime #dceeb1` · `--fg-cream #f4ecd6` · `--fg-lilac #c5b0f4` · `--fg-coral #f3c9b6` · `--fg-mint #c8e6cd` · `--fg-pink #efd4d4`. One zone per viewport. `--fg-teal #319aa5` and `--fg-teal-deep #2d696d` are reserved for the Timo mascot artwork only. `--fg-magenta #ff3d8b` is the single‑shot alert/risk accent (stuck approvals, high‑risk flags) — use scarcely.

### Type & radii
- `--fg-sans` → **Inter** (figmaSans substitute) — everything.
- `--fg-mono` → **JetBrains Mono** (figmaMono substitute) — uppercase taxonomy only.
- `--fg-r-md 8` · `--fg-r-lg 24` (cards) · `--fg-r-xl 32` · `--fg-r-pill 50` (buttons).
- Fonts loaded in `apps/dashboard/index.html` (Google Fonts).

Spacing (`--sp-1..10`), motion (`--ease`, `--spring`, `--dur-*`), and `.rise`/`.rise-1..3` mount stagger are unchanged and reused.

---

## 3. Type ladder

| Role | Face / size / weight | Use |
|---|---|---|
| Eyebrow | mono · 11px · 500 · UPPER · +0.12em | Context line above a title |
| Page title | Inter · ~24px · 540 · −0.025em | One per page (`.fg-title`) |
| KPI number | Inter · ~30px · 460 · −0.03em · tabular | Headline metrics (`.fg-kpi-num`) |
| Card title | Inter · 15px · 600 | Section/card heads |
| Row name | Inter · 13.5px · 520 | Primary list text |
| Body / sub | Inter · 12–13px · 350–360 | Secondary — recedes by **weight** |
| Taxonomy | mono · 10–11px · 500 · UPPER | Tags, ages, risk, captions, dates |

Negative letter‑spacing scales with size; tight on titles, near‑zero on body.

---

## 4. Components

- **Editorial header — `.fg-head`**: mono `.fg-eyebrow` + tight `.fg-title` + optional `.fg-sub`, closed by a 1px **black** rule. Right rail = `.fg-quicknav` pills.
- **Card — `.fg-card`**: white + 1px hairline + `--fg-r-lg`, no shadow. Head `.fg-card-head` (`.fg-card-title` + `.fg-card-link`/`.fg-cap`).
- **KPI tile — `.fg-kpi` (+`--lime/cream/lilac/coral/mint/pink`, `--link`)**: pastel ground, mono `.fg-kpi-label`, light `.fg-kpi-num` + `.fg-kpi-unit`, `.fg-kpi-sub`; clickable tiles get a circular `.fg-kpi-arrow`. The KPI band is the page's colour zone.
- **List row — `.fg-row`**: hairline‑separated; `.fg-row-name` (weight) + `.fg-row-sub`, with `.fg-row-meta`/`.fg-tag`/`.fg-risk` and a right‑aligned mono `.fg-age` (`--stuck` → magenta).
- **Pill button — `.fg-pill` / global `.btn`**: black = primary, white + 1px hairline = secondary; `:hover` fills black. Icon buttons are circles.
- **States**: `.fg-empty` (quiet editorial line), `.fg-note` (mono loading), `.fg-error`.

These live in `styles.css` under **"FIGMA THEME … Overview"** and the global **"FIGMA GLOBAL"** override layer. The override layer is where the shared primitives (`.btn`, `.stat-chip`, `.hero`, `.login-*`, `.nav-*`) are flipped to Figma centrally — change the global look there, not per page.

---

## 5. Page structure (every screen)

```tsx
import './<page>.css';            // page-unique styles, classes prefixed <pfx>-
…
<div className="fg-overview">
  <div className="fg-inner">
    <header className="fg-head">…</header>
    {/* reuse the .fg-* kit; one pastel zone max */}
  </div>
</div>
```

- Reuse the shared `.fg-*` kit first; only add **prefixed** page CSS in `apps/dashboard/src/screens/<page>.css` for layout the kit doesn't cover.
- `Overview.tsx` is the canonical reference page — mirror its vocabulary.
- Preserve behaviour: tokens/markup change, data/hooks/routes don't.

---

## 6. Do's & Don'ts

| ✅ Do | ❌ Don't |
|---|---|
| Ink on white; hairlines for structure | Shadows for separation (except popovers) |
| One pastel zone per viewport | Multiple colour blocks in one view; rainbow chips |
| Weight + size for hierarchy | Mid‑gray / opacity'd text |
| Mono UPPERCASE for taxonomy | Mono in body copy |
| Pill buttons, circular icon buttons | Square/gradient buttons; any violet |
| Tokens (`var(--fg-…)`), prefixed page CSS | Hardcoded hex; editing shared `.fg-*` per page |
| Lucide icons, ~2px stroke | Emoji / Material icons |

---

## 7. Adding to the system
1. Need a value? Add a `--fg-*` **token** first, then reference it.
2. Need a component? Reuse a `.fg-*` class; only invent (prefixed, in the page's CSS) when nothing fits.
3. A new **shared** primitive belongs in the "FIGMA GLOBAL" layer of `styles.css` + documented here.
4. Migrating the desktop agent to this system is the open follow‑up — keep this doc as the target spec for both surfaces.
