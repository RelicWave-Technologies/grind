//! Executing one scenario op against the Rust runtime.

use std::sync::atomic::Ordering;

use rusqlite::types::Value as Sql;
use timo_core::js::iso::to_iso_string;
use timo_core::js::math::div;
use timo_core::js::number::add;
use timo_core::timer::TimerError;
use timo_core::timer::types::{EntryMatch, StartArgs, TimerAwayReason, TimerExitReason};
use timo_store::timer::SnapshotAt;

use super::records::{DiagRecord, OpValue, RunRecord};
use super::replay::{Run, Supplied};
use super::scenario::Op;
use super::world::GuardMode;

fn away(reason: &str) -> TimerAwayReason {
    if reason == "suspend" {
        TimerAwayReason::Suspend
    } else {
        TimerAwayReason::Lock
    }
}

fn exit(reason: &str) -> TimerExitReason {
    match reason {
        "quit" => TimerExitReason::Quit,
        "update" => TimerExitReason::Update,
        _ => TimerExitReason::Shutdown,
    }
}

fn sql_value(value: &serde_json::Value) -> Sql {
    match value {
        serde_json::Value::String(s) => Sql::Text(s.clone()),
        serde_json::Value::Number(n) => Sql::Real(n.as_f64().unwrap_or(f64::NAN)),
        _ => Sql::Null,
    }
}

impl Run {
    /// One op. Ops that `launch` in the TypeScript harness launch here too.
    pub(super) fn apply(&mut self, index: usize, op: &Op, supplied: &Supplied) {
        let rt = std::sync::Arc::clone(&self.rt);
        match op {
            Op::Start { guid } => {
                let args = StartArgs {
                    lark_task_guid: guid.clone(),
                };
                self.launch(
                    index,
                    async move { rt.start(args).await.map(OpValue::Status) },
                );
            }
            Op::Stop => self.launch(index, async move { rt.stop().await.map(OpValue::Status) }),
            Op::Pause => self.launch(index, async move { rt.pause().await.map(OpValue::Status) }),
            Op::Resume => self.launch(index, async move { rt.resume().await.map(OpValue::Status) }),
            Op::ResumeFromIdle { at } => {
                let at = *at;
                self.launch(index, async move {
                    rt.resume_from_idle(at).await.map(|()| OpValue::Null)
                });
            }
            Op::PauseForIdle { ms } => {
                let ms = *ms;
                self.launch(index, async move {
                    rt.pause_for_idle(ms).await.map(|()| OpValue::Null)
                });
            }
            Op::PauseForPermission { ms } => {
                let ms = *ms;
                self.launch(index, async move {
                    rt.pause_for_permission(ms).await.map(OpValue::Status)
                });
            }
            Op::PrepareForQuit { reason } => {
                let reason = exit(reason);
                self.launch(index, async move {
                    rt.prepare_for_quit(reason).await.map(OpValue::Status)
                });
            }
            Op::PrepareForAway { reason, ms } => {
                let (reason, ms) = (away(reason), *ms);
                self.launch(index, async move {
                    rt.prepare_for_away(reason, ms).map(OpValue::Status)
                });
            }
            Op::DiscardAway { start, resume } => {
                let (start, resume) = (*start, *resume);
                self.launch(index, async move {
                    rt.discard_away(start, resume).await.map(|()| OpValue::Null)
                });
            }
            Op::BeginMeeting { at } => {
                let at = *at;
                self.launch(index, async move {
                    rt.begin_meeting(at).await.map(|()| OpValue::Null)
                });
            }
            Op::EndMeeting { at } => {
                let at = *at;
                self.launch(index, async move {
                    rt.end_meeting(at).await.map(|()| OpValue::Null)
                });
            }
            Op::Flush { limit } => {
                let limit = match limit {
                    serde_json::Value::Null => timo_core::timer::FLUSH_BATCH_LIMIT,
                    serde_json::Value::String(_) => f64::INFINITY,
                    other => other.as_f64().unwrap_or(f64::NAN),
                };
                self.launch(index, async move {
                    rt.flush_unsynced(limit).await.map(OpValue::Bool)
                });
            }
            Op::Burst { ops } => {
                for member in ops {
                    self.apply(index, member, supplied);
                }
            }
            other => self.apply_sync(index, other, supplied),
        }
    }

