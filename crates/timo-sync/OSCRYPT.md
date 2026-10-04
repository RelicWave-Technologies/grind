# Importing the Electron agent's `safeStorage` files

`legacy/agent` (Electron **33.2.0**, `productName` "Timo", appId `com.relicwave.grind`) stores the
session in `<userData>/tokens.bin` (and short-lived `<userData>/pending-lark-login.bin`) with
`safeStorage.encryptString(JSON.stringify(x))`. `safeStorage` is Chromium's `os_crypt`. This file
records exactly what that does on each OS, where each fact comes from, and what is **not** proven.
The Rust that depends on it is `src/tokens/legacy/`.

**Version pin.** `electron/electron@v33.2.0` `DEPS` says `chromium_version` = `130.0.6723.118`. Every
Chromium source below was read at that tag (the tag URLs resolve; `main` no longer has
`components/os_crypt/sync/`, it moved to `async/`). I diffed the `.170` tag against `.118` for the
three files that matter: identical.

Legend: **[source]** read in the actual source; **[measured]** observed on an artifact on this
machine without touching any user data; **[prediction]** reasoned, not observed.

## What `safeStorage` returns

Electron `shell/browser/api/electron_api_safe_storage.cc` (v33.2.0)
<https://github.com/electron/electron/blob/v33.2.0/shell/browser/api/electron_api_safe_storage.cc>:

- `EncryptString` returns `node::Buffer::Copy(isolate, ciphertext.c_str(), ciphertext.size())`: the
  raw `OSCrypt::EncryptString` output, **no extra envelope**. That buffer is the file's whole content.
- `DecryptString`: `if (ciphertext.empty()) { return ""; }`, then
  `if (ciphertext.find(kEncryptionVersionPrefixV10) != 0 && ciphertext.find(kEncryptionVersionPrefixV11) != 0)`
  → throws "Ciphertext does not appear to be encrypted." So Electron itself refuses anything that
  does not start with `v10`/`v11`, on every OS. The importer does the same (typed `UnknownPrefix`),
  and an empty file reads as the empty string (which is then "not a session").
- A `v11` blob passes that gate; on macOS `os_crypt` only knows `v10` and would hand `v11…` back as
  cleartext (`os_crypt_mac.mm`: "If the prefix is not found then we'll assume we're dealing with old
  data saved as clear text"). Electron on macOS/Windows never writes `v11` (that is the Linux v11
  prefix), so it is rejected here. **[source]**

## macOS

Source files (tag `130.0.6723.118`), base
`https://chromium.googlesource.com/chromium/src/+/refs/tags/130.0.6723.118/`:

| Fact | File and quoted line |
|---|---|
| Prefix `v10` | `components/os_crypt/sync/os_crypt_mac.mm:44` `constexpr char kEncryptionVersionPrefix[] = "v10";`, and `EncryptString`: `ciphertext->insert(0, kEncryptionVersionPrefix);` |
| Salt | `os_crypt_mac.mm:33` `constexpr char kSalt[] = "saltysalt";` |
| Iterations | `os_crypt_mac.mm:39` `constexpr size_t kEncryptionIterations = 1003;` |
| Key size | `os_crypt_mac.mm:36` `constexpr size_t kDerivedKeySizeInBits = 128;` (16 bytes) |
| KDF | `os_crypt_mac.mm:121` `crypto::SymmetricKey::DeriveKeyFromPasswordUsingPbkdf2(crypto::SymmetricKey::AES, password, salt, kEncryptionIterations, kDerivedKeySizeInBits)` → `crypto/symmetric_key.cc:85` `int rv = PKCS5_PBKDF2_HMAC_SHA1(password.data(), password.length(), reinterpret_cast<const uint8_t*>(salt.data()), salt.length(), ...)` — **HMAC-SHA1**, password = the raw bytes of the `std::string` (`password.data(), password.length()`) |
| IV | `os_crypt_mac.mm:168` and `:208` `const std::string iv(kCCBlockSizeAES128, ' ');` = 16 ASCII spaces (0x20) |
| Cipher | `crypto/encryptor.cc:26-29` `GetCipherForKey`: `case 16: return EVP_aes_128_cbc();`; mode `crypto::Encryptor::CBC` in `os_crypt_mac.mm` |
| Padding | `crypto/encryptor.cc` calls `EVP_CipherInit_ex` / `EVP_CipherUpdate` / `EVP_CipherFinal_ex` and never `EVP_CIPHER_CTX_set_padding` (grep: no match), so BoringSSL's default **PKCS#7** applies. Also visible: `size_t result = length + ((do_encrypt && mode_ == CBC) ? 16 : 0);` — encryption always adds up to a whole block |
| Empty plaintext | `EncryptString`: `if (plaintext.empty()) { *ciphertext = std::string(); return true; }` — **an empty plaintext encrypts to an empty blob, with no prefix** |
| Layout | `"v10" ‖ AES-128-CBC(PKCS#7)(plaintext)`; decrypt strips `strlen(kEncryptionVersionPrefix)` bytes |

