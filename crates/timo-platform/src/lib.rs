//! Operating-system integration for macOS and Windows: input counting, idle
//! time, power and lock events, screen capture, permissions, keychain.
//! Platform code sits behind `#[cfg(target_os)]`; the decisions it feeds are
//! pure functions that compile and test on every host.
