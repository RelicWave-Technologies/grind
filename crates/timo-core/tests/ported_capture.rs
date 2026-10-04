//! 1:1 port of the capture tests: `scheduler.test.ts`, `retention.test.ts`,
//! `asyncLru.test.ts`, `index.test.ts` (`activityWindowForShot`) and
//! `uploader.test.ts` (legacy/agent/src/main/services/capture).
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare"
)]

use timo_core::capture::{
    AsyncLru, CAPTURE_DEFER_MS, CAPTURE_QUIET_SECONDS, LoadOutcome, Lookup, MAX_CAPTURE_DEFERRALS,
    RetentionInput, RetentionRow, ScreenshotUploadFailureDecision, UploadError,
    activity_window_for_shot, next_delay_ms, plan_screenshot_retention, screenshot_retry_delay_ms,
    screenshot_upload_failure_decision, should_defer_capture,
};

mod next_delay_ms_ {
    use super::*;

    const INT: f64 = 180_000.0; // 3m

    #[test]
    fn returns_the_exact_interval() {
        assert_eq!(next_delay_ms(INT), INT);
    }

    #[test]
    fn rounds_fractional_milliseconds_defensively() {
        assert_eq!(next_delay_ms(60_000.4), 60_000.0);
        assert_eq!(next_delay_ms(60_000.5), 60_001.0);
    }

    #[test]
    fn enforces_a_1s_floor_on_the_interval() {
        assert_eq!(next_delay_ms(0.0), 1000.0);
    }
}

mod should_defer_capture_ {
    use super::*;

    #[test]
    fn waits_for_a_gap_in_input_because_the_stall_freezes_every_window() {
        assert!(should_defer_capture(0.0, 0.0));
        assert!(should_defer_capture(1.0, 0.0));
    }

    #[test]
    fn goes_ahead_once_input_has_been_quiet() {
        assert!(!should_defer_capture(CAPTURE_QUIET_SECONDS, 0.0));
        assert!(!should_defer_capture(30.0, 0.0));
    }

    #[test]
    fn never_holds_a_capture_back_forever() {
        assert!(should_defer_capture(0.0, MAX_CAPTURE_DEFERRALS - 1.0));
        assert!(!should_defer_capture(0.0, MAX_CAPTURE_DEFERRALS));
        assert!(!should_defer_capture(0.0, MAX_CAPTURE_DEFERRALS + 5.0));
    }

    #[test]
    fn bounds_the_total_delay_it_can_add() {
        const {
            assert!(MAX_CAPTURE_DEFERRALS * CAPTURE_DEFER_MS <= 10_000.0);
        }
    }
}

mod plan_screenshot_retention_ {
    use super::*;

    const NOW: f64 = 1_700_000_000_000.0;
    const DAY: f64 = 86_400_000.0;

    fn row(id: &str, file_path: &str, age_days: f64) -> RetentionRow {
        RetentionRow {
            id: id.to_owned(),
            file_path: file_path.to_owned(),
            captured_at: NOW - age_days * DAY,
        }
    }

