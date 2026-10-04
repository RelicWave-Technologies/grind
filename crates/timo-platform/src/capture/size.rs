//! Screenshot dimensions: the two resize rules legacy applies, and the constants
//! they share.
//!
//! Legacy resizes twice, and only the first is visible in `capture.ts`:
//!
//! 1. **Chromium's thumbnailer** — `desktopCapturer.getSources({ thumbnailSize:
//!    2560×2560 })` hands back the display scaled to *letterbox* inside that box.
//!    Letterboxing **enlarges** a small display too: a 1920×1080 monitor arrives as
//!    2560×1440. `thumbnail.getSize()` is the size after this step, and that is
//!    the `width`/`height` legacy reports.
//! 2. **sharp** — `resize({ 2560, 2560, fit: 'inside', withoutEnlargement: true })`.
//!    After step 1 the frame already fits, so this never changes anything in
//!    practice; it is kept so the rule still holds if the two caps ever differ.

/// `SCREENSHOT_MAX_EDGE` (`env.ts`): the longest edge of a stored screenshot.
pub const MAX_EDGE: u32 = 2560;

/// `SCREENSHOT_QUALITY` (`env.ts`, default 82): the WebP quality setting.
pub const QUALITY: u8 = 82;

/// Edge of the square `probeScreenCapture` asks Electron to scale into.
pub const PROBE_EDGE: u32 = 64;

/// A width and height in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

