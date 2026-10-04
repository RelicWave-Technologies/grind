//! The one-time move of the Electron agent's session into the OS keychain.
//!
//! The order is the safety: look at the keychain first (a session already there
//! wins, nothing is touched), then the files, and only then ask for the key. The
//! session is written, **read back** and compared before a single file is deleted,
//! so a failed or short keychain write can never cost the user their login.
//!
//! Run it once at startup, before anything can sign in: between the "already
//! present?" look and the write there is no lock, so a login that lands in
//! that window would be overwritten by the old session.

use std::io;
use std::path::Path;
use std::sync::Arc;

use thiserror::Error;

use super::candidates::{PENDING_LOGIN_FILE, remove_files, token_candidates};
use super::format::FormatError;
use super::keys::{KeyError, OsCryptKey, OsCryptKeySource};
use super::scan::{Scan, scan_candidates};
use crate::pending_login::StoredPendingLarkLogin;
use crate::tokens::{
    KeychainTokenStore, PENDING_LOGIN_SLOT, SecretVault, TokenError, TokenStore, VaultError,
};

/// What an import did. Never carries a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportOutcome {
    /// The keychain already holds a valid entry. Nothing was read or changed.
    AlreadyPresent,
    /// No file to import. No key was requested.
    NothingToImport,
    /// Every file decrypted but none holds a valid session. Files left in place.
    NoValidSession { candidates: usize },
    /// Written to the keychain, read back and equal. `skipped` newer-first
    /// candidates were passed over; `leftover` files could not be deleted.
    Imported { skipped: usize, leftover: usize },
    /// Pending Lark login only: the file was unreadable (as the TypeScript treats
    /// it, it is cleared) and nothing was imported.
    Discarded {
        reason: DiscardReason,
        leftover: usize,
    },
}

/// Why a pending login file was cleared instead of imported.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DiscardReason {
    #[error("the file could not be read ({0:?})")]
    Unreadable(io::ErrorKind),
    #[error("the file did not decrypt: {0}")]
    Undecryptable(FormatError),
    #[error("the file decrypted to something that is not a pending login")]
    InvalidPayload,
}

/// A candidate that could not be turned into plaintext.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CandidateFailure {
    #[error("could not be read ({0:?})")]
    Read(io::ErrorKind),
    #[error("did not decrypt: {0}")]
    Decrypt(FormatError),
}

/// An import that did not complete. Files are left where they were.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ImportError {
    #[error("keychain: {0}")]
    Vault(String),
    #[error("could not list the user data directory ({0:?})")]
    Io(io::ErrorKind),
    #[error("os_crypt key unavailable: {0}")]
    Key(#[from] KeyError),
    /// No candidate yielded a session and at least one would not decrypt, so a
    /// valid one may be hiding behind a denied Keychain prompt or a changed key.
    #[error(
        "{failed} of {candidates} files did not decrypt ({invalid} decrypted to no session); first: {first}"
    )]
    Undecryptable {
        candidates: usize,
        failed: usize,
        invalid: usize,
        first: CandidateFailure,
    },
    /// The keychain did not hand back what was just written.
    #[error("the keychain did not return the imported entry; files kept")]
    ReadBackMismatch,
}

impl From<VaultError> for ImportError {
    fn from(err: VaultError) -> Self {
        Self::Vault(err.to_string())
    }
}

impl From<TokenError> for ImportError {
    fn from(err: TokenError) -> Self {
        Self::Vault(err.to_string())
    }
}

/// Keychain calls block (and on macOS may wait on a prompt): keep them off the
/// async workers where the vault is owned. The key source is borrowed, so its
/// lookup runs inline: start the import from a task that may block.
async fn blocking<T, F>(op: F) -> Result<T, ImportError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, VaultError> + Send + 'static,
{
    tokio::task::spawn_blocking(op)
        .await
        .map_err(|e| ImportError::Vault(e.to_string()))?
        .map_err(ImportError::from)
}

