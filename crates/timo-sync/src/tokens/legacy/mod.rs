//! One-time import of the Electron agent's `safeStorage` files into the keychain.
//!
//! `legacy/agent` kept the session in `<userData>/tokens.bin` and a Lark login in
//! flight in `<userData>/pending-lark-login.bin`, both written by Electron's
//! `safeStorage` (Chromium `os_crypt`). [`import_legacy_session`] and
//! [`import_pending_lark_login`] decrypt them with the key the OS holds for that app,
//! store the result through [`super::KeychainTokenStore`] / the pending slot, verify
//! it reads back, and only then delete the files.
//!
//! The format, the key sources and every fact's source are in `OSCRYPT.md`.

mod candidates;
pub mod format;
mod import;
pub mod keys;
pub mod local_state;
mod payload;
mod scan;
#[doc(hidden)]
pub mod testing;

#[cfg(test)]
mod tests;

pub use candidates::{PENDING_LOGIN_FILE, TOKENS_FILE, token_candidates};
pub use format::{FormatError, Secret, decrypt_mac_v10, decrypt_windows_v10};
pub use import::{
    CandidateFailure, DiscardReason, ImportError, ImportOutcome, import_legacy_session,
    import_pending_lark_login,
};
pub use keys::{
    ELECTRON_PRODUCT_NAME, KeyError, MacKeychainKeySource, OsCryptKey, OsCryptKeySource,
};
pub use local_state::{KeyUnprotector, LocalStateKeySource, UnprotectError};
