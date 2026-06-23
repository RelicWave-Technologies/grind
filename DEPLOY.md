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

## 5. Agent DMG

The build goes through a `pnpm deploy --prod` staging dir (see
`apps/agent/scripts/package-mac.sh`). This is **required**: in this pnpm
workspace (shamefully-hoist), the agent's transitive deps — e.g. `color-name`,
which `sharp` → `color` → `color-convert` needs — live at the hoisted root, not
beside the requiring package. A plain in-place `electron-builder` run dedupes
them out of the asar and the packaged app dies at launch with
`Cannot find module 'color-name'`. `pnpm deploy` materializes a correct flat
`node_modules` that electron-builder packs faithfully. The script also rebuilds
native modules (better-sqlite3, uiohook-napi, get-windows) for the Electron ABI.

```bash
# 1. Bake the production API URL into the app:
echo 'MAIN_VITE_API_URL=https://grind-xcdr.onrender.com' > apps/agent/.env.production

# 2a. Unsigned (no Apple account) — verified working:
pnpm --filter @grind/agent package:unsigned        # -> apps/agent/release/Grind-0.0.1-arm64.dmg

# 2b. Signed + notarized — needs a Developer ID cert in the login keychain:
export APPLE_ID="you@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
pnpm --filter @grind/agent package                 # SIGN=1 under the hood
```

`package-mac.sh <arch>` takes `arm64` (default) or `x64`. Note: an `x64` build
on an Apple-Silicon machine needs the `@img/sharp-darwin-x64` prebuilt present;
arm64 covers all Apple-Silicon Macs (2020+).

Explicit mac arch scripts are also available:

```bash
pnpm --filter @grind/agent package:mac:arm64
pnpm --filter @grind/agent package:mac:x64
```

The icon is generated from source (`pnpm --filter @grind/agent icon`) and lives
at `apps/agent/build/icon.svg`, `apps/agent/build/icon.png`, and
`apps/agent/build/icon.icns`. Entitlements (hardened runtime, JIT, library
validation off for native modules) are in `apps/agent/build/entitlements.mac.plist`.
Unsigned apps: users right-click → Open once to bypass Gatekeeper.

### Windows packaging

Windows v1 is an unsigned internal IT installer. Build the x64 NSIS installer:

```bash
# Bake the production API URL into the app:
echo 'MAIN_VITE_API_URL=https://grind-xcdr.onrender.com' > apps/agent/.env.production

# Unsigned Windows x64 installer:
pnpm --filter @grind/agent package:win:x64
```

The Windows packager (`apps/agent/scripts/package-windows.mjs`) builds the app,
creates a clean runtime staging package, and runs `npm install --omit=dev` there
so Windows-native install scripts run on Windows. Prefer running this on a
Windows machine or Windows CI runner because the agent has native modules
(`better-sqlite3`, `sharp`, `uiohook-napi`, optional `get-windows`). Cross-builds
from macOS can fail if the target native binaries or Wine/NSIS toolchain are not
available.

If/when Windows signing is needed, provide `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`
or `CSC_LINK`/`CSC_KEY_PASSWORD` and run with `SIGN=1`. Without `SIGN=1`, the
script disables certificate auto-discovery so the v1 internal build remains
unsigned.
