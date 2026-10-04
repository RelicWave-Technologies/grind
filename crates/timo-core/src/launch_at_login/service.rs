//! Port of `createLaunchAtLoginService` in
//! `legacy/agent/src/main/services/launchAtLogin.ts`.

use thiserror::Error;

mod windows;

use super::env::{AppThrew, LaunchEnv, LaunchLog};
use super::items::{HIDDEN_ARG, WINDOWS_ITEM_NAME};
use super::types::{
    LaunchAtLoginHealth, LaunchAtLoginRemediation as Fix, LoginItemQuery, LoginItemSettings,
    LoginItemSettingsPatch,
};
use crate::desktop_types::{LaunchAtLoginState as State, LaunchOrigin};
use crate::js::iso::{InvalidTimeValue, to_iso_string};

/// What escapes the service: an exception of the clock (`RangeError`) or of an
/// Electron call that no `try` of the TypeScript catches.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LaunchError {
    #[error("Invalid time value")]
    InvalidTime,
    #[error("{}", .0.message)]
    App(AppThrew),
}

impl LaunchError {
    /// `String(err)`.
    fn text(&self) -> String {
        match self {
            Self::InvalidTime => "RangeError: Invalid time value".to_owned(),
            Self::App(e) => e.text(),
        }
    }
}

impl From<InvalidTimeValue> for LaunchError {
    fn from(_: InvalidTimeValue) -> Self {
        Self::InvalidTime
    }
}

impl From<AppThrew> for LaunchError {
    fn from(e: AppThrew) -> Self {
        Self::App(e)
    }
}

type Health = Result<LaunchAtLoginHealth, LaunchError>;

/// Port of `isHiddenLaunch`: only the explicit hidden startup argument counts.
#[must_use]
pub fn is_hidden_launch(argv: &[String]) -> bool {
    argv.iter().any(|a| a == HIDDEN_ARG)
}

/// `supported(platform)`.
fn supported(platform: &str) -> bool {
    platform == "darwin" || platform == "win32"
}

/// Port of the service closure.
#[derive(Debug)]
pub struct LaunchAtLoginService<E: LaunchEnv> {
    env: E,
    opened_at_login: bool,
    last_windows_verdict: Option<LaunchLog>,
}

impl<E: LaunchEnv> LaunchAtLoginService<E> {
    /// `createLaunchAtLoginService(deps)`: reads the macOS login origin now,
    /// before any registration changes.
    pub fn new(mut env: E) -> Self {
        let opened_at_login = detect_opened_at_login(&mut env);
        Self {
            env,
            opened_at_login,
            last_windows_verdict: None,
        }
    }

    pub fn env(&self) -> &E {
        &self.env
    }

    pub fn env_mut(&mut self) -> &mut E {
        &mut self.env
    }

    /// `shouldStartHidden()`.
    pub fn should_start_hidden(&self) -> bool {
        self.opened_at_login
    }

    /// `launchOrigin()`.
    pub fn launch_origin(&self) -> LaunchOrigin {
        if !self.env.is_packaged() || !supported(&self.env.platform()) {
            LaunchOrigin::Unknown
        } else if self.opened_at_login {
            LaunchOrigin::LoginItem
        } else {
            LaunchOrigin::User
        }
    }

    /// `moveToApplicationsFolder(options)`.
    pub fn move_to_applications_folder(&mut self, with_options: bool) -> bool {
        if !self.env.is_packaged()
            || self.env.platform() != "darwin"
            || self.env.is_in_applications_folder()
        {
            return false;
        }
        self.env.move_to_applications_folder(with_options)
    }

    fn result(&mut self, state: State, remediation: Fix, can_repair: bool) -> Health {
        let now = self.env.now();
        Ok(LaunchAtLoginHealth {
            required: state != State::Unavailable,
            ready: state == State::Ready,
            state,
            can_repair,
            remediation,
            opened_at_login: self.opened_at_login,
            checked_at: to_iso_string(now)?,
        })
    }

    /// `BLOCKED` with the remediation of the current platform.
    fn blocked(&mut self) -> Health {
        let fix = if self.env.platform() == "darwin" {
            Fix::OpenLoginItems
        } else {
            Fix::OpenStartupApps
        };
        self.result(State::Blocked, fix, false)
    }

    /// `inspect()`.
    pub fn inspect(&mut self) -> Health {
        if !self.env.is_packaged() || !supported(&self.env.platform()) {
            return self.result(State::Unavailable, Fix::None, false);
        }
        if self.env.platform() == "darwin" {
            self.inspect_mac()
        } else {
            self.inspect_windows()
        }
    }

