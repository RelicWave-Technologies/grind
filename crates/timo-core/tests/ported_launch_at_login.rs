//! 1:1 port of `launchAtLogin.test.ts`
//! (legacy/agent/src/main/services/launchAtLogin.test.ts).
#![cfg(test)]
#![allow(
    clippy::too_many_lines,
    reason = "the ported tests are as long as the TypeScript tests they mirror"
)]

use std::collections::VecDeque;

use timo_core::desktop_types::{LaunchAtLoginState as State, LaunchOrigin};
use timo_core::launch_at_login::{
    AppThrew, LaunchAtLoginHealth, LaunchAtLoginRemediation as Fix, LaunchAtLoginService,
    LaunchEnv, LaunchItem, LaunchLog, LoginItemQuery, LoginItemSettings, LoginItemSettingsPatch,
    is_hidden_launch,
};

const EXE: &str = "C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe";
/// `Date.parse('2026-07-12T00:00:00.000Z')`.
const NOW: f64 = 1_783_814_400_000.0;

/// `settings(patch)`.
fn settings(patch: impl FnOnce(&mut LoginItemSettings)) -> LoginItemSettings {
    let mut s = LoginItemSettings {
        open_at_login: false,
        was_opened_at_login: false,
        status: "not-registered".to_owned(),
        executable_will_launch_at_login: false,
        launch_items: Vec::new(),
    };
    patch(&mut s);
    s
}

/// `item(patch)`: a launch item exactly as Electron reports it on Windows
/// (`args` empty on purpose: electron#31960).
fn item(patch: impl FnOnce(&mut LaunchItem)) -> LaunchItem {
    let mut i = LaunchItem {
        name: "Timo".to_owned(),
        path: EXE.to_owned(),
        args: Vec::new(),
        scope: "user".to_owned(),
        enabled: true,
    };
    patch(&mut i);
    i
}

/// The test's `mocks.app` plus `deps`.
struct FakeEnv {
    packaged: bool,
    platform: &'static str,
    exec_path: String,
    argv: Vec<String>,
    in_applications: bool,
    /// `mockReturnValueOnce` chain, then `mockReturnValue`.
    once: VecDeque<LoginItemSettings>,
    always: Option<LoginItemSettings>,
    sets: Vec<LoginItemSettingsPatch>,
    moves: Vec<bool>,
}

impl FakeEnv {
    fn new(platform: &'static str, exec_path: &str, argv: &[&str]) -> Self {
        Self {
            packaged: true,
            platform,
            exec_path: exec_path.to_owned(),
            argv: argv.iter().map(|a| (*a).to_owned()).collect(),
            in_applications: true,
            once: VecDeque::new(),
            always: None,
            sets: Vec::new(),
            moves: Vec::new(),
        }
    }

    fn returns(mut self, s: LoginItemSettings) -> Self {
        self.always = Some(s);
        self
    }

    fn returns_once(mut self, chain: Vec<LoginItemSettings>) -> Self {
        self.once = chain.into();
        self
    }
}

impl LaunchEnv for FakeEnv {
    fn is_packaged(&self) -> bool {
        self.packaged
    }
    fn platform(&self) -> String {
        self.platform.to_owned()
    }
    fn exec_path(&self) -> String {
        self.exec_path.clone()
    }
    fn argv(&self) -> Vec<String> {
        self.argv.clone()
    }
    fn now(&mut self) -> f64 {
        NOW
    }
    fn get_login_item_settings(
        &mut self,
        _options: Option<&LoginItemQuery>,
    ) -> Result<LoginItemSettings, AppThrew> {
        self.once
            .pop_front()
            .or_else(|| self.always.clone())
            .ok_or_else(|| AppThrew {
                message: "no scripted settings left".to_owned(),
            })
    }
    fn set_login_item_settings(&mut self, s: &LoginItemSettingsPatch) -> Result<(), AppThrew> {
        self.sets.push(s.clone());
        Ok(())
    }
    fn is_in_applications_folder(&mut self) -> bool {
        self.in_applications
    }
    fn move_to_applications_folder(&mut self, with_options: bool) -> bool {
        self.moves.push(with_options);
        true
    }
    fn log(&mut self, _entry: &LaunchLog) {}
}

