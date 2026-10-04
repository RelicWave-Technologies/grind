use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use crate::tokens::legacy::keys::{
    KeyError, MacKeychainKeySource, OsCryptKey, OsCryptKeySource, classify,
};
use crate::tokens::legacy::local_state::{KeyUnprotector, LocalStateKeySource, UnprotectError};

use super::support::{TempDir, WINDOWS_KEY};

/// DPAPI stand-in: "protecting" prepends a marker; `unprotect` insists on it.
struct FakeDpapi {
    plain: Vec<u8>,
}

const PROTECTED: &[u8] = b"<fake dpapi blob>";

impl KeyUnprotector for FakeDpapi {
    fn unprotect(&self, blob: &[u8]) -> Result<Vec<u8>, UnprotectError> {
        if blob == PROTECTED {
            Ok(self.plain.clone())
        } else {
            Err(UnprotectError("The data is invalid.".to_owned()))
        }
    }
}

fn local_state(encrypted_key: &str) -> String {
    format!(
        r#"{{"os_crypt":{{"audit_enabled":true,"encrypted_key":"{encrypted_key}"}},"other":1}}"#
    )
}

fn dpapi_key_b64(body: &[u8]) -> String {
    STANDARD.encode([b"DPAPI".as_slice(), body].concat())
}

fn load_from(content: &[u8], plain: Vec<u8>) -> Result<OsCryptKey, KeyError> {
    let dir = TempDir::new("localstate");
    dir.write("Local State", content);
    LocalStateKeySource::new(dir.path(), FakeDpapi { plain }).load_key()
}

#[test]
fn local_state_yields_the_unprotected_key() {
    let doc = local_state(&dpapi_key_b64(PROTECTED));
    let key = load_from(doc.as_bytes(), WINDOWS_KEY.to_vec()).expect("key");
    assert_eq!(
        key,
        OsCryptKey::windows_key(WINDOWS_KEY.to_vec()).expect("key")
    );
}

#[test]
fn local_state_failures_are_typed() {
    let ok_plain = WINDOWS_KEY.to_vec();
    let cases: Vec<(&str, Vec<u8>, KeyError)> = vec![
        ("not json", b"{{{".to_vec(), KeyError::LocalStateMalformed),
        ("array", b"[1,2]".to_vec(), KeyError::LocalStateMalformed),
        ("no os_crypt", b"{}".to_vec(), KeyError::EncryptedKeyMissing),
        (
            "no key field",
            br#"{"os_crypt":{}}"#.to_vec(),
            KeyError::EncryptedKeyMissing,
        ),
        (
            "key not a string",
            br#"{"os_crypt":{"encrypted_key":7}}"#.to_vec(),
            KeyError::EncryptedKeyMissing,
        ),
        (
            "bad base64",
            local_state("%%%not base64%%%").into_bytes(),
            KeyError::EncryptedKeyBase64,
        ),
        (
            "no DPAPI marker",
            local_state(&STANDARD.encode(b"XXXXXrest")).into_bytes(),
            KeyError::EncryptedKeyNotDpapi,
        ),
        (
            "empty key",
            local_state("").into_bytes(),
            KeyError::EncryptedKeyNotDpapi,
        ),
        (
            "DPAPI refuses",
            local_state(&dpapi_key_b64(b"other blob")).into_bytes(),
            KeyError::Unprotect("The data is invalid.".to_owned()),
        ),
    ];
    for (name, content, expected) in cases {
        assert_eq!(
            load_from(&content, ok_plain.clone()).expect_err(name),
            expected,
            "{name}"
        );
    }
}

#[test]
fn local_state_key_must_be_32_bytes() {
    let doc = local_state(&dpapi_key_b64(PROTECTED));
    assert_eq!(
        load_from(doc.as_bytes(), vec![1; 31]).expect_err("short"),
        KeyError::InvalidKeyLength { len: 31 }
    );
    assert_eq!(
        load_from(doc.as_bytes(), vec![1; 33]).expect_err("long"),
        KeyError::InvalidKeyLength { len: 33 }
    );
}

#[test]
fn missing_local_state_is_unreadable_not_found() {
    let dir = TempDir::new("nolocalstate");
    let source = LocalStateKeySource::new(dir.path(), FakeDpapi { plain: Vec::new() });
    assert_eq!(
        source.load_key().expect_err("no file"),
        KeyError::LocalStateUnreadable(std::io::ErrorKind::NotFound)
    );
}

#[test]
fn key_constructors_validate() {
    assert_eq!(
        OsCryptKey::mac_password(Vec::new()),
        Err(KeyError::EmptyKeychainPassword)
    );
    assert!(
        OsCryptKey::mac_password(vec![0xff, 0xfe]).is_ok(),
        "any bytes, not only UTF-8"
    );
    assert_eq!(
        OsCryptKey::windows_key(vec![0; 16]),
        Err(KeyError::InvalidKeyLength { len: 16 })
    );
}

#[test]
fn mac_source_names_the_item_as_electron_does() {
    // electron_browser_main_parts.cc: service = app_name + " Safe Storage", account = app_name.
    let source = MacKeychainKeySource::timo();
    assert_eq!(source.service(), "Timo Safe Storage");
    assert_eq!(source.account(), "Timo");
    assert_eq!(
        MacKeychainKeySource::new("Grind").service(),
        "Grind Safe Storage"
    );
}

#[test]
fn keyring_errors_map_to_kinds() {
    assert_eq!(
        classify(keyring::Error::NoEntry),
        KeyError::KeychainItemNotFound
    );
    assert!(matches!(
        classify(keyring::Error::NoDefaultStore),
        KeyError::KeychainFailure(_)
    ));
}
