use std::sync::Arc;

use crate::pending_login::StoredPendingLarkLogin;
use crate::tokens::legacy::import::{
    DiscardReason, ImportError, ImportOutcome, import_pending_lark_login,
};
use crate::tokens::legacy::keys::KeyError;
use crate::tokens::{MemoryVault, PENDING_LOGIN_SLOT, SecretVault};

use super::support::{FakeKeys, ForgetfulVault, Os, TempDir};

const LOGIN: &[u8] = br#"{"verifier":"v-123","loginUrl":"https://example.test/login?x=1","createdAt":1791133383891}"#;

fn stored(vault: &MemoryVault) -> Option<StoredPendingLarkLogin> {
    vault
        .get(PENDING_LOGIN_SLOT)
        .expect("get")
        .and_then(|bytes| StoredPendingLarkLogin::coerce(&bytes))
}

#[tokio::test]
async fn imports_the_pending_login_and_removes_the_file() {
    for os in Os::BOTH {
        let dir = TempDir::new("pending-happy");
        dir.write("pending-lark-login.bin", &os.encrypt(LOGIN));
        let vault = Arc::new(MemoryVault::new());

        let outcome =
            import_pending_lark_login(dir.path(), Arc::clone(&vault), &FakeKeys::ok(os)).await;

        assert_eq!(
            outcome,
            Ok(ImportOutcome::Imported {
                skipped: 0,
                leftover: 0
            })
        );
        assert_eq!(
            stored(&vault),
            Some(StoredPendingLarkLogin {
                verifier: "v-123".to_owned(),
                login_url: "https://example.test/login?x=1".to_owned(),
                created_at: 1_791_133_383_891,
            })
        );
        assert!(!dir.exists("pending-lark-login.bin"));
    }
}

#[tokio::test]
async fn a_pending_login_already_in_the_keychain_wins() {
    let dir = TempDir::new("pending-present");
    dir.write("pending-lark-login.bin", &Os::Mac.encrypt(LOGIN));
    let vault = Arc::new(MemoryVault::new());
    vault.set(PENDING_LOGIN_SLOT, LOGIN).expect("seed");
    let keys = FakeKeys::ok(Os::Mac);
    assert_eq!(
        import_pending_lark_login(dir.path(), vault, &keys).await,
        Ok(ImportOutcome::AlreadyPresent)
    );
    assert!(dir.exists("pending-lark-login.bin"));
    assert_eq!(keys.calls(), 0);
}

#[tokio::test]
async fn no_pending_file_is_nothing_to_import() {
    let dir = TempDir::new("pending-none");
    let keys = FakeKeys::ok(Os::Mac);
    assert_eq!(
        import_pending_lark_login(dir.path(), Arc::new(MemoryVault::new()), &keys).await,
        Ok(ImportOutcome::NothingToImport)
    );
    assert_eq!(keys.calls(), 0);
}

#[tokio::test]
async fn an_undecryptable_file_is_cleared_and_reported() {
    let dir = TempDir::new("pending-garbage");
    dir.write(
        "pending-lark-login.bin",
        b"v10 this is not a real blob at all..",
    );
    let vault = Arc::new(MemoryVault::new());
    let outcome =
        import_pending_lark_login(dir.path(), Arc::clone(&vault), &FakeKeys::ok(Os::Mac)).await;
    assert!(
        matches!(
            outcome,
            Ok(ImportOutcome::Discarded {
                reason: DiscardReason::Undecryptable(_),
                leftover: 0
            })
        ),
        "{outcome:?}"
    );
    assert!(!dir.exists("pending-lark-login.bin"));
    assert_eq!(vault.get(PENDING_LOGIN_SLOT).expect("get"), None);
}

#[tokio::test]
async fn a_payload_that_is_not_a_pending_login_is_cleared_and_reported() {
    let bad = [
        &br#"{"verifier":"","loginUrl":"u","createdAt":1}"#[..],
        br#"{"verifier":"v","loginUrl":"","createdAt":1}"#,
        br#"{"verifier":"v","loginUrl":"u","createdAt":"1"}"#,
        br#"{"verifier":"v","loginUrl":"u"}"#,
        b"null",
        b"not json",
    ];
    for payload in bad {
        let dir = TempDir::new("pending-invalid");
        dir.write("pending-lark-login.bin", &Os::Windows.encrypt(payload));
        let outcome = import_pending_lark_login(
            dir.path(),
            Arc::new(MemoryVault::new()),
            &FakeKeys::ok(Os::Windows),
        )
        .await;
        assert_eq!(
            outcome,
            Ok(ImportOutcome::Discarded {
                reason: DiscardReason::InvalidPayload,
                leftover: 0
            }),
            "{}",
            String::from_utf8_lossy(payload)
        );
        assert!(!dir.exists("pending-lark-login.bin"));
    }
}

#[tokio::test]
async fn a_denied_keychain_prompt_keeps_the_pending_file() {
    let dir = TempDir::new("pending-denied");
    dir.write("pending-lark-login.bin", &Os::Mac.encrypt(LOGIN));
    let keys = FakeKeys::new(Err(KeyError::KeychainItemNotFound));
    let outcome = import_pending_lark_login(dir.path(), Arc::new(MemoryVault::new()), &keys).await;
    assert_eq!(
        outcome,
        Err(ImportError::Key(KeyError::KeychainItemNotFound))
    );
    assert!(dir.exists("pending-lark-login.bin"));
}

#[tokio::test]
async fn the_pending_file_survives_a_keychain_that_forgets_the_write() {
    let dir = TempDir::new("pending-forgetful");
    dir.write("pending-lark-login.bin", &Os::Mac.encrypt(LOGIN));
    let outcome =
        import_pending_lark_login(dir.path(), Arc::new(ForgetfulVault), &FakeKeys::ok(Os::Mac))
            .await;
    assert_eq!(outcome, Err(ImportError::ReadBackMismatch));
    assert!(dir.exists("pending-lark-login.bin"));
}
