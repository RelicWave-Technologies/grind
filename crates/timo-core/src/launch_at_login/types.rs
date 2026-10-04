//! The data the launch-at-login service reads from and writes to the login-item
//! registry (Electron's `LoginItemSettings`, `LoginItemSettingsOptions`,
//! `Settings`) and reports (`LaunchAtLoginHealth`).

use serde::{Deserialize, Serialize};

use crate::desktop_types::LaunchAtLoginState;

/// `LaunchAtLoginRemediation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LaunchAtLoginRemediation {
    #[serde(rename = "NONE")]
    None,
    #[serde(rename = "MOVE_TO_APPLICATIONS")]
    MoveToApplications,
    #[serde(rename = "REGISTER")]
    Register,
    #[serde(rename = "ENABLE_STARTUP")]
    EnableStartup,
    #[serde(rename = "OPEN_LOGIN_ITEMS")]
    OpenLoginItems,
    #[serde(rename = "OPEN_STARTUP_APPS")]
    OpenStartupApps,
}

/// `LaunchAtLoginHealth`. Field order is the TypeScript literal's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "mirrors the TypeScript health object's independent flags"
)]
pub struct LaunchAtLoginHealth {
    pub required: bool,
    pub ready: bool,
    pub state: LaunchAtLoginState,
    pub can_repair: bool,
    pub remediation: LaunchAtLoginRemediation,
    pub opened_at_login: bool,
    pub checked_at: String,
}

/// An item of `LoginItemSettings['launchItems']` (Windows).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchItem {
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
    pub scope: String,
    pub enabled: bool,
}

/// The fields of Electron's `LoginItemSettings` the service reads.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginItemSettings {
    pub open_at_login: bool,
    pub was_opened_at_login: bool,
    pub status: String,
    pub executable_will_launch_at_login: bool,
    pub launch_items: Vec<LaunchItem>,
}

/// `LoginItemSettingsOptions` as the service builds it: `{ type: 'mainAppService' }`
/// on macOS, `{ path, args: ['--hidden'] }` on Windows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum LoginItemQuery {
    MainAppService {
        #[serde(rename = "type")]
        kind: &'static str,
    },
    Path {
        path: String,
        args: Vec<String>,
    },
}

/// `Settings` (what `setLoginItemSettings` receives), keys in the order the
/// TypeScript literals write them; absent keys are omitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginItemSettingsPatch {
    pub open_at_login: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

/// `MoveToApplicationsResult` (`shared/launchAtLogin.ts`) lives with the
/// move coordinator; re-exported here for the TypeScript module's sake.
pub use crate::move_to_applications::MoveToApplicationsResult;
