//! Where the secret bytes live: the OS keychain.
//!
//! macOS Keychain and Windows Credential Manager through the `keyring` crate.
//! The trait exists so the store logic is proven against [`MemoryVault`]
//! without touching a real keychain (which prompts, and pollutes the user's).

use std::collections::HashMap;
use std::sync::Mutex;

use thiserror::Error;

/// Keychain service name: the app identifier from `tauri.conf.json`.
pub const KEYCHAIN_SERVICE: &str = "com.relicwave.grind";
/// The entry holding the session JSON.
pub const TOKENS_SLOT: &str = "tokens";
/// The entry holding the in-flight Lark login (`pending-lark-login.bin` before).
pub const PENDING_LOGIN_SLOT: &str = "pending-lark-login";
/// Windows Credential Manager refuses a blob over `CRED_MAX_CREDENTIAL_BLOB_SIZE`
/// (2560 bytes); a session is well under 1 KiB, so this is a guard, not a limit
/// anyone meets. Applied on every OS so a failure shows up in tests, not on a PC.
pub const MAX_SECRET_BYTES: usize = 2560;

#[derive(Debug, Clone, Error)]
pub enum VaultError {
    #[error("keychain: {0}")]
    Backend(String),
    #[error("keychain secret is {0} bytes; the limit is {MAX_SECRET_BYTES}")]
    TooLarge(usize),
}

/// Blocking secret storage addressed by slot name.
pub trait SecretVault: Send + Sync + 'static {
    fn get(&self, slot: &str) -> Result<Option<Vec<u8>>, VaultError>;
    fn set(&self, slot: &str, secret: &[u8]) -> Result<(), VaultError>;
    /// Deleting a slot that does not exist is not an error.
    fn delete(&self, slot: &str) -> Result<(), VaultError>;
}

/// The real keychain.
#[derive(Debug, Clone)]
pub struct KeyringVault {
    service: String,
}

impl KeyringVault {
    #[must_use]
    pub fn new() -> Self {
        Self::with_service(KEYCHAIN_SERVICE)
    }

    #[must_use]
    pub fn with_service(service: &str) -> Self {
        Self {
            service: service.to_owned(),
        }
    }

    fn entry(&self, slot: &str) -> Result<keyring::Entry, VaultError> {
        keyring::Entry::new(&self.service, slot).map_err(|e| VaultError::Backend(e.to_string()))
    }
}

impl Default for KeyringVault {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretVault for KeyringVault {
    fn get(&self, slot: &str) -> Result<Option<Vec<u8>>, VaultError> {
        match self.entry(slot)?.inner.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(VaultError::Backend(e.to_string())),
        }
    }

    fn set(&self, slot: &str, secret: &[u8]) -> Result<(), VaultError> {
        if secret.len() > MAX_SECRET_BYTES {
            return Err(VaultError::TooLarge(secret.len()));
        }
        self.entry(slot)?
            .inner
            .set_secret(secret)
            .map_err(|e| VaultError::Backend(e.to_string()))
    }

    fn delete(&self, slot: &str) -> Result<(), VaultError> {
        match self.entry(slot)?.inner.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(VaultError::Backend(e.to_string())),
        }
    }
}

/// In-process vault for tests and for hosts with no keychain.
#[derive(Debug, Default)]
pub struct MemoryVault {
    slots: Mutex<HashMap<String, Vec<u8>>>,
}

impl MemoryVault {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Vec<u8>>>, VaultError> {
        self.slots
            .lock()
            .map_err(|_| VaultError::Backend("memory vault poisoned".to_owned()))
    }
}

impl SecretVault for MemoryVault {
    fn get(&self, slot: &str) -> Result<Option<Vec<u8>>, VaultError> {
        Ok(self.lock()?.get(slot).cloned())
    }

    fn set(&self, slot: &str, secret: &[u8]) -> Result<(), VaultError> {
        if secret.len() > MAX_SECRET_BYTES {
            return Err(VaultError::TooLarge(secret.len()));
        }
        self.lock()?.insert(slot.to_owned(), secret.to_vec());
        Ok(())
    }

    fn delete(&self, slot: &str) -> Result<(), VaultError> {
        self.lock()?.remove(slot);
        Ok(())
    }
}
