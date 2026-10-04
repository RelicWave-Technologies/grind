use std::sync::Arc;

use crate::tokens::legacy::candidates::token_candidates;
use crate::tokens::legacy::import::{
    CandidateFailure, ImportError, ImportOutcome, import_legacy_session,
};
use crate::tokens::legacy::keys::KeyError;
use crate::tokens::{KeychainTokenStore, MemoryVault, SecretVault, TOKENS_SLOT, TokenStore};

use super::support::{
    FakeKeys, ForgetfulVault, Os, ReadOnlyVault, TempDir, tokens, tokens_json, touch,
};

fn write_session(dir: &TempDir, name: &str, os: Os, tag: &str) {
    dir.write(name, &os.encrypt(&tokens_json(&tokens(tag))));
}

#[tokio::test]
async fn imports_the_session_and_removes_the_file() {
    for os in Os::BOTH {
        let dir = TempDir::new("happy");
        write_session(&dir, "tokens.bin", os, "one");
        let vault = Arc::new(MemoryVault::new());
        let keys = FakeKeys::ok(os);

        let outcome = import_legacy_session(dir.path(), Arc::clone(&vault), &keys).await;

        assert_eq!(
            outcome,
            Ok(ImportOutcome::Imported {
                skipped: 0,
                leftover: 0
            })
        );
        let loaded = KeychainTokenStore::new(vault).load().await.expect("load");
        assert_eq!(loaded, Some(tokens("one")));
        assert!(!dir.exists("tokens.bin"));
        assert_eq!(keys.calls(), 1);
    }
}

#[tokio::test]
async fn a_session_already_in_the_keychain_wins_and_nothing_is_touched() {
    let dir = TempDir::new("present");
    write_session(&dir, "tokens.bin", Os::Mac, "old");
    let vault = Arc::new(MemoryVault::new());
    let store = KeychainTokenStore::new(Arc::clone(&vault));
    store.save(tokens("new")).await.expect("seed");
    let keys = FakeKeys::ok(Os::Mac);

    let outcome = import_legacy_session(dir.path(), Arc::clone(&vault), &keys).await;

    assert_eq!(outcome, Ok(ImportOutcome::AlreadyPresent));
    assert_eq!(store.load().await.expect("load"), Some(tokens("new")));
    assert!(dir.exists("tokens.bin"), "file left alone");
    assert_eq!(keys.calls(), 0, "no Keychain prompt");
}

#[tokio::test]
async fn an_invalid_entry_in_the_keychain_is_not_a_session() {
    let dir = TempDir::new("junk-entry");
    write_session(&dir, "tokens.bin", Os::Mac, "real");
    let vault = Arc::new(MemoryVault::new());
    vault.set(TOKENS_SLOT, b"not json").expect("seed junk");

    let outcome =
        import_legacy_session(dir.path(), Arc::clone(&vault), &FakeKeys::ok(Os::Mac)).await;

    assert_eq!(
        outcome,
        Ok(ImportOutcome::Imported {
            skipped: 0,
            leftover: 0
        })
    );
    assert_eq!(
        KeychainTokenStore::new(vault).load().await.expect("load"),
        Some(tokens("real"))
    );
}

#[tokio::test]
async fn no_file_means_nothing_to_import_and_no_prompt() {
    let dir = TempDir::new("empty");
    let keys = FakeKeys::ok(Os::Mac);
    let vault = Arc::new(MemoryVault::new());
    assert_eq!(
        import_legacy_session(dir.path(), Arc::clone(&vault), &keys).await,
        Ok(ImportOutcome::NothingToImport)
    );
    let missing = dir.path().join("no-such-dir");
    assert_eq!(
        import_legacy_session(&missing, vault, &keys).await,
        Ok(ImportOutcome::NothingToImport)
    );
    assert_eq!(keys.calls(), 0);
}

