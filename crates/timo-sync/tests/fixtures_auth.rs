//! `auth.ts` parity: random sequences of start / redeem / cancel / password
//! login run through the REAL TypeScript and through the Rust service with the
//! same clock and the same 48 random bytes; the login URL, the PKCE verifier,
//! the stored pending login, the requests, the saved sessions and the results
//! must agree after every op.
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

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use support::{MockServer, Reply, fixture, s};
use timo_sync::auth::{AuthEnv, AuthService};
use timo_sync::pending_login::MemoryPendingLoginStore;
use timo_sync::tokens::{MemoryTokenStore, StoredTokens, TokenError, TokenStore};
use timo_sync::{ApiClient, CallbackScheme, ClientConfig, Platform};

/// A token store that also remembers what was saved, like `syncTokenStore.ts`.
#[derive(Default)]
struct Recording {
    inner: MemoryTokenStore,
    saved: Mutex<Vec<StoredTokens>>,
}

impl TokenStore for Recording {
    async fn load(&self) -> Result<Option<StoredTokens>, TokenError> {
        self.inner.load().await
    }
    async fn save(&self, tokens: StoredTokens) -> Result<(), TokenError> {
        self.saved.lock().unwrap().push(tokens.clone());
        self.inner.save(tokens).await
    }
    async fn replace_if_match(
        &self,
        e: &StoredTokens,
        n: StoredTokens,
    ) -> Result<bool, TokenError> {
        self.inner.replace_if_match(e, n).await
    }
    async fn clear(&self) -> Result<(), TokenError> {
        self.inner.clear().await
    }
    async fn clear_if_match(&self, e: &StoredTokens) -> Result<bool, TokenError> {
        self.inner.clear_if_match(e).await
    }
}

struct World {
    clock: Arc<AtomicI64>,
    random: Arc<Mutex<Vec<Vec<u8>>>>,
    opened: Arc<Mutex<Vec<String>>>,
    open_fails: Arc<AtomicBool>,
    workspace_clears: Arc<AtomicUsize>,
}

