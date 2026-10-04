//! The injected world of the launch-at-login service: `deps` of
//! `createLaunchAtLoginService` (the Electron `app`, the platform, the
//! executable path, `argv`, the clock) and its log sink.

use serde::Serialize;

use super::types::{LoginItemQuery, LoginItemSettings, LoginItemSettingsPatch};
use crate::desktop_types::LaunchAtLoginState;

/// An exception thrown by an Electron call; `message` is `err.message`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppThrew {
    pub message: String,
}

impl AppThrew {
    /// `String(err)` for an `Error`.
    #[must_use]
    pub fn text(&self) -> String {
        format!("Error: {}", self.message)
    }
}

/// Which branch produced a non-READY Windows verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum VerdictBranch {
    #[serde(rename = "canonical-item-disabled")]
    CanonicalItemDisabled,
    #[serde(rename = "current-item-disabled")]
    CurrentItemDisabled,
    #[serde(rename = "related-item-present")]
    RelatedItemPresent,
    #[serde(rename = "no-item-found")]
    NoItemFound,
    #[serde(rename = "getLoginItemSettings-threw")]
    GetLoginItemSettingsThrew,
}

/// The readings behind a Windows verdict (`readings` of `inspectWindows`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "mirrors the TypeScript readings object's independent flags"
)]
pub struct Readings {
    pub canonical_enabled: Option<bool>,
    pub has_enabled_current: bool,
    pub has_disabled_current: bool,
    pub open_at_login: bool,
    pub executable_will_launch_at_login: bool,
    pub opened_at_login: bool,
    pub item_count: usize,
}

/// `log.warn('launch at login verdict', { state, branch, ...fields })`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum LaunchLog {
    Readings {
        state: LaunchAtLoginState,
        branch: VerdictBranch,
        #[serde(flatten)]
        readings: Readings,
    },
    Threw {
        state: LaunchAtLoginState,
        branch: VerdictBranch,
        err: String,
    },
}

/// Everything the service reaches outside itself for.
pub trait LaunchEnv {
    /// `deps.app.isPackaged`.
    fn is_packaged(&self) -> bool;
    /// `deps.platform` (a Node platform string).
    fn platform(&self) -> String;
    /// `deps.execPath`.
    fn exec_path(&self) -> String;
    /// `deps.argv`.
    fn argv(&self) -> Vec<String>;
    /// `deps.now()`.
    fn now(&mut self) -> f64;
    /// `deps.app.getLoginItemSettings(options?)`.
    fn get_login_item_settings(
        &mut self,
        options: Option<&LoginItemQuery>,
    ) -> Result<LoginItemSettings, AppThrew>;
    /// `deps.app.setLoginItemSettings(settings)`.
    fn set_login_item_settings(
        &mut self,
        settings: &LoginItemSettingsPatch,
    ) -> Result<(), AppThrew>;
    /// `deps.app.isInApplicationsFolder()`.
    fn is_in_applications_folder(&mut self) -> bool;
    /// `deps.app.moveToApplicationsFolder(options)`; `with_options` says whether
    /// the caller passed options (opaque here).
    fn move_to_applications_folder(&mut self, with_options: bool) -> bool;
    /// `log.warn(...)` of `logWindowsVerdict`.
    fn log(&mut self, entry: &LaunchLog);
}
