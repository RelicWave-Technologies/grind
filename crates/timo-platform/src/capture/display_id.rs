//! The `displayId` stored with every screenshot.
//!
//! Legacy stores Electron's `source.display_id`, falling back to `String(source.id)`
//! when it is empty (`capture.ts:161`). What Electron 33.2.0 puts there
//! (`shell/browser/api/electron_api_desktop_capturer.cc`):
//!
//! * **macOS**: `NumberToString(media_list_source.id.id)`, and for a screen that
//!   id is the `CGDirectDisplayID`. So the decimal display id.
//! * **Windows, DXGI capturer** (Electron's default there): the id of the
//!   `electron.screen` display, which is
//!   `base::PersistentHash("<adapter LUID low>/<LUID high>/<target id>")` from
//!   `DisplayInfo::DisplayIdFromMonitorInfo` (`ui/display/win/display_info.cc`,
//!   Chromium 130.0.6723.118), or, when `QueryDisplayConfig` gives no path for the
//!   monitor, `PersistentHash(<GDI device name>)`. `PersistentHash` is Paul
//!   Hsieh's `SuperFastHash` (`base/third_party/superfasthash/superfasthash.c`).
//! * **Windows, GDI fallback**: `display_id` stays empty, so legacy stores the
//!   source id, `screen:<index>:0`.
//!
//! The string is only used to tell displays apart and to group screenshots, but it
//! is stored and uploaded, so the same hash keeps an upgraded install's displays
//! the same displays.

/// `SuperFastHash` from Chromium's `base/third_party/superfasthash/superfasthash.c`,
/// byte for byte: the same arithmetic on `uint32_t`, tail bytes read as `signed
/// char` (sign-extended), and `0` for empty input.
#[must_use]
pub fn super_fast_hash(data: &[u8]) -> u32 {
    let Ok(len) = u32::try_from(data.len()) else {
        return 0;
    };
    if len == 0 || i32::try_from(len).is_err() {
        return 0;
    }
    let mut hash = len;
    let words = data.chunks_exact(4);
    let tail = words.remainder();
    for word in words {
        if let [a, b, c, d] = *word {
            hash = hash.wrapping_add(get16(a, b));
            let tmp = (get16(c, d) << 11) ^ hash;
            hash = (hash << 16) ^ tmp;
            hash = hash.wrapping_add(hash >> 11);
        }
    }
    hash = match *tail {
        [a, b, c] => {
            hash = hash.wrapping_add(get16(a, b));
            hash ^= hash << 16;
            hash ^= signed_char(c) << 18;
            hash.wrapping_add(hash >> 11)
        }
        [a, b] => {
            hash = hash.wrapping_add(get16(a, b));
            hash ^= hash << 11;
            hash.wrapping_add(hash >> 17)
        }
        [a] => {
            hash = hash.wrapping_add(signed_char(a));
            hash ^= hash << 10;
            hash.wrapping_add(hash >> 1)
        }
        _ => hash,
    };
    hash ^= hash << 3;
    hash = hash.wrapping_add(hash >> 5);
    hash ^= hash << 4;
    hash = hash.wrapping_add(hash >> 17);
    hash ^= hash << 25;
    hash.wrapping_add(hash >> 6)
}

/// `get16bits`: two bytes, little endian.
fn get16(low: u8, high: u8) -> u32 {
    (u32::from(high) << 8) + u32::from(low)
}

/// `(uint32_t)(signed char)byte`: sign-extended, then reinterpreted.
fn signed_char(byte: u8) -> u32 {
    i32::from(i8::from_ne_bytes([byte])).cast_unsigned()
}

/// Chromium's Windows display id from the monitor's display-config path:
/// `PersistentHash("%lu/%li/%u")` of the adapter LUID's low and high parts and
/// the target id, printed as the unsigned 32-bit value (`int64_t` holds it
/// without sign).
#[must_use]
pub fn windows_display_id(adapter_low: u32, adapter_high: i32, target_id: u32) -> String {
    let key = format!("{adapter_low}/{adapter_high}/{target_id}");
    super_fast_hash(key.as_bytes()).to_string()
}

