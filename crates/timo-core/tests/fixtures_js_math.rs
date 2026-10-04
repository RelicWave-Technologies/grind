//! Golden fixtures for `timo_core::js::{math, iso, string}`, each against the
//! JavaScript engine's own answer (`*`, `/`, `Math.sqrt`, `x ** 2`,
//! `Math.hypot`, `new Date(ms).toISOString()`, `String.prototype.trim`),
//! dumped by `parity/src/gen/jsMath.ts`.
#![cfg(test)]

mod common;

use common::{dec, enc_text, run_value};
use serde::Deserialize;
use timo_core::js::iso::to_iso_string;
use timo_core::js::json::quote;
use timo_core::js::math::{abs, div, hypot, hypot2, mul, sqrt, square};
use timo_core::js::string::trim;

fn unary(name: &str, ts_name: &str, f: fn(f64) -> f64) {
    run_value("js", name, ts_name, |v| enc_text(f(dec(&v["x"]))));
}

fn binary(name: &str, ts_name: &str, f: fn(f64, f64) -> f64) {
    run_value("js", name, ts_name, |v| {
        enc_text(f(dec(&v["a"]), dec(&v["b"])))
    });
}

#[test]
fn fixture_mul() {
    binary("mul", "mul", mul);
}

#[test]
fn fixture_div() {
    binary("div", "div", div);
}

#[test]
fn fixture_hypot() {
    binary("hypot", "hypot", hypot2);
}

#[test]
fn fixture_sqrt() {
    unary("sqrt", "sqrt", sqrt);
}

#[test]
fn fixture_square() {
    unary("square", "square", square);
}

#[test]
fn fixture_abs() {
    unary("abs", "abs", abs);
}

#[test]
fn fixture_hypot_n() {
    run_value("js", "hypot_n", "hypotN", |v| {
        let xs: Vec<f64> = v["xs"]
            .as_array()
            .map(|a| a.iter().map(dec).collect())
            .unwrap_or_default();
        enc_text(hypot(&xs))
    });
}

#[derive(Deserialize)]
struct Ms {
    ms: f64,
}

#[test]
fn fixture_to_iso_string() {
    common::run("js", "to_iso_string", "toIsoString", |i: Ms| {
        to_iso_string(i.ms)
            .map(|s| quote(&s))
            .map_err(|e| e.to_string())
    });
}

#[derive(Deserialize)]
struct Text {
    text: String,
}

#[test]
fn fixture_trim() {
    common::run("js", "trim", "trim", |i: Text| Ok(quote(trim(&i.text))));
}
