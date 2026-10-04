//! The Chromium-side *encryption*, so tests can build the blobs Electron would.
//!
//! Not used by the importer. It is `pub` (hidden from the docs) only because the
//! integration tests in `tests/` compile this crate without `cfg(test)`.

use aes::Aes128;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockEncryptMut, KeyIvInit};

pub use super::format::derive_mac_key;
use super::format::{FormatError, V10_PREFIX, WINDOWS_KEY_BYTES, WINDOWS_NONCE_BYTES};

const MAC_IV: [u8; 16] = [b' '; 16];

/// Port of `OSCryptImpl::EncryptString` (`os_crypt_mac.mm`). An empty plaintext
/// encrypts to an empty blob, with no prefix, as Chromium does.
pub fn encrypt_mac_v10(plaintext: &[u8], keychain_password: &[u8]) -> Result<Vec<u8>, FormatError> {
    if plaintext.is_empty() {
        return Ok(Vec::new());
    }
    if keychain_password.is_empty() {
        return Err(FormatError::EmptyPassword);
    }
    let key = derive_mac_key(keychain_password);
    let mut buf = plaintext.to_vec();
    buf.resize(plaintext.len() + 16, 0);
    let sealed_len = cbc::Encryptor::<Aes128>::new(&key.into(), &MAC_IV.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
        .map_err(|_| FormatError::BadPadding)?
        .len();
    buf.truncate(sealed_len);
    let mut blob = V10_PREFIX.to_vec();
    blob.extend_from_slice(&buf);
    Ok(blob)
}

/// Port of `OSCryptImpl::EncryptString` (`os_crypt_win.cc`), with the nonce
/// supplied (Chromium draws it at random) so a test is deterministic.
pub fn encrypt_windows_v10(
    plaintext: &[u8],
    key: &[u8; WINDOWS_KEY_BYTES],
    nonce: &[u8; WINDOWS_NONCE_BYTES],
) -> Result<Vec<u8>, FormatError> {
    let sealed = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key))
        .encrypt(&Nonce::from(*nonce), plaintext)
        .map_err(|_| FormatError::AuthenticationFailed)?;
    let mut blob = V10_PREFIX.to_vec();
    blob.extend_from_slice(nonce);
    blob.extend_from_slice(&sealed);
    Ok(blob)
}
