//! 1:1 port of the activity tests: `aggregator.test.ts`, `minuteSealer.test.ts`,
//! `percent.test.ts`, `activeWindow.test.ts` (legacy/agent/src/main/services/activity).
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    clippy::indexing_slicing,
    clippy::too_many_arguments,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare; helpers mirror the test files helpers"
)]

use timo_core::activity::{
    ActiveWindowObservation, ActiveWindowTracker, ActivityAggregator, ActivitySample,
    ActivityWindow, CLICKS_SAT_PER_MIN, KEYS_SAT_PER_MIN, MinuteSealer, SealerHost,
    activity_percent, coefficient_of_variation,
};

/// `toBeCloseTo(expected, digits)`.
fn close_to(actual: f64, expected: f64, digits: i32) -> bool {
    (expected - actual).abs() < 10f64.powi(-digits) / 2.0
}

mod aggregator {
    use super::*;

    mod coefficient_of_variation_ {
        use super::*;

        #[test]
        fn is_null_for_fewer_than_2_values() {
            assert_eq!(coefficient_of_variation(&[]), None);
            assert_eq!(coefficient_of_variation(&[5.0]), None);
        }

        #[test]
        fn is_about_0_for_perfectly_regular_metronomic_values() {
            let cv = coefficient_of_variation(&[100.0, 100.0, 100.0, 100.0]).unwrap();
            assert!(close_to(cv, 0.0, 6));
        }

        #[test]
        fn is_higher_for_irregular_bursty_values() {
            let cv = coefficient_of_variation(&[10.0, 400.0, 30.0, 600.0, 20.0]).unwrap();
            assert!(cv > 0.5);
        }

        #[test]
        fn is_null_when_mean_is_0() {
            assert_eq!(coefficient_of_variation(&[0.0, 0.0, 0.0]), None);
        }
    }

    mod activity_aggregator_counts {
        use super::*;

        #[test]
        fn counts_keystrokes_clicks_scrolls() {
            let mut a = ActivityAggregator::new();
            a.on_key(0.0);
            a.on_key(100.0);
            a.on_click();
            a.on_click();
            a.on_scroll();
            let s = a.flush(1000.0);
            assert_eq!(s.bucket_start, 1000.0);
            assert_eq!(s.keystrokes, 2.0);
            assert_eq!(s.clicks, 2.0);
            assert_eq!(s.scroll_events, 1.0);
        }

        #[test]
        fn accumulates_mouse_distance_across_moves() {
            let mut a = ActivityAggregator::new();
            a.on_move(0.0, 0.0, 0.0);
            a.on_move(10.0, 3.0, 4.0); // dist 5
            a.on_move(20.0, 6.0, 8.0); // dist 5
            let s = a.flush(0.0);
            assert_eq!(s.mouse_distance_px, 10.0);
        }

        #[test]
        fn resets_after_flush() {
            let mut a = ActivityAggregator::new();
            a.on_key(0.0);
            a.on_click();
            a.flush(0.0);
            let s = a.flush(60000.0);
            assert_eq!(s.keystrokes, 0.0);
            assert_eq!(s.clicks, 0.0);
            assert_eq!(s.scroll_events, 0.0);
            assert_eq!(s.mouse_distance_px, 0.0);
            assert!(a.is_empty());
        }
    }

    mod activity_aggregator_timing_cvs_anti_cheat_signals {
        use super::*;

        #[test]
        fn metronomic_typing_iki_cv_about_0_bot_signature() {
            let mut a = ActivityAggregator::new();
            let mut t = 0.0;
            while t <= 1000.0 {
                a.on_key(t); // exact 100ms gaps
                t += 100.0;
            }
            let s = a.flush(0.0);
            assert!(s.iki_cv.is_some());
            assert!(s.iki_cv.unwrap() < 0.01);
        }

        #[test]
        fn bursty_human_typing_high_iki_cv() {
            let mut a = ActivityAggregator::new();
            for t in [0.0, 80.0, 130.0, 600.0, 660.0, 1400.0, 1450.0] {
                a.on_key(t);
            }
            let s = a.flush(0.0);
            assert!(s.iki_cv.unwrap() > 0.4);
        }