fn service(env: FakeEnv) -> LaunchAtLoginService<FakeEnv> {
    LaunchAtLoginService::new(env)
}

const MAC_EXE: &str = "/Applications/Timo.app/Contents/MacOS/Timo";

fn canonical_patch() -> LoginItemSettingsPatch {
    LoginItemSettingsPatch {
        open_at_login: true,
        enabled: Some(true),
        kind: None,
        name: Some("Timo".to_owned()),
        path: Some(EXE.to_owned()),
        args: Some(vec!["--hidden".to_owned()]),
    }
}

fn removal_of(name: &str, path: &str) -> impl Fn(&LoginItemSettingsPatch) -> bool {
    let (name, path) = (name.to_owned(), path.to_owned());
    move |s| {
        !s.open_at_login
            && s.name.as_deref() == Some(name.as_str())
            && s.path.as_deref() == Some(path.as_str())
    }
}

fn expect_health(h: &LaunchAtLoginHealth, state: State, ready: bool) {
    assert_eq!((h.state, h.ready), (state, ready));
}

mod launch_at_login_service {
    use super::*;

    #[test]
    fn recognizes_only_the_explicit_hidden_startup_argument() {
        assert!(is_hidden_launch(&[
            "Timo.exe".to_owned(),
            "--hidden".to_owned()
        ]));
        assert!(!is_hidden_launch(&[
            "Timo.exe".to_owned(),
            "timo://callback".to_owned()
        ]));
    }

    #[test]
    fn is_unavailable_without_mutating_login_items_in_dev_mode() {
        let mut env = FakeEnv::new("darwin", MAC_EXE, &[]);
        env.packaged = false;
        let mut s = service(env);

        let health = s.reconcile_on_boot().unwrap();
        assert!(!health.required);
        assert!(!health.ready);
        assert_eq!(health.state, State::Unavailable);
        assert!(s.env().sets.is_empty());
    }

    #[test]
    fn requires_installation_when_a_packaged_mac_app_is_outside_applications() {
        let mut env = FakeEnv::new("darwin", "/Volumes/Timo/Timo.app/Contents/MacOS/Timo", &[])
            .returns(settings(|_| {}));
        env.in_applications = false;

        let health = service(env).inspect().unwrap();
        assert_eq!(health.state, State::NeedsInstall);
        assert_eq!(health.remediation, Fix::MoveToApplications);
        assert!(!health.can_repair);
    }

    #[test]
    fn registers_a_missing_macos_main_app_service_on_boot_and_verifies_it() {
        let enabled = || {
            settings(|s| {
                s.open_at_login = true;
                s.status = "enabled".to_owned();
            })
        };
        let env = FakeEnv::new("darwin", MAC_EXE, &[]).returns_once(vec![
            settings(|_| {}),
            settings(|_| {}),
            enabled(),
            enabled(),
        ]);
        let mut s = service(env);

        let health = s.reconcile_on_boot().unwrap();

        assert!(s.env().sets.contains(&LoginItemSettingsPatch {
            open_at_login: true,
            enabled: None,
            kind: Some("mainAppService"),
            name: None,
            path: None,
            args: None,
        }));
        expect_health(&health, State::Ready, true);
    }

    #[test]
    fn surfaces_macos_approval_without_silently_overriding_it() {
        let env = FakeEnv::new("darwin", MAC_EXE, &[]).returns(settings(|s| {
            s.open_at_login = true;
            s.status = "requires-approval".to_owned();
        }));
        let mut s = service(env);

        let health = s.reconcile_on_boot().unwrap();

        assert_eq!(health.state, State::NeedsApproval);
        assert_eq!(health.remediation, Fix::OpenLoginItems);
        assert!(s.env().sets.is_empty());
    }

