//! The CoreGraphics calls screen capture needs, declared by hand like
//! `mac_ffi.rs` and kept to exactly what is used so each line can be checked
//! against the SDK header by eye.
//!
//! `CGDisplayCreateImage` is looked up with `dlsym` instead of being linked. It
//! is deprecated since macOS 14 and *obsoleted* in the macOS 15 SDK (the header
//! stops declaring it, though the framework still exports it and it still works
//! on macOS 26). A hard link would stop Timo from launching the day Apple deletes
//! the symbol; a lookup turns that day into a capture error and a `no frames`
//! health instead.

use std::ffi::{CStr, c_char, c_void};

use crate::PlatformError;

pub(super) type CGDirectDisplayID = u32;
type CGImageRef = *const c_void;
type CGDataProviderRef = *const c_void;
type CFDataRef = *const c_void;

type CreateImageFn = unsafe extern "C" fn(CGDirectDisplayID) -> CGImageRef;

/// `dlsym`'s "search every loaded image" pseudo-handle, `((void *) -2)`.
const RTLD_DEFAULT_ADDRESS: usize = usize::MAX - 1;

// CGBitmapInfo.
const BYTE_ORDER_MASK: u32 = 0x7000;
const BYTE_ORDER_32_LITTLE: u32 = 2 << 12;
const ALPHA_INFO_MASK: u32 = 0x1F;
const ALPHA_PREMULTIPLIED_FIRST: u32 = 2;
const ALPHA_FIRST: u32 = 4;
const ALPHA_NONE_SKIP_FIRST: u32 = 6;

const MAX_DISPLAYS: usize = 32;

unsafe extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGGetActiveDisplayList(max: u32, displays: *mut CGDirectDisplayID, count: *mut u32) -> i32;
    fn CGMainDisplayID() -> CGDirectDisplayID;
    fn CGImageGetWidth(image: CGImageRef) -> usize;
    fn CGImageGetHeight(image: CGImageRef) -> usize;
    fn CGImageGetBitsPerPixel(image: CGImageRef) -> usize;
    fn CGImageGetBitsPerComponent(image: CGImageRef) -> usize;
    fn CGImageGetBytesPerRow(image: CGImageRef) -> usize;
    fn CGImageGetBitmapInfo(image: CGImageRef) -> u32;
    fn CGImageGetDataProvider(image: CGImageRef) -> CGDataProviderRef;
    fn CGImageRelease(image: CGImageRef);
    fn CGDataProviderCopyData(provider: CGDataProviderRef) -> CFDataRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDataGetLength(data: CFDataRef) -> isize;
    fn CFDataGetBytePtr(data: CFDataRef) -> *const u8;
    fn CFRelease(cf: *const c_void);
}

/// The active displays, the one with the menu bar first (the order
/// `[NSScreen screens]` gives, which is where Chromium's capturer lists them).
pub(super) fn active_displays() -> Result<Vec<CGDirectDisplayID>, PlatformError> {
    let mut ids = [0u32; MAX_DISPLAYS];
    let mut count = 0u32;
    let max = u32::try_from(MAX_DISPLAYS).unwrap_or(u32::MAX);
    // SAFETY: `ids` has room for `max` entries and `count` is a valid out pointer.
    let status = unsafe { CGGetActiveDisplayList(max, ids.as_mut_ptr(), &raw mut count) };
    if status != 0 {
        return Err(PlatformError::os(
            "CGGetActiveDisplayList",
            format!("error {status}"),
        ));
    }
    let count = usize::try_from(count).unwrap_or(0).min(MAX_DISPLAYS);
    let mut list: Vec<CGDirectDisplayID> = ids.iter().take(count).copied().collect();
    // SAFETY: no arguments, no preconditions.
    let main = unsafe { CGMainDisplayID() };
    if let Some(at) = list.iter().position(|id| *id == main) {
        list.swap(0, at);
    }
    Ok(list)
}

/// What the OS said about one image's pixel format, for diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Format {
    pub bits_per_pixel: usize,
    pub bits_per_component: usize,
    pub bitmap_info: u32,
}

impl Format {
    /// 8-bit, 32-bit pixels, little-endian words with alpha (or a skipped byte)
    /// first: bytes in memory are B, G, R, A. This is what Chromium's capturer
    /// assumes without checking; here it is checked, so a different format
    /// (an HDR half-float image, say) is reported rather than encoded as noise.
    pub(super) fn is_bgra(self) -> bool {
        let alpha = self.bitmap_info & ALPHA_INFO_MASK;
        self.bits_per_pixel == 32
            && self.bits_per_component == 8
            && self.bitmap_info & BYTE_ORDER_MASK == BYTE_ORDER_32_LITTLE
            && matches!(
                alpha,
                ALPHA_PREMULTIPLIED_FIRST | ALPHA_FIRST | ALPHA_NONE_SKIP_FIRST
            )
    }
}

/// An owned `CGImageRef` from `CGDisplayCreateImage`.
pub(super) struct DisplayImage(CGImageRef);

