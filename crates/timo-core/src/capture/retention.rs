//! Port of `legacy/agent/src/main/services/capture/retention.ts`: the retention
//! and reconciliation planner for the local screenshot cache.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::js::math::mul;
use crate::js::number::sub;

const DAY_MS: f64 = 86_400_000.0;

/// Port of `RetentionRow`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionRow {
    pub id: String,
    pub file_path: String,
    pub captured_at: f64,
}

/// Port of `RetentionInput`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionInput {
    pub rows: Vec<RetentionRow>,
    pub files_on_disk: Vec<String>,
    pub now: f64,
    pub retention_days: f64,
}

/// Port of `RetentionPlan`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPlan {
    pub files_to_delete: Vec<String>,
    pub row_ids_to_delete: Vec<String>,
    pub expired: usize,
    pub orphan_files: usize,
    pub dangling_rows: usize,
}

/// An insertion-ordered set of strings, like a JavaScript `Set<string>`.
#[derive(Default)]
struct OrderedSet {
    seen: HashSet<String>,
    items: Vec<String>,
}

impl OrderedSet {
    fn insert(&mut self, value: &str) {
        if self.seen.insert(value.to_owned()) {
            self.items.push(value.to_owned());
        }
    }
}

/// Port of `planScreenshotRetention`.
#[must_use]
pub fn plan_screenshot_retention(input: &RetentionInput) -> RetentionPlan {
    let expire = input.retention_days > 0.0;
    let cutoff = sub(input.now, mul(input.retention_days, DAY_MS));

    let disk: HashSet<&str> = input.files_on_disk.iter().map(String::as_str).collect();
    let row_paths: HashSet<&str> = input.rows.iter().map(|r| r.file_path.as_str()).collect();

    let mut files = OrderedSet::default();
    let mut row_ids = OrderedSet::default();
    let mut expired = 0;
    let mut dangling_rows = 0;

    for r in &input.rows {
        if expire && r.captured_at < cutoff {
            expired += 1;
            row_ids.insert(&r.id);
            if disk.contains(r.file_path.as_str()) {
                files.insert(&r.file_path);
            }
        } else if !disk.contains(r.file_path.as_str()) {
            // File gone but row not yet expired: drop the dangling row.
            dangling_rows += 1;
            row_ids.insert(&r.id);
        }
    }

    let mut orphan_files = 0;
    for f in &input.files_on_disk {
        if !row_paths.contains(f.as_str()) {
            orphan_files += 1;
            files.insert(f);
        }
    }

    RetentionPlan {
        files_to_delete: files.items,
        row_ids_to_delete: row_ids.items,
        expired,
        orphan_files,
        dangling_rows,
    }
}