### Where the PBKDF2 password comes from

`components/os_crypt/sync/keychain_password_mac.mm` (same tag):

- `:46` `std::string password = base::Base64Encode(base::RandBytesAsVector(kBytes));` with
  `kBytes = 128 / 8` — Chromium creates a random 16-byte key, **base64-encodes it, and stores that
  string** (24 ASCII characters, ending `==`).
- `:91` read: `std::string password = std::string(static_cast<char*>(password_data), password_length);`
  — the stored bytes come back **verbatim**; no decoding. `os_crypt_mac.mm` then passes that string
  straight to `DeriveKeyFromPasswordUsingPbkdf2`. So: **PBKDF2 password = the Keychain item's data,
  as raw bytes, base64 text un-decoded**. (`MacKeychainKeySource` uses
  `keyring::Entry::get_secret()`, which returns the item's raw bytes, and the vectors in
  `tests/fixtures/osCrypt/` cover unicode and long passwords, which Node hashes as raw UTF-8 bytes too.)
- An empty result means "no key": `GetPassword` returns `std::string()` on denial or error, and
  `os_crypt_mac.mm`: `if (password.empty()) return cached_encryption_key_.get();` (null). The
  importer treats an empty password as an error for the same reason.

### Keychain item names for an Electron app named "Timo"

- Electron `shell/browser/electron_browser_main_parts.cc:541-542` (v33.2.0)
  <https://github.com/electron/electron/blob/v33.2.0/shell/browser/electron_browser_main_parts.cc>:
  `KeychainPassword::GetServiceName() = app_name + " Safe Storage";`
  `KeychainPassword::GetAccountName() = app_name;` **[source]**
- `app_name` there is `electron::Browser::Get()->GetName()` (`:500`), run in
  `PostCreateMainMessageLoop`, i.e. **before** the app's JavaScript runs (`PreMainMessageLoopRun`
  comes after it). `Browser::GetName()` (`shell/browser/browser.cc:156`) returns the
  `app.setName` override if any, else `GetExecutableFileProductName()`, which on macOS
  (`shell/browser/browser_mac.mm:459`) is `GetApplicationName()` =
  `[MainApplicationBundle().infoDictionary objectForKey:kCFBundleNameKey]`
  (`shell/common/application_info_mac.mm:29`). So the name comes from the **bundle's `CFBundleName`**,
  not from `package.json`'s `productName` at runtime. **[source]**
- **[measured]** `legacy/agent/release/Timo-0.0.2-beta.38-arm64-mac.zip` → `Timo.app/Contents/Info.plist`
  (read with `unzip -p | plutil -p`; nothing run or installed): `CFBundleName` = `Timo`,
  `CFBundleDisplayName` = `Timo`, `CFBundleExecutable` = `Timo`, `CFBundleIdentifier` =
  `com.relicwave.grind`. The legacy agent does not call `app.setName` (grep of `src/main`:
  no hit).

  ⇒ Keychain **service `Timo Safe Storage`, account `Timo`** for the shipped macOS build. This
  comes from Electron's source plus the shipped bundle's plist. I did **not** look at the real Keychain
  item (not permitted here), so "the item with those names exists on a user's Mac" is **[prediction]**
  until the first real import. Builds run as `electron .` in development would be
  `Electron Safe Storage`; `MacKeychainKeySource::new(product_name)` takes the name for that reason.
