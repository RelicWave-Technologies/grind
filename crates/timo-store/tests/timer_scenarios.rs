//! Replays every scenario the legacy TypeScript recorded (`parity/src/scenarios/timer.ts`)
//! through the Rust runtime and stores, and requires every output member of every
//! step to be byte-identical.

#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::string_slice,
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "an integration test: it asserts by panicking, slices fixture text it measured, and reports its counts"
)]

mod timer_support;

use std::fs;
use std::path::PathBuf;

use timer_support::members::{array_items, object_members, value_end};
use timer_support::replay::{Run, Supplied};
use timer_support::scenario::{Delivery, Scenario, SnapshotIn};

/// Inputs the TypeScript recorded in a step's output; they are not compared.
const SUPPLIED: [&str; 2] = ["deliveries", "snapshot"];

fn fixture() -> String {
    // `TIMO_FIXTURE_DIR` points at a differently generated dump (a bigger or re-seeded
    // soak: `PARITY_FIXTURE_ROOT=/dir PARITY_SALT=7 pnpm --filter @grind/parity fixtures
    // -- --only timer/ --count 5000`, then `TIMO_FIXTURE_DIR=/dir/timo-store`).
    let root = std::env::var_os("TIMO_FIXTURE_DIR").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures"),
        PathBuf::from,
    );
    let path = root.join("timer/scenarios.json");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn supplied(members: &[(String, String)]) -> Supplied {
    let find = |key: &str| {
        members
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };
    Supplied {
        deliveries: find("deliveries")
            .map(|t| serde_json::from_str::<Vec<Delivery>>(t).unwrap())
            .unwrap_or_default(),
        snapshot: find("snapshot").map(|t| serde_json::from_str::<SnapshotIn>(t).unwrap()),
    }
}

fn shorten(text: &str) -> String {
    if text.len() > 1500 {
        format!("{}…", &text[..1500])
    } else {
        text.to_owned()
    }
}

/// Compare one step; the error names the first member that differs.
fn compare(actual: &[(&'static str, String)], expected: &[(String, String)]) -> Result<(), String> {
    let expected: Vec<&(String, String)> = expected
        .iter()
        .filter(|(k, _)| !SUPPLIED.contains(&k.as_str()))
        .collect();
    let keys: Vec<&str> = actual.iter().map(|(k, _)| *k).collect();
    let want: Vec<&str> = expected.iter().map(|(k, _)| k.as_str()).collect();
    if keys != want {
        return Err(format!(
            "members differ: expected {want:?}, actual {keys:?}"
        ));
    }
    for ((key, got), (_, exp)) in actual.iter().zip(&expected) {
        if got != exp {
            return Err(format!(
                "member `{key}` differs\n  expected: {}\n  actual:   {}",
                shorten(exp),
                shorten(got)
            ));
        }
    }
    Ok(())
}

fn run_case(index: usize, input: &str, output: &str) -> Result<usize, String> {
    let scenario: Scenario = serde_json::from_str(input).map_err(|e| format!("input: {e}"))?;
    let steps = array_items(output);
    if steps.len() != scenario.ops.len() {
        return Err(format!(
            "{} steps recorded for {} ops",
            steps.len(),
            scenario.ops.len()
        ));
    }
    let mut run = Run::new(&scenario)?;
    for (i, (op, step)) in scenario.ops.iter().zip(&steps).enumerate() {
        let members = object_members(step);
        let actual = run.step(i, op, &supplied(&members));
        compare(&actual, &members).map_err(|e| {
            if std::env::var_os("TIMER_DEBUG").is_some() {
                eprintln!("EXPECTED {members:#?}\nACTUAL {actual:#?}");
            }
            format!(
                "scenario #{index} `{}` step {i} ({op:?}): {e}",
                scenario.name
            )
        })?;
    }
    Ok(steps.len())
}

#[test]
fn every_recorded_scenario_replays_byte_for_byte() {
    let text = fixture();
    let mut scenarios = 0;
    let mut steps = 0;
    for line in text.lines().filter(|l| l.starts_with("    {\"input\":")) {
        let line = line.trim_start().trim_end_matches(',');
        let input_end = value_end(line, "{\"input\":".len());
        let input = &line["{\"input\":".len()..input_end];
        let output_start = input_end + ",\"output\":".len();
        let output = &line[output_start..value_end(line, output_start)];
        match run_case(scenarios, input, output) {
            Ok(n) => steps += n,
            Err(e) => panic!("{e}"),
        }
        scenarios += 1;
    }
    assert!(scenarios >= 500, "only {scenarios} scenarios");
    println!("{scenarios} scenarios, {steps} steps replayed byte for byte");
}
