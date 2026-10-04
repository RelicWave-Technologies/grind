//! The process default locale: how ICU derives it from the environment (every case below was observed
//! on the real Electron 33.2.0 main process, see `PARITY.md`, "Locale") and that the comparator follows it.
#![allow(clippy::unwrap_used, reason = "tests unwrap")]

use core::cmp::Ordering;

use timo_core::js::collate::{collator, posix_locale_tag, set_default_locale};

#[test]
fn the_environment_names_the_default_locale_as_icu_does() {
    // (LC_ALL, LC_MESSAGES, LANG) -> `Intl.Collator().resolvedOptions().locale` on Electron 33.2.0.
    let observed = [
        ((None, None, None), "en-US"),
        ((None, None, Some("C.UTF-8")), "en-US"),
        ((None, None, Some("POSIX")), "en-US"),
        ((None, None, Some("cs_CZ.UTF-8")), "cs-CZ"),
        ((None, None, Some("da_DK.UTF-8")), "da-DK"),
        ((Some("en_US.UTF-8"), None, Some("cs_CZ.UTF-8")), "en-US"),
        ((None, Some("cs_CZ.UTF-8"), Some("en_US.UTF-8")), "cs-CZ"),
        (
            (
                Some("cs_CZ.UTF-8"),
                Some("da_DK.UTF-8"),
                Some("en_US.UTF-8"),
            ),
            "cs-CZ",
        ),
        ((None, None, Some("es_ES@collation=traditional")), "es-ES"),
        ((Some(""), None, Some("sk_SK.UTF-8")), "sk-SK"),
    ];
    for ((all, messages, lang), want) in observed {
        assert_eq!(
            posix_locale_tag(all, messages, lang),
            want,
            "{all:?} {messages:?} {lang:?}"
        );
    }
}

/// One test: the default is set once per process.
#[test]
fn the_comparator_follows_the_process_default_locale() {
    let ulid = ("01ARZ3NDEKTSV4RRFFQ69G50CH", "01ARZ3NDEKTSV4RRFFQ69G50CJ");
    // Nothing set: the root collation, `-1` as under en-US.
    assert_eq!(collator().unwrap().compare(ulid.0, ulid.1), Ordering::Less);
    assert!(set_default_locale("cs-CZ"));
    // The Czech "ch" is one letter after "h": `+1`.
    assert_eq!(
        collator().unwrap().compare(ulid.0, ulid.1),
        Ordering::Greater
    );
    assert!(!set_default_locale("en-US"), "the first default stays");
    assert_eq!(
        collator().unwrap().compare(ulid.0, ulid.1),
        Ordering::Greater
    );
}
