//! Shared support for the golden-fixture tests.
//!
//! A fixture is `{fn, seed, cases}` written by `parity/` from the real
//! TypeScript, one case per line: `{"input":<json>,"output":<json>}`. The
//! output is what `JSON.stringify` produced. A Rust result passes only if the
//! text it serializes to is IDENTICAL to that output, byte for byte: whole
//! numbers without `.0`, `0` for `-0`, `null` for NaN, shortest round-trip
//! digits, the same key order. No normalising, so nothing can pass by luck.
#![allow(
    dead_code,
    clippy::string_slice,
    clippy::match_same_arms,
    reason = "each test crate uses a subset of these helpers; the scanner slices text it wrote itself"
)]

use std::fs;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use timo_core::js::json::quote;
use timo_core::js::number::number_to_string;

/// One case, as the raw JSON text of its input and its expected output.
pub struct RawCase {
    pub input: String,
    pub output: String,
}

/// `TIMO_FIXTURE_DIR` points the tests at a differently generated set (a bigger
/// or re-seeded dump from `parity/`); by default the committed one is used.
fn fixture_root() -> PathBuf {
    std::env::var_os("TIMO_FIXTURE_DIR").map_or_else(
        || {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
        },
        PathBuf::from,
    )
}

fn fixture_path(module: &str, name: &str) -> PathBuf {
    fixture_root().join(module).join(format!("{name}.json"))
}

/// End offset of the JSON value starting at `start` (a scanner, not a parser:
/// the text is trusted, it was written by `JSON.stringify`).
fn value_end(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    let mut depth = 0_usize;
    let mut in_string = false;
    let mut i = start;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            match b {
                b'\\' => i += 1,
                b'"' => {
                    in_string = false;
                    if depth == 0 {
                        return i + 1;
                    }
                }
                _ => {}
            }
        } else {
            match b {
                b'"' => in_string = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' if depth == 0 => return i,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return i + 1;
                    }
                }
                b',' if depth == 0 => return i,
                _ => {}
            }
        }
        i += 1;
    }
    bytes.len()
}

fn split_case(line: &str) -> RawCase {
    const INPUT: &str = "{\"input\":";
    const OUTPUT: &str = ",\"output\":";
    assert!(line.starts_with(INPUT), "malformed fixture line: {line}");
    let input_end = value_end(line, INPUT.len());
    assert!(
        line[input_end..].starts_with(OUTPUT),
        "malformed fixture line: {line}"
    );
    let output_start = input_end + OUTPUT.len();
    let output_end = value_end(line, output_start);
    assert_eq!(&line[output_end..], "}", "malformed fixture line: {line}");
    RawCase {
        input: line[INPUT.len()..input_end].to_owned(),
        output: line[output_start..output_end].to_owned(),
    }
}

/// Load `tests/fixtures/<module>/<name>.json`, checking its header.
pub fn load(module: &str, name: &str, ts_name: &str) -> Vec<RawCase> {
    let path = fixture_path(module, name);
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert!(
        text.contains(&format!("\"fn\": \"{ts_name}\"")),
        "{} is not the fixture for {ts_name}",
        path.display()
    );
    assert!(
        text.contains("\"seed\": "),
        "{} records no seed",
        path.display()
    );
    text.lines()
        .filter(|l| l.starts_with("    {\"input\":"))
        .map(|l| split_case(l.trim_start().trim_end_matches(',')))
        .collect()
}

/// What a ported function returned: serialized JSON text, or a thrown message.
pub type Outcome = Result<String, String>;

/// The text `JSON.stringify({error: message})` writes.
pub fn error_text(message: &str) -> String {
    format!("{{\"error\":{}}}", quote(message))
}

/// Run every case of a fixture through `f` (typed input in, outcome out).
/// Panics on the first mismatch with the case index, input, expected, actual.
/// Returns the number of cases checked.
pub fn run<I: DeserializeOwned>(
    module: &str,
    name: &str,
    ts_name: &str,
    f: impl Fn(I) -> Outcome,
) -> usize {
    let cases = load(module, name, ts_name);
    assert!(cases.len() >= 100, "{ts_name}: only {} cases", cases.len());
    for (index, case) in cases.iter().enumerate() {
        let input: I = serde_json::from_str(&case.input).unwrap_or_else(|e| {
            panic!(
                "{ts_name} case {index}: input does not parse: {e}\n{}",
                case.input
            )
        });
        let actual = match f(input) {
            Ok(text) => text,
            Err(message) => error_text(&message),
        };
        assert!(
            actual == case.output,
            "{ts_name} case {index} differs\n  input:    {}\n  expected: {}\n  actual:   {actual}",
            case.input,
            case.output
        );
    }
    cases.len()
}

/// Same, with the input handed over as a parsed `serde_json::Value` (the
/// `js` fixtures encode doubles that JSON cannot carry).
pub fn run_value(
    module: &str,
    name: &str,
    ts_name: &str,
    f: impl Fn(&serde_json::Value) -> String,
) -> usize {
    run::<serde_json::Value>(module, name, ts_name, |v| Ok(f(&v)))
}

/// Decode a double written by `parity/src/gen/jsEncoding.ts`.
pub fn dec(v: &serde_json::Value) -> f64 {
    match v {
        serde_json::Value::Number(n) => n.as_f64().expect("finite number"),
        serde_json::Value::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => panic!("bad encoded double {other}"),
        },
        other => panic!("bad encoded double {other}"),
    }
}

/// Encode a double the same way, as JSON text.
pub fn enc_text(x: f64) -> String {
    if x.is_nan() {
        "\"NaN\"".to_owned()
    } else if x == f64::INFINITY {
        "\"Infinity\"".to_owned()
    } else if x == f64::NEG_INFINITY {
        "\"-Infinity\"".to_owned()
    } else if x == 0.0 && x.is_sign_negative() {
        "\"-0\"".to_owned()
    } else {
        number_to_string(x)
    }
}

/// `-1`, `0` or `1`.
pub fn sign_text(o: core::cmp::Ordering) -> String {
    match o {
        core::cmp::Ordering::Less => "-1",
        core::cmp::Ordering::Equal => "0",
        core::cmp::Ordering::Greater => "1",
    }
    .to_owned()
}
