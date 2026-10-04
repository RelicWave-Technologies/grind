//! Cross-implementation vectors for the Chromium `os_crypt` "v10" format.
//!
//! `parity/src/gen/osCrypt.ts` builds every blob with Node's `crypto` (OpenSSL), an
//! implementation sharing no code with the `RustCrypto` crates used here. For each
//! case, this crate must (1) decrypt the blob to the recorded plaintext and
//! (2) encrypt the plaintext to the identical bytes (CBC with the fixed IV and GCM
//! with the recorded nonce are deterministic). A mismatch in either direction means
//! the Rust side would misread, or mis-write, what Electron's `safeStorage` does.
#![cfg(test)]

use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use timo_sync::tokens::legacy::format::{decrypt_mac_v10, decrypt_windows_v10, derive_mac_key};
use timo_sync::tokens::legacy::testing::{encrypt_mac_v10, encrypt_windows_v10};

fn cases(name: &str) -> Vec<(Value, Value)> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/osCrypt")
        .join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let doc: Value = serde_json::from_str(&text).expect("fixture is JSON");
    doc["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|c| (c["input"].clone(), c["output"].clone()))
        .collect()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing string {key}"))
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    hex.as_bytes()
        .chunks(2)
        .map(|pair| {
            let digits = std::str::from_utf8(pair).expect("ASCII hex");
            u8::from_str_radix(digits, 16).expect("hex digit")
        })
        .collect()
}

fn hex_string(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .concat()
}

#[test]
fn mac_blobs_from_node_decrypt_and_re_encrypt_identically() {
    let all = cases("mac_encrypt.json");
    assert!(all.len() >= 500, "fixture has {} cases", all.len());
    let mut empty = 0;
    for (index, (input, output)) in all.iter().enumerate() {
        let (password, plain) = (
            text(input, "password").as_bytes(),
            text(input, "plaintext").as_bytes(),
        );
        let blob = STANDARD
            .decode(output.as_str().expect("blob"))
            .expect("base64");
        let back = decrypt_mac_v10(&blob, password).unwrap_or_else(|e| panic!("case {index}: {e}"));
        assert_eq!(back.expose(), plain, "case {index}: decrypt");
        let again =
            encrypt_mac_v10(plain, password).unwrap_or_else(|e| panic!("case {index}: {e}"));
        assert_eq!(again, blob, "case {index}: encrypt");
        empty += usize::from(plain.is_empty());
    }
    assert!(empty >= 1, "the empty plaintext is covered");
}

#[test]
fn mac_pbkdf2_keys_match_node() {
    let all = cases("mac_derive_key.json");
    assert!(all.len() >= 500);
    for (index, (input, output)) in all.iter().enumerate() {
        let key = derive_mac_key(text(input, "password").as_bytes());
        assert_eq!(
            hex_string(&key),
            output.as_str().expect("hex"),
            "case {index}"
        );
    }
}

#[test]
fn windows_blobs_from_node_decrypt_and_re_encrypt_identically() {
    let all = cases("windows_encrypt.json");
    assert!(all.len() >= 500, "fixture has {} cases", all.len());
    for (index, (input, output)) in all.iter().enumerate() {
        let key: [u8; 32] = hex_bytes(text(input, "keyHex"))
            .try_into()
            .expect("32-byte key");
        let nonce: [u8; 12] = hex_bytes(text(input, "nonceHex"))
            .try_into()
            .expect("12-byte nonce");
        let plain = text(input, "plaintext").as_bytes();
        let blob = STANDARD
            .decode(output.as_str().expect("blob"))
            .expect("base64");
        let back = decrypt_windows_v10(&blob, &key).unwrap_or_else(|e| panic!("case {index}: {e}"));
        assert_eq!(back.expose(), plain, "case {index}: decrypt");
        let again = encrypt_windows_v10(plain, &key, &nonce)
            .unwrap_or_else(|e| panic!("case {index}: {e}"));
        assert_eq!(again, blob, "case {index}: encrypt");
    }
}
