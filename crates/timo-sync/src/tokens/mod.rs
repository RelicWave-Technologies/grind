//! The signed-in session on this machine.
//!
//! Port of `legacy/agent/src/main/services/tokenStore.ts`. The Electron agent
//! kept the session in `tokens.bin`, encrypted with `safeStorage`; the Rust app
//! keeps it in the OS keychain ([`KeychainTokenStore`]) and, once, imports the
//! old file ([`legacy`]). What carries over unchanged is the contract: every
//! mutation runs one at a time, and a rotation or a sign-out only ever applies
//! to the exact session that asked for it.

mod keychain;
pub mod legacy;
mod memory;
mod vault;

use std::future::Future;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use keychain::KeychainTokenStore;
pub use memory::MemoryTokenStore;
pub use vault::{
    KEYCHAIN_SERVICE, KeyringVault, MAX_SECRET_BYTES, MemoryVault, PENDING_LOGIN_SLOT, SecretVault,
    TOKENS_SLOT, VaultError,
};

/// Port of `tokenStore.ts::StoredTokens`. Field order is the JSON key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
    pub workspace_id: String,
}

impl StoredTokens {
    /// Port of `tokenStore.ts::isStoredTokens`: all four parts non-empty.
    #[must_use]
    pub fn is_valid(&self) -> bool {
        [
            &self.access_token,
            &self.refresh_token,
            &self.user_id,
            &self.workspace_id,
        ]
        .iter()
        .all(|part| !part.is_empty())
    }
}

/// A token store failure. The TypeScript lets the raw error propagate.
#[derive(Debug, Clone, Error)]
pub enum TokenError {
    /// `new Error('invalid_token_payload')`.
    #[error("invalid_token_payload")]
    InvalidPayload,
    #[error("{0}")]
    Vault(String),
}

impl From<VaultError> for TokenError {
    fn from(err: VaultError) -> Self {
        Self::Vault(err.to_string())
    }
}

/// The five operations of `tokenStore.ts`, as `apiClient.ts` and `auth.ts` use them.
pub trait TokenStore: Send + Sync + 'static {
    /// `loadTokens`: waits for pending mutations, then reads.
    fn load(&self) -> impl Future<Output = Result<Option<StoredTokens>, TokenError>> + Send;
    /// `saveTokens`.
    fn save(&self, tokens: StoredTokens) -> impl Future<Output = Result<(), TokenError>> + Send;
    /// `replaceTokensIfMatch`: rotate only the session that initiated the refresh.
    fn replace_if_match(
        &self,
        expected: &StoredTokens,
        next: StoredTokens,
    ) -> impl Future<Output = Result<bool, TokenError>> + Send;
    /// `clearTokens`.
    fn clear(&self) -> impl Future<Output = Result<(), TokenError>> + Send;
    /// `clearTokensIfMatch`: delete only the exact rejected session.
    fn clear_if_match(
        &self,
        expected: &StoredTokens,
    ) -> impl Future<Output = Result<bool, TokenError>> + Send;
}