/// Chromium's fallback when no display-config path matches: the hash of the GDI
/// device name (`\\.\DISPLAY1`).
#[must_use]
pub fn windows_display_id_from_device_name(device_name: &str) -> String {
    super_fast_hash(device_name.as_bytes()).to_string()
}

/// `s.display_id || String(s.id)`: JavaScript's `||` on a string, so an empty
/// `display_id` falls back to the source id.
#[must_use]
pub fn row_display_id(display_id: &str, source_id: &str) -> String {
    if display_id.is_empty() {
        source_id.to_owned()
    } else {
        display_id.to_owned()
    }
}

/// Electron's `DesktopMediaID::ToString()` for a screen: `screen:<id>:0`.
#[must_use]
pub fn screen_source_id(id: u32) -> String {
    format!("screen:{id}:0")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Produced by compiling Chromium 130.0.6723.118's
    /// `base/third_party/superfasthash/superfasthash.c` with `cc` and calling
    /// `SuperFastHash(s, strlen(s))` (`parity/native/capture/superfasthash.sh`).
    const GOLDEN: &[(&str, u32)] = &[
        ("", 0),
        ("a", 291_415_938),
        ("ab", 1_366_002_500),
        ("abc", 3_535_673_738),
        ("abcd", 3_671_636_187),
        ("abcde", 1_374_488_366),
        (r"\\.\DISPLAY1", 2_528_732_444),
        (r"\\.\DISPLAY2", 2_779_098_405),
        ("0/0/0", 671_097_153),
        ("46285/0/4353", 3_844_369_179),
        ("1234567890/-1/4294967295", 81_421_875),
        ("46285/0/4354", 3_520_136_428),
        ("4294967295/2147483647/65793", 3_290_175_832),
        ("The quick brown fox jumps over the lazy dog", 96_435_427),
    ];

    #[test]
    fn super_fast_hash_matches_the_chromium_c_source() {
        for (input, expected) in GOLDEN {
            assert_eq!(super_fast_hash(input.as_bytes()), *expected, "{input:?}");
        }
    }

    #[test]
    fn tail_bytes_above_0x7f_are_sign_extended_like_signed_char() {
        // Not in the golden list: the C source's `(signed char)` casts are the
        // one place a Rust port goes wrong silently. Pinned against a C build of
        // the same file for the bytes 0xE9 / 0xC3 0xA9 / 0xFF 0xFE 0xFD.
        assert_eq!(super_fast_hash(&[0xE9]), 1_776_944_832);
        assert_eq!(super_fast_hash(&[0xC3, 0xA9]), 3_304_826_196);
        assert_eq!(super_fast_hash(&[0xFF, 0xFE, 0xFD]), 1_417_302_142);
    }

    #[test]
    fn windows_display_id_hashes_the_luid_path_as_decimal() {
        assert_eq!(windows_display_id(46285, 0, 4353), "3844369179");
        assert_eq!(windows_display_id(46285, 0, 4354), "3520136428");
        assert_eq!(windows_display_id(1_234_567_890, -1, u32::MAX), "81421875");
        assert_eq!(windows_display_id(0, 0, 0), "671097153");
    }

    #[test]
    fn the_device_name_fallback_hashes_the_name() {
        assert_eq!(
            windows_display_id_from_device_name(r"\\.\DISPLAY1"),
            "2528732444"
        );
    }

    #[test]
    fn an_empty_display_id_falls_back_to_the_source_id() {
        assert_eq!(row_display_id("", &screen_source_id(3)), "screen:3:0");
        assert_eq!(row_display_id("1", &screen_source_id(3)), "1");
        assert_eq!(row_display_id("0", "screen:0:0"), "0");
    }
}
