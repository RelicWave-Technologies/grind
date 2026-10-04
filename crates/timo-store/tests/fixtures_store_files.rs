//! The small JSON files and the legacy migration against golden output from the real
//! TypeScript. `preferences.ts`, `workspaceTime.ts` and `legacyMigration.ts` import
//! `electron`, so the generators (`parity/src/gen/store{Preferences,WorkspaceTime,Migration}.ts`)
//! run VERBATIM COPIES of their pure functions (file and line cited there) as the oracle.
#![cfg(test)]
#![allow(
    clippy::print_stderr,
    reason = "the scratch-directory cleanup reports what it could not remove"
)]

mod store_support;

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use store_support::{TempDir, assert_cases};
use timo_core::js::number::number_to_string;
use timo_store::legacy_migration::migrate_legacy_user_data;
use timo_store::preferences::{FloatingBarPatch, Preferences, PreferencesStore};
use timo_store::workspace_time_file::{read_persisted, serialize_persisted, write_persisted};

/// The inverse of `parity/src/gen/jsEncoding.ts::enc`, for a patch value.
fn decode(value: &Value) -> Option<f64> {
    match value {
        Value::Null => None,
        Value::Number(n) => n.as_f64(),
        Value::String(s) => Some(match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => panic!("bad encoded double {other}"),
        }),
        other => panic!("bad patch value {other}"),
    }
}

fn patch_of(patch: &Value) -> FloatingBarPatch {
    FloatingBarPatch {
        visible: patch.get("visible").and_then(Value::as_bool),
        x: patch.get("x").map(decode),
        y: patch.get("y").map(decode),
    }
}

fn snapshot(prefs: &Preferences) -> Value {
    json!({
        "floatingBar": { "visible": prefs.floating_bar.visible, "x": prefs.floating_bar.x, "y": prefs.floating_bar.y },
        "lastLarkTaskGuid": prefs.last_lark_task_guid,
    })
}

fn replay_preferences(case: &Value) -> Value {
    let dir = TempDir::new("prefs");
    let path = dir.path().join("preferences.json");
    if let Some(raw) = case["raw"].as_str() {
        fs::write(&path, raw).expect("write raw");
    }
    let mut store = PreferencesStore::load(path.clone());
    let initial = snapshot(&store.get());
    let results: Vec<Value> = case["ops"]
        .as_array()
        .expect("ops")
        .iter()
        .map(|op| match op["op"].as_str().expect("op") {
            "patch" => json!({ "snapshot": snapshot(&store.patch_floating_bar(patch_of(&op["patch"]))), "changed": true }),
            "remember" => {
                let (prefs, changed) = store.remember_last_lark_task(op["guid"].as_str());
                json!({ "snapshot": snapshot(&prefs), "changed": changed })
            }
            "get" => json!({ "snapshot": snapshot(&store.get()), "changed": false }),
            other => panic!("unexpected op {other}"),
        })
        .collect();
    store.flush().expect("flush");
    let file = fs::read_to_string(&path).expect("read flushed file");
    json!({ "initial": initial, "results": results, "file": file })
}

fn replay_workspace_time(case: &Value) -> Value {
    let dir = TempDir::new("wst");
    let path = dir.path().join("workspace-time.json");
    if let Some(raw) = case["raw"].as_str() {
        fs::write(&path, raw).expect("write raw");
    }
    let valid: Vec<&str> = case["valid"]
        .as_array()
        .expect("valid")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    match read_persisted(&path, |zone| valid.contains(&zone)) {
        Ok(persisted) => {
            let written = serialize_persisted(&persisted).expect("serialize");
            // The atomic write puts those same bytes on disk, mode 0600 where modes exist.
            let target = dir.path().join("out.json");
            write_persisted(&target, &persisted).expect("write");
            assert_eq!(fs::read_to_string(&target).expect("read back"), written);
            assert_no_temp_files(dir.path());
            json!({
                "parsed": { "workspaceId": persisted.workspace_id, "timeZone": persisted.time_zone },
                "failure": null,
                "written": written,
            })
        }
        Err(error) => json!({
            "parsed": null,
            "failure": if error.is_not_found() { "missing" } else { "unusable" },
            "written": null,
        }),
    }
}

fn assert_no_temp_files(dir: &Path) {
    let leftovers: Vec<_> = fs::read_dir(dir)
        .expect("read dir")
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "temp files left behind: {leftovers:?}"
    );
}

/// Port of `parity/src/gen/storeMigration.ts::dumpTree`: `[relative path, 'f' | 'd', text]`, sorted.
fn dump_tree(root: &Path) -> Value {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, &'static str, Option<String>)>) {
        for entry in fs::read_dir(dir).expect("read dir") {
            let full = entry.expect("entry").path();
            let rel = full
                .strip_prefix(root)
                .expect("under root")
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            if full.is_dir() {
                out.push((rel, "d", None));
                walk(root, &full, out);
            } else {
                out.push((
                    rel,
                    "f",
                    Some(fs::read_to_string(&full).expect("read file")),
                ));
            }
        }
    }
    let mut entries = Vec::new();
    walk(root, root, &mut entries);
    entries.sort();
    Value::Array(
        entries
            .into_iter()
            .map(|(rel, kind, text)| json!([rel, kind, text]))
            .collect(),
    )
}

fn replay_migration(case: &Value) -> Value {
    let root = TempDir::new("mig");
    for (rel, content) in case["tree"].as_object().expect("tree") {
        let full = root.path().join(rel);
        match content {
            Value::Null => fs::create_dir_all(&full).expect("mkdir"),
            Value::String(text) => {
                fs::create_dir_all(full.parent().expect("parent")).expect("mkdir parent");
                fs::write(&full, text).expect("write file");
            }
            other => panic!("bad tree entry {other}"),
        }
    }
    migrate_legacy_user_data(&root.path().join("Timo"));
    dump_tree(root.path())
}

#[test]
fn preferences_match_the_typescript() {
    assert_cases("preferences", replay_preferences);
}

#[test]
fn workspace_time_cache_matches_the_typescript() {
    assert_cases("workspace_time", replay_workspace_time);
}

#[test]
fn legacy_migration_matches_the_typescript() {
    assert_cases("legacy_migration", replay_migration);
}

#[test]
fn the_pretty_printer_writes_numbers_as_javascript_does() {
    // JSON.stringify(1e21) is "1e+21"; the preferences file holds positions through the same writer.
    assert_eq!(number_to_string(1e21), "1e+21");
}
