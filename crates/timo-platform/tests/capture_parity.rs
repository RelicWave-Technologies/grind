//! The screenshot pipeline against golden output from the real legacy code and
//! the real sharp (0.33.5: libvips 8.15.3, libwebp 1.4.0), written by
//! `parity/src/captureFixtures.ts` into `tests/fixtures/capture/`.
//!
//! Three things are held to the oracle:
//!
//! * `bgraToRgbaInPlace`: byte for byte, 208 cases.
//! * sharp's `resize({ fit: 'inside', withoutEnlargement: true })` output size:
//!   exactly, 280 sizes.
//! * the whole sharp half (`removeAlpha` → resize → `webp({ quality: 82 })`) on
//!   seven source frames: the output size exactly and the quality setting the
//!   same, then how close the pixels are. When the source already fits (no
//!   resize) the same libwebp with the same settings should give the same file;
//!   when sharp has to resize, the kernels differ and only a similarity score can
//!   say they agree. Both numbers are printed (`--nocapture`).
#![allow(
    clippy::print_stdout,
    clippy::float_arithmetic,
    clippy::too_many_lines,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::many_single_char_names,
    reason = "a parity report prints its measurements; PSNR/SSIM are float maths with the textbook names; \
              the helpers outside #[test] fns fail loudly on bad fixtures by design"
)]

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use timo_platform::capture::encode::encode_rgb_like_sharp;
use timo_platform::capture::frame::bgra_to_rgba_in_place;
use timo_platform::capture::size::{Dimensions, MAX_EDGE, QUALITY, sharp_inside_size};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/capture")
}

fn json(name: &str) -> Value {
    serde_json::from_slice(&fs::read(fixtures().join(name)).unwrap()).unwrap()
}

fn num(v: &Value) -> u32 {
    u32::try_from(v.as_u64().unwrap()).unwrap()
}

#[test]
fn bgra_to_rgba_in_place_matches_the_legacy_function() {
    let fixture = json("bgra_to_rgba_in_place.json");
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 200);
    for case in cases {
        let bytes = |v: &Value| -> Vec<u8> {
            v.as_array()
                .unwrap()
                .iter()
                .map(|b| u8::try_from(b.as_u64().unwrap()).unwrap())
                .collect()
        };
        let mut input = bytes(&case["input"]["bytes"]);
        bgra_to_rgba_in_place(&mut input);
        assert_eq!(input, bytes(&case["output"]), "input {:?}", case["input"]);
    }
}

#[test]
fn sharp_inside_size_matches_sharp() {
    let fixture = json("sharp_inside_size.json");
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 250);
    for case in cases {
        let input = &case["input"];
        let frame = Dimensions::new(num(&input["width"]), num(&input["height"]));
        let want = Dimensions::new(
            num(&case["output"]["width"]),
            num(&case["output"]["height"]),
        );
        assert_eq!(
            sharp_inside_size(frame, num(&input["edge"])),
            want,
            "{input}"
        );
    }
}

fn decode_png(path: &Path) -> (Dimensions, Vec<u8>) {
    let decoder = png::Decoder::new(std::io::Cursor::new(fs::read(path).unwrap()));
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgb, "fixture PNGs are RGB");
    buf.truncate(info.buffer_size());
    (Dimensions::new(info.width, info.height), buf)
}

fn decode_webp(bytes: &[u8]) -> (Dimensions, Vec<u8>) {
    let image = webp::Decoder::new(bytes).decode().unwrap();
    (
        Dimensions::new(image.width(), image.height()),
        image.to_vec(),
    )
}

fn psnr(a: &[u8], b: &[u8]) -> f64 {
    let sum: f64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| {
            let d = f64::from(*x) - f64::from(*y);
            d * d
        })
        .sum();
    if sum == 0.0 {
        return f64::INFINITY;
    }
    let mse = sum / f64::from(u32::try_from(a.len()).unwrap());
    10.0 * (255.0_f64 * 255.0 / mse).log10()
}

/// Luma (BT.601) of packed RGB.
fn luma(rgb: &[u8]) -> Vec<f64> {
    rgb.chunks_exact(3)
        .map(|p| 0.299 * f64::from(p[0]) + 0.587 * f64::from(p[1]) + 0.114 * f64::from(p[2]))
        .collect()
}

