# Grind — Deployment Runbook

| Surface | Target | Config |
|---|---|---|
| `@grind/api` (Express + Prisma) | VPS, Docker container behind host Nginx | `infra/vps/Dockerfile.api` |
| `@grind/dashboard` (Vite SPA) | VPS, Nginx container | `infra/vps/Dockerfile.dashboard` |
| `@grind/agent` (Electron) | GitHub Releases (Mac universal DMG/ZIP + Windows x64 NSIS) | `apps/agent/electron-builder.yml` |

Both server surfaces are served from one domain, `https://timo.emiactech.com`.

---

## 1. API + dashboard (VPS)

Deploys run through `.github/workflows/deploy-vps.yml` (**Deploy VPS**). It
triggers on every push to `main` that touches `apps/api`, `apps/dashboard`,
`packages`, `infra/vps`, or the root workspace/lockfile config, and can also be
run manually (`workflow_dispatch`).

### Build job

Builds two images and pushes them to GHCR, tagged with the commit SHA and `main`:

- `ghcr.io/relicwave-technologies/grind-api` from `infra/vps/Dockerfile.api`
  (installs the api + db closure, `prisma generate`, tsup build, runs
  `pnpm --filter @grind/api start` on port 4000).
- `ghcr.io/relicwave-technologies/grind-dashboard` from
  `infra/vps/Dockerfile.dashboard` (Vite build with `VITE_API_BASE` empty, so
  the SPA calls the API on the same origin; served by Nginx using
  `infra/vps/dashboard-nginx.conf`).

### Deploy job (`production` environment)

Over SSH to the VPS:

1. Ensures `/opt/grind` is a git checkout of `main` and fast-forwards it.
2. Writes `infra/vps/.env.production` from the `PRODUCTION_ENV` secret (plus
   `TIMO_PRODUCTION_ENV` when set) and `infra/vps/.deploy.env` with the image
   names + tag.
3. Pulls the new images, stops `api` + `dashboard`, takes a `pg_dump` of
   `DATABASE_URL` into `/opt/grind/backups/` (verified with `pg_restore --list`),
   then runs `prisma migrate deploy` in a one-off `api` container and a few
   sanity SQL checks.
4. Starts the stack with `docker compose -f infra/vps/docker-compose.prod.yml up -d`.
   If anything fails, the previous containers are restarted.
5. Installs the host Nginx site (`infra/vps/nginx-timo.emiactech.com.conf`;
   the `.http.conf` variant is used once to obtain the Let's Encrypt cert via
   certbot). Nginx proxies `/v1/`, `/health`, `/healthz` to the API on
   `127.0.0.1:4100` and everything else to the dashboard on `127.0.0.1:4101`.
6. Verifies `https://timo.emiactech.com/healthz` and `/`.

