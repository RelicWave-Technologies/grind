//! Port of `legacy/agent/src/main/services/auth.test.ts` (8 tests) plus login,
//! logout and `ensureSession`. `api()` is real here and talks to a loopback
//! server, so the exchange request itself is asserted, not a mock call.
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

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use support::{MockServer, Reply, tokens};
use timo_sync::auth::{AuthEnv, AuthService, LARK_LOGIN_HARD_TTL_MS, LARK_LOGIN_REUSE_TTL_MS};
use timo_sync::pending_login::{MemoryPendingLoginStore, StoredPendingLarkLogin};
use timo_sync::tokens::{MemoryTokenStore, TokenStore};
use timo_sync::{ApiClient, ClientConfig};

const BASE_TIME: i64 = 1_783_036_800_000; // 2026-07-03T00:00:00.000Z

struct Harness {
    service: AuthService<MemoryTokenStore, MemoryPendingLoginStore>,
    tokens: Arc<MemoryTokenStore>,
    pending: Arc<MemoryPendingLoginStore>,
    clock: Arc<AtomicI64>,
    opened: Arc<Mutex<Vec<String>>>,
    workspace_clears: Arc<AtomicUsize>,
    server: MockServer,
}

struct Options {
    open_fails_first: bool,
    stored: Option<StoredPendingLarkLogin>,
    replies: Vec<Reply>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            open_fails_first: false,
            stored: None,
            replies: vec![Reply::json(
                200,
                r#"{"accessToken":"at","refreshToken":"rt","userId":"user_1","workspaceId":"ws_1"}"#,
            )],
        }
    }
}

async fn harness(options: Options) -> Harness {
    let server = MockServer::sequence(options.replies).await;
    let tokens = Arc::new(MemoryTokenStore::new(None));
    let api = Arc::new(ApiClient::new(&server.base, Arc::clone(&tokens)).unwrap());
    let pending = Arc::new(MemoryPendingLoginStore::new(options.stored));
    let clock = Arc::new(AtomicI64::new(BASE_TIME));
    let opened: Arc<Mutex<Vec<String>>> = Arc::default();
    let workspace_clears = Arc::new(AtomicUsize::new(0));
    let (now, urls, wipes) = (
        Arc::clone(&clock),
        Arc::clone(&opened),
        Arc::clone(&workspace_clears),
    );
    let fail_first = Arc::new(AtomicUsize::new(usize::from(options.open_fails_first)));
    let env = AuthEnv {
        now_ms: Box::new(move || now.load(Ordering::SeqCst)),
        random_fill: Box::new(|bytes| getrandom::fill(bytes).unwrap()),
        open_external: Box::new(move |url| {
            urls.lock().unwrap().push(url);
            let fail = fail_first
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok();
            Box::pin(async move { if fail { Err("boom".to_owned()) } else { Ok(()) } })
        }),
        clear_workspace_time: Box::new(move || {
            wipes.fetch_add(1, Ordering::SeqCst);
        }),
    };
    let mut config = ClientConfig::local_default();
    config.api_url.clone_from(&server.base);
    "host".clone_into(&mut config.hostname);
    let service = AuthService::new(api, config, Arc::clone(&pending), env);
    Harness {
        service,
        tokens,
        pending,
        clock,
        opened,
        workspace_clears,
        server,
    }
}

fn query(url: &str) -> Vec<(String, String)> {
    let (_, q) = url.split_once('?').expect("query");
    q.split('&')
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
}

fn param(url: &str, key: &str) -> String {
    query(url)
        .into_iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v)
        .expect("param")
}

