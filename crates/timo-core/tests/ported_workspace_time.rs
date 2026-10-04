//! 1:1 port of the pure part of `legacy/agent/src/main/services/workspaceTime.test.ts`.
//!
//! The TypeScript tests drive the whole service against a temp directory and a
//! mocked token store. The Rust service logic is the pure `WorkspaceTime` state
//! (the file and the token reads stay in the app crate), so each test performs
//! the same steps on it and checks the same results, including the JSON the
//! service writes to `workspace-time.json`.
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare"
)]

use timo_core::js::date::{DateParse, parse};
use timo_core::js::ser::to_string;
use timo_core::workspace_time::{
    PersistedWorkspaceTime, TimeSource, WorkspaceTime, WorkspaceTimeContext, parse_persisted,
    unavailable_context,
};

fn date_parse(text: &str) -> f64 {
    match parse(text) {
        DateParse::Time(ms) => ms,
        other => panic!("not a date: {text} ({other:?})"),
    }
}

/// What the cache holds -> what `initializeWorkspaceTime` restores.
fn restored(workspace_id: &str, time_zone: &str, token_workspace: &str) -> WorkspaceTime {
    let mut service = WorkspaceTime::new();
    let persisted = parse_persisted(Some(workspace_id), Some(time_zone));
    service.restore_from_cache(token_workspace, persisted.as_ref());
    service
}

mod workspace_time {
    use super::*;

    #[test]
    fn uses_the_server_timezone_for_a_dst_safe_business_day_window_and_persists_it() {
        let mut service = WorkspaceTime::new();
        service.restore_from_cache("workspace_1", None);
        service.apply_server("Asia/Kolkata", "workspace_1").unwrap();

        let context = service
            .context_at(date_parse("2026-07-14T20:00:00.000Z"))
            .unwrap();
        assert_eq!(
            context,
            WorkspaceTimeContext {
                ready: true,
                time_zone: Some("Asia/Kolkata".into()),
                source: TimeSource::Server,
                date: Some("2026-07-15".into()),
                day_start: Some(date_parse("2026-07-14T18:30:00.000Z")),
                day_end: Some(date_parse("2026-07-15T18:30:00.000Z")),
            }
        );
        let written = to_string(&PersistedWorkspaceTime {
            workspace_id: "workspace_1".into(),
            time_zone: "Asia/Kolkata".into(),
        })
        .unwrap();
        assert_eq!(
            written,
            "{\"workspaceId\":\"workspace_1\",\"timeZone\":\"Asia/Kolkata\"}"
        );
    }

    #[test]
    fn loads_the_last_validated_timezone_offline_and_rejects_an_invalid_cache() {
        let service = restored("workspace_1", "Asia/Kolkata", "workspace_1");
        let context = service
            .context_at(date_parse("2026-07-15T00:00:00.000Z"))
            .unwrap();
        assert_eq!(context.source, TimeSource::Cache);

        let service = restored("workspace_1", "not/a-zone", "workspace_1");
        assert!(
            !service
                .context_at(date_parse("2026-07-15T00:00:00.000Z"))
                .unwrap()
                .ready
        );
    }

    #[test]
    fn never_restores_another_workspace_cache_on_a_shared_machine() {
        let service = restored("workspace_previous", "America/New_York", "workspace_1");

        assert_eq!(
            service
                .context_at(date_parse("2026-07-15T00:00:00.000Z"))
                .unwrap(),
            unavailable_context()
        );
        assert_eq!(
            unavailable_context(),
            WorkspaceTimeContext {
                ready: false,
                time_zone: None,
                source: TimeSource::Unavailable,
                date: None,
                day_start: None,
                day_end: None,
            }
        );
    }

    #[test]
    fn clears_in_memory_time_immediately_at_an_auth_boundary() {
        let mut service = WorkspaceTime::new();
        service.apply_server("Asia/Kolkata", "workspace_1").unwrap();

        assert!(service.clear());

        assert!(
            !service
                .context_at(date_parse("2026-07-15T00:00:00.000Z"))
                .unwrap()
                .ready
        );
    }
}