        #[test]
        fn iki_cv_null_with_fewer_than_3_keystrokes() {
            let mut a = ActivityAggregator::new();
            a.on_key(0.0);
            a.on_key(100.0);
            assert_eq!(a.flush(0.0).iki_cv, None);
        }

        #[test]
        fn straight_line_constant_velocity_mouse_straightness_about_1_move_speed_cv_about_0_bot() {
            let mut a = ActivityAggregator::new();
            for i in 0..=10_u32 {
                let i = f64::from(i);
                a.on_move(i * 10.0, i * 5.0, 0.0); // straight, constant speed
            }
            let s = a.flush(0.0);
            assert!(close_to(s.path_straightness.unwrap(), 1.0, 4));
            assert!(s.move_speed_cv.unwrap() < 0.01);
        }

        #[test]
        fn wandering_human_mouse_straightness_below_1() {
            let mut a = ActivityAggregator::new();
            a.on_move(0.0, 0.0, 0.0);
            a.on_move(10.0, 50.0, 0.0);
            a.on_move(20.0, 50.0, 50.0);
            a.on_move(30.0, 0.0, 50.0);
            a.on_move(40.0, 0.0, 0.0); // returns near start → low straightness
            let s = a.flush(0.0);
            assert!(s.path_straightness.unwrap() < 0.2);
        }

        #[test]
        fn path_straightness_null_with_no_movement() {
            let mut a = ActivityAggregator::new();
            a.on_key(0.0);
            assert_eq!(a.flush(0.0).path_straightness, None);
        }
    }
}

mod minute_sealer {
    use super::*;

    /// The test's `harness(startMs)`: a settable clock and a list of persisted
    /// samples.
    #[derive(Debug)]
    struct Host {
        now_ms: f64,
        persisted: Vec<(ActivitySample, Option<String>)>,
    }

    impl SealerHost for Host {
        fn now(&mut self) -> f64 {
            self.now_ms
        }
        fn persist(&mut self, sample: &ActivitySample, entry_id: Option<&str>) {
            self.persisted
                .push((sample.clone(), entry_id.map(str::to_owned)));
        }
    }

    fn harness(start_ms: f64) -> MinuteSealer<Host> {
        MinuteSealer::new(Host {
            now_ms: start_ms,
            persisted: Vec::new(),
        })
    }

    fn advance(h: &mut MinuteSealer<Host>, ms: f64) {
        h.host_mut().now_ms += ms;
    }

    fn persisted(h: &MinuteSealer<Host>) -> &[(ActivitySample, Option<String>)] {
        &h.host().persisted
    }

    #[test]
    fn seals_a_normal_minute_and_attributes_it_to_the_recording_entry() {
        let mut h = harness(60_000.0);
        h.set_recording(true, Some("e1"));
        for i in 0..10_u32 {
            h.on_key(60_000.0 + f64::from(i) * 100.0);
        }
        h.on_click();
        advance(&mut h, 60_000.0);
        assert_eq!(h.tick(), Some(60_000.0));
        assert_eq!(persisted(&h).len(), 1);
        assert_eq!(persisted(&h)[0].0.keystrokes, 10.0);
        assert_eq!(persisted(&h)[0].0.clicks, 1.0);
        assert_eq!(persisted(&h)[0].0.bucket_start, 60_000.0);
        assert_eq!(persisted(&h)[0].1.as_deref(), Some("e1"));
    }

    // Bug #1 regression: pausing/stopping at tick time must NOT drop the minute.
    #[test]
    fn persists_a_minute_typed_before_a_pause_no_silent_loss() {
        let mut h = harness(60_000.0);
        h.set_recording(true, Some("e1"));
        for i in 0..8_u32 {
            h.on_key(60_000.0 + f64::from(i) * 50.0);
        }
        h.set_recording(false, None); // user pauses 30s in
        advance(&mut h, 60_000.0); // 60s tick fires while PAUSED
        assert_eq!(h.tick(), Some(60_000.0));
        assert_eq!(persisted(&h).len(), 1);
        assert_eq!(persisted(&h)[0].0.keystrokes, 8.0);
        // Attribution survives the pause (entry was active during capture).
        assert_eq!(persisted(&h)[0].1.as_deref(), Some("e1"));
    }