fn is_b64url(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[tokio::test]
async fn opens_a_lark_login_url_with_the_agent_client_callback_scheme_and_pkce_challenge() {
    let h = harness(Options::default()).await;

    h.service.start_lark_login().await.unwrap();

    let opened = h.opened.lock().unwrap().clone();
    assert_eq!(opened.len(), 1);
    let url = &opened[0];
    assert!(
        url.starts_with(&format!("{}/v1/auth/lark/start?", h.server.base)),
        "{url}"
    );
    assert_eq!(param(url, "client"), "agent");
    assert_eq!(param(url, "callback_scheme"), "timo");
    assert!(is_b64url(&param(url, "code_challenge"), 43));
    let stored = h.pending.peek().await.expect("stored");
    assert!(is_b64url(&stored.verifier, 64));
    assert_eq!(&stored.login_url, url);
    assert_eq!(stored.created_at, BASE_TIME);
    // The challenge is sha256(verifier) in base64url, as the API checks.
    let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(stored.verifier.as_bytes()));
    assert_eq!(param(url, "code_challenge"), expected);
}

#[tokio::test]
async fn reuses_a_pending_login_url_before_the_reuse_ttl() {
    let h = harness(Options::default()).await;
    h.service.start_lark_login().await.unwrap();
    let first = h.opened.lock().unwrap()[0].clone();

    h.clock
        .store(BASE_TIME + LARK_LOGIN_REUSE_TTL_MS - 1, Ordering::SeqCst);
    h.service.start_lark_login().await.unwrap();

    let opened = h.opened.lock().unwrap().clone();
    assert_eq!(opened.len(), 2);
    assert_eq!(opened[1], first);
}

#[tokio::test]
async fn regenerates_the_login_url_once_the_reuse_ttl_has_elapsed() {
    let h = harness(Options::default()).await;
    h.service.start_lark_login().await.unwrap();
    let first = param(&h.opened.lock().unwrap()[0], "code_challenge");

    h.clock
        .store(BASE_TIME + LARK_LOGIN_REUSE_TTL_MS, Ordering::SeqCst);
    h.service.start_lark_login().await.unwrap();

    let opened = h.opened.lock().unwrap().clone();
    assert_eq!(opened.len(), 2);
    assert_ne!(param(&opened[1], "code_challenge"), first);
}

#[tokio::test]
async fn does_not_redeem_a_hard_expired_pending_verifier() {
    let h = harness(Options::default()).await;
    h.service.start_lark_login().await.unwrap();
    h.clock
        .store(BASE_TIME + LARK_LOGIN_HARD_TTL_MS, Ordering::SeqCst);

    assert!(!h.service.complete_lark_login("agent-code").await.unwrap());

    assert_eq!(h.server.count(), 0, "no request to the API");
    assert!(h.tokens.load().await.unwrap().is_none());
    assert!(
        h.pending.peek().await.is_none(),
        "the expired verifier is wiped"
    );
}

#[tokio::test]
async fn clears_pending_state_when_the_browser_cannot_be_opened() {
    let h = harness(Options {
        open_fails_first: true,
        ..Options::default()
    })
    .await;

    let err = h.service.start_lark_login().await.unwrap_err();
    assert_eq!(err.message(), "boom");
    let failed = param(&h.opened.lock().unwrap()[0], "code_challenge");

    h.service.start_lark_login().await.unwrap();

    assert_ne!(
        param(&h.opened.lock().unwrap()[1], "code_challenge"),
        failed
    );
}

#[tokio::test]
async fn clears_pending_state_when_login_is_cancelled() {
    let h = harness(Options::default()).await;
    h.service.start_lark_login().await.unwrap();
    let first = param(&h.opened.lock().unwrap()[0], "code_challenge");

    h.service.cancel_lark_login();
    h.service.start_lark_login().await.unwrap();

    assert_ne!(param(&h.opened.lock().unwrap()[1], "code_challenge"), first);
}

