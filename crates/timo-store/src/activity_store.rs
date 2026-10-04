//! Local per-minute activity sample queue. Counts and content-free CVs only.
//!
//! Port of `legacy/agent/src/main/services/activity/store.ts`. The SQL is the
//! TypeScript's, character for character, and every number a caller hands in is
//! bound as a double, which is how better-sqlite3 binds anything that is not an
//! int32: SQLite's column affinity then stores `1791133380000.0` as an INTEGER
//! and `1.5` as a REAL, exactly as it does for the Electron agent.

use rusqlite::{Connection, Result, Row, named_params};
use serde::{Deserialize, Serialize};

use crate::row_value::{number_at, opt_number_at, opt_string_at, string_at};

/// Port of `ActivityRow`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub id: String,
    pub time_entry_id: Option<String>,
    pub bucket_start: f64,
    pub keystrokes: f64,
    pub clicks: f64,
    pub mouse_distance_px: f64,
    pub scroll_events: f64,
    pub iki_cv: Option<f64>,
    pub move_speed_cv: Option<f64>,
    pub path_straightness: Option<f64>,
    pub active_app: Option<String>,
    pub active_app_bundle: Option<String>,
    pub active_title: Option<String>,
    pub active_url: Option<String>,
    pub synced: f64,
}

/// Port of `PolicyFlags` (`@grind/types`): which active-window fields may be kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyFlags {
    pub capture_apps: bool,
    pub capture_titles: bool,
    pub capture_urls: bool,
}

/// Port of the result of `ActivityStore.countSince`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCounts {
    pub keystrokes: f64,
    pub clicks: f64,
    pub scroll_events: f64,
}

/// Port of the result of `ActivityStore.aggregate`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAggregate {
    pub minutes: f64,
    pub keystrokes: f64,
    pub clicks: f64,
    pub mouse_distance_px: f64,
    pub scroll_events: f64,
}

const SCHEMA: &str = "
      CREATE TABLE IF NOT EXISTS activity_samples (
        id            TEXT PRIMARY KEY,
        time_entry_id TEXT,
        bucket_start  INTEGER NOT NULL,
        keystrokes    INTEGER NOT NULL,
        clicks        INTEGER NOT NULL,
        mouse_dist_px INTEGER NOT NULL,
        scroll_events INTEGER NOT NULL,
        iki_cv        REAL,
        move_speed_cv REAL,
        path_straight REAL,
        synced        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_activity_bucket ON activity_samples(bucket_start);
      CREATE INDEX IF NOT EXISTS idx_activity_synced ON activity_samples(synced);
    ";

/// Columns added after the first release; each is added on every boot and the
/// "duplicate column" failure is swallowed.
const ADDED_COLUMNS: [&str; 4] = [
    "active_app TEXT",
    "active_app_bundle TEXT",
    "active_title TEXT",
    "active_url TEXT",
];

const INSERT: &str = "INSERT INTO activity_samples
          (id, time_entry_id, bucket_start, keystrokes, clicks, mouse_dist_px, scroll_events,
           iki_cv, move_speed_cv, path_straight,
           active_app, active_app_bundle, active_title, active_url, synced)
         VALUES (@id, @timeEntryId, @bucketStart, @keystrokes, @clicks, @mouseDistancePx, @scrollEvents,
           @ikiCv, @moveSpeedCv, @pathStraightness,
           @activeApp, @activeAppBundle, @activeTitle, @activeUrl, 0)";

/// Port of `ActivityStore`. Owns its connection, like the TypeScript's own `Database`.
#[derive(Debug)]
pub struct ActivityStore {
    conn: Connection,
}

impl ActivityStore {
    /// Port of `ActivityStore.constructor`.
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA)?;
        // Idempotent column adds: SQLite has no `ADD COLUMN IF NOT EXISTS`, so
        // every failure is swallowed, as the TypeScript does.
        for column in ADDED_COLUMNS {
            let sql = format!("ALTER TABLE activity_samples ADD COLUMN {column}");
            if let Err(error) = conn.execute_batch(&sql) {
                tracing::debug!(%error, column, "activity column already added on a prior boot");
            }
        }
        Ok(Self { conn })
    }

    /// The connection, for diagnostics and tests.
    #[must_use]
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Hands the connection back (a second store over the same database, as a reboot is).
    #[must_use]
    pub fn into_connection(self) -> Connection {
        self.conn
    }

    /// Port of `legacy/agent/src/main/services/activity/store.ts::ActivityStore.insert`.
    pub fn insert(&self, r: &ActivityRow) -> Result<()> {
        self.conn.execute(
            INSERT,
            named_params! {
                "@id": r.id,
                "@timeEntryId": r.time_entry_id,
                "@bucketStart": r.bucket_start,
                "@keystrokes": r.keystrokes,
                "@clicks": r.clicks,
                "@mouseDistancePx": r.mouse_distance_px,
                "@scrollEvents": r.scroll_events,
                "@ikiCv": r.iki_cv,
                "@moveSpeedCv": r.move_speed_cv,
                "@pathStraightness": r.path_straightness,
                "@activeApp": r.active_app,
                "@activeAppBundle": r.active_app_bundle,
                "@activeTitle": r.active_title,
                "@activeUrl": r.active_url,
            },
        )?;
        Ok(())
    }

    /// Port of `legacy/agent/src/main/services/activity/store.ts::ActivityStore.unsynced`.
    pub fn unsynced(&self, limit: f64) -> Result<Vec<ActivityRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM activity_samples WHERE synced = 0 ORDER BY bucket_start ASC LIMIT ?",
        )?;
        stmt.query_map([limit], map)?.collect()
    }

    /// Port of `legacy/agent/src/main/services/activity/store.ts::ActivityStore.markSynced`
    /// (one transaction for the whole list).
    pub fn mark_synced(&mut self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare("UPDATE activity_samples SET synced = 1 WHERE id = ?")?;
            for id in ids {
                stmt.execute([id])?;
            }
        }
        tx.commit()
    }

    /// Port of `legacy/agent/src/main/services/activity/store.ts::ActivityStore.scrubActiveFields`.
    pub fn scrub_active_fields(&self, policy: PolicyFlags) -> Result<usize> {
        match scrub_sql(policy) {
            Some(sql) => self.conn.execute(&sql, []),
            None => Ok(0),
        }
    }

    /// Port of `legacy/agent/src/main/services/activity/store.ts::ActivityStore.countSince`.
    pub fn count_since(&self, since_ms: f64) -> Result<ActivityCounts> {
        self.conn.query_row(
            "SELECT COALESCE(SUM(keystrokes),0) k, COALESCE(SUM(clicks),0) c, COALESCE(SUM(scroll_events),0) s
         FROM activity_samples WHERE bucket_start >= ?",
            [since_ms],
            |r| {
                Ok(ActivityCounts {
                    keystrokes: number_at(r, "k")?,
                    clicks: number_at(r, "c")?,
                    scroll_events: number_at(r, "s")?,
                })
            },
        )
    }

    /// Port of `legacy/agent/src/main/services/activity/store.ts::ActivityStore.aggregate`:
    /// summed counts and minute count for a `[from, to)` window.
    pub fn aggregate(&self, from_ms: f64, to_ms: f64) -> Result<ActivityAggregate> {
        self.conn.query_row(
            "SELECT COUNT(*) n, COALESCE(SUM(keystrokes),0) k, COALESCE(SUM(clicks),0) c,
                COALESCE(SUM(mouse_dist_px),0) d, COALESCE(SUM(scroll_events),0) s
         FROM activity_samples WHERE bucket_start >= ? AND bucket_start < ?",
            [from_ms, to_ms],
            |r| {
                Ok(ActivityAggregate {
                    minutes: number_at(r, "n")?,
                    keystrokes: number_at(r, "k")?,
                    clicks: number_at(r, "c")?,
                    mouse_distance_px: number_at(r, "d")?,
                    scroll_events: number_at(r, "s")?,
                })
            },
        )
    }
}

