# Lark OAuth as Sole Identity — Production Implementation Plan

**Status:** proposed · **Scope:** Option B — dashboard + desktop agent both authenticate via Lark; email/password removed in production. **Lark is the single source of truth for identity + login; Grind owns the org hierarchy.**

---

## 0. Principles & decisions

- **Identity = Lark.** Canonical key is the Lark **`open_id`** (app-scoped, stable). `union_id` stored as a secondary key. `email`, `name`, `avatar_url` are pulled from Lark and refreshed on every login.
- **Hierarchy = Grind.** `team`, `manager`, `role` are assigned by an admin inside Grind. Lark's department/manager tree is **never read** (it's unreliable).
- **Provisioning.** First Lark login JIT-creates the user as **PENDING MEMBER** (no session). An admin completes setup (team + shift) or activates explicitly. The configured **bootstrap admin email** is created **ACTIVE ADMIN** and bootstraps the single default workspace.
- **No passwords in production.** `passwordHash` becomes nullable and is never set by the Lark path. A **dev-only** password shim stays behind `NODE_ENV!=='production' && ALLOW_PASSWORD_LOGIN==='true'` so local dev + the test suite keep working without a live Lark tenant.
- **Reuse, don't rebuild.** `lark/oauthClient.ts`, `lark/tokenManager.ts`, `lark/oauth.ts`, `lark/crypto.ts`, `lib/jwt.ts`, `lib/refreshToken.ts`, `middleware/{auth,scope}.ts`, RBAC — all unchanged in contract.

---

## 1. Verified Lark API contract (international tenant, `larksuite.com`)

| Step | Method · URL | Notes |
|---|---|---|
| Authorize | `GET https://accounts.larksuite.com/open-apis/authen/v1/authorize` | params `client_id, redirect_uri, response_type=code, scope, state` (+ optional `code_challenge, code_challenge_method=S256` PKCE). Already built in `lark/oauth.ts:buildAuthorizeUrl`. |
| Token | `POST https://open.larksuite.com/open-apis/authen/v2/oauth/token` | `grant_type=authorization_code, client_id, client_secret, code, redirect_uri`. Returns `access_token, refresh_token` (**only if `offline_access` granted**), `expires_in, refresh_token_expires_in, scope, token_type=Bearer`. Refresh tokens are **single-use**. Already built in `lark/oauthClient.ts`. |
| Profile | `GET https://open.larksuite.com/open-apis/authen/v1/user_info` (Bearer = user_access_token) | Returns `open_id, union_id, user_id, name, en_name, avatar_url, email, enterprise_email, mobile, tenant_key`. **`email` requires scope `contact:user.email:readonly`.** Repo calls this in `lark/tasks.ts:getOpenId` — generalize to `getUserProfile`. |

**Scopes requested at login** (one consent powers login *and* the bot/approvals/tasks features): existing `LARK_SCOPE_STRING` (`lark/config.ts`) **+ `contact:user.email:readonly`**. `offline_access` is already present.

Redirect URI (single, strict-match, registered in the Lark console): `https://grind-xcdr.onrender.com/v1/auth/lark/callback`.

---

## 2. Data model (`packages/db/prisma/schema.prisma`) — one migration

```prisma
enum ProvisioningStatus { PENDING ACTIVE }

model User {
  // ...
  passwordHash       String?              // was non-null → NULLABLE
  provisioningStatus ProvisioningStatus @default(PENDING)
  avatarUrl          String?
  // LarkIdentity (openId @unique) already exists — the login lookup key.
}

// Short-lived, single-use handoff codes for the DESKTOP AGENT deep-link flow.
model AgentAuthCode {
  id            String   @id @default(cuid())
  codeHash      String   @unique          // sha256(one-time code); plaintext never stored
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  challenge     String                    // PKCE S256 challenge from the agent
  expiresAt     DateTime                  // now + 120s
  consumedAt    DateTime?                 // single-use guard
  createdAt     DateTime @default(now())
  @@index([userId])
}
```