Required GitHub secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY`,
`PRODUCTION_ENV` (the API env file: `DATABASE_URL`, `JWT_SECRET`,
`DASHBOARD_URL`, screenshot storage, Lark, … — see `.env.example` and
`apps/api/src/env.ts`), and optionally `TIMO_PRODUCTION_ENV`.

Non-secret API config (Lark approval codes etc.) lives in the `environment:`
block of `infra/vps/docker-compose.prod.yml`.

`TIMO_TIMER_LEASE_RECONCILER_ENABLED` (in `PRODUCTION_ENV`, default `false`)
turns on the job that closes protocol-v2 timers whose agent stopped
checkpointing (`LEASE_EXPIRED`). Check its value in the running container
(`docker exec vps-api-1 printenv TIMO_TIMER_LEASE_RECONCILER_ENABLED`) before
reasoning about closed timers. When on, it waits one lease length (3 min)
after the API starts, and again after any stretch of more than a lease in
which it could not reach the database, so agents can checkpoint first — a
deploy or a database outage never closes running timers by itself.

`infra/vps/docker-compose.yml` is the build-from-source variant of the same
stack, for running it on a box without the CI-built images.

### Remote resync (developer)

A developer can ask one person's Timo to re-send its local time entries,
activity and screenshots for a date range, without touching their laptop —
for when a day looks wrong or empty on the dashboard. The agent picks the
request up on its next heartbeat (≤ 60 s), runs it silently (no notification,
one line in the agent log) and reports counts back. It needs an agent build
that includes it (the next release after beta.38); older agents ignore the
request and it expires after 7 days.

1. **Allow yourself.** Set `DEVELOPER_EMAILS` (comma-separated,
   case-insensitive) for the API. `.env.production` on the VPS is rewritten
   from the secrets on every deploy, so put it in the `TIMO_PRODUCTION_ENV`
   (or `PRODUCTION_ENV`) GitHub secret, or uncomment the line in the
   `environment:` block of `infra/vps/docker-compose.prod.yml`. Then redeploy
   (or `docker compose -f infra/vps/docker-compose.prod.yml up -d api`).
   Unset or empty = feature off: `/v1/dev/*` answers 404 for everyone.
2. **Open `https://timo.emiactech.com/dev/resync`.** There is no nav link;
   anyone not on the list is sent to their home page.
3. Pick the person and the dates (workspace calendar, at most 31 days) and
   press **Re-send**. Status goes *Waiting for agent* → *Running* →
   *Done*/*Failed*; expand a row for what was re-sent, what is still queued,
   sync errors, and the agent's version/OS. *Still uploading* means the
   2-minute wait ended with data still queued — it keeps syncing in the
   background.

API: `POST/GET /v1/dev/agent-commands`, `GET /v1/dev/agent-commands/:id`,
`GET /v1/dev/people` (developer only); the agent reports to
`POST /v1/agent/commands/:id/result`.

## 2. Agent desktop releases

The build goes through a `pnpm deploy --prod` staging dir (see
`apps/agent/scripts/package-mac.sh`). This is **required**: in this pnpm
workspace (shamefully-hoist), the agent's transitive deps — e.g. `color-name`,
which `sharp` → `color` → `color-convert` needs — live at the hoisted root, not
beside the requiring package. A plain in-place `electron-builder` run dedupes
them out of the asar and the packaged app dies at launch with
`Cannot find module 'color-name'`. `pnpm deploy` materializes a correct flat
`node_modules` that electron-builder packs faithfully. The script also rebuilds
native modules (better-sqlite3, uiohook-napi, get-windows) for the Electron ABI.

The production update feed is GitHub Releases using `electron-updater`.
Release builds bake three desktop env values:

```bash
MAIN_VITE_API_URL=https://timo.emiactech.com
MAIN_VITE_UPDATE_CHANNEL=latest     # latest for stable, beta for beta
MAIN_VITE_AUTO_UPDATE_ENABLED=1     # release builds only
```

Local unsigned test builds should omit `MAIN_VITE_AUTO_UPDATE_ENABLED`; macOS
auto-update is enabled only for signed/notarized release builds. Windows v1 is
unsigned by choice for internal IT deployment, so SmartScreen warnings are
expected until a later code-signing phase.

### Manual release workflow

Use **Actions → Release Agent**. Inputs:

- `version`: must exactly match `apps/agent/package.json`.
- `channel`: `stable` requires `1.0.0`; `beta` requires `1.0.1-beta.1`.
- `api_url`: production API URL to bake into the app.
- `release_notes`: copied into the draft GitHub Release.

The workflow creates/uses tag `v<version>`, keeps the GitHub Release as a
draft, builds Windows x64 on `windows-latest`, builds a signed/notarized
universal macOS package on `macos-14`, and uploads:

- Windows: `.exe`, `.exe.blockmap`, `latest.yml` or `beta.yml`.
- macOS: `.dmg`, `.zip`, blockmaps, `latest-mac.yml` or `beta-mac.yml`.

Required GitHub secrets for the macOS job:

