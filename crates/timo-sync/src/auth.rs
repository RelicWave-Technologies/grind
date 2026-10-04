//! Port of `legacy/agent/src/main/services/auth.ts`: Lark login (system browser
//! plus a custom-scheme deep link, with PKCE), password login, logout and the
//! saved-session check.
//!
//! The verifier is generated here and never leaves the process, so an app that
//! intercepts the callback URL cannot redeem the one-time code: the API checks
//! `sha256(verifier) == challenge`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use tokio::task::AbortHandle;

use crate::api::ApiClient;
pub use crate::auth_types::{AuthEnv, OpenFuture, RandomFill};
use crate::auth_types::{
    ExchangeBody, ExchangeResponse, LoginBody, LoginResponse, LogoutBody, PendingLogin, PendingView,
};
use crate::config::ClientConfig;
use crate::error::ApiError;
use crate::http::RequestOptions;
use crate::pending_login::{PendingLoginStore, StoredPendingLarkLogin};
use crate::tokens::{StoredTokens, TokenStore};
use crate::urlenc::search_params;
use crate::wire::json_body;

pub const LARK_LOGIN_REUSE_TTL_MS: i64 = 9 * 60_000;
pub const LARK_LOGIN_HARD_TTL_MS: i64 = 12 * 60_000;

type PendingState = Arc<Mutex<Option<PendingLogin>>>;

pub struct AuthService<S: TokenStore, P: PendingLoginStore> {
    api: Arc<ApiClient<S>>,
    config: ClientConfig,
    store: Arc<P>,
    env: Arc<AuthEnv>,
    pending: PendingState,
    /// Held while a cancelled login's stored copy is being wiped, so a login
    /// started right after `cancelLarkLogin()` cannot read the copy back.
    store_gate: Arc<tokio::sync::Mutex<()>>,
}

impl<S: TokenStore, P: PendingLoginStore> std::fmt::Debug for AuthService<S, P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthService").finish_non_exhaustive()
    }
}

impl<S: TokenStore, P: PendingLoginStore> AuthService<S, P> {
    pub fn new(api: Arc<ApiClient<S>>, config: ClientConfig, store: Arc<P>, env: AuthEnv) -> Self {
        Self {
            api,
            config,
            store,
            env: Arc::new(env),
            pending: Arc::new(Mutex::new(None)),
            store_gate: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn view(&self) -> Option<PendingView> {
        let guard = self.pending.lock().ok()?;
        guard.as_ref().map(|p| PendingView {
            verifier: p.verifier.clone(),
            login_url: p.login_url.clone(),
            created_at: p.created_at,
        })
    }

    fn set_pending(&self, view: &PendingView) {
        let expiry = self.arm_expiry(&view.verifier, view.created_at);
        if let Ok(mut guard) = self.pending.lock() {
            *guard = Some(PendingLogin {
                verifier: view.verifier.clone(),
                login_url: view.login_url.clone(),
                created_at: view.created_at,
                expiry,
            });
        }
    }

    /// `clearPendingLarkLoginMemory`.
    fn clear_memory(&self) {
        if let Ok(mut guard) = self.pending.lock() {
            *guard = None;
        }
    }

    /// `clearPendingLarkLogin`.
    async fn clear_pending(&self) {
        self.clear_memory();
        self.store.clear().await;
    }

    /// `armExpiryTimer`: after the hard TTL, forget the login if it is still
    /// the same one, and wipe the stored copy.
    fn arm_expiry(&self, verifier: &str, created_at: i64) -> AbortHandle {
        let elapsed = (self.env.now_ms)().saturating_sub(created_at);
        let remaining = LARK_LOGIN_HARD_TTL_MS.saturating_sub(elapsed).max(1);
        let state = Arc::clone(&self.pending);
        let store = Arc::clone(&self.store);
        let verifier = verifier.to_owned();
        let wait = Duration::from_millis(u64::try_from(remaining).unwrap_or(1));
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            let expired = state.lock().ok().is_some_and(|mut g| {
                let same = g
                    .as_ref()
                    .is_some_and(|p| p.verifier == verifier && p.created_at == created_at);
                if same {
                    // Dropping the entry aborts this very task's handle: harmless.
                    *g = None;
                }
                same
            });
            if expired {
                store.clear().await;
            }
        })
        .abort_handle()
    }

    /// `createPendingLarkLogin`: 48 random bytes as a 64-character base64url
    /// verifier; the challenge is the base64url SHA-256 of its text.
    fn create_pending(&self, now: i64) -> PendingView {
        let mut bytes = [0_u8; 48];
        (self.env.random_fill)(&mut bytes);
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let query = search_params(&[
            ("client", "agent"),
            ("code_challenge", &challenge),
            ("callback_scheme", self.config.callback_scheme.as_str()),
        ]);
        PendingView {
            verifier,
            login_url: format!("{}/v1/auth/lark/start?{query}", self.config.api_url),
            created_at: now,
        }
    }

    /// `getPendingLarkLogin`.
    async fn get_pending(&self, now: i64) -> Option<PendingView> {
        if let Some(live) = self.view() {
            return Some(live);
        }
        let stored = {
            let _wiped = self.store_gate.lock().await;
            self.store.load().await?
        };
        let view = PendingView {
            verifier: stored.verifier,
            login_url: stored.login_url,
            created_at: stored.created_at,
        };
        if is_hard_expired(view.created_at, now) {
            self.clear_memory();
            self.store.clear().await;
            return None;
        }
        self.set_pending(&view);
        Some(view)
    }

