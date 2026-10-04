//! Launch-at-login health and repair.
//!
//! Port of `legacy/agent/src/main/services/launchAtLogin.ts` and
//! `legacy/agent/src/shared/launchAtLogin.ts`: a state machine over the
//! operating system's login-item registry, with every dependency injected.

pub mod env;
pub mod items;
pub mod service;
pub mod types;

pub use env::{AppThrew, LaunchEnv, LaunchLog, VerdictBranch};
pub use service::{LaunchAtLoginService, LaunchError, is_hidden_launch};
pub use types::{
    LaunchAtLoginHealth, LaunchAtLoginRemediation, LaunchItem, LoginItemQuery, LoginItemSettings,
    LoginItemSettingsPatch, MoveToApplicationsResult,
};
