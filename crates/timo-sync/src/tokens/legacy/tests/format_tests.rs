use crate::tokens::legacy::format::{
    FormatError, decrypt_mac_v10, decrypt_windows_v10, derive_mac_key,
};
use crate::tokens::legacy::testing::{encrypt_mac_v10, encrypt_windows_v10};

use super::support::{MAC_PASSWORD, WINDOWS_KEY, WINDOWS_NONCE};

fn plaintexts() -> Vec<Vec<u8>> {
    let mut all: Vec<Vec<u8>> = vec![
        Vec::new(),
        b"a".to_vec(),
        vec![b'x'; 15],
        vec![b'x'; 16],
        vec![b'x'; 17],
        vec![b'y'; 32],
        vec![b'z'; 1000],
        "tokens: héllo – 日本語 – 🙂".as_bytes().to_vec(),
        vec![0, 255, 0, 255],
    ];
    all.push(
        br#"{"accessToken":"a.b.c","refreshToken":"r","userId":"u","workspaceId":"w"}"#.to_vec(),
    );
    all
}

#[test]
fn mac_round_trips_every_block_boundary() {
    for plain in plaintexts() {
        let blob = encrypt_mac_v10(&plain, MAC_PASSWORD).expect("encrypt");
        let back = decrypt_mac_v10(&blob, MAC_PASSWORD).expect("decrypt");
        assert_eq!(back.expose(), plain.as_slice(), "len {}", plain.len());
    }
}

#[test]
fn mac_blob_layout_is_prefix_plus_whole_blocks() {
    let blob = encrypt_mac_v10(&[b'x'; 16], MAC_PASSWORD).expect("encrypt");
    assert_eq!(blob.get(..3), Some(b"v10".as_slice()));
    // 16 bytes of plaintext take two blocks: PKCS#7 adds a whole padding block.
    assert_eq!(blob.len(), 3 + 32);
    // Chromium encrypts "" to "", with no prefix.
    assert!(
        encrypt_mac_v10(b"", MAC_PASSWORD)
            .expect("encrypt")
            .is_empty()
    );
}

#[test]
fn mac_key_is_pbkdf2_sha1_saltysalt_1003() {
    // Independent check lives in tests/os_crypt_vectors.rs (Node's pbkdf2Sync);
    // here: determinism, length, and that the password matters byte for byte.
    assert_eq!(derive_mac_key(b"pw"), derive_mac_key(b"pw"));
    assert_ne!(derive_mac_key(b"pw"), derive_mac_key(b"pW"));
}

#[test]
fn mac_wrong_password_fails_cleanly_or_never_returns_the_plaintext() {
    let plain = br#"{"accessToken":"a","refreshToken":"b","userId":"c","workspaceId":"d"}"#;
    let blob = encrypt_mac_v10(plain, MAC_PASSWORD).expect("encrypt");
    // Garbage output passes PKCS#7 about 1 time in 256: the contract is that the
    // plaintext never comes back, and for this fixed input it is a padding error.
    assert_eq!(
        decrypt_mac_v10(&blob, b"another-password").map(|s| s.expose().to_vec()),
        Err(FormatError::BadPadding)
    );
}

#[test]
fn mac_rejects_bad_blobs_with_typed_errors() {
    let good = encrypt_mac_v10(b"hello", MAC_PASSWORD).expect("encrypt");
    assert_eq!(good.len(), 3 + 16);
    let err = |blob: &[u8]| decrypt_mac_v10(blob, MAC_PASSWORD).expect_err("must fail");
    assert_eq!(err(b"v10"), FormatError::BadLength { len: 0 });
    assert_eq!(
        err(&good[..good.len() - 1]),
        FormatError::BadLength { len: 15 }
    );
    assert_eq!(
        err(b"hello world, not encrypted"),
        FormatError::UnknownPrefix { len: 26 }
    );
    assert_eq!(
        err(b"v11aaaaaaaaaaaaaaaaaaaaaaaa"),
        FormatError::UnknownPrefix { len: 27 }
    );
    assert_eq!(err(b"v1"), FormatError::UnknownPrefix { len: 2 });
    assert_eq!(
        decrypt_mac_v10(&good, b"").expect_err("empty password"),
        FormatError::EmptyPassword
    );
}