    /// `startLarkLogin`: mint PKCE and open the browser; the deep link finishes it.
    pub async fn start_lark_login(&self) -> Result<(), ApiError> {
        let now = (self.env.now_ms)();
        let existing = self
            .get_pending(now)
            .await
            .filter(|l| now.saturating_sub(l.created_at) < LARK_LOGIN_REUSE_TTL_MS);
        let login = if let Some(reusable) = existing {
            reusable
        } else {
            self.clear_pending().await;
            let fresh = self.create_pending(now);
            self.set_pending(&fresh);
            self.store
                .save(&StoredPendingLarkLogin {
                    verifier: fresh.verifier.clone(),
                    login_url: fresh.login_url.clone(),
                    created_at: fresh.created_at,
                })
                .await?;
            fresh
        };
        if let Err(message) = (self.env.open_external)(login.login_url).await {
            self.clear_pending().await;
            tracing::warn!(err = %message, "failed to open Lark login in browser");
            return Err(ApiError::Other(message));
        }
        Ok(())
    }

    /// `completeLarkLogin`: redeem the deep-link code. `false` for a stray or
    /// replayed link (no flow in progress, or the verifier expired).
    pub async fn complete_lark_login(&self, code: &str) -> Result<bool, ApiError> {
        let Some(login) = self.get_pending((self.env.now_ms)()).await else {
            return Ok(false);
        };
        if is_hard_expired(login.created_at, (self.env.now_ms)()) {
            self.clear_pending().await;
            return Ok(false);
        }
        let body = json_body(&ExchangeBody {
            code,
            code_verifier: &login.verifier,
        })?;
        let options = RequestOptions::post(Some(body)).without_auth();
        let res: ExchangeResponse = self.api.api("/v1/auth/lark/exchange", &options).await?;
        self.api
            .tokens()
            .save(StoredTokens {
                access_token: res.access_token,
                refresh_token: res.refresh_token,
                user_id: res.user_id,
                workspace_id: res.workspace_id,
            })
            .await?;
        (self.env.clear_workspace_time)();
        self.clear_pending().await;
        Ok(true)
    }

    /// `cancelLarkLogin`: abandon an in-flight login (the deep link reported
    /// pending/error). The stored copy is wiped in the background, as `void`.
    pub fn cancel_lark_login(&self) {
        self.clear_memory();
        let store = Arc::clone(&self.store);
        let gate = Arc::clone(&self.store_gate);
        // Take the gate NOW (synchronously) when it is free, so the wipe is
        // ordered before any later `get_pending`.
        let held = Arc::clone(&gate).try_lock_owned().ok();
        tokio::spawn(async move {
            let _wiping = match held {
                Some(guard) => guard,
                None => gate.lock_owned().await,
            };
            store.clear().await;
        });
    }

    /// `login(email, password)`.
    pub async fn login(&self, email: &str, password: &str) -> Result<serde_json::Value, ApiError> {
        let body = json_body(&LoginBody {
            email,
            password,
            device_name: format!(
                "{} ({})",
                self.config.hostname,
                self.config.platform.as_str()
            ),
        })?;
        let options = RequestOptions::post(Some(body)).without_auth();
        let res: LoginResponse = self.api.api("/v1/auth/login", &options).await?;
        let text = |key: &str| {
            res.user
                .get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        self.api
            .tokens()
            .save(StoredTokens {
                access_token: res.access_token,
                refresh_token: res.refresh_token,
                user_id: text("id"),
                workspace_id: text("workspaceId"),
            })
            .await?;
        (self.env.clear_workspace_time)();
        Ok(res.user)
    }

    /// `logout`: tell the server (best effort), then clear locally regardless.
    pub async fn logout(&self) -> Result<(), ApiError> {
        if let Some(tokens) = self.api.tokens().load().await? {
            let outcome = async {
                let body = json_body(&LogoutBody {
                    refresh_token: &tokens.refresh_token,
                })?;
                self.api
                    .api::<serde_json::Value>("/v1/auth/logout", &RequestOptions::post(Some(body)))
                    .await
            }
            .await;
            drop(outcome);
        }
        self.api.tokens().clear().await?;
        (self.env.clear_workspace_time)();
        Ok(())
    }

    /// `isLoggedIn` / `ensureSession`: validate the saved session. `api()`
    /// rotates the refresh token on a 401, so a valid refresh token keeps the
    /// user signed in across restarts. Anything but a definite
    /// `UnauthorizedError` keeps the cached login state.
    pub async fn ensure_session(&self) -> Result<bool, ApiError> {
        if self.api.tokens().load().await?.is_none() {
            return Ok(false);
        }
        match self
            .api
            .api::<serde_json::Value>("/v1/auth/me", &RequestOptions::get())
            .await
        {
            Ok(_) => Ok(true),
            Err(err) if err.is_unauthorized() => Ok(false),
            Err(err) => {
                tracing::warn!(err = %err, "session validation failed; keeping cached login state");
                Ok(true)
            }
        }
    }
}

fn is_hard_expired(created_at: i64, now: i64) -> bool {
    now.saturating_sub(created_at) >= LARK_LOGIN_HARD_TTL_MS
}
