//! Shared support for the store golden-fixture tests.
//!
//! A fixture is `{fn, seed, cases}` written by `parity/` from the real TypeScript
//! (`parity/src/gen/store*.ts`). For the SQLite stores a case's input is a seeded
//! operation sequence and its output is one outcome per step plus a dump of every
//! table (with SQLite's `typeof` per value, so INTEGER-versus-REAL is visible) and the
//! schema. The Rust replays the sequence and must produce a dump whose JavaScript text
//! (`JSON.stringify`, via `timo_core::js::ser`) is identical.
#![allow(
    dead_code,
    clippy::too_many_lines,
    reason = "each test crate uses a subset of these helpers; the dump and replay read straight through"
)]

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use rusqlite::types::{FromSql, ValueRef};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};
use timo_core::js::ser::to_string;

/// One generated case.
pub struct Case {
    pub input: Value,
    pub output: Value,
}

fn fixture_root() -> PathBuf {
    std::env::var_os("TIMO_FIXTURE_DIR").map_or_else(
        || {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
        },
        PathBuf::from,
    )
}

/// Every case of `store/<name>.json`.
pub fn load(name: &str) -> Vec<Case> {
    let path = fixture_root().join("store").join(format!("{name}.json"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut fixture: Value = serde_json::from_str(&text).expect("fixture is JSON");
    let cases = fixture["cases"].take();
    let Value::Array(mut cases) = cases else {
        panic!("{name}: no cases")
    };
    cases.iter_mut().for_each(as_javascript_numbers);
    cases
        .into_iter()
        .map(|mut c| Case {
            input: c["input"].take(),
            output: c["output"].take(),
        })
        .collect()
}

/// JSON.parse reads every number as a double; so must the fixtures. Without this a long
/// integer literal like `4611686018427388000` would stay a `u64` that no double equals.
fn as_javascript_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => *value = Value::from(n.as_f64().expect("finite number")),
        Value::Array(items) => items.iter_mut().for_each(as_javascript_numbers),
        Value::Object(map) => map.values_mut().for_each(as_javascript_numbers),
        _ => {}
    }
}

/// `JSON.stringify(value)` as the TypeScript writes it (object keys sorted: `Value` is a `BTreeMap`).
pub fn js(value: &Value) -> String {
    to_string(value).expect("serializable")
}

/// Runs `run` on every case and demands the JavaScript text of its output equal the fixture's.
pub fn assert_cases(name: &str, run: impl Fn(&Value) -> Value) {
    let cases = load(name);
    assert!(!cases.is_empty(), "{name}: no cases");
    let mut failures = Vec::new();
    for (i, case) in cases.iter().enumerate() {
        let (want, got) = (js(&case.output), js(&run(&case.input)));
        if want != got && failures.len() < 3 {
            failures.push(format!(
                "case {i}\ninput: {}\n{}",
                clip(&js(&case.input), 1500),
                first_difference(&want, &got)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{name}: mismatches\n{}",
        failures.join("\n---\n")
    );
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Where two texts first differ, with some context either side.
fn first_difference(want: &str, got: &str) -> String {
    let common = want
        .chars()
        .zip(got.chars())
        .take_while(|(a, b)| a == b)
        .count();
    let start = common.saturating_sub(120);
    let slice = |s: &str| s.chars().skip(start).take(300).collect::<String>();
    format!(
        "first difference at char {common}\nwant: ...{}\n got: ...{}",
        slice(want),
        slice(got)
    )
}

// --- SQLite ------------------------------------------------------------------------------

/// An in-memory database that outlives the connections the stores open to it: the
/// "keeper" holds it open (shared cache), so a store whose constructor fails and drops
/// its connection leaves the database for the next step, as the TypeScript's single
/// `Database` object does.
pub struct SharedMemoryDb {
    uri: String,
    pub keeper: Connection,
}

static NEXT_DB: AtomicU32 = AtomicU32::new(0);

impl SharedMemoryDb {
    pub fn new() -> Self {
        let n = NEXT_DB.fetch_add(1, Ordering::Relaxed);
        let uri = format!(
            "file:timo_store_test_{}_{n}?mode=memory&cache=shared",
            std::process::id()
        );
        let keeper = Self::open(&uri);
        Self { uri, keeper }
    }

    fn open(uri: &str) -> Connection {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_URI;
        Connection::open_with_flags(uri, flags).expect("open shared in-memory db")
    }

    /// A fresh connection to the same database.
    pub fn connect(&self) -> Connection {
        Self::open(&self.uri)
    }
}

/// The message better-sqlite3 puts on its `SqliteError` (`sqlite3_errmsg`).
pub fn message(error: &rusqlite::Error) -> String {
    match error {
        rusqlite::Error::SqliteFailure(_, Some(text)) => text.clone(),
        // rusqlite (bundled, i.e. modern SQLite) appends the SQL text and offset to a
        // failed statement's message; the clean one is `msg`.
        #[cfg(feature = "bundled")]
        rusqlite::Error::SqlInputError { msg, .. } => msg.clone(),
        other => other.to_string(),
    }
}

/// `{ok: value}` or `{error: message}`: one step's recorded outcome.
pub fn outcome(result: rusqlite::Result<Value>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": message(&error) }),
    }
}

/// How a column value looks to JavaScript.
fn column_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(_) | ValueRef::Real(_) => {
            Value::from(f64::column_result(value).expect("number"))
        }
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
            Value::from(String::from_utf8_lossy(bytes).into_owned())
        }
    }
}

