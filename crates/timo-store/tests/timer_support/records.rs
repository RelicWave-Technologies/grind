//! The pieces of a step record, serialized with `JSON.stringify`'s rules.

use serde::Serialize;
use timo_core::js::ser::to_string;
use timo_core::timer::types::{ReadRecoveryNotice, TimerRecoveryResult, TimerStatus};
use timo_core::types::TimeEntry;

/// What an op resolved to (the `ok` of `settled[].result`).
#[derive(Serialize)]
#[serde(untagged)]
pub enum OpValue {
    Null,
    Bool(bool),
    Num(f64),
    NumOrNull(Option<f64>),
    Status(TimerStatus),
    Recovery(Option<TimerRecoveryResult>),
    Notice(Option<ReadRecoveryNotice>),
    Entries(Vec<TimeEntry>),
    Pairs(Vec<(String, f64)>),
    Diagnostics(Option<DiagRecord>),
    Run(RunRecord),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagRecord {
    pub local_ms: f64,
    pub merged_ms: f64,
    pub conflicts: f64,
}

/// better-sqlite3's `RunResult`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub changes: f64,
    pub last_insert_rowid: f64,
}

#[derive(Serialize)]
pub struct OkRec {
    pub ok: OpValue,
}

#[derive(Serialize)]
pub struct ErrRec {
    pub error: String,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum ResultRec {
    Ok(OkRec),
    Err(ErrRec),
}

#[derive(Serialize)]
pub struct Settled {
    pub op: usize,
    pub result: ResultRec,
}

/// `JSON.stringify(value)`.
pub fn text<T: Serialize + ?Sized>(value: &T) -> String {
    to_string(value).unwrap_or_else(|e| format!("<unserializable: {e}>"))
}