    #[test]
    fn captures_macos_login_origin_before_registration_changes() {
        let env = FakeEnv::new("darwin", MAC_EXE, &[]).returns(settings(|s| {
            s.open_at_login = true;
            s.status = "enabled".to_owned();
            s.was_opened_at_login = true;
        }));
        let mut launch = service(env);

        assert!(launch.should_start_hidden());
        assert_eq!(launch.launch_origin(), LaunchOrigin::LoginItem);
        assert!(launch.inspect().unwrap().opened_at_login);
    }

    #[test]
    fn requires_the_canonical_approved_windows_item_not_only_open_at_login() {
        let env = FakeEnv::new("win32", EXE, &[]).returns(settings(|s| {
            s.open_at_login = true;
            s.executable_will_launch_at_login = false;
            s.launch_items = vec![item(|i| i.enabled = false)];
        }));

        let health = service(env).inspect().unwrap();
        assert!(!health.ready);
        assert_eq!(health.state, State::NeedsRepair);
        assert_eq!(health.remediation, Fix::EnableStartup);
    }

    #[test]
    fn accepts_the_current_windows_path_when_windows_reports_startup_approval() {
        let env = FakeEnv::new("win32", EXE, &["Timo.exe", "--hidden"]).returns(settings(|s| {
            s.open_at_login = true;
            s.executable_will_launch_at_login = true;
            s.launch_items = vec![item(|_| {})];
        }));

        let health = service(env).inspect().unwrap();
        expect_health(&health, State::Ready, true);
        assert!(health.opened_at_login);
    }

    #[test]
    fn trusts_the_exact_electron_windows_receipt_when_launch_item_metadata_is_absent() {
        let env = FakeEnv::new("win32", EXE, &[]).returns(settings(|s| {
            s.open_at_login = true;
            s.executable_will_launch_at_login = true;
        }));

        let health = service(env).inspect().unwrap();
        expect_health(&health, State::Ready, true);
        assert_eq!(health.remediation, Fix::None);
    }

    #[test]
    fn uses_a_real_hidden_windows_boot_as_readiness_proof_when_registry_metadata_is_incomplete() {
        let env = FakeEnv::new("win32", EXE, &["Timo.exe", "--hidden"]).returns(settings(|_| {}));

        let health = service(env).inspect().unwrap();
        expect_health(&health, State::Ready, true);
        assert!(health.opened_at_login);
    }

    #[test]
    fn honors_an_explicitly_disabled_current_windows_item_after_a_hidden_boot() {
        let env = FakeEnv::new("win32", EXE, &["Timo.exe", "--hidden"]).returns(settings(|s| {
            s.launch_items = vec![item(|i| i.enabled = false)];
        }));

        let health = service(env).inspect().unwrap();
        expect_health(&health, State::NeedsRepair, false);
    }

    #[test]
    fn does_not_let_an_enabled_duplicate_override_an_explicitly_disabled_canonical_item() {
        let env = FakeEnv::new("win32", EXE, &[]).returns(settings(|s| {
            s.launch_items = vec![
                item(|i| i.enabled = false),
                item(|i| {
                    i.name = "Timo time tracker desktop agent".to_owned();
                    i.enabled = true;
                }),
            ];
        }));

        expect_health(&service(env).inspect().unwrap(), State::NeedsRepair, false);
    }

    #[test]
    fn trusts_an_enabled_current_windows_startup_item_even_when_windows_reports_the_display_description_name()
     {
        let env = FakeEnv::new("win32", EXE, &[]).returns(settings(|s| {
            s.open_at_login = false;
            s.executable_will_launch_at_login = false;
            s.launch_items = vec![item(|i| {
                i.name = "Timo time tracker desktop agent".to_owned();
            })];
        }));

        let health = service(env).inspect().unwrap();
        expect_health(&health, State::Ready, true);
        assert_eq!(health.remediation, Fix::None);
    }

