# Grind — Deployment Runbook

Three surfaces ship independently:

| Surface | Target | Config | Auth |
|---|---|---|---|
| `@grind/dashboard` (Vite SPA) | **Vercel** | `vercel.json` | Vercel CLI (`anish877`) |
| `@grind/api` (Express + Prisma) | **Render** | `render.yaml` | Render dashboard |
| `@grind/agent` (Electron) | **DMG** (signed + notarized) | `apps/agent/electron-builder.yml` | Apple Developer ID |
| Screenshots | **Cloudinary** | API `/v1/screenshots/sign` | Cloudinary account |

Database stays on **Neon** (existing).

There is a small cyclic dependency in the origins: the API needs the dashboard
URL (CORS + cross-site cookie), and the dashboard needs the API URL. Resolve it
by deploying the API first, then the dashboard, then setting `DASHBOARD_URL` on
the API and redeploying it.

---

## 0. Prerequisites (you provide)

- **Neon**: `DATABASE_URL` (pooled, `?pgbouncer=true`) + `DIRECT_URL` (direct).
- **Cloudinary**: Cloud name, API key, API secret (Dashboard → Account Details).
- **Apple Developer**: a *Developer ID Application* cert installed in the login
  keychain, plus `APPLE_ID`, an app-specific password, and `APPLE_TEAM_ID`.

---

## 1. Cloudinary

1. Create a free account at cloudinary.com.
2. Copy **Cloud name**, **API Key**, **API Secret** from the dashboard.
3. (Optional) Pre-create the folder `grind/screenshots` — Cloudinary also
   auto-creates it on first upload.

No code changes needed — the API signs uploads and the agent pushes bytes
directly. These values go into Render env (step 2).

## 2. Render (API)

The repo ships `render.yaml` as a Blueprint.

1. Push this branch to GitHub (Render builds from the repo).
2. Render Dashboard → **New → Blueprint** → pick the `grind` repo → it reads
   `render.yaml` and proposes the `grind-api` web service.
3. Fill the `sync: false` env vars when prompted:
   - `DATABASE_URL`, `DIRECT_URL` — from Neon
   - `DASHBOARD_URL` — leave blank for now; set after step 3
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
   - Lark vars — optional, leave blank to keep Lark disabled
   - `JWT_SECRET` is generated automatically.
4. Deploy. The build runs `prisma generate → tsup build → prisma migrate deploy`
   against Neon, then `node dist/index.cjs`. Health check: `GET /healthz`.
5. Note the service URL, e.g. `https://grind-api.onrender.com`.

## 3. Vercel (dashboard)

Done via the Vercel CLI (already logged in as `anish877`). From the repo root:

```bash
# Point the SPA at the Render API (build-time inlined by Vite):
vercel env add VITE_API_BASE production   # paste https://grind-api.onrender.com
vercel --prod                              # builds @grind/dashboard, deploys dist
```

`vercel.json` handles the monorepo build (`pnpm --filter @grind/dashboard build`,
output `apps/dashboard/dist`) and SPA rewrites. Note the deployed URL, e.g.
`https://grind-dashboard.vercel.app`.

## 4. Close the CORS/cookie loop

Set `DASHBOARD_URL` on Render to the Vercel URL (comma-separate to allow preview
URLs too) and redeploy the API. In production the auth cookie is
`SameSite=None; Secure`, so both must be HTTPS (they are).

## 5. Agent DMG (signed + notarized)

```bash
# 1. Bake the production API URL into the app:
cp apps/agent/.env.production.example apps/agent/.env.production
#    edit MAIN_VITE_API_URL=https://grind-api.onrender.com

# 2. Provide Apple notarization creds in the environment:
export APPLE_ID="you@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
#    (Developer ID Application cert must be in the login keychain)

# 3. Build, sign, notarize, staple — both arches:
pnpm --filter @grind/agent package
#    → apps/agent/release/Grind-0.0.1-arm64.dmg
#    → apps/agent/release/Grind-0.0.1-x64.dmg
```

The icon is generated from source (`pnpm --filter @grind/agent icon`) and lives
at `apps/agent/build/icon.icns`. Entitlements (hardened runtime, JIT, library
validation off for native modules) are in `apps/agent/build/entitlements.mac.plist`.

### Unsigned smoke build (no Apple account)

```bash
pnpm --filter @grind/agent package:unsigned   # arm64 dmg, no signing/notarization
```

Verified working — produces `apps/agent/release/Grind-0.0.1-arm64.dmg`. Users
right-click → Open to bypass Gatekeeper.
