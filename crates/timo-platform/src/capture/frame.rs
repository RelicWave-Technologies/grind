//! Raw pixels as the OS hands them over, and the byte shuffling to get them into
//! the shape the encoder reads.
//!
//! Both macOS (`CGDisplayCreateImage`: little-endian 32-bit, alpha first) and
//! Windows (GDI `BI_RGB` DIB) give **B, G, R, A** bytes per pixel, top row first.
//! Neither captures a real alpha channel, so it is dropped before encoding.

use super::size::Dimensions;
use crate::PlatformError;

/// One display's pixels: `width * height` pixels of B, G, R, A, top row first,
/// rows packed with no padding.
#[derive(Debug)]
pub struct RawFrame {
    size: Dimensions,
    bgra: Vec<u8>,
}

impl RawFrame {
    /// Wrap tightly packed BGRA pixels. The length must be exactly
    /// `width * height * 4`.
    pub fn new(size: Dimensions, bgra: Vec<u8>) -> Result<Self, PlatformError> {
        if bgra.len() == byte_len(size)? {
            Ok(Self { size, bgra })
        } else {
            Err(PlatformError::os(
                "raw frame",
                format!(
                    "{} bytes do not make a {}x{} BGRA frame",
                    bgra.len(),
                    size.width,
                    size.height
                ),
            ))
        }
    }

    /// Take `size.height` rows of `size.width` pixels out of a buffer whose rows
    /// are `stride` bytes apart (the OS pads rows to an alignment). An unpadded
    /// buffer is reused as is; a padded one is copied row by row.
    pub fn from_strided(
        size: Dimensions,
        stride: usize,
        mut data: Vec<u8>,
    ) -> Result<Self, PlatformError> {
        let row = row_len(size)?;
        let height = usize::try_from(size.height).map_err(|e| PlatformError::os("frame", e))?;
        if stride < row || data.len() < stride.saturating_mul(height.saturating_sub(1)) + row {
            return Err(PlatformError::os(
                "raw frame",
                format!(
                    "stride {stride} / {} bytes cannot hold {}x{}",
                    data.len(),
                    size.width,
                    size.height
                ),
            ));
        }
        if stride == row {
            data.truncate(byte_len(size)?);
            return Self::new(size, data);
        }
        let mut bgra = Vec::with_capacity(byte_len(size)?);
        for chunk in data.chunks(stride).take(height) {
            bgra.extend_from_slice(chunk.get(..row).unwrap_or_default());
        }
        Self::new(size, bgra)
    }

    #[must_use]
    pub fn size(&self) -> Dimensions {
        self.size
    }

    #[must_use]
    pub fn bgra(&self) -> &[u8] {
        &self.bgra
    }

    /// Give the pixels back (to resize in place of a copy).
    #[must_use]
    pub fn into_bgra(self) -> Vec<u8> {
        self.bgra
    }
}

fn row_len(size: Dimensions) -> Result<usize, PlatformError> {
    usize::try_from(size.width)
        .ok()
        .and_then(|w| w.checked_mul(4))
        .ok_or_else(|| PlatformError::os("raw frame", "row length overflows"))
}

fn byte_len(size: Dimensions) -> Result<usize, PlatformError> {
    let height = usize::try_from(size.height).map_err(|e| PlatformError::os("raw frame", e))?;
    row_len(size)?
        .checked_mul(height)
        .ok_or_else(|| PlatformError::os("raw frame", "frame length overflows"))
}

/// Swap the B and R bytes of packed 32-bit BGRA pixels in place, so the buffer
/// reads as RGBA, and hand the buffer back. Green and alpha are untouched, and
/// so are any trailing bytes that do not make a whole pixel.
///
/// Port of `legacy/agent/src/main/services/capture/capture.ts::bgraToRgbaInPlace`
/// (which does the same with one pass over little-endian `Uint32` words:
/// keep A and G, exchange R and B).
pub fn bgra_to_rgba_in_place(bmp: &mut [u8]) -> &mut [u8] {
    for px in bmp.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    bmp
}

