//! Port of `legacy/agent/src/main/services/tokenStore.test.ts` (5 tests),
//! adapted from the encrypted file to the keychain store. Tests 1, 3 and 4 keep
//! their meaning verbatim; test 2 (a Windows destination lock) and test 5 (a
//! durable `.next` slot) are file mechanics with no keychain counterpart: their
//! guarantee (a failed write never loses the old session; the newest slot wins)
//! is asserted at the keychain level here and in the legacy-import tests.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::string_slice,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    reason = "test code: a failed assertion is the failure report"
)]

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use support::tokens;
use timo_sync::tokens::{
    KeychainTokenStore, MAX_SECRET_BYTES, MemoryVault, SecretVault, TOKENS_SLOT, TokenStore,
    VaultError,
};

fn store() -> (Arc<MemoryVault>, KeychainTokenStore<MemoryVault>) {
    let vault = Arc::new(MemoryVault::new());
    (Arc::clone(&vault), KeychainTokenStore::new(vault))
}

#[tokio::test]
async fn serializes_concurrent_replacements_and_exposes_the_newest_durable_tokens() {
    let (_, store) = store();
    let (first, second) = (tokens("a1", "r1"), tokens("a2", "r2"));

    let (a, b) = tokio::join!(store.save(first), store.save(second.clone()));
    a.unwrap();
    b.unwrap();

    assert_eq!(store.load().await.unwrap(), Some(second));
}

/// A vault whose next `set` fails, like a keychain that is locked or a Windows
/// credential store that is busy.
struct FlakyVault {
    inner: MemoryVault,
    fail_next_set: AtomicBool,
}

impl SecretVault for FlakyVault {
    fn get(&self, slot: &str) -> Result<Option<Vec<u8>>, VaultError> {
        self.inner.get(slot)
    }

    fn set(&self, slot: &str, secret: &[u8]) -> Result<(), VaultError> {
        if self.fail_next_set.swap(false, Ordering::SeqCst) {
            return Err(VaultError::Backend("locked".to_owned()));
        }
        self.inner.set(slot, secret)
    }

    fn delete(&self, slot: &str) -> Result<(), VaultError> {
        self.inner.delete(slot)
    }
}

#[tokio::test]
async fn a_failed_keychain_write_never_loses_the_previous_session() {
    let vault = Arc::new(FlakyVault {
        inner: MemoryVault::new(),
        fail_next_set: AtomicBool::new(false),
    });
    let store = KeychainTokenStore::new(Arc::clone(&vault));
    let (first, second) = (tokens("a1", "r1"), tokens("a2", "r2"));
    store.save(first.clone()).await.unwrap();

    vault.fail_next_set.store(true, Ordering::SeqCst);
    assert!(store.save(second.clone()).await.is_err());
    assert_eq!(
        store.load().await.unwrap(),
        Some(first),
        "the old session survives"
    );

    store.save(second.clone()).await.unwrap();
    assert_eq!(store.load().await.unwrap(), Some(second));
}

#[tokio::test]
async fn cannot_clear_a_newer_rotation_using_an_older_rejected_snapshot() {
    let (_, store) = store();
    let (first, second) = (tokens("a1", "r1"), tokens("a2", "r2"));
    store.save(second.clone()).await.unwrap();

    assert!(!store.clear_if_match(&first).await.unwrap());

    assert_eq!(store.load().await.unwrap(), Some(second));
}

#[tokio::test]
async fn cannot_resurrect_an_old_session_after_a_newer_login_wins() {
    let (_, store) = store();
    let (first, second) = (tokens("a1", "r1"), tokens("a2", "r2"));
    store.save(second.clone()).await.unwrap();

    let late = tokens("late", "late");
    assert!(!store.replace_if_match(&first, late).await.unwrap());

    assert_eq!(store.load().await.unwrap(), Some(second));
}

#[tokio::test]
async fn replace_if_match_rotates_the_exact_session_and_clear_if_match_removes_it() {
    let (_, store) = store();
    let (first, second) = (tokens("a1", "r1"), tokens("a2", "r2"));
    store.save(first.clone()).await.unwrap();

    assert!(
        store
            .replace_if_match(&first, second.clone())
            .await
            .unwrap()
    );
    assert_eq!(store.load().await.unwrap(), Some(second.clone()));
    assert!(store.clear_if_match(&second).await.unwrap());
    assert_eq!(store.load().await.unwrap(), None);
}

#[tokio::test]
async fn an_empty_part_is_an_invalid_payload_and_a_damaged_blob_reads_as_no_session() {
    let (vault, store) = store();
    let mut bad = tokens("a", "r");
    bad.user_id = String::new();
    assert_eq!(
        store.save(bad).await.unwrap_err().to_string(),
        "invalid_token_payload"
    );

    vault.set(TOKENS_SLOT, b"not json").unwrap();
    assert_eq!(store.load().await.unwrap(), None);
    vault
        .set(
            TOKENS_SLOT,
            br#"{"accessToken":"a","refreshToken":"r","userId":"","workspaceId":"w"}"#,
        )
        .unwrap();
    assert_eq!(store.load().await.unwrap(), None);
}

#[test]
fn a_secret_over_the_credential_manager_limit_is_refused_everywhere() {
    let vault = MemoryVault::new();
    let err = vault
        .set(TOKENS_SLOT, &vec![b'x'; MAX_SECRET_BYTES + 1])
        .unwrap_err();
    assert!(matches!(err, VaultError::TooLarge(n) if n == MAX_SECRET_BYTES + 1));
    vault
        .set(TOKENS_SLOT, &vec![b'x'; MAX_SECRET_BYTES])
        .unwrap();
}