/// The `UPDATE` that blanks the fields a policy forbids, or `None` when it
/// forbids nothing. Port of the statement built in
/// `legacy/agent/src/main/services/activity/store.ts::ActivityStore.scrubActiveFields`.
#[must_use]
pub fn scrub_sql(policy: PolicyFlags) -> Option<String> {
    let mut sets: Vec<&str> = Vec::new();
    if policy.capture_apps {
        if !policy.capture_titles {
            sets.push("active_title = NULL");
        }
        if !policy.capture_urls {
            sets.push("active_url = NULL");
        }
    } else {
        sets.extend([
            "active_app = NULL",
            "active_app_bundle = NULL",
            "active_title = NULL",
            "active_url = NULL",
        ]);
    }
    (!sets.is_empty()).then(|| format!("UPDATE activity_samples SET {}", sets.join(", ")))
}

/// Port of `legacy/agent/src/main/services/activity/store.ts::map`.
fn map(r: &Row<'_>) -> Result<ActivityRow> {
    Ok(ActivityRow {
        id: string_at(r, "id")?,
        time_entry_id: opt_string_at(r, "time_entry_id")?,
        bucket_start: number_at(r, "bucket_start")?,
        keystrokes: number_at(r, "keystrokes")?,
        clicks: number_at(r, "clicks")?,
        mouse_distance_px: number_at(r, "mouse_dist_px")?,
        scroll_events: number_at(r, "scroll_events")?,
        iki_cv: opt_number_at(r, "iki_cv")?,
        move_speed_cv: opt_number_at(r, "move_speed_cv")?,
        path_straightness: opt_number_at(r, "path_straight")?,
        active_app: opt_string_at(r, "active_app")?,
        active_app_bundle: opt_string_at(r, "active_app_bundle")?,
        active_title: opt_string_at(r, "active_title")?,
        active_url: opt_string_at(r, "active_url")?,
        synced: number_at(r, "synced")?,
    })
}
