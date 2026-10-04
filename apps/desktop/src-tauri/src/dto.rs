//! Types that cross the IPC boundary. `ts-rs` writes them to
//! `apps/desktop/src/generated/*.ts` (`pnpm --filter @grind/desktop bindings`),
//! which the TypeScript bridge imports, so a Rust field change that the renderer
//! does not follow fails `pnpm typecheck`.

use serde::Serialize;
use ts_rs::TS;

/// `process.platform`, spelled the way the renderer already expects.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/generated/")]
pub enum Platform {
    Darwin,
    Win32,
    Linux,
}

impl Platform {
    #[must_use]
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Darwin
        } else if cfg!(target_os = "windows") {
            Self::Win32
        } else {
            Self::Linux
        }
    }
}

/// The part of `settings:get` that needs no services. The rest
/// (`launchAtLogin`, `screenStatus`, `floatingBarVisible`) is still
/// `not ported yet: settings_get_services`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/generated/")]
pub struct SettingsInfo {
    pub version: String,
    pub platform: Platform,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_serializes_like_process_platform() {
        assert_eq!(
            serde_json::to_string(&Platform::Darwin).ok().as_deref(),
            Some("\"darwin\"")
        );
        assert_eq!(
            serde_json::to_string(&Platform::Win32).ok().as_deref(),
            Some("\"win32\"")
        );
    }

    #[test]
    fn settings_info_has_the_renderer_field_names() {
        let info = SettingsInfo {
            version: "1.2.3".into(),
            platform: Platform::Win32,
        };
        let json = serde_json::to_value(info).ok();
        assert_eq!(
            json,
            Some(serde_json::json!({ "version": "1.2.3", "platform": "win32" }))
        );
    }
}
