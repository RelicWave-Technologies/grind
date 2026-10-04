//! Test support: a scripted HTTP server on a loopback socket (no real network),
//! and token stores that record what `apiClient` asks of them.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::string_slice,
    clippy::too_many_lines,
    reason = "each integration test uses a subset of these helpers; a failed assertion is the failure report"
)]

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use timo_sync::tokens::{StoredTokens, TokenError, TokenStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinSet;

/// What the server answers.
#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub body: String,
    pub delay: Duration,
    /// Close the socket without answering (a network error for the client).
    pub drop_connection: bool,
}

impl Reply {
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            body: body.to_owned(),
            delay: Duration::ZERO,
            drop_connection: false,
        }
    }

    pub fn after(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    pub fn dropped() -> Self {
        Self {
            drop_connection: true,
            ..Self::json(0, "")
        }
    }
}

/// One request as the server saw it. Header names are lower-cased.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

type Handler = dyn Fn(usize, &Recorded) -> Reply + Send + Sync;

pub struct MockServer {
    pub base: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    accept: tokio::task::JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

impl MockServer {
    pub async fn start(
        handler: impl Fn(usize, &Recorded) -> Reply + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let base = format!("http://{}", listener.local_addr().expect("local addr"));
        let requests: Arc<Mutex<Vec<Recorded>>> = Arc::default();
        let handler: Arc<Handler> = Arc::new(handler);
        let seen = Arc::clone(&requests);
        let accept = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let (seen, handler) = (Arc::clone(&seen), Arc::clone(&handler));
                connections.spawn(async move { serve(stream, &seen, &handler).await });
            }
        });
        Self {
            base,
            requests,
            accept,
        }
    }

    /// Answers request N with `script[N]`; past the end, a 500.
    pub async fn sequence(script: Vec<Reply>) -> Self {
        Self::start(move |index, _| {
            script
                .get(index)
                .cloned()
                .unwrap_or_else(|| Reply::json(500, "script exhausted"))
        })
        .await
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().expect("requests").clone()
    }

    pub fn count(&self) -> usize {
        self.requests.lock().expect("requests").len()
    }

    pub fn paths(&self) -> Vec<String> {
        self.requests().into_iter().map(|r| r.path).collect()
    }
}

async fn serve(
    mut stream: tokio::net::TcpStream,
    seen: &Mutex<Vec<Recorded>>,
    handler: &Arc<Handler>,
) {
    let Some(request) = read_request(&mut stream).await else {
        return;
    };
    let index = {
        let mut all = seen.lock().expect("requests");
        all.push(request.clone());
        all.len() - 1
    };
    let reply = handler(index, &request);
    if !reply.delay.is_zero() {
        tokio::time::sleep(reply.delay).await;
    }
    if reply.drop_connection {
        return;
    }
    let head = format!(
        "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reply.status,
        reply.body.len()
    );
    drop(stream.write_all(head.as_bytes()).await);
    drop(stream.write_all(reply.body.as_bytes()).await);
    drop(stream.shutdown().await);
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<Recorded> {
    let mut buf = Vec::new();
    let mut chunk = [0_u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_owned(), first.next()?.to_owned());
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let want: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    while buf.len() < head_end + want {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = buf[head_end..].to_vec();
    Some(Recorded {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

pub fn tokens(access: &str, refresh: &str) -> StoredTokens {
    StoredTokens {
        access_token: access.to_owned(),
        refresh_token: refresh.to_owned(),
        user_id: "u".to_owned(),
        workspace_id: "w".to_owned(),
    }
}

/// A token store that answers `load` from a script and records the rest: the
/// vitest `vi.fn().mockResolvedValueOnce(..)` mocks of `tokenStore`.
pub struct ScriptedTokens {
    loads: Mutex<VecDeque<Option<StoredTokens>>>,
    fallback: Option<StoredTokens>,
    pub replaced: Mutex<Vec<(StoredTokens, StoredTokens)>>,
    pub clear_matches: Mutex<Vec<StoredTokens>>,
    pub replace_result: bool,
    pub clear_result: bool,
}

impl ScriptedTokens {
    /// `mockResolvedValue(fallback)`, after the `once` values are used up.
    pub fn new(once: Vec<Option<StoredTokens>>, fallback: Option<StoredTokens>) -> Arc<Self> {
        Arc::new(Self {
            loads: Mutex::new(once.into()),
            fallback,
            replaced: Mutex::default(),
            clear_matches: Mutex::default(),
            replace_result: true,
            clear_result: true,
        })
    }

    pub fn cleared(&self) -> usize {
        self.clear_matches.lock().expect("clears").len()
    }
}

impl TokenStore for ScriptedTokens {
    async fn load(&self) -> Result<Option<StoredTokens>, TokenError> {
        let next = self.loads.lock().expect("loads").pop_front();
        Ok(next.unwrap_or_else(|| self.fallback.clone()))
    }

    async fn save(&self, _: StoredTokens) -> Result<(), TokenError> {
        Ok(())
    }

    async fn replace_if_match(
        &self,
        expected: &StoredTokens,
        next: StoredTokens,
    ) -> Result<bool, TokenError> {
        self.replaced
            .lock()
            .expect("replaced")
            .push((expected.clone(), next));
        Ok(self.replace_result)
    }

    async fn clear(&self) -> Result<(), TokenError> {
        Ok(())
    }

    async fn clear_if_match(&self, expected: &StoredTokens) -> Result<bool, TokenError> {
        self.clear_matches
            .lock()
            .expect("clears")
            .push(expected.clone());
        Ok(self.clear_result)
    }
}

// ---------------- golden fixtures (parity/ dumps of the real TypeScript) ----------------

/// One fixture case. Numbers are parsed with `serde_json`'s `float_roundtrip`, so
/// they equal V8's doubles; output TEXT (bodies, URLs) is compared as strings.
pub struct Case {
    pub input: serde_json::Value,
    pub output: serde_json::Value,
}

/// `parity/` writes `{fn, seed, cases:[{input, output}]}` into `tests/fixtures/<module>/<name>.json`.
/// `TIMO_FIXTURE_DIR` points the tests at a differently generated set.
pub fn fixture(module: &str, name: &str) -> Vec<Case> {
    let root = std::env::var_os("TIMO_FIXTURE_DIR").map_or_else(
        || {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
        },
        std::path::PathBuf::from,
    );
    let path = root.join(module).join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let doc: serde_json::Value = serde_json::from_str(&text).expect("fixture JSON");
    doc["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|c| Case {
            input: c["input"].clone(),
            output: c["output"].clone(),
        })
        .collect()
}

pub fn s(value: &serde_json::Value) -> String {
    value
        .as_str()
        .unwrap_or_else(|| panic!("not a string: {value}"))
        .to_owned()
}

pub fn opt_s(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

pub fn f(value: &serde_json::Value) -> f64 {
    value
        .as_f64()
        .unwrap_or_else(|| panic!("not a number: {value}"))
}

pub fn opt_f(value: &serde_json::Value) -> Option<f64> {
    value.as_f64()
}