    fn disabled_then_ready() -> Vec<LoginItemSettings> {
        let disabled = settings(|s| {
            s.open_at_login = true;
            s.executable_will_launch_at_login = false;
            s.launch_items = vec![item(|i| i.enabled = false)];
        });
        let ready = || {
            settings(|s| {
                s.open_at_login = true;
                s.executable_will_launch_at_login = true;
                s.launch_items = vec![item(|_| {})];
            })
        };
        vec![disabled, ready(), ready(), ready(), ready()]
    }

    #[test]
    fn self_heals_a_disabled_windows_item_on_boot() {
        let env = FakeEnv::new("win32", EXE, &[]).returns_once(disabled_then_ready());
        let mut s = service(env);

        let health = s.reconcile_on_boot().unwrap();

        assert!(s.env().sets.contains(&canonical_patch()));
        expect_health(&health, State::Ready, true);
    }

    #[test]
    fn repairs_a_disabled_windows_item_from_the_explicit_repair_action() {
        let env = FakeEnv::new("win32", EXE, &[]).returns_once(disabled_then_ready());
        let mut s = service(env);

        let health = s.repair().unwrap();

        assert!(s.env().sets.contains(&canonical_patch()));
        expect_health(&health, State::Ready, true);
    }

    #[test]
    fn reports_blocked_when_a_windows_repair_does_not_become_effective() {
        let disabled = settings(|s| {
            s.open_at_login = true;
            s.launch_items = vec![item(|i| i.enabled = false)];
        });
        let env = FakeEnv::new("win32", EXE, &[]).returns(disabled);

        let health = service(env).repair().unwrap();
        assert_eq!(health.state, State::Blocked);
        assert_eq!(health.remediation, Fix::OpenStartupApps);
        assert!(!health.can_repair);
    }

    #[test]
    fn does_not_remove_a_working_windows_item_before_a_replacement_is_verified() {
        let stale_item = item(|i| {
            i.name = "Timo time tracker desktop agent".to_owned();
            i.path = "C:\\Old\\Timo\\Timo.exe".to_owned();
        });
        let repairable = settings(|s| s.launch_items = vec![stale_item.clone()]);
        let env = FakeEnv::new("win32", EXE, &[]).returns(repairable);
        let mut s = service(env);

        s.repair().unwrap();

        assert_eq!(s.env().sets.first(), Some(&canonical_patch()));
        assert!(
            !s.env()
                .sets
                .iter()
                .any(removal_of(&stale_item.name, &stale_item.path))
        );
    }

    #[test]
    fn removes_legacy_and_wrong_path_windows_entries_during_reconciliation() {
        let stale_items = vec![
            item(|i| {
                i.name = "Grind".to_owned();
                i.path = "C:\\Old\\Grind.exe".to_owned();
            }),
            item(|i| {
                i.name = "Timo time tracker desktop agent".to_owned();
                i.path = "C:\\Old\\Timo\\Timo.exe".to_owned();
            }),
            item(|i| i.path = "C:\\Old\\Timo.exe".to_owned()),
            item(|i| {
                i.name = "Timo Legacy".to_owned();
                i.path = "C:\\Old\\Timo\\Timo.exe".to_owned();
            }),
        ];
        let stale = settings(|s| s.launch_items = stale_items.clone());
        let ready = || {
            settings(|s| {
                s.open_at_login = true;
                s.executable_will_launch_at_login = true;
                s.launch_items = vec![item(|_| {})];
            })
        };
        let ready_with_stale = || {
            settings(|s| {
                s.open_at_login = true;
                s.executable_will_launch_at_login = true;
                s.launch_items = [vec![item(|_| {})], stale_items.clone()].concat();
            })
        };
        let env = FakeEnv::new("win32", EXE, &[]).returns_once(vec![
            stale,
            ready_with_stale(),
            ready_with_stale(),
            ready_with_stale(),
            ready(),
        ]);
        let mut s = service(env);

        s.reconcile_on_boot().unwrap();

        let sets = &s.env().sets;
        assert!(
            sets.iter()
                .any(|x| !x.open_at_login && x.name.as_deref() == Some("Grind"))
        );
        assert!(sets.iter().any(removal_of(
            "Timo time tracker desktop agent",
            "C:\\Old\\Timo\\Timo.exe"
        )));
        assert!(sets.iter().any(removal_of("Timo", "C:\\Old\\Timo.exe")));
        assert!(
            sets.iter()
                .any(removal_of("Timo Legacy", "C:\\Old\\Timo\\Timo.exe"))
        );
    }