#[test]
fn mac_damaged_ciphertext_never_yields_the_plaintext() {
    let plain = b"{\"k\":\"some session json, long enough for two blocks\"}";
    let blob = encrypt_mac_v10(plain, MAC_PASSWORD).expect("encrypt");
    for i in 3..blob.len() {
        let mut damaged = blob.clone();
        damaged[i] ^= 0x01;
        match decrypt_mac_v10(&damaged, MAC_PASSWORD) {
            Err(e) => assert!(matches!(e, FormatError::BadPadding), "byte {i}: {e:?}"),
            Ok(back) => assert_ne!(back.expose(), plain.as_slice(), "byte {i}"),
        }
    }
}

#[test]
fn windows_round_trips() {
    for plain in plaintexts() {
        let blob = encrypt_windows_v10(&plain, &WINDOWS_KEY, &WINDOWS_NONCE).expect("encrypt");
        assert_eq!(blob.get(..3), Some(b"v10".as_slice()));
        assert_eq!(blob.get(3..15), Some(WINDOWS_NONCE.as_slice()));
        assert_eq!(blob.len(), 3 + 12 + plain.len() + 16);
        let back = decrypt_windows_v10(&blob, &WINDOWS_KEY).expect("decrypt");
        assert_eq!(back.expose(), plain.as_slice(), "len {}", plain.len());
    }
}

#[test]
fn windows_wrong_key_and_tampering_fail_the_tag() {
    let blob = encrypt_windows_v10(b"secret", &WINDOWS_KEY, &WINDOWS_NONCE).expect("encrypt");
    assert_eq!(
        decrypt_windows_v10(&blob, &[9; 32]).expect_err("wrong key"),
        FormatError::AuthenticationFailed
    );
    for i in 3..blob.len() {
        let mut damaged = blob.clone();
        damaged[i] ^= 0x80;
        assert_eq!(
            decrypt_windows_v10(&damaged, &WINDOWS_KEY).expect_err("tampered"),
            FormatError::AuthenticationFailed,
            "byte {i}"
        );
    }
}

#[test]
fn windows_rejects_short_and_unprefixed_blobs() {
    let good = encrypt_windows_v10(b"", &WINDOWS_KEY, &WINDOWS_NONCE).expect("encrypt");
    assert_eq!(good.len(), 31);
    assert!(
        decrypt_windows_v10(&good, &WINDOWS_KEY)
            .expect("empty plaintext")
            .is_empty()
    );
    let err = |blob: &[u8]| decrypt_windows_v10(blob, &WINDOWS_KEY).expect_err("must fail");
    for cut in [1, 2, 15, 30] {
        let short = &good[..cut.min(good.len())];
        let expected = if cut < 3 {
            FormatError::UnknownPrefix { len: cut }
        } else {
            FormatError::TooShort { len: cut, min: 31 }
        };
        assert_eq!(err(short), expected, "cut {cut}");
    }
    assert_eq!(
        err(b"\x01\x00\x00\x00 raw dpapi blob"),
        FormatError::UnknownPrefix { len: 19 }
    );
    assert_eq!(
        err(b"v11 not chromium's"),
        FormatError::UnknownPrefix { len: 18 }
    );
}

#[test]
fn empty_blob_is_empty_plaintext_on_both_oses() {
    // Electron's decryptString returns "" for an empty buffer before os_crypt runs.
    assert!(decrypt_mac_v10(b"", MAC_PASSWORD).expect("mac").is_empty());
    assert!(
        decrypt_windows_v10(b"", &WINDOWS_KEY)
            .expect("win")
            .is_empty()
    );
}