/// Move `<user_data>/tokens.bin` (and its `.next` slots) into the keychain.
///
/// Port of the read path of `tokenStore.ts` (`tokenCandidates`, `readTokens`):
/// candidates newest-first, the first that decrypts to a valid session wins.
pub async fn import_legacy_session<V: SecretVault, K: OsCryptKeySource>(
    user_data: &Path,
    vault: Arc<V>,
    keys: &K,
) -> Result<ImportOutcome, ImportError> {
    let store = KeychainTokenStore::new(vault);
    if store.load().await?.is_some() {
        return Ok(ImportOutcome::AlreadyPresent);
    }
    let files = token_candidates(user_data).map_err(|e| ImportError::Io(e.kind()))?;
    if files.is_empty() {
        return Ok(ImportOutcome::NothingToImport);
    }
    let (tokens, skipped) = match scan_candidates(&files, keys)? {
        Scan::Found { tokens, skipped } => (tokens, skipped),
        Scan::NoSession { invalid } => {
            return Ok(ImportOutcome::NoValidSession {
                candidates: invalid,
            });
        }
    };
    store.save(tokens.clone()).await?;
    if store.load().await?.as_ref() != Some(&tokens) {
        return Err(ImportError::ReadBackMismatch);
    }
    Ok(ImportOutcome::Imported {
        skipped,
        leftover: remove_files(&files),
    })
}

/// Move `<user_data>/pending-lark-login.bin` into the keychain's pending slot.
///
/// Port of `pendingLarkLoginStore.ts::loadPendingLarkLogin`: an unreadable file
/// is cleared, here with the reason reported ([`ImportOutcome::Discarded`]). A
/// denied Keychain prompt is not an unreadable file: that is an `Err`, file kept.
pub async fn import_pending_lark_login<V: SecretVault, K: OsCryptKeySource>(
    user_data: &Path,
    vault: Arc<V>,
    keys: &K,
) -> Result<ImportOutcome, ImportError> {
    let get = Arc::clone(&vault);
    let held = blocking(move || get.get(PENDING_LOGIN_SLOT)).await?;
    if held.is_some_and(|bytes| StoredPendingLarkLogin::coerce(&bytes).is_some()) {
        return Ok(ImportOutcome::AlreadyPresent);
    }
    let file = user_data.join(PENDING_LOGIN_FILE);
    let blob = match std::fs::read(&file) {
        Ok(blob) => blob,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(ImportOutcome::NothingToImport),
        Err(e) => return Ok(discard(&file, DiscardReason::Unreadable(e.kind()))),
    };
    let key = keys.load_key()?;
    let login = match decrypt_pending(&key, &blob) {
        Ok(login) => login,
        Err(reason) => return Ok(discard(&file, reason)),
    };
    store_pending(vault, &login).await?;
    Ok(ImportOutcome::Imported {
        skipped: 0,
        leftover: remove_files(&[file]),
    })
}

fn decrypt_pending(key: &OsCryptKey, blob: &[u8]) -> Result<StoredPendingLarkLogin, DiscardReason> {
    let plain = key.decrypt(blob).map_err(DiscardReason::Undecryptable)?;
    StoredPendingLarkLogin::coerce(plain.expose()).ok_or(DiscardReason::InvalidPayload)
}

fn discard(file: &Path, reason: DiscardReason) -> ImportOutcome {
    ImportOutcome::Discarded {
        reason,
        leftover: remove_files(&[file.to_path_buf()]),
    }
}

/// Write the canonical JSON to the pending slot and require it to read back.
async fn store_pending<V: SecretVault>(
    vault: Arc<V>,
    login: &StoredPendingLarkLogin,
) -> Result<(), ImportError> {
    let bytes = serde_json::to_vec(login).map_err(|e| ImportError::Vault(e.to_string()))?;
    let expected = login.clone();
    blocking(move || {
        vault.set(PENDING_LOGIN_SLOT, &bytes)?;
        match vault.get(PENDING_LOGIN_SLOT)? {
            Some(back) if StoredPendingLarkLogin::coerce(&back).as_ref() == Some(&expected) => {
                Ok(true)
            }
            _ => Ok(false),
        }
    })
    .await?
    .then_some(())
    .ok_or(ImportError::ReadBackMismatch)
}