- The `keyring` crate looks the item up by exactly these two strings:
  `apple-native-keyring-store-1.0.2/src/keychain.rs` `find_generic_password(Some(&[keychain]), &self.service, &self.account)`
  (legacy file-keychain API, user domain default keychain). **[source]**

## Windows

`components/os_crypt/sync/os_crypt_win.cc` (same tag):

| Fact | Quoted line |
|---|---|
| Key lives in `Local State` | `:32` `constexpr char kOsCryptEncryptedKeyPrefName[] = "os_crypt.encrypted_key";` ("Contains base64 random key encrypted with DPAPI.") |
| Key length | `:39` `constexpr size_t kKeyLength = 256 / 8;` (32 bytes) |
| Nonce length | `:42` `constexpr size_t kNonceLength = 96 / 8;` (12 bytes) |
| Blob prefix | `:45` `constexpr char kEncryptionVersionPrefix[] = "v10";` |
| Key prefix | `:48` `constexpr char kDPAPIKeyPrefix[] = "DPAPI";` |
| Reading the key | `InitWithExistingKey`: `base::Base64Decode(base64_encrypted_key, &encrypted_key_with_header);` then `if (!base::StartsWith(encrypted_key_with_header, kDPAPIKeyPrefix, base::CompareCase::SENSITIVE)) { return OSCrypt::kInvalidKeyFormat; }`, `encrypted_key = encrypted_key_with_header.substr(sizeof(kDPAPIKeyPrefix) - 1);` (strips the 5 bytes), then `DecryptStringWithDPAPI(encrypted_key, &key)` |
| DPAPI call | `:95` `result = CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, 0, &output);` — no entropy, flags 0, user scope; `LocalFree(output.pbData)` after copying |
| Cipher | `:196` and `:222` `crypto::Aead aead(crypto::Aead::AES_256_GCM);` → `crypto/aead.cc:24` `aead_ = EVP_aead_aes_256_gcm();` |
| Encrypt layout | `EncryptString`: `aead.Seal(plaintext, nonce, std::string(), ciphertext)` (empty additional data), then `ciphertext->insert(0, nonce); ciphertext->insert(0, kEncryptionVersionPrefix);` ⇒ `"v10" ‖ nonce(12) ‖ ciphertext ‖ tag(16)` (BoringSSL's `Seal` appends the tag; `aead.cc` allocates `plaintext.size() + EVP_AEAD_max_overhead(aead_)`, 16 for GCM) |
| Decrypt layout | `:229` `ciphertext.substr(sizeof(kEncryptionVersionPrefix) - 1, kNonceLength)` = nonce; `:232` `ciphertext.substr(kNonceLength + (sizeof(kEncryptionVersionPrefix) - 1))` = ciphertext‖tag; `:234` `aead.Open(raw_ciphertext, nonce, std::string(), plaintext)` |
| Un-prefixed blob | `DecryptString`: `if (!base::StartsWith(ciphertext, kEncryptionVersionPrefix, ...)) return DecryptStringWithDPAPI(ciphertext, plaintext);` — a pre-2018 raw-DPAPI blob. Electron's `decryptString` rejects it earlier ("does not appear to be encrypted"), and Electron 33 never writes one |

`Local State` path: Electron `shell/browser/browser_process_impl.cc:115-116`:
`CHECK(base::PathService::Get(electron::DIR_SESSION_DATA, &prefs_path)); prefs_path = prefs_path.Append(FILE_PATH_LITERAL("Local State"));`
→ `<sessionData>/Local State`, and `DIR_SESSION_DATA` defaults to `userData` (`%APPDATA%\Timo`).
The file is JSON (`JsonPrefStore`); `os_crypt.encrypted_key` is the nested path
`{"os_crypt": {"encrypted_key": "<base64>"}}`. The caller passes `userData` in; the importer joins
`Local State` and never guesses the directory. **[source]** for the path rule; that `DIR_SESSION_DATA`
equals `userData` for this app (no `setPath('sessionData', …)` in `legacy/agent`) is **[prediction]**
from grep, not a run.

DPAPI itself is `timo_platform::dpapi::unprotect` (`crates/timo-platform/src/dpapi.rs`), which wraps
`CryptUnprotectData` with the same arguments as Chromium and `LocalFree`s the output. `timo-sync`
forbids unsafe code and does not depend on `timo-platform`; the host wires one into the other via
`KeyUnprotector`.

## How the claims are checked

- `crates/timo-sync/tests/os_crypt_vectors.rs` decrypts, and re-encrypts byte for byte, ~1,550
  vectors produced by `parity/src/gen/osCrypt.ts` with Node's OpenSSL `crypto` (no code shared with
  the RustCrypto crates): AES-128-CBC with PBKDF2-HMAC-SHA1(`saltysalt`, 1003), AES-256-GCM, empty / 1 /
  15 / 16 / 17 / 32 / 33 / 5000-byte and unicode plaintexts, real-shaped `StoredTokens` and pending-login
  JSON, and passwords of 1, 24, 63, 64, 65 and 300 bytes plus unicode. Mutation check: changing the
  iteration count to 1004 fails both macOS vectors tests.