#[tokio::test]
async fn the_newest_slot_wins_even_if_it_is_a_next_file() {
    // Port of tokenStore.test.ts case 5: a newer valid .next slot beats tokens.bin.
    for os in Os::BOTH {
        let dir = TempDir::new("order-next");
        write_session(&dir, "tokens.bin", os, "old");
        write_session(&dir, "tokens.bin.4242.7.next", os, "newest");
        write_session(&dir, "tokens.bin.4242.6.next", os, "middle");
        touch(&dir.path().join("tokens.bin"), 1_000);
        touch(&dir.path().join("tokens.bin.4242.6.next"), 2_000);
        touch(&dir.path().join("tokens.bin.4242.7.next"), 3_000);
        let vault = Arc::new(MemoryVault::new());

        let outcome =
            import_legacy_session(dir.path(), Arc::clone(&vault), &FakeKeys::ok(os)).await;

        assert_eq!(
            outcome,
            Ok(ImportOutcome::Imported {
                skipped: 0,
                leftover: 0
            })
        );
        assert_eq!(
            KeychainTokenStore::new(vault).load().await.expect("load"),
            Some(tokens("newest"))
        );
        assert!(
            token_candidates(dir.path()).expect("list").is_empty(),
            "every slot deleted"
        );
    }
}

#[tokio::test]
async fn a_newer_canonical_file_beats_an_older_next_slot() {
    let dir = TempDir::new("order-canonical");
    write_session(&dir, "tokens.bin", Os::Mac, "canonical");
    write_session(&dir, "tokens.bin.9.1.next", Os::Mac, "stale");
    touch(&dir.path().join("tokens.bin.9.1.next"), 1_000);
    touch(&dir.path().join("tokens.bin"), 2_000);
    let vault = Arc::new(MemoryVault::new());
    import_legacy_session(dir.path(), Arc::clone(&vault), &FakeKeys::ok(Os::Mac))
        .await
        .expect("import");
    assert_eq!(
        KeychainTokenStore::new(vault).load().await.expect("load"),
        Some(tokens("canonical"))
    );
}

#[tokio::test]
async fn an_invalid_newest_file_is_skipped_for_the_next_valid_one() {
    let dir = TempDir::new("skip-invalid");
    write_session(&dir, "tokens.bin", Os::Mac, "good");
    let missing_field = br#"{"accessToken":"a","refreshToken":"r","userId":"u"}"#;
    dir.write("tokens.bin.1.1.next", &Os::Mac.encrypt(missing_field));
    touch(&dir.path().join("tokens.bin"), 1_000);
    touch(&dir.path().join("tokens.bin.1.1.next"), 2_000);
    let vault = Arc::new(MemoryVault::new());

    let outcome =
        import_legacy_session(dir.path(), Arc::clone(&vault), &FakeKeys::ok(Os::Mac)).await;

    assert_eq!(
        outcome,
        Ok(ImportOutcome::Imported {
            skipped: 1,
            leftover: 0
        })
    );
    assert_eq!(
        KeychainTokenStore::new(vault).load().await.expect("load"),
        Some(tokens("good"))
    );
    assert!(
        !dir.exists("tokens.bin.1.1.next"),
        "the invalid slot goes too"
    );
}

