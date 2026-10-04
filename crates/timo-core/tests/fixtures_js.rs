//! Golden fixtures for `timo_core::js`: each helper against the JavaScript
//! engine's own answer (`Math.*`, `%`, `String(n)`, `JSON.stringify`,
//! `localeCompare`, `new Date(s).getTime()`).
#![cfg(test)]

mod common;

use common::{dec, enc_text, run_value, sign_text};
use serde_json::Value;
use timo_core::js::collate::collator;
use timo_core::js::date::{DateParse, parse};
use timo_core::js::json::quote;
use timo_core::js::number::{
    add, ceil, floor, max, min, number_to_string, rem, round, sort_cmp, strict_eq, sub, trunc,
};
use timo_core::js::ser::to_string;

fn unary(name: &str, ts_name: &str, f: fn(f64) -> f64) {
    run_value("js", name, ts_name, |v| enc_text(f(dec(&v["x"]))));
}

fn binary(name: &str, ts_name: &str, f: fn(f64, f64) -> f64) {
    run_value("js", name, ts_name, |v| {
        enc_text(f(dec(&v["a"]), dec(&v["b"])))
    });
}

#[test]
fn fixture_round() {
    unary("round", "round", round);
}

#[test]
fn fixture_floor() {
    unary("floor", "floor", floor);
}

#[test]
fn fixture_ceil() {
    unary("ceil", "ceil", ceil);
}

#[test]
fn fixture_trunc() {
    unary("trunc", "trunc", trunc);
}

#[test]
fn fixture_max() {
    binary("max", "max", max);
}

#[test]
fn fixture_min() {
    binary("min", "min", min);
}

#[test]
fn fixture_rem() {
    binary("rem", "rem", rem);
}

#[test]
fn fixture_add() {
    binary("add", "add", add);
}

#[test]
fn fixture_sub() {
    binary("sub", "sub", sub);
}

#[test]
fn fixture_strict_eq() {
    run_value("js", "strict_eq", "strictEq", |v| {
        u8::from(strict_eq(dec(&v["a"]), dec(&v["b"]))).to_string()
    });
}

#[test]
fn fixture_sort_cmp() {
    run_value("js", "sort_cmp", "sortCmp", |v| {
        sign_text(sort_cmp(dec(&v["a"]), dec(&v["b"])))
    });
}

#[test]
fn fixture_number_to_string() {
    run_value("js", "number_to_string", "numberToString", |v| {
        quote(&number_to_string(dec(&v["x"])))
    });
}

#[test]
fn fixture_json_stringify_numbers() {
    run_value(
        "js",
        "json_stringify_numbers",
        "jsonStringifyNumbers",
        |v| {
            let xs: Vec<f64> = v["xs"].as_array().expect("array").iter().map(dec).collect();
            quote(&to_string(&xs).expect("serializes"))
        },
    );
}

#[test]
fn fixture_json_quote() {
    run_value("js", "json_quote", "jsonQuote", |v| {
        quote(&quote(v["s"].as_str().expect("string")))
    });
}

#[test]
fn fixture_locale_compare() {
    let collator = collator().expect("collator");
    run_value("js", "locale_compare", "localeCompare", |v: &Value| {
        let a = v["a"].as_str().expect("string");
        let b = v["b"].as_str().expect("string");
        sign_text(collator.compare(a, b))
    });
}

#[test]
fn fixture_date_parse() {
    run_value("js", "date_parse", "dateParse", |v| {
        match parse(v["s"].as_str().expect("string")) {
            DateParse::Time(t) => enc_text(t),
            DateParse::Invalid => enc_text(f64::NAN),
            DateParse::Unsupported => "\"unsupported\"".to_owned(),
        }
    });
}
