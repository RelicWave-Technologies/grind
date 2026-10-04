//! Errors of the small JSON files next to `agent.db`.

use std::io;

use thiserror::Error;
use timo_core::js::ser::SerError;

/// What can go wrong reading or writing `preferences.json` / `workspace-time.json`.
#[derive(Debug, Error)]
pub enum FileStoreError {
    /// The file system refused (a missing file is `Io` with `ErrorKind::NotFound`).
    #[error("file: {0}")]
    Io(#[from] io::Error),
    /// The file is not JSON.
    #[error("file is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// The value could not be written as JSON.
    #[error("value could not be written as JSON: {0}")]
    Ser(#[from] SerError),
    /// Port of `new Error('invalid_workspace_time_cache')`.
    #[error("invalid_workspace_time_cache")]
    InvalidWorkspaceTimeCache,
}

impl FileStoreError {
    /// `err.code === 'ENOENT'`: the file simply is not there (not worth a warning).
    #[must_use]
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::Io(e) if e.kind() == io::ErrorKind::NotFound)
    }
}
