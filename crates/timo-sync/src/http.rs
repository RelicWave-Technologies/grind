//! One HTTP round trip, as `apiClient.ts::rawFetch` makes it.

use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::error::ApiError;

/// `FetchOptions.method`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    const fn to_reqwest(self) -> reqwest::Method {
        match self {
            Self::Get => reqwest::Method::GET,
            Self::Post => reqwest::Method::POST,
            Self::Put => reqwest::Method::PUT,
            Self::Patch => reqwest::Method::PATCH,
            Self::Delete => reqwest::Method::DELETE,
        }
    }
}

/// Port of `apiClient.ts::FetchOptions`. `body` is already `JSON.stringify`
/// text, so the caller decides the bytes (see [`crate::wire::json_body`]).
#[derive(Debug, Clone)]
pub struct RequestOptions {
    pub method: Method,
    pub body: Option<String>,
    /// `auth: false` sends no token and never refreshes.
    pub auth: bool,
    /// `timeoutMs`; absent for almost every call, as in the TypeScript.
    pub timeout: Option<Duration>,
}

impl RequestOptions {
    #[must_use]
    pub const fn get() -> Self {
        Self {
            method: Method::Get,
            body: None,
            auth: true,
            timeout: None,
        }
    }

    #[must_use]
    pub const fn post(body: Option<String>) -> Self {
        Self {
            method: Method::Post,
            body,
            auth: true,
            timeout: None,
        }
    }

    #[must_use]
    pub const fn put(body: Option<String>) -> Self {
        Self {
            method: Method::Put,
            body,
            auth: true,
            timeout: None,
        }
    }

    #[must_use]
    pub const fn without_auth(mut self) -> Self {
        self.auth = false;
        self
    }

    #[must_use]
    pub const fn with_timeout_ms(mut self, ms: u64) -> Self {
        self.timeout = Some(Duration::from_millis(ms));
        self
    }
}

/// A `Response` whose body is already read (inside the timeout, as
/// `AbortSignal.timeout` also covers reading the body).
#[derive(Debug)]
pub struct RawResponse {
    pub status: u16,
    body: Result<Vec<u8>, ApiError>,
}

impl RawResponse {
    /// `res.ok`.
    #[must_use]
    pub const fn ok(&self) -> bool {
        self.status >= 200 && self.status < 300
    }

    /// `res.text().catch(() => '')`.
    #[must_use]
    pub fn text_or_empty(&self) -> String {
        self.body.as_ref().map_or_else(
            |_| String::new(),
            |b| String::from_utf8_lossy(b).into_owned(),
        )
    }

    /// `res.json()`: invalid JSON is a `SyntaxError`; valid JSON of the wrong
    /// shape is a [`ApiError::Shape`].
    pub fn json<T: DeserializeOwned>(&self) -> Result<T, ApiError> {
        let bytes = self.body.as_ref().map_err(Clone::clone)?;
        let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        serde_json::from_slice(bytes).map_err(|e| {
            if e.is_syntax() || e.is_eof() {
                ApiError::Syntax(e.to_string())
            } else {
                ApiError::Shape(e.to_string())
            }
        })
    }
}

/// The base URL plus a connection pool.
#[derive(Debug, Clone)]
pub struct Transport {
    client: reqwest::Client,
    base: String,
}

impl Transport {
    pub fn new(base: &str) -> Result<Self, ApiError> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| ApiError::Network(e.to_string()))?;
        Ok(Self {
            client,
            base: base.trim_end_matches('/').to_owned(),
        })
    }

    /// Port of `apiClient.ts::rawFetch`: JSON content type even on GET, the
    /// ngrok header, a bearer token only when one is supplied.
    pub async fn fetch(
        &self,
        path: &str,
        opts: &RequestOptions,
        access_token: Option<&str>,
    ) -> Result<RawResponse, ApiError> {
        let work = self.round_trip(path, opts, access_token);
        match opts.timeout.filter(|d| !d.is_zero()) {
            Some(limit) => tokio::time::timeout(limit, work)
                .await
                .map_err(|_| ApiError::Timeout)?,
            None => work.await,
        }
    }

    async fn round_trip(
        &self,
        path: &str,
        opts: &RequestOptions,
        access_token: Option<&str>,
    ) -> Result<RawResponse, ApiError> {
        let mut req = self
            .client
            .request(opts.method.to_reqwest(), format!("{}{path}", self.base))
            .header("Content-Type", "application/json")
            .header("ngrok-skip-browser-warning", "true");
        if let Some(token) = access_token.filter(|t| !t.is_empty()) {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        if let Some(body) = &opts.body {
            req = req.body(body.clone());
        }
        let response = req
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| ApiError::Network(e.to_string()));
        Ok(RawResponse { status, body })
    }

    /// The pool, for the one request that is not the Timo API (Cloudinary).
    #[must_use]
    pub const fn client(&self) -> &reqwest::Client {
        &self.client
    }
}