- `MAC_CERTIFICATE_BASE64` — base64-encoded Developer ID Application `.p12`.
- `MAC_CERTIFICATE_PASSWORD`.
- `APPLE_ID`.
- `APPLE_APP_SPECIFIC_PASSWORD`.
- `APPLE_TEAM_ID`.

For a one-off unsigned Windows installer without creating a release, use
**Actions → Package Windows Agent** (`.github/workflows/package-windows.yml`);
it uploads the installer as a workflow artifact. The installed app still
updates itself from **published** releases (input `auto_update`, default on),
on the channel its version implies (`-beta.N` → beta). Before this, one-off
builds shipped with updates off and channel `latest` — a machine set up from
one never updated.

### Release checklist

1. Bump `apps/agent/package.json` version.
2. Run the Release Agent workflow as `beta`.
3. Install beta on Windows x64, Apple Silicon Mac, and Intel Mac.
4. Verify update from the previous beta on all three targets.
5. While tracking, verify the update downloads but restart waits until Stop.
6. Publish the draft stable release only after beta QA passes.
7. Verify stable update from the previous stable build.

### Windows auto-update

**How it works.** `electron-updater` (GitHub provider) runs in the agent
(`apps/agent/src/main/services/updates/`). It checks 5 s after launch, every
6 h, and when Settings opens. A beta build asks GitHub's releases feed for the
newest *published* prerelease and reads its `beta.yml`; a stable build reads
`latest.yml` from GitHub's "latest" release (which never includes
prereleases, so a beta build must never run on `latest` — the packager refuses
that combination and the app corrects it at runtime). Draft releases are
invisible to every client. The installer downloads in the background and is
installed when the person clicks **Restart to update** (Settings, the banner,
or the tray), when they Quit Timo, or — Windows — at the next launch: an update
that is ready within 3 minutes of launch while no timer is running is
installed silently and Timo restarts (once per version, so a failing install
can never loop). It is never installed during a Windows shutdown/sign-off:
Electron does not emit `quit` then, and the agent also holds install-on-quit
on `session-end` so a half-run installer can't remove the old files without
writing the new ones.

**Per-user installs only.** The NSIS installer always installs to
`%LOCALAPPDATA%\Programs\Timo` (`nsis.allowElevation: false`,
`allowToChangeInstallationDirectory: false`, and `build/installer.nsh`
`customInstallMode` forcing "only for me", which also skips the "who is this
for" page). Reason: the update feed never sets `isAdminRightsRequired` (only
`perMachine` builds get it), so `electron-updater` runs the installer with
Timo's own unelevated token. An install under Program Files then needs a UAC
prompt on every update — a standard user cannot answer it, so the update never
lands — and earlier installers offered "Anyone who uses this computer" on first
install *and on every interactive update*, which is how machines ended up
there (`C:\Program Files\Grind\Timo` = a pre-rebrand all-users install).

**A Program Files install cannot update itself.** Beta.38+ detects this
(`process.execPath` under `%ProgramFiles%`/`%ProgramFiles(x86)%`), does not
start the updater, shows a one-time notice *"Timo can't update itself here —
download the new installer"*, keeps a **Download installer** button in
Settings → Updates, and reports it in the heartbeat. What to tell the person:

1. Download the current installer (dashboard sidebar → Windows, or
   `https://timo.emiactech.com/v1/downloads/agent/windows`) and run it. It
   installs Timo just for them in `%LOCALAPPDATA%\Programs\Timo` and Timo
   updates itself from then on. No admin rights needed.
2. Nothing is lost: sign-in, the local database (unsynced time, queued
   screenshots) and preferences live in `%APPDATA%\Timo` (Electron
   `userData`, named after the product), not in the install folder, and the
   new install reads the same folder. A pre-rebrand `%APPDATA%\Grind` is
   migrated on first launch (`legacyMigration.ts`).
3. Afterwards, someone with admin rights removes the old all-users copy from
   Settings → Apps → Installed apps ("Timo", or "Grind" for pre-rebrand
   installs). Until then there are two Timo shortcuts; the old one starts the
   old version.

