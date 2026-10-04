//! Port of `legacy/agent/src/main/services/apiClient.test.ts` (7 tests), plus
//! the transport behaviour a mock `fetch` could not show: headers, single-flight,
//! timeouts, network errors. The server is a loopback socket; no real network.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::string_slice,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    reason = "test code: a failed assertion is the failure report"
)]

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use support::{MockServer, Reply, ScriptedTokens, tokens};
use timo_sync::tokens::{MemoryTokenStore, TokenStore};
use timo_sync::{ApiClient, ApiError, AuthStatus, RequestOptions};

#[derive(Deserialize, Debug, PartialEq)]
struct Value42 {
    value: i64,
}

fn client<S: TokenStore>(server: &MockServer, store: Arc<S>) -> ApiClient<S> {
    ApiClient::new(&server.base, store).expect("client")
}

fn auth_log<S: TokenStore>(
    api: &ApiClient<S>,
) -> (Arc<Mutex<Vec<AuthStatus>>>, timo_sync::Subscription) {
    let seen: Arc<Mutex<Vec<AuthStatus>>> = Arc::default();
    let sink = Arc::clone(&seen);
    let off = api.on_auth_change(move |s| sink.lock().expect("seen").push(s));
    (seen, off)
}

#[tokio::test]
async fn keeps_the_session_when_refresh_fails_transiently_5xx() {
    let server = MockServer::sequence(vec![
        Reply::json(401, r#"{"error":"expired"}"#),
        Reply::json(503, "busy"),
    ])
    .await;
    let store = ScriptedTokens::new(vec![], Some(tokens("a0", "r0")));
    let api = client(&server, Arc::clone(&store));
    let (seen, off) = auth_log(&api);

    let err = api
        .api::<serde_json::Value>("/v1/thing", &RequestOptions::get())
        .await
        .unwrap_err();

    assert!(matches!(err, ApiError::Http { status: 503, .. }), "{err}");
    assert_eq!(store.cleared(), 0);
    assert!(!seen.lock().unwrap().contains(&AuthStatus::LoggedOut));
    off.off();
}

#[tokio::test]
async fn signs_out_only_when_refresh_is_definitively_rejected_401() {
    let server = MockServer::sequence(vec![
        Reply::json(401, r#"{"error":"expired"}"#),
        Reply::json(401, r#"{"error":"invalid_refresh"}"#),
    ])
    .await;
    let store = ScriptedTokens::new(vec![], Some(tokens("a0", "r0")));
    let api = client(&server, Arc::clone(&store));
    let (seen, off) = auth_log(&api);

    let err = api
        .api::<serde_json::Value>("/v1/thing", &RequestOptions::get())
        .await
        .unwrap_err();

    assert!(err.is_unauthorized(), "{err}");
    assert_eq!(store.cleared(), 1);
    assert!(seen.lock().unwrap().contains(&AuthStatus::LoggedOut));
    off.off();
}

#[tokio::test]
async fn rotates_on_401_then_retries_returning_the_retried_response() {
    let server = MockServer::sequence(vec![
        Reply::json(401, r#"{"error":"expired"}"#),
        Reply::json(200, r#"{"accessToken":"a1","refreshToken":"r1"}"#),
        Reply::json(200, r#"{"value":42}"#),
    ])
    .await;
    let store = ScriptedTokens::new(vec![], Some(tokens("a0", "r0")));
    let api = client(&server, Arc::clone(&store));

    let got: Value42 = api.api("/v1/thing", &RequestOptions::get()).await.unwrap();

    assert_eq!(got, Value42 { value: 42 });
    let replaced = store.replaced.lock().unwrap().clone();
    assert_eq!(replaced.len(), 1);
    assert_eq!(replaced[0].0, tokens("a0", "r0"));
    assert_eq!(
        (
            replaced[0].1.access_token.as_str(),
            replaced[0].1.refresh_token.as_str()
        ),
        ("a1", "r1")
    );
}

#[tokio::test]
async fn uses_newer_stored_tokens_instead_of_refreshing_a_stale_token() {
    let server = MockServer::sequence(vec![
        Reply::json(401, r#"{"error":"expired"}"#),
        Reply::json(200, r#"{"value":42}"#),
    ])
    .await;
    let store = ScriptedTokens::new(
        vec![Some(tokens("a0", "r0")), Some(tokens("a1", "r1"))],
        None,
    );
    let api = client(&server, Arc::clone(&store));

    let got: Value42 = api.api("/v1/thing", &RequestOptions::get()).await.unwrap();

    assert_eq!(got.value, 42);
    assert_eq!(server.count(), 2);
    assert_eq!(
        server.requests()[1].header("authorization"),
        Some("Bearer a1")
    );
    assert!(store.replaced.lock().unwrap().is_empty());
    assert_eq!(store.cleared(), 0);
}

#[tokio::test]
async fn recovers_reuse_grace_by_reloading_newer_stored_tokens() {
    let server = MockServer::sequence(vec![
        Reply::json(401, r#"{"error":"expired"}"#),
        Reply::json(
            409,
            r#"{"error":"refresh_reuse_grace","reason":"reuse_grace"}"#,
        ),
        Reply::json(200, r#"{"value":42}"#),
    ])
    .await;
    let store = ScriptedTokens::new(
        vec![
            Some(tokens("a0", "r0")),
            Some(tokens("a0", "r0")),
            Some(tokens("a1", "r1")),
        ],
        None,
    );
    let api = client(&server, Arc::clone(&store));

    let got: Value42 = api.api("/v1/thing", &RequestOptions::get()).await.unwrap();

    assert_eq!(got.value, 42);
    assert_eq!(store.cleared(), 0);
}

#[tokio::test]
async fn does_not_clear_tokens_when_reuse_grace_has_no_newer_local_token() {
    let server = MockServer::sequence(vec![
        Reply::json(401, r#"{"error":"expired"}"#),
        Reply::json(
            409,
            r#"{"error":"refresh_reuse_grace","reason":"reuse_grace"}"#,
        ),
    ])
    .await;
    let store = ScriptedTokens::new(vec![], Some(tokens("a0", "r0")));
    let api = client(&server, Arc::clone(&store));

    let err = api
        .api::<serde_json::Value>("/v1/thing", &RequestOptions::get())
        .await
        .unwrap_err();

    assert!(matches!(err, ApiError::Http { .. }), "{err}");
    assert_eq!(store.cleared(), 0);
}

#[tokio::test]
async fn does_not_clear_a_newer_login_if_a_stale_refresh_is_terminally_rejected() {
    let server = MockServer::sequence(vec![
        Reply::json(401, r#"{"error":"expired"}"#),
        Reply::json(401, r#"{"error":"invalid_refresh","reason":"reuse"}"#),
        Reply::json(200, r#"{"value":42}"#),
    ])
    .await;
    let store = ScriptedTokens::new(
        vec![
            Some(tokens("a0", "r0")),
            Some(tokens("a0", "r0")),
            Some(tokens("a1", "r1")),
        ],
        None,
    );
    let api = client(&server, Arc::clone(&store));

    let got: Value42 = api.api("/v1/thing", &RequestOptions::get()).await.unwrap();

    assert_eq!(got.value, 42);
    assert_eq!(store.cleared(), 0);
    assert_eq!(
        server.requests()[2].header("authorization"),
        Some("Bearer a1")
    );
}

// ---- behaviour the mock-`fetch` tests could not show (proof D) ----

#[tokio::test]
async fn sends_the_headers_and_body_apiclient_ts_sends() {
    let server = MockServer::sequence(vec![Reply::json(200, "{}"), Reply::json(200, "{}")]).await;
    let api = client(
        &server,
        Arc::new(MemoryTokenStore::new(Some(tokens("tok", "r")))),
    );

    api.api::<serde_json::Value>("/v1/a", &RequestOptions::get())
        .await
        .unwrap();
    api.api::<serde_json::Value>(
        "/v1/b",
        &RequestOptions::post(Some(r#"{"x":1}"#.to_owned())).without_auth(),
    )
    .await
    .unwrap();

    let seen = server.requests();
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("GET", "/v1/a")
    );
    assert_eq!(seen[0].header("content-type"), Some("application/json"));
    assert_eq!(seen[0].header("ngrok-skip-browser-warning"), Some("true"));
    assert_eq!(seen[0].header("authorization"), Some("Bearer tok"));
    assert_eq!(seen[0].body, "");
    assert_eq!(
        seen[1].header("authorization"),
        None,
        "auth:false sends no token"
    );
    assert_eq!(seen[1].body, r#"{"x":1}"#);
}

#[tokio::test]
async fn no_tokens_is_unauthorized_before_any_request() {
    let server = MockServer::sequence(vec![]).await;
    let api = client(&server, Arc::new(MemoryTokenStore::new(None)));

    let err = api
        .api::<serde_json::Value>("/v1/a", &RequestOptions::get())
        .await
        .unwrap_err();

    assert_eq!(err.to_string(), "UnauthorizedError: no_tokens");
    assert_eq!(server.count(), 0);
}

#[tokio::test]
async fn http_error_text_matches_string_of_the_js_error() {
    let server = MockServer::sequence(vec![Reply::json(409, "reauth please")]).await;
    let api = client(
        &server,
        Arc::new(MemoryTokenStore::new(Some(tokens("t", "r")))),
    );

    let err = api
        .api::<serde_json::Value>("/v1/lark/tasks", &RequestOptions::get())
        .await
        .unwrap_err();

    assert_eq!(
        err.to_string(),
        "HttpError: /v1/lark/tasks 409: reauth please"
    );
    assert_eq!(err.message(), "/v1/lark/tasks 409: reauth please");
    assert!(err.to_string().contains("409"));
}

#[tokio::test]
async fn a_401_with_auth_false_is_a_plain_http_error_and_never_refreshes() {
    let server = MockServer::sequence(vec![Reply::json(401, "nope")]).await;
    let store = ScriptedTokens::new(vec![], Some(tokens("a0", "r0")));
    let api = client(&server, Arc::clone(&store));

    let err = api
        .api::<serde_json::Value>("/v1/auth/login", &RequestOptions::post(None).without_auth())
        .await
        .unwrap_err();

    assert!(matches!(err, ApiError::Http { status: 401, .. }));
    assert_eq!(server.count(), 1);
    assert_eq!(store.cleared(), 0);
}

#[tokio::test]
async fn concurrent_401s_share_one_refresh() {
    // Both requests 401, ONE refresh (the token is single-use), both retried.
    let server = MockServer::start(|_, req| match req.path.as_str() {
        "/v1/auth/refresh" => Reply::json(200, r#"{"accessToken":"a1","refreshToken":"r1"}"#)
            .after(Duration::from_millis(150)),
        _ if req.header("authorization") == Some("Bearer a1") => {
            Reply::json(200, r#"{"value":42}"#)
        }
        _ => Reply::json(401, r#"{"error":"expired"}"#),
    })
    .await;
    let store = Arc::new(MemoryTokenStore::new(Some(tokens("a0", "r0"))));
    let api = client(&server, Arc::clone(&store));

    let options = RequestOptions::get();
    let (one, two) = tokio::join!(
        api.api::<Value42>("/v1/one", &options),
        api.api::<Value42>("/v1/two", &options)
    );

    assert_eq!(one.unwrap().value, 42);
    assert_eq!(two.unwrap().value, 42);
    let refreshes = server
        .paths()
        .iter()
        .filter(|p| *p == "/v1/auth/refresh")
        .count();
    assert_eq!(refreshes, 1, "{:?}", server.paths());
    assert_eq!(store.load().await.unwrap().unwrap().refresh_token, "r1");
}

#[tokio::test]
async fn a_request_still_rejected_after_one_refresh_fails_without_a_second_refresh() {
    let refreshes = Arc::new(Mutex::new(0_usize));
    let counter = Arc::clone(&refreshes);
    let server = MockServer::start(move |_, req| {
        if req.path == "/v1/auth/refresh" {
            let mut n = counter.lock().unwrap();
            *n += 1;
            return Reply::json(
                200,
                &format!(r#"{{"accessToken":"a{n}","refreshToken":"r{n}"}}"#, n = *n),
            );
        }
        // Only the freshest access token (a2) is accepted.
        if req.header("authorization") == Some("Bearer a2") {
            Reply::json(200, r#"{"value":42}"#)
        } else {
            Reply::json(401, "{}")
        }
    })
    .await;
    let api = client(
        &server,
        Arc::new(MemoryTokenStore::new(Some(tokens("a0", "r0")))),
    );

    // a0 -> 401 -> refresh -> a1 -> 401 again (second request) -> clear + error
    let first = api.api::<Value42>("/v1/x", &RequestOptions::get()).await;
    assert!(first.is_err());
    assert_eq!(*refreshes.lock().unwrap(), 1);
}

#[tokio::test]
async fn a_timeout_is_a_timeout_error_not_an_http_error() {
    let server =
        MockServer::sequence(vec![Reply::json(200, "{}").after(Duration::from_secs(5))]).await;
    let api = client(
        &server,
        Arc::new(MemoryTokenStore::new(Some(tokens("t", "r")))),
    );
    let options = RequestOptions::get().with_timeout_ms(120);

    let started = std::time::Instant::now();
    let err = api
        .api::<serde_json::Value>("/v1/slow", &options)
        .await
        .unwrap_err();

    assert!(matches!(err, ApiError::Timeout), "{err}");
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn without_a_timeout_a_slow_answer_is_waited_for() {
    let server = MockServer::sequence(vec![
        Reply::json(200, r#"{"value":42}"#).after(Duration::from_millis(300)),
    ])
    .await;
    let api = client(
        &server,
        Arc::new(MemoryTokenStore::new(Some(tokens("t", "r")))),
    );

    let got: Value42 = api.api("/v1/slow", &RequestOptions::get()).await.unwrap();

    assert_eq!(got.value, 42);
}

#[tokio::test]
async fn a_network_error_during_refresh_propagates_and_keeps_the_tokens() {
    let server = MockServer::sequence(vec![Reply::json(401, "{}"), Reply::dropped()]).await;
    let store = ScriptedTokens::new(vec![], Some(tokens("a0", "r0")));
    let api = client(&server, Arc::clone(&store));

    let err = api
        .api::<serde_json::Value>("/v1/x", &RequestOptions::get())
        .await
        .unwrap_err();

    assert!(matches!(err, ApiError::Network(_)), "{err}");
    assert_eq!(store.cleared(), 0);
}

#[tokio::test]
async fn a_2xx_body_that_is_not_json_is_a_syntax_error() {
    let server = MockServer::sequence(vec![Reply::json(200, "<html>")]).await;
    let api = client(
        &server,
        Arc::new(MemoryTokenStore::new(Some(tokens("t", "r")))),
    );

    let err = api
        .api::<serde_json::Value>("/v1/x", &RequestOptions::get())
        .await
        .unwrap_err();

    assert!(matches!(err, ApiError::Syntax(_)), "{err}");
}

#[tokio::test]
async fn a_second_401_after_refresh_clears_only_the_refreshed_session() {
    let server = MockServer::start(|_, req| {
        if req.path == "/v1/auth/refresh" {
            Reply::json(200, r#"{"accessToken":"a1","refreshToken":"r1"}"#)
        } else {
            Reply::json(401, "{}")
        }
    })
    .await;
    let store = Arc::new(MemoryTokenStore::new(Some(tokens("a0", "r0"))));
    let api = client(&server, Arc::clone(&store));
    let (seen, off) = auth_log(&api);

    let err = api
        .api::<serde_json::Value>("/v1/x", &RequestOptions::get())
        .await
        .unwrap_err();

    assert!(matches!(err, ApiError::Http { status: 401, .. }), "{err}");
    assert!(
        store.load().await.unwrap().is_none(),
        "the rejected refreshed session is removed"
    );
    assert_eq!(seen.lock().unwrap().as_slice(), &[AuthStatus::LoggedOut]);
    off.off();
}
