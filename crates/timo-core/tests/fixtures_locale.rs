//! `localeCompare` and `canonicalTimerEntryPayload` under other ICU default locales: the TypeScript ran
//! in one process per locale (`parity/src/gen/timerLocale.ts`), and each result must be reproduced under
//! `collator_for(locale)`.
#![cfg(test)]

mod common;

use serde::Deserialize;
use timo_core::js::collate::collator_for;
use timo_core::js::ser::to_string;
use timo_core::{CanonicalTimerEntryLike, canonical_timer_entry_payload_with};

#[derive(Deserialize)]
struct Pair {
    locale: String,
    a: String,
    b: String,
}

#[derive(Deserialize)]
struct Canonical {
    locale: String,
    entry: CanonicalTimerEntryLike,
}

#[test]
fn fixture_locale_compare_in() {
    common::run(
        "locale",
        "locale_compare_in",
        "localeCompareIn",
        |i: Pair| {
            let collator = collator_for(&i.locale).map_err(|e| e.to_string())?;
            Ok(match collator.compare(&i.a, &i.b) {
                core::cmp::Ordering::Less => "-1".to_owned(),
                core::cmp::Ordering::Equal => "0".to_owned(),
                core::cmp::Ordering::Greater => "1".to_owned(),
            })
        },
    );
}

#[test]
fn fixture_canonical_payload_in() {
    common::run(
        "locale",
        "canonical_payload_in",
        "canonicalPayloadIn",
        |i: Canonical| {
            let collator = collator_for(&i.locale).map_err(|e| e.to_string())?;
            let payload = canonical_timer_entry_payload_with(&i.entry, &collator)
                .map_err(|e| e.to_string())?;
            to_string(&payload).map_err(|e| e.to_string())
        },
    );
}