    /// The ops that are not async in the TypeScript, plus the harness controls.
    fn apply_sync(&mut self, index: usize, op: &Op, supplied: &Supplied) {
        let rt = std::sync::Arc::clone(&self.rt);
        match op {
            Op::Recover { at } => {
                let at = *at;
                self.launch(index, async move {
                    rt.lock().recover(at).map(OpValue::Recovery)
                });
            }
            Op::RecoverAway => self.launch(index, async move {
                rt.lock().recover_away().map(OpValue::Recovery)
            }),
            Op::Heartbeat => self.launch(index, async move {
                rt.lock().heartbeat().map(|()| OpValue::Null)
            }),
            Op::LastLiveness => self.launch(index, async move {
                rt.lock().last_liveness().map(OpValue::NumOrNull)
            }),
            Op::RecoveryNotice => self.launch(index, async move {
                rt.lock().recovery_notice().map(OpValue::Notice)
            }),
            Op::DismissNotice => {
                self.launch(index, async move {
                    rt.lock().dismiss_recovery_notice().map(|()| OpValue::Null)
                });
            }
            Op::HasUnsynced => {
                self.launch(
                    index,
                    async move { rt.lock().has_unsynced().map(OpValue::Bool) },
                );
            }
            Op::IsPendingCreate { id } => {
                let id = id.clone();
                self.launch(index, async move {
                    rt.lock().is_pending_create(&id).map(OpValue::Bool)
                });
            }
            Op::Mode { mode } => {
                let mode = super::replay::mode_of(mode);
                self.launch(index, async move {
                    Ok(OpValue::Bool(rt.set_today_ledger_mode(mode)))
                });
            }
            Op::ListToday { at } => {
                let at = *at;
                self.launch(index, async move {
                    rt.lock().list_today(at).map(OpValue::Entries)
                });
            }
            Op::WorkedByTask { at } => {
                let at = *at;
                self.launch(index, async move {
                    rt.lock().worked_ms_by_task(at).map(OpValue::Pairs)
                });
            }
            Op::Diagnostics { at } => {
                let at = *at;
                self.launch(index, async move { diagnostics(&rt, at) });
            }
            Op::Finalize { entry, at } => {
                let id = if entry == "open" {
                    self.open_entry_id().unwrap_or_else(|| "none".to_owned())
                } else {
                    entry.clone()
                };
                let at = *at;
                self.launch(index, async move {
                    rt.accept_server_finalization(&id, at).map(OpValue::Status)
                });
            }
            Op::Bind { owner, claim } => {
                let (owner, claim) = (owner.clone(), *claim);
                self.launch(index, async move {
                    rt.lock()
                        .bind_owner(owner.as_ref(), claim)
                        .map(|()| OpValue::Null)
                });
            }
            Op::ClaimMatched { pairs } => {
                let pairs: Vec<EntryMatch> = pairs
                    .iter()
                    .map(|p| EntryMatch {
                        id: p.id.clone(),
                        client_uuid: p.client_uuid.clone(),
                    })
                    .collect();
                self.launch(index, async move {
                    rt.lock().claim_server_matched_entries(&pairs).map(count)
                });
            }
            other => self.apply_control(index, other, supplied),
        }
    }

