//! `String.prototype.localeCompare` with the root collation.

use core::cmp::Ordering;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use thiserror::Error;

/// The collation data could not be loaded (cannot happen with the compiled
/// data this crate links; kept as an error so no comparator has to panic).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("root collator unavailable: {0}")]
pub struct CollatorError(String);

/// A ready collator. Build one with [`collator`] before a sort, then compare
/// inside the comparator, which cannot fail.
pub struct LocaleCollator(CollatorBorrowed<'static>);

impl core::fmt::Debug for LocaleCollator {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("LocaleCollator(root)")
    }
}

/// The root-locale collator at default strength: what `a.localeCompare(b)`
/// gives under `en-US`, with no locale-specific tailoring.
pub fn collator() -> Result<LocaleCollator, CollatorError> {
    Collator::try_new(CollatorPreferences::default(), CollatorOptions::default())
        .map(LocaleCollator)
        .map_err(|e| CollatorError(e.to_string()))
}

impl LocaleCollator {
    /// `a.localeCompare(b)` as an ordering.
    #[must_use]
    pub fn compare(&self, a: &str, b: &str) -> Ordering {
        self.0.compare(a, b)
    }
}