    fn inspect_mac(&mut self) -> Health {
        if !self.env.is_in_applications_folder() {
            return self.result(State::NeedsInstall, Fix::MoveToApplications, false);
        }
        let attempt = self.mac_verdict();
        match attempt {
            Ok(health) => Ok(health),
            Err(_) => self.result(State::Blocked, Fix::OpenLoginItems, false),
        }
    }

    /// The `try` body of `inspectMac`.
    fn mac_verdict(&mut self) -> Health {
        let query = canonical_query(&self.env);
        let settings = self.env.get_login_item_settings(query.as_ref())?;
        if settings.status == "enabled" && settings.open_at_login {
            return self.result(State::Ready, Fix::None, false);
        }
        if settings.status == "requires-approval" {
            return self.result(State::NeedsApproval, Fix::OpenLoginItems, false);
        }
        if settings.status == "not-registered" || settings.status == "not-found" {
            return self.result(State::NeedsRegistration, Fix::Register, true);
        }
        self.result(State::Blocked, Fix::OpenLoginItems, false)
    }

    /// `blockedAfterAttempt`.
    fn blocked_after_attempt(&mut self, next: LaunchAtLoginHealth) -> Health {
        if next.ready || next.state == State::NeedsApproval || next.state == State::NeedsInstall {
            return Ok(next);
        }
        self.blocked()
    }

    /// `registerAndVerify()`.
    fn register_and_verify(&mut self) -> Health {
        let attempt = self.try_register();
        match attempt {
            Ok(health) => Ok(health),
            Err(_) => self.blocked(),
        }
    }

    fn try_register(&mut self) -> Health {
        let patch = canonical_registration(&self.env);
        self.env.set_login_item_settings(&patch)?;
        let next = self.inspect()?;
        self.blocked_after_attempt(next)
    }

    /// `cleanupAfterReady(health)`.
    fn cleanup_after_ready(&mut self, health: LaunchAtLoginHealth) -> Health {
        if !health.ready {
            return Ok(health);
        }
        if self.env.platform() == "win32" && !self.has_verified_canonical_registration() {
            let patch = canonical_registration(&self.env);
            if self.env.set_login_item_settings(&patch).is_err() {
                return Ok(health);
            }
            if !self.has_verified_canonical_registration() {
                return Ok(health);
            }
        }
        self.cleanup_windows_items()?;
        self.inspect()
    }

    /// `repair()`.
    pub fn repair(&mut self) -> Health {
        let health = self.inspect()?;
        if health.state != State::NeedsRegistration && health.state != State::NeedsRepair {
            return self.cleanup_after_ready(health);
        }
        let registered = self.register_and_verify()?;
        self.cleanup_after_ready(registered)
    }

    /// `reconcileOnBoot()`: boot self-heals the same states as an explicit repair.
    pub fn reconcile_on_boot(&mut self) -> Health {
        self.repair()
    }
}

/// `detectOpenedAtLogin`.
fn detect_opened_at_login<E: LaunchEnv>(env: &mut E) -> bool {
    let platform = env.platform();
    if !env.is_packaged() || !supported(&platform) {
        return false;
    }
    if platform == "win32" {
        return is_hidden_launch(&env.argv());
    }
    let query = canonical_query(env);
    env.get_login_item_settings(query.as_ref())
        .is_ok_and(|s: LoginItemSettings| s.was_opened_at_login)
}

/// `canonicalQuery`.
fn canonical_query<E: LaunchEnv>(env: &E) -> Option<LoginItemQuery> {
    match env.platform().as_str() {
        "darwin" => Some(LoginItemQuery::MainAppService {
            kind: "mainAppService",
        }),
        "win32" => Some(LoginItemQuery::Path {
            path: env.exec_path(),
            args: vec![HIDDEN_ARG.to_owned()],
        }),
        _ => None,
    }
}

/// `canonicalRegistration(deps)` (always `openAtLogin = true`).
fn canonical_registration<E: LaunchEnv>(env: &E) -> LoginItemSettingsPatch {
    if env.platform() == "darwin" {
        return LoginItemSettingsPatch {
            open_at_login: true,
            enabled: None,
            kind: Some("mainAppService"),
            name: None,
            path: None,
            args: None,
        };
    }
    LoginItemSettingsPatch {
        open_at_login: true,
        enabled: Some(true),
        kind: None,
        name: Some(WINDOWS_ITEM_NAME.to_owned()),
        path: Some(env.exec_path()),
        args: Some(vec![HIDDEN_ARG.to_owned()]),
    }
}
