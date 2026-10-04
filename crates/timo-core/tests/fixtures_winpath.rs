//! Golden fixtures for the `path.win32` port (`js::path_win32`) and
//! `String.prototype.toLowerCase`, dumped from Node by `parity/src/gen/winPath.ts`.
#![cfg(test)]

mod common;

use serde::Deserialize;
use timo_core::js::path_win32::{basename, dirname, join, normalize};
use timo_core::js::ser::to_string;

#[derive(Deserialize)]
struct One {
    path: String,
}

fn text(s: &str) -> Result<String, String> {
    to_string(s).map_err(|e| e.to_string())
}

#[test]
fn fixture_normalize() {
    common::run("winpath", "normalize", "normalize", |i: One| {
        text(&normalize(&i.path))
    });
}

#[test]
fn fixture_basename() {
    common::run("winpath", "basename", "basename", |i: One| {
        text(&basename(&i.path))
    });
}

#[test]
fn fixture_dirname() {
    common::run("winpath", "dirname", "dirname", |i: One| {
        text(&dirname(&i.path))
    });
}

#[derive(Deserialize)]
struct Many {
    paths: Vec<String>,
}

#[test]
fn fixture_join() {
    common::run("winpath", "join", "join", |i: Many| {
        let parts: Vec<&str> = i.paths.iter().map(String::as_str).collect();
        text(&join(&parts))
    });
}

#[derive(Deserialize)]
struct Lower {
    text: String,
}

#[test]
fn fixture_to_lower_case() {
    common::run("winpath", "to_lower_case", "toLowerCase", |i: Lower| {
        text(&i.text.to_lowercase())
    });
}
