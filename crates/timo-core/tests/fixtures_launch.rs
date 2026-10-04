//! Golden fixtures for the launch-at-login service, dumped from the real
//! TypeScript by `parity/src/gen/launch.ts`.
#![cfg(test)]

mod common;

use serde::{Deserialize, Serialize};
use timo_core::desktop_types::LaunchOrigin;
use timo_core::js::ser::to_string;
use timo_core::launch_at_login::{
    AppThrew, LaunchAtLoginHealth, LaunchAtLoginService, LaunchEnv, LaunchLog, LoginItemQuery,
    LoginItemSettings, LoginItemSettingsPatch,
};

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

/// A scripted `getLoginItemSettings` answer.
#[derive(Deserialize)]
#[serde(untagged)]
enum Get {
    Throws { throws: String },
    Settings(LoginItemSettings),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Call {
    Named(String),
    Move { options: bool },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    platform: String,
    packaged: bool,
    exec_path: String,
    argv: Vec<String>,
    in_applications: bool,
    now: f64,
    gets: Vec<Get>,
    set_throws: Vec<usize>,
    calls: Vec<Call>,
}

#[derive(Serialize)]
#[serde(tag = "e", rename_all = "camelCase")]
enum Trace {
    Get {
        query: Option<LoginItemQuery>,
        threw: Option<String>,
    },
    Set {
        settings: LoginItemSettingsPatch,
        threw: Option<&'static str>,
    },
    InApplications,
    #[serde(rename_all = "camelCase")]
    Move {
        with_options: bool,
    },
}

struct Env<'a> {
    input: &'a Input,
    get_index: usize,
    set_index: usize,
    trace: Vec<Trace>,
    logs: Vec<LaunchLog>,
}

impl LaunchEnv for Env<'_> {
    fn is_packaged(&self) -> bool {
        self.input.packaged
    }
    fn platform(&self) -> String {
        self.input.platform.clone()
    }
    fn exec_path(&self) -> String {
        self.input.exec_path.clone()
    }
    fn argv(&self) -> Vec<String> {
        self.input.argv.clone()
    }
    fn now(&mut self) -> f64 {
        self.input.now
    }
    fn get_login_item_settings(
        &mut self,
        options: Option<&LoginItemQuery>,
    ) -> Result<LoginItemSettings, AppThrew> {
        let at = self.get_index.min(self.input.gets.len().saturating_sub(1));
        self.get_index += 1;
        let query = options.cloned();
        match self.input.gets.get(at) {
            Some(Get::Settings(s)) => {
                self.trace.push(Trace::Get { query, threw: None });
                Ok(s.clone())
            }
            Some(Get::Throws { throws }) => {
                self.trace.push(Trace::Get {
                    query,
                    threw: Some(throws.clone()),
                });
                Err(AppThrew {
                    message: throws.clone(),
                })
            }
            None => Err(AppThrew {
                message: "no scripted settings".to_owned(),
            }),
        }
    }
    fn set_login_item_settings(
        &mut self,
        settings: &LoginItemSettingsPatch,
    ) -> Result<(), AppThrew> {
        let index = self.set_index;
        self.set_index += 1;
        let throws = self.input.set_throws.contains(&index);
        self.trace.push(Trace::Set {
            settings: settings.clone(),
            threw: throws.then_some("set failed"),
        });
        if throws {
            Err(AppThrew {
                message: "set failed".to_owned(),
            })
        } else {
            Ok(())
        }
    }
    fn is_in_applications_folder(&mut self) -> bool {
        self.trace.push(Trace::InApplications);
        self.input.in_applications
    }
    fn move_to_applications_folder(&mut self, with_options: bool) -> bool {
        self.trace.push(Trace::Move { with_options });
        true
    }
    fn log(&mut self, entry: &LaunchLog) {
        self.logs.push(entry.clone());
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum Ret {
    Nothing(()),
    Flag(bool),
    Origin(LaunchOrigin),
    Health(LaunchAtLoginHealth),
    Error { error: String },
}

#[derive(Serialize)]
struct LogLine {
    level: &'static str,
    message: &'static str,
    meta: LaunchLog,
}

#[derive(Serialize)]
struct Step {
    ret: Ret,
    trace: Vec<Trace>,
    logs: Vec<LogLine>,
}

fn health(result: Result<LaunchAtLoginHealth, timo_core::launch_at_login::LaunchError>) -> Ret {
    match result {
        Ok(h) => Ret::Health(h),
        Err(e) => Ret::Error {
            error: e.to_string(),
        },
    }
}

fn step(service: &mut LaunchAtLoginService<Env<'_>>, ret: Ret) -> Step {
    let env = service.env_mut();
    Step {
        ret,
        trace: std::mem::take(&mut env.trace),
        logs: std::mem::take(&mut env.logs)
            .into_iter()
            .map(|meta| LogLine {
                level: "warn",
                message: "launch at login verdict",
                meta,
            })
            .collect(),
    }
}

fn apply(service: &mut LaunchAtLoginService<Env<'_>>, call: &Call) -> Ret {
    match call {
        Call::Move { options } => Ret::Flag(service.move_to_applications_folder(*options)),
        Call::Named(name) => match name.as_str() {
            "inspect" => health(service.inspect()),
            "reconcileOnBoot" => health(service.reconcile_on_boot()),
            "repair" => health(service.repair()),
            "shouldStartHidden" => Ret::Flag(service.should_start_hidden()),
            "launchOrigin" => Ret::Origin(service.launch_origin()),
            _ => Ret::Nothing(()),
        },
    }
}

#[test]
fn fixture_service() {
    common::run("launch", "service", "service", |input: Input| {
        let env = Env {
            input: &input,
            get_index: 0,
            set_index: 0,
            trace: Vec::new(),
            logs: Vec::new(),
        };
        let mut service = LaunchAtLoginService::new(env);
        let mut steps = vec![step(&mut service, Ret::Nothing(()))];
        for call in &input.calls {
            let ret = apply(&mut service, call);
            steps.push(step(&mut service, ret));
        }
        json(&steps)
    });
}
