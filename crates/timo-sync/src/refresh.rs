//! The token refresh half of `apiClient.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::ApiClient;
use crate::error::ApiError;
use crate::http::{RawResponse, RequestOptions};
use crate::tokens::{StoredTokens, TokenStore};
use crate::wire::json_body;

/// Port of `apiClient.ts::RefreshOutcome`. A refusal is DEFINITIVE (`terminal`:
/// the refresh answered 401, the token is dead) or TRANSIENT (5xx, 429: keep the
/// session and try later). A thrown network error is likewise transient: it
/// propagates as `Err` and never signs out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshOutcome {
    Refreshed(StoredTokens),
    Refused { terminal: bool },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshBody<'a> {
    refresh_token: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshData {
    access_token: String,
    refresh_token: String,
}

/// Port of `apiClient.ts::refreshFailureReason`: `body.reason`, else
/// `body.error`, when a string; any unreadable body is `null`.
fn failure_reason(res: &RawResponse) -> Option<String> {
    let body: Value = res.json().ok()?;
    let object = body.as_object()?;
    for key in ["reason", "error"] {
        if let Some(Value::String(text)) = object.get(key) {
            return Some(text.clone());
        }
    }
    None
}

impl<S: TokenStore> ApiClient<S> {
    /// Port of `apiClient.ts::refreshTokens`.
    pub(crate) async fn refresh_tokens(
        &self,
        current: &StoredTokens,
    ) -> Result<RefreshOutcome, ApiError> {
        let body = json_body(&RefreshBody {
            refresh_token: &current.refresh_token,
        })?;
        let options = RequestOptions::post(Some(body)).without_auth();
        let res = self
            .transport()
            .fetch("/v1/auth/refresh", &options, None)
            .await?;
        if !res.ok() {
            return self.refresh_refused(current, &res).await;
        }
        let data: RefreshData = res.json()?;
        let next = StoredTokens {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            ..current.clone()
        };
        if self
            .tokens()
            .replace_if_match(current, next.clone())
            .await?
        {
            return Ok(RefreshOutcome::Refreshed(next));
        }
        if let Some(latest) = self.tokens().load().await? {
            tracing::info!("refresh result discarded because the stored session changed");
            return Ok(RefreshOutcome::Refreshed(latest));
        }
        Ok(RefreshOutcome::Refused { terminal: true })
    }

    async fn refresh_refused(
        &self,
        current: &StoredTokens,
        res: &RawResponse,
    ) -> Result<RefreshOutcome, ApiError> {
        let reason = failure_reason(res);
        tracing::warn!(status = res.status, reason = ?reason, "refresh failed");
        if res.status == 409
            && reason.as_deref() == Some("reuse_grace")
            && let Some(latest) = self.load_newer(current).await?
        {
            tracing::info!("refresh recovered with newer stored tokens after reuse grace");
            return Ok(RefreshOutcome::Refreshed(latest));
        }
        Ok(RefreshOutcome::Refused {
            terminal: res.status == 401,
        })
    }
}