    #[test]
    fn attributes_a_minute_to_the_entry_even_after_the_timer_stops_entry_id_now_null() {
        let mut h = harness(0.0);
        h.set_recording(true, Some("entry-A"));
        h.on_key(100.0);
        h.on_key(400.0);
        h.set_recording(false, None); // stop closes the entry → null
        advance(&mut h, 60_000.0);
        h.tick();
        assert_eq!(persisted(&h)[0].1.as_deref(), Some("entry-A"));
    }

    #[test]
    fn ignores_input_while_not_recording() {
        let mut h = harness(0.0);
        h.on_key(10.0); // never started recording
        h.on_click();
        h.on_move(20.0, 5.0, 5.0);
        advance(&mut h, 60_000.0);
        assert_eq!(h.tick(), None);
        assert_eq!(persisted(&h).len(), 0);
    }

    #[test]
    fn skips_empty_minutes_nothing_to_persist() {
        let mut h = harness(0.0);
        h.set_recording(true, Some("e1"));
        advance(&mut h, 60_000.0);
        assert_eq!(h.tick(), None);
        assert_eq!(persisted(&h).len(), 0);
    }

    #[test]
    fn emits_distinct_buckets_across_consecutive_minutes() {
        let mut h = harness(0.0);
        h.set_recording(true, Some("e1"));
        h.on_click();
        advance(&mut h, 60_000.0);
        h.tick(); // seals bucket 0
        h.on_click();
        advance(&mut h, 60_000.0);
        h.tick(); // seals bucket 60_000
        let buckets: Vec<f64> = persisted(&h).iter().map(|p| p.0.bucket_start).collect();
        assert_eq!(buckets, vec![0.0, 60_000.0]);
    }

    // Bug #2: seal the in-flight partial minute on quit.
    #[test]
    fn seals_the_in_flight_partial_minute_on_quit_seal_partial() {
        let mut h = harness(0.0);
        h.set_recording(true, Some("e1"));
        h.on_key(1000.0);
        h.on_key(1200.0);
        advance(&mut h, 30_000.0); // 30s into the minute, app quits
        assert_eq!(h.seal_partial(), Some(0.0));
        assert_eq!(persisted(&h).len(), 1);
        assert_eq!(persisted(&h)[0].0.keystrokes, 2.0);
    }

    // Invariant #2: at-most-once per bucket.
    #[test]
    fn never_emits_the_same_bucket_twice_overwrite_safe() {
        let mut h = harness(60_000.0);
        h.set_recording(true, Some("e1"));
        h.on_key(60_100.0);
        h.on_key(60_200.0);
        h.on_key(60_300.0);
        assert_eq!(h.seal_partial(), Some(60_000.0)); // e.g. quit path persists 3 keys
        assert_eq!(persisted(&h).len(), 1);
        assert_eq!(persisted(&h)[0].0.keystrokes, 3.0);

        // stop→restart within the SAME wall-clock minute: more keys arrive, then
        // a tick tries to seal bucket 60_000 again. It must NOT persist again.
        h.set_recording(true, Some("e1"));
        h.on_key(60_500.0);
        h.on_key(60_600.0);
        advance(&mut h, 60_000.0); // now 120_000
        assert_eq!(h.tick(), None); // 60_000 already emitted → dropped
        assert_eq!(persisted(&h).len(), 1); // unchanged — no clobber
    }

    #[test]
    fn resets_the_aggregator_on_a_dropped_already_emitted_bucket_so_events_do_not_leak_forward() {
        let mut h = harness(60_000.0);
        h.set_recording(true, Some("e1"));
        h.on_key(60_100.0);
        h.seal_partial(); // emits bucket 60_000 (1 key)
        h.on_key(60_500.0); // arrives for the already-sealed minute
        advance(&mut h, 60_000.0);
        h.tick(); // bucket 60_000 dropped + reset
        h.on_key(120_100.0); // a fresh key in the next minute
        advance(&mut h, 60_000.0);
        h.tick(); // seals bucket 120_000
        let last = persisted(&h).last().unwrap();
        assert_eq!(last.0.bucket_start, 120_000.0);
        assert_eq!(last.0.keystrokes, 1.0); // only the fresh key, not the leaked one
    }
}

mod percent {
    use super::*;

