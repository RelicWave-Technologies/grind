//! Nothing secret may reach an error's `Display` or `Debug`, nor a key's `Debug`.

use std::sync::Arc;

use crate::tokens::legacy::format::{FormatError, Secret, decrypt_mac_v10, decrypt_windows_v10};
use crate::tokens::legacy::import::{
    ImportError, import_legacy_session, import_pending_lark_login,
};
use crate::tokens::legacy::keys::{KeyError, OsCryptKey};
use crate::tokens::legacy::testing::{encrypt_mac_v10, encrypt_windows_v10};
use crate::tokens::{MemoryVault, StoredTokens};

use super::support::{FakeKeys, Os, TempDir, WINDOWS_NONCE};

const MARKER: &str = "SECRET-MARKER-9f3a";

fn assert_clean(what: &str, shown: &str) {
    assert!(!shown.contains(MARKER), "{what} leaked the marker: {shown}");
    assert!(
        !shown.contains("U0VDUkVU"),
        "{what} leaked base64 of it: {shown}"
    );
}

fn secret_tokens() -> StoredTokens {
    StoredTokens {
        access_token: format!("{MARKER}-access"),
        refresh_token: format!("{MARKER}-refresh"),
        user_id: format!("{MARKER}-user"),
        workspace_id: format!("{MARKER}-ws"),
    }
}

#[test]
fn secrets_debug_as_a_length() {
    let secret = Secret::new(MARKER.as_bytes().to_vec());
    assert_clean("Secret", &format!("{secret:?}"));
    for key in [
        OsCryptKey::mac_password(MARKER.as_bytes().to_vec()).expect("password"),
        OsCryptKey::windows_key(vec![0x41; 32]).expect("key"),
    ] {
        let shown = format!("{key:?}");
        assert_clean("OsCryptKey", &shown);
        assert!(
            !shown.contains("AAAA") && !shown.contains("65, 65"),
            "{shown}"
        );
    }
}

#[test]
fn format_errors_carry_no_bytes() {
    let password = MARKER.as_bytes();
    let blob = encrypt_mac_v10(MARKER.as_bytes(), password).expect("encrypt");
    let key = [0x41_u8; 32];
    let win = encrypt_windows_v10(MARKER.as_bytes(), &key, &WINDOWS_NONCE).expect("encrypt");
    let errors: Vec<FormatError> = vec![
        decrypt_mac_v10(&blob, b"wrong-password").expect_err("wrong"),
        decrypt_mac_v10(&blob[..blob.len() - 1], password).expect_err("short"),
        decrypt_mac_v10(MARKER.as_bytes(), password).expect_err("prefix"),
        decrypt_mac_v10(&blob, b"").expect_err("empty"),
        decrypt_windows_v10(&win, &[0x42; 32]).expect_err("tag"),
        decrypt_windows_v10(MARKER.as_bytes(), &key).expect_err("prefix"),
        decrypt_windows_v10(&win[..10], &key).expect_err("short"),
    ];
    for e in errors {
        assert_clean("FormatError", &format!("{e} | {e:?}"));
    }
}

fn secret_json() -> Vec<u8> {
    serde_json::to_vec(&secret_tokens()).expect("json")
}

async fn session_result(blob: &[u8], keys: &FakeKeys) -> String {
    let dir = TempDir::new("leak-session");
    dir.write("tokens.bin", blob);
    let r = import_legacy_session(dir.path(), Arc::new(MemoryVault::new()), keys).await;
    match &r {
        Err(e) => format!("{r:?} | {e}"),
        Ok(_) => format!("{r:?}"),
    }
}

#[tokio::test]
async fn session_import_results_carry_no_secrets() {
    let json = secret_json();
    let not_a_session = format!(r#"{{"accessToken":"{MARKER}"}}"#);
    let shown = [
        // wrong key: every file undecryptable
        session_result(
            &Os::Mac.encrypt(&json),
            &FakeKeys::new(Ok(Os::Mac.wrong_key())),
        )
        .await,
        // decrypts, but is not a session: the plaintext is secret too
        session_result(
            &Os::Mac.encrypt(not_a_session.as_bytes()),
            &FakeKeys::ok(Os::Mac),
        )
        .await,
        // success
        session_result(&Os::Windows.encrypt(&json), &FakeKeys::ok(Os::Windows)).await,
    ];
    for text in &shown {
        assert_clean("session import result", text);
    }
    let e = ImportError::from(KeyError::KeychainFailure("denied".to_owned()));
    assert_clean("ImportError", &format!("{e} | {e:?}"));
}

#[tokio::test]
async fn pending_import_results_carry_no_secrets() {
    let dir = TempDir::new("leak-pending");
    let invalid = format!(r#"{{"verifier":"{MARKER}"}}"#);
    dir.write(
        "pending-lark-login.bin",
        &Os::Mac.encrypt(invalid.as_bytes()),
    );
    let r = import_pending_lark_login(
        dir.path(),
        Arc::new(MemoryVault::new()),
        &FakeKeys::ok(Os::Mac),
    )
    .await;
    assert_clean("invalid pending payload", &format!("{r:?}"));
    dir.write("pending-lark-login.bin", MARKER.as_bytes());
    let r = import_pending_lark_login(
        dir.path(),
        Arc::new(MemoryVault::new()),
        &FakeKeys::ok(Os::Mac),
    )
    .await;
    assert_clean("garbage pending file", &format!("{r:?}"));
}
