//! `localeCompare` under every default locale of `tests/data/locale_electron.json`, which
//! `parity/src/electronLocale.mjs` recorded on the real Electron 33.2.0 (ICU 74.2, CLDR 44.1): for each
//! locale, the result of every pair of the probe strings. `collator_for` must reproduce all of them,
//! including the languages Chromium's trimmed ICU data has no collation tailoring for.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::print_stdout,
    reason = "a test: it reads the snapshot it was given and reports the locales that differ"
)]

use core::cmp::Ordering;
use std::collections::BTreeMap;

use serde::Deserialize;
use timo_core::js::collate::collator_for;

#[derive(Deserialize)]
struct Snapshot {
    probe: Vec<String>,
    locales: BTreeMap<String, Recorded>,
}

#[derive(Deserialize)]
struct Recorded {
    results: String,
}

fn mark(ordering: Ordering) -> char {
    match ordering {
        Ordering::Less => '<',
        Ordering::Equal => '=',
        Ordering::Greater => '>',
    }
}

/// What is known not to match, exactly: one pair of one locale, where Electron's ICU 74.2 orders the
/// Latvian `y` before the `ĳ` ligature and the collation data here (CLDR 44 as ICU4X 1.5 carries it)
/// after it. The ligature is not an id character; the entry is here so the set cannot grow unnoticed.
const KNOWN_RESIDUAL: [(&str, &str); 1] = [("lv-LV", "\"y\" vs \"ĳ\": Electron <, here >")];

/// The pairs of the probe, in the order the snapshot records them.
fn pairs(probe: &[String]) -> Vec<(&String, &String)> {
    probe
        .iter()
        .enumerate()
        .flat_map(|(i, a)| probe.iter().skip(i + 1).map(move |b| (a, b)))
        .collect()
}

/// Every pair of `tag` that collates differently here than Electron recorded.
fn differing(snapshot: &Snapshot, tag: &str, recorded: &Recorded) -> Vec<String> {
    let collator = collator_for(tag).unwrap();
    pairs(&snapshot.probe)
        .into_iter()
        .zip(recorded.results.chars())
        .filter_map(|((a, b), want)| {
            let got = mark(collator.compare(a, b));
            (got != want).then(|| format!("{a:?} vs {b:?}: Electron {want}, here {got}"))
        })
        .collect()
}

#[test]
fn every_recorded_locale_collates_as_electron_does() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/data/locale_electron.json"
    );
    let snapshot: Snapshot = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let total = pairs(&snapshot.probe).len();
    let mut wrong = Vec::new();
    for (tag, recorded) in &snapshot.locales {
        let found = differing(&snapshot, tag, recorded);
        let known: Vec<&str> = KNOWN_RESIDUAL
            .iter()
            .filter(|(known_tag, _)| known_tag == tag)
            .map(|(_, pair)| *pair)
            .collect();
        if found != known || recorded.results.chars().count() != total {
            wrong.push(format!(
                "{tag}: {} of {total} pairs, first {:?}",
                found.len(),
                found.first()
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "locales that differ from Electron 33.2.0:\n{}",
        wrong.join("\n")
    );
    println!(
        "{} locales, {} probe strings",
        snapshot.locales.len(),
        snapshot.probe.len()
    );
}