    fn window(
        minutes: f64,
        keystrokes: f64,
        clicks: f64,
        mouse_distance_px: f64,
        scroll_events: f64,
    ) -> ActivityWindow {
        ActivityWindow {
            minutes,
            keystrokes,
            clicks,
            mouse_distance_px,
            scroll_events,
        }
    }

    #[test]
    fn is_zero_for_an_empty_window() {
        let r = activity_percent(&window(0.0, 0.0, 0.0, 0.0, 0.0));
        assert_eq!((r.keyboard, r.mouse), (0.0, 0.0));
    }

    #[test]
    fn maps_saturation_rate_to_100() {
        let r = activity_percent(&window(
            2.0,
            KEYS_SAT_PER_MIN * 2.0,
            CLICKS_SAT_PER_MIN * 2.0,
            0.0,
            0.0,
        ));
        assert_eq!(r.keyboard, 100.0);
        assert_eq!(r.mouse, 100.0);
    }

    #[test]
    fn clamps_above_saturation_to_100() {
        let r = activity_percent(&window(1.0, 100_000.0, 0.0, 0.0, 0.0));
        assert_eq!(r.keyboard, 100.0);
    }

    #[test]
    fn half_saturation_reads_about_50() {
        let r = activity_percent(&window(1.0, KEYS_SAT_PER_MIN / 2.0, 0.0, 0.0, 0.0));
        assert_eq!(r.keyboard, 50.0);
        assert_eq!(r.mouse, 0.0);
    }

    #[test]
    fn mouse_uses_the_busiest_channel_movement_alone_counts() {
        let r = activity_percent(&window(1.0, 0.0, 0.0, 6000.0, 0.0));
        assert_eq!(r.mouse, 100.0);
        assert_eq!(r.keyboard, 0.0);
    }

    #[test]
    fn averages_over_the_window_minutes() {
        // 120 keys over 2 minutes = 60/min = half of 120 saturation → 50%
        let r = activity_percent(&window(2.0, 120.0, 0.0, 0.0, 0.0));
        assert_eq!(r.keyboard, 50.0);
    }
}

mod active_window {
    use super::*;

    fn o(
        ts: f64,
        app: Option<&str>,
        app_bundle: Option<&str>,
        title: Option<&str>,
        url: Option<&str>,
    ) -> ActiveWindowObservation {
        ActiveWindowObservation {
            ts,
            app: app.map(str::to_owned),
            app_bundle: app_bundle.map(str::to_owned),
            title: title.map(str::to_owned),
            url: url.map(str::to_owned),
        }
    }

    fn app(ts: f64, name: &str) -> ActiveWindowObservation {
        o(ts, Some(name), None, None, None)
    }

