//! Where a screenshot lives on disk, and the one function that writes it.
//!
//! Layout (`legacy/.../capture/capture.ts::dayDir` and `captureNow`):
//! `<userData>/screenshots/<YYYY-MM-DD>/<id>.webp`, the date being the **UTC**
//! day of `capturedAt` (`new Date(now).toISOString().slice(0, 10)`) — not the
//! workspace time zone. Files are created with mode `0600`.
//!
//! Time and ids are inputs: nothing here reads a clock or makes a ULID.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use timo_core::js::iso::to_iso_string;

use crate::PlatformError;

/// The folder holding every day's screenshots.
#[must_use]
pub fn screenshots_dir(user_data: &Path) -> PathBuf {
    user_data.join("screenshots")
}

/// `new Date(capturedAt).toISOString().slice(0, 10)`: the UTC calendar day of a
/// capture time given as (possibly fractional) epoch milliseconds, as
/// `serverAlignedNow()` returns it. A time `Date` rejects is an error, exactly
/// where legacy's `toISOString()` throws a `RangeError`.
pub fn utc_day(captured_at_ms: f64) -> Result<String, PlatformError> {
    let iso = to_iso_string(captured_at_ms)
        .map_err(|e| PlatformError::os("screenshot day directory", e))?;
    Ok(iso.chars().take(10).collect())
}

/// `<userData>/screenshots/<UTC day>`: legacy's `dayDir(now)`.
pub fn day_dir(user_data: &Path, captured_at_ms: f64) -> Result<PathBuf, PlatformError> {
    Ok(screenshots_dir(user_data).join(utc_day(captured_at_ms)?))
}

/// `<userData>/screenshots/<UTC day>/<id>.webp`: the `filePath` legacy stores.
/// An id that could escape the day folder (empty, or holding a path separator or
/// a NUL) is refused; a ULID never does.
pub fn screenshot_path(
    user_data: &Path,
    captured_at_ms: f64,
    id: &str,
) -> Result<PathBuf, PlatformError> {
    if id.is_empty() || id.contains(['/', '\\', '\0']) || id == "." || id == ".." {
        return Err(PlatformError::os(
            "screenshot path",
            format!("`{id}` is not a usable file id"),
        ));
    }
    Ok(day_dir(user_data, captured_at_ms)?.join(format!("{id}.webp")))
}

/// Create the day folder if needed and write the WebP bytes to
/// [`screenshot_path`], mode `0600` on unix (`fs.writeFile(path, buf, { mode:
/// 0o600 })`: the mode applies when the file is created, and a file that already
/// exists is overwritten). Returns the path.
pub fn write_screenshot(
    user_data: &Path,
    captured_at_ms: f64,
    id: &str,
    webp: &[u8],
) -> Result<PathBuf, PlatformError> {
    let path = screenshot_path(user_data, captured_at_ms, id)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| PlatformError::os("create screenshot folder", e))?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| PlatformError::os("open screenshot file", e))?;
    file.write_all(webp)
        .map_err(|e| PlatformError::os("write screenshot file", e))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_day_is_the_utc_date_not_the_local_one() {
        // 2026-10-05T23:59:59.999Z and one millisecond later.
        assert_eq!(utc_day(1_791_244_799_999.0).unwrap(), "2026-10-05");
        assert_eq!(utc_day(1_791_244_800_000.0).unwrap(), "2026-10-06");
    }

    #[test]
    fn a_fractional_timestamp_truncates_like_date() {
        assert_eq!(utc_day(1_791_244_799_999.9).unwrap(), "2026-10-05");
        assert_eq!(utc_day(1_791_133_383_891.262_7).unwrap(), "2026-10-04");
    }

    #[test]
    fn dates_javascript_rejects_are_errors() {
        assert!(utc_day(f64::NAN).is_err());
        assert!(utc_day(f64::INFINITY).is_err());
        assert!(utc_day(8.64e15 + 1.0).is_err());
    }

    #[test]
    fn the_path_is_user_data_screenshots_day_id_webp() {
        let path = screenshot_path(Path::new("/data/Timo"), 1_791_133_383_891.0, "01ABC").unwrap();
        assert_eq!(
            path,
            Path::new("/data/Timo/screenshots/2026-10-04/01ABC.webp")
        );
    }

    #[test]
    fn an_id_that_could_leave_the_day_folder_is_refused() {
        for bad in ["", ".", "..", "a/b", "a\\b", "../x", "a\0b"] {
            assert!(
                screenshot_path(Path::new("/d"), 0.0, bad).is_err(),
                "`{bad:?}` accepted"
            );
        }
    }

    #[test]
    fn writing_makes_the_folder_and_a_private_file() {
        let root = std::env::temp_dir().join(format!("timo-layout-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root).unwrap();
        }
        let written = write_screenshot(&root, 1_791_133_383_891.0, "01TEST", b"RIFFdata").unwrap();
        assert_eq!(fs::read(&written).unwrap(), b"RIFFdata");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&written).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // A second write to the same id replaces the file, like `writeFile`.
        write_screenshot(&root, 1_791_133_383_891.0, "01TEST", b"x").unwrap();
        assert_eq!(fs::read(&written).unwrap(), b"x");
        fs::remove_dir_all(&root).unwrap();
    }
}
