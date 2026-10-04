//! The one connection both timer stores share.
//!
//! The TypeScript hands one `better-sqlite3` `Database` to both stores. Here the
//! connection sits behind a mutex that is only ever held for one store call.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rusqlite::Connection;
use timo_core::timer::TimerError;

/// A connection shared by the timer stores.
pub type SharedDb = Arc<Mutex<Connection>>;

/// Wrap a connection for sharing.
#[must_use]
pub fn shared(connection: Connection) -> SharedDb {
    Arc::new(Mutex::new(connection))
}

/// A fresh `:memory:` database (tests and the parity harness).
pub fn open_in_memory() -> Result<SharedDb, TimerError> {
    Connection::open_in_memory().map(shared).map_err(db_err)
}

/// A SQLite failure as the thrown `Error` the TypeScript has: its message.
#[must_use]
#[allow(
    clippy::needless_pass_by_value,
    reason = "used directly as a `map_err` callback"
)]
pub fn db_err(error: rusqlite::Error) -> TimerError {
    TimerError::Store(error.to_string())
}

/// Lock the connection (a poisoned lock still holds a usable connection).
pub(crate) fn lock(db: &SharedDb) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(PoisonError::into_inner)
}
