//! Screenshot capture: every display at full resolution, through the same pixel
//! pipeline legacy runs, plus the 64×64 permission probe.
//!
//! Ports of `legacy/agent/src/main/services/capture/capture.ts`
//! (`captureNow`, `probeScreenCapture`, `bgraToRgbaInPlace`, `dayDir`). The OS
//! half grabs raw BGRA pixels per display (macOS `CGDisplayCreateImage`, Windows
//! GDI); everything else — sizes, health, paths, the WebP encode — is plain Rust
//! that compiles and tests on any host. Time and ids are arguments: the caller
//! samples `serverAlignedNow()` after the capture returns (as legacy does) and
//! mints the ULIDs, then hands both to [`write_screenshot`].
//!
//! Privacy contract: pixels are held in memory for the length of one capture and
//! written only by [`write_screenshot`]; the probe keeps nothing.

use crate::PlatformError;
use crate::permissions::{ScreenStatus, screen_status};

pub mod display_id;
#[cfg(feature = "encode")]
pub mod encode;
pub mod frame;
pub mod health;
pub mod layout;
pub mod size;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
mod mac_sys;
#[cfg(target_os = "macos")]
use mac as imp;

#[cfg(target_os = "windows")]
mod win_config;
#[cfg(target_os = "windows")]
mod win_gdi;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as imp;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use unsupported as imp;

pub use health::CaptureHealth;
pub use layout::{day_dir, screenshot_path, screenshots_dir, utc_day, write_screenshot};
use size::{Dimensions, PROBE_EDGE, chromium_thumbnail_size};

/// One display's finished screenshot, before it has an id or a time.
#[cfg(feature = "encode")]
#[derive(Debug)]
pub struct CapturedShot {
    /// `displayId` as legacy stores it.
    pub display_id: String,
    /// `width`/`height` as legacy stores them: the thumbnail size, before sharp.
    pub size: Dimensions,
    /// The WebP file's bytes (`bytes` is their length).
    pub webp: Vec<u8>,
}

/// What [`capture_now`] returns: one shot per usable display, and the verdict.
#[cfg(feature = "encode")]
#[derive(Debug)]
pub struct CaptureResult {
    pub shots: Vec<CapturedShot>,
    pub health: CaptureHealth,
}

/// One display's raw capture, before any resizing or encoding.
#[derive(Debug)]
pub struct GrabbedDisplay {
    /// `displayId` as legacy stores it.
    pub display_id: String,
    /// `None` is a blank capture (legacy's empty thumbnail).
    pub frame: Option<frame::RawFrame>,
}

/// Grab every display's pixels at native size and stop there. All frames are
/// held at once (a 4K display is 33 MB), so this is for diagnostics and tests;
/// [`capture_now`] handles one display at a time.
pub fn grab_displays() -> Result<Vec<GrabbedDisplay>, PlatformError> {
    imp::displays()?
        .iter()
        .map(|display| {
            Ok(GrabbedDisplay {
                display_id: display.display_id(),
                frame: grab_blank_as_none(display),
            })
        })
        .collect()
}

/// `hasScreenAccess()`: Screen Recording granted (always, on Windows).
fn has_screen_access() -> bool {
    screen_status().is_ok_and(|status| status == ScreenStatus::Granted)
}

/// Capture every display now (`captureNow`).
///
/// Without Screen Recording permission, and not `force`, nothing is captured
/// (`no-permission`). `force` captures anyway: on macOS the first such call is
/// what registers the app in the Screen Recording list. A display the OS cannot
/// capture counts as blank (`empty`); the OS call failing outright is `error`,
/// or `no-permission` if the grant is missing. Like legacy, only a failure
/// *after* pixels exist (resize, encode) is an `Err`.
///
/// Blocking: it takes a few hundred milliseconds to a couple of seconds per
/// display. Call it from a blocking thread, never an IPC handler.
#[cfg(feature = "encode")]
pub fn capture_now(force: bool) -> Result<CaptureResult, PlatformError> {
    if !force && !has_screen_access() {
        return Ok(CaptureResult {
            shots: Vec::new(),
            health: CaptureHealth::NoPermission,
        });
    }
    let displays = match imp::displays() {
        Ok(displays) => displays,
        Err(error) => {
            tracing::warn!(%error, "screenshot capture failed — likely missing Screen Recording permission");
            return Ok(CaptureResult {
                shots: Vec::new(),
                health: health::failure_health(has_screen_access()),
            });
        }
    };
    let mut shots = Vec::new();
    let mut saw_empty = false;
    for display in &displays {
        match grab_blank_as_none(display) {
            Some(frame) => match encode::encode_frame(frame)? {
                Some(done) => shots.push(CapturedShot {
                    display_id: display.display_id(),
                    size: done.size,
                    webp: done.webp,
                }),
                None => saw_empty = true,
            },
            None => saw_empty = true,
        }
    }
    let health = health::capture_health(shots.len(), saw_empty);
    Ok(CaptureResult { shots, health })
}

/// Grab one display; a failed grab is a blank one, as legacy's empty thumbnail.
fn grab_blank_as_none(display: &imp::Display) -> Option<frame::RawFrame> {
    match display.grab() {
        Ok(frame) => frame,
        Err(error) => {
            let id = display.display_id();
            tracing::warn!(%error, %id, "display capture failed");
            None
        }
    }
}

/// Permission/readiness probe (`probeScreenCapture`): grab every display and
/// say whether anything non-blank came back, in the 64×64 thumbnail Electron
/// is asked for. Never writes, uploads or keeps pixels; each frame is dropped
/// as soon as it has been looked at.
#[must_use]
pub fn probe_screen_capture() -> CaptureHealth {
    let Ok(displays) = imp::displays() else {
        return health::failure_health(has_screen_access());
    };
    let probe_box = Dimensions::new(PROBE_EDGE, PROBE_EDGE);
    let usable: Vec<bool> = displays
        .iter()
        .map(|display| {
            grab_blank_as_none(display)
                .is_some_and(|f| !chromium_thumbnail_size(f.size(), probe_box).is_empty())
        })
        .collect();
    health::probe_health(&usable)
}
