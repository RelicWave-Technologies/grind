---
name: interactive-product-deck
description: >-
  Build a polished, light-mode-first INTERACTIVE product deck — a "living Figma"
  that pitches a software product by REPLAYING its real workflows in faithful
  in-deck app mockups (desktop windows, phones, chat) where things actually move:
  streaming activity, tool calls, approvals you can click, multi-surface sync.
  Use when someone wants to present/pitch a product, feature, or workflow to a
  client/team/exec with animated, clickable mockups instead of static slides, or
  says "make a deck / pitch / interactive mockup / show it working / day-in-the-life".
  Trigger: /interactive-product-deck
---

# Interactive Product Deck

You build a **self-contained multi-page static HTML deck** (no build step, relative
links, servable by `python3 -m http.server`) whose centerpiece is one or more
**interactive replays** of a product's real workflows. The UI animates step by step —
thinking → tool calls → data → approvals → result — inside **faithful replicas of the
real app's surfaces**. It is a *living Figma*: it plans the product, shows the UI, and
the flows actually run. Default to **light mode**.

This is a visual pitch, **not a document**. Minimal text, maximum motion.

---

## The method — always follow in order

### 1 · Understand the product (analyze first, ask second)
Do real research before asking the user anything obvious.
- Inspect the codebase / context: what the product does, its **surfaces** (web app,
  desktop, mobile, chat bot, CLI), the **real UI** (read the actual CSS tokens and
  component markup — e.g. `globals.css`, the timeline/message components), **data
  shapes**, **tool / integration names**, **channels**, **RBAC**, **streaming events**.
- **Pull the REAL design tokens and component structure from the source** so the
  mockups are pixel-faithful, not approximations. If the app has a signature detail
  (a shimmer, a specific row layout, a status ribbon), copy it 1:1.
- Identify the company's actual stack and domain (who uses it, what they do all day) —
  the deck must feel like *their* world, with *their* tool names and data.
- Only then, if context is thin, ask **3–5 targeted questions**: Who is the audience
  (client / exec / team)? What is the **one** story to land? Which surfaces to show?
  Which workflows are most impressive *moving*? Any real names/data to use?

### 2 · Ideate the interactive scenarios (the "what moves")
- A great deck shows things **actually moving**. Pick workflows that animate well:
  anything **multi-step, streaming, cross-surface, or gated by an approval**.
- Strongly prefer **ONE complex, cross-domain ask** decomposed into a live plan
  (a checklist that ticks off) over many small siloed demos. "One messy ask → the
  system runs the whole company" lands harder than six isolated features.
- For each scenario decide: which **surfaces** appear (replicate each faithfully),
  what **steps stream**, where the **human approves** (the trust beat), what the
  **payoff** is, and how **secondary surfaces** react in sync (e.g. a phone lighting
  up as the desktop works).
- Plan the **pages**: `index` (Overview — the thesis + a "connected to the root"
  system map), the **interactive Day/Replay** (the centerpiece), a **UI tour**, and
  `integrations` / `architecture` / `roadmap` as the story needs.

### 3 · Pitch before building
Present a tight plan to the user **before generating thousands of lines**:
- The page list.
- Each interactive scene in one line.
- The app surfaces you'll replicate (and that you'll match the real UI).
- The visual identity (light-first, the accent, fonts).
Get explicit approval on the **shape**, then build.

### 4 · Build
- **Files**: `deck.css` (bundled design system — copy `assets/deck.css`), `deck.js`
  (shared top-nav — copy `assets/deck.js`), one `*.html` per page. Relative links,
  no framework, no build.
- **Light-mode-first.** The chrome (page, nav, cards, hero, tables) is light. The
  **embedded app mockups** match the real product: if the real app is dark and the
  deck is light, either keep mockups dark (premium, like Stripe/Linear screenshots)
  **or** theme them light if the user asks — `assets/deck.css` ships a light theme
  whose device replicas are overridden to light via a higher-specificity block, so
  flipping device theme = editing/removing one block.