Beta.37 and older agents on Program Files that click **Restart to update**
get the same per-user install through the new installer's forced "only for
me"; their silent install-on-quit still asks for UAC and usually goes nowhere.

**Finding stuck machines.** Heartbeat diagnostics (beta.38+) fill
`User.agentInstallScope` (`user` / `machine` / `unknown`) and
`User.agentUpdateError` (last updater failure as `CODE: message`, null once a
check succeeds). Older agents only report `agentVersion`:

```sql
SELECT email, "agentVersion", "agentInstallScope", "agentUpdateError", "agentLastSeenAt"
FROM "User"
WHERE "agentPlatform" = 'win32' AND "deactivatedAt" IS NULL
  AND ("agentInstallScope" = 'machine' OR "agentUpdateError" IS NOT NULL
       OR "agentVersion" <> '<newest published version>')
ORDER BY "agentLastSeenAt" DESC;
```

On the machine itself, `%APPDATA%\Timo\logs\main.log` has `updates enabled`
(channel, install scope), `update failed` (with the error `code`) and
`updates blocked: per-machine install cannot update itself`.

**Verifying a release's Windows feed** (after publishing the draft):

```bash
TAG=v0.0.2-beta.38
gh release view "$TAG" --json isDraft,isPrerelease --jq .   # isDraft must be false
gh release download "$TAG" -p beta.yml -O -                 # latest.yml for stable
```

The feed must name the release's version, a `path:` that is one of the
release's `Timo-<version>-x64-setup.exe` assets, and no
`isAdminRightsRequired: true`. The Release Agent workflow checks the same
before uploading. Then on a Windows machine running the previous version:
Settings → Updates → **Check for updates** downloads it, and the log shows
`update available` → `update downloaded`.

### Local macOS packaging

```bash
# 1. Bake the production API URL into the app:
echo 'MAIN_VITE_API_URL=https://timo.emiactech.com' > apps/agent/.env.production

# 2a. Unsigned (no Apple account) — verified working:
pnpm --filter @grind/agent package:unsigned        # -> apps/agent/release/Grind-0.0.1-arm64.dmg

# 2b. Signed + notarized — needs a Developer ID cert in the login keychain:
export APPLE_ID="you@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
pnpm --filter @grind/agent package                 # SIGN=1 under the hood

# 2c. Universal signed/notarized release artifacts:
PUBLISH=1 UPDATE_CHANNEL=latest pnpm --filter @grind/agent package:mac:universal
```

`package-mac.sh <arch>` takes `arm64` (default), `x64`, or `universal`. The
universal lane produces both DMG and ZIP; ZIP is required for macOS updater
metadata. Native optional dependencies for both Mac CPU families are retained
through `.npmrc` `supportedArchitectures` settings.

Explicit mac arch scripts are also available:

```bash
pnpm --filter @grind/agent package:mac:arm64
pnpm --filter @grind/agent package:mac:x64
pnpm --filter @grind/agent package:mac:universal
```

The icon is generated from source (`pnpm --filter @grind/agent icon`) and lives
at `apps/agent/build/icon.svg`, `apps/agent/build/icon.png`, and
`apps/agent/build/icon.icns`. Entitlements (hardened runtime, JIT, library
validation off for native modules) are in `apps/agent/build/entitlements.mac.plist`.
Unsigned apps: users right-click → Open once to bypass Gatekeeper.

### Local Windows packaging

Windows v1 is an unsigned internal IT installer. Build the x64 NSIS installer:

```bash
# Bake the production API URL into the app:
echo 'MAIN_VITE_API_URL=https://timo.emiactech.com' > apps/agent/.env.production

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

For release publishing, run through the Release Agent workflow. Local publishing
uses:

```bash
PUBLISH=1 UPDATE_CHANNEL=beta pnpm --filter @grind/agent package:win:x64
```
