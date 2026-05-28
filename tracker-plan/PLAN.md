I have sufficient research. Let me compile the comprehensive report now. (Acknowledged on the auto-mode and task reminders — proceeding straight to the deliverable.)

---

# Employee Time Tracker + Screenshot Monitor — Dev Plan (2025–2026)

**Scope:** Internal-use Hubstaff-style agent for ~50–200 employees (mostly Mac, some Windows). Screenshots + time tracking only. Stack: Electron + TypeScript agent; Express + Prisma + Postgres + S3 backend. Tauri vs Electron is decided — Electron.

---

## 1. Electron Agent Architecture

**Process model.** Two real processes do real work; everything else is supporting:

- **Main process** (Node + Electron): owns native APIs — screen capture, permission checks, idle detection, active-window polling, SQLite, file I/O, S3 uploads, auto-launch, auto-update, OS event listeners (power, lock-screen). All "agent logic" lives here.
- **Tray/Settings BrowserWindow** (renderer): minimal UI — login, project picker, timer start/stop, permission warnings, "open in dashboard" link. Hidden by default; shown from tray icon.
- **No hidden BrowserWindow needed for capture.** The recommended 2025 pattern is to do `desktopCapturer.getSources()` + `nativeImage` thumbnails directly in the main process. Older tutorials that spin up a hidden window to call `getUserMedia` are obsolete for our use case — we just need a JPEG/WebP, not a media stream.

