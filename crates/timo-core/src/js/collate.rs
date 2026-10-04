//! `String.prototype.localeCompare` under the process's ICU default locale.
//!
//! `a.localeCompare(b)` takes no locale, so V8 uses the ICU default locale of the process. On
//! Electron 33.2.0 (measured on the real binary, see `PARITY.md`, "Locale") that is derived from the
//! environment exactly as ICU's `uprv_getDefaultLocaleID` does it on macOS and Linux:
//! `LC_ALL`, else `LC_MESSAGES`, else `LANG`, with `C`/`POSIX`/nothing meaning `en-US`. It is NOT
//! `app.getLocale()` and NOT the macOS preferred languages. On Windows ICU reads the user's regional
//! format (`GetUserDefaultLocaleName`); that is not reproduced here, the shell passes it as a tag.
//!
//! The same two ULIDs compare `-1` under `en-US` and `+1` under `cs-CZ` (the Czech "ch" is one
//! letter, sorted after "h"), so the comparator is built for a locale. The shell sets the process
//! locale once at start-up ([`set_default_locale`]); until it does, the root collation
//! (`en-US`) is used, which is what an environment with no locale gives.

use core::cmp::Ordering;
use std::sync::OnceLock;

use icu_collator::{Collator, CollatorOptions};
use icu_locid::Locale;
use thiserror::Error;

/// The collation data could not be loaded (cannot happen with the compiled
/// data this crate links; kept as an error so no comparator has to panic).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("root collator unavailable: {0}")]
pub struct CollatorError(String);

/// A ready collator. Build one with [`collator`] before a sort, then compare
/// inside the comparator, which cannot fail.
pub struct LocaleCollator(Collator);

impl core::fmt::Debug for LocaleCollator {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("LocaleCollator")
    }
}

static DEFAULT_LOCALE: OnceLock<String> = OnceLock::new();

/// Set the process's ICU default locale (a BCP 47 tag such as `cs-CZ`), once. `false` when a
/// locale was already set; the first one stays, like ICU's default after start-up.
pub fn set_default_locale(tag: &str) -> bool {
    DEFAULT_LOCALE.set(tag.to_owned()).is_ok()
}

/// The collator for the process's default locale.
pub fn collator() -> Result<LocaleCollator, CollatorError> {
    collator_for(DEFAULT_LOCALE.get().map_or("en-US", String::as_str))
}

/// Languages CLDR tailors but whose tailoring Electron 33.2.0 does not have: Chromium ships a trimmed
/// ICU data file (74.2, CLDR 44.1), and under these languages `localeCompare` collates as the root does.
/// Every language here was measured on the real binary: all 9,316 pairs of 137 probe strings come out
/// exactly as `en-US`'s (`tests/data/locale_electron.json`), where the complete CLDR data differs.
const ELECTRON_UNTAILORED: [&str; 35] = [
    "as", "az", "be", "bs", "chr", "cy", "dsb", "ee", "fo", "gl", "hsb", "hy", "ig", "is", "ka",
    "kk", "kok", "ku", "ky", "mk", "mn", "mt", "ne", "nn", "om", "or", "pa", "ps", "si", "sq",
    "tk", "to", "ug", "uz", "wo",
];

/// `a.localeCompare(b)` under the ICU default locale `tag` (BCP 47, `cs-CZ`). A tag that does not
/// parse, or a locale with no tailoring, collates as the root does, as ICU's fallback does.
pub fn collator_for(tag: &str) -> Result<LocaleCollator, CollatorError> {
    let parsed = tag.parse::<Locale>().unwrap_or_default();
    // ICU resolves the script of `zh-TW` / `zh-HK` / `zh-MO` through its likely-subtags data, and
    // Traditional Chinese collates by stroke count by default; the collator's data is keyed by the
    // `co` keyword instead, so that is spelled out.
    let traditional = parsed.id.language.as_str() == "zh"
        && (parsed
            .id
            .script
            .is_some_and(|script| script.as_str() == "Hant")
            || (parsed.id.script.is_none()
                && parsed
                    .id
                    .region
                    .is_some_and(|region| ["TW", "HK", "MO"].contains(&region.as_str()))));
    let locale = if traditional {
        "zh-u-co-stroke".parse::<Locale>().unwrap_or_default()
    } else if ELECTRON_UNTAILORED.contains(&parsed.id.language.as_str()) {
        Locale::default()
    } else {
        parsed
    };
    Collator::try_new(&locale.into(), CollatorOptions::new())
        .map(LocaleCollator)
        .map_err(|e| CollatorError(e.to_string()))
}

/// The locale tag ICU derives from the POSIX environment: the first of `LC_ALL`, `LC_MESSAGES`,
/// `LANG` that is set and not empty; `C`, `POSIX` or nothing is `en-US`. `cs_CZ.UTF-8` is `cs-CZ`
/// (the encoding and any `@modifier` are dropped).
#[must_use]
pub fn posix_locale_tag(
    lc_all: Option<&str>,
    lc_messages: Option<&str>,
    lang: Option<&str>,
) -> String {
    let chosen = [lc_all, lc_messages, lang]
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
        .unwrap_or("C");
    let name = chosen.split(['.', '@']).next().unwrap_or("C");
    if name.is_empty() || name == "C" || name == "POSIX" {
        return "en-US".to_owned();
    }
    name.replace('_', "-")
}

impl LocaleCollator {
    /// `a.localeCompare(b)` as an ordering.
    #[must_use]
    pub fn compare(&self, a: &str, b: &str) -> Ordering {
        self.0.compare(a, b)
    }
}
