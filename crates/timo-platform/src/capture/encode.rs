//! The pixel pipeline: raw display pixels in, a WebP file's bytes out.
//!
//! ```text
//! legacy:  getSources(2560x2560)      Chromium letterboxes the frame (enlarges too)
//!          toBitmap() BGRA -> RGBA    bgraToRgbaInPlace
//!          sharp raw -> removeAlpha -> resize(inside, withoutEnlargement) -> webp(82)
//! here:    RawFrame (BGRA)
//!          -> scale to chromium_thumbnail_size           (fast_image_resize, bilinear)
//!          -> BGRA -> RGB, alpha dropped
//!          -> scale to sharp_inside_size if it differs   (Lanczos3, sharp's default)
//!          -> libwebp lossy, quality 82, method 4
//! ```
//!
//! libwebp is the encoder sharp wraps (libvips 8.15 with libwebp 1.4.0; the
//! `webp` crate vendors the same 1.4.0), driven with the same settings, so the
//! bytes for a given RGB image are expected to match sharp's; resizing is the one
//! place the output can differ (libyuv's bilinear in Chromium, libvips' kernels in
//! sharp, versus a convolution here), and that only moves pixel values by a few
//! levels. `PARITY.md` records it; `tests/capture_parity.rs` measures it.

use fast_image_resize::images::Image;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use webp::{Encoder, WebPConfig};

use super::frame::{RawFrame, bgra_to_rgb};
use super::size::{Dimensions, MAX_EDGE, QUALITY, chromium_thumbnail_size, sharp_inside_size};
use crate::PlatformError;

/// libwebp's `WEBP_MAX_DIMENSION`: no side of a WebP can exceed it.
const WEBP_MAX_DIMENSION: u32 = 16_383;

/// `sharp`'s default `effort` for WebP (libvips `effort`, libwebp `method`).
const WEBP_METHOD: i32 = 4;

/// A screenshot ready to be written: the size Electron's `thumbnail.getSize()`
/// reports (what legacy stores as `width`/`height`) and the WebP bytes.
#[derive(Debug)]
pub struct EncodedFrame {
    /// Size after Chromium's thumbnailer, before sharp's (no-op) resize.
    pub size: Dimensions,
    pub webp: Vec<u8>,
}

/// Run one display's pixels through the whole pipeline. `Ok(None)` is an
/// *empty* thumbnail (Electron's `isEmpty()`): a zero-sized frame, or one the
/// thumbnailer rounds to zero.
pub fn encode_frame(frame: RawFrame) -> Result<Option<EncodedFrame>, PlatformError> {
    let source = frame.size();
    let box_edge = Dimensions::new(MAX_EDGE, MAX_EDGE);
    let thumb = chromium_thumbnail_size(source, box_edge);
    if thumb.is_empty() {
        return Ok(None);
    }
    let bgra = scale_bgra(frame, thumb, FilterType::Bilinear)?;
    let rgb = bgra_to_rgb(&bgra);
    let webp = encode_rgb_like_sharp(rgb, thumb, MAX_EDGE)?;
    Ok(Some(EncodedFrame { size: thumb, webp }))
}

/// The sharp half of the pipeline on packed RGB: `resize({ edge, edge, fit:
/// 'inside', withoutEnlargement: true })` (a no-op when the image fits) then
/// `webp({ quality: 82 })`. Exposed so the parity tests can feed it the same
/// pixels sharp gets.
pub fn encode_rgb_like_sharp(
    rgb: Vec<u8>,
    size: Dimensions,
    edge: u32,
) -> Result<Vec<u8>, PlatformError> {
    let target = sharp_inside_size(size, edge);
    if target == size {
        return encode_webp(&rgb, size);
    }
    let resized = scale_rgb(rgb, size, target)?;
    encode_webp(&resized, target)
}

/// Resize BGRA pixels (treated as four independent channels) to `to`.
fn scale_bgra(
    frame: RawFrame,
    to: Dimensions,
    filter: FilterType,
) -> Result<Vec<u8>, PlatformError> {
    let from = frame.size();
    if from == to {
        return Ok(frame.into_bgra());
    }
    let scale = Scale {
        from,
        to,
        pixel: PixelType::U8x4,
        filter,
    };
    resize(frame.into_bgra(), &scale)
}

fn scale_rgb(rgb: Vec<u8>, from: Dimensions, to: Dimensions) -> Result<Vec<u8>, PlatformError> {
    let scale = Scale {
        from,
        to,
        pixel: PixelType::U8x3,
        filter: FilterType::Lanczos3,
    };
    resize(rgb, &scale)
}

/// One resize: source and target size, pixel layout and kernel.
struct Scale {
    from: Dimensions,
    to: Dimensions,
    pixel: PixelType,
    filter: FilterType,
}

