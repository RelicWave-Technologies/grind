//! The scenario input recorded by `parity/src/scenarios/timer*.ts`.

use serde::Deserialize;
use timo_core::timer::types::TimerOwner;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BusinessDaySpec {
    Utc,
    Fixed {
        start: f64,
        end: f64,
    },
    None,
    #[serde(rename_all = "camelCase")]
    Offset {
        offset_ms: f64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedRow {
    pub id: String,
    pub client_uuid: String,
    pub ended_at: Option<f64>,
    pub synced: i64,
    pub sync_state: Option<String>,
    pub owner_user_id: Option<String>,
    pub owner_workspace_id: Option<String>,
    pub acknowledged_revision: Option<f64>,
    pub acknowledged_hash: Option<String>,
    pub json_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub mono0: f64,
    pub true0: f64,
    pub skew: f64,
    pub per_call: f64,
    pub owner: Option<TimerOwner>,
    pub bind: bool,
    pub claim_legacy: bool,
    pub legacy_schema: bool,
    pub seed_rows: Vec<SeedRow>,
    pub business_day: BusinessDaySpec,
    pub mode: String,
    pub id_start: u64,
}

#[derive(Debug, Deserialize)]
pub struct Pair {
    pub id: String,
    #[serde(rename = "clientUuid")]
    pub client_uuid: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    Start {
        guid: Option<String>,
    },
    Stop,
    Pause,
    Resume,
    ResumeFromIdle {
        at: f64,
    },
    PauseForIdle {
        ms: f64,
    },
    PauseForPermission {
        ms: f64,
    },
    PrepareForQuit {
        reason: String,
    },
    PrepareForAway {
        reason: String,
        ms: f64,
    },
    DiscardAway {
        start: f64,
        resume: f64,
    },
    BeginMeeting {
        at: f64,
    },
    EndMeeting {
        at: f64,
    },
    Flush {
        limit: serde_json::Value,
    },
    Recover {
        at: f64,
    },
    RecoverAway,
    Heartbeat,
    LastLiveness,
    RecoveryNotice,
    DismissNotice,
    HasUnsynced,
    IsPendingCreate {
        id: String,
    },
    Mode {
        mode: String,
    },
    ListToday {
        at: f64,
    },
    WorkedByTask {
        at: Option<f64>,
    },
    Diagnostics {
        at: Option<f64>,
    },
    Finalize {
        entry: String,
        at: f64,
    },
    Bind {
        owner: Option<TimerOwner>,
        claim: bool,
    },
    ClaimMatched {
        pairs: Vec<Pair>,
    },
    Advance {
        ms: f64,
    },
    Suspend {
        ms: f64,
    },
    JumpDevice {
        ms: f64,
    },
    NoteServerTime {
        offset: f64,
        rtt: f64,
    },
    NoteRaw {
        iso: String,
        started: Option<f64>,
        received: Option<f64>,
    },
    Tracking {
        active: bool,
    },
    Guard {
        mode: String,
    },
    ReleaseGuard {
        deny: bool,
    },
    Ids {
        set: u64,
    },
    Listener {
        throws: bool,
    },
    Sql {
        stmt: String,
        params: Vec<serde_json::Value>,
    },
    Deliver,
    Drain,
    Snapshot,
    /// Several ops in one synchronous turn: nothing runs between them.
    Burst {
        ops: Vec<Op>,
    },
}

#[derive(Debug, Deserialize)]
pub struct Scenario {
    pub name: String,
    pub setup: Setup,
    pub ops: Vec<Op>,
}

/// A recorded delivery (`Delivery` of `timerTypes.ts`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: u64,
    pub resolve: Option<String>,
    pub reject_http: Option<HttpReject>,
    pub reject_error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HttpReject {
    pub status: u16,
    pub body: String,
}

/// A recorded snapshot (`record.snapshot` of `timerRun.ts`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotIn {
    pub window: WindowIn,
    pub response: serde_json::Value,
    pub fetched_at: f64,
}

#[derive(Debug, Deserialize, Clone, Copy)]
pub struct WindowIn {
    pub start: f64,
    pub end: f64,
}
