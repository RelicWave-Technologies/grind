//! 1:1 port of `legacy/agent/src/main/services/capture/store.test.ts`.
#![cfg(test)]

use rusqlite::Connection;
use timo_store::capture_store::ScreenshotStore;

fn column_names(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>("name"))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn index_names(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA index_list({table})"))
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>("name"))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

mod screenshot_store_migrations {
    use super::*;

    #[test]
    fn adds_retry_columns_before_creating_indexes_on_older_local_databases() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
      CREATE TABLE screenshots (
        id           TEXT PRIMARY KEY,
        time_entry_id TEXT,
        display_id   TEXT NOT NULL,
        captured_at  INTEGER NOT NULL,
        file_path    TEXT NOT NULL,
        bytes        INTEGER NOT NULL,
        width        INTEGER NOT NULL,
        height       INTEGER NOT NULL,
        upload_state TEXT NOT NULL DEFAULT 'pending',
        attempts     INTEGER NOT NULL DEFAULT 0,
        s3_key       TEXT
      );
      CREATE INDEX idx_shots_captured ON screenshots(captured_at);
      CREATE INDEX idx_shots_upload ON screenshots(upload_state);
    ",
        )
        .unwrap();

        let store =
            ScreenshotStore::new(conn, 0.0).expect("opens an older database without throwing");

        let cols = column_names(store.connection(), "screenshots");
        for wanted in ["last_error", "next_attempt_at", "failed_at"] {
            assert!(
                cols.iter().any(|c| c == wanted),
                "missing column {wanted} in {cols:?}"
            );
        }
        let indexes = index_names(store.connection(), "screenshots");
        assert!(
            indexes.iter().any(|i| i == "idx_shots_next_attempt"),
            "{indexes:?}"
        );
    }
}

mod recovering_a_backlog_written_off_during_a_storage_outage {
    use super::*;

    /// A store over the database, as the agent builds it.
    fn open_store(conn: Connection) -> ScreenshotStore {
        ScreenshotStore::new(conn, 1_700_000_000_000.0).unwrap()
    }

    fn seed(conn: &Connection, rows: &[(&str, &str, i64)]) {
        for (id, state, attempts) in rows {
            conn.execute(
                "INSERT INTO screenshots (id, display_id, captured_at, file_path, bytes, width, height, upload_state, attempts, failed_at, last_error)
         VALUES (?, 'd', 1, '/tmp/' || ?, 1, 1, 1, ?, ?, 1, 'boom')",
                rusqlite::params![id, id, state, attempts],
            )
            .unwrap();
        }
    }

    fn state_of(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT upload_state FROM screenshots WHERE id = ?",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn puts_failed_shots_back_in_the_queue_once() {
        let store = open_store(Connection::open_in_memory().unwrap()); // creates the schema
        seed(
            store.connection(),
            &[("a", "failed", 5), ("b", "failed", 5), ("c", "uploaded", 1)],
        );
        // Reopening runs the recovery against the rows now present.
        store
            .connection()
            .execute("DELETE FROM capture_meta", [])
            .unwrap();
        let store = open_store(store.into_connection());

        let mut stmt = store
            .connection()
            .prepare(
                "SELECT id, attempts FROM screenshots WHERE upload_state='pending' ORDER BY id",
            )
            .unwrap();
        let pending: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(pending, vec![("a".to_owned(), 0), ("b".to_owned(), 0)]);
        // An already-uploaded shot is left alone.
        assert_eq!(state_of(store.connection(), "c"), "uploaded");
    }

    #[test]
    fn does_not_resurrect_dead_rows_on_every_launch() {
        let store = open_store(Connection::open_in_memory().unwrap());
        store
            .connection()
            .execute("DELETE FROM capture_meta", [])
            .unwrap();
        seed(store.connection(), &[("a", "failed", 5)]);
        let store = open_store(store.into_connection()); // recovery runs, marker written

        // The shot fails again for a reason of its own.
        store
            .connection()
            .execute(
                "UPDATE screenshots SET upload_state='failed', attempts=5 WHERE id='a'",
                [],
            )
            .unwrap();
        let store = open_store(store.into_connection()); // a later launch must leave it alone

        assert_eq!(state_of(store.connection(), "a"), "failed");
    }
}