    /// World, guard, ids, listener, SQL, deliveries and snapshots.
    fn apply_control(&mut self, index: usize, op: &Op, supplied: &Supplied) {
        match op {
            Op::Advance { ms } => self.world.advance(*ms),
            Op::Suspend { ms } => self.world.suspend(*ms),
            Op::JumpDevice { ms } => self.world.jump_device(*ms),
            Op::NoteServerTime { offset, rtt } => {
                let started = self.world.device_now();
                self.world.advance(div(*rtt, 2.0));
                let stamped =
                    to_iso_string(add(self.world.true_now(), *offset)).unwrap_or_default();
                self.world.advance(div(*rtt, 2.0));
                let received = self.world.device_now();
                let clock = self.clock.clone();
                self.launch(index, async move {
                    Ok(OpValue::NumOrNull(
                        clock.note_server_time(&stamped, started, received),
                    ))
                });
            }
            Op::NoteRaw {
                iso,
                started,
                received,
            } => {
                let (iso, started, received) = (
                    iso.clone(),
                    started.unwrap_or(f64::NAN),
                    received.unwrap_or(f64::NAN),
                );
                let clock = self.clock.clone();
                self.launch(index, async move {
                    Ok(OpValue::NumOrNull(
                        clock.note_server_time(&iso, started, received),
                    ))
                });
            }
            Op::Tracking { active } => self.clock.set_tracking(*active),
            Op::Guard { mode } => self.guard.set_mode(match mode.as_str() {
                "deny" => GuardMode::Deny,
                "hold" => GuardMode::Hold,
                _ => GuardMode::Allow,
            }),
            Op::ReleaseGuard { deny } => self.guard.release(*deny),
            Op::Ids { set } => self.ids.set(*set),
            Op::Listener { throws } => self.listener_throws.store(*throws, Ordering::SeqCst),
            Op::Sql { stmt, params } => self.sql(index, stmt, params),
            Op::Deliver | Op::Drain => {
                for delivery in &supplied.deliveries {
                    self.deliver(delivery);
                }
            }
            Op::Snapshot => self.snapshot(index, supplied),
            _ => unreachable!("handled by apply / apply_sync"),
        }
    }

    fn sql(&mut self, index: usize, stmt: &str, params: &[serde_json::Value]) {
        let values: Vec<Sql> = params.iter().map(sql_value).collect();
        let db = std::sync::Arc::clone(&self.db);
        let stmt = stmt.to_owned();
        self.launch(index, async move {
            let conn = db.lock().unwrap();
            // better-sqlite3's `changes` is the growth of `sqlite3_total_changes()`: a DDL statement
            // makes none, where `Connection::execute` reports the previous statement's count.
            let before = conn.total_changes();
            conn.execute(&stmt, rusqlite::params_from_iter(values))
                .map_err(|e| TimerError::Store(e.to_string()))?;
            let changes =
                f64::from(u32::try_from(conn.total_changes() - before).unwrap_or(u32::MAX));
            let rowid =
                timo_core::js::number::i64_to_f64(conn.last_insert_rowid()).unwrap_or(f64::NAN);
            Ok(OpValue::Run(RunRecord {
                changes,
                last_insert_rowid: rowid,
            }))
        });
    }

    fn snapshot(&mut self, index: usize, supplied: &Supplied) {
        let Some(owner) = self.owner.clone() else {
            return;
        };
        let snap = supplied.snapshot.as_ref().expect("recorded snapshot");
        let response: timo_core::timer::dto::TodayLedgerResponse =
            serde_json::from_value(snap.response.clone()).expect("recorded snapshot response");
        let cache = std::sync::Arc::clone(&self.cache);
        let (window, fetched_at) = (
            timo_core::timer::types::DayWindow {
                start: snap.window.start,
                end: snap.window.end,
            },
            snap.fetched_at,
        );
        self.launch(index, async move {
            cache
                .replace_snapshot_at(&SnapshotAt {
                    owner: &owner,
                    window,
                    response: &response,
                    fetched_at,
                })
                .map(|()| OpValue::Null)
        });
    }
}

fn count(n: usize) -> OpValue {
    OpValue::Num(f64::from(u32::try_from(n).unwrap_or(u32::MAX)))
}

fn diagnostics(
    rt: &timo_core::timer::TimerRuntime,
    at: Option<f64>,
) -> Result<OpValue, TimerError> {
    let d = rt.lock().today_ledger_diagnostics(at)?;
    Ok(OpValue::Diagnostics(d.map(|d| DiagRecord {
        local_ms: d.local_ms,
        merged_ms: d.merged_ms,
        conflicts: f64::from(u32::try_from(d.conflicts).unwrap_or(u32::MAX)),
    })))
}