#[tokio::test]
async fn redeems_a_non_expired_deep_link_code_with_the_pending_verifier_and_stores_tokens() {
    let h = harness(Options::default()).await;
    h.service.start_lark_login().await.unwrap();
    let verifier = h.pending.peek().await.unwrap().verifier;

    assert!(h.service.complete_lark_login("agent-code").await.unwrap());

    let request = &h.server.requests()[0];
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/v1/auth/lark/exchange")
    );
    assert_eq!(
        request.body,
        format!(r#"{{"code":"agent-code","codeVerifier":"{verifier}"}}"#)
    );
    assert_eq!(request.header("authorization"), None);
    assert_eq!(
        h.tokens.load().await.unwrap(),
        Some(timo_sync::tokens::StoredTokens {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            user_id: "user_1".into(),
            workspace_id: "ws_1".into(),
        })
    );
    assert!(h.pending.peek().await.is_none());
    assert_eq!(h.workspace_clears.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn redeems_a_deep_link_code_after_app_relaunch_by_hydrating_the_stored_verifier() {
    let first = harness(Options::default()).await;
    first.service.start_lark_login().await.unwrap();
    let stored = first.pending.peek().await.unwrap();

    let relaunched = harness(Options {
        stored: Some(stored.clone()),
        ..Options::default()
    })
    .await;
    relaunched.clock.store(BASE_TIME + 1_000, Ordering::SeqCst);

    assert!(
        relaunched
            .service
            .complete_lark_login("agent-code")
            .await
            .unwrap()
    );

    let request = &relaunched.server.requests()[0];
    assert_eq!(
        request.body,
        format!(
            r#"{{"code":"agent-code","codeVerifier":"{}"}}"#,
            stored.verifier
        )
    );
}

#[tokio::test]
async fn a_stray_deep_link_with_no_login_in_progress_is_ignored() {
    let h = harness(Options::default()).await;

    assert!(!h.service.complete_lark_login("replayed").await.unwrap());

    assert_eq!(h.server.count(), 0);
}

#[tokio::test]
async fn password_login_sends_the_device_name_and_stores_the_session() {
    let h = harness(Options {
        replies: vec![Reply::json(
            200,
            r#"{"accessToken":"at","refreshToken":"rt","user":{"id":"u1","workspaceId":"w1","name":"Asha"}}"#,
        )],
        ..Options::default()
    })
    .await;

    let user = h.service.login("a@b.co", "pw").await.unwrap();

    let request = &h.server.requests()[0];
    assert_eq!(request.path, "/v1/auth/login");
    let platform = timo_sync::Platform::current().as_str();
    assert_eq!(
        request.body,
        format!(r#"{{"email":"a@b.co","password":"pw","deviceName":"host ({platform})"}}"#)
    );
    assert_eq!(user["name"], "Asha");
    let saved = h.tokens.load().await.unwrap().unwrap();
    assert_eq!(
        (saved.user_id.as_str(), saved.workspace_id.as_str()),
        ("u1", "w1")
    );
    assert_eq!(h.workspace_clears.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn logout_is_best_effort_and_always_clears_locally() {
    let h = harness(Options {
        replies: vec![Reply::json(500, "down")],
        ..Options::default()
    })
    .await;
    h.tokens.save(tokens("a", "r")).await.unwrap();

    h.service.logout().await.unwrap();

    let request = &h.server.requests()[0];
    assert_eq!(request.path, "/v1/auth/logout");
    assert_eq!(request.body, r#"{"refreshToken":"r"}"#);
    assert_eq!(request.header("authorization"), Some("Bearer a"));
    assert!(h.tokens.load().await.unwrap().is_none());
    assert_eq!(h.workspace_clears.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ensure_session_is_false_without_tokens_and_keeps_the_session_on_a_non_auth_error() {
    let h = harness(Options {
        replies: vec![Reply::json(500, "boom")],
        ..Options::default()
    })
    .await;
    assert!(!h.service.ensure_session().await.unwrap());
    assert_eq!(h.server.count(), 0);

    h.tokens.save(tokens("a", "r")).await.unwrap();
    assert!(
        h.service.ensure_session().await.unwrap(),
        "a server error keeps the cached login state"
    );
}

#[tokio::test]
async fn ensure_session_is_false_when_the_session_is_definitively_dead() {
    let h = harness(Options {
        replies: vec![
            Reply::json(401, "{}"),
            Reply::json(401, r#"{"error":"invalid_refresh"}"#),
        ],
        ..Options::default()
    })
    .await;
    h.tokens.save(tokens("a", "r")).await.unwrap();

    assert!(!h.service.ensure_session().await.unwrap());
    assert!(h.tokens.load().await.unwrap().is_none());
}
