//! Where the `os_crypt` key comes from, per OS. The importer asks a
//! [`OsCryptKeySource`] once and decrypts every candidate with what it returns.
//!
//! * macOS: the Keychain item `"<product> Safe Storage"` / `"<product>"`, whose
//!   stored string is the PBKDF2 password ([`MacKeychainKeySource`]).
//! * Windows: `Local State` → DPAPI → the 32-byte AES key ([`super::LocalStateKeySource`]).
//!
//! Neither source is asked for until there is a file to decrypt, so a machine
//! with nothing to import is never shown a Keychain prompt.

use thiserror::Error;

use super::format::{FormatError, Secret, WINDOWS_KEY_BYTES, decrypt_mac_v10, decrypt_windows_v10};

/// `package.json::productName` of `legacy/agent`; Electron names the Keychain
/// item after it (`electron_browser_main_parts.cc`: `app_name + " Safe Storage"`).
pub const ELECTRON_PRODUCT_NAME: &str = "Timo";

/// The key material one OS's `safeStorage` encrypted with. Debug prints lengths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OsCryptKey {
    /// The Keychain item's stored bytes, used verbatim as the PBKDF2 password.
    MacPassword(Secret),
    /// The AES-256-GCM key (exactly 32 bytes).
    WindowsAesKey(Secret),
}

impl OsCryptKey {
    /// Chromium treats an empty Keychain password as "no key" (`GetPassword`
    /// returns `""` on denial), so an empty one is an error, not a key.
    pub fn mac_password(bytes: Vec<u8>) -> Result<Self, KeyError> {
        if bytes.is_empty() {
            return Err(KeyError::EmptyKeychainPassword);
        }
        Ok(Self::MacPassword(Secret::new(bytes)))
    }

    pub fn windows_key(bytes: Vec<u8>) -> Result<Self, KeyError> {
        if bytes.len() != WINDOWS_KEY_BYTES {
            return Err(KeyError::InvalidKeyLength { len: bytes.len() });
        }
        Ok(Self::WindowsAesKey(Secret::new(bytes)))
    }

    /// Decrypt one `safeStorage` blob with this key.
    pub fn decrypt(&self, blob: &[u8]) -> Result<Secret, FormatError> {
        match self {
            Self::MacPassword(password) => decrypt_mac_v10(blob, password.expose()),
            Self::WindowsAesKey(key) => {
                let key: &[u8; WINDOWS_KEY_BYTES] = key
                    .expose()
                    .try_into()
                    .map_err(|_| FormatError::InvalidKey { len: key.len() })?;
                decrypt_windows_v10(blob, key)
            }
        }
    }
}

/// Why the key could not be had. Kinds and lengths only, never key bytes.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum KeyError {
    /// No `"<product> Safe Storage"` item: the Electron app never ran as this
    /// user here, or ran under another product name.
    #[error("the Electron Safe Storage Keychain item does not exist")]
    KeychainItemNotFound,
    /// The user declined the Keychain prompt, the keychain is locked, or the OS failed.
    #[error("the Keychain refused or failed the lookup: {0}")]
    KeychainFailure(String),
    #[error("the Keychain password is empty")]
    EmptyKeychainPassword,
    #[error("Local State could not be read ({0:?})")]
    LocalStateUnreadable(std::io::ErrorKind),
    #[error("Local State is not a JSON object")]
    LocalStateMalformed,
    #[error("Local State has no os_crypt.encrypted_key")]
    EncryptedKeyMissing,
    #[error("os_crypt.encrypted_key is not valid base64")]
    EncryptedKeyBase64,
    /// Chromium's `kInvalidKeyFormat`: the decoded key must start with `DPAPI`.
    #[error("os_crypt.encrypted_key does not start with the DPAPI marker")]
    EncryptedKeyNotDpapi,
    #[error("DPAPI could not unprotect the key: {0}")]
    Unprotect(String),
    #[error("the AES-256 key is {len} bytes; it must be 32")]
    InvalidKeyLength { len: usize },
}

/// Hands out the key that encrypted the Electron agent's files.
pub trait OsCryptKeySource {
    fn load_key(&self) -> Result<OsCryptKey, KeyError>;
}

/// macOS: read the Keychain "Safe Storage" item Electron created.
///
/// Port of `KeychainPassword::GetPassword` (`keychain_password_mac.mm`), minus
/// its create-on-missing branch: this reader never writes to that item.
#[derive(Debug, Clone)]
pub struct MacKeychainKeySource {
    service: String,
    account: String,
}

impl MacKeychainKeySource {
    /// For an Electron app named `product_name`
    /// (`electron_browser_main_parts.cc`: service `name + " Safe Storage"`, account `name`).
    #[must_use]
    pub fn new(product_name: &str) -> Self {
        Self {
            service: format!("{product_name} Safe Storage"),
            account: product_name.to_owned(),
        }
    }

    /// The Timo Electron agent's item.
    #[must_use]
    pub fn timo() -> Self {
        Self::new(ELECTRON_PRODUCT_NAME)
    }

    #[must_use]
    pub fn service(&self) -> &str {
        &self.service
    }

    #[must_use]
    pub fn account(&self) -> &str {
        &self.account
    }
}

impl OsCryptKeySource for MacKeychainKeySource {
    fn load_key(&self) -> Result<OsCryptKey, KeyError> {
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(classify)?;
        let secret = entry.inner.get_secret().map_err(classify)?;
        OsCryptKey::mac_password(secret)
    }
}

/// Map a keyring failure to a [`KeyError`] without carrying any secret.
pub(super) fn classify(err: keyring::Error) -> KeyError {
    match err {
        keyring::Error::NoEntry => KeyError::KeychainItemNotFound,
        other => KeyError::KeychainFailure(other.to_string()),
    }
}
