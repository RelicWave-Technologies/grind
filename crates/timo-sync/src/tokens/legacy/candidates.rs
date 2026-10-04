//! The Electron agent's on-disk slots for the session.
//!
//! Port of `tokenStore.ts::tokenCandidates` and `removeTokenFiles`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// `tokenStore.ts::filePath`: `<userData>/tokens.bin`.
pub const TOKENS_FILE: &str = "tokens.bin";
/// `pendingLarkLoginStore.ts::filePath`.
pub const PENDING_LOGIN_FILE: &str = "pending-lark-login.bin";

/// `name === base || (name.startsWith(`${base}.`) && name.endsWith('.next'))`.
fn is_candidate_name(name: &str) -> bool {
    name == TOKENS_FILE
        || (name
            .strip_prefix(TOKENS_FILE)
            .is_some_and(|rest| rest.starts_with('.'))
            && Path::new(name).extension().is_some_and(|ext| ext == "next"))
}

/// Every session slot in `user_data`, newest modification first.
///
/// The TypeScript sorts `readdir` order by `mtimeMs` descending (stable); `readdir`
/// order is arbitrary, so ties are broken here by name, for the same answer on every
/// host. A slot that is not a regular file, or vanishes between listing and stat,
/// cannot hold a session and is left out. A missing directory is no candidates.
pub fn token_candidates(user_data: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(user_data) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut dated: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in entries {
        let entry = entry?;
        let named = entry.file_name().to_str().is_some_and(is_candidate_name);
        if !named {
            continue;
        }
        let Ok(meta) = fs::metadata(entry.path()) else {
            continue;
        };
        if let (true, Ok(modified)) = (meta.is_file(), meta.modified()) {
            dated.push((modified, entry.path()));
        }
    }
    dated.sort_by(|a, b| a.1.cmp(&b.1));
    dated.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    Ok(dated.into_iter().map(|(_, path)| path).collect())
}

/// Delete `files`; a file already gone is fine. Returns how many could not be
/// deleted for another reason (the session is already safe in the keychain).
#[must_use]
pub fn remove_files(files: &[PathBuf]) -> usize {
    files
        .iter()
        .filter(|file| match fs::remove_file(file) {
            Ok(()) => false,
            Err(e) => e.kind() != io::ErrorKind::NotFound,
        })
        .count()
}
