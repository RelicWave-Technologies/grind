//! In-memory [`TokenStore`] with the same compare-and-swap rules as the keychain
//! one, for tests of everything that sits on top of the store.

use std::sync::Mutex;

use super::{StoredTokens, TokenError, TokenStore};

#[derive(Debug, Default)]
pub struct MemoryTokenStore {
    current: Mutex<Option<StoredTokens>>,
}

impl MemoryTokenStore {
    #[must_use]
    pub fn new(initial: Option<StoredTokens>) -> Self {
        Self {
            current: Mutex::new(initial),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<StoredTokens>>, TokenError> {
        self.current
            .lock()
            .map_err(|_| TokenError::Vault("memory token store poisoned".to_owned()))
    }
}

impl TokenStore for MemoryTokenStore {
    async fn load(&self) -> Result<Option<StoredTokens>, TokenError> {
        Ok(self.lock()?.clone())
    }

    async fn save(&self, tokens: StoredTokens) -> Result<(), TokenError> {
        if !tokens.is_valid() {
            return Err(TokenError::InvalidPayload);
        }
        *self.lock()? = Some(tokens);
        Ok(())
    }

    async fn replace_if_match(
        &self,
        expected: &StoredTokens,
        next: StoredTokens,
    ) -> Result<bool, TokenError> {
        let mut current = self.lock()?;
        if current.as_ref() != Some(expected) {
            return Ok(false);
        }
        if !next.is_valid() {
            return Err(TokenError::InvalidPayload);
        }
        *current = Some(next);
        Ok(true)
    }

    async fn clear(&self) -> Result<(), TokenError> {
        *self.lock()? = None;
        Ok(())
    }

    async fn clear_if_match(&self, expected: &StoredTokens) -> Result<bool, TokenError> {
        let mut current = self.lock()?;
        if current.as_ref() != Some(expected) {
            return Ok(false);
        }
        *current = None;
        Ok(true)
    }
}
