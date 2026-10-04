# timo-sync: where the Rust is not the TypeScript

Everything here is a deliberate, listed difference. The proof for the rest is in
`tests/` (ports of the TS tests, loopback-server behaviour tests) and
`tests/fixtures/` (golden output of the REAL TypeScript, see `parity/src/gen/sync*.ts`).

## Proven against the real TypeScript (fixtures)

| Fixture | Real TS function | Cases |
|---|---|---|
| `activitySync/flush_activity` | `activity/sync.ts::flushActivity` (batches, UTF-16 caps, bytes) | 511 |
| `auth/flow` | `auth.ts` start / redeem / cancel / password login, op sequences | 502 |
| `uploader/screenshot_retry_delay_ms`, `…_failure_decision` | `capture/uploader.ts` policy | 505 + 505 |
| `uploader/upload_screenshots_now` | `uploader.ts::uploadScreenshotsNow` (bodies, multipart, store marks) | 500 |
| `wire/build_heartbeat_request` | `heartbeatPayload.ts::buildHeartbeatRequest` | 503 |
| `wire/search_params`, `encode_uri_component` | `URLSearchParams`, `encodeURIComponent` | 506, 505 |
| `lark/create_task_error_message` | `ipc/lark.ts::createTaskErrorMessage` (copied, see below) | 504 |
| `osCrypt/*` | Node `crypto` building Chromium `os_crypt` blobs | 1549 |

The timer's create/sync request BODIES are proven by `timo-core`'s `sync_payload`
fixtures (that agent ported them); `tests/timer_sync.rs` pins the path, method,
receipt parsing and error mapping of the transport on top.

Oracle caveat: `ipc/lark.ts::createTaskErrorMessage` is module-private and
Electron-bound, so its body is COPIED into the generator (cited file:line). A
later change in `legacy/` is invisible until the copy is refreshed.

## Differences

1. **Transport.** `fetch` (undici) became `reqwest` + rustls with the platform
   certificate verifier. undici trusts Node's bundled CA list; the Rust client trusts
   the OS store (a superset on a managed laptop, and it follows a corporate proxy CA).
   Headers undici adds on its own (`user-agent: node`, `accept-language`, `sec-fetch-*`,
   `accept-encoding`) are not sent; the ones `apiClient.ts` sets are (`Content-Type`
   on every request, `ngrok-skip-browser-warning`, a bearer token only when present).
2. **Timeout covers the body.** `AbortSignal.timeout` aborts a `fetch` and the body
   read that follows it; the Rust timeout wraps send + body read together. The first
   (401) response body is read eagerly, which the TypeScript never does.
3. **Response shapes.** TypeScript casts (`as T`) and finds a missing field later;
   serde fails at once with `ApiError::Shape`. Types for cast responses use `default`
   where the TypeScript tolerates absence (`detached`, `LarkStatus` flags, …).
   `TimerSyncReceipt` is parsed strictly, as in TypeScript, by `timo-core`'s DTO.
4. **Session storage.** `tokens.bin` (Electron `safeStorage`) became one entry in the
   OS keychain (service `com.relicwave.grind`, slots `tokens` and `pending-lark-login`).
   A keychain write is atomic, so the file-rename retry loop and the `.next` slots do
   not exist; the compare-and-swap semantics (`replaceTokensIfMatch`,
   `clearTokensIfMatch`) and the one-at-a-time mutation order do. Windows Credential
   Manager refuses blobs over 2560 bytes: the vault guard returns an error instead
   (a session is well under 1 KiB). The one-time import of the Electron files is in
   `src/tokens/legacy/` (see `OSCRYPT.md`: sources, and what is a prediction).
5. **`cancelLarkLogin`.** The stored copy is wiped in the background as in
   TypeScript, but a gate makes a login started right afterwards wait for the wipe;
   in TypeScript that is a race between two file operations.
6. **`createdAt` of a pending login** must be a whole number (it is `Date.now()`);
   a fractional one is treated as unreadable, TypeScript accepts any finite number.
7. **Uploader policy lives here, not in `timo-core`.** It classifies `ApiError`
   (`HttpError 503`, `UnauthorizedError`), which `timo-core` cannot see.
   OS file errors: only `ENOENT` is reproduced with Node's message
   (`ENOENT: no such file or directory, open '<path>'`); other I/O errors use Rust's text.
8. **`lark.ts` error mapper.** A truthy non-string `error`/`detail` that the
   TypeScript returns as is (a number, say) is returned as its JSON text.
9. **Lark tasks** keep the field order the API writes; unknown extra fields the API
   might add are dropped when a task is re-serialised (TypeScript keeps them).
10. **Drains and heartbeat** keep the TypeScript's single-flight and
    overlapping-tick behaviour, with `tokio` timers; their collaborators (timer,
    probes, server clock, stores) are traits the app wires: `HeartbeatHooks`,
    `ActivityOutbox`, `ActivityDrainDeps`, `ScreenshotQueue`, `LarkSyncHooks`.
11. **Not added, as in TypeScript:** no generic retry/backoff in `api()`, and no
    timeout on the heartbeat, config, activity or Cloudinary calls. Adding them is a
    behaviour change that needs a sign-off.

## Cross-checking Windows from a Mac

`aws-lc`/`ring` and SQLite's C cannot be built for `x86_64-pc-windows-msvc` without a
Windows SDK, so TLS (`timo-sync`'s `tls` feature) and SQLite (`timo-store`'s `bundled`)
are default features that the cross-check switches off:

    cargo clippy -p timo-sync -p timo-store --no-default-features --target x86_64-pc-windows-msvc -- -D warnings

CI on `windows-latest` builds both for real.