- **Faithful replicas.** Reuse the real app's tokens and component structure. Embed
  real brand logos as inline SVG (or base64 PNG from the brand's site) for integration
  marks; use clean Lucide-style line icons for concepts.
- **The interactive replay engine** is the heart — see `assets/replay-engine.md`.
- **Verify before declaring done**: headlessly syntax-check every inline `<script>`
  (`new Function(src)`), serve the folder, and click through **every scene** including
  **Approve and Decline** on each gate. The demo must never hang.

---

## Design system — bundled in `assets/deck.css`

Light-mode-first "Obsidian-neutral" system. Edit tokens at `:root`; every page follows.

- **Tokens**: light surfaces (`--bg`, `--surface-1..4`), dark text (`--fg`,
  `--fg-muted/dim/faint`), translucent borders, ONE disciplined blue **`--accent`**,
  **dark `--primary`** (button) with light `--on-primary`, status hues
  (`--green/amber/red/blue` + `*-bg` tints), warm inline `--code-bg/--code-fg`,
  radii, fonts (Inter + JetBrains Mono), soft shadows.
- **Components** (all token-driven, so they flip with the theme): `hero`,
  `section-label`, `card` + `grid-2/3/4`, `stat-card`, `pill-*`, `tbl` table,
  `callout(.accent/.green/.amber)`, `flow` (numbered horizontal steps), `phases`
  (vertical timeline), `constell` (hub-and-spoke system map with orbiting `cchip`s),
  `code` (self-contained dark card — premium on a light page).
- **App replicas** (the magic):
  - **Desktop window** `.divo`: titlebar (traffic lights + breadcrumb), `.divo-side`
    sidebar, `.divo-thread`, `.divo-composer`. Scopes its own tokens so it can be a
    different theme than the chrome.
  - **Phone** `.lkm`: status bar, chat header, message feed, real bottom tab bar.
  - **Activity stream** (copy this exactly from the target app): `.tl-row` =
    `[18px icon box] verb arg duration`; running → spinner + **shimmer**; done →
    check + past-tense verb + duration. `.tl-head` shimmer header, `.tl-say` inline
    streamed text + cursor, `.tl-ribbon` "Synthesizing… Ns", fold to **"Worked for Ns"**.
  - **Data card** `.d-data`, **terminal** `.d-term` (stays dark — terminals are dark),
    **approval gate** `.d-approve` (pulsing, clickable), **RBAC badge** `.d-rbac`.
- **The shimmer** (signature live effect): a `linear-gradient(90deg, dim, fg, dim)`
  clipped to text (`background-clip:text; color:transparent`), `background-size:200%`,
  `animation: shimmer 2.2s linear infinite`. On **light** use a **dark** sweep; on
  **dark** a **light** sweep.

---

## Pitfalls — learned the hard way (read before building the engine)

1. **Item-type mismatch hangs the demo.** The `type` you PUSH onto the timeline must
   match the `type` your renderer checks. e.g. pushing `{t:'approval'}` but rendering
   `if(it.t==='approve')` → the card **silently never renders**, nothing to click, the
   run waits forever. Make them identical (or check both).
2. **Shimmer goes invisible** if a span has BOTH a color class (`.verb{color:..}`) and
   `.shimmer-text` — the element's `color` overrides `shimmer-text`'s `color:transparent`.
   Put the resting color behind `:not(.shimmer-text)` so the gradient wins when active.
3. **An approval that's below the fold looks "stuck."** When a gate becomes pending,
   `scrollIntoView({block:'center'})` it and make it **pulse** + say "click to continue".
4. **Inline hardcoded colors in JS strings don't theme-flip.** Use tokens, or fix them
   per-theme (a near-white bold goes invisible on a white card).
5. **Match the real app's tense + labels.** Tool rows flip present→past on completion
   ("Checking…" → "Checked"), show a summary/duration, and the whole work log folds
   into a single "Worked for Ns" line when the answer arrives.
6. **Render perf** if you stream real markdown: split into blocks + memoize, coalesce
   token updates with `requestAnimationFrame`, memoize message components.
7. **Less text.** Nobody reads a wall in a pitch. One line per idea; let the motion talk.

---

## Deploy
Pure static. From the deck folder: link to the target host project once, then
`vercel --prod --yes` (or any static host / `python3 -m http.server` for local). All
pages return 200; the title and a signature token confirm the right build is live.

## Files in this skill
- `assets/deck.css` — the full light-mode-first design system (tokens, components,
  faithful app replicas, the shimmer, light-device overrides). Copy it verbatim and
  retheme the `:root` accent/identity per product.
- `assets/deck.js` — the shared injected top-nav (edit the `LINKS` array).
- `assets/replay-engine.md` — the interactive replay engine: scene format, step types,
  the `proceed()` loop, render regions, approval click→proceed, fold-to-"Worked for Ns".
