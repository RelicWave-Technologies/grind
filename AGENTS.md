# AGENTS.md
> Shared context for all AI coding assistants — Claude Code, Codex, Cursor, Gemini CLI, etc.
> This file is symlinked as CLAUDE.md. One source of truth.

---

## MANDATORY: How Every AI Session Must Work

These rules exist so that switching between Claude, Codex, Cursor, or any other tool mid-feature
causes zero context loss. The **Lark Wiki** is the source of truth for all plans and progress.

### Lark Wiki — Source of Truth

All project documentation lives in the **Lark Wiki** under `Tech Hub > 02 — Internal Projects > Grind`.
Use the `lark-wiki` skill (via `lark-cli`) to read and write wiki pages. Do NOT maintain separate
local markdown files for plans or progress — the wiki is canonical.

**Wiki structure:**
```
Grind
├── Grind — Overview
├── Grind — References/
│    └── Time Tracker — Architecture & Tech Plan
└── Grind — Updates/
     └── Time Tracker MVP/
          ├── Plan
          ├── Updates
          ├── Meeting Updates
          └── Build Plan — Tracker + Dashboard
```

**Wiki page tokens (for lark-cli):**

| Page | obj_token | node_token |
|---|---|---|
| Grind (project root) | `QGnxd7gIRoxFArxDlMYlOVxHgLh` | `CNhTwn36iiIr8JkaFj2lOIHhgOg` |
| Grind — Overview | `AlKKdR05moG61mxkuGblExoDgFh` | `BGgvwBulGibkWAk2BRyl4hVDgWh` |
| Grind — References (parent) | `HuaXdvMxfo3LNJx4OgXlhG9Lg1d` | `MQb7w4C4AimvZekyPO0l8LRvg1g` |
| Grind — Updates (parent) | `F4WAdwmCWoz6EMxX4wKl8JGqgfg` | `RNW7w0sstixBrZkaVlXlOhF5gmc` |
| Ref: Time Tracker — Architecture & Tech Plan | `N2wtdf0yyoED7bxO3hzlMXhsgNh` | `LBOfwqmxoiM7Q5kUl1zlGVK3gLh` |
| Feature: Time Tracker MVP (folder) | `C1NPdC66lofn7cxfkqUljzoKgYb` | `HxJowzMc2iPScmkRU26lGn6Dgpg` |
| Time Tracker MVP — Plan | `GDWodW56fofwChxzlYvlZcRxgA3` | `WsSvwBc4aiYz1ykMX00lsno0gIc` |
| Time Tracker MVP — Updates | `N7vkdocUsoNgB7xmcIUlWCWigyh` | `J0HLw1Lrni5cyPkK58YlbIn1gth` |
| Time Tracker MVP — Meeting Updates | `ASuwdpd59obMm6xS1MOlet3eg4b` | `E36Fw9BkLiphzCkgvMtl0DX8gIg` |
| Time Tracker MVP — Build Plan (Tracker + Dashboard) | `EVded8JgToBkXVxLvOfle6BygUc` | `UicZwET2Oi9vKJkQR9tlMG0BgHf` |

**Wiki space ID:** `7635896570625396443` (Tech Hub)
**Project node token:** `CNhTwn36iiIr8JkaFj2lOIHhgOg`

### How to read/write wiki pages

```bash
# Read a page
lark-cli docs +fetch --api-version v2 --doc <obj_token> --doc-format markdown

# Overwrite a page (content must be a relative path with v2)
lark-cli docs +update --api-version v2 --doc <obj_token> --command overwrite --doc-format markdown --content @.context/file.md

# Append to a page
lark-cli docs +update --api-version v2 --doc <obj_token> --command append --doc-format markdown --content "content"

# Create a new sub-page
lark-cli wiki +node-create --space-id 7635896570625396443 --parent-node-token <PARENT_NODE> --title "Title"
```

### At the START of every session
1. Fetch the **Updates** page for the active feature from wiki (obj_token `N7vkdocUsoNgB7xmcIUlWCWigyh` for Time Tracker MVP)
2. Read its **Current State** — this is where the last session left off
3. If the request doesn't match any existing feature, ask before creating code

### During a session
- Architecture decisions go to the feature's **Plan** page (Key Decisions table)
- Blockers go to the feature's **Updates** page immediately

### At the END of every session (before stopping)
1. Overwrite the **Updates** page with a fresh snapshot:
   - What is working
   - What is in progress (file + function level)
   - What is not started
   - Exact next action
   - Append a progress log entry (date, tool, what you did)
2. Write snapshot to `.context/` first, then push via `lark-cli docs +update`

**This is not optional.** Treat updating the wiki as the last action in every session.

### When starting a brand-new feature
1. Create a folder under `Grind — Updates` with **Plan** and **Updates** sub-pages
2. Fill in the Plan before writing code
3. Add the new tokens to the table above

---

## Project quick facts

- **Stack:** Electron 31+ TS agent · Express + Prisma + Postgres + S3 backend · React + Vite dashboard · pnpm workspaces + Turborepo
- **Scope:** Internal-use Hubstaff-style tracker — screenshots + time tracking only. No payroll, no invoicing.
- **Privacy contract:** count keystrokes/mouse, never content. Window titles + URLs default OFF. 60-day screenshot retention.
- **Signing:** macOS signing via Apple Developer account. Windows ships unsigned for v1 (internal IT deployment).

## Local paths

- `tracker-plan/PLAN.md` — local copy of the architectural plan (also pushed to wiki under References)
- `.context/` — scratch dir for wiki-sync snapshots; do not commit large files here