    fn plan(
        rows: Vec<RetentionRow>,
        files: &[&str],
        retention_days: f64,
    ) -> timo_core::capture::RetentionPlan {
        plan_screenshot_retention(&RetentionInput {
            rows,
            files_on_disk: files.iter().map(|f| (*f).to_owned()).collect(),
            now: NOW,
            retention_days,
        })
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn keeps_fresh_rows_whose_files_exist_deletes_nothing() {
        let p = plan(
            vec![row("a", "/s/a.webp", 1.0), row("b", "/s/b.webp", 10.0)],
            &["/s/a.webp", "/s/b.webp"],
            60.0,
        );
        assert!(p.files_to_delete.is_empty());
        assert!(p.row_ids_to_delete.is_empty());
    }

    #[test]
    fn expires_rows_and_their_files_past_the_retention_window() {
        let p = plan(
            vec![
                row("old", "/s/old.webp", 61.0),
                row("new", "/s/new.webp", 1.0),
            ],
            &["/s/old.webp", "/s/new.webp"],
            60.0,
        );
        assert_eq!(p.row_ids_to_delete, strings(&["old"]));
        assert_eq!(p.files_to_delete, strings(&["/s/old.webp"]));
        assert_eq!(p.expired, 1);
    }

    #[test]
    fn deletes_orphan_files_on_disk_that_have_no_row_crash_between_write_and_insert() {
        let p = plan(
            vec![row("a", "/s/a.webp", 1.0)],
            &["/s/a.webp", "/s/orphan.webp"],
            60.0,
        );
        assert_eq!(p.files_to_delete, strings(&["/s/orphan.webp"]));
        assert!(p.row_ids_to_delete.is_empty());
        assert_eq!(p.orphan_files, 1);
    }

    #[test]
    fn drops_dangling_rows_whose_file_has_vanished_no_broken_thumbnails() {
        let p = plan(
            vec![row("a", "/s/a.webp", 1.0), row("gone", "/s/gone.webp", 2.0)],
            &["/s/a.webp"],
            60.0,
        );
        assert_eq!(p.row_ids_to_delete, strings(&["gone"]));
        assert!(p.files_to_delete.is_empty()); // file already gone: nothing to unlink
        assert_eq!(p.dangling_rows, 1);
    }

    #[test]
    fn does_not_list_an_already_expired_file_as_an_orphan_no_double_count() {
        let p = plan(
            vec![row("old", "/s/old.webp", 90.0)],
            &["/s/old.webp"],
            60.0,
        );
        assert_eq!(p.files_to_delete, strings(&["/s/old.webp"]));
        assert_eq!(p.orphan_files, 0); // it has a row, so it's expiry not orphan
        assert_eq!(p.expired, 1);
    }

    #[test]
    fn retention_days_zero_or_less_disables_expiry_but_still_reconciles_orphans_and_dangling() {
        let p = plan(
            vec![
                row("ancient", "/s/ancient.webp", 999.0),
                row("gone", "/s/gone.webp", 1.0),
            ],
            &["/s/ancient.webp", "/s/orphan.webp"],
            0.0,
        );
        assert_eq!(p.expired, 0); // ancient kept: expiry disabled
        assert_eq!(p.row_ids_to_delete, strings(&["gone"])); // dangling row still dropped
        assert_eq!(p.files_to_delete, strings(&["/s/orphan.webp"])); // orphan still cleaned
    }

    #[test]
    fn handles_the_empty_case() {
        let p = plan(vec![], &[], 60.0);
        assert!(p.files_to_delete.is_empty());
        assert!(p.row_ids_to_delete.is_empty());
        assert_eq!((p.expired, p.orphan_files, p.dangling_rows), (0, 0, 0));
    }
}

mod async_lru {
    use super::*;

    /// `cache.get(key, load)` where `load` resolves to `outcome` straight away:
    /// returns whether the loader ran, and the value the promise resolves to.
    fn get(
        cache: &mut AsyncLru<String>,
        key: &str,
        outcome: LoadOutcome<String>,
    ) -> (bool, Option<String>) {
        match cache.get(key) {
            Lookup::Hit(v) => (false, Some(v)),
            Lookup::Pending => (false, None),
            Lookup::Miss(token) => {
                let value = match &outcome {
                    LoadOutcome::Loaded(v) => Some(v.clone()),
                    LoadOutcome::Missing | LoadOutcome::Failed => None,
                };
                cache.settle(key, token, outcome);
                (true, value)
            }
        }
    }

    #[test]
    fn deduplicates_concurrent_loads_for_the_same_immutable_key() {
        let mut cache = AsyncLru::<String>::new(2.0).unwrap();
        let mut loads = 0;
        // Two gets before the load settles: the second shares the pending load.
        let first = cache.get("a");
        let second = cache.get("a");
        if let Lookup::Miss(token) = first {
            loads += 1;
            cache.settle("a", token, LoadOutcome::Loaded("thumb".to_owned()));
        }
        assert!(matches!(second, Lookup::Pending));
        assert_eq!(loads, 1);
        assert!(matches!(cache.get("a"), Lookup::Hit(v) if v == "thumb"));
    }

