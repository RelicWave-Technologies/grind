//! Chromium `os_crypt` "v10" blobs, as Electron `safeStorage.encryptString` writes them.
//!
//! The facts and their sources are in `crates/timo-sync/OSCRYPT.md`. In short:
//!
//! * **macOS** — `"v10" ++ AES-128-CBC(PKCS#7)`, key = PBKDF2-HMAC-SHA1 over the
//!   Keychain "Safe Storage" password (verbatim bytes), salt `saltysalt`, 1003
//!   iterations, 16 bytes; IV = 16 ASCII spaces.
//! * **Windows** — `"v10" ++ nonce(12) ++ AES-256-GCM(ciphertext ++ tag(16))`, key
//!   = the 32 bytes DPAPI hands back for `Local State`'s `os_crypt.encrypted_key`.
//!
//! Nothing here logs, prints or formats a secret. [`Secret`] debug-prints its
//! length only, and every [`FormatError`] carries lengths, never bytes.

use aes::Aes128;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use sha1::Sha1;
use thiserror::Error;

/// `OSCryptImpl::EncryptString` / `DecryptString`: `kEncryptionVersionPrefix`.
pub const V10_PREFIX: &[u8] = b"v10";
/// `os_crypt_mac.mm::kSalt`.
const MAC_SALT: &[u8] = b"saltysalt";
/// `os_crypt_mac.mm::kEncryptionIterations`.
const MAC_ITERATIONS: u32 = 1003;
/// `kDerivedKeySizeInBits` (128) / 8.
pub const MAC_KEY_BYTES: usize = 16;
/// `std::string iv(kCCBlockSizeAES128, ' ')`.
const MAC_IV: [u8; 16] = [b' '; 16];
const AES_BLOCK: usize = 16;
/// `os_crypt_win.cc::kKeyLength` (256 / 8).
pub const WINDOWS_KEY_BYTES: usize = 32;
/// `os_crypt_win.cc::kNonceLength` (96 / 8).
pub const WINDOWS_NONCE_BYTES: usize = 12;
/// AES-GCM authentication tag, appended to the ciphertext by `BoringSSL`'s `Seal`.
pub const WINDOWS_TAG_BYTES: usize = 16;

/// Secret bytes (a password, a key, a decrypted payload). Never `Display`, and
/// `Debug` shows the length only, so a stray `{:?}` cannot leak it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(Vec<u8>);

impl Secret {
    #[must_use]
    pub const fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret(<{} bytes>)", self.0.len())
    }
}

/// Why a blob did not decrypt. Lengths only, never content.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FormatError {
    /// Electron's `decryptString` throws "does not appear to be encrypted".
    #[error("blob of {len} bytes does not start with the v10 prefix")]
    UnknownPrefix { len: usize },
    #[error("blob of {len} bytes is shorter than the {min} a v10 blob needs")]
    TooShort { len: usize, min: usize },
    /// A CBC body must be a whole number of 16-byte blocks.
    #[error("ciphertext of {len} bytes is not a whole number of AES blocks")]
    BadLength { len: usize },
    /// The wrong key (or a damaged blob) shows up as invalid PKCS#7 padding.
    #[error("AES-CBC padding is invalid (wrong key or damaged blob)")]
    BadPadding,
    /// The wrong key (or a damaged blob) fails the GCM tag.
    #[error("AES-GCM authentication failed (wrong key or damaged blob)")]
    AuthenticationFailed,
    #[error("the Keychain password is empty")]
    EmptyPassword,
    #[error("the AES-256 key is {len} bytes; it must be 32")]
    InvalidKey { len: usize },
}

/// `SymmetricKey::DeriveKeyFromPasswordUsingPbkdf2(AES, password, "saltysalt", 1003, 128)`.
#[must_use]
pub fn derive_mac_key(password: &[u8]) -> [u8; MAC_KEY_BYTES] {
    let mut key = [0_u8; MAC_KEY_BYTES];
    pbkdf2::pbkdf2_hmac::<Sha1>(password, MAC_SALT, MAC_ITERATIONS, &mut key);
    key
}

/// Port of `OSCryptImpl::DecryptString` (`os_crypt_mac.mm`) behind Electron's
/// `safeStorage.decryptString` gate: empty in, empty out; anything else must
/// carry the `v10` prefix.
pub fn decrypt_mac_v10(blob: &[u8], keychain_password: &[u8]) -> Result<Secret, FormatError> {
    if blob.is_empty() {
        return Ok(Secret::new(Vec::new()));
    }
    let body = blob
        .strip_prefix(V10_PREFIX)
        .ok_or(FormatError::UnknownPrefix { len: blob.len() })?;
    if keychain_password.is_empty() {
        return Err(FormatError::EmptyPassword);
    }
    if body.is_empty() || body.len() % AES_BLOCK != 0 {
        return Err(FormatError::BadLength { len: body.len() });
    }
    let key = derive_mac_key(keychain_password);
    let mut buf = body.to_vec();
    let plain_len = cbc::Decryptor::<Aes128>::new(&key.into(), &MAC_IV.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| FormatError::BadPadding)?
        .len();
    buf.truncate(plain_len);
    Ok(Secret::new(buf))
}

/// Port of `OSCryptImpl::DecryptString` (`os_crypt_win.cc`), `v10` branch.
/// (A blob without the prefix is a pre-2018 raw-DPAPI blob in Chromium; Electron's
/// `decryptString` refuses it before it gets that far, so it is refused here too.)
pub fn decrypt_windows_v10(
    blob: &[u8],
    key: &[u8; WINDOWS_KEY_BYTES],
) -> Result<Secret, FormatError> {
    if blob.is_empty() {
        return Ok(Secret::new(Vec::new()));
    }
    let body = blob
        .strip_prefix(V10_PREFIX)
        .ok_or(FormatError::UnknownPrefix { len: blob.len() })?;
    let min = V10_PREFIX.len() + WINDOWS_NONCE_BYTES + WINDOWS_TAG_BYTES;
    let (nonce, sealed) = body
        .split_at_checked(WINDOWS_NONCE_BYTES)
        .filter(|(_, sealed)| sealed.len() >= WINDOWS_TAG_BYTES)
        .ok_or(FormatError::TooShort {
            len: blob.len(),
            min,
        })?;
    let nonce: [u8; WINDOWS_NONCE_BYTES] = nonce.try_into().map_err(|_| FormatError::TooShort {
        len: blob.len(),
        min,
    })?;
    Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key))
        .decrypt(&Nonce::from(nonce), sealed)
        .map(Secret::new)
        .map_err(|_| FormatError::AuthenticationFailed)
}
