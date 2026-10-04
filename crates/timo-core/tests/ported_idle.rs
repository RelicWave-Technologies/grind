//! 1:1 port of `idle/decide.test.ts` and `idle/monitor.test.ts`
//! (legacy/agent/src/main/services/idle).
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare"
)]

use std::collections::VecDeque;

use timo_core::idle::{
    HandlerOutcome, IdleEffect, IdleInputs, IdleMonitor, IdleTickInput, compute_idle_start,
    should_prompt_idle,
};

mod decide {
    use super::*;

    const BASE: IdleInputs = IdleInputs {
        is_running: true,
        idle_seconds: 0.0,
        threshold_sec: 300.0,
        prompting: false,
    };

    fn with_idle(idle_seconds: f64) -> IdleInputs {
        IdleInputs {
            idle_seconds,
            ..BASE
        }
    }

    mod should_prompt_idle_ {
        use super::*;

        #[test]
        fn prompts_when_running_over_threshold_not_already_prompting() {
            assert!(should_prompt_idle(&with_idle(301.0)));
            assert!(should_prompt_idle(&with_idle(300.0)));
        }

        #[test]
        fn does_not_prompt_below_threshold() {
            assert!(!should_prompt_idle(&with_idle(120.0)));
        }

        #[test]
        fn does_not_prompt_when_not_running() {
            assert!(!should_prompt_idle(&IdleInputs {
                is_running: false,
                idle_seconds: 999.0,
                ..BASE
            }));
        }

        #[test]
        fn does_not_prompt_when_already_prompting() {
            assert!(!should_prompt_idle(&IdleInputs {
                idle_seconds: 999.0,
                prompting: true,
                ..BASE
            }));
        }
    }

    mod compute_idle_start_ {
        use super::*;

        #[test]
        fn subtracts_idle_seconds_from_now() {
            assert_eq!(
                compute_idle_start(1_000_000.0, 60.0),
                1_000_000.0 - 60_000.0
            );
        }

        #[test]
        fn never_goes_past_now_for_negative_idle() {
            assert_eq!(compute_idle_start(1_000_000.0, -5.0), 1_000_000.0);
        }
    }
}

mod monitor {
    use super::*;

    /// `vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'))`.
    const START: f64 = 1_784_203_200_000.0;

    /// The test's hoisted `state` plus the fake handlers and clock.
    struct Setup {
        monitor: IdleMonitor,
        now: f64,
        idle_seconds: f64,
        running: bool,
        paused: bool,
        threshold: f64,
        warning: Option<f64>,
        on_warning: Vec<(f64, f64)>,
        on_warning_cancelled: usize,
        on_idle: Vec<f64>,
        /// `mockResolvedValueOnce` queue for `onIdle` (default `true`).
        idle_outcomes: VecDeque<HandlerOutcome>,
    }

    fn setup() -> Setup {
        Setup {
            monitor: IdleMonitor::new(),
            now: START,
            idle_seconds: 0.0,
            running: true,
            paused: false,
            threshold: 10.0,
            warning: None,
            on_warning: Vec::new(),
            on_warning_cancelled: 0,
            on_idle: Vec::new(),
            idle_outcomes: VecDeque::new(),
        }
    }

    impl Setup {
        /// `await tick(monitor)`: one poll, then the handlers settle.
        fn tick(&mut self) {
            let input = IdleTickInput {
                is_protected: false,
                accruing: self.running && !self.paused,
                idle_seconds: self.idle_seconds,
                now: self.now,
                threshold_sec: self.threshold,
                warning_seconds: self.warning,
            };
            let effects = self.monitor.tick(&input);
            self.apply(effects);
        }

