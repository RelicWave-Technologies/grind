//! The PKCE verifier of a Lark login that is waiting for the browser.
//!
//! Port of `legacy/agent/src/main/services/pendingLarkLoginStore.ts`. The file
//! `pending-lark-login.bin` (Electron `safeStorage`) becomes one keychain entry.

use std::future::Future;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::tokens::{PENDING_LOGIN_SLOT, SecretVault, TokenError, VaultError};

/// Port of `pendingLarkLoginStore.ts::StoredPendingLarkLogin`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPendingLarkLogin {
    pub verifier: String,
    pub login_url: String,
    /// `Date.now()` when the login began.
    pub created_at: i64,
}

impl StoredPendingLarkLogin {
    /// Port of `pendingLarkLoginStore.ts::coerce` on the parsed bytes: strings
    /// non-empty, `createdAt` a finite number (a whole one, as `Date.now()` is).
    #[must_use]
    pub fn coerce(bytes: &[u8]) -> Option<Self> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            verifier: String,
            login_url: String,
            created_at: f64,
        }
        let raw: Raw = serde_json::from_slice(bytes).ok()?;
        if raw.verifier.is_empty() || raw.login_url.is_empty() {
            return None;
        }
        let created_at = timo_core::js::number::f64_to_i64(raw.created_at).ok()?;
        Some(Self {
            verifier: raw.verifier,
            login_url: raw.login_url,
            created_at,
        })
    }
}

pub trait PendingLoginStore: Send + Sync + 'static {
    /// `loadPendingLarkLogin`: an unreadable entry is cleared and reads as none.
    fn load(&self) -> impl Future<Output = Option<StoredPendingLarkLogin>> + Send;
    /// `savePendingLarkLogin`.
    fn save(
        &self,
        login: &StoredPendingLarkLogin,
    ) -> impl Future<Output = Result<(), TokenError>> + Send;
    /// `clearStoredPendingLarkLogin`: a missing entry is fine.
    fn clear(&self) -> impl Future<Output = ()> + Send;
}

/// [`PendingLoginStore`] over the keychain.
#[derive(Debug)]
pub struct KeychainPendingLoginStore<V: SecretVault> {
    vault: Arc<V>,
}

impl<V: SecretVault> KeychainPendingLoginStore<V> {
    #[must_use]
    pub const fn new(vault: Arc<V>) -> Self {
        Self { vault }
    }

    async fn run<T: Send + 'static>(
        &self,
        op: impl FnOnce(&V) -> Result<T, VaultError> + Send + 'static,
    ) -> Result<T, VaultError> {
        let vault = Arc::clone(&self.vault);
        tokio::task::spawn_blocking(move || op(&vault))
            .await
            .map_err(|e| VaultError::Backend(e.to_string()))?
    }
}

impl<V: SecretVault> PendingLoginStore for KeychainPendingLoginStore<V> {
    async fn load(&self) -> Option<StoredPendingLarkLogin> {
        match self.run(|v| v.get(PENDING_LOGIN_SLOT)).await {
            Ok(None) => None,
            Ok(Some(bytes)) => {
                let parsed = StoredPendingLarkLogin::coerce(&bytes);
                if parsed.is_none() {
                    tracing::warn!("pending lark login: unreadable, clearing");
                    self.clear().await;
                }
                parsed
            }
            Err(err) => {
                tracing::warn!(err = %err, "pending lark login: unreadable, clearing");
                self.clear().await;
                None
            }
        }
    }

    async fn save(&self, login: &StoredPendingLarkLogin) -> Result<(), TokenError> {
        let bytes = crate::wire::json_body(login)
            .map_err(|e| TokenError::Vault(e.message()))?
            .into_bytes();
        self.run(move |v| v.set(PENDING_LOGIN_SLOT, &bytes)).await?;
        Ok(())
    }

    async fn clear(&self) {
        if let Err(err) = self.run(|v| v.delete(PENDING_LOGIN_SLOT)).await {
            tracing::warn!(err = %err, "pending lark login: delete failed");
        }
    }
}

/// In-memory store for tests.
#[derive(Debug, Default)]
pub struct MemoryPendingLoginStore {
    slot: Mutex<Option<StoredPendingLarkLogin>>,
}

impl MemoryPendingLoginStore {
    #[must_use]
    pub fn new(initial: Option<StoredPendingLarkLogin>) -> Self {
        Self {
            slot: Mutex::new(initial),
        }
    }

    /// What is stored right now.
    pub async fn peek(&self) -> Option<StoredPendingLarkLogin> {
        self.slot.lock().await.clone()
    }
}

impl PendingLoginStore for MemoryPendingLoginStore {
    async fn load(&self) -> Option<StoredPendingLarkLogin> {
        self.slot.lock().await.clone()
    }

    async fn save(&self, login: &StoredPendingLarkLogin) -> Result<(), TokenError> {
        *self.slot.lock().await = Some(login.clone());
        Ok(())
    }

    async fn clear(&self) {
        *self.slot.lock().await = None;
    }
}
