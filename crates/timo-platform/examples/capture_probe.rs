//! Live probe for screenshot capture: captures every display on this machine,
//! prints the sizes, bytes, timings and health, and writes the results for you
//! to look at.
//!
//! ```text
//! cargo run -p timo-platform --example capture_probe -- /tmp/timo-d7b
//! ```
//!
//! Under `<dir>` it writes `screenshots/<UTC day>/<id>.webp` (the production
//! layout, mode 0600) and a `.png` copy of each so a viewer that cannot open WebP
//! can. macOS: the *terminal* you run this from needs Screen Recording
//! (System Settings → Privacy & Security → Screen & System Audio Recording).
//! Without it the probe says so; it never invents an image.
#![allow(
    clippy::print_stdout,
    clippy::float_arithmetic,
    clippy::too_many_lines,
    reason = "a probe exists to print; one linear script reads best; epoch seconds to ms is a throwaway float"
)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use timo_platform::capture::{self, CaptureHealth, encode, probe_screen_capture};
use timo_platform::permissions;

fn ms(d: Duration) -> u128 {
    d.as_millis()
}

fn main() {
    let dir = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| "/tmp/timo-d7b".to_owned()),
    );
    println!("timo-platform capture probe on {}", std::env::consts::OS);
    println!(
        "screen_status = {:?}",
        permissions::screen_status().map(permissions::ScreenStatus::as_str)
    );

    let t = Instant::now();
    println!(
        "probe_screen_capture() = {} ({} ms)",
        probe_screen_capture().as_str(),
        ms(t.elapsed())
    );

    let t = Instant::now();
    let displays = match capture::grab_displays() {
        Ok(displays) => displays,
        Err(error) => {
            println!("grab_displays failed: {error}");
            return;
        }
    };
    println!(
        "grab: {} display(s) in {} ms",
        displays.len(),
        ms(t.elapsed())
    );

    // Same instant for every file name, like one capture tick.
    let captured_at = now_ms();
    for (index, display) in displays.into_iter().enumerate() {
        let Some(frame) = display.frame else {
            println!("display {}: BLANK (empty thumbnail)", display.display_id);
            continue;
        };
        let native = frame.size();
        let t = Instant::now();
        let Ok(Some(done)) = encode::encode_frame(frame) else {
            println!("display {}: encode failed or empty", display.display_id);
            continue;
        };
        let encode_ms = ms(t.elapsed());
        let id = format!("probe{index}-d{}", display.display_id);
        let path = write(&dir, captured_at, &id, &done.webp);
        println!(
            "display {}: native {}x{} -> stored {}x{}, {} bytes, encode {} ms\n  {}",
            display.display_id,
            native.width,
            native.height,
            done.size.width,
            done.size.height,
            done.webp.len(),
            encode_ms,
            path.display()
        );
        write_png(&path, &done.webp);
    }

    let t = Instant::now();
    match capture::capture_now(true) {
        Ok(result) => println!(
            "capture_now(force): {} shot(s), health = {} ({} ms end to end)",
            result.shots.len(),
            result.health.as_str(),
            ms(t.elapsed())
        ),
        Err(error) => println!("capture_now failed: {error}"),
    }
    println!(
        "capture_now(no force) health = {}",
        capture::capture_now(false)
            .map_or(CaptureHealth::Error, |r| r.health)
            .as_str()
    );
}

fn now_ms() -> f64 {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    since.as_secs_f64() * 1000.0
}

fn write(dir: &Path, captured_at: f64, id: &str, webp: &[u8]) -> PathBuf {
    match capture::write_screenshot(dir, captured_at, id, webp) {
        Ok(path) => path,
        Err(error) => {
            println!("write failed: {error}");
            PathBuf::new()
        }
    }
}

/// Decode the WebP we just wrote and save it as a PNG next to it.
fn write_png(webp_path: &Path, webp: &[u8]) {
    let Some(image) = webp::Decoder::new(webp).decode() else {
        println!("  (could not decode back for the PNG copy)");
        return;
    };
    let png_path = webp_path.with_extension("png");
    let Ok(file) = std::fs::File::create(&png_path) else {
        return;
    };
    let mut encoder = png::Encoder::new(file, image.width(), image.height());
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    if let Ok(mut writer) = encoder.write_header()
        && let Err(error) = writer.write_image_data(&image)
    {
        println!("  png write failed: {error}");
    }
    println!("  {}", png_path.display());
}