impl World {
    fn env(&self) -> AuthEnv {
        let (clock, random, opened, fails, clears) = (
            Arc::clone(&self.clock),
            Arc::clone(&self.random),
            Arc::clone(&self.opened),
            Arc::clone(&self.open_fails),
            Arc::clone(&self.workspace_clears),
        );
        AuthEnv {
            now_ms: Box::new(move || clock.load(Ordering::SeqCst)),
            random_fill: Box::new(move |bytes| {
                let next = random.lock().unwrap().remove(0);
                bytes.copy_from_slice(&next);
            }),
            open_external: Box::new(move |url| {
                opened.lock().unwrap().push(url);
                let fail = fails.load(Ordering::SeqCst);
                Box::pin(async move { if fail { Err("boom".to_owned()) } else { Ok(()) } })
            }),
            clear_workspace_time: Box::new(move || {
                clears.fetch_add(1, Ordering::SeqCst);
            }),
        }
    }
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn config(input: &Value, platform: Platform, hostname: &str) -> ClientConfig {
    let mut config = ClientConfig::local_default();
    config.api_url = s(&input["apiUrl"]);
    config.callback_scheme = if input["scheme"] == "grind" {
        CallbackScheme::Grind
    } else {
        CallbackScheme::Timo
    };
    config.platform = platform;
    hostname.clone_into(&mut config.hostname);
    config
}

fn platform(v: &Value) -> Platform {
    match s(v).as_str() {
        "darwin" => Platform::Darwin,
        "win32" => Platform::Win32,
        _ => Platform::Linux,
    }
}

#[tokio::test]
async fn the_auth_flow_matches_the_typescript_after_every_op() {
    let cases = fixture("auth", "flow");
    let (mut starts, mut logins, mut completes) = (0, 0, 0);
    for (i, case) in cases.iter().enumerate() {
        let input = &case.input;
        let reply: Arc<Mutex<Option<String>>> = Arc::default();
        let responder = Arc::clone(&reply);
        let server = MockServer::start(move |_, _| {
            Reply::json(200, responder.lock().unwrap().as_deref().unwrap_or("{}"))
        })
        .await;
        let tokens = Arc::new(Recording::default());
        let api = Arc::new(ApiClient::new(&server.base, Arc::clone(&tokens)).unwrap());
        let pending = Arc::new(MemoryPendingLoginStore::new(None));
        let world = World {
            clock: Arc::new(AtomicI64::new(0)),
            random: Arc::new(Mutex::new(
                input["random"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|h| hex(&s(h)))
                    .collect(),
            )),
            opened: Arc::default(),
            open_fails: Arc::default(),
            workspace_clears: Arc::default(),
        };
        let main = AuthService::new(
            Arc::clone(&api),
            config(input, Platform::Darwin, "h"),
            Arc::clone(&pending),
            world.env(),
        );
        let ops = input["ops"].as_array().unwrap();
        for (n, op) in ops.iter().enumerate() {
            let at = format!("case {i} op {n} ({})", op["op"]);
            world
                .clock
                .store(op["now"].as_i64().unwrap(), Ordering::SeqCst);
            let (sent, opened, saved) = (
                server.count(),
                world.opened.lock().unwrap().len(),
                tokens.saved.lock().unwrap().len(),
            );
            let result: Value = match s(&op["op"]).as_str() {
                "start" => {
                    starts += 1;
                    world
                        .open_fails
                        .store(op["openFails"].as_bool().unwrap(), Ordering::SeqCst);
                    main.start_lark_login()
                        .await
                        .map_or_else(|e| json!({"error": e.message()}), |()| json!("ok"))
                }
                "complete" => {
                    completes += 1;
                    *reply.lock().unwrap() = Some(op["response"].to_string());
                    main.complete_lark_login(&s(&op["code"]))
                        .await
                        .map_or_else(|e| json!({"error": e.message()}), Value::Bool)
                }
                "cancel" => {
                    main.cancel_lark_login();
                    for _ in 0..4 {
                        tokio::task::yield_now().await;
                    }
                    json!("ok")
                }
                _ => {
                    logins += 1;
                    *reply.lock().unwrap() = Some(op["response"].to_string());
                    let cfg = config(input, platform(&op["platform"]), &s(&op["hostname"]));
                    let svc =
                        AuthService::new(Arc::clone(&api), cfg, Arc::clone(&pending), world.env());
                    svc.login(&s(&op["email"]), &s(&op["password"]))
                        .await
                        .unwrap_or_else(|e| json!({"error": e.message()}))
                }
            };
            let want = &case.output["effects"][n];
            assert_eq!(result, want["result"], "{at}: result");
            let api_calls: Vec<Value> = server.requests()[sent..]
                .iter()
                .map(|r| json!({"path": r.path, "method": r.method, "bodyText": r.body}))
                .collect();
            let want_calls: Vec<Value> = want["api"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| json!({"path": c["path"], "method": c["method"], "bodyText": c["bodyText"]}))
                .collect();
            assert_eq!(api_calls, want_calls, "{at}: requests");
            for request in &server.requests()[sent..] {
                assert!(
                    request.header("authorization").is_none(),
                    "{at}: auth:false sends no token"
                );
            }
            assert_eq!(
                json!(world.opened.lock().unwrap()[opened..].to_vec()),
                want["opened"],
                "{at}: opened"
            );
            let saved_now: Vec<Value> = tokens.saved.lock().unwrap()[saved..]
                .iter()
                .map(|t| json!({"accessToken": t.access_token, "refreshToken": t.refresh_token, "userId": t.user_id, "workspaceId": t.workspace_id}))
                .collect();
            assert_eq!(json!(saved_now), want["saved"], "{at}: saved tokens");
            let stored = pending.peek().await.map_or(Value::Null, |p| json!({"verifier": p.verifier, "loginUrl": p.login_url, "createdAt": p.created_at}));
            assert_eq!(stored, want["pending"], "{at}: pending login");
            assert_eq!(
                world.workspace_clears.load(Ordering::SeqCst),
                usize::try_from(want["workspaceClears"].as_u64().unwrap()).unwrap(),
                "{at}: workspace resets"
            );
        }
    }
    assert!(
        cases.len() >= 500 && starts > 300 && logins > 100 && completes > 100,
        "{starts} starts, {completes} completes, {logins} logins"
    );
}
