//! The Windows half of the service: reading the Run-key launch items, deciding
//! the verdict, and removing legacy and duplicate rows.

use super::{Health, LaunchAtLoginService, canonical_query};
use crate::desktop_types::LaunchAtLoginState as State;
use crate::js::path_win32 as win32;
use crate::launch_at_login::env::{AppThrew, LaunchEnv, LaunchLog, Readings, VerdictBranch};
use crate::launch_at_login::items::{
    HIDDEN_ARG, LEGACY_WINDOWS_ITEMS, is_canonical_item, is_current_item, is_owned_startup_item,
};
use crate::launch_at_login::types::LaunchAtLoginRemediation as Fix;
use crate::launch_at_login::types::LoginItemSettingsPatch;

impl<E: LaunchEnv> LaunchAtLoginService<E> {
    pub(super) fn inspect_windows(&mut self) -> Health {
        match self.windows_verdict() {
            Ok(health) => Ok(health),
            Err(err) => {
                self.log_windows_verdict(&LaunchLog::Threw {
                    state: State::Blocked,
                    branch: VerdictBranch::GetLoginItemSettingsThrew,
                    err: err.text(),
                });
                self.result(State::Blocked, Fix::OpenStartupApps, false)
            }
        }
    }

    /// The `try` body of `inspectWindows`.
    fn windows_verdict(&mut self) -> Health {
        let query = canonical_query(&self.env);
        let settings = self.env.get_login_item_settings(query.as_ref())?;
        let exec = self.env.exec_path();
        let canonical = settings
            .launch_items
            .iter()
            .find(|i| is_canonical_item(i, &exec));
        let current = |enabled: bool| {
            settings
                .launch_items
                .iter()
                .any(|i| is_current_item(i, &exec) && i.enabled == enabled)
        };
        let (enabled_current, disabled_current) = (current(true), current(false));
        let readings = Readings {
            canonical_enabled: canonical.map(|i| i.enabled),
            has_enabled_current: enabled_current,
            has_disabled_current: disabled_current,
            open_at_login: settings.open_at_login,
            executable_will_launch_at_login: settings.executable_will_launch_at_login,
            opened_at_login: self.opened_at_login,
            item_count: settings.launch_items.len(),
        };
        if canonical.is_some_and(|i| !i.enabled) {
            return self.needs_repair(VerdictBranch::CanonicalItemDisabled, readings);
        }
        if canonical.is_some_and(|i| i.enabled)
            || enabled_current
            || (settings.open_at_login && settings.executable_will_launch_at_login)
        {
            return self.result(State::Ready, Fix::None, false);
        }
        if disabled_current {
            return self.needs_repair(VerdictBranch::CurrentItemDisabled, readings);
        }
        // Windows invoked this process with our private startup argument: keep
        // that direct runtime receipt when registry metadata is incomplete.
        if self.opened_at_login {
            return self.result(State::Ready, Fix::None, false);
        }
        let any_current = settings
            .launch_items
            .iter()
            .any(|i| is_current_item(i, &exec));
        self.unregistered_verdict(settings.open_at_login || any_current, readings)
    }

    /// The tail of `inspectWindows`: something related is there but not
    /// healthy (repair it), or nothing is (register).
    fn unregistered_verdict(&mut self, related_present: bool, readings: Readings) -> Health {
        if related_present {
            return self.needs_repair(VerdictBranch::RelatedItemPresent, readings);
        }
        self.log_windows_verdict(&LaunchLog::Readings {
            state: State::NeedsRegistration,
            branch: VerdictBranch::NoItemFound,
            readings,
        });
        self.result(State::NeedsRegistration, Fix::Register, true)
    }

    fn needs_repair(&mut self, branch: VerdictBranch, readings: Readings) -> Health {
        self.log_windows_verdict(&LaunchLog::Readings {
            state: State::NeedsRepair,
            branch,
            readings,
        });
        self.result(State::NeedsRepair, Fix::EnableStartup, true)
    }

    /// `logWindowsVerdict`: deduplicated on the reading shape.
    fn log_windows_verdict(&mut self, entry: &LaunchLog) {
        if self.last_windows_verdict.as_ref() == Some(entry) {
            return;
        }
        self.last_windows_verdict = Some(entry.clone());
        self.env.log(entry);
    }

    fn remove_windows_item(
        &mut self,
        name: &str,
        path: &str,
        args: Option<Vec<String>>,
    ) -> Result<(), AppThrew> {
        self.env.set_login_item_settings(&LoginItemSettingsPatch {
            open_at_login: false,
            enabled: Some(false),
            kind: None,
            name: Some(name.to_owned()),
            path: Some(path.to_owned()),
            args,
        })
    }

    /// `cleanupWindowsItems()`.
    pub(super) fn cleanup_windows_items(&mut self) -> Result<(), AppThrew> {
        if !self.env.is_packaged() || self.env.platform() != "win32" {
            return Ok(());
        }
        let exec = self.env.exec_path();
        // A throw in this first block is swallowed (and ends the loop).
        let _swallowed = self.remove_stale_items(&exec);
        let programs_dir = win32::dirname(&win32::dirname(&exec));
        for (name, app_dir, executable) in LEGACY_WINDOWS_ITEMS {
            let legacy_path = win32::join(&[&programs_dir, app_dir, executable]);
            self.remove_windows_item(name, &legacy_path, Some(vec![HIDDEN_ARG.to_owned()]))?;
            self.remove_windows_item(name, &legacy_path, None)?;
        }
        Ok(())
    }

    fn remove_stale_items(&mut self, exec: &str) -> Result<(), AppThrew> {
        let settings = self.env.get_login_item_settings(None)?;
        for item in &settings.launch_items {
            let canonical = is_canonical_item(item, exec);
            if !canonical && is_owned_startup_item(item, exec) {
                self.remove_windows_item(&item.name, &item.path, Some(item.args.clone()))?;
            }
        }
        Ok(())
    }

    /// `hasVerifiedCanonicalWindowsRegistration()`.
    pub(super) fn has_verified_canonical_registration(&mut self) -> bool {
        if self.env.platform() != "win32" {
            return true;
        }
        let query = canonical_query(&self.env);
        let Ok(settings) = self.env.get_login_item_settings(query.as_ref()) else {
            return false;
        };
        let exec = self.env.exec_path();
        settings
            .launch_items
            .iter()
            .any(|i| is_canonical_item(i, &exec) && i.enabled)
            || settings.executable_will_launch_at_login
    }
}
