//! Recover local state stranded by app identity changes.
//!
//! Windows `userData` is derived from Electron's runtime app name, so both the
//! Grind -> Timo rebrand and the scoped package fallback (`@grind/agent`) can
//! leave tokens and the local database behind while the fixed build reads
//! `%APPDATA%\Timo`. `safeStorage` keys are user-scoped (DPAPI on Windows), so
//! the current build can still decrypt copied tokens.
//!
//! Only acts when the current directory has NO session, so it never clobbers a
//! live login, and is fully best-effort: a failure here must never block boot.
//!
//! Port of `legacy/agent/src/main/services/legacyMigration.ts::migrateLegacyUserData`.
//! The function itself is not platform-gated, exactly as the TypeScript's is not;
//! the *call site* is (`index.ts:211`: `if (process.platform === 'win32')`), and that
//! gate belongs to the caller of this function.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::paths::{
    AGENT_DB, PENDING_LARK_LOGIN_BIN, PREFERENCES_JSON, SCREENSHOTS_DIR, TOKENS_BIN,
};

/// Suffix a migrated file is renamed to in the legacy directory.
pub const MIGRATED_SUFFIX: &str = ".migrated-to-timo";

/// Port of `LEGACY_APP_DIRS`: app-dir names of prior builds, as siblings of the current `userData`.
const LEGACY_APP_DIRS: [&[&str]; 2] = [&["Grind"], &["@grind", "agent"]];

/// Port of `MIGRATE_ENTRIES`.
const MIGRATE_ENTRIES: [&str; 5] = [
    TOKENS_BIN,
    PENDING_LARK_LOGIN_BIN,
    AGENT_DB,
    PREFERENCES_JSON,
    SCREENSHOTS_DIR,
];

/// What [`migrate_legacy_user_data`] did (the TypeScript returns `void` and logs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// The current directory already holds a session (`tokens.bin`): nothing to do.
    AlreadySignedIn,
    /// No legacy directory with a session was found.
    NothingToMigrate,
    /// Entries were copied from this legacy directory.
    Migrated {
        /// The legacy directory the session came from.
        from: PathBuf,
    },
    /// Something failed part-way (`legacy userData migration failed`); boot goes on.
    Failed(String),
}

/// Port of `migrateLegacyUserData`, with `app.getPath('userData')` passed in.
pub fn migrate_legacy_user_data(current_dir: &Path) -> MigrationOutcome {
    match migrate(current_dir) {
        Ok(outcome) => outcome,
        Err(error) => {
            tracing::warn!(%error, "legacy userData migration failed");
            MigrationOutcome::Failed(error.to_string())
        }
    }
}

fn migrate(current_dir: &Path) -> io::Result<MigrationOutcome> {
    if current_dir.join(TOKENS_BIN).exists() {
        return Ok(MigrationOutcome::AlreadySignedIn); // already signed in here
    }
    // `path.dirname`: the parent, and a root is its own parent.
    let parent = current_dir.parent().unwrap_or(current_dir);
    for parts in LEGACY_APP_DIRS {
        let legacy_dir = parts
            .iter()
            .fold(parent.to_path_buf(), |dir, part| dir.join(part));
        if legacy_dir == current_dir || !legacy_dir.join(TOKENS_BIN).exists() {
            continue;
        }
        fs::create_dir_all(current_dir)?;
        for entry in MIGRATE_ENTRIES {
            let from = legacy_dir.join(entry);
            let to = current_dir.join(entry);
            if from.exists() && !to.exists() {
                copy_recursive(&from, &to)?;
                quarantine_legacy_entry(&from);
            }
        }
        tracing::info!(from = %legacy_dir.display(), to = %current_dir.display(), "migrated legacy session from prior app identity");
        return Ok(MigrationOutcome::Migrated { from: legacy_dir });
    }
    Ok(MigrationOutcome::NothingToMigrate)
}

/// `fs.cpSync(from, to, { recursive: true })` for a destination that does not exist.
/// Symlinks are followed (copied as what they point to): a legacy directory holds only
/// files the agent itself wrote.
fn copy_recursive(from: &Path, to: &Path) -> io::Result<()> {
    if fs::metadata(from)?.is_dir() {
        fs::create_dir(to)?;
        for child in fs::read_dir(from)? {
            let name = child?.file_name();
            copy_recursive(&from.join(&name), &to.join(&name))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(drop)
    }
}

/// Port of `quarantineLegacyEntry`: rename the migrated entry to `<name>.migrated-to-timo`
/// so it is not migrated twice. When that name is already taken, the TypeScript calls
/// `fs.rmSync(file, { force: true })`, which removes a file but THROWS on a directory
/// (`ERR_FS_EISDIR`; `force` only forgives a missing path, `recursive` was not passed).
/// So a leftover `screenshots` directory stays put and is logged; copied as is.
fn quarantine_legacy_entry(file: &Path) {
    let mut name = file.as_os_str().to_owned();
    name.push(MIGRATED_SUFFIX);
    let backup = PathBuf::from(name);
    let result = if backup.exists() {
        remove_file_not_dir(file)
    } else {
        fs::rename(file, &backup)
    };
    if let Err(error) = result {
        tracing::warn!(%error, file = %file.display(), "legacy userData quarantine failed");
    }
}

/// `fs.rmSync(path, { force: true })`: a missing path is fine, a directory is an error.
fn remove_file_not_dir(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(meta) if meta.is_dir() => Err(io::Error::other("Path is a directory")),
        Ok(_) => fs::remove_file(path),
    }
}
