//! Walking the session candidates until one decrypts to a valid session.

use std::path::PathBuf;

use super::import::{CandidateFailure, ImportError};
use super::keys::OsCryptKeySource;
use super::payload::parse_tokens;
use crate::tokens::StoredTokens;

pub(super) enum Scan {
    /// The newest valid session; `skipped` candidates before it were not.
    Found {
        tokens: StoredTokens,
        skipped: usize,
    },
    /// Everything decrypted and nothing was a session; `invalid` files.
    NoSession { invalid: usize },
}

/// Port of `tokenStore.ts::readTokens`' loop, with the key asked for once, here,
/// and only because there is at least one file. `files` is newest first.
pub(super) fn scan_candidates<K: OsCryptKeySource>(
    files: &[PathBuf],
    keys: &K,
) -> Result<Scan, ImportError> {
    let key = keys.load_key()?;
    let (mut failed, mut invalid) = (0_usize, 0_usize);
    let mut first: Option<CandidateFailure> = None;
    for file in files {
        let plain = std::fs::read(file)
            .map_err(|e| CandidateFailure::Read(e.kind()))
            .and_then(|blob| key.decrypt(&blob).map_err(CandidateFailure::Decrypt));
        match plain {
            Ok(plain) => match parse_tokens(plain.expose()) {
                Some(tokens) => {
                    return Ok(Scan::Found {
                        tokens,
                        skipped: failed + invalid,
                    });
                }
                None => invalid += 1,
            },
            Err(failure) => {
                failed += 1;
                first.get_or_insert(failure);
            }
        }
    }
    match first {
        Some(first) => Err(ImportError::Undecryptable {
            candidates: files.len(),
            failed,
            invalid,
            first,
        }),
        None => Ok(Scan::NoSession { invalid }),
    }
}