fn resize(pixels: Vec<u8>, scale: &Scale) -> Result<Vec<u8>, PlatformError> {
    let (from, to) = (scale.from, scale.to);
    let source = Image::from_vec_u8(from.width, from.height, pixels, scale.pixel)
        .map_err(|e| PlatformError::os("resize input", e))?;
    let mut dest = Image::new(to.width, to.height, scale.pixel);
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(scale.filter));
    Resizer::new()
        .resize(&source, &mut dest, &options)
        .map_err(|e| PlatformError::os("resize", e))?;
    Ok(dest.into_vec())
}

/// libwebp lossy at [`QUALITY`], `method` 4, no alpha: what sharp's
/// `.webp({ quality: 82 })` asks libvips for.
fn encode_webp(rgb: &[u8], size: Dimensions) -> Result<Vec<u8>, PlatformError> {
    if size.is_empty() || size.width > WEBP_MAX_DIMENSION || size.height > WEBP_MAX_DIMENSION {
        return Err(PlatformError::os(
            "webp encode",
            format!(
                "{}x{} is outside what WebP can hold",
                size.width, size.height
            ),
        ));
    }
    let expected = usize::try_from(size.width)
        .ok()
        .zip(usize::try_from(size.height).ok())
        .and_then(|(w, h)| w.checked_mul(h))
        .and_then(|px| px.checked_mul(3));
    if expected != Some(rgb.len()) {
        return Err(PlatformError::os(
            "webp encode",
            format!(
                "{} bytes are not a {}x{} RGB image",
                rgb.len(),
                size.width,
                size.height
            ),
        ));
    }
    let mut config =
        WebPConfig::new().map_err(|()| PlatformError::os("webp config", "init failed"))?;
    config.quality = f32::from(QUALITY);
    config.method = WEBP_METHOD;
    let memory = Encoder::from_rgb(rgb, size.width, size.height)
        .encode_advanced(&config)
        .map_err(|e| PlatformError::os("webp encode", format!("{e:?}")))?;
    Ok(memory.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A smooth test frame: BGRA pixels with a diagonal gradient.
    fn gradient(width: u32, height: u32) -> RawFrame {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                let r = u8::try_from((x * 255) / width.max(1)).unwrap_or(255);
                let g = u8::try_from((y * 255) / height.max(1)).unwrap_or(255);
                data.extend_from_slice(&[128, g, r, 0]);
            }
        }
        RawFrame::new(Dimensions::new(width, height), data).unwrap()
    }

    fn webp_size(bytes: &[u8]) -> (u32, u32) {
        let image = webp::Decoder::new(bytes).decode().unwrap();
        (image.width(), image.height())
    }

    #[test]
    fn a_small_frame_is_enlarged_like_chromiums_thumbnailer() {
        let out = encode_frame(gradient(320, 180)).unwrap().unwrap();
        assert_eq!(out.size, Dimensions::new(2560, 1440));
        assert_eq!(webp_size(&out.webp), (2560, 1440));
    }

    #[test]
    fn a_big_frame_is_reduced_to_the_cap() {
        let out = encode_frame(gradient(5120, 2880)).unwrap().unwrap();
        assert_eq!(out.size, Dimensions::new(2560, 1440));
        assert_eq!(webp_size(&out.webp), (2560, 1440));
    }

    #[test]
    fn the_output_is_a_lossy_webp_riff_container() {
        let out = encode_frame(gradient(64, 64)).unwrap().unwrap();
        assert_eq!(out.webp.get(..4), Some(&b"RIFF"[..]));
        assert_eq!(out.webp.get(8..12), Some(&b"WEBP"[..]));
        assert_eq!(out.webp.get(12..16), Some(&b"VP8 "[..]), "lossy, not VP8L");
    }

    #[test]
    fn an_empty_frame_is_reported_empty_not_an_error() {
        let frame = RawFrame::new(Dimensions::new(0, 0), Vec::new()).unwrap();
        assert!(encode_frame(frame).unwrap().is_none());
    }

    #[test]
    fn the_sharp_stage_keeps_a_fitting_image_and_caps_a_large_one() {
        let small = vec![200; 100 * 50 * 3];
        let bytes = encode_rgb_like_sharp(small, Dimensions::new(100, 50), MAX_EDGE).unwrap();
        assert_eq!(webp_size(&bytes), (100, 50));
        let large = vec![90; 3000 * 1000 * 3];
        let bytes = encode_rgb_like_sharp(large, Dimensions::new(3000, 1000), MAX_EDGE).unwrap();
        assert_eq!(webp_size(&bytes), (2560, 853));
    }

    #[test]
    fn a_buffer_of_the_wrong_length_is_an_error_not_a_panic() {
        assert!(encode_rgb_like_sharp(vec![0; 10], Dimensions::new(4, 4), MAX_EDGE).is_err());
        assert!(encode_webp(&[], Dimensions::new(0, 0)).is_err());
        assert!(encode_webp(&[0; 3], Dimensions::new(20_000, 1)).is_err());
    }
}
