//! Windows: the AES key in `<userData>/Local State`.
//!
//! Port of `OSCryptImpl::InitWithExistingKey` (`os_crypt_win.cc`): read
//! `os_crypt.encrypted_key`, base64-decode, require the `DPAPI` marker, strip it,
//! DPAPI-unprotect the rest. DPAPI itself is a Win32 call, so it comes in through
//! [`KeyUnprotector`]; the host wires `timo_platform::dpapi` into it (this crate
//! forbids unsafe code and does not depend on `timo-platform`).

use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use thiserror::Error;

use super::keys::{KeyError, OsCryptKey, OsCryptKeySource};

/// `os_crypt_win.cc::kDPAPIKeyPrefix`.
pub const DPAPI_PREFIX: &[u8] = b"DPAPI";
/// `BrowserProcessImpl`: `DIR_SESSION_DATA` + `"Local State"`.
pub const LOCAL_STATE_FILE: &str = "Local State";

/// `CryptUnprotectData` (user scope), as one function.
pub trait KeyUnprotector {
    fn unprotect(&self, blob: &[u8]) -> Result<Vec<u8>, UnprotectError>;
}

/// A DPAPI failure: the OS error text, never the data.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct UnprotectError(pub String);

#[derive(Debug, Clone)]
pub struct LocalStateKeySource<U: KeyUnprotector> {
    path: PathBuf,
    unprotector: U,
}

impl<U: KeyUnprotector> LocalStateKeySource<U> {
    /// `user_data` is Electron's `userData` directory (`%APPDATA%\Timo`).
    #[must_use]
    pub fn new(user_data: &Path, unprotector: U) -> Self {
        Self {
            path: user_data.join(LOCAL_STATE_FILE),
            unprotector,
        }
    }
}

impl<U: KeyUnprotector> OsCryptKeySource for LocalStateKeySource<U> {
    fn load_key(&self) -> Result<OsCryptKey, KeyError> {
        let text =
            std::fs::read(&self.path).map_err(|e| KeyError::LocalStateUnreadable(e.kind()))?;
        let protected = protected_key(&text)?;
        let key = self
            .unprotector
            .unprotect(&protected)
            .map_err(|e| KeyError::Unprotect(e.0))?;
        OsCryptKey::windows_key(key)
    }
}

/// The DPAPI blob inside a `Local State` document.
fn protected_key(local_state: &[u8]) -> Result<Vec<u8>, KeyError> {
    let doc: Value =
        serde_json::from_slice(local_state).map_err(|_| KeyError::LocalStateMalformed)?;
    if !doc.is_object() {
        return Err(KeyError::LocalStateMalformed);
    }
    let encoded = doc
        .pointer("/os_crypt/encrypted_key")
        .and_then(Value::as_str)
        .ok_or(KeyError::EncryptedKeyMissing)?;
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|_| KeyError::EncryptedKeyBase64)?;
    decoded
        .strip_prefix(DPAPI_PREFIX)
        .map(<[u8]>::to_vec)
        .ok_or(KeyError::EncryptedKeyNotDpapi)
}
