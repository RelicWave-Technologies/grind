//! Windows launch-item identity: which registry rows are ours.
//! Ports of the pure helpers of `launchAtLogin.ts`.

use super::types::LaunchItem;
use crate::js::path_win32 as win32;

pub const HIDDEN_ARG: &str = "--hidden";
pub const WINDOWS_ITEM_NAME: &str = "Timo";
pub const WINDOWS_DESCRIPTION_NAME: &str = "Timo time tracker desktop agent";

/// `LEGACY_WINDOWS_ITEMS`: `{ name, appDir, executable }`.
pub const LEGACY_WINDOWS_ITEMS: [(&str, &str, &str); 2] = [
    ("Grind", "Grind", "Grind.exe"),
    ("@grind/agent", "@grind", "agent.exe"),
];

/// `value.replace(/^"|"$/gu, '')` (a leading and a trailing quote), then
/// `path.win32.normalize(...)`, then `.toLowerCase()`.
#[must_use]
pub fn normalize_windows_path(value: &str) -> String {
    let without_lead = value.strip_prefix('"').unwrap_or(value);
    let without_quotes = without_lead.strip_suffix('"').unwrap_or(without_lead);
    win32::normalize(without_quotes).to_lowercase()
}

/// `value.trim().toLowerCase()`.
fn normalize_windows_name(value: &str) -> String {
    crate::js::string::trim(value).to_lowercase()
}

/// `sameWindowsPath`.
#[must_use]
pub fn same_windows_path(left: &str, right: &str) -> bool {
    normalize_windows_path(left) == normalize_windows_path(right)
}

/// `isCurrentWindowsItem`.
#[must_use]
pub fn is_current_item(item: &LaunchItem, exec_path: &str) -> bool {
    same_windows_path(&item.path, exec_path)
}

/// `isCanonicalWindowsItem`: the name we register under, at this executable.
/// (`item.args` is deliberately not compared; see the TypeScript comment.)
#[must_use]
pub fn is_canonical_item(item: &LaunchItem, exec_path: &str) -> bool {
    item.name == WINDOWS_ITEM_NAME && is_current_item(item, exec_path)
}

/// `WINDOWS_OWNED_NAMES.has(name)`.
fn is_owned_name(name: &str) -> bool {
    name == WINDOWS_ITEM_NAME.to_lowercase()
        || name == WINDOWS_DESCRIPTION_NAME.to_lowercase()
        || LEGACY_WINDOWS_ITEMS
            .iter()
            .any(|(legacy, _, _)| name == legacy.to_lowercase())
}

/// `isOwnedWindowsStartupItem`.
#[must_use]
pub fn is_owned_startup_item(item: &LaunchItem, exec_path: &str) -> bool {
    if is_owned_name(&normalize_windows_name(&item.name)) {
        return true;
    }
    if same_windows_path(&item.path, exec_path) {
        return true;
    }
    let normalized = normalize_windows_path(&item.path);
    let executable = win32::basename(&normalized);
    (executable == "timo.exe" && normalized.contains("\\timo\\"))
        || (executable == "grind.exe" && normalized.contains("\\grind\\"))
        || (executable == "agent.exe" && normalized.contains("\\@grind\\"))
}
