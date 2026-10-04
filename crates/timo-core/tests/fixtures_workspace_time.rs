//! Golden fixtures for `services/workspaceTime.ts` (SC-57): the real service run
//! over a sequence of calls by `parity/` (`src/gen/workspaceTime.ts`), including
//! the `workspace-time.json` it writes. The driver below is what the app crate
//! does around the pure `WorkspaceTime` state: read and parse the cache, check the
//! stored session, write the file.
#![cfg(test)]

mod common;

use common::run;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use timo_core::js::ser::to_string;
use timo_core::workspace_time::{
    PersistedWorkspaceTime, WorkspaceTime, WorkspaceTimeContext, parse_persisted,
};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Op {
    Init,
    #[serde(rename_all = "camelCase")]
    Apply {
        time_zone: String,
        workspace_id: String,
    },
    Clear,
    #[serde(rename_all = "camelCase")]
    Session {
        workspace_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Context {
        now_ms: f64,
    },
    #[serde(rename_all = "camelCase")]
    ContextDefault {
        clock_ms: f64,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioIn {
    cache_file: Option<String>,
    workspace_id: Option<String>,
    ops: Vec<Op>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StepOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<WorkspaceTimeContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    time_zone: Option<String>,
    file: Option<String>,
}

/// The module-level variables of `workspaceTime.ts` plus the world around it.
struct Driver {
    state: WorkspaceTime,
    initialized: bool,
    file: Option<String>,
    session: Option<String>,
}

/// `parsePersisted(JSON.parse(text))`: anything unreadable is "no cache".
fn read_cache(text: &str) -> Option<PersistedWorkspaceTime> {
    let raw: Value = serde_json::from_str(text).ok()?;
    let object = raw.as_object()?;
    parse_persisted(
        object.get("workspaceId").and_then(Value::as_str),
        object.get("timeZone").and_then(Value::as_str),
    )
}

impl Driver {
    /// `initializeWorkspaceTime`.
    fn initialize(&mut self) {
        if self.initialized {
            return;
        }
        if let Some(workspace_id) = self.session.clone() {
            let persisted = self.file.as_deref().and_then(read_cache);
            self.state
                .restore_from_cache(&workspace_id, persisted.as_ref());
        }
        self.initialized = true;
    }

    /// `applyServerWorkspaceTimeZone`; the error is the message the TypeScript throws.
    fn apply(&mut self, value: &str, expected: &str) -> Result<(), String> {
        self.initialize();
        let parsed = timo_core::tz::parse_time_zone(value).ok_or("zod_invalid")?;
        if self.session.as_deref() != Some(expected) {
            return Err("workspace_session_changed".to_owned());
        }
        self.state
            .apply_server(value, expected)
            .map_err(|e| e.to_string())?;
        self.file = Some(
            to_string(&PersistedWorkspaceTime {
                workspace_id: expected.to_owned(),
                time_zone: parsed,
            })
            .map_err(|e| e.to_string())?,
        );
        Ok(())
    }

    fn context(&self, now: f64) -> (Option<WorkspaceTimeContext>, Option<String>) {
        match self.state.context_at(now) {
            Ok(context) => (Some(context), None),
            Err(e) => (None, Some(e.to_string())),
        }
    }
}

fn scenario(i: &ScenarioIn) -> Result<String, String> {
    let mut d = Driver {
        state: WorkspaceTime::new(),
        initialized: false,
        file: i.cache_file.clone(),
        session: i.workspace_id.clone(),
    };
    let mut out = Vec::new();
    for op in &i.ops {
        let (mut context, mut error) = (None, None);
        match op {
            Op::Init => d.initialize(),
            Op::Apply {
                time_zone,
                workspace_id,
            } => error = d.apply(time_zone, workspace_id).err(),
            Op::Clear => {
                d.state.clear();
                d.initialized = true;
            }
            Op::Session { workspace_id } => d.session.clone_from(workspace_id),
            Op::Context { now_ms } => (context, error) = d.context(*now_ms),
            Op::ContextDefault { clock_ms } => (context, error) = d.context(*clock_ms),
        }
        out.push(
            to_string(&StepOut {
                context,
                error,
                time_zone: d.state.time_zone().map(str::to_owned),
                file: d.file.clone(),
            })
            .map_err(|e| e.to_string())?,
        );
    }
    Ok(format!("[{}]", out.join(",")))
}

#[test]
fn fixture_workspace_time_scenario() {
    run(
        "tz",
        "workspace_time_scenario",
        "workspaceTimeScenario",
        |i: ScenarioIn| scenario(&i),
    );
}