    #[test]
    fn keeps_the_canonical_windows_startup_item_while_removing_duplicate_timo_rows() {
        let duplicate = item(|i| {
            i.name = "Timo time tracker desktop agent".to_owned();
            i.path = "C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo-old\\Timo.exe".to_owned();
        });
        let ready = settings(|s| {
            s.open_at_login = true;
            s.executable_will_launch_at_login = true;
            s.launch_items = vec![item(|_| {}), duplicate.clone()];
        });
        let env = FakeEnv::new("win32", EXE, &[]).returns_once(vec![
            ready.clone(),
            ready.clone(),
            ready.clone(),
            ready,
        ]);
        let mut s = service(env);

        s.repair().unwrap();

        let sets = &s.env().sets;
        assert!(
            sets.iter()
                .any(removal_of(&duplicate.name, &duplicate.path))
        );
        assert!(!sets.iter().any(|x| {
            !x.open_at_login
                && x.name.as_deref() == Some("Timo")
                && x.path.as_deref() == Some(EXE)
                && x.args.as_deref() == Some(&["--hidden".to_owned()][..])
        }));
    }

    #[test]
    fn keeps_a_working_noncanonical_windows_item_when_canonical_verification_fails() {
        let display_item = item(|i| i.name = "Timo time tracker desktop agent".to_owned());
        let state = settings(|s| {
            s.open_at_login = false;
            s.executable_will_launch_at_login = false;
            s.launch_items = vec![display_item];
        });
        let env = FakeEnv::new("win32", EXE, &[]).returns_once(vec![
            state.clone(),
            state.clone(),
            state.clone(),
            state,
        ]);
        let mut s = service(env);

        expect_health(&s.repair().unwrap(), State::Ready, true);
        assert!(
            !s.env()
                .sets
                .iter()
                .any(removal_of("Timo time tracker desktop agent", EXE))
        );
    }

    #[test]
    fn removes_the_duplicate_windows_identity_only_after_canonical_verification_succeeds() {
        let duplicate = item(|i| i.name = "Timo time tracker desktop agent".to_owned());
        let mixed = settings(|s| {
            s.open_at_login = true;
            s.executable_will_launch_at_login = true;
            s.launch_items = vec![item(|_| {}), duplicate.clone()];
        });
        let env = FakeEnv::new("win32", EXE, &[]).returns(mixed);
        let mut s = service(env);

        expect_health(&s.reconcile_on_boot().unwrap(), State::Ready, true);
        assert!(s.env().sets.contains(&LoginItemSettingsPatch {
            open_at_login: false,
            enabled: Some(false),
            kind: None,
            name: Some(duplicate.name),
            path: Some(duplicate.path),
            args: Some(duplicate.args),
        }));
    }

    #[test]
    fn delegates_a_user_confirmed_macos_move_to_electron() {
        let mut env = FakeEnv::new("darwin", "/Volumes/Timo/Timo.app/Contents/MacOS/Timo", &[])
            .returns(settings(|_| {}));
        env.in_applications = false;
        let mut s = service(env);

        assert!(s.move_to_applications_folder(true));
        assert_eq!(s.env().moves, vec![true]);
    }
}