    #[test]
    fn evicts_the_least_recently_used_value_at_the_configured_bound() {
        let mut cache = AsyncLru::<String>::new(2.0).unwrap();
        get(&mut cache, "a", LoadOutcome::Loaded("a".to_owned()));
        get(&mut cache, "b", LoadOutcome::Loaded("b".to_owned()));
        get(&mut cache, "c", LoadOutcome::Loaded("c".to_owned()));
        let (reloaded, value) = get(&mut cache, "a", LoadOutcome::Loaded("a2".to_owned()));
        assert_eq!(value.as_deref(), Some("a2"));
        assert!(reloaded);
    }

    #[test]
    fn does_not_retain_failed_or_missing_values() {
        let mut cache = AsyncLru::<String>::new(2.0).unwrap();
        let mut missing_loads = 0;
        let mut failed_loads = 0;
        for _ in 0..2 {
            let (ran, value) = get(&mut cache, "missing", LoadOutcome::Missing);
            missing_loads += usize::from(ran);
            assert_eq!(value, None);
        }
        for _ in 0..2 {
            let (ran, value) = get(&mut cache, "failed", LoadOutcome::Failed);
            failed_loads += usize::from(ran);
            assert_eq!(value, None);
        }
        assert_eq!(missing_loads, 2);
        assert_eq!(failed_loads, 2);
    }
}

mod activity_window_for_shot_ {
    use super::*;

    const DAY_DEFAULT: f64 = 30.0 * 60_000.0;

    #[test]
    fn first_shot_no_older_looks_back_default_window_ms() {
        let t = 10.0 * 60_000.0; // 10 minutes
        let w = activity_window_for_shot(t, None, DAY_DEFAULT);
        assert_eq!(w.from, t - DAY_DEFAULT);
        assert_eq!(w.to, t + 60_000.0);
    }

    mod normal_cadence_1_3_minute_interval_partition_mode {
        use super::*;

        #[test]
        fn starts_the_window_60s_past_the_older_shot() {
            let older = 0.0;
            let now = 3.0 * 60_000.0; // 3m later
            let w = activity_window_for_shot(now, Some(older), DAY_DEFAULT);
            assert_eq!(w.from, older + 60_000.0);
            assert_eq!(w.to, now + 60_000.0);
        }
    }

    mod fast_cadence_15_second_interval_regression_guard {
        use super::*;

        #[test]
        fn regression_15s_gap_must_not_leave_a_future_only_window() {
            let older = 60_000_000.0; // arbitrary epoch
            let now = older + 15_000.0; // 15s later
            let w = activity_window_for_shot(now, Some(older), DAY_DEFAULT);
            // The fix: clamp from to at most (now - 60_000) so the past minute is
            // always in scope.
            assert!(w.from <= now - 60_000.0);
            // And the window MUST be long enough to capture one minute bucket.
            assert!(w.to - w.from >= 60_000.0);
        }

        #[test]
        fn thirty_s_gap_also_clamps_so_the_past_minute_is_included() {
            let older = 60_000_000.0;
            let now = older + 30_000.0;
            let w = activity_window_for_shot(now, Some(older), DAY_DEFAULT);
            assert_eq!(w.from, now - 60_000.0);
            assert_eq!(w.to, now + 60_000.0);
        }

        #[test]
        fn exactly_60s_gap_is_the_crossover_partition_mode_kicks_in_no_clamp_needed() {
            let older = 60_000_000.0;
            let now = older + 60_000.0;
            let w = activity_window_for_shot(now, Some(older), DAY_DEFAULT);
            assert_eq!(w.from, now - 60_000.0);
        }

        #[test]
        fn five_minute_gap_is_well_into_partition_mode() {
            let older = 60_000_000.0;
            let now = older + 5.0 * 60_000.0;
            let w = activity_window_for_shot(now, Some(older), DAY_DEFAULT);
            // partitionFrom = older + 60s; that's earlier than (now - 60s), so it wins.
            assert_eq!(w.from, older + 60_000.0);
        }
    }
}

mod screenshot_uploader_retry_decisions {
    use super::*;