- DB is empty → no backfill needed; `provisioningStatus` default `PENDING` is harmless. (If it weren't empty, the migration would backfill existing rows to `ACTIVE`.)
- Workspace bootstrap is idempotent via a **fixed id** (`WORKSPACE_ID` env, default `ws_default`) used with `upsert` → no duplicate-workspace race.

---

## 3. API surface

All new routes live in `apps/api/src/routes/authLark.ts`, mounted **before** `requireAccessToken` (the callback is browser-facing, like `routes/lark.ts:36`). A reusable service `apps/api/src/auth/larkLogin.ts` holds the identity/provisioning logic so both the dashboard and agent paths share it.

### 3.1 `GET /v1/auth/lark/start`
Query: `client=dashboard|agent` (default `dashboard`); agent adds `code_challenge` (its PKCE S256 challenge).

1. `503 {error:'lark_not_configured'}` if `!isLarkConfigured()`.
2. Build a signed **state JWT** (`lark/oauth.ts`, extend): `{ kind:'lark_login', nonce, client, agentChallenge?, iat, exp(+10m) }`.
3. **Dashboard CSRF:** set httpOnly cookie `grind_login_state=<nonce>` (`SameSite=None;Secure` in prod, `Lax` dev, 10-min TTL). (Agent has no cookie; its CSRF/interception defense is the PKCE binding in §3.3.)
4. `302` → `buildAuthorizeUrl(scope = LARK_SCOPE_STRING + ' contact:user.email:readonly', state)`. (Or return `{authorizeUrl}` JSON if `Accept: application/json`, for clients that prefer to open it themselves.)

### 3.2 `GET /v1/auth/lark/callback`
Query from Lark: `code?`, `state?`, `error?`, `error_description?`.

Ordered handling (each failure → a specific terminal outcome, §6):
1. **User-denied / Lark error:** `error` present → redirect dashboard `…/login?error=denied` (or agent error deep-link).
2. **Missing `code`/`state`** → `…/login?error=invalid_request`.
3. **Verify state JWT** (`kind==='lark_login'`, not expired). Fail → `…/login?error=state_invalid`.
4. **Dashboard CSRF:** if `state.client==='dashboard'`, require cookie `grind_login_state===state.nonce`; clear the cookie. Mismatch → `…/login?error=state_invalid`.
5. **Exchange code** via `oauthClient.exchangeCode(code, redirectUri)`:
   - `LarkTransientError` (network/5xx/429) → `…/login?error=temporary` (retryable).
   - `LarkReauthRequiredError` / invalid_grant → `…/login?error=auth_failed`.
6. **Fetch profile** `getUserProfile(access_token)`:
   - email = `enterprise_email || email`, normalized (`trim().toLowerCase()`).
   - **No `open_id`** (shouldn't happen) → `…/login?error=auth_failed`.
   - **No email** (scope not granted / user has none) → `…/login?error=no_email` (actionable: "ask your admin to grant the email permission").
7. **Resolve + provision** (`larkLogin.resolveUser`, §4) → `{user, status}`.
8. **Deactivated** user (`deactivatedAt!=null`) → `…/login?error=deactivated`.
9. **PENDING** → dashboard: `…/login?status=pending`; agent: deep-link `grind://auth?status=pending`.
10. **ACTIVE** →
    - **dashboard:** `issueRefreshToken(user.id)` + `signAccessToken` + set `grind_at` cookie (reuse `auth.ts:72` logic) → `302` to validated dashboard origin (`DASHBOARD_URL`, never a user-supplied redirect).
    - **agent:** create an `AgentAuthCode` (random 32B; store `sha256`; bind `challenge=state.agentChallenge`; 120s TTL) → `302` `grind://auth?code=<one-time>`.
11. **Persist Lark tokens** (best-effort, after user exists): `tokenManager.persistTokens(user.id, tokenResp)` (extracted from `connect`). Failure is logged, non-fatal (next login re-grants). Single-use refresh that fails to persist is simply re-issued next login.

### 3.3 `POST /v1/auth/lark/exchange` (agent only)
Body: `{ code, codeVerifier }`.
1. `sha256(code)` → look up `AgentAuthCode`. Not found / `consumedAt!=null` / expired → `400 {error:'code_invalid'}`.
2. **PKCE check:** `base64url(sha256(codeVerifier)) === challenge`, else `400 {error:'pkce_mismatch'}` (blocks a malicious local app that intercepted the `grind://` redirect — it lacks the verifier).
3. In **one transaction**: mark `consumedAt=now()` (single-use) and issue `signAccessToken` + `issueRefreshToken`.
4. `200 { accessToken, refreshToken, userId, workspaceId }`. The agent stores these in `safeStorage` exactly as today.

### 3.4 Admin (`routes/admin.ts`)
- `GET /v1/admin/users?status=pending` — list PENDING users (reuse existing list + filter).
- `POST /v1/admin/users/:id/activate` — explicit PENDING→ACTIVE override. Admin setup writes also auto-activate once a pending user has both team and shift.
- Reuse `PATCH /v1/admin/users/:id` for team/manager/role/shift.
- **Remove** temp-password generation on invite (`admin.ts:1155`); the "invite" concept becomes "pre-create a PENDING shell by email" (optional) or simply "they appear after first Lark login."
- Last-admin protection (`admin.ts:1071`) unchanged.

---

## 4. Identity resolution & provisioning (`auth/larkLogin.ts`)

`resolveUser(profile) → { user, status }`, all inside a transaction with unique-violation retry:

1. **By open_id:** `LarkIdentity.findUnique({openId})`. Hit → update `User.{name,avatarUrl,email}` from Lark (profile sync of stable fields only), return user + its status.
2. **By email** (covers a pre-created PENDING shell or a future non-empty DB): `User.findUnique({email})`. Hit → upsert `LarkIdentity` linking `open_id/union_id`, update profile, return.
3. **Create:**
   - **Workspace:** `upsert({where:{id: WORKSPACE_ID}, create:{id, name:'Workspace'}})` — idempotent, no race.
   - **Bootstrap admin:** `email ∈ LARK_BOOTSTRAP_ADMIN_EMAILS` (comma-list, normalized) → `role=ADMIN, provisioningStatus=ACTIVE`. Else `role=MEMBER, provisioningStatus=PENDING`.
   - Create `User` (`passwordHash=null`) + `LarkIdentity` in the same transaction.
4. **Bootstrap promotion:** if the user already existed as PENDING but their email is now a bootstrap email → promote to `ADMIN/ACTIVE` (covers "logged in before the env var was set").

**Race / idempotency:** concurrent first-logins of the same person → the second hits a `P2002` on `LarkIdentity.openId` or `User.email`; we catch it and re-run step 1/2 as a read (find-or-create). Workspace `upsert` on fixed id is inherently safe.

**Profile-sync edge:** updating `User.email` from Lark can collide with another user's email (`P2002`) — caught, logged, old email kept (open_id remains the source of truth, so login still works).

---

## 5. Desktop agent — deep-link flow (`apps/agent`)

**Why a one-time code, not tokens in the URL:** custom-scheme URLs land in OS logs / other local apps can register the scheme. We never put long-lived tokens in `grind://`; we pass a 120-s single-use code that is **useless without the agent's PKCE verifier** (§3.3).

1. **Protocol registration** (`main/index.ts`): `app.setAsDefaultProtocolClient('grind')`; electron-builder `protocols` entry in `electron-builder.yml`. **Single-instance lock** (`app.requestSingleInstanceLock()`); macOS `open-url`, Windows/Linux `second-instance` argv parsing. Queue deep-links that arrive before `app.whenReady()`.
2. **Start:** renderer "Sign in with Lark" → IPC `auth:loginWithLark` → main generates `codeVerifier` (32B) + `code_challenge`, `shell.openExternal('…/v1/auth/lark/start?client=agent&code_challenge=…')`, holds the verifier in memory with a timeout.
3. **Return:** `grind://auth?code=…` (or `?status=pending` / `?error=…`) → main parses → `POST /v1/auth/lark/exchange {code, codeVerifier}` → `saveTokens()` (`services/tokenStore.ts`, unchanged) → broadcast `loggedIn`.
4. **Renderer:** `screens/Login.tsx` → single "Sign in with Lark" button + states: idle / waiting-for-browser / pending-approval / error(reason) + "try again". `preload/index.ts` exposes `auth.loginWithLark()`; remove `auth.login(email,password)`.
5. **Edge cases:** browser closed / never returns → 90-s timeout, re-enable button; expired one-time code → `code_invalid` → restart; second agent instance → focus the first; deep-link before ready → queue; protocol not registered in `electron-vite dev` → dev uses the password shim.

---

## 6. Error & edge-case matrix

| Condition | Detection | Dashboard outcome | Agent outcome |
|---|---|---|---|
| Lark not configured | `!isLarkConfigured()` | `503` → login shows "SSO unavailable" | error deep-link `config` |
| User denied consent | `?error=access_denied` | `login?error=denied` | `grind://auth?error=denied` |
| Forged/expired `state` | JWT verify / cookie mismatch | `login?error=state_invalid` | exchange rejects (PKCE) |
| Network/5xx/429 at token | `LarkTransientError` | `login?error=temporary` (retry) | `error=temporary` |
| Invalid/expired auth code | `LarkReauthRequiredError` | `login?error=auth_failed` | `error=auth_failed` |
| No email (scope/missing) | profile.email empty | `login?error=no_email` | `error=no_email` |
| Deactivated user | `deactivatedAt!=null` | `login?error=deactivated` | `error=deactivated` |
| PENDING user | `provisioningStatus` | `login?status=pending` banner | `status=pending` screen |
| Concurrent first login | `P2002` on open_id/email | retried as find — transparent | same |
| Email changed in Lark | match by open_id | profile updated | same |
| Email collides on sync | `P2002` on email update | logged, old email kept | same |
| One-time code reuse/expiry | `consumedAt`/`expiresAt` | n/a | `code_invalid` → restart |
| PKCE mismatch | challenge≠sha256(verifier) | n/a | `pkce_mismatch` (blocks interception) |
| Lark refresh-token persist fails | catch in `persistTokens` | login still succeeds; re-grants next time | same |
| Open-redirect attempt | `next` not same-origin | ignored; redirect to `DASHBOARD_URL` | n/a |
| Bootstrap email logs in late | PENDING→promote | becomes ADMIN/ACTIVE | same |

**Cross-cutting robustness:** every handler wrapped in try/catch → `errorHandler`; tokens/secrets redacted in logs (extend `pino` redact paths); a simple in-memory **rate limiter** on `/start`, `/callback`, `/exchange` (per-IP, e.g. 30/min) to blunt abuse; all timestamps UTC; all email comparisons normalized.

---

## 7. Security controls (summary)

- **CSRF:** dashboard double-submit cookie ↔ state nonce; agent PKCE S256 binding on the one-time code.
- **Replay:** Lark auth code single-use (enforced by Lark); our one-time code single-use + 120 s TTL + hashed at rest.
- **Open redirect:** post-login target is the server-configured `DASHBOARD_URL` allowlist only; any `next` is validated to a same-origin path or dropped.
- **Cookies:** `httpOnly; Secure; SameSite=None` in prod (already implemented for cross-site Vercel↔Render).
- **Secrets:** `client_secret` only on the API; agent is a public client that never touches Lark directly; Lark refresh tokens AES-256-GCM at rest (`lark/crypto.ts`).
- **Scope minimization documented:** login requests the full set for one-consent UX; admins may trim to `contact:user.email:readonly offline_access` if bot features aren't wanted.

---

## 8. Password removal + local/dev strategy

- Production: delete `/v1/auth/login` behavior. Keep a **dev shim**: `if (env.NODE_ENV!=='production' && env.ALLOW_PASSWORD_LOGIN==='true')` mount a `/v1/auth/login` that still verifies `passwordHash`. Lets `seed.ts` + the test suite + offline local dev work without a live Lark tenant.
- `seed.ts`: keep creating dev users **with** `passwordHash` (only usable under the shim) **and** mark them `ACTIVE`; optionally seed a fake `LarkIdentity` for end-to-end local tests.
- Types: `LoginRequest/LoginResponse` retained (used by shim + agent dev), but the dashboard/agent prod UIs no longer call them.

---

## 9. Observability

- Structured `pino` logs per phase keyed by `state.nonce` as a correlation id: `lark_login.start|callback.exchange_ok|profile_ok|provisioned|session_issued|denied|error{reason}` — **tokens/emails redacted** (log `open_id` + hashed email only).
- Counters (log-derived): logins by outcome, pending-created, bootstrap-promotions.
- `/healthz` unchanged; add a `/v1/auth/lark/diag` (admin-only) reporting `{configured, loginRedirectUri, connectRedirectUri, scopes, bootstrapEmailsSet}` for ops.

---

## 10. Testing

- **Unit:** `larkLogin.resolveUser` — open_id hit / email hit / create / bootstrap / pending / promotion / P2002 retry / email-collision. `oauth state` (nonce, kind, expiry, cookie mismatch). PKCE verify. One-time code single-use + expiry.
- **Integration (supertest, in-memory/mocked Lark client):** full `/start`→`/callback` for dashboard (cookie set, redirect) and agent (`grind://` + `/exchange`); every error row in §6; deactivated; pending; rate limit.
- **Agent (vitest, mocked electron):** deep-link parse, queue-before-ready, single-instance, exchange→saveTokens, timeout/retry.
- **Dashboard:** Login renders Lark button, pending banner, error messages; router guard unchanged.
- Keep existing `lark/oauth.test.ts`, `lark.test.ts` green; update/remove password-login tests to the dev-shim path.

---

## 11. Rollout

1. Lark console: enable scopes (+`contact:user.email:readonly`), register both redirect URIs, copy App ID/Secret.
2. Render env: `LARK_APP_ID, LARK_APP_SECRET, LARK_TOKEN_KEY (openssl rand -base64 32), LARK_LOGIN_REDIRECT_URI=https://timo.emiactech.com/v1/auth/lark/callback, LARK_CONNECT_REDIRECT_URI=https://timo.emiactech.com/v1/lark/oauth/callback, LARK_BOOTSTRAP_ADMIN_EMAILS=abhishek@emiactech.com, WORKSPACE_ID=ws_default`. (Leave `ALLOW_PASSWORD_LOGIN` unset in prod.)
3. Ship API (migration runs via `prisma migrate deploy` in the Render build) → deploy dashboard (Vercel) → ship signed/unsigned agent with the `timo://` protocol.
4. Bootstrap admin signs in → activates the team as they log in.
5. Revert path: `passwordHash` is retained (nullable) + the dev shim, so password login can be re-enabled by flag without data loss.

---

## 12. Env reference

| Var | Where | Purpose |
|---|---|---|
| `LARK_APP_ID/_SECRET/_TOKEN_KEY` | Render | OAuth + refresh-token encryption (already in `env.ts`) |
| `LARK_LOGIN_REDIRECT_URI` | Render | strict-match callback for dashboard/agent sign-in |
| `LARK_CONNECT_REDIRECT_URI` | Render | strict-match callback for task integration connect/reconnect |
| `LARK_BOOTSTRAP_ADMIN_EMAILS` | Render (new) | comma-list → ACTIVE ADMIN on first login |
| `WORKSPACE_ID` | Render (new, default `ws_default`) | idempotent single workspace |
| `DASHBOARD_URL` | Render | post-login redirect allowlist + CORS |
| `ALLOW_PASSWORD_LOGIN` | local only | enable dev password shim (never in prod) |

---

## 13. File-by-file change list

**API**
- `packages/db/prisma/schema.prisma` (+migration): nullable `passwordHash`, `ProvisioningStatus`, `avatarUrl`, `AgentAuthCode`.
- `apps/api/src/env.ts`: `LARK_BOOTSTRAP_ADMIN_EMAILS`, `WORKSPACE_ID`, `ALLOW_PASSWORD_LOGIN`.
- `apps/api/src/lark/config.ts`: add `contact:user.email:readonly` to scopes.
- `apps/api/src/lark/oauth.ts`: `signLoginState/verifyLoginState` (nonce, client, agentChallenge).
- `apps/api/src/lark/tasks.ts` → `getUserProfile(accessToken)` returning full profile.
- `apps/api/src/lark/tokenManager.ts`: extract `persistTokens(userId, tokenResp)`.
- `apps/api/src/auth/larkLogin.ts` (new): `resolveUser`, bootstrap/provisioning, PKCE + one-time-code helpers.
- `apps/api/src/routes/authLark.ts` (new): `/start`, `/callback`, `/exchange`; mount in `app.ts` before auth.
- `apps/api/src/routes/auth.ts`: gate `/login` behind the dev shim.
- `apps/api/src/routes/admin.ts`: pending list + `activate`; drop temp-password invite.
- `apps/api/src/middleware/scope.ts` (or login): reject `PENDING`.
- `packages/types`: `LarkLoginStart/Callback`, `AgentExchangeRequest/Response`, `ProvisioningStatus`, pending-user DTOs.

**Dashboard**
- `screens/Login.tsx` (Lark button + pending/error states), `lib/auth.ts` (drop password mutation; add Lark start), `router.tsx` (unchanged guard; read `?status/?error`), admin "Pending users" panel.

**Agent**
- `main/index.ts` (protocol + single-instance + open-url/second-instance + queue), `electron-builder.yml` (`protocols`), `ipc/auth.ts` + `services/auth.ts` (`loginWithLark`, exchange), `preload/index.ts` (expose), `renderer/screens/Login.tsx` (Lark button + states).

**Docs/config**: `.env.example`, `DEPLOY.md` (auth section), this file.
