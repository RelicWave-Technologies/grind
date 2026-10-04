use serde::{Serialize, Serializer};

/// What a command rejects with. Serialized as its message, which is what the
/// renderer's `Error` carries (Electron's `ipcRenderer.invoke` rejected with one).
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Tauri(#[from] tauri::Error),
    #[error("could not resolve {0}")]
    Path(&'static str),
}

impl Serialize for CommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
