//! Where the user's data lives. The Tauri app must read the SAME folder the
//! Electron app wrote (`agent.db` and its siblings), so an upgraded install
//! keeps its entries. Electron's `userData` is `<appData>/<productName>`:
//! `~/Library/Application Support/Timo` on macOS, `%APPDATA%\Timo` on Windows.
//! Tauri's own `app_data_dir()` would be keyed on the identifier instead.

use std::path::{Path, PathBuf};

const PRODUCT_NAME: &str = "Timo";

/// `<appData>/Timo`, given the platform's app-data base (Tauri's `data_dir`).
#[must_use]
pub fn user_data_dir(app_data: &Path) -> PathBuf {
    app_data.join(PRODUCT_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_electrons_user_data_folder() {
        let mac = Path::new("/Users/a/Library/Application Support");
        assert_eq!(
            user_data_dir(mac),
            Path::new("/Users/a/Library/Application Support/Timo")
        );
    }
}
