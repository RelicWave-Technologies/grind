//! 1:1 port of `quitCleanup.test.ts`
//! (legacy/agent/src/main/services/quitCleanup.test.ts).
#![cfg(test)]

use timo_core::quit_cleanup::{
    BeforeQuit, OpOutcome, QuitCleanupRunner, QuitEffect, QuitLogLevel, QuitLogMeta, QuitOp,
    before_quit_decision,
};

/// A host whose operations all resolve at once, except those the test holds
/// back (the TypeScript tests' `deferred()` promises).
#[derive(Default)]
struct Host {
    prepare_calls: Vec<String>,
    flush_unsynced_calls: usize,
    flush_partial_activity_calls: usize,
    flush_preferences_calls: usize,
    flush_logs_calls: usize,
    warns: Vec<(&'static str, QuitLogMeta)>,
    /// `prepareForQuit` waits for `release_prepare`.
    hold_prepare: bool,
    held_prepare: Option<u64>,
    /// `prepareForQuit` rejects with this.
    prepare_rejects: Option<String>,
}

impl Host {
    fn perform(&mut self, runner: &mut QuitCleanupRunner, effects: Vec<QuitEffect>) {
        for effect in effects {
            let next = match effect {
                QuitEffect::Log {
                    level,
                    message,
                    meta,
                } => {
                    if level == QuitLogLevel::Warn {
                        self.warns.push((message, meta));
                    }
                    Vec::new()
                }
                QuitEffect::ClearTimer { .. } => Vec::new(),
                QuitEffect::Run { id, op, reason, .. } => match op {
                    QuitOp::FlushPartialActivity => {
                        self.flush_partial_activity_calls += 1;
                        runner.op_finished(id, &OpOutcome::Resolved)
                    }
                    QuitOp::PrepareForQuit => {
                        self.prepare_calls.push(reason);
                        if self.hold_prepare {
                            self.held_prepare = Some(id);
                            Vec::new()
                        } else if let Some(err) = self.prepare_rejects.clone() {
                            runner.op_finished(id, &OpOutcome::Rejected(err))
                        } else {
                            runner.op_finished(id, &OpOutcome::Resolved)
                        }
                    }
                    QuitOp::FlushUnsynced => {
                        self.flush_unsynced_calls += 1;
                        runner.op_finished(id, &OpOutcome::Resolved)
                    }
                    QuitOp::FlushPreferences => {
                        self.flush_preferences_calls += 1;
                        runner.op_finished(id, &OpOutcome::Resolved)
                    }
                    QuitOp::FlushLogs { call } => {
                        self.flush_logs_calls += usize::from(call);
                        runner.op_finished(id, &OpOutcome::Resolved)
                    }
                },
            };
            self.perform(runner, next);
        }
    }

    fn run(&mut self, runner: &mut QuitCleanupRunner, reason: &str) -> bool {
        let start = runner.run(reason);
        self.perform(runner, start.effects);
        start.joined
    }
}

mod quit_cleanup_runner {
    use super::*;

    #[test]
    fn finalizes_timer_flushes_sync_and_flushes_preferences() {
        let mut runner = QuitCleanupRunner::new(None, true);
        let mut host = Host::default();

        host.run(&mut runner, "quit");

        assert_eq!(host.flush_partial_activity_calls, 1);
        assert_eq!(host.prepare_calls, vec!["quit".to_owned()]);
        assert_eq!(host.flush_unsynced_calls, 1);
        assert_eq!(host.flush_preferences_calls, 1);
        assert_eq!(host.flush_logs_calls, 1);
        assert!(runner.has_completed());
    }

    #[test]
    fn reuses_the_in_flight_cleanup_for_repeated_quit_attempts() {
        let mut runner = QuitCleanupRunner::new(None, false);
        let mut host = Host {
            hold_prepare: true,
            ..Host::default()
        };

        let first_joined = host.run(&mut runner, "quit");
        let second_joined = host.run(&mut runner, "shutdown");
        assert!(!first_joined);
        assert!(second_joined);
        assert_eq!(host.prepare_calls.len(), 1);

        // `pending.resolve()`
        host.hold_prepare = false;
        let id = host.held_prepare.take().unwrap();
        let effects = runner.op_finished(id, &OpOutcome::Resolved);
        host.perform(&mut runner, effects);
        assert!(runner.has_completed());
    }

    #[test]
    fn keeps_going_when_timer_cleanup_fails() {
        let mut runner = QuitCleanupRunner::new(None, false);
        let mut host = Host {
            prepare_rejects: Some("Error: db busy".to_owned()),
            ..Host::default()
        };

        host.run(&mut runner, "quit");

        assert_eq!(host.flush_preferences_calls, 1);
        assert!(
            host.warns
                .iter()
                .any(|(message, meta)| *message == "quit cleanup timer failed"
                    && matches!(meta, QuitLogMeta::Failed { reason, .. } if reason == "quit"))
        );
        assert!(runner.has_completed());
    }

    #[test]
    fn can_invalidate_an_early_cleanup_when_the_quit_triggering_action_is_cancelled() {
        let mut runner = QuitCleanupRunner::new(None, false);
        let mut host = Host::default();

        host.run(&mut runner, "quit");
        runner.invalidate();

        assert!(!runner.has_completed());
    }
}

mod register_graceful_quit_handler {
    use super::*;

    #[test]
    fn prevents_quit_until_cleanup_finishes_then_quits_again() {
        // `hasCleanupCompleted: () => false`: preventDefault, run the cleanup for
        // `'quit'`, then `app.quit()` once it settles.
        assert_eq!(before_quit_decision(false), BeforeQuit::PreventAndCleanUp);
    }

    #[test]
    fn allows_quit_after_cleanup_has_already_completed() {
        assert_eq!(before_quit_decision(true), BeforeQuit::Proceed);
    }
}