impl Dimensions {
    #[must_use]
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// Electron's `NativeImage.isEmpty()` for a bitmap of this size.
    #[must_use]
    pub fn is_empty(self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// `RoundedDivision(a, b)` from Chromium `media/base/video_util.cc`: `a / b`
/// rounded to nearest, halves up. Both operands are non-negative there.
fn rounded_division(a: u64, b: u64) -> u64 {
    (a + b / 2) / b
}

/// The thumbnail Chromium 130 makes of a `width`×`height` frame for a
/// `target_width`×`target_height` request.
///
/// Port of `ScaleDesktopFrame` (`chrome/browser/media/webrtc/native_desktop_media_list.cc`),
/// which sizes the bitmap with `media::ComputeLetterboxRegion(bounds, content)` =
/// `ScaleSizeToTarget(content, bounds.size(), fit_within_target = true)`
/// (`media/base/video_util.cc`, tag 130.0.6723.118). It scales the frame to touch
/// the box on its longer side — **up as well as down** — rounding the other side
/// to nearest. An empty frame, or a size that rounds to zero, is an empty image.
#[must_use]
pub fn chromium_thumbnail_size(frame: Dimensions, target: Dimensions) -> Dimensions {
    if frame.is_empty() || target.is_empty() {
        return Dimensions::new(0, 0);
    }
    let x = u64::from(frame.width) * u64::from(target.height);
    let y = u64::from(frame.height) * u64::from(target.width);
    // The result is at most `target` on both sides, so it always fits a u32.
    let narrow = |v: u64| u32::try_from(v).unwrap_or(u32::MAX);
    if y < x {
        Dimensions::new(
            target.width,
            narrow(rounded_division(y, u64::from(frame.width))),
        )
    } else {
        Dimensions::new(
            narrow(rounded_division(x, u64::from(frame.height))),
            target.height,
        )
    }
}

/// The size sharp's `resize({ width: edge, height: edge, fit: 'inside',
/// withoutEnlargement: true })` produces for a `frame` (libvips `vips_resize`
/// via `pipeline.cc`): untouched when it already fits, otherwise both sides are
/// divided by the larger of the two shrink factors and rounded to nearest, with
/// the longer side landing exactly on `edge`. Never below 1 px.
#[must_use]
pub fn sharp_inside_size(frame: Dimensions, edge: u32) -> Dimensions {
    if frame.width <= edge && frame.height <= edge {
        return frame;
    }
    let (long, short, width_is_long) = if frame.width >= frame.height {
        (frame.width, frame.height, true)
    } else {
        (frame.height, frame.width, false)
    };
    let scaled_short = rounded_division(u64::from(short) * u64::from(edge), u64::from(long)).max(1);
    let scaled_short = u32::try_from(scaled_short).unwrap_or(edge);
    if width_is_long {
        Dimensions::new(edge, scaled_short)
    } else {
        Dimensions::new(scaled_short, edge)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOX: Dimensions = Dimensions {
        width: MAX_EDGE,
        height: MAX_EDGE,
    };

    #[test]
    fn a_small_display_is_enlarged_to_the_box_like_chromium() {
        let got = chromium_thumbnail_size(Dimensions::new(1920, 1080), BOX);
        assert_eq!(got, Dimensions::new(2560, 1440));
        let got = chromium_thumbnail_size(Dimensions::new(1440, 900), BOX);
        assert_eq!(got, Dimensions::new(2560, 1600));
    }

    #[test]
    fn a_big_display_is_reduced_and_the_short_side_rounds_to_nearest() {
        // 3456 x 2234 (the 16" MacBook Pro panel): 2234 * 2560 / 3456 = 1654.8.
        let got = chromium_thumbnail_size(Dimensions::new(3456, 2234), BOX);
        assert_eq!(got, Dimensions::new(2560, 1655));
        // Portrait: the tall side touches the box.
        let got = chromium_thumbnail_size(Dimensions::new(1080, 1920), BOX);
        assert_eq!(got, Dimensions::new(1440, 2560));
        assert_eq!(
            chromium_thumbnail_size(Dimensions::new(5120, 2880), BOX),
            Dimensions::new(2560, 1440)
        );
    }

    #[test]
    fn a_frame_that_already_matches_the_box_is_unchanged() {
        assert_eq!(chromium_thumbnail_size(BOX, BOX), BOX);
        assert_eq!(
            chromium_thumbnail_size(Dimensions::new(2560, 1664), BOX),
            Dimensions::new(2560, 1664)
        );
    }

    #[test]
    fn empty_frames_and_collapsed_sides_are_empty() {
        assert!(chromium_thumbnail_size(Dimensions::new(0, 10), BOX).is_empty());
        assert!(chromium_thumbnail_size(Dimensions::new(10, 0), BOX).is_empty());
        // A 20000 x 10 strip rounds to a 0 px side in the 64 px probe box.
        let probe = Dimensions::new(PROBE_EDGE, PROBE_EDGE);
        assert!(chromium_thumbnail_size(Dimensions::new(20_000, 10), probe).is_empty());
    }

    #[test]
    fn the_probe_box_scales_a_real_display_to_a_non_empty_image() {
        let probe = Dimensions::new(PROBE_EDGE, PROBE_EDGE);
        let got = chromium_thumbnail_size(Dimensions::new(3456, 2234), probe);
        assert_eq!(got, Dimensions::new(64, 41));
    }

    #[test]
    fn sharp_leaves_a_frame_that_fits_alone() {
        let frame = Dimensions::new(1920, 1080);
        assert_eq!(sharp_inside_size(frame, MAX_EDGE), frame);
        assert_eq!(sharp_inside_size(BOX, MAX_EDGE), BOX);
    }

    #[test]
    fn sharp_never_enlarges_and_caps_the_long_edge() {
        assert_eq!(
            sharp_inside_size(Dimensions::new(5120, 2880), MAX_EDGE),
            Dimensions::new(2560, 1440)
        );
        assert_eq!(
            sharp_inside_size(Dimensions::new(3000, 4000), MAX_EDGE),
            Dimensions::new(1920, 2560)
        );
        // A hairline stays a hairline rather than vanishing.
        assert_eq!(
            sharp_inside_size(Dimensions::new(100_000, 3), MAX_EDGE),
            Dimensions::new(2560, 1)
        );
    }
}
