//! Port of `legacy/agent/src/main/services/apiClient.ts::api`: the authed
//! request with the one-shot, single-flight refresh on a 401.
//!
//! There is no generic retry or backoff here, as in the TypeScript: all retry
//! policy lives in the callers (drains, uploader, lark sync).

use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use tokio::sync::OnceCell;

use crate::auth_events::{AuthListeners, AuthStatus, Subscription};
use crate::error::ApiError;
use crate::http::{RawResponse, RequestOptions, Transport};
use crate::refresh::RefreshOutcome;
use crate::tokens::{StoredTokens, TokenStore};

type Flight = Arc<OnceCell<Result<RefreshOutcome, ApiError>>>;

#[derive(Debug)]
pub struct ApiClient<S: TokenStore> {
    transport: Transport,
    tokens: Arc<S>,
    listeners: AuthListeners,
    /// `refreshInFlight`: concurrent 401s share ONE rotation. The refresh token
    /// is single-use with server-side reuse detection, so two parallel
    /// rotations would revoke the whole token family.
    flight: Mutex<Option<Flight>>,
}

impl<S: TokenStore> ApiClient<S> {
    pub fn new(base_url: &str, tokens: Arc<S>) -> Result<Self, ApiError> {
        Ok(Self {
            transport: Transport::new(base_url)?,
            tokens,
            listeners: AuthListeners::default(),
            flight: Mutex::new(None),
        })
    }

    pub(crate) const fn transport(&self) -> &Transport {
        &self.transport
    }

    pub(crate) fn tokens(&self) -> &S {
        &self.tokens
    }

    /// `onAuthChange(listener)`.
    pub fn on_auth_change(
        &self,
        listener: impl Fn(AuthStatus) + Send + Sync + 'static,
    ) -> Subscription {
        self.listeners.subscribe(listener)
    }

    /// `tokenChanged(a, b)` + `loadNewerTokens`: stored tokens whose refresh
    /// token differs from `current`'s.
    pub(crate) async fn load_newer(
        &self,
        current: &StoredTokens,
    ) -> Result<Option<StoredTokens>, ApiError> {
        let latest = self.tokens.load().await?;
        Ok(latest.filter(|l| l.refresh_token != current.refresh_token))
    }

    /// `clearTokensIfUnchanged`.
    async fn clear_if_unchanged(&self, current: &StoredTokens) -> Result<bool, ApiError> {
        if !self.tokens.clear_if_match(current).await? {
            tracing::info!("skipped logout because newer stored tokens exist");
            return Ok(false);
        }
        self.listeners.notify(AuthStatus::LoggedOut);
        Ok(true)
    }

    /// `retryWithNewerTokens`: `Ok(Some(value))` is `{recovered: true}`.
    async fn retry_with_newer<T: DeserializeOwned>(
        &self,
        path: &str,
        opts: &RequestOptions,
        current: &StoredTokens,
    ) -> Result<Option<T>, ApiError> {
        let Some(latest) = self.load_newer(current).await? else {
            return Ok(None);
        };
        let res = self
            .transport
            .fetch(path, opts, Some(&latest.access_token))
            .await?;
        if res.ok() {
            return res.json().map(Some);
        }
        if res.status == 401 {
            return Ok(None);
        }
        Err(http_error(path, &res))
    }

    /// `refreshTokensOnce`: the first caller refreshes, concurrent callers wait
    /// for and share its outcome; once settled, the next caller starts afresh.
    async fn refresh_once(&self, current: &StoredTokens) -> Result<RefreshOutcome, ApiError> {
        let cell: Flight = {
            let mut slot = self
                .flight
                .lock()
                .map_err(|_| ApiError::Token("refresh slot poisoned".to_owned()))?;
            Arc::clone(slot.get_or_insert_with(|| Arc::new(OnceCell::new())))
        };
        let outcome = cell
            .get_or_init(|| self.refresh_tokens(current))
            .await
            .clone();
        if let Ok(mut slot) = self.flight.lock()
            && slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cell))
        {
            *slot = None;
        }
        outcome
    }

    /// `api(path, opts)`.
    pub async fn api<T: DeserializeOwned>(
        &self,
        path: &str,
        opts: &RequestOptions,
    ) -> Result<T, ApiError> {
        let tokens = if opts.auth {
            self.tokens.load().await?
        } else {
            None
        };
        if opts.auth && tokens.is_none() {
            return Err(ApiError::Unauthorized("no_tokens".to_owned()));
        }
        let access = tokens.as_ref().map(|t| t.access_token.as_str());
        let first = self.transport.fetch(path, opts, access).await?;
        if first.status != 401 || !opts.auth {
            return finish(path, &first);
        }
        let tokens = tokens.ok_or_else(|| ApiError::Unauthorized("no_tokens".to_owned()))?;
        let refreshed = match self.load_newer(&tokens).await? {
            Some(newer) => RefreshOutcome::Refreshed(newer),
            None => self.refresh_once(&tokens).await?,
        };
        match refreshed {
            RefreshOutcome::Refused { terminal: true } => {
                self.sign_out_or_recover(path, opts, &tokens).await
            }
            RefreshOutcome::Refused { terminal: false } => Err(ApiError::Http {
                path: "/v1/auth/refresh".to_owned(),
                status: 503,
                body: "refresh_transient".to_owned(),
            }),
            RefreshOutcome::Refreshed(fresh) => self.retry_once(path, opts, &fresh).await,
        }
    }

    /// The `outcome.terminal` branch: only a definitive 401 from the refresh
    /// signs the user out, and only if the session on disk is still the one
    /// that was rejected.
    async fn sign_out_or_recover<T: DeserializeOwned>(
        &self,
        path: &str,
        opts: &RequestOptions,
        rejected: &StoredTokens,
    ) -> Result<T, ApiError> {
        if let Some(value) = self.retry_with_newer(path, opts, rejected).await? {
            return Ok(value);
        }
        self.clear_if_unchanged(rejected).await?;
        Err(ApiError::Unauthorized("refresh_failed".to_owned()))
    }

    /// The request retried with the refreshed session (`secondRes`).
    async fn retry_once<T: DeserializeOwned>(
        &self,
        path: &str,
        opts: &RequestOptions,
        fresh: &StoredTokens,
    ) -> Result<T, ApiError> {
        let second = self
            .transport
            .fetch(path, opts, Some(&fresh.access_token))
            .await?;
        if second.status == 401 {
            if let Some(value) = self.retry_with_newer(path, opts, fresh).await? {
                return Ok(value);
            }
            self.clear_if_unchanged(fresh).await?;
        }
        finish(path, &second)
    }
}

/// `throw new HttpError(path, status, await res.text().catch(() => ''))`.
fn http_error(path: &str, res: &RawResponse) -> ApiError {
    ApiError::Http {
        path: path.to_owned(),
        status: res.status,
        body: res.text_or_empty(),
    }
}

/// The shared tail: `!res.ok` throws `HttpError`, else `res.json()`.
fn finish<T: DeserializeOwned>(path: &str, res: &RawResponse) -> Result<T, ApiError> {
    if res.ok() {
        res.json()
    } else {
        Err(http_error(path, res))
    }
}
