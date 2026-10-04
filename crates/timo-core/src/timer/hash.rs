//! SHA-256 as hex, the `createHash('sha256').update(s).digest('hex')` of the TS.

use core::fmt::Write as _;

use sha2::{Digest, Sha256};

/// Lower-case hex SHA-256 of the UTF-8 bytes of `text`.
#[must_use]
pub fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        // Writing to a String cannot fail.
        let _written = write!(out, "{byte:02x}");
    }
    out
}

/// `createHash('sha256').update(canonicalTimerEntryPayload(entry)).digest('hex')`:
/// the hash an acknowledgement is compared with.
pub fn canonical_entry_hash(
    entry: &crate::types::TimeEntry,
) -> Result<String, crate::error::CoreError> {
    Ok(sha256_hex(&crate::today_ledger::canonical(entry)?))
}

/// `canonicalTimerEntryPayload(entry)`.
pub fn canonical_entry_payload(
    entry: &crate::types::TimeEntry,
) -> Result<String, crate::error::CoreError> {
    crate::today_ledger::canonical(entry)
}