        fn apply(&mut self, effects: Vec<IdleEffect>) {
            for effect in effects {
                let next = match effect {
                    IdleEffect::Warning {
                        idle_started_at,
                        deadline_at,
                    } => {
                        self.on_warning.push((idle_started_at, deadline_at));
                        self.monitor
                            .warning_settled(HandlerOutcome::Accepted, self.now)
                    }
                    IdleEffect::Idle { idle_started_at } => {
                        self.on_idle.push(idle_started_at);
                        let outcome = self
                            .idle_outcomes
                            .pop_front()
                            .unwrap_or(HandlerOutcome::Accepted);
                        self.monitor.idle_settled(outcome)
                    }
                    IdleEffect::WarningCancelled => {
                        self.on_warning_cancelled += 1;
                        Vec::new()
                    }
                    IdleEffect::Arm { .. } | IdleEffect::Clear => Vec::new(),
                };
                self.apply(next);
            }
        }

        fn note_activity(&mut self) {
            let effects = self.monitor.note_activity();
            self.apply(effects);
        }

        fn suspend(&mut self) {
            let effects = self.monitor.suspend();
            self.apply(effects);
        }

        fn resolve(&mut self) {
            let effects = self.monitor.resolve();
            self.apply(effects);
        }
    }

    mod idle_monitor_two_stage_gating {
        use super::*;

        #[test]
        fn keeps_the_existing_direct_idle_pause_when_warning_is_disabled() {
            let mut s = setup();
            s.idle_seconds = 10.0;

            s.tick();

            assert!(s.on_warning.is_empty());
            assert_eq!(s.on_idle.len(), 1);
            assert!(s.monitor.is_prompting());
        }

        #[test]
        fn shows_one_warning_before_the_threshold_without_pausing() {
            let mut s = setup();
            s.warning = Some(3.0);
            s.idle_seconds = 7.0;

            s.tick();
            s.tick();

            assert_eq!(s.on_warning.len(), 1);
            assert_eq!(s.on_warning[0].1, s.now + 3000.0);
            assert!(s.on_idle.is_empty());
            s.resolve();
        }

        #[test]
        fn dismisses_the_warning_automatically_when_activity_returns() {
            let mut s = setup();
            s.warning = Some(3.0);
            s.idle_seconds = 7.0;
            s.tick();

            s.idle_seconds = 0.0;
            s.tick();

            assert_eq!(s.on_warning_cancelled, 1);
            assert!(!s.monitor.is_prompting());
        }

        #[test]
        fn dismisses_the_warning_immediately_when_tracked_input_returns() {
            let mut s = setup();
            s.warning = Some(3.0);
            s.idle_seconds = 7.0;
            s.tick();

            s.note_activity();

            assert_eq!(s.on_warning_cancelled, 1);
            assert!(!s.monitor.is_prompting());
        }

        #[test]
        fn transitions_the_warning_into_the_durable_idle_prompt_at_the_deadline() {
            let mut s = setup();
            s.warning = Some(3.0);
            s.idle_seconds = 7.0;
            s.tick();

            s.now += 3000.0;
            s.idle_seconds = 10.0;
            s.tick();

            assert_eq!(s.on_idle.len(), 1);
            assert!(s.monitor.is_prompting());
        }

        #[test]
        fn retries_presenting_a_paused_idle_prompt_after_a_coordinator_conflict() {
            let mut s = setup();
            s.idle_seconds = 10.0;
            s.idle_outcomes = VecDeque::from([HandlerOutcome::Rejected, HandlerOutcome::Accepted]);

            s.tick();
            s.paused = true;
            s.tick();

            assert_eq!(s.on_idle.len(), 2);
            assert!(s.monitor.is_prompting());
        }

        #[test]
        fn never_warns_or_pauses_when_the_timer_is_not_accruing() {
            let mut s = setup();
            s.warning = Some(3.0);
            s.idle_seconds = 20.0;
            s.paused = true;

            s.tick();

            assert!(s.on_warning.is_empty());
            assert!(s.on_idle.is_empty());
        }

        #[test]
        fn clears_a_warning_while_machine_away_handling_is_active() {
            let mut s = setup();
            s.warning = Some(3.0);
            s.idle_seconds = 7.0;
            s.tick();

            s.suspend();
            s.tick();

            assert_eq!(s.on_warning_cancelled, 1);
            assert!(!s.monitor.is_prompting());
        }
    }
}
