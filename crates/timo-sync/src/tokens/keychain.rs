//! [`TokenStore`] over a [`SecretVault`].
//!
//! Port of `tokenStore.ts`' `mutationChain`: one `tokio` mutex (FIFO) stands in
//! for the promise chain, and `load` takes it too, so a read never sees half of
//! a replace. The file-rename dance the TypeScript needed (`.next` slots for a
//! Windows destination lock) has no counterpart: a keychain write is atomic.

use std::sync::Arc;

use tokio::sync::Mutex;

use super::vault::{SecretVault, TOKENS_SLOT, VaultError};
use super::{StoredTokens, TokenError, TokenStore};

#[derive(Debug)]
pub struct KeychainTokenStore<V: SecretVault> {
    vault: Arc<V>,
    chain: Mutex<()>,
}

impl<V: SecretVault> KeychainTokenStore<V> {
    #[must_use]
    pub fn new(vault: Arc<V>) -> Self {
        Self {
            vault,
            chain: Mutex::new(()),
        }
    }

    /// Port of `tokenStore.ts::readTokens`. A stored blob that is not a valid
    /// session reads as no session, as an undecryptable file did.
    async fn read(&self) -> Result<Option<StoredTokens>, TokenError> {
        let vault = Arc::clone(&self.vault);
        let raw = blocking(move || vault.get(TOKENS_SLOT)).await?;
        let Some(bytes) = raw else { return Ok(None) };
        Ok(serde_json::from_slice::<StoredTokens>(&bytes)
            .ok()
            .filter(StoredTokens::is_valid))
    }

    /// Port of `tokenStore.ts::writeTokens`.
    async fn write(&self, tokens: StoredTokens) -> Result<(), TokenError> {
        if !tokens.is_valid() {
            return Err(TokenError::InvalidPayload);
        }
        let bytes = serde_json::to_vec(&tokens).map_err(|e| TokenError::Vault(e.to_string()))?;
        let vault = Arc::clone(&self.vault);
        blocking(move || vault.set(TOKENS_SLOT, &bytes)).await?;
        Ok(())
    }

    async fn remove(&self) -> Result<(), TokenError> {
        let vault = Arc::clone(&self.vault);
        blocking(move || vault.delete(TOKENS_SLOT)).await?;
        Ok(())
    }
}

/// Keychain calls block (and on macOS may wait on a prompt): keep them off the
/// async workers.
async fn blocking<T, F>(op: F) -> Result<T, VaultError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, VaultError> + Send + 'static,
{
    tokio::task::spawn_blocking(op)
        .await
        .map_err(|e| VaultError::Backend(e.to_string()))?
}

impl<V: SecretVault> TokenStore for KeychainTokenStore<V> {
    async fn load(&self) -> Result<Option<StoredTokens>, TokenError> {
        let _turn = self.chain.lock().await;
        self.read().await
    }

    async fn save(&self, tokens: StoredTokens) -> Result<(), TokenError> {
        let _turn = self.chain.lock().await;
        self.write(tokens).await
    }

    async fn replace_if_match(
        &self,
        expected: &StoredTokens,
        next: StoredTokens,
    ) -> Result<bool, TokenError> {
        let _turn = self.chain.lock().await;
        if self.read().await?.as_ref() != Some(expected) {
            return Ok(false);
        }
        self.write(next).await?;
        Ok(true)
    }

    async fn clear(&self) -> Result<(), TokenError> {
        let _turn = self.chain.lock().await;
        self.remove().await
    }

    async fn clear_if_match(&self, expected: &StoredTokens) -> Result<bool, TokenError> {
        let _turn = self.chain.lock().await;
        if self.read().await?.as_ref() != Some(expected) {
            return Ok(false);
        }
        self.remove().await?;
        Ok(true)
    }
}
