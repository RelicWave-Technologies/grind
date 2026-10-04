//! Behaviour of the file layer that the fixtures cannot see: modes, temp files, failure
//! clean-up, and a real `agent.db` surviving a reopen.
#![cfg(test)]

mod store_support;

use std::fs;

use store_support::TempDir;
use timo_store::activity_store::{ActivityRow, ActivityStore};
use timo_store::agent_db::open_agent_db;
use timo_store::atomic_write::{temp_path, write_atomic};
use timo_store::preferences::{FloatingBarPatch, PreferencesStore, serialize};

#[test]
fn an_atomic_write_replaces_the_file_and_leaves_no_temp_file() {
    let dir = TempDir::new("atomic");
    let target = dir.path().join("preferences.json");
    fs::write(&target, "old").unwrap();

    write_atomic(&target, b"new").unwrap();

    assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    assert!(!temp_path(&target).exists());
}

#[test]
fn the_temp_file_is_named_after_the_target_and_the_process() {
    let target = std::path::Path::new("/data/Timo/preferences.json");
    let expected = format!("/data/Timo/preferences.json.{}.tmp", std::process::id());
    assert_eq!(temp_path(target).to_string_lossy(), expected);
}

#[cfg(unix)]
#[test]
fn the_written_file_is_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt as _;

    let dir = TempDir::new("atomic");
    let target = dir.path().join("workspace-time.json");

    write_atomic(&target, b"{}").unwrap();

    let mode = fs::metadata(&target).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn a_failed_write_reports_the_error_and_removes_its_temp_file() {
    let dir = TempDir::new("atomic");
    // The target is a directory, so the rename cannot replace it.
    let target = dir.path().join("a-directory");
    fs::create_dir(&target).unwrap();

    assert!(write_atomic(&target, b"x").is_err());
    assert!(!temp_path(&target).exists());
}

#[test]
fn preferences_are_written_as_json_stringify_with_two_space_indent() {
    let dir = TempDir::new("prefs");
    let mut prefs = PreferencesStore::load(dir.path().join("preferences.json"));
    prefs.patch_floating_bar(FloatingBarPatch {
        visible: Some(false),
        x: Some(Some(12.5)),
        y: Some(None),
    });
    prefs.remember_last_lark_task(Some("a\"b"));

    let expected = "{\n  \"floatingBar\": {\n    \"visible\": false,\n    \"x\": 12.5,\n    \"y\": null\n  },\n  \"lastLarkTaskGuid\": \"a\\\"b\"\n}";
    assert_eq!(serialize(&prefs.get()), expected);
    prefs.flush().unwrap();
    assert_eq!(fs::read_to_string(prefs.path()).unwrap(), expected);
}

#[test]
fn a_flush_into_a_missing_directory_is_an_error_not_a_panic() {
    let dir = TempDir::new("prefs");
    let prefs = PreferencesStore::load(dir.path().join("missing").join("preferences.json"));
    assert!(prefs.flush().is_err());
}

#[test]
fn agent_db_is_a_real_file_that_keeps_its_rows_across_a_reopen() {
    let dir = TempDir::new("db");
    let path = dir.path().join("agent.db");
    let row = ActivityRow {
        id: "a1".to_owned(),
        time_entry_id: None,
        bucket_start: 1_791_133_383_891.262_7,
        keystrokes: 3.0,
        clicks: 1.0,
        mouse_distance_px: 10.0,
        scroll_events: 0.0,
        iki_cv: Some(0.5),
        move_speed_cv: None,
        path_straightness: None,
        active_app: None,
        active_app_bundle: None,
        active_title: None,
        active_url: None,
        synced: 0.0,
    };
    ActivityStore::new(open_agent_db(&path).unwrap())
        .unwrap()
        .insert(&row)
        .unwrap();

    let reopened = ActivityStore::new(open_agent_db(&path).unwrap()).unwrap();

    assert_eq!(reopened.unsynced(10.0).unwrap(), vec![row]);
}
