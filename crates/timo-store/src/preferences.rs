//! Local, user-scoped preferences: small UI choices that belong to the device,
//! not the account (floating-bar visibility and position, the last tracked task).
//! Not secrets (those live behind the OS keychain) and not workspace policy
//! (server-owned). Just per-install chrome state.
//!
//! Port of `legacy/agent/src/main/services/preferences.ts`. Design, as there:
//! one JSON file in the user-data directory, read once into memory at boot; a
//! corrupt or partial file degrades to defaults rather than blocking startup;
//! writes are atomic (temp file + rename).
//!
//! The TypeScript debounces writes by 250 ms and notifies listeners. Both are
//! the caller's job here: [`PreferencesStore::patch_floating_bar`] and
//! [`PreferencesStore::remember_last_lark_task`] say whether something changed
//! (the caller then schedules [`PreferencesStore::flush`] and notifies), and
//! there are no timers in this crate.

use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic_write::write_atomic;
use crate::file_error::FileStoreError;
pub use crate::preferences_json::{FloatingBarPreferences, Preferences, coerce, serialize};

/// Port of the `Partial<FloatingBarPreferences>` a caller hands to `patchFloatingBar`.
/// `None` leaves a field alone; `Some(None)` sets a position back to "default corner".
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FloatingBarPatch {
    /// New visibility.
    pub visible: Option<bool>,
    /// New x (`Some(None)` clears it).
    pub x: Option<Option<f64>>,
    /// New y (`Some(None)` clears it).
    pub y: Option<Option<f64>>,
}

/// Port of the module-level `cache` + `filePath()` of `preferences.ts`.
#[derive(Debug)]
pub struct PreferencesStore {
    path: PathBuf,
    cache: Preferences,
}

impl PreferencesStore {
    /// Load once at boot. Port of `ensureLoaded`: a missing file is silently the
    /// defaults, an unreadable or corrupt one is the defaults with a warning.
    #[must_use]
    pub fn load(path: PathBuf) -> Self {
        let cache = match read(&path) {
            Ok(prefs) => prefs,
            Err(error) => {
                if !error.is_not_found() {
                    tracing::warn!(%error, "preferences: unreadable, using defaults");
                }
                Preferences::default()
            }
        };
        Self { path, cache }
    }

    /// The file this store reads and writes.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A structural copy, so callers cannot mutate the cache in place.
    /// Port of `getPreferences`.
    #[must_use]
    pub fn get(&self) -> Preferences {
        self.cache.clone()
    }

    /// Shallow-merge a partial update into the floating-bar prefs. The caller then
    /// schedules a [`flush`](Self::flush) and notifies its listeners with the
    /// returned snapshot (the TypeScript does both unconditionally, even for an
    /// empty patch). Port of `patchFloatingBar`.
    pub fn patch_floating_bar(&mut self, patch: FloatingBarPatch) -> Preferences {
        let bar = &mut self.cache.floating_bar;
        if let Some(visible) = patch.visible {
            bar.visible = visible;
        }
        if let Some(x) = patch.x {
            bar.x = x;
        }
        if let Some(y) = patch.y {
            bar.y = y;
        }
        self.get()
    }

    /// Remember the task the user is tracking. The flag is `false` when nothing
    /// changed, in which case the caller must not schedule a write or notify (it
    /// is called on every start and must stay off the disk). Port of `rememberLastLarkTask`.
    pub fn remember_last_lark_task(&mut self, guid: Option<&str>) -> (Preferences, bool) {
        if self.cache.last_lark_task_guid.as_deref() == guid {
            return (self.get(), false);
        }
        self.cache.last_lark_task_guid = guid.map(str::to_owned);
        (self.get(), true)
    }

    /// Atomic write: temp file + rename, so a crash mid-write never corrupts.
    /// Port of `flush` (the quit-time `flushPreferences` is the same call).
    pub fn flush(&self) -> Result<(), FileStoreError> {
        write_atomic(&self.path, serialize(&self.cache).as_bytes())?;
        Ok(())
    }
}

/// `coerce(JSON.parse(readFileSync(path, 'utf8')))`. Invalid UTF-8 becomes U+FFFD, as Node's decoder does.
fn read(path: &Path) -> Result<Preferences, FileStoreError> {
    let bytes = fs::read(path)?;
    let value = serde_json::from_str(&String::from_utf8_lossy(&bytes))?;
    Ok(coerce(&value))
}