/// Mean SSIM over non-overlapping 8x8 luma windows (constants of Wang et al.).
fn ssim(a: &[u8], b: &[u8], size: Dimensions) -> f64 {
    let (la, lb) = (luma(a), luma(b));
    let (w, h) = (
        usize::try_from(size.width).unwrap(),
        usize::try_from(size.height).unwrap(),
    );
    let (c1, c2) = ((0.01_f64 * 255.0).powi(2), (0.03_f64 * 255.0).powi(2));
    let (mut total, mut windows) = (0.0, 0_u32);
    for y0 in (0..h.saturating_sub(7)).step_by(8) {
        for x0 in (0..w.saturating_sub(7)).step_by(8) {
            let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for y in y0..y0 + 8 {
                for x in x0..x0 + 8 {
                    let (p, q) = (la[y * w + x], lb[y * w + x]);
                    sa += p;
                    sb += q;
                    saa += p * p;
                    sbb += q * q;
                    sab += p * q;
                }
            }
            let (ma, mb) = (sa / 64.0, sb / 64.0);
            let (va, vb, cov) = (
                saa / 64.0 - ma * ma,
                sbb / 64.0 - mb * mb,
                sab / 64.0 - ma * mb,
            );
            total += ((2.0 * ma * mb + c1) * (2.0 * cov + c2))
                / ((ma * ma + mb * mb + c1) * (va + vb + c2));
            windows += 1;
        }
    }
    total / f64::from(windows.max(1))
}

#[test]
fn the_whole_sharp_half_agrees_with_sharp_on_seven_frames() {
    let meta = json("images.json");
    assert_eq!(
        num(&meta["quality"]),
        u32::from(QUALITY),
        "the quality setting is sharp's 82"
    );
    assert_eq!(num(&meta["maxEdge"]), MAX_EDGE);
    println!(
        "{:<16} {:>11} {:>11} {:>11} {:>8} {:>8} {:>9} {:>8}",
        "image", "source", "sharp out", "ours", "sharp B", "ours B", "PSNR dB", "SSIM"
    );
    for image in meta["images"].as_array().unwrap() {
        let name = image["name"].as_str().unwrap();
        let (size, rgb) = decode_png(&fixtures().join(format!("images/{name}.png")));
        assert_eq!(
            (size.width, size.height),
            (num(&image["width"]), num(&image["height"]))
        );

        let ours = encode_rgb_like_sharp(rgb, size, MAX_EDGE).unwrap();
        let golden = fs::read(fixtures().join(format!("images/{name}.sharp.webp"))).unwrap();
        let want = Dimensions::new(num(&image["webpWidth"]), num(&image["webpHeight"]));
        let (our_size, our_px) = decode_webp(&ours);
        let (golden_size, golden_px) = decode_webp(&golden);
        assert_eq!(our_size, want, "{name}: output size");
        assert_eq!(golden_size, want, "{name}: the fixture's own size");

        let resized = want != size;
        let (db, similarity) = (psnr(&our_px, &golden_px), ssim(&our_px, &golden_px, want));
        println!(
            "{name:<16} {:>5}x{:<5} {:>5}x{:<5} {:>5}x{:<5} {:>8} {:>8} {:>9.2} {:>8.5}{}",
            size.width,
            size.height,
            want.width,
            want.height,
            our_size.width,
            our_size.height,
            golden.len(),
            ours.len(),
            db,
            similarity,
            if ours == golden {
                "  BYTE-IDENTICAL"
            } else if resized {
                "  (resized)"
            } else {
                ""
            },
        );
        // Same pixels in, same size out: the encoder settings are the same, so
        // the files should be (near) the same. A resize moves values by a few
        // levels through a different kernel, so it gets a looser bar.
        let (min_db, min_ssim) = if resized { (40.0, 0.99) } else { (45.0, 0.995) };
        assert!(db >= min_db, "{name}: PSNR {db:.2} dB < {min_db}");
        assert!(
            similarity >= min_ssim,
            "{name}: SSIM {similarity:.5} < {min_ssim}"
        );
    }
}
