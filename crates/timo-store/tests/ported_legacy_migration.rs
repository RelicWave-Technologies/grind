//! 1:1 port of `legacy/agent/src/main/services/legacyMigration.test.ts`. The TypeScript mocks
//! `app.getPath('userData')`; here the current directory is the argument.
#![cfg(test)]

mod store_support;

use std::fs;
use std::path::Path;

use store_support::TempDir;
use timo_store::legacy_migration::{MigrationOutcome, migrate_legacy_user_data};

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

mod migrate_legacy_user_data_ {
    use super::*;

    #[test]
    fn copies_token_files_from_a_legacy_app_dir_when_the_current_dir_has_no_session() {
        let root = TempDir::new("mig");
        let legacy = root.path().join("Grind");
        let current = root.path().join("Timo");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("tokens.bin"), "TOKENS").unwrap();
        fs::write(legacy.join("pending-lark-login.bin"), "PENDING").unwrap();

        let outcome = migrate_legacy_user_data(&current);

        assert_eq!(
            outcome,
            MigrationOutcome::Migrated {
                from: legacy.clone()
            }
        );
        assert_eq!(read(&current.join("tokens.bin")), "TOKENS");
        assert_eq!(read(&current.join("pending-lark-login.bin")), "PENDING");
        assert!(!legacy.join("tokens.bin").exists());
        assert!(legacy.join("tokens.bin.migrated-to-timo").exists());
        assert!(!legacy.join("pending-lark-login.bin").exists());
        assert!(
            legacy
                .join("pending-lark-login.bin.migrated-to-timo")
                .exists()
        );
    }

    #[test]
    fn copies_local_state_from_the_scoped_package_name_app_dir() {
        let root = TempDir::new("mig");
        let legacy = root.path().join("@grind").join("agent");
        let current = root.path().join("Timo");
        fs::create_dir_all(legacy.join("screenshots")).unwrap();
        fs::write(legacy.join("tokens.bin"), "TOKENS").unwrap();
        fs::write(legacy.join("agent.db"), "DB").unwrap();
        fs::write(
            legacy.join("preferences.json"),
            r#"{"floatingBarVisible":true}"#,
        )
        .unwrap();
        fs::write(legacy.join("screenshots").join("shot.jpg"), "JPEG").unwrap();

        migrate_legacy_user_data(&current);

        assert_eq!(read(&current.join("tokens.bin")), "TOKENS");
        assert_eq!(read(&current.join("agent.db")), "DB");
        assert_eq!(
            read(&current.join("preferences.json")),
            r#"{"floatingBarVisible":true}"#
        );
        assert_eq!(read(&current.join("screenshots").join("shot.jpg")), "JPEG");
        assert!(!legacy.join("tokens.bin").exists());
        assert!(legacy.join("tokens.bin.migrated-to-timo").exists());
        assert!(!legacy.join("screenshots").exists());
        assert!(legacy.join("screenshots.migrated-to-timo").exists());
    }

    #[test]
    fn does_not_overwrite_an_existing_session_in_the_current_dir() {
        let root = TempDir::new("mig");
        let legacy = root.path().join("Grind");
        let current = root.path().join("Timo");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&current).unwrap();
        fs::write(legacy.join("tokens.bin"), "OLD").unwrap();
        fs::write(current.join("tokens.bin"), "CURRENT").unwrap();

        let outcome = migrate_legacy_user_data(&current);

        assert_eq!(outcome, MigrationOutcome::AlreadySignedIn);
        assert_eq!(read(&current.join("tokens.bin")), "CURRENT");
    }

    #[test]
    fn is_a_no_op_no_throw_when_there_is_no_legacy_dir() {
        let root = TempDir::new("mig");
        let current = root.path().join("Timo");
        fs::create_dir_all(&current).unwrap();

        let outcome = migrate_legacy_user_data(&current);

        assert_eq!(outcome, MigrationOutcome::NothingToMigrate);
        assert!(!current.join("tokens.bin").exists());
    }
}