    #[test]
    fn returns_null_fields_when_nothing_was_observed() {
        let t = ActiveWindowTracker::default();
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app, None);
        assert_eq!(d.active_app_bundle, None);
        assert_eq!(d.active_title, None);
        assert_eq!(d.active_url, None);
    }

    #[test]
    fn attributes_a_full_bucket_to_a_single_observation_made_at_the_start() {
        let mut t = ActiveWindowTracker::default();
        t.observe(o(
            0.0,
            Some("Chrome"),
            Some("com.google.Chrome"),
            None,
            None,
        ));
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app.as_deref(), Some("Chrome"));
        assert_eq!(d.active_app_bundle.as_deref(), Some("com.google.Chrome"));
    }

    #[test]
    fn picks_the_app_with_the_longest_cumulative_time() {
        let mut t = ActiveWindowTracker::default();
        t.observe(app(0.0, "Chrome"));
        t.observe(app(10_000.0, "VS Code"));
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app.as_deref(), Some("VS Code"));
    }

    #[test]
    fn picks_chrome_when_it_actually_owns_more_time_even_with_more_switches() {
        let mut t = ActiveWindowTracker::default();
        t.observe(app(0.0, "Chrome"));
        t.observe(app(30_000.0, "VS Code"));
        t.observe(app(35_000.0, "Chrome"));
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app.as_deref(), Some("Chrome"));
    }

    #[test]
    fn uses_the_prior_observation_as_the_anchor_for_time_before_the_first_in_bucket_tick() {
        let mut t = ActiveWindowTracker::default();
        t.observe(app(-5_000.0, "Chrome"));
        t.observe(app(50_000.0, "VS Code"));
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app.as_deref(), Some("Chrome"));
    }

    #[test]
    fn attaches_the_winning_apps_last_observations_title_and_url() {
        let mut t = ActiveWindowTracker::default();
        t.observe(o(
            0.0,
            Some("Chrome"),
            Some("com.google.Chrome"),
            Some("tab one"),
            Some("https://a"),
        ));
        t.observe(o(
            30_000.0,
            Some("Chrome"),
            Some("com.google.Chrome"),
            Some("tab two"),
            Some("https://b"),
        ));
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_title.as_deref(), Some("tab two"));
        assert_eq!(d.active_url.as_deref(), Some("https://b"));
    }

    #[test]
    fn falls_back_to_the_most_recent_observation_when_no_slice_fits_the_bucket() {
        let mut t = ActiveWindowTracker::default();
        t.observe(app(-1_000.0, "Chrome"));
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app.as_deref(), Some("Chrome"));
    }

    #[test]
    fn returns_null_when_only_a_pre_bucket_null_observation_exists() {
        let mut t = ActiveWindowTracker::default();
        t.observe(o(0.0, None, None, None, None));
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app, None);
    }

    #[test]
    fn observations_later_than_the_bucket_end_do_not_steal_time() {
        let mut t = ActiveWindowTracker::default();
        t.observe(app(0.0, "Chrome"));
        t.observe(app(120_000.0, "VS Code")); // outside bucket
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app.as_deref(), Some("Chrome"));
    }

    #[test]
    fn handles_two_same_named_apps_across_observations() {
        let mut t = ActiveWindowTracker::default();
        for ts in [0.0, 20_000.0, 40_000.0] {
            t.observe(o(ts, Some("Chrome"), Some("com.google.Chrome"), None, None));
        }
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app.as_deref(), Some("Chrome"));
    }

    #[test]
    fn separates_by_app_bundle_tuple_same_display_name_different_bundle_counts_separately() {
        let mut t = ActiveWindowTracker::default();
        t.observe(o(
            0.0,
            Some("Chrome"),
            Some("com.google.Chrome"),
            None,
            None,
        ));
        t.observe(o(
            30_000.0,
            Some("Chrome"),
            Some("com.google.Chrome.test"),
            None,
            None,
        ));
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app.as_deref(), Some("Chrome"));
    }

    #[test]
    fn prune_drops_old_observations_but_keeps_the_most_recent_pre_cut_as_an_anchor() {
        let mut t = ActiveWindowTracker::default();
        t.observe(app(0.0, "A"));
        t.observe(app(10_000.0, "B"));
        t.observe(app(20_000.0, "C"));
        t.observe(app(70_000.0, "D"));
        t.prune(60_000.0);
        // C (the latest pre-60s) is kept as the anchor; D is in-window.
        assert_eq!(t.size(), 2);
        let d = t.dominant_for(60_000.0, 120_000.0);
        assert_eq!(d.active_app.as_deref(), Some("D"));
    }

    #[test]
    fn respects_the_observation_cap() {
        let mut t = ActiveWindowTracker::new(5);
        for i in 0..20_u32 {
            t.observe(app(f64::from(i) * 1_000.0, &format!("App{i}")));
        }
        assert_eq!(t.size(), 5);
    }

    #[test]
    fn null_app_null_bundle_in_mid_bucket_are_skipped_not_winners() {
        let mut t = ActiveWindowTracker::default();
        t.observe(app(0.0, "Chrome"));
        t.observe(o(20_000.0, None, None, None, None));
        t.observe(app(50_000.0, "VS Code"));
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app.as_deref(), Some("Chrome"));
    }

    #[test]
    fn a_flapping_rapid_switch_favours_total_time_not_last_seen() {
        let mut t = ActiveWindowTracker::default();
        t.observe(app(0.0, "VS Code"));
        t.observe(app(40_000.0, "Chrome"));
        t.observe(app(41_000.0, "VS Code"));
        t.observe(app(42_000.0, "Chrome"));
        t.observe(app(43_000.0, "VS Code"));
        t.observe(app(44_000.0, "Chrome"));
        t.observe(app(45_000.0, "VS Code"));
        let d = t.dominant_for(0.0, 60_000.0);
        assert_eq!(d.active_app.as_deref(), Some("VS Code"));
    }
}
