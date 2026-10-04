//! `SpySync` and `receipt()` of `timerService.test.ts`.

use std::sync::{Arc, Mutex, PoisonError};

use futures_util::future::{BoxFuture, FutureExt};
use timo_core::js::iso::to_iso_string;
use timo_core::timer::dto::{
    DtoCloseReason, SegmentDto, TimeEntryDto, TimerSyncCorrection, TimerSyncDisposition,
    TimerSyncReceipt,
};
use timo_core::timer::error::SyncError;
use timo_core::timer::hash::canonical_entry_hash;
use timo_core::timer::traits::SyncClient;
use timo_core::types::{AgentCloseReason, TimeEntry};

use super::{MIN, T0};

/// A callback a test runs inside `create`/`sync`.
pub type Hook = Arc<dyn Fn(&TimeEntry) + Send + Sync>;

#[derive(Default)]
pub struct Log {
    pub creates: Vec<String>,
    pub syncs: Vec<String>,
    pub calls: Vec<String>,
    pub fail_create_count: f64,
    pub fail_sync_count: f64,
    pub not_found_sync_count: f64,
    /// Runs inside `create`/`sync` after the call is recorded (a test mutating the store mid-flight).
    pub on_create: Option<Hook>,
    pub on_sync: Option<Hook>,
}

#[derive(Clone, Default)]
pub struct SpySync(pub Arc<Mutex<Log>>);

#[derive(Default)]
pub struct Overrides {
    pub accepted_revision: Option<f64>,
    pub canonical_hash: Option<String>,
    pub correction: Option<TimerSyncCorrection>,
}

fn iso(ms: f64) -> String {
    to_iso_string(ms).unwrap()
}

/// `receipt(entry, overrides)`.
pub fn receipt(entry: &TimeEntry, over: Overrides) -> TimerSyncReceipt {
    let canonical_hash = canonical_entry_hash(entry).unwrap();
    TimerSyncReceipt {
        disposition: TimerSyncDisposition::Applied,
        accepted_revision: over.accepted_revision.unwrap_or(entry.revision),
        canonical_hash: over.canonical_hash.unwrap_or(canonical_hash),
        canonical_entry: TimeEntryDto {
            id: entry.id.clone(),
            client_uuid: entry.client_uuid.clone(),
            user_id: entry.user_id.clone(),
            lark_task_guid: entry.lark_task_guid.clone().flatten(),
            source: entry.source,
            tracking_protocol_version: Some(2.0),
            revision: Some(entry.revision),
            last_proven_at: Some(iso(entry.ended_at.unwrap_or(T0))),
            lease_expires_at: entry.ended_at.is_none().then(|| iso(T0 + 3.0 * MIN)),
            close_reason: entry.close_reason.map(|r| match r {
                AgentCloseReason::Agent => DtoCloseReason::Agent,
                AgentCloseReason::AgentRecovery => DtoCloseReason::AgentRecovery,
            }),
            server_finalized_at: None,
            started_at: iso(entry.started_at),
            ended_at: entry.ended_at.map(iso),
            notes: None,
            segments: entry
                .segments
                .iter()
                .map(|s| SegmentDto {
                    id: s.id.clone(),
                    kind: s.kind,
                    started_at: iso(s.started_at),
                    ended_at: s.ended_at.map(iso),
                })
                .collect(),
        },
        server_time: iso(T0),
        correction: over.correction,
    }
}

impl SpySync {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn log(&self) -> std::sync::MutexGuard<'_, Log> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn creates(&self) -> Vec<String> {
        self.log().creates.clone()
    }

    pub fn syncs(&self) -> Vec<String> {
        self.log().syncs.clone()
    }

    pub fn calls(&self) -> Vec<String> {
        self.log().calls.clone()
    }
}

fn ready(
    result: Result<TimerSyncReceipt, SyncError>,
) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
    async move { result }.boxed()
}

impl SyncClient for SpySync {
    fn create(&self, entry: &TimeEntry) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
        let hook = {
            let mut log = self.log();
            if log.fail_create_count > 0.0 {
                log.fail_create_count -= 1.0;
                return ready(Err(SyncError::Other("network down".to_owned())));
            }
            log.creates.push(entry.id.clone());
            log.calls.push(format!("create:{}", entry.id));
            log.on_create.clone()
        };
        if let Some(hook) = hook {
            hook(entry);
        }
        ready(Ok(receipt(
            entry,
            Overrides {
                accepted_revision: Some(0.0),
                canonical_hash: Some("0".repeat(64)),
                correction: None,
            },
        )))
    }

    fn sync(&self, entry: &TimeEntry) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
        let hook = {
            let mut log = self.log();
            if log.not_found_sync_count > 0.0 {
                log.not_found_sync_count -= 1.0;
                return ready(Err(SyncError::Http {
                    path: format!("/v1/time-entries/{}/sync", entry.id),
                    status: 404,
                    body: "{\"error\":\"not_found\"}".to_owned(),
                }));
            }
            if log.fail_sync_count > 0.0 {
                log.fail_sync_count -= 1.0;
                return ready(Err(SyncError::Other("network down".to_owned())));
            }
            log.syncs.push(entry.id.clone());
            log.calls.push(format!("sync:{}", entry.id));
            log.on_sync.clone()
        };
        if let Some(hook) = hook {
            hook(entry);
        }
        ready(Ok(receipt(entry, Overrides::default())))
    }
}
