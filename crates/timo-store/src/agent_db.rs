//! Opening `agent.db`.

use std::path::Path;

use rusqlite::{Connection, Result};

/// Port of `new Database(path.join(userData, 'agent.db'))`: opens (or creates)
/// the file and sets nothing else.
///
/// The PRAGMAs (`journal_mode = WAL`, `synchronous = FULL`, `busy_timeout`) are
/// the timer store's business; it sets them on its own connection, exactly as
/// `SqliteEntryStore` does. WAL is persistent in the file header, so every other
/// connection to the file inherits it. SQLite's own default busy timeout is none;
/// rusqlite, like better-sqlite3, installs a 5 s one on every connection it opens.
pub fn open_agent_db(path: &Path) -> Result<Connection> {
    Connection::open(path)
}