fn raw_rows(conn: &Connection, sql: &str) -> Vec<Vec<Value>> {
    let mut stmt = conn.prepare(sql).expect("prepare dump query");
    let width = stmt.column_count();
    let mut rows = stmt.query([]).expect("run dump query");
    let mut out = Vec::new();
    while let Some(row) = rows.next().expect("next row") {
        out.push(
            (0..width)
                .map(|i| column_value(row.get_ref(i).expect("column")))
                .collect(),
        );
    }
    out
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn rows_value(rows: Vec<Vec<Value>>) -> Value {
    Value::Array(rows.into_iter().map(Value::Array).collect())
}

/// Port of `parity/src/gen/storeDb.ts::dumpDb`: the schema and every table's rows, with `typeof` per value.
pub fn dump_db(conn: &Connection) -> Value {
    let master = raw_rows(
        conn,
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name",
    );
    let names = raw_rows(
        conn,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    let tables: Vec<Value> = names
        .iter()
        .map(|n| {
            let name = n[0].as_str().expect("table name").to_owned();
            let info = raw_rows(conn, &format!("PRAGMA table_info({})", quoted(&name)));
            let columns: Vec<String> = info
                .iter()
                .map(|r| quoted(r[1].as_str().expect("column name")))
                .collect();
            let select = columns
                .iter()
                .map(|c| format!("{c}, typeof({c})"))
                .collect::<Vec<_>>()
                .join(", ");
            let rows = raw_rows(
                conn,
                &format!("SELECT {select} FROM {} ORDER BY rowid", quoted(&name)),
            );
            let pairs: Vec<Vec<Value>> = rows
                .into_iter()
                .map(|r| r.chunks(2).map(|p| Value::Array(p.to_vec())).collect())
                .collect();
            json!({ "name": name, "info": rows_value(info), "rows": rows_value(pairs) })
        })
        .collect();
    json!({ "master": rows_value(master), "tables": tables })
}

/// A store under test, replayed by [`replay`].
pub trait Replay: Sized {
    /// Builds the store over `conn` (a step of the sequence: the first, or a `reopen`).
    fn open(conn: Connection, step: Option<&Value>, case: &Value) -> rusqlite::Result<Self>;
    /// Performs one op and returns what the TypeScript method returned.
    fn apply(&mut self, op: &Value) -> rusqlite::Result<Value>;
}

/// Port of `parity/src/gen/storeDb.ts::runCase`.
pub fn replay<S: Replay>(case: &Value) -> Value {
    let db = SharedMemoryDb::new();
    for sql in case["pre"].as_array().expect("pre") {
        db.keeper
            .execute_batch(sql.as_str().expect("sql"))
            .expect("pre-seed");
    }
    let mut store: Option<S> = None;
    let mut results = Vec::new();
    let build = |store: &mut Option<S>, step: Option<&Value>| -> Value {
        *store = None; // the previous store's connection goes away first
        match S::open(db.connect(), step, case) {
            Ok(s) => {
                *store = Some(s);
                json!({ "ok": null })
            }
            Err(error) => json!({ "error": message(&error) }),
        }
    };
    results.push(build(&mut store, None));
    for op in case["ops"].as_array().expect("ops") {
        let kind = op["op"].as_str().expect("op kind");
        results.push(match kind {
            "reopen" => build(&mut store, Some(op)),
            "exec" => outcome(
                db.keeper
                    .execute_batch(op["sql"].as_str().expect("sql"))
                    .map(|()| Value::Null),
            ),
            _ => match store.as_mut() {
                None => json!({ "error": "no store" }),
                Some(s) => outcome(s.apply(op)),
            },
        });
    }
    let dump = dump_db(&db.keeper);
    let mut out = Map::new();
    out.insert("results".into(), Value::Array(results));
    out.insert("dump".into(), dump);
    Value::Object(out)
}

/// `op[key]` as a double (a JSON number).
pub fn num(op: &Value, key: &str) -> f64 {
    op[key]
        .as_f64()
        .unwrap_or_else(|| panic!("{key} is not a number in {op}"))
}

/// `op[key]` as text.
pub fn text<'a>(op: &'a Value, key: &str) -> &'a str {
    op[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is not a string in {op}"))
}

/// `Value::from(f64)` collapses non-finite numbers to `null`, as `JSON.stringify` does.
pub fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serializable")
}

// --- files ----------------------------------------------------------------------------------

static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

/// A scratch directory under the system temp dir, removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        let n = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("timo-store-{label}-{}-{n}", std::process::id()));
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Best effort: a leftover scratch directory must not fail a passing test.
        fs::remove_dir_all(&self.0).ok();
    }
}
