//! 1:1 port of `legacy/agent/src/main/services/lastTaskMemory.test.ts`, on a real file in
//! a scratch directory instead of the TypeScript's mocked `node:fs`.
//!
//! The "restart" is a fresh [`PreferencesStore::load`] of the same file, as a new module
//! instance is a new app launch in the TypeScript.
#![cfg(test)]

mod store_support;

use std::fs;

use store_support::TempDir;
use timo_store::preferences::{FloatingBarPatch, PreferencesStore};

fn file(dir: &TempDir) -> std::path::PathBuf {
    dir.path().join("preferences.json")
}

mod last_tracked_task_memory {
    use super::*;

    #[test]
    fn defaults_to_no_remembered_task_on_a_fresh_install() {
        let dir = TempDir::new("prefs");
        let prefs = PreferencesStore::load(file(&dir));
        assert_eq!(prefs.get().last_lark_task_guid, None);
    }

    #[test]
    fn remembers_the_task_and_survives_a_restart() {
        let dir = TempDir::new("prefs");
        let mut first = PreferencesStore::load(file(&dir));
        first.remember_last_lark_task(Some("task-abc"));
        first.flush().unwrap();

        // A fresh load = a new app launch reading the same file.
        let after_restart = PreferencesStore::load(file(&dir));
        assert_eq!(
            after_restart.get().last_lark_task_guid.as_deref(),
            Some("task-abc")
        );
    }

    #[test]
    fn keeps_the_floating_bar_prefs_intact_when_remembering_a_task() {
        let dir = TempDir::new("prefs");
        let mut prefs = PreferencesStore::load(file(&dir));
        prefs.patch_floating_bar(FloatingBarPatch {
            visible: Some(false),
            x: Some(Some(12.0)),
            y: Some(Some(34.0)),
        });
        prefs.remember_last_lark_task(Some("task-abc"));
        prefs.flush().unwrap();

        let after_restart = PreferencesStore::load(file(&dir)).get();
        assert!(!after_restart.floating_bar.visible);
        assert_eq!(after_restart.floating_bar.x, Some(12.0));
        assert_eq!(after_restart.floating_bar.y, Some(34.0));
        assert_eq!(
            after_restart.last_lark_task_guid.as_deref(),
            Some("task-abc")
        );
    }

    #[test]
    fn does_not_rewrite_or_notify_when_the_task_has_not_changed() {
        let dir = TempDir::new("prefs");
        let mut prefs = PreferencesStore::load(file(&dir));
        let (_, first) = prefs.remember_last_lark_task(Some("task-abc"));
        assert!(first, "the first remember is a change");

        // The caller notifies listeners and schedules a write only when this flag is true.
        let (snapshot, changed) = prefs.remember_last_lark_task(Some("task-abc"));

        // Start is called on every tracking start; a no-op must not churn the disk.
        assert!(!changed);
        assert_eq!(snapshot.last_lark_task_guid.as_deref(), Some("task-abc"));
        assert!(
            !file(&dir).exists(),
            "nothing is written until the caller flushes"
        );
    }

    #[test]
    fn ignores_a_corrupt_guid_rather_than_losing_the_whole_preferences_file() {
        let dir = TempDir::new("prefs");
        fs::write(
            file(&dir),
            r#"{"floatingBar":{"visible":false,"x":5,"y":6},"lastLarkTaskGuid":42}"#,
        )
        .unwrap();

        let prefs = PreferencesStore::load(file(&dir)).get();
        assert!(!prefs.floating_bar.visible);
        assert_eq!(prefs.floating_bar.x, Some(5.0));
        assert_eq!(prefs.floating_bar.y, Some(6.0));
        assert_eq!(prefs.last_lark_task_guid, None);
    }
}
