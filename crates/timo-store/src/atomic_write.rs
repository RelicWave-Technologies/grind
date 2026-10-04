//! Atomic file replacement shared by the JSON files in the user-data directory.

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

/// The temp file a write to `target` goes through: `<target>.<pid>.tmp`.
#[must_use]
pub fn temp_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_owned();
    name.push(format!(".{}.tmp", std::process::id()));
    PathBuf::from(name)
}

/// Writes `contents` to a temp file (mode `0600` where the platform has modes)
/// and renames it over `target`, so a crash mid-write never leaves a half file.
/// On failure the temp file is removed, best effort, and the error returned.
///
/// Port of the `fs.writeFile(tmp, data, { mode: 0o600 })` + `fs.rename(tmp, target)`
/// pair in `preferences.ts::flush` and `workspaceTime.ts::applyServerWorkspaceTimeZone`.
pub fn write_atomic(target: &Path, contents: &[u8]) -> io::Result<()> {
    let tmp = temp_path(target);
    let result = write_temp(&tmp, contents).and_then(|()| fs::rename(&tmp, target));
    if result.is_err() {
        discard(&tmp);
    }
    result
}

/// `void fs.unlink(tmp).catch(() => undefined)`.
fn discard(tmp: &Path) {
    if let Err(error) = fs::remove_file(tmp) {
        tracing::debug!(%error, "temp file already gone");
    }
}

fn write_temp(tmp: &Path, contents: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(tmp)?.write_all(contents)
}
