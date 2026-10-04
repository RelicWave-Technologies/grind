//! The timer's tables: `local_entries`, `timer_meta`, `server_entry_cache`,
//! `server_snapshot_meta`.
//!
//! Port of `legacy/agent/src/main/services/timer/sqliteStore.ts` and
//! `todayLedgerStore.ts`. The SQL text, the PRAGMAs and the migrations are the
//! TypeScript's, so a database written by the Electron agent opens unchanged.

mod claim;
mod db;
mod effective;
mod entry_rows;
mod entry_store;
mod js_number;
mod ledger_snapshot;
mod meta;
mod migrations;
mod parse;
mod today_ledger_store;
mod writes;

pub use db::{SharedDb, open_in_memory, shared};
pub use entry_store::SqliteEntryStore;
pub use ledger_snapshot::SnapshotAt;
pub use today_ledger_store::{DeviceNow, SqliteTodayLedgerStore};
