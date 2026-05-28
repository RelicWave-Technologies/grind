# Grind

Internal time tracker + screenshot monitor. See [tracker-plan/PLAN.md](tracker-plan/PLAN.md) for the full architectural plan and [AGENTS.md](AGENTS.md) for the wiki-sync workflow.

## Week 1 quick start

```bash
# 1. Prereqs
nvm use                                # node 20.18
corepack enable

# 2. Configure
cp .env.example .env
# edit .env:
#   - paste your Neon DATABASE_URL (pooled) and DIRECT_URL
#   - set JWT_SECRET="$(openssl rand -base64 32)"

# 3. Install
pnpm install

# 4. DB
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 5. Run everything
pnpm dev
```

Then click the tray icon → log in with `abhishek@emiactech.com` / `grindgrind` → see 3 projects.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Run API + Electron agent in parallel (hot reload) |
| `pnpm typecheck` | TypeScript check across all packages |
| `pnpm lint` | ESLint across all packages |
| `pnpm db:generate` | Prisma client codegen |
| `pnpm db:migrate` | Apply Prisma migrations (Neon dev branch) |
| `pnpm db:seed` | Seed workspace + admin user + 3 projects |
| `pnpm db:studio` | Open Prisma Studio in browser |

## Layout

- `apps/api/` — Express + Prisma + auth
- `apps/agent/` — Electron tray app (login + project list + heartbeat)
- `packages/db/` — Prisma schema + client + seed
- `packages/types/` — shared zod schemas
- `packages/tsconfig/` — shared TS configs

## ngrok for cross-machine testing

```bash
ngrok http 4000
# → https://abc123.ngrok-free.app
```

Teammate sets `AGENT_API_URL=https://abc123.ngrok-free.app` in their `apps/agent/.env` and launches the agent.

## What works in Week 1

- Login (argon2 + JWT access + opaque refresh in DB)
- Token persistence via `safeStorage` (macOS Keychain / Windows DPAPI)
- Refresh-on-401 interceptor in the agent's API client
- 60-second heartbeat
- Project list

## What's deferred

Screenshots, permissions, idle detection, activity tracking, dashboard, signing, auto-update — see PLAN.md §13 of the Week 1 plan for the full deferral table.