- What the vectors do **not** prove: that Chromium's recipe is what I transcribed. That rests on the
  source quotes above. Node and RustCrypto agreeing shows the two implementations of *my reading*
  agree, not that the reading matches a real Electron blob.

## Not verified (read this before relying on the import)

1. **No real `tokens.bin` was decrypted.** Forbidden here (no Electron, no real Keychain or user
   data). The first real import on a machine that has an Electron-written file is the first
   end-to-end observation. Until then, "a blob Electron wrote decrypts here" is **[prediction]**
   backed by the source above and the independent vectors.
2. **The Keychain ACL prompt [prediction].** The item is created by the Electron app (`AddGenericPassword`
   with a null access argument, so its trusted-application list holds the creating app). The Tauri app
   reads another app's item, which on macOS normally raises "Timo wants to use your confidential
   information stored in 'Timo Safe Storage' in your keychain" with Allow / Always Allow / Deny. Both
   apps use bundle id `com.relicwave.grind` ([measured] for Electron's `Info.plist`; the Tauri side is only claimed by the
   `KEYCHAIN_SERVICE` comment in `vault.rs`, "the app identifier from `tauri.conf.json`"; I did not open it), so if the Tauri build is signed by the same Developer ID team the designated
   requirement may match and the prompt may not appear. I did **not** inspect either signature, so
   whether it prompts is unknown. Either way a denial is an `ImportError::Key`/`Undecryptable`, never
   a deletion: the files stay and the import can be retried.
   The importer asks for the key only once there is a file to decrypt and no session already in the
   keychain, so a machine with nothing to import is never prompted.
3. **`v10` on macOS uses the legacy file keychain (`SecKeychain*`).** `keyring` 4.2 does the same;
   behaviour on a Mac where Electron's item was created in the data-protection keychain would differ
   (whether Chromium 130's `crypto::AppleKeychain` also uses the legacy API, and so whether the item can live anywhere else, I did not check: **[prediction]** that it does not).
4. **Account name for dev builds / other product names** (`Electron Safe Storage` etc.) is not handled
   automatically; callers pass the product name.
5. **Secrets in memory.** `Secret` hides contents from `Debug` and nothing logs them, but the crate
   forbids unsafe code so buffers are not explicitly zeroised on drop.
6. **Windows end to end.** The Windows path (`LocalStateKeySource` + `dpapi`) type-checks and lints for
   `x86_64-pc-windows-msvc`, and its logic is tested with a fake `KeyUnprotector`; the real
   `CryptUnprotectData` round trip test (`dpapi.rs`, `cfg(windows)`) has never been executed here.
7. **A race, by design.** Between "is there already a session?" and the write there is no lock, so
   run the import once at startup, before any sign-in can happen.