#[tokio::test]
async fn empty_string_parts_are_not_a_session() {
    let dir = TempDir::new("empty-part");
    dir.write(
        "tokens.bin",
        &Os::Mac
            .encrypt(br#"{"accessToken":"","refreshToken":"r","userId":"u","workspaceId":"w"}"#),
    );
    let outcome = import_legacy_session(
        dir.path(),
        Arc::new(MemoryVault::new()),
        &FakeKeys::ok(Os::Mac),
    )
    .await;
    assert_eq!(outcome, Ok(ImportOutcome::NoValidSession { candidates: 1 }));
    assert!(dir.exists("tokens.bin"), "kept: nothing was imported");
}

#[tokio::test]
async fn extra_keys_and_a_repeated_key_follow_json_parse() {
    let dir = TempDir::new("extra");
    let json = br#"{"accessToken":"first","accessToken":"a","refreshToken":"r","userId":"u","workspaceId":"w","extra":[1]}"#;
    dir.write("tokens.bin", &Os::Windows.encrypt(json));
    let vault = Arc::new(MemoryVault::new());
    import_legacy_session(dir.path(), Arc::clone(&vault), &FakeKeys::ok(Os::Windows))
        .await
        .expect("import");
    let loaded = KeychainTokenStore::new(vault)
        .load()
        .await
        .expect("load")
        .expect("session");
    assert_eq!(
        loaded.access_token, "a",
        "last duplicate wins, as in JSON.parse"
    );
}

#[tokio::test]
async fn wrong_key_for_every_file_is_an_error_and_files_stay() {
    for os in Os::BOTH {
        let dir = TempDir::new("wrongkey");
        write_session(&dir, "tokens.bin", os, "one");
        write_session(&dir, "tokens.bin.1.1.next", os, "two");
        let vault = Arc::new(MemoryVault::new());
        let keys = FakeKeys::new(Ok(os.wrong_key()));

        let outcome = import_legacy_session(dir.path(), Arc::clone(&vault), &keys).await;

        let Err(ImportError::Undecryptable {
            candidates,
            failed,
            invalid,
            first,
        }) = outcome
        else {
            panic!("expected Undecryptable, got {outcome:?}");
        };
        assert_eq!((candidates, failed, invalid), (2, 2, 0));
        assert!(matches!(first, CandidateFailure::Decrypt(_)));
        assert!(dir.exists("tokens.bin") && dir.exists("tokens.bin.1.1.next"));
        assert_eq!(vault.get(TOKENS_SLOT).expect("get"), None);
    }
}

#[tokio::test]
async fn a_denied_keychain_prompt_is_an_error_and_files_stay() {
    let dir = TempDir::new("denied");
    write_session(&dir, "tokens.bin", Os::Mac, "one");
    let keys = FakeKeys::new(Err(KeyError::KeychainFailure(
        "User canceled the operation".to_owned(),
    )));
    let outcome = import_legacy_session(dir.path(), Arc::new(MemoryVault::new()), &keys).await;
    assert_eq!(
        outcome,
        Err(ImportError::Key(KeyError::KeychainFailure(
            "User canceled the operation".to_owned()
        )))
    );
    assert!(dir.exists("tokens.bin"));
}

#[tokio::test]
async fn files_are_deleted_only_after_the_write_reads_back() {
    // The vault accepts the write and then forgets it: the files must survive.
    let dir = TempDir::new("readback");
    write_session(&dir, "tokens.bin", Os::Mac, "one");
    let outcome =
        import_legacy_session(dir.path(), Arc::new(ForgetfulVault), &FakeKeys::ok(Os::Mac)).await;
    assert_eq!(outcome, Err(ImportError::ReadBackMismatch));
    assert!(dir.exists("tokens.bin"));

    // The vault refuses the write: same.
    let outcome = import_legacy_session(
        dir.path(),
        Arc::new(ReadOnlyVault::default()),
        &FakeKeys::ok(Os::Mac),
    )
    .await;
    assert!(matches!(outcome, Err(ImportError::Vault(_))), "{outcome:?}");
    assert!(dir.exists("tokens.bin"));
}

#[tokio::test]
async fn only_the_agents_own_slots_are_candidates() {
    let dir = TempDir::new("names");
    write_session(&dir, "tokens.bin", Os::Mac, "real");
    for name in [
        "tokens.bin.bak",
        "tokens.bin.next.tmp",
        "xtokens.bin",
        "tokens.binnext",
        "other.next",
        "tokens.bin.migrated-to-timo",
    ] {
        dir.write(name, b"unrelated");
    }
    std::fs::create_dir(dir.path().join("tokens.bin.0.0.next")).expect("dir named like a slot");
    write_session(&dir, "tokens.bin.next", Os::Mac, "dotted");
    touch(&dir.path().join("tokens.bin"), 5_000);
    touch(&dir.path().join("tokens.bin.next"), 1_000);

    let names: Vec<String> = token_candidates(dir.path())
        .expect("list")
        .iter()
        .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_owned))
        .collect();
    assert_eq!(names, ["tokens.bin", "tokens.bin.next"]);

    import_legacy_session(
        dir.path(),
        Arc::new(MemoryVault::new()),
        &FakeKeys::ok(Os::Mac),
    )
    .await
    .expect("import");
    assert!(
        dir.exists("tokens.bin.bak") && dir.exists("other.next"),
        "unrelated files stay"
    );
    assert!(dir.path().join("tokens.bin.0.0.next").is_dir());
}

#[tokio::test]
async fn an_empty_file_decrypts_to_nothing_and_is_not_a_session() {
    let dir = TempDir::new("zero-bytes");
    dir.write("tokens.bin", b"");
    let outcome = import_legacy_session(
        dir.path(),
        Arc::new(MemoryVault::new()),
        &FakeKeys::ok(Os::Mac),
    )
    .await;
    assert_eq!(outcome, Ok(ImportOutcome::NoValidSession { candidates: 1 }));
}
