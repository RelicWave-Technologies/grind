//! macOS capture: `CGDisplayCreateImage`, per display, at native pixel size.
//!
//! This is what legacy's Electron 33 uses, so it is what is kept. Chasing the
//! chain: `desktopCapturer.getSources({ types: ['screen'] })`
//! (`electron_api_desktop_capturer.cc`) → `MakeScreenCapturer()` →
//! `ShouldUseThumbnailCapturerMac` is false in Chromium 130 (its
//! `ScreenCaptureKit` features are all disabled by default) →
//! `content::desktop_capture::CreateScreenCapturer()` → WebRTC's
//! `ScreenCapturerMac`, whose `DesktopFrameProvider` calls
//! `CGDisplayCreateImage(display_id)` (the `IOSurface`/`CGDisplayStream` path is off
//! on macOS 14 and later). Same API, same TCC service (`kTCCServiceScreenCapture`),
//! so no new permission prompt compared with legacy. `ELECTRON-PARITY.md` has the
//! sources and the macOS 15 re-consent behaviour.

use super::display_id::{row_display_id, screen_source_id};
use super::frame::RawFrame;
use super::mac_sys::{CGDirectDisplayID, DisplayImage, active_displays};
use super::size::Dimensions;
use crate::PlatformError;

/// One display the OS reports.
#[derive(Debug)]
pub(super) struct Display {
    id: CGDirectDisplayID,
}

/// The displays to capture, main display first.
pub(super) fn displays() -> Result<Vec<Display>, PlatformError> {
    Ok(active_displays()?
        .into_iter()
        .map(|id| Display { id })
        .collect())
}

impl Display {
    /// Electron's `source.display_id` on macOS is the `CGDirectDisplayID` in
    /// decimal, and is never empty, so the source-id fallback is unreachable.
    pub(super) fn display_id(&self) -> String {
        row_display_id(&self.id.to_string(), &screen_source_id(self.id))
    }

    /// Capture this display at its native pixel size. `Ok(None)` is a blank
    /// capture: the OS gave no image, or a zero-sized one.
    pub(super) fn grab(&self) -> Result<Option<RawFrame>, PlatformError> {
        let Some(image) = DisplayImage::capture(self.id)? else {
            return Ok(None);
        };
        let (width, height) = image.width_height();
        let size = Dimensions::new(to_u32(width)?, to_u32(height)?);
        if size.is_empty() {
            return Ok(None);
        }
        let format = image.format();
        if !format.is_bgra() {
            return Err(PlatformError::os(
                "CGDisplayCreateImage",
                format!("unsupported pixel format {format:?}"),
            ));
        }
        let data = image.copy_pixels()?;
        RawFrame::from_strided(size, image.bytes_per_row(), data).map(Some)
    }
}

fn to_u32(n: usize) -> Result<u32, PlatformError> {
    u32::try_from(n).map_err(|e| PlatformError::os("display size", e))
}
