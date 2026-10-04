//! Port of `legacy/agent/src/main/trayPresentation.ts`: tray title and tooltip
//! strings.

use crate::js::string::trim;

const TRAY_APP_NAME: &str = "Timo";

/// Port of `trayMenuTitleForElapsed(elapsedText?, { hasIcon? })`; `has_icon`
/// defaults to `true` when `None`.
#[must_use]
pub fn tray_menu_title_for_elapsed(elapsed_text: Option<&str>, has_icon: Option<bool>) -> String {
    let has_icon = has_icon.unwrap_or(true);
    let elapsed = elapsed_text.map(trim).unwrap_or_default();
    if !elapsed.is_empty() {
        return if has_icon {
            format!(" {elapsed}")
        } else {
            format!("{TRAY_APP_NAME} {elapsed}")
        };
    }
    if has_icon {
        String::new()
    } else {
        TRAY_APP_NAME.to_owned()
    }
}

/// Port of `trayTooltipForElapsed(elapsedText?)`.
#[must_use]
pub fn tray_tooltip_for_elapsed(elapsed_text: Option<&str>) -> String {
    let elapsed = elapsed_text.map(trim).unwrap_or_default();
    if elapsed.is_empty() {
        TRAY_APP_NAME.to_owned()
    } else {
        format!("{TRAY_APP_NAME} {elapsed}")
    }
}
