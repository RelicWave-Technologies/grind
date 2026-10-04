//! What a capture attempt says about the Screen Recording permission.
//!
//! `CaptureHealth` is how legacy tells "no permission" from "granted but
//! producing blank frames" (the tell that macOS revoked the grant mid-session,
//! which only a restart fixes). The three classifiers are the exact decisions in
//! `capture.ts`, lifted out of the OS calls so they test on every host.

/// `CaptureHealth` in `legacy/agent/src/main/services/permissions.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureHealth {
    Ok,
    NoPermission,
    Empty,
    Error,
    /// Nothing has been captured yet (the loop's initial value).
    Unknown,
}

impl CaptureHealth {
    /// The exact string legacy's union type holds.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::NoPermission => "no-permission",
            Self::Empty => "empty",
            Self::Error => "error",
            Self::Unknown => "unknown",
        }
    }
}

/// The verdict `captureNow` returns after it has looked at every display
/// (`capture.ts:183`): `ok` if at least one image was kept, else `empty` if any
/// display came back blank, else `error` (no displays at all).
#[must_use]
pub fn capture_health(kept: usize, saw_empty: bool) -> CaptureHealth {
    if kept > 0 {
        CaptureHealth::Ok
    } else if saw_empty {
        CaptureHealth::Empty
    } else {
        CaptureHealth::Error
    }
}

/// The verdict when the capture call itself throws (`capture.ts:124-127` and
/// `probeScreenCapture`'s `catch`): if the grant is there the failure is a real
/// `error`, otherwise it is `no-permission`.
#[must_use]
pub fn failure_health(has_screen_access: bool) -> CaptureHealth {
    if has_screen_access {
        CaptureHealth::Error
    } else {
        CaptureHealth::NoPermission
    }
}

/// `probeScreenCapture`'s verdict from what each display's 64×64 thumbnail
/// looked like (`true` = not empty): any usable thumbnail → `ok`, displays that
/// were all blank → `empty`, no displays → `error`.
#[must_use]
pub fn probe_health(thumbnails_usable: &[bool]) -> CaptureHealth {
    if thumbnails_usable.iter().any(|usable| *usable) {
        CaptureHealth::Ok
    } else if thumbnails_usable.is_empty() {
        CaptureHealth::Error
    } else {
        CaptureHealth::Empty
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ports of legacy `captureProbe.test.ts`. The Electron mocks become the
    // inputs the decision takes; "without touching disk" is structural, since
    // nothing in this module can reach the filesystem.

    #[test]
    fn verifies_a_usable_frame_without_writing_or_retaining_screenshot_files() {
        // `getSources` -> [{ thumbnail: { isEmpty: () => false } }]
        assert_eq!(probe_health(&[true]), CaptureHealth::Ok);
    }

    #[test]
    fn reports_missing_permission_without_touching_disk() {
        // `hasScreenAccess` false and `getSources` rejects.
        assert_eq!(failure_health(false), CaptureHealth::NoPermission);
    }

    #[test]
    fn a_failure_with_the_grant_in_place_is_an_error() {
        assert_eq!(failure_health(true), CaptureHealth::Error);
    }

    #[test]
    fn the_probe_tells_blank_from_absent() {
        assert_eq!(probe_health(&[false, false]), CaptureHealth::Empty);
        assert_eq!(probe_health(&[false, true]), CaptureHealth::Ok);
        assert_eq!(probe_health(&[]), CaptureHealth::Error);
    }

    #[test]
    fn capture_health_follows_the_ternary_in_capture_now() {
        assert_eq!(capture_health(1, false), CaptureHealth::Ok);
        assert_eq!(capture_health(2, true), CaptureHealth::Ok);
        assert_eq!(capture_health(0, true), CaptureHealth::Empty);
        assert_eq!(capture_health(0, false), CaptureHealth::Error);
    }

    #[test]
    fn strings_match_the_legacy_union() {
        assert_eq!(CaptureHealth::Ok.as_str(), "ok");
        assert_eq!(CaptureHealth::NoPermission.as_str(), "no-permission");
        assert_eq!(CaptureHealth::Empty.as_str(), "empty");
        assert_eq!(CaptureHealth::Error.as_str(), "error");
        assert_eq!(CaptureHealth::Unknown.as_str(), "unknown");
    }
}