impl DisplayImage {
    /// `CGDisplayCreateImage(display)`. `Ok(None)` is the OS returning no image
    /// (the call fails without Screen Recording permission on some systems, and
    /// when the display just went away); `Err` is the symbol being missing.
    pub(super) fn capture(display: CGDirectDisplayID) -> Result<Option<Self>, PlatformError> {
        let create = create_image_fn()?;
        // SAFETY: `create` is `CGDisplayCreateImage`, which takes a display id and
        // returns a +1 retained image or null.
        let image = unsafe { create(display) };
        Ok((!image.is_null()).then_some(Self(image)))
    }

    pub(super) fn width_height(&self) -> (usize, usize) {
        // SAFETY: `self.0` is a live image owned by `self`.
        unsafe { (CGImageGetWidth(self.0), CGImageGetHeight(self.0)) }
    }

    pub(super) fn bytes_per_row(&self) -> usize {
        // SAFETY: `self.0` is a live image owned by `self`.
        unsafe { CGImageGetBytesPerRow(self.0) }
    }

    pub(super) fn format(&self) -> Format {
        // SAFETY: `self.0` is a live image owned by `self`.
        unsafe {
            Format {
                bits_per_pixel: CGImageGetBitsPerPixel(self.0),
                bits_per_component: CGImageGetBitsPerComponent(self.0),
                bitmap_info: CGImageGetBitmapInfo(self.0),
            }
        }
    }

    /// Copy the image's pixel bytes (`CGDataProviderCopyData`): `bytes_per_row`
    /// apart, rows padded to the OS's alignment.
    pub(super) fn copy_pixels(&self) -> Result<Vec<u8>, PlatformError> {
        // SAFETY: `self.0` is a live image; the provider is borrowed from it.
        let data = unsafe { CGDataProviderCopyData(CGImageGetDataProvider(self.0)) };
        if data.is_null() {
            return Err(PlatformError::os("CGDataProviderCopyData", "returned null"));
        }
        // SAFETY: `data` is a live CFData we own; the slice is copied before release.
        let bytes = unsafe {
            let len = usize::try_from(CFDataGetLength(data)).unwrap_or(0);
            let ptr = CFDataGetBytePtr(data);
            let copied = if ptr.is_null() || len == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(ptr, len).to_vec()
            };
            CFRelease(data);
            copied
        };
        Ok(bytes)
    }
}

impl Drop for DisplayImage {
    fn drop(&mut self) {
        // SAFETY: `self.0` is the +1 reference `CGDisplayCreateImage` returned.
        unsafe { CGImageRelease(self.0) };
    }
}

impl std::fmt::Debug for DisplayImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DisplayImage").finish_non_exhaustive()
    }
}

fn create_image_fn() -> Result<CreateImageFn, PlatformError> {
    let name: &CStr = c"CGDisplayCreateImage";
    // SAFETY: `RTLD_DEFAULT` is a valid handle and `name` is NUL-terminated.
    let symbol = unsafe {
        dlsym(
            std::ptr::without_provenance_mut(RTLD_DEFAULT_ADDRESS),
            name.as_ptr(),
        )
    };
    if symbol.is_null() {
        return Err(PlatformError::os(
            "CGDisplayCreateImage",
            "the symbol is gone from CoreGraphics on this macOS",
        ));
    }
    // SAFETY: the symbol is `CGImageRef CGDisplayCreateImage(CGDirectDisplayID)`.
    Ok(unsafe { std::mem::transmute::<*mut c_void, CreateImageFn>(symbol) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_format_check_accepts_the_display_format_and_nothing_else() {
        let bgra = Format {
            bits_per_pixel: 32,
            bits_per_component: 8,
            // kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst
            bitmap_info: BYTE_ORDER_32_LITTLE | ALPHA_NONE_SKIP_FIRST,
        };
        assert!(bgra.is_bgra());
        assert!(
            Format {
                bitmap_info: BYTE_ORDER_32_LITTLE | ALPHA_PREMULTIPLIED_FIRST,
                ..bgra
            }
            .is_bgra()
        );
        // Big-endian (ARGB in memory), half-float HDR, 16-bit: all refused.
        assert!(
            !Format {
                bitmap_info: ALPHA_NONE_SKIP_FIRST,
                ..bgra
            }
            .is_bgra()
        );
        assert!(
            !Format {
                bits_per_pixel: 64,
                bits_per_component: 16,
                ..bgra
            }
            .is_bgra()
        );
        // RGBA order (alpha last) is not BGRA either.
        assert!(
            !Format {
                bitmap_info: BYTE_ORDER_32_LITTLE | 1,
                ..bgra
            }
            .is_bgra()
        );
    }

    #[test]
    fn the_symbol_resolves_on_this_mac() {
        assert!(create_image_fn().is_ok());
    }

    #[test]
    fn there_is_a_main_display_to_list() {
        // A headless CI runner may have none; the call must still succeed.
        assert!(active_displays().is_ok());
    }
}
