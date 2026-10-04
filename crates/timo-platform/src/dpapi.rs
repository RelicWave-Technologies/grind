//! Windows DPAPI (`CryptProtectData` / `CryptUnprotectData`), user scope.
//!
//! The one thing `timo-sync` cannot do itself (it forbids unsafe code): unwrap the
//! AES key Chromium keeps in `Local State` (`os_crypt.encrypted_key`) so the
//! Electron agent's `safeStorage` files can be imported. Chromium's own calls are
//! `os_crypt_win.cc::DecryptStringWithDPAPI` (`CryptUnprotectData`, flags 0, no
//! entropy) and `EncryptStringWithDPAPI` (`CryptProtectData`).
//!
//! Elsewhere both functions return [`PlatformError::Unsupported`]. Neither logs,
//! and an error carries the OS error text, never the data.

use crate::error::PlatformError;

/// DPAPI-unprotect `blob` for the current user.
pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>, PlatformError> {
    imp::unprotect(blob)
}

/// DPAPI-protect `plaintext` for the current user (used to prove the round trip).
pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
    imp::protect(plaintext)
}

#[cfg(target_os = "windows")]
mod imp {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData,
    };
    use windows::core::w;

    use crate::error::PlatformError;

    fn input_blob(data: &[u8]) -> Result<CRYPT_INTEGER_BLOB, PlatformError> {
        let len = u32::try_from(data.len())
            .map_err(|_| PlatformError::os("DPAPI", "input larger than 4 GiB"))?;
        Ok(CRYPT_INTEGER_BLOB {
            cbData: len,
            pbData: data.as_ptr().cast_mut(),
        })
    }

    /// Copy the OS-allocated output out, wipe it, and free it.
    ///
    /// # Safety
    /// `out` must have been filled in by a successful `CryptProtectData` or
    /// `CryptUnprotectData` call and not freed since; this call frees it.
    unsafe fn take_output(out: &CRYPT_INTEGER_BLOB) -> Result<Vec<u8>, PlatformError> {
        let len = usize::try_from(out.cbData)
            .map_err(|_| PlatformError::os("DPAPI", "output length does not fit in memory"))?;
        if out.pbData.is_null() {
            return Ok(Vec::new());
        }
        // SAFETY: per this function's contract `pbData` points to `cbData` readable
        // bytes the OS allocated; they are copied before anything frees them.
        let copied = unsafe { std::slice::from_raw_parts(out.pbData, len) }.to_vec();
        // SAFETY: the same `len` bytes are writable (the OS owns them for us to
        // free); zeroing keeps key material from lingering in freed heap.
        unsafe { std::ptr::write_bytes(out.pbData, 0, len) };
        // SAFETY: `pbData` was allocated by the OS with `LocalAlloc`, which is
        // what `LocalFree` releases; it is freed exactly once, here.
        unsafe { LocalFree(Some(HLOCAL(out.pbData.cast()))) };
        Ok(copied)
    }

    pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>, PlatformError> {
        let input = input_blob(blob)?;
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` borrows `blob`, which outlives the call; `out` is a valid
        // writable blob. The optional pointers are absent, as in Chromium.
        unsafe { CryptUnprotectData(&raw const input, None, None, None, None, 0, &raw mut out) }
            .map_err(|e| PlatformError::os("CryptUnprotectData", e))?;
        // SAFETY: the call above succeeded, so `out` is OS-allocated and unfreed.
        unsafe { take_output(&out) }
    }

    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
        let input = input_blob(plaintext)?;
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` borrows `plaintext`, which outlives the call; the
        // description is a static wide string; `out` is a valid writable blob.
        unsafe {
            CryptProtectData(
                &raw const input,
                w!("Timo"),
                None,
                None,
                None,
                0,
                &raw mut out,
            )
        }
        .map_err(|e| PlatformError::os("CryptProtectData", e))?;
        // SAFETY: the call above succeeded, so `out` is OS-allocated and unfreed.
        unsafe { take_output(&out) }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use crate::error::PlatformError;

    pub fn unprotect(_blob: &[u8]) -> Result<Vec<u8>, PlatformError> {
        Err(PlatformError::Unsupported("DPAPI"))
    }

    pub fn protect(_plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
        Err(PlatformError::Unsupported("DPAPI"))
    }
}

#[cfg(test)]
mod tests {
    use super::{protect, unprotect};

    #[cfg(windows)]
    #[test]
    fn round_trips_and_does_not_echo_the_secret() {
        let secret = b"\x00\x01 secret-key-material \xff".to_vec();
        let blob = protect(&secret).expect("protect");
        assert_ne!(blob, secret);
        assert_eq!(unprotect(&blob).expect("unprotect"), secret);
        let err = unprotect(b"not a dpapi blob SECRET-MARKER").expect_err("garbage");
        assert!(!format!("{err} {err:?}").contains("SECRET-MARKER"));
    }

    #[cfg(not(windows))]
    #[test]
    fn is_unsupported_off_windows() {
        assert!(protect(b"x").is_err());
        assert!(unprotect(b"x").is_err());
    }
}