**IPC pattern.** Use `ipcMain.handle` / `ipcRenderer.invoke` (request/response) for everything renderer → main. Never expose `ipcRenderer` directly via `contextBridge`; expose one named function per operation ([Electron Context Isolation docs](https://www.electronjs.org/docs/latest/tutorial/context-isolation), [Sentry Electron IPC](https://docs.sentry.io/platforms/javascript/guides/electron/features/inter-process-communication/)).

```ts
// preload.ts
contextBridge.exposeInMainWorld('agent', {
  startTimer: (projectId: string) => ipcRenderer.invoke('timer:start', projectId),
  stopTimer:  ()                  => ipcRenderer.invoke('timer:stop'),
  getStatus:  ()                  => ipcRenderer.invoke('agent:status'),
  onStatus:   (cb) => ipcRenderer.on('agent:status:push', (_, s) => cb(s)),
});
```

Push state changes (timer ticking, permission revoked, queue depth) from main → renderer via `webContents.send` on a single channel `agent:status:push`.

Settings: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for the tray window.

**State management.**
- **Main process** is the source of truth. Use a small in-memory state machine (TypeScript discriminated union: `IDLE | RUNNING | PAUSED_IDLE | UPLOADING | OFFLINE`) plus SQLite for durable state.
- **Renderer** uses a tiny store (Zustand or even React `useReducer`) that mirrors what main pushed. No business logic in renderer.
- For settings persistence, use **better-sqlite3** for the queue *and* a `kv` table for settings. Avoid `electron-store` for anything sensitive — its encryption is obscurity, not security ([Jesse Li breakdown](https://blog.jse.li/posts/electron-store-encryption/)). Auth tokens go in OS keychain via `keytar` or Electron 15+'s `safeStorage`.

**Recommended folder structure (the agent only):**

```
apps/agent/
├── src/
│   ├── main/
│   │   ├── index.ts                  # app.whenReady, single instance lock
│   │   ├── ipc/                      # one file per channel namespace
│   │   ├── services/
│   │   │   ├── capture/              # desktopCapturer + sharp
│   │   │   ├── activity/             # uiohook-napi listener, counters
│   │   │   ├── window/               # active-win polling
│   │   │   ├── idle/                 # powerMonitor wrapper
│   │   │   ├── permissions/          # node-mac-permissions wrapper
│   │   │   ├── queue/                # better-sqlite3 upload queue
│   │   │   ├── upload/               # S3 client, retry
│   │   │   ├── auth/                 # JWT, refresh, keytar
│   │   │   ├── updater/              # electron-updater
│   │   │   └── state/                # state machine
│   │   ├── tray.ts
│   │   └── windows/tray-window.ts
│   ├── preload/index.ts
│   └── renderer/                     # Vite + React
│       ├── App.tsx
│       └── screens/
├── build/
│   ├── entitlements.mac.plist
│   ├── entitlements.mac.inherit.plist
│   └── icons/
├── electron-builder.yml
└── package.json
```

**Tooling.** Use **electron-vite** (Vite-based, fast HMR for renderer + tsx for main). Bundler: **electron-builder** over Electron Forge — better support for S3/generic update providers, NSIS configuration, and multi-platform CI ([compare](https://www.electronforge.io/core-concepts/why-electron-forge)).

---

## 2. Screenshot Capture in 2025

**Use `desktopCapturer` from the main process.** `getDisplayMedia` is for screen-sharing UX (with a picker); for headless periodic capture, `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {...} })` is the right API ([docs](https://www.electronjs.org/docs/latest/api/desktop-capturer), [yal.cc Electron v35](https://yal.cc/electron-desktop-screenshots/)).

**Multi-monitor.**
- `getSources` returns one entry per display.
- Important perf caveat: it **always captures all displays** even if you only want one — slower with more monitors ([yal.cc](https://yal.cc/electron-desktop-screenshots/)). Live with it; for 1–3 monitors it's fine.
- Pair with `screen.getAllDisplays()` to correlate IDs and store per-display metadata (`display_id`, `bounds`, `scaleFactor`).
- Default: capture **all monitors**, store each as a separate screenshot row linked to the same `activity_sample`. Admin setting can switch to "primary only."

**Thumbnail size = capture size.** Set `thumbnailSize` to the actual display resolution (use `display.size.width * scaleFactor`). Setting it lower scales server-side rendering down (cheaper); setting to `0,0` skips capture entirely (useful when you just want source IDs).

**Format & compression.** Capture returns `NativeImage` → get a PNG/JPEG buffer → re-encode with **sharp** ([sharp](https://sharp.pixelplumbing.com/)).

- **Pick WebP at quality 60–70 lossy.** Sharp's WebP encoder is excellent; WebP is ~25–35% smaller than equivalent JPEG ([WebP docs](https://developers.google.com/speed/webp/docs/cwebp)).
- JPEG q=70 is a fallback if any downstream tool can't handle WebP (none of ours can't).
- **Resize to max 1920px on the long edge** before encoding. Screenshots at native 4K/5K are wasteful for review UX.
- **Typical file sizes:** 1920×1080 desktop content → ~80–200 KB WebP q70, ~150–400 KB JPEG q75. At 3 screenshots/10min × 8h × 200 users ≈ 28,800 screenshots/day ≈ 3–6 GB/day of S3 ingress. Plan retention accordingly.

**Pseudocode:**
```ts
const sources = await desktopCapturer.getSources({
  types: ['screen'],
  thumbnailSize: { width: 1920, height: 1080 }, // cap; sharp resizes precisely
});
for (const s of sources) {
  const webp = await sharp(s.thumbnail.toPNG())
    .resize({ width: 1920, withoutEnlargement: true })
    .webp({ quality: 65, effort: 4 })
    .toBuffer();
  await queue.enqueueScreenshot({ displayId: s.display_id, buffer: webp });
}
```

**Randomized scheduling.** Hubstaff and Time Doctor both randomize within a window — e.g. "3 per 10 min, jittered" — so users can't predict the shot ([Hubstaff docs](https://support.hubstaff.com/change-screenshot-frequency/), [Time Doctor docs](https://support.timedoctor.com/knowledge/the-screencasts-screenshots-feature)). Implement as: divide the interval into N sub-buckets, take one shot per bucket at `start + random(0, bucketLen)`.

**Blur / redaction.**
- Server-side is easier; client-side is more private. For internal use, server-side is fine.
- On-device option: detect "looks like a password field" / "looks like banking" is **hard and unreliable**. Don't ship this in v1.
- Ship instead: (a) per-user "blur all screenshots" toggle (admin or self-serve depending on policy), (b) a redact UX on the dashboard where the employee can request blurring of a specific screenshot, (c) a global "blur faint" mode that applies a 8–12px Gaussian using sharp before upload, leaving structure visible but text unreadable ([Hubstaff blur](https://hubstaff.com/productivity-monitoring/privacy-first-employee-monitoring)).

---

## 3. macOS Screen Recording Permission (TCC)

**TCC = Transparency, Consent, Control.** It's the system that gates Screen Recording, Accessibility, Input Monitoring, Camera, Mic, etc. Per-app, persisted in `~/Library/Application Support/com.apple.TCC/TCC.db`; only `tccutil` and System Settings can mutate it ([screenify guide](https://www.screenify.studio/blog/2026-04-23-macos-screen-recording-permissions)).

**Two libraries to know:**

| | `systemPreferences.getMediaAccessStatus('screen')` (built-in) | `node-mac-permissions` ([repo](https://github.com/codebytere/node-mac-permissions)) |
|---|---|---|
| Built-in to Electron | Yes | No (native module, rebuild needed) |
| Covers screen recording | Yes | Yes (`getAuthStatus('screen')`) |
| Covers accessibility, input-monitoring | **No** | **Yes** |
| Can trigger prompt | No (you must actually call `desktopCapturer`) | `askForScreenCaptureAccess()`, `askForAccessibilityAccess()` |
| Known bugs | **Stale status after user grants/revokes in Settings** ([electron/electron#36722](https://github.com/electron/electron/issues/36722)) | Active maintenance, v2.5.0 (Mar 2025) |

**Recommendation:** Use **`node-mac-permissions`** for everything (screen, accessibility, input-monitoring). It's a single dependency, status is reliable, and the same package handles the other two permissions we need.

**Status values:** `'not determined' | 'denied' | 'authorized' | 'restricted'`.

**Request flow (first launch):**

1. On app start, call `getAuthStatus('screen')`, `getAuthStatus('accessibility')`, `getAuthStatus('input-monitoring')`.
2. If any is `not determined`: show an onboarding screen explaining *why* each permission is needed in plain language (compliance + privacy upside). Then call `askForScreenCaptureAccess()` etc. to fire the system prompt.
3. If `denied`: deep-link to System Settings:
   - `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
   - `...?Privacy_Accessibility`
   - `...?Privacy_ListenEvent` (Input Monitoring)
4. After granting Screen Recording, **macOS requires the app to be restarted** to take effect for `desktopCapturer`. Detect this: after `askForScreenCaptureAccess`, prompt "Restart Tracker" → `app.relaunch(); app.exit()`.

**Detecting mid-session revocation.** The user can revoke from System Settings at any time. Don't trust cached status — re-check `getAuthStatus('screen')` immediately before every capture attempt. If `desktopCapturer.getSources` returns sources but the thumbnails are all black/empty (1×1 transparent), treat that as a revocation signal too — known macOS behavior. When detected: pause tracking, push a "permission lost" event to the renderer + log to Sentry + show a tray badge.

**What breaks if revoked mid-session:**
- `desktopCapturer` still returns sources but thumbnails are blank.
- `active-win` returns the window owner but title becomes empty (without Screen Recording perm, macOS hides titles since Sequoia) — see §6.

---

## 4. Idle Detection

**Use `powerMonitor.getSystemIdleTime()`** ([Electron docs](https://www.electronjs.org/docs/latest/api/power-monitor)) — returns seconds since last input. Cross-platform (macOS, Windows, Linux).

**Edge cases:**

- **Lock screen.** `powerMonitor.getSystemIdleState(threshold)` returns `'locked'` on macOS and Windows. Subscribe to `lock-screen` / `unlock-screen` events — fired on both platforms. On lock: pause timer immediately, take no screenshot. On unlock: resume only if user confirms (a "you locked at 3:04, resume timer?" prompt).
- **Sleep / suspend.** Subscribe to `suspend` and `resume`. Pause on suspend, prompt on resume. **macOS hot corner gotcha:** display sleep via hot corner doesn't fire `suspend` ([electron/electron#12706](https://github.com/electron/electron/issues/12706)). Fall back to idle-time threshold (>5 min → treat as away regardless).
- **Fullscreen video.** This is the classic false-positive: user is watching a long Zoom presentation, no keyboard/mouse, registered as idle. Mitigations:
  - Detect active app via `active-win`; whitelist `zoom.us`, `Teams`, `Meet` (browser tab), Google Meet PWA, Webex, Slack huddles. While these are foreground, raise idle threshold from 5 min to 30 min.
  - Don't auto-stop the timer on idle; only **pause time accrual and skip screenshots**. Resume the moment input returns. This is how Hubstaff handles it ([activity tracking](https://support.hubstaff.com/activity-tracking-overview/)).
- **Multiple monitors / external keyboard.** `getSystemIdleTime` aggregates across all input devices on both OSes — no special handling needed.

**Recommended config:** Idle threshold 5 minutes (configurable per workspace). On idle entry: stop counting time, suspend screenshots, set state to `PAUSED_IDLE`. On any input: resume immediately.

---

## 5. Activity Tracking Without Keylogging

**Goal:** count keystrokes and mouse events per minute *without recording content*. Privacy contract: we never see what was typed, just that *something* was typed.

**Library matrix (2025):**

| Library | Status | Pros | Cons |
|---|---|---|---|
| **uiohook-napi** ([SnosMe](https://github.com/SnosMe/uiohook-napi)) | **Active, recommended.** N-API native module, libuiohook-based. | Modern N-API (works across Electron versions w/o rebuilds for each), captures keyboard + mouse globally. | Will crash if macOS Accessibility permission not granted *before* `uIOhook.start()` ([issue #24](https://github.com/SnosMe/uiohook-napi/issues/24)). Must guard. |
| **node-global-key-listener** | Active. | Pre-compiled binaries, no node-gyp. | Less granular for mouse, geared toward shortcut listening. |
| **iohook** (wilix-team) | **Effectively dead** — no recent releases, doesn't work with modern Electron/Node. | — | Avoid. |

**Pick `uiohook-napi`.** Listen for `keydown`, `mousedown`, `mousemove` (throttled), `wheel`.

**Privacy-safe counters.** Only increment counters; never store the key code, modifier, or position content beyond what's needed to debounce.

```ts
import { uIOhook, UiohookKey } from 'uiohook-napi';

const sample = { keystrokes: 0, mouseClicks: 0, mouseDistance: 0, scrollEvents: 0 };
let lastMove: {x: number, y: number} | null = null;

uIOhook.on('keydown',   () => sample.keystrokes++);
uIOhook.on('mousedown', () => sample.mouseClicks++);
uIOhook.on('mousemove', (e) => {
  if (lastMove) sample.mouseDistance += Math.hypot(e.x - lastMove.x, e.y - lastMove.y);
  lastMove = { x: e.x, y: e.y };
});
uIOhook.on('wheel', () => sample.scrollEvents++);

// Flush to SQLite every 60s; reset counters.
```

**Activity-level score.** Industry standard is a 0–100 score per minute based on whether keystrokes + mouse > threshold. Hubstaff uses a "minute-with-activity" ratio over 10 min ([Hubstaff activity calc](https://support.hubstaff.com/how-are-activity-levels-calculated/)). Replicate:
- A minute counts as "active" if `keystrokes ≥ 1 OR mouseClicks ≥ 1 OR (mouseDistance ≥ 50px AND moveEvents ≥ 5)`.
- 10-minute block score = `(activeMinutes / 10) × 100`.

**Anti-keylog guarantees to document and ship:**
- No key codes leave the process.
- No clipboard reading.
- Counters reset every flush.
- Source code reviewable (internal repo).

**macOS gotcha:** `uiohook-napi` needs **Input Monitoring** permission *and* in some flows Accessibility. Check both before starting; if either is missing, don't call `uIOhook.start()` (it'll crash). Show the permission screen first.

---

## 6. Active Window / App Tracking

**Use `get-windows`** (`sindresorhus/get-windows` — the new name for `active-win`, [npm](https://www.npmjs.com/package/active-win), [repo](https://github.com/sindresorhus/get-windows)). Returns `{ title, id, bounds, owner: { name, processId, bundleId, path } }`.

**Permission requirements:**
- **macOS:** needs **Screen Recording** for `title`, and **Accessibility** for `url` (browser tab URL). Without Screen Recording on Sequoia+, `title` will be empty. Without Accessibility, `url` is missing.
- **Windows:** no special permission; works out of the box.
- **Linux:** needs `xprop` (X11) or specific environments.

**Anti-prompt-spam.** The library can spam the Accessibility prompt if called in a tight loop ([issue #135](https://github.com/sindresorhus/get-windows/issues/135)). Mitigations:
- Pass `{ accessibilityPermission: false, screenRecordingPermission: false }` if those permissions aren't yet granted — disables features but stops the prompt.
- Poll at most every 5 seconds, not every second.
- After permission is granted, restart the process or recreate the underlying handle to pick up new permission state.

**What to log:** `bundleId` (macOS) / `path` (Windows), `processName`, and **title only if user opted in to title capture**. Many privacy-conscious deployments capture only app name, not window title. Make this an admin-level toggle (`workspace.captureTitles = true|false`). URL: opt-in separately.

**Sampling cadence:** every 10 seconds is plenty. Aggregate to "minutes-per-app" per 10-minute block on the server.

---

## 7. Offline Queue / Local Storage

**Library: `better-sqlite3`** ([npm](https://www.npmjs.com/package/better-sqlite3)) — synchronous, fast, the default for Electron in 2025. Lives in main process only ([Electron + better-sqlite3 guide](https://dev.to/arindam1997007/a-step-by-step-guide-to-integrating-better-sqlite3-with-electron-js-app-using-create-react-app-3k16)).

**SQLite settings:**
- `PRAGMA journal_mode = WAL;` — readers don't block writers; durable on crash ([SQLite WAL recovery](https://runebook.dev/en/docs/sqlite/walformat/recovery)).
- `PRAGMA synchronous = NORMAL;` — fast enough, safe in WAL.
- `PRAGMA busy_timeout = 5000;`
- `PRAGMA foreign_keys = ON;`

**Schema (local agent DB at `userData/agent.db`):**

```sql
CREATE TABLE kv ( key TEXT PRIMARY KEY, value TEXT NOT NULL );

CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,                 -- ULID
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT,
  started_at INTEGER NOT NULL,         -- epoch ms
  ended_at   INTEGER,
  client_uuid TEXT NOT NULL,           -- idempotency
  status TEXT NOT NULL,                -- 'open' | 'closed' | 'synced'
  synced_at INTEGER
);
CREATE INDEX idx_time_entries_status ON time_entries(status);

CREATE TABLE activity_samples (
  id TEXT PRIMARY KEY,
  time_entry_id TEXT NOT NULL REFERENCES time_entries(id),
  bucket_start INTEGER NOT NULL,       -- 1-minute bucket
  keystrokes INTEGER NOT NULL,
  mouse_clicks INTEGER NOT NULL,
  mouse_distance INTEGER NOT NULL,
  scroll_events INTEGER NOT NULL,
  active_app TEXT,
  active_app_bundle TEXT,
  active_window_title TEXT,            -- nullable per policy
  is_idle INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER
);
CREATE INDEX idx_activity_pending ON activity_samples(synced_at) WHERE synced_at IS NULL;

CREATE TABLE screenshots (
  id TEXT PRIMARY KEY,
  time_entry_id TEXT NOT NULL,
  display_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  file_path TEXT NOT NULL,             -- on-disk webp
  bytes INTEGER NOT NULL,
  upload_state TEXT NOT NULL,          -- 'pending' | 'uploading' | 'uploaded' | 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  s3_key TEXT
);
CREATE INDEX idx_screenshots_upload ON screenshots(upload_state, next_attempt_at);
```

**Why files on disk + DB pointers** (not BLOBs): keeps DB small, lets uploader stream files. Files live in `userData/screenshots/YYYY-MM-DD/<id>.webp`.

**Queue worker.**
- Single async worker loop in main process: `pick → upload → mark`. Sequential by default; max 2 concurrent.
- Mark `upload_state = 'uploading'` before starting (durability across restarts: on boot, reset any stale `'uploading'` rows back to `'pending'`).
- **Retry/backoff:** exponential with jitter — `delay = min(60s × 2^attempts, 1h) ± 30%`. Cap at 12 attempts before flagging `'failed'` and surfacing to user.
- **Crash mid-upload:** because state transitions are SQLite transactions in WAL mode, a crash leaves the row in `'uploading'` — the boot recovery query (`UPDATE screenshots SET upload_state='pending' WHERE upload_state='uploading'`) handles it cleanly.
- **Ordering:** screenshots and activity samples are eventually-consistent; we don't need strict order. Time entries should be uploaded *before* their associated screenshots/samples (FK on server). Enforce in worker: drain time_entries queue first.

**Disk pressure.** Cap local screenshot dir at 2 GB; if exceeded, oldest already-uploaded files are deleted. Never delete pending files.

---

## 8. S3 Upload Pattern

**Use presigned PUT URLs, not multipart for screenshots.** Screenshots are 80–400 KB — multipart's break-even is >5 MB. Multipart adds complexity (initiate/upload-parts/complete) with no win here ([AWS multipart](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-design-patterns.html)).

**Flow:**

1. Agent → API: `POST /uploads/screenshot` with `{ screenshotId, contentType: 'image/webp', bytes, capturedAt }`.
2. API validates, generates a presigned PUT URL (`expiresIn: 300s`), returns `{ url, key, headers }`.
3. Agent PUTs the WebP directly to S3 with those headers.
4. Agent → API: `POST /uploads/screenshot/:id/complete` to confirm.
5. API marks `screenshots.uploaded = true` and writes the row from queued metadata.

**Why a "complete" call:** S3 doesn't push events without S3 → Lambda → API plumbing. The complete call is simpler and lets us validate `bytes` matches.

**Retry strategy.**
- AWS SDK v3 already does exponential backoff on 5xx and throttling ([AWS retry](https://docs.aws.amazon.com/emr/latest/ReleaseGuide/emr-spark-emrfs-retry.html)). Trust it for the actual S3 PUT.
- Wrap the whole 3-step flow in *our* retry: on any failure, mark `pending`, schedule with the queue's backoff (see §7).
- Treat presigned-URL expiry (403 after 5 min) as a normal retry; we'll get a fresh URL next attempt.

**Bandwidth throttling on poor wifi.**
- Detect via `navigator.connection.effectiveType` in renderer? **Don't** — unreliable on Electron / Linux. Instead, measure observed throughput in the uploader: track bytes/sec over a rolling 30s window.
- If throughput < 50 KB/s sustained: drop concurrent uploads to 1 and pause non-essential ones (e.g. defer screenshot uploads until idle bandwidth recovers — but keep time-entry uploads going since they're tiny).
- Optional: ship a "Pause uploads on metered connections" setting (Windows exposes metered-connection state via `electron`'s `app.getPath` / WinAPI; macOS doesn't expose it cleanly — punt).

**Ordering guarantees.** As stated in §7: time_entries before screenshots/samples that reference them. Within a category, FIFO by `captured_at`. No global total order required.

**S3 key layout.** `s3://bucket/screenshots/{workspace}/{user_id}/{YYYY}/{MM}/{DD}/{screenshot_id}.webp`. The date partition keeps lifecycle rules simple (see §16).

---

## 9. Auto-Update

**`electron-updater`** is the right tool ([electron-builder auto-update](https://www.electron.build/auto-update), [release channels](https://www.electron.build/tutorials/release-using-channels.html)).

**Provider choice: Generic (S3 + CloudFront).**
- GitHub Releases: public-only (private repos require tokens shipped in the app — leaky), and your team probably doesn't want internal-build binaries on GitHub.
- S3 provider: works but historically buggy ([electron-builder#3498](https://github.com/electron-userland/electron-builder/issues/3498)) and requires SDK creds on client.
- **Generic provider over CloudFront** with a CDN URL like `https://updates.yourco.internal/agent/{channel}/` — simplest, no auth needed on client (or use a signed cookie if you must restrict).

**`electron-builder.yml` (excerpt):**
```yaml
publish:
  provider: generic
  url: https://updates.yourco.internal/agent/${channel}
  channel: stable
mac:
  target: dmg
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.inherit.plist
  notarize: true
win:
  target: nsis
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
```

**Differential updates.** electron-updater emits a `.blockmap` file next to each build; on update, only changed blocks are downloaded ([electron-updater channels](https://www.electron.build/tutorials/release-using-channels.html)). Big win — typical agent update is ~5–10 MB rather than 80–120 MB. **NSIS only does differential for app code, not the installer itself**; that's fine.

**Channels.** `stable` (default) and `beta`. Set `autoUpdater.channel = 'beta'` for opt-in users (admin toggle in dashboard or env var). Beta versions are published as `1.4.0-beta.1`, stable as `1.4.0`.

**Update cadence in code:**
```ts
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.checkForUpdatesAndNotify();
// re-check every 4 hours while running
setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
```

Force-update path: backend pings agent with min-supported-version; if agent version below it, refuse to track and prompt the user to update. Prevents stale agents lingering forever.

---

## 10. Code Signing & Notarization (macOS)

**Required for distribution outside MAS** since 10.15 Catalina ([Apple notarization docs](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)).

**Toolchain:**
- `notarytool` (not the deprecated `altool`).
- `electron-notarize` (now `@electron/notarize`, [repo](https://github.com/electron/notarize)) — integrated into `electron-builder`'s afterSign hook.

**Setup steps:**
1. Apple Developer account ($99/yr) → create **Developer ID Application** certificate.
2. Create an App-Specific Password or, better, an App Store Connect API key (avoid TFA pain in CI).
3. `electron-builder` config:

```yaml
mac:
  identity: "Developer ID Application: Your Company (TEAMID)"
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.inherit.plist
  notarize:
    teamId: TEAMID
```

Set creds via env: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

**Entitlements (`build/entitlements.mac.plist`):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <!-- Required for Electron + native modules -->
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>

  <!-- Network for uploads -->
  <key>com.apple.security.network.client</key><true/>

  <!-- We are NOT sandboxed; do not enable app-sandbox -->
</dict></plist>
```

**There is no `com.apple.security.device.screen-capture` entitlement.** Screen recording is gated **purely by TCC / user consent**, not entitlements ([Apple Developer Forum thread](https://developer.apple.com/forums/topics/code-signing-topic/code-signing-topic-notarization?page=2&sortBy=oldest)). What you *do* need is Info.plist usage descriptions:

```xml
<key>NSScreenCaptureUsageDescription</key>
<string>YourCo Tracker captures periodic screenshots during work sessions for productivity tracking.</string>
<key>NSAppleEventsUsageDescription</key>
<string>YourCo Tracker reads the active window title to log app usage.</string>
```

Same for **Accessibility** (no entitlement; just TCC consent + the system prompt fires automatically when you call `AXIsProcessTrusted`-equivalent APIs).

**Common notarization gotchas:**
- All bundled binaries must be signed (electron-builder handles this).
- `chmod +x` helper scripts inside the app bundle will fail notarization unless signed.
- If a native module ships with `.node` binaries built unsigned, they get auto-signed by electron-builder, but only if `gatekeeperAssess` flow detects them.

---

## 11. Windows Distribution Unsigned

**SmartScreen 2025 reality:**
- EV certificates **no longer bypass SmartScreen instantly** as of 2024 — they go through the same reputation build-up as OV ([devclass](https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554)).
- Unsigned Electron app → "Windows protected your PC, unknown publisher" full-screen prompt; user must click "More info" → "Run anyway."
- An OV cert reduces but doesn't eliminate the warning until enough installs accumulate.

**Options for an internal app:**

1. **Azure Trusted Signing / Azure Artifact Signing** ($9.99/mo, cloud-based, no hardware token) — best modern option if you qualify. **US/Canada/EU/UK orgs only with 3+ years history**, individual devs US/Canada only ([Microsoft docs](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)). India-based orgs currently can't get it directly; check via a US/EU subsidiary if you have one.
2. **OV cert from a CA** (~$200–400/yr from SSL.com, Sectigo, etc.) — works, but reputation must build up.
3. **Self-signed + GPO trust** — for fully internal deployment where IT controls all endpoints. Push your cert into the Trusted Publishers store via Group Policy or Intune/MDM, then signed builds skip SmartScreen entirely on managed machines. Common pattern for internal LOB apps.
4. **Stay unsigned** — viable for internal IT-deployed apps where IT does the install manually or via MDM, and end users never see the SmartScreen prompt. Document the bypass for IT staff.

**Installer choice for an internal Electron app:**

| | NSIS | MSIX | Squirrel.Windows |
|---|---|---|---|
| Recommended | **Yes** | For Win10+/Store-style only | **Avoid** — deprecated |
| electron-builder support | First-class | Yes | Yes but discouraged |
| Auto-update integration | electron-updater works | App Installer handles updates, separate flow | Built-in but worse |
| Per-user vs per-machine | Configurable | Per-user by default | Per-user |
| IT-friendly silent install | `/S` flag | `Add-AppxPackage` PS cmdlet | Awkward |

**Pick NSIS.** Set `oneClick: false` so IT can do silent installs and choose location. For MDM push, NSIS supports `/S /D=C:\Apps\YourCoTracker`.

**Practical recommendation for India-HQ scenario:** start with **OV cert via Sectigo** (~$200/yr; available globally) OR if you have GPO/Intune coverage, ship unsigned and push trust via policy. Don't block MVP on this — most users will install via IT.

---

## 12. Auto-Launch on Boot

**Electron API:** `app.setLoginItemSettings()` ([docs](https://www.electronjs.org/docs/latest/api/app)).

**macOS 13+ (Ventura and later).** Apple replaced the legacy Login Items API with `SMAppService`. Electron's `setLoginItemSettings` uses `SMAppService` under the hood on macOS 13+ ([Electron app docs](https://www.electronjs.org/docs/latest/api/app)). Caveats:
- `openAsHidden` is **deprecated and ignored** on macOS 13+. To start hidden, the app itself must hide its dock icon (via `app.dock.hide()` after `app.whenReady()`).
- For ventura+, you can specify the `type`:
  ```ts
  app.setLoginItemSettings({ openAtLogin: true });
  ```
  The default `'mainAppService'` is correct for a tracker that runs as the main app. Alternatives (`agentService`, `daemonService`, `loginItemService`) require `Contents/Library/LoginItems/` sub-bundles — overkill here.
- The user will see "YourCoTracker was added to login items" notification first launch. Normal.

**Windows.**
- `app.setLoginItemSettings({ openAtLogin: true })` writes `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` ([Electron API ref](https://www.electronjs.org/docs/latest/api/app)).
- Per-machine alternative for IT-deployed apps: write `HKLM\...\Run` via NSIS installer (use `extraInstallArgs`).
- Pass `args: ['--hidden']` so the app starts to tray, not visible window.

**Edge cases:**
- After uninstall, the registry entry / login item may linger ([electron-builder#2237](https://github.com/electron-userland/electron-builder/issues/2237)). NSIS uninstaller should explicitly `DeleteRegValue HKCU 'Software\Microsoft\Windows\CurrentVersion\Run' YourCoTracker`.
- Multi-user Windows machines: HKCU per user means each must enable separately. For shared/corporate machines, use HKLM via installer.
- Use `app.requestSingleInstanceLock()` so login-time autorun doesn't spawn duplicate instances if user manually launches.

**Avoid the `auto-launch` npm package** — last published 3 years ago, predates macOS 13 SMAppService changes ([npm](https://www.npmjs.com/package/auto-launch)). Stick with Electron's built-in.

---

## 13. Backend Schema (Prisma)

Postgres + Prisma + an extension you'll want: nothing required, but consider `pg_trgm` for fuzzy search on app titles later.

```prisma
// schema.prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

model Workspace {
  id        String   @id @default(cuid())
  name      String
  createdAt DateTime @default(now())
  // policy
  screenshotsPerHour       Int     @default(3)
  captureWindowTitles      Boolean @default(false)
  captureBrowserUrls       Boolean @default(false)
  blurScreenshotsByDefault Boolean @default(false)
  retentionDays            Int     @default(60)

  users    User[]
  projects Project[]
}

model User {
  id          String   @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  email       String   @unique
  name        String
  role        Role     @default(MEMBER)
  passwordHash String?
  invitedAt   DateTime?
  activatedAt DateTime?
  createdAt   DateTime @default(now())

  timeEntries      TimeEntry[]
  screenshots      Screenshot[]
  activitySamples  ActivitySample[]
  auditLogs        AuditLog[]
  refreshTokens    RefreshToken[]

  @@index([workspaceId])
}

enum Role { OWNER ADMIN MEMBER }

model Project {
  id          String   @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  name        String
  archived    Boolean  @default(false)
  createdAt   DateTime @default(now())

  tasks       Task[]
  timeEntries TimeEntry[]

  @@index([workspaceId, archived])
}

model Task {
  id        String   @id @default(cuid())
  projectId String
  project   Project  @relation(fields: [projectId], references: [id])
  name      String
  done      Boolean  @default(false)
  createdAt DateTime @default(now())

  timeEntries TimeEntry[]
  @@index([projectId])
}

model TimeEntry {
  id          String   @id          // ULID from agent
  clientUuid  String   @unique      // idempotency
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id])
  taskId      String?
  task        Task?    @relation(fields: [taskId], references: [id])
  startedAt   DateTime
  endedAt     DateTime?
  durationSec Int?                  // denormalized after close
  agentVersion String
  platform    String                // 'darwin' | 'win32'
  createdAt   DateTime @default(now())

  screenshots     Screenshot[]
  activitySamples ActivitySample[]

  @@index([userId, startedAt])
  @@index([projectId, startedAt])
  @@index([startedAt])              // BRIN candidate
}

model ActivitySample {
  id              String   @id      // ULID
  userId          String
  user            User     @relation(fields: [userId], references: [id])
  timeEntryId     String
  timeEntry       TimeEntry @relation(fields: [timeEntryId], references: [id], onDelete: Cascade)
  bucketStart     DateTime           // 1-min bucket
  keystrokes      Int
  mouseClicks     Int
  mouseDistance   Int
  scrollEvents    Int
  isIdle          Boolean
  activeApp       String?
  activeAppBundle String?
  activeTitle     String?            // null if policy disallows
  activeUrl       String?

  @@index([userId, bucketStart])
  @@index([timeEntryId])
}

model Screenshot {
  id           String   @id          // ULID
  userId       String
  user         User     @relation(fields: [userId], references: [id])
  timeEntryId  String
  timeEntry    TimeEntry @relation(fields: [timeEntryId], references: [id], onDelete: Cascade)
  capturedAt   DateTime
  displayId    String
  s3Key        String
  bytes        Int
  width        Int
  height       Int
  blurred      Boolean  @default(false)
  deletedAt    DateTime?
  deletedBy    String?
  deletedReason String?

  @@index([userId, capturedAt])
  @@index([timeEntryId])
  @@index([capturedAt])             // BRIN for retention sweep
}

model AuditLog {
  id          String   @id @default(cuid())
  workspaceId String
  actorId     String?
  actor       User?    @relation(fields: [actorId], references: [id])
  action      String   // 'screenshot.delete', 'user.role.change', etc.
  targetType  String
  targetId    String
  metadata    Json
  ip          String?
  userAgent   String?
  createdAt   DateTime @default(now())

  @@index([workspaceId, createdAt])
  @@index([targetType, targetId])
}

model RefreshToken {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id])
  tokenHash  String   @unique
  deviceName String?
  ip         String?
  expiresAt  DateTime
  revokedAt  DateTime?
  createdAt  DateTime @default(now())

  @@index([userId])
}
```

**Index notes:**
- The compound `(userId, startedAt)` / `(userId, capturedAt)` are the bread-and-butter dashboard query indexes.
- For `screenshots.capturedAt` and `time_entries.startedAt` consider **BRIN** indexes once tables exceed ~10M rows — much cheaper than btree on time-ordered append-only data ([Prisma indexes](https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes)). BRIN isn't first-class in Prisma; add via raw SQL migration.
- Cascade deletes from `TimeEntry` keep cleanup simple when a user deletes a session.
- For real scale (>50M activity_samples), partition `activity_samples` and `screenshots` by month with `pg_partman`. Out of scope for v1 at 200 users.

---

## 14. API Surface

**Auth pattern.** **Hybrid JWT access + opaque refresh token in DB.**
- Access token: short-lived JWT (15 min), signed with HS256 or RS256, contains `userId`, `workspaceId`, `role`.
- Refresh token: opaque random 256-bit, hashed in DB (`RefreshToken.tokenHash`), 30-day TTL, single-use rotation. Stored in the agent's OS keychain via `keytar` / `safeStorage`.
- Rationale: JWT is stateless for the API hot path; refresh-in-DB lets you revoke devices and audit logins, which a pure-JWT setup can't do ([hybrid auth](https://clerk.com/blog/combining-the-benefits-of-session-tokens-and-jwts)).
- For the **web dashboard**, use httpOnly + Secure + SameSite=Lax cookies holding the access token; refresh handled by `/auth/refresh` endpoint that reads the cookie.

**Endpoints (REST, versioned `/v1`):**

```
# Auth
POST   /v1/auth/login                 # email + password → access + refresh
POST   /v1/auth/refresh               # refresh → new access (rotates refresh)
POST   /v1/auth/logout                # revokes refresh token

# Agent
GET    /v1/agent/config               # workspace policy: interval, blur, title-capture
GET    /v1/agent/min-version          # force-update check
POST   /v1/agent/heartbeat            # liveness ping every 60s

# Projects & tasks
GET    /v1/projects                   # for the picker
GET    /v1/projects/:id/tasks

# Time entries
POST   /v1/time-entries               # idempotent via clientUuid
PATCH  /v1/time-entries/:id           # close

# Bulk uploads
POST   /v1/activity-samples           # batch of N samples
POST   /v1/uploads/screenshot         # → { presignedUrl, key }
POST   /v1/uploads/screenshot/:id/complete

# Dashboard (admin/manager)
GET    /v1/users
GET    /v1/users/:id/timesheets?from=&to=
GET    /v1/users/:id/screenshots?from=&to=&cursor=
DELETE /v1/screenshots/:id            # admin or owner
GET    /v1/reports/activity?...

# Audit
GET    /v1/audit?...                  # admin only
```

**Rate limits** (express-rate-limit or @upstash/ratelimit, [Express security](https://expressjs.com/en/advanced/best-practice-security/)):

| Group | Limit |
|---|---|
| `/auth/login` | 10 / 15min / IP |
| `/auth/refresh` | 60 / hour / token |
| `/uploads/screenshot` | 600 / hour / user (room for ~3/10min × 8h × buffer) |
| `/activity-samples` | 600 / hour / user |
| `/heartbeat` | 120 / hour / user |
| everything else | 300 / 15min / user |

**Middleware order:** `helmet()` → `cors()` → `pinoHttp()` → `rateLimit()` → routes.

**Idempotency:** every agent-originated POST carries `Idempotency-Key` header set to the row's ULID; server uses upsert keyed on it.

**Presigned URL design:**
- 5-minute TTL.
- Restrict to `Content-Type: image/webp` (or jpeg), max content length 2 MB, server-side encryption enforced (`x-amz-server-side-encryption: AES256`).
- One key format: `screenshots/{workspaceId}/{userId}/{YYYY}/{MM}/{DD}/{screenshotId}.webp`.

---

## 15. Web Dashboard

**Stack:** React + TypeScript + Vite + TanStack Query + TanStack Router + shadcn/ui + Tailwind. Charts: **Recharts** ([Recharts](https://recharts.org/), [PostHog tutorial](https://posthog.com/tutorials/recharts)). Lists: **TanStack Virtual** (better than react-window, same author).

**Key screens:**

1. **Login / SSO** (later add Google Workspace OAuth for the org).
2. **My day** (employee view) — own timesheet, today's screenshots, activity bars per hour, simple "Start tracking" with project picker (mirrors the agent — gives non-installers a fallback).
3. **Team timesheets** (manager) — table with virtualized rows, per-user × per-day hours, drill into a day.
4. **Day detail** — vertical hour ribbon, screenshots gallery (virtualized grid via TanStack Virtual + intersection-observer for lazy thumbnails), activity bars under each 10-min block. Click screenshot → modal with delete/blur/redact.
5. **Reports** — stacked bar (project hours / week), line (activity score over time), CSV export.
6. **People & projects admin** — invite, deactivate, role change, project create/archive.
7. **Settings** — workspace policy: screenshot frequency, title-capture toggle, blur default, retention days.
8. **Audit log** — searchable trail.

**Virtualization specifics.** Screenshot gallery can show 8 hrs × 3 shots × 7 days = 168 thumbnails per user-week. With 50 users in a team view, 8000+ tiles — must be virtualized + lazy-load images via `loading="lazy"` plus `IntersectionObserver` for actual fetch. Serve a `thumb.webp` (240×135) alongside the full webp; only fetch full on modal open.

**Charts.** Recharts is the right choice — small data, dashboard scale, React-native API. Use `<ResponsiveContainer>` + memoized data; pre-aggregate on server (`/v1/reports/activity` returns already-bucketed data) so client never crunches >500 points.

---

## 16. Privacy & Compliance

**Disclosure to employees (must-have).**
- Written policy doc signed at onboarding: what's captured (screenshots, app names, keystroke counts, idle), what's *not* (content of keystrokes, clipboard, files, microphone, camera), retention period, who can view, how to request deletion.
- In-app on first launch: full-screen consent screen — same content, "I understand & consent" checkbox before any tracking starts. Log consent timestamp + version in `AuditLog`.

**India DPDP Act 2023 / 2025 rules.**
- Employee data falls under "legitimate uses" for employment purposes, so explicit consent isn't strictly required for *work-related* monitoring, but **transparency and purpose limitation are mandatory** ([Saachi HRMS](https://saachihrms.com/blog/dpdp-act-2025-employee-data-privacy-india-hr), [Tsaaro](https://tsaaro.com/blogs/hr-dpdpa-do-you-need-consent-to-process-employee-data)).
- Full compliance deadline mid-May 2027 ([DLA Piper](https://www.dlapiperdataprotection.com/?t=law&c=IN)). Get ahead of it now.
- Required: notice of monitoring, named Data Protection Officer (DPO), breach notification process, data subject rights (access, correction, erasure).

**GDPR (still applies if any team member is in EU, even one).**
- Lawful basis = legitimate interest (productivity) + balancing test documented.
- Right to erasure: design DB so a user's `screenshots` + `activity_samples` + `time_entries` can be cascade-deleted within 30 days of request.
- Data retention: default **60 days for screenshots, 365 days for time entries and activity samples**. Industry norms: Hubstaff defaults 30d screenshots, configurable to "forever"; Time Doctor similar. **60d is a healthy compromise** — long enough for monthly reviews and disputes, short enough that you're not sitting on years of personal-data-adjacent content.
- Build retention as a daily job: `DELETE FROM screenshots WHERE captured_at < NOW() - INTERVAL '60 days'` + S3 lifecycle rule (since keys are partitioned by date, set bucket lifecycle to expire `screenshots/*/YYYY/MM/DD/` after 60d — belt + suspenders).

**Screenshot deletion / redaction UX.**
- **Employee-initiated deletion:** allow the employee to delete *their own* screenshots from the dashboard for up to 24 hours after capture (configurable). Logged in `AuditLog` with reason.
- **Employee-initiated blur:** "Blur this screenshot" reshapes the WebP server-side via sharp blur(15), replaces S3 object, marks `blurred=true`. Original is *not* kept (point of blur is privacy).
- **Admin deletion:** any time, requires reason, logged.
- Quiet-hours: agent **never captures outside scheduled work hours** if employee is on the clock during off-hours by mistake. Configurable per workspace.
- Camera, mic, clipboard: never accessed. Document this in the marketing/internal page; this is a strong differentiator vs Hubstaff for employee acceptance.

---

## 17. Common Pitfalls (what cloners get wrong)

Based on user complaints about Hubstaff/Time Doctor and engineering postmortems ([Worktime](https://www.worktime.com/blog/employee-monitoring/best-hubstaff-alternatives-for-time-tracking), [Hubstaff alternatives reviews](https://apploye.com/hubstaff-alternatives)):

1. **Treating the agent as "always-on."** Build pause-on-idle, pause-on-lock, pause-on-suspend from day one. Hubstaff's "watched every second" reputation comes from missing these (52% of monitored workers cite this).
2. **Permission UX as an afterthought.** Most clones bury permission setup; users hit a broken first-screenshot experience. Make permission onboarding a top-tier flow, with a clear "what & why" for each grant.
3. **Synchronous screenshot capture blocking the main process.** `desktopCapturer` is async but sharp encoding isn't trivial. Queue encoding to a worker thread or just `setImmediate` it, not inline.
4. **Storing screenshots as DB BLOBs.** SQLite/Postgres BLOBs work but kill backups and queries. Files on disk + S3 + DB rows pointing to them.
5. **No idempotency on uploads.** Network flakes → duplicate time entries. Use ULIDs generated client-side + server upsert.
6. **No version-floor check.** Old agents lingering 6 months later → silent data corruption. Implement a min-version gate.
7. **Aggressive notifications stressing the employee.** Tray icon state changes are enough; don't pop a toast for every screenshot.
8. **No "I'm done for today" UX.** Agent runs forever in tray, employee forgets, screenshots get taken during their personal time at 9pm. Auto-stop after N hours, prompt to extend.
9. **Title capture without opt-in.** Window titles can contain PII ("Doctor's appointment - Calendar"). Default OFF.
10. **No anti-cheat thinking.** See below — at least be aware.
11. **Crash recovery untested.** A SIGKILL mid-upload should result in resumed uploads, not lost screenshots. Test with `kill -9` on the running process.
12. **Auto-update auth.** If updates require auth headers, electron-updater needs special config — but creds shipped in the binary are leaky. Use CloudFront signed cookies on a separate hostname.

**Anti-cheat against mouse jigglers.**
Cloners often skip this. Mid-2020s detection patterns ([CurrentWare](https://www.currentware.com/blog/mouse-jiggler-detection/), [Monitask](https://www.monitask.com/en/mouse-jiggler-detection-software), [ActivTrak](https://support.activtrak.com/hc/en-us/articles/4406765537563)):

- **Pattern detection.** Real human input is bursty + correlated with keystrokes. Jigglers produce metronomic mouse-only movement. Flag sessions where mouse-distance > 1000px/min but keystrokes = 0 across multiple 10-min windows.
- **Screenshot correlation.** If the same screenshot pixels repeat for 30+ minutes while activity shows movement, suspicious. (Compute perceptual hash of screenshots server-side; alert on repeats.)
- **Hardware jiggler** (USB device): impossible to detect from software without enumerating USB devices (`node-usb-detection`), and even then, plenty are HID-class normal mice.

For v1, ship the **pattern detection** (mouse-without-keystrokes flag) and the **screenshot perceptual hash dupe** check as a backend report ("possible automation"). Don't auto-block — surface to managers.

---

## 18. Phased Delivery Plan

### 6-week MVP

**Week 1 — Backend skeleton + agent shell.**
- Monorepo set up (see §19).
- Express + Prisma + Postgres up; auth endpoints + migrations.
- Electron + Vite + React tray app; main process state machine; login + project picker.
- CI: GitHub Actions for typecheck, lint, test (no signing yet).
- **Deliverable:** agent logs in, calls heartbeat, sees projects.

**Week 2 — Time tracking + permissions.**
- Time entry start/stop, ULID idempotency, upload on stop.
- Permission onboarding screens; node-mac-permissions integration.
- powerMonitor idle + lock/unlock; pause/resume logic.
- **Deliverable:** start tracker, hours show in Postgres, idle auto-pauses.

**Week 3 — Screenshots end-to-end.**
- `desktopCapturer` + sharp WebP pipeline.
- Better-sqlite3 local queue; S3 presigned URL flow.
- Upload worker with retry/backoff.
- **Deliverable:** screenshots appear in S3, metadata in DB.

**Week 4 — Activity tracking + active window.**
- uiohook-napi counters; activity_samples batch upload.
- active-win (get-windows) sampling.
- Anti-prompt-spam guards.
- **Deliverable:** activity bars data flowing, app names captured.

**Week 5 — Dashboard MVP.**
- Login, today's view, screenshots gallery (virtualized), team timesheets.
- Recharts activity bars.
- Admin: invite users, manage projects.
- **Deliverable:** managers can view their team's day.

**Week 6 — Hardening + packaging.**
- macOS code signing + notarization (need Apple ID set up early).
- Windows NSIS build (unsigned for internal first); auto-launch wired in.
- electron-updater on generic provider.
- Sentry on agent + API.
- Internal dogfood release to 5 employees.
- **Deliverable:** signed mac DMG + Windows installer, auto-updates from staging URL, observability in Sentry.

### v1.1 (next 4 weeks)

- Windows code signing (Sectigo OV or Azure Trusted Signing if eligible).
- Differential update verification + beta channel.
- Dashboard polish: reports, CSV export, audit log UI, retention settings.
- Per-user blur policy and self-serve screenshot deletion.
- Anti-cheat report (mouse-without-keystrokes + perceptual hash dupes).
- Quiet hours / auto-stop after N hours.
- Sentry release health, source maps, structured logging end-to-end.

### v1.2+ ideas (parking lot, not promises)

- SSO (Google Workspace OIDC).
- Mobile companion for time-only (no monitoring).
- Slack notifications.
- Project budgets and alerts.
- Pull request → time entry linking via Git author email.

---

## 19. Repo Structure

**pnpm workspaces + Turborepo** for caching and parallel builds ([Prisma + pnpm guide](https://www.prisma.io/docs/guides/use-prisma-in-pnpm-workspaces), [Turbo + pnpm](https://medium.com/@TheblogStacker/2025-monorepo-that-actually-scales-turborepo-pnpm-for-next-js-ab4492fbde2a)).

```
yourco-tracker/
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
├── tsconfig.base.json
├── .changeset/                       # versioning if you split releases
│
├── apps/
│   ├── agent/                        # Electron app
│   │   ├── src/{main,preload,renderer}
│   │   ├── build/                    # icons, entitlements, installer assets
│   │   ├── electron-builder.yml
│   │   ├── electron.vite.config.ts
│   │   └── package.json
│   │
│   ├── api/                          # Express + Prisma
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── routes/{auth,agent,uploads,reports,admin}.ts
│   │   │   ├── middleware/
│   │   │   ├── services/{s3,auth,queue}.ts
│   │   │   └── lib/
│   │   ├── tests/
│   │   └── package.json
│   │
│   └── dashboard/                    # React + Vite SPA
│       ├── src/
│       │   ├── routes/
│       │   ├── components/
│       │   ├── lib/api.ts            # generated client
│       │   └── styles/
│       ├── index.html
│       └── package.json
│
├── packages/
│   ├── db/                           # Prisma schema + migrations + generated client
│   │   ├── prisma/{schema.prisma,migrations/}
│   │   ├── src/index.ts              # re-exports prisma client
│   │   └── package.json
│   │
│   ├── types/                        # shared zod schemas + TS types
│   │   ├── src/
│   │   │   ├── api.ts                # request/response zod schemas
│   │   │   ├── domain.ts             # core entities
│   │   │   └── ipc.ts                # agent IPC contracts
│   │   └── package.json
│   │
│   ├── tsconfig/                     # shared tsconfig presets
│   │   ├── base.json
│   │   ├── electron.json
│   │   ├── node.json
│   │   └── react.json
│   │
│   ├── eslint-config/                # shared lint rules
│   │
│   └── logger/                       # pino + electron-log adapter
│       ├── src/index.ts
│       └── package.json
│
└── tools/
    ├── scripts/                      # release, version bump, smoke
    └── ci/                           # github actions
```

**`pnpm-workspace.yaml`:**
```yaml
packages:
  - apps/*
  - packages/*
  - tools/*
```

**Prisma gotcha in pnpm:** the generated client lives under `.pnpm` cache, not `node_modules/@prisma/client`. Add `prisma.client.output = "../../node_modules/.prisma/client"` or accept it; for Docker, copy the whole pnpm store, not just `node_modules` ([Sinclair Software](https://www.sinclair.software/articles/pnpm-prisma-generation-issue/)).

**Sharing types agent ↔ API:** the `@yourco/types` package exports zod schemas; both sides validate. Prevents drift.

---

## 20. Observability

**Sentry for the agent** ([Sentry Electron docs](https://docs.sentry.io/platforms/javascript/guides/electron/)).
- Initialize in **main** (`@sentry/electron/main`) and **renderer** (`@sentry/electron/renderer`). Renderer events get proxied through main automatically via IPC ([Sentry IPC](https://docs.sentry.io/platforms/javascript/guides/electron/features/inter-process-communication/)).
- Enable `MainProcessSession` integration → release health (crash-free sessions per release).
- Upload sourcemaps in CI (`sentry-cli releases files upload-sourcemaps`).
- Set `release` from `package.json` version + git SHA. Channels (`stable` / `beta`) go into `environment`.

```ts
// main/sentry.ts
import * as Sentry from '@sentry/electron/main';
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: `agent@${app.getVersion()}`,
  environment: process.env.UPDATE_CHANNEL ?? 'stable',
  tracesSampleRate: 0.1,
  integrations: [Sentry.mainProcessSessionIntegration()],
});
```

**Sentry for the API.** `@sentry/node`. Sample traces at 5%, errors at 100%. Add `userId` + `workspaceId` to scope per request.

**Structured logs.**
- **API:** `pino` with `pino-http`. JSON to stdout, ship to your existing log store (CloudWatch / Datadog / Loki). Mandatory fields: `ts`, `level`, `req_id`, `user_id`, `workspace_id`, `route`, `latency_ms`.
- **Agent:** `electron-log` ([repo](https://github.com/megahertz/electron-log)) with file rotation (`log.transports.file.maxSize = 5_000_000`). On critical errors, attach last N log lines to Sentry context. Note: electron-log rotation only checks at init — supplement with a manual size check + archive call daily.

**Events to track (Sentry "feedback" or a separate analytics table — for diagnostics, not BI):**

| Category | Event | Properties |
|---|---|---|
| Lifecycle | `agent.started` | version, os, locale |
| Lifecycle | `agent.crashed` | last_state |
| Permissions | `permission.granted` | type (screen / accessibility / input-monitoring) |
| Permissions | `permission.revoked_detected` | type |
| Tracking | `timer.started` / `timer.stopped` | project, duration |
| Tracking | `idle.entered` / `idle.exited` | duration |
| Capture | `screenshot.captured` | bytes, displays_count |
| Upload | `upload.attempted` / `upload.failed` / `upload.succeeded` | bytes, latency, attempt |
| Queue | `queue.depth_high` | count (alert at >500) |
| Update | `update.checked` / `update.downloaded` / `update.applied` | from, to |
| Auth | `auth.refresh.failed` | reason |

**Alerts to wire in Sentry:**
- Crash-free session rate < 99.5% → PagerDuty.
- Auth refresh failure spike → maybe backend broke refresh flow.
- Upload failure rate > 5% across the fleet for 15 min → S3 / network issue.

---

## Quick library/version reference

| Concern | Library | Version (May 2026) | Notes |
|---|---|---|---|
| App shell | electron | 31+ | hardened runtime works since 28 |
| Builder | electron-builder | 25+ | generic provider stable |
| Bundler | electron-vite | latest | preferred over electron-forge for this stack |
| Updater | electron-updater | 6.x | bundled w/ electron-builder |
| Screenshots | (built-in `desktopCapturer`) | — | + sharp |
| Image encoding | sharp | 0.33+ | needs Node ≥ 18.17 |
| Permissions (macOS) | node-mac-permissions | 2.5.0 (Mar 2025) | rebuild for Electron |
| Active window | get-windows (`active-win`) | latest | rebrand of active-win |
| Activity hook | uiohook-napi | latest | guard against missing perms |
| Local store | better-sqlite3 | latest | WAL mode |
| Logging (agent) | electron-log | 5.x | + rotation cron |
| Logging (API) | pino + pino-http | latest | JSON to stdout |
| Errors | @sentry/electron | latest | main + renderer init |
| Errors (API) | @sentry/node | latest | with profiling |
| HTTP framework | express | 4.x or 5 | helmet + express-rate-limit |
| ORM | prisma | 5.x | + BRIN via raw SQL |
| Auth helpers | jsonwebtoken, argon2 | latest | argon2 for password hash |
| Token storage | keytar / `safeStorage` | — | OS keychain |
| S3 SDK | @aws-sdk/client-s3 | v3 latest | built-in retries |
| Dashboard charts | recharts | 2.x | server-aggregate data |
| Dashboard lists | @tanstack/react-virtual | latest | for screenshot grid |

---

## Sources

- [Electron desktopCapturer docs](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron IPC tutorial](https://www.electronjs.org/docs/latest/tutorial/ipc)
- [Electron powerMonitor docs](https://www.electronjs.org/docs/latest/api/power-monitor)
- [Electron app docs (setLoginItemSettings, SMAppService)](https://www.electronjs.org/docs/latest/api/app)
- [Electron systemPreferences screen status bug #36722](https://github.com/electron/electron/issues/36722)
- [Electron screen capture macOS bug #38190](https://github.com/electron/electron/issues/38190)
- [Electron hot corner suspend issue #12706](https://github.com/electron/electron/issues/12706)
- [electron-builder auto-update](https://www.electron.build/auto-update)
- [electron-builder release channels](https://www.electron.build/tutorials/release-using-channels.html)
- [electron-builder MacConfiguration](https://www.electron.build/electron-builder.Interface.MacConfiguration.html)
- [@electron/notarize](https://github.com/electron/notarize)
- [node-mac-permissions](https://github.com/codebytere/node-mac-permissions)
- [uiohook-napi + Electron crash issue](https://github.com/SnosMe/uiohook-napi/issues/24)
- [get-windows / active-win permission prompts](https://github.com/sindresorhus/get-windows/issues/135)
- [active-win npm](https://www.npmjs.com/package/active-win)
- [better-sqlite3](https://www.npmjs.com/package/better-sqlite3)
- [SQLite WAL recovery](https://runebook.dev/en/docs/sqlite/walformat/recovery)
- [sharp image processing](https://sharp.pixelplumbing.com/)
- [WebP cwebp docs](https://developers.google.com/speed/webp/docs/cwebp)
- [Yal.cc — taking screenshots in Electron v35](https://yal.cc/electron-desktop-screenshots/)
- [Sentry for Electron](https://docs.sentry.io/platforms/javascript/guides/electron/)
- [Sentry IPC integration](https://docs.sentry.io/platforms/javascript/guides/electron/features/inter-process-communication/)
- [electron-log](https://github.com/megahertz/electron-log)
- [electron-store encryption critique](https://blog.jse.li/posts/electron-store-encryption/)
- [Apple notarization docs](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple — resolving notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
- [Electron Forge — sign macOS](https://www.electronforge.io/guides/code-signing/code-signing-macos)
- [Httptoolkit — notarizing Electron Forge](https://httptoolkit.com/blog/notarizing-electron-apps-with-electron-forge/)
- [Microsoft — Windows code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Azure Artifact Signing (formerly Trusted Signing)](https://azure.microsoft.com/en-us/products/artifact-signing)
- [DevClass — Azure code signing 2026](https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554)
- [Screenify — macOS screen recording permissions 2026](https://www.screenify.studio/blog/2026-04-23-macos-screen-recording-permissions)
- [AWS — S3 performance design patterns](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-design-patterns.html)
- [AWS multipart upload + transfer acceleration](https://aws.amazon.com/blogs/compute/uploading-large-objects-to-amazon-s3-using-multipart-upload-and-transfer-acceleration/)
- [AWS — S3 retry strategies (EMRFS)](https://docs.aws.amazon.com/emr/latest/ReleaseGuide/emr-spark-emrfs-retry.html)
- [Hubstaff — activity calculation](https://support.hubstaff.com/how-are-activity-levels-calculated/)
- [Hubstaff — change screenshot frequency](https://support.hubstaff.com/change-screenshot-frequency/)
- [Hubstaff — privacy-first monitoring (blur)](https://hubstaff.com/productivity-monitoring/privacy-first-employee-monitoring)
- [Time Doctor — screencasts/screenshots feature](https://support.timedoctor.com/knowledge/the-screencasts-screenshots-feature)
- [Time Doctor — what it tracks](https://support.timedoctor.com/knowledge/what-does-time-doctor-monitor-on-my-computer)
- [Worktime — Hubstaff alternatives 2026](https://www.worktime.com/blog/employee-monitoring/best-hubstaff-alternatives-for-time-tracking)
- [CurrentWare — mouse jiggler detection](https://www.currentware.com/blog/mouse-jiggler-detection/)
- [Monitask — jiggler detection](https://www.monitask.com/en/mouse-jiggler-detection-software)
- [ActivTrak — detect jigglers](https://support.activtrak.com/hc/en-us/articles/4406765537563-How-to-Detect-Mouse-Jigglers-and-Activity-Mimicking-Tools-in-ActivTrak)
- [Saachi HRMS — DPDP Act 2025 employee data](https://saachihrms.com/blog/dpdp-act-2025-employee-data-privacy-india-hr)
- [Tsaaro — DPDPA employee consent](https://tsaaro.com/blogs/hr-dpdpa-do-you-need-consent-to-process-employee-data)
- [DLA Piper — India data protection](https://www.dlapiperdataprotection.com/?t=law&c=IN)
- [MeraMonitor — employee monitoring laws India 2025](https://meramonitor.com/employee-monitoring-laws-in-india/)
- [Prisma indexes docs](https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes)
- [Prisma + pnpm workspaces](https://www.prisma.io/docs/guides/use-prisma-in-pnpm-workspaces)
- [Express security best practices](https://expressjs.com/en/advanced/best-practice-security/)
- [Better Stack — rate limiting Express](https://betterstack.com/community/guides/scaling-nodejs/rate-limiting-express/)
- [Clerk — combining JWTs and session tokens](https://clerk.com/blog/combining-the-benefits-of-session-tokens-and-jwts)
- [Recharts](https://recharts.org/)
- [PostHog — Recharts tutorial](https://posthog.com/tutorials/recharts)
