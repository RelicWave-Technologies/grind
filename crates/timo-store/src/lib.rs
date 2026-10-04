//! SQLite persistence. Same schema and file as the Electron agent's
//! `agent.db`, so an upgraded install keeps its data.
#![forbid(unsafe_code)]

pub mod timer;

// The non-timer persistence layer: activity, screenshots, Lark task cache, and
// the small files beside `agent.db`.
pub mod activity_store;
pub mod agent_db;
pub mod atomic_write;
pub mod capture_store;
pub mod file_error;
pub mod lark_task_cache;
pub mod legacy_migration;
pub mod paths;
pub mod preferences;
mod preferences_json;
mod row_value;
pub mod workspace_time_file;