    fn decide(
        attempts: f64,
        err: &UploadError,
        now: f64,
        r: f64,
    ) -> ScreenshotUploadFailureDecision {
        screenshot_upload_failure_decision(attempts, err, now, || r)
    }

    #[test]
    fn uses_capped_exponential_backoff_with_a_one_minute_floor() {
        assert_eq!(screenshot_retry_delay_ms(1.0, || 0.0), 60_000.0);
        assert_eq!(screenshot_retry_delay_ms(2.0, || 0.5), 90_000.0);
        assert_eq!(screenshot_retry_delay_ms(20.0, || 1.0), 3_600_000.0);
    }

    #[test]
    fn does_not_consume_attempts_for_auth_failures() {
        let decision = decide(
            4.0,
            &UploadError::Unauthorized {
                message: "no_tokens".to_owned(),
            },
            1_000.0,
            0.0,
        );
        assert_eq!(
            decision,
            ScreenshotUploadFailureDecision::Pending {
                last_error: "no_tokens".to_owned(),
                next_attempt_at: 61_000.0
            }
        );
    }

    #[test]
    fn does_not_consume_attempts_when_storage_is_not_configured() {
        let decision = decide(
            4.0,
            &UploadError::Http {
                path: "/v1/screenshots/sign".to_owned(),
                status: 503.0,
                body: "cloudinary_not_configured".to_owned(),
            },
            1_000.0,
            0.0,
        );
        assert_eq!(
            decision,
            ScreenshotUploadFailureDecision::Pending {
                last_error: "/v1/screenshots/sign 503: cloudinary_not_configured".to_owned(),
                next_attempt_at: 61_000.0
            }
        );
    }

    #[test]
    fn schedules_retryable_failures_below_the_cap() {
        let decision = decide(
            1.0,
            &UploadError::Error {
                message: "network reset".to_owned(),
                code: None,
            },
            1_000.0,
            0.5,
        );
        assert_eq!(
            decision,
            ScreenshotUploadFailureDecision::Retry {
                last_error: "network reset".to_owned(),
                next_attempt_at: 91_000.0
            }
        );
    }

    #[test]
    fn moves_the_fifth_retryable_failure_to_failed() {
        // `rng` is left to its default in the TypeScript; it is never consulted.
        let decision = decide(
            4.0,
            &UploadError::Error {
                message: "network reset".to_owned(),
                code: None,
            },
            1_000.0,
            0.5,
        );
        assert_eq!(
            decision,
            ScreenshotUploadFailureDecision::Failed {
                last_error: "network reset".to_owned()
            }
        );
    }

    #[test]
    fn treats_local_missing_files_and_cloudinary_hard_4xx_responses_as_terminal() {
        assert!(matches!(
            decide(
                0.0,
                &UploadError::Plain {
                    code: Some("ENOENT".to_owned())
                },
                1_000.0,
                0.5
            ),
            ScreenshotUploadFailureDecision::Failed { .. }
        ));
        assert_eq!(
            decide(
                0.0,
                &UploadError::Cloudinary {
                    status: 401.0,
                    body: "bad signature".to_owned()
                },
                1_000.0,
                0.5
            ),
            ScreenshotUploadFailureDecision::Failed {
                last_error: "cloudinary 401: bad signature".to_owned()
            }
        );
    }

    #[test]
    fn keeps_throttling_style_cloudinary_4xx_responses_retryable() {
        let decision = decide(
            0.0,
            &UploadError::Cloudinary {
                status: 429.0,
                body: "too many requests".to_owned(),
            },
            1_000.0,
            0.0,
        );
        assert_eq!(
            decision,
            ScreenshotUploadFailureDecision::Retry {
                last_error: "cloudinary 429: too many requests".to_owned(),
                next_attempt_at: 61_000.0
            }
        );
    }
}
