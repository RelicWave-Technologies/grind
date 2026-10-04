//! 1:1 port of `legacy/agent/src/main/services/activity/store.test.ts`.
//!
//! The TypeScript uses a `FakeDb` that records the SQL text and answers `changes: 7`.
//! Here the statement text is asserted on the pure builder [`scrub_sql`] (the exact
//! string the store executes) and the behaviour on a real in-memory database holding
//! seven rows, so `changes` is 7 for real.
#![cfg(test)]

use rusqlite::Connection;
use timo_store::activity_store::{ActivityRow, ActivityStore, PolicyFlags, scrub_sql};

fn row(id: &str) -> ActivityRow {
    ActivityRow {
        id: id.to_owned(),
        time_entry_id: Some("te".to_owned()),
        bucket_start: 60_000.0,
        keystrokes: 1.0,
        clicks: 1.0,
        mouse_distance_px: 1.0,
        scroll_events: 1.0,
        iki_cv: None,
        move_speed_cv: None,
        path_straightness: None,
        active_app: Some("Safari".to_owned()),
        active_app_bundle: Some("com.apple.Safari".to_owned()),
        active_title: Some("Title".to_owned()),
        active_url: Some("https://example.com".to_owned()),
        synced: 0.0,
    }
}

fn store_with_seven_rows() -> ActivityStore {
    let store = ActivityStore::new(Connection::open_in_memory().unwrap()).unwrap();
    for i in 0..7 {
        store.insert(&row(&format!("a{i}"))).unwrap();
    }
    store
}

fn non_null_columns(store: &ActivityStore) -> (i64, i64, i64, i64) {
    store
        .connection()
        .query_row(
            "SELECT COUNT(active_app), COUNT(active_app_bundle), COUNT(active_title), COUNT(active_url) FROM activity_samples",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
}

mod active_store_scrub_active_fields {
    use super::*;

    #[test]
    fn scrubs_every_active_window_column_when_app_capture_is_off() {
        let policy = PolicyFlags {
            capture_apps: false,
            capture_titles: false,
            capture_urls: false,
        };
        assert_eq!(
            scrub_sql(policy).as_deref(),
            Some(
                "UPDATE activity_samples SET active_app = NULL, active_app_bundle = NULL, active_title = NULL, active_url = NULL"
            ),
        );

        let store = store_with_seven_rows();
        let changed = store.scrub_active_fields(policy).unwrap();

        assert_eq!(changed, 7);
        assert_eq!(non_null_columns(&store), (0, 0, 0, 0));
    }

    #[test]
    fn keeps_app_fields_while_scrubbing_disabled_title_and_url_fields() {
        let policy = PolicyFlags {
            capture_apps: true,
            capture_titles: false,
            capture_urls: false,
        };
        assert_eq!(
            scrub_sql(policy).as_deref(),
            Some("UPDATE activity_samples SET active_title = NULL, active_url = NULL"),
        );

        let store = store_with_seven_rows();
        let changed = store.scrub_active_fields(policy).unwrap();

        assert_eq!(changed, 7);
        assert_eq!(non_null_columns(&store), (7, 7, 0, 0));
    }

    #[test]
    fn does_nothing_when_all_capture_fields_are_enabled() {
        let policy = PolicyFlags {
            capture_apps: true,
            capture_titles: true,
            capture_urls: true,
        };
        assert_eq!(scrub_sql(policy), None); // no statement is built, let alone run

        let store = store_with_seven_rows();
        let changed = store.scrub_active_fields(policy).unwrap();

        assert_eq!(changed, 0);
        assert_eq!(non_null_columns(&store), (7, 7, 7, 7));
    }
}

/// The two single-field policies the TypeScript test does not name but its builder has.
#[test]
fn scrubs_only_the_url_or_only_the_title_when_that_is_all_the_policy_forbids() {
    let urls_off = PolicyFlags {
        capture_apps: true,
        capture_titles: true,
        capture_urls: false,
    };
    let titles_off = PolicyFlags {
        capture_apps: true,
        capture_titles: false,
        capture_urls: true,
    };
    assert_eq!(
        scrub_sql(urls_off).as_deref(),
        Some("UPDATE activity_samples SET active_url = NULL")
    );
    assert_eq!(
        scrub_sql(titles_off).as_deref(),
        Some("UPDATE activity_samples SET active_title = NULL")
    );
}
