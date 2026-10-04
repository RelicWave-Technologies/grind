//! Windows capture: GDI `BitBlt`, one monitor at a time, in physical pixels.
//!
//! Legacy's Electron 33 (Chromium 130) tries DXGI Desktop Duplication first
//! (`kDirectXCapturer` is on by default) and falls back to GDI. GDI is kept
//! alone here: it has no device, no duplication session to lose on a mode
//! switch, a UAC prompt or a lock screen, and since Windows 8 the screen DC holds
//! the composed desktop, so the picture is the same. What DXGI adds is speed and
//! the cursor, neither of which a screenshot needs. See `ELECTRON-PARITY.md`.
//!
//! Each monitor is captured through its own device context
//! (`CreateDC("DISPLAY", "\\.\DISPLAYn")`) at the size and position
//! `EnumDisplaySettings(ENUM_CURRENT_SETTINGS)` reports, which is in physical
//! pixels whatever the monitor's scaling. The thread is switched to per-monitor
//! DPI awareness for the grab so a process that is not itself DPI aware still
//! gets real pixels, not a bitmap-stretched copy.

use windows::Win32::Graphics::Gdi::{
    DEVMODEW, DISPLAY_DEVICE_ATTACHED_TO_DESKTOP, DISPLAY_DEVICE_MIRRORING_DRIVER, DISPLAY_DEVICEW,
    ENUM_CURRENT_SETTINGS, EnumDisplayDevicesW, EnumDisplaySettingsW,
};
use windows::core::PCWSTR;

use super::display_id::{row_display_id, screen_source_id};
use super::frame::RawFrame;
use super::size::Dimensions;
use super::win_config::display_id_for_device;
use super::win_gdi;
use crate::PlatformError;

/// One monitor attached to the desktop.
#[derive(Debug)]
pub(super) struct Display {
    /// NUL-terminated UTF-16 GDI device name (`\\.\DISPLAY1`).
    device: Vec<u16>,
    size: Dimensions,
    id: String,
}

/// The monitors to capture: attached to the desktop, not mirroring drivers, in
/// the order GDI lists them (which is the order Chromium's capturer uses).
pub(super) fn displays() -> Result<Vec<Display>, PlatformError> {
    let mut found = Vec::new();
    let mut index = 0u32;
    loop {
        let mut device = DISPLAY_DEVICEW {
            cb: u32::try_from(std::mem::size_of::<DISPLAY_DEVICEW>()).unwrap_or(0),
            ..Default::default()
        };
        // SAFETY: `device` is a valid, correctly sized out structure.
        if !unsafe { EnumDisplayDevicesW(PCWSTR::null(), index, &raw mut device, 0) }.as_bool() {
            break;
        }
        let flags = device.StateFlags;
        let attached = flags.contains(DISPLAY_DEVICE_ATTACHED_TO_DESKTOP);
        let mirror = flags.contains(DISPLAY_DEVICE_MIRRORING_DRIVER);
        if attached && !mirror {
            found.push(describe(&device.DeviceName, index)?);
        }
        index += 1;
    }
    Ok(found)
}

/// Read a device's current mode and work out its `displayId`.
fn describe(name: &[u16; 32], index: u32) -> Result<Display, PlatformError> {
    let len = name.iter().position(|c| *c == 0).unwrap_or(name.len());
    let mut device: Vec<u16> = name.iter().take(len).copied().collect();
    device.push(0);
    let mut mode = DEVMODEW {
        dmSize: u16::try_from(std::mem::size_of::<DEVMODEW>()).unwrap_or(0),
        ..Default::default()
    };
    // SAFETY: `device` is NUL-terminated and `mode` is a sized out structure.
    let ok = unsafe {
        EnumDisplaySettingsW(
            PCWSTR(device.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &raw mut mode,
        )
    };
    if !ok.as_bool() {
        return Err(PlatformError::os("EnumDisplaySettings", "no current mode"));
    }
    let hashed = display_id_for_device(&device);
    Ok(Display {
        id: row_display_id(&hashed, &screen_source_id(index)),
        size: Dimensions::new(mode.dmPelsWidth, mode.dmPelsHeight),
        device,
    })
}

impl Display {
    pub(super) fn display_id(&self) -> String {
        self.id.clone()
    }

    /// Capture this monitor. `Ok(None)` is a blank capture (zero-sized mode).
    pub(super) fn grab(&self) -> Result<Option<RawFrame>, PlatformError> {
        if self.size.is_empty() {
            return Ok(None);
        }
        win_gdi::grab(&self.device, self.size).map(Some)
    }
}
