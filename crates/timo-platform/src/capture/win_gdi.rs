//! The GDI half of Windows capture: copy one monitor's pixels into memory.

use std::ffi::c_void;

use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap,
    CreateCompatibleDC, CreateDCW, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDIBits, HBITMAP, HDC,
    HGDIOBJ, SRCCOPY, SelectObject,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows::core::{PCWSTR, w};

use super::frame::RawFrame;
use super::size::Dimensions;
use crate::PlatformError;

/// Per-monitor DPI awareness for this thread until dropped.
struct DpiScope(DPI_AWARENESS_CONTEXT);

impl DpiScope {
    fn enter() -> Self {
        // SAFETY: a plain thread setting; the previous value is restored on drop.
        Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
    }
}

impl Drop for DpiScope {
    fn drop(&mut self) {
        // SAFETY: `self.0` is the context `SetThreadDpiAwarenessContext` returned.
        unsafe { SetThreadDpiAwarenessContext(self.0) };
    }
}

/// A device context deleted when dropped.
struct Dc(HDC);

impl Drop for Dc {
    fn drop(&mut self) {
        // SAFETY: `self.0` came from `CreateDCW` / `CreateCompatibleDC` and is deleted once.
        unsafe { DeleteDC(self.0) }.as_bool();
    }
}

/// A bitmap deleted when dropped.
struct Bitmap(HBITMAP);

impl Drop for Bitmap {
    fn drop(&mut self) {
        // SAFETY: `self.0` came from `CreateCompatibleBitmap`, is not selected
        // into a DC any more (the caller restores the old object first) and is
        // deleted once.
        unsafe { DeleteObject(HGDIOBJ(self.0.0)) }.as_bool();
    }
}

/// Copy the monitor named `device` (NUL-terminated UTF-16) into BGRA pixels.
pub(super) fn grab(device: &[u16], size: Dimensions) -> Result<RawFrame, PlatformError> {
    let (width, height) = (to_i32(size.width)?, to_i32(size.height)?);
    let _dpi = DpiScope::enter();
    // SAFETY: "DISPLAY" is a valid driver name and `device` is NUL-terminated.
    let screen =
        Dc(unsafe { CreateDCW(w!("DISPLAY"), PCWSTR(device.as_ptr()), PCWSTR::null(), None) });
    if screen.0.is_invalid() {
        return Err(PlatformError::os(
            "CreateDC",
            "no device context for the monitor",
        ));
    }
    // SAFETY: `screen` is a live DC.
    let memory = Dc(unsafe { CreateCompatibleDC(Some(screen.0)) });
    if memory.0.is_invalid() {
        return Err(PlatformError::os("CreateCompatibleDC", "failed"));
    }
    // SAFETY: `screen` is a live DC and the size is positive.
    let bitmap = Bitmap(unsafe { CreateCompatibleBitmap(screen.0, width, height) });
    if bitmap.0.is_invalid() {
        return Err(PlatformError::os("CreateCompatibleBitmap", "failed"));
    }
    copy_pixels(&screen, &memory, &bitmap, size)
}

fn copy_pixels(
    screen: &Dc,
    memory: &Dc,
    bitmap: &Bitmap,
    size: Dimensions,
) -> Result<RawFrame, PlatformError> {
    let (width, height) = (to_i32(size.width)?, to_i32(size.height)?);
    // Everything fallible and unrelated to GDI state happens before the bitmap is selected.
    let mut bgra = vec![0u8; pixel_bytes(size)?];
    // SAFETY: both DCs and the bitmap are live; the old object is restored right after the blit.
    let old = unsafe { SelectObject(memory.0, HGDIOBJ(bitmap.0.0)) };
    // SAFETY: `memory` has the bitmap selected; `screen` is a live DC.
    let blit = unsafe {
        BitBlt(
            memory.0,
            0,
            0,
            width,
            height,
            Some(screen.0),
            0,
            0,
            SRCCOPY | CAPTUREBLT,
        )
    };
    // SAFETY: restoring the object that was selected before ours. `GetDIBits` requires
    // the bitmap not to be selected into any DC, so this is done on every path (the blit
    // result is only inspected afterwards) and before the readback.
    unsafe { SelectObject(memory.0, old) };
    blit.map_err(|e| PlatformError::os("BitBlt", e))?;
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: u32::try_from(std::mem::size_of::<BITMAPINFOHEADER>()).unwrap_or(0),
            biWidth: width,
            // Negative height: top row first.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    // SAFETY: `bgra` holds exactly `width * height * 4` bytes, the size `info` asks for; the bitmap is no longer selected into `memory`.
    let lines = unsafe {
        GetDIBits(
            memory.0,
            bitmap.0,
            0,
            size.height,
            Some(bgra.as_mut_ptr().cast::<c_void>()),
            &raw mut info,
            DIB_RGB_COLORS,
        )
    };
    if lines == 0 {
        return Err(PlatformError::os("GetDIBits", "copied no scan lines"));
    }
    RawFrame::new(size, bgra)
}

fn pixel_bytes(size: Dimensions) -> Result<usize, PlatformError> {
    usize::try_from(size.width)
        .ok()
        .zip(usize::try_from(size.height).ok())
        .and_then(|(w, h)| w.checked_mul(h))
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| PlatformError::os("display size", "overflows"))
}

fn to_i32(n: u32) -> Result<i32, PlatformError> {
    i32::try_from(n).map_err(|e| PlatformError::os("display size", e))
}
