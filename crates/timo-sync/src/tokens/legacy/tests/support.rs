//! Shared fixtures: temp dirs, fake key sources, vaults that misbehave.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use crate::tokens::legacy::keys::{KeyError, OsCryptKey, OsCryptKeySource};
use crate::tokens::legacy::testing::{encrypt_mac_v10, encrypt_windows_v10};
use crate::tokens::{MAX_SECRET_BYTES, MemoryVault, SecretVault, StoredTokens, VaultError};

pub const MAC_PASSWORD: &[u8] = b"aBcDeFgHiJkLmNoPqRsTuV==";
pub const WINDOWS_KEY: [u8; 32] = *b"0123456789abcdef0123456789abcdef";
pub const WINDOWS_NONCE: [u8; 12] = *b"nonce-nonce!";

/// A scratch directory removed on drop, under `$TIMO_TEST_TMP` or the OS temp dir.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let base = std::env::var_os("TIMO_TEST_TMP").map_or_else(std::env::temp_dir, PathBuf::from);
        let path = base.join("timo-legacy-import").join(format!(
            "{}-{}-{label}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).expect("write file");
        path
    }

    pub fn exists(&self, name: &str) -> bool {
        self.0.join(name).exists()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        drop(fs::remove_dir_all(&self.0));
    }
}

/// Set a file's modification time to `seconds` after the epoch.
pub fn touch(path: &Path, seconds: u64) {
    let file = fs::File::options()
        .write(true)
        .open(path)
        .expect("open for touch");
    file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
        .expect("set mtime");
}

pub fn tokens(tag: &str) -> StoredTokens {
    StoredTokens {
        access_token: format!("access-{tag}"),
        refresh_token: format!("refresh-{tag}"),
        user_id: format!("user-{tag}"),
        workspace_id: format!("ws-{tag}"),
    }
}

/// `JSON.stringify(tokens)`, as `tokenStore.ts::writeTokens` does.
pub fn tokens_json(t: &StoredTokens) -> Vec<u8> {
    serde_json::to_vec(t).expect("serialize tokens")
}

/// Which OS's blobs a test builds.
#[derive(Clone, Copy)]
pub enum Os {
    Mac,
    Windows,
}

impl Os {
    pub const BOTH: [Self; 2] = [Self::Mac, Self::Windows];

    pub fn key(self) -> OsCryptKey {
        match self {
            Self::Mac => OsCryptKey::mac_password(MAC_PASSWORD.to_vec()).expect("password"),
            Self::Windows => OsCryptKey::windows_key(WINDOWS_KEY.to_vec()).expect("key"),
        }
    }

    pub fn encrypt(self, plaintext: &[u8]) -> Vec<u8> {
        match self {
            Self::Mac => encrypt_mac_v10(plaintext, MAC_PASSWORD).expect("encrypt"),
            Self::Windows => {
                encrypt_windows_v10(plaintext, &WINDOWS_KEY, &WINDOWS_NONCE).expect("encrypt")
            }
        }
    }

    /// A key that is the wrong one for [`Os::encrypt`]'s blobs.
    pub fn wrong_key(self) -> OsCryptKey {
        match self {
            Self::Mac => {
                OsCryptKey::mac_password(b"not-the-password==".to_vec()).expect("password")
            }
            Self::Windows => OsCryptKey::windows_key(vec![7; 32]).expect("key"),
        }
    }
}

/// A key source that counts how often it is asked.
pub struct FakeKeys {
    key: Result<OsCryptKey, KeyError>,
    calls: AtomicUsize,
}

impl FakeKeys {
    pub fn new(key: Result<OsCryptKey, KeyError>) -> Self {
        Self {
            key,
            calls: AtomicUsize::new(0),
        }
    }

    pub fn ok(os: Os) -> Self {
        Self::new(Ok(os.key()))
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl OsCryptKeySource for FakeKeys {
    fn load_key(&self) -> Result<OsCryptKey, KeyError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.key.clone()
    }
}

/// A vault that accepts writes but never returns them.
#[derive(Debug, Default)]
pub struct ForgetfulVault;

impl SecretVault for ForgetfulVault {
    fn get(&self, _slot: &str) -> Result<Option<Vec<u8>>, VaultError> {
        Ok(None)
    }

    fn set(&self, _slot: &str, _secret: &[u8]) -> Result<(), VaultError> {
        Ok(())
    }

    fn delete(&self, _slot: &str) -> Result<(), VaultError> {
        Ok(())
    }
}

/// A vault whose writes fail.
#[derive(Debug, Default)]
pub struct ReadOnlyVault(pub MemoryVault);

impl SecretVault for ReadOnlyVault {
    fn get(&self, slot: &str) -> Result<Option<Vec<u8>>, VaultError> {
        self.0.get(slot)
    }

    fn set(&self, _slot: &str, secret: &[u8]) -> Result<(), VaultError> {
        if secret.len() > MAX_SECRET_BYTES {
            return Err(VaultError::TooLarge(secret.len()));
        }
        Err(VaultError::Backend("keychain is read only".to_owned()))
    }

    fn delete(&self, slot: &str) -> Result<(), VaultError> {
        self.0.delete(slot)
    }
}
