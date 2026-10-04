//! Operating-system integration for macOS and Windows: input counting, idle
//! time, power and lock events, permissions. Platform code sits behind
//! `#[cfg(target_os)]`; the decisions it feeds are pure functions that compile
//! and test on every host. Every other target gets a compile-safe
//! implementation that returns [`PlatformError::Unsupported`] — never fake data.
//!
//! Each behaviour here is a port of what `legacy/agent` gets from Electron
//! (`powerMonitor`, `systemPreferences`) and `uiohook-napi`. The sources behind
//! every choice are in `ELECTRON-PARITY.md`; deliberate quirks are in `PARITY.md`.
//!
//! Privacy contract: input listeners deliver *counts and pointer positions
//! only*. Key identities, characters and text never leave the OS callback.
#![allow(
    unsafe_code,
    reason = "this is the one crate that talks to the OS: CoreGraphics event taps, IOKit, Win32 hooks"
)]

pub mod capture;
pub mod dpapi;
pub mod error;
pub mod idle;
pub mod input;
pub mod permissions;
pub mod power;
mod session;

#[cfg(target_os = "macos")]
mod mac_ffi;

pub use error::{PermissionKind, PlatformError};