/// BGRA to packed RGB: the same swap legacy does followed by sharp's
/// `removeAlpha()`, in one pass and without touching the source. Trailing bytes
/// that do not make a whole pixel are ignored.
#[must_use]
pub fn bgra_to_rgb(bgra: &[u8]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(bgra.len() / 4 * 3);
    for px in bgra.chunks_exact(4) {
        if let [b, g, r, _alpha] = *px {
            rgb.extend_from_slice(&[r, g, b]);
        }
    }
    rgb
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ports of legacy `bitmap.test.ts` (3 cases, same names).

    #[test]
    fn swaps_the_blue_and_red_bytes_while_leaving_green_and_alpha_alone() {
        // One pixel, BGRA: B=0x10 G=0x20 R=0x30 A=0x40
        let mut bmp = [0x10, 0x20, 0x30, 0x40];
        assert_eq!(bgra_to_rgba_in_place(&mut bmp), &[0x30, 0x20, 0x10, 0x40]);
    }

    #[test]
    fn round_trips_known_colours_through_the_encoder_input_exactly_as_the_capture_path_does() {
        // What the OS would hand us for red, green, blue: B,G,R,A per pixel.
        let original = [
            0, 0, 255, 255, // red
            0, 255, 0, 255, // green
            255, 0, 0, 255, // blue
        ];
        let expected = [255, 0, 0, 0, 255, 0, 0, 0, 255];

        // Legacy: swap in place, then sharp's `removeAlpha().raw()` keeps the
        // first three bytes of each RGBA pixel.
        let mut swapped = original;
        let dropped: Vec<u8> = bgra_to_rgba_in_place(&mut swapped)
            .chunks_exact(4)
            .flat_map(|px| px.iter().copied().take(3))
            .collect();
        assert_eq!(dropped, expected);

        // The one-step conversion the encoder uses must give the same colours.
        assert_eq!(bgra_to_rgb(&original), expected);
    }

    #[test]
    fn handles_a_buffer_with_a_non_zero_byte_offset() {
        // Legacy slices a pooled `Buffer`; the Rust equivalent is a sub-slice of
        // a larger allocation. The neighbours must not be touched.
        let mut backing = [0u8; 12];
        backing
            .get_mut(4..8)
            .unwrap_or_default()
            .copy_from_slice(&[0x10, 0x20, 0x30, 0x40]);
        bgra_to_rgba_in_place(backing.get_mut(4..8).unwrap_or_default());
        assert_eq!(backing.get(4..8), Some(&[0x30, 0x20, 0x10, 0x40][..]));
        assert_eq!(backing.get(..4), Some(&[0, 0, 0, 0][..]));
        assert_eq!(backing.get(8..), Some(&[0, 0, 0, 0][..]));
    }

    #[test]
    fn a_partial_trailing_pixel_is_left_alone() {
        let mut bmp = [1, 2, 3, 4, 9, 8];
        bgra_to_rgba_in_place(&mut bmp);
        assert_eq!(bmp, [3, 2, 1, 4, 9, 8]);
        assert_eq!(bgra_to_rgb(&[1, 2, 3, 4, 9, 8]), [3, 2, 1]);
    }

    #[test]
    fn a_frame_must_be_exactly_width_times_height_pixels() {
        let size = Dimensions::new(2, 2);
        assert!(RawFrame::new(size, vec![0; 16]).is_ok());
        assert!(RawFrame::new(size, vec![0; 15]).is_err());
        assert!(RawFrame::new(size, vec![0; 20]).is_err());
    }

    #[test]
    fn stride_padding_is_dropped_row_by_row() {
        // 2x2 pixels, 12-byte stride (4 bytes of padding per row).
        let mut data = Vec::new();
        for row in 0..2u8 {
            data.extend_from_slice(&[row, 1, 2, 3, row, 4, 5, 6]);
            data.extend_from_slice(&[0xEE; 4]);
        }
        let frame = RawFrame::from_strided(Dimensions::new(2, 2), 12, data).unwrap();
        assert_eq!(
            frame.bgra(),
            [0, 1, 2, 3, 0, 4, 5, 6, 1, 1, 2, 3, 1, 4, 5, 6]
        );
    }

    #[test]
    fn an_unpadded_buffer_is_taken_without_copying_and_extra_tail_is_cut() {
        let frame =
            RawFrame::from_strided(Dimensions::new(2, 1), 8, vec![1, 2, 3, 4, 5, 6, 7, 8, 9])
                .unwrap();
        assert_eq!(frame.bgra(), [1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn a_buffer_too_short_for_the_stride_is_refused() {
        assert!(RawFrame::from_strided(Dimensions::new(2, 2), 8, vec![0; 15]).is_err());
        assert!(RawFrame::from_strided(Dimensions::new(2, 2), 4, vec![0; 16]).is_err());
    }
}
