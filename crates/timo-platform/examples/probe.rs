//! Live probe: prints idle time, permission states, and — for N seconds — input
//! counts and power/session events as the OS delivers them.
//!
//! ```text
//! cargo run -p timo-platform --example probe -- 15
//! ```
//!
//! Type, click, move the mouse and scroll while it runs. To see power events,
//! lock the screen (Ctrl+Cmd+Q on macOS, Win+L on Windows) or sleep the machine.
//!
//! macOS: the *terminal* you run this from needs Input Monitoring
//! (System Settings → Privacy & Security → Input Monitoring). Without it the
//! probe prints the exact error and shows zero counts — it never fakes numbers.
#![allow(
    clippy::print_stdout,
    clippy::float_arithmetic,
    clippy::too_many_lines,
    reason = "a probe exists to print; the distance is a throwaway float sum"
)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use timo_platform::idle::{IdleState, system_idle_seconds, system_idle_state};
use timo_platform::input::{InputEvent, InputListener, MoveThrottle};
use timo_platform::permissions::{self, ScreenStatus};
use timo_platform::power::{PowerEvent, PowerMonitor};

#[derive(Default)]
struct Counts {
    keys: AtomicU64,
    clicks: AtomicU64,
    moves_raw: AtomicU64,
    moves_throttled: AtomicU64,
    scrolls: AtomicU64,
    distance_px: Mutex<(f64, Option<(i16, i16)>)>,
}

fn main() {
    let seconds: u64 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(10);
    println!(
        "timo-platform probe — {seconds}s on {}",
        std::env::consts::OS
    );

    println!("-- idle");
    println!("system_idle_seconds   = {:?}", system_idle_seconds());
    println!(
        "system_idle_state(30) = {:?}",
        system_idle_state(30).map(IdleState::as_str)
    );
    println!(
        "system_idle_state(0)  = {:?}",
        system_idle_state(0).map(IdleState::as_str)
    );

    println!("-- permissions");
    println!(
        "accessibility_trusted(false) = {:?}",
        permissions::accessibility_trusted(false)
    );
    println!(
        "input_monitoring_granted     = {:?}",
        permissions::input_monitoring_granted()
    );
    println!(
        "screen_recording_granted     = {:?}",
        permissions::screen_recording_granted()
    );
    println!(
        "screen_status                = {:?}",
        permissions::screen_status().map(ScreenStatus::as_str)
    );

    let (power_tx, power_rx) = mpsc::channel::<(Instant, PowerEvent)>();
    let power_tx = Mutex::new(power_tx);
    let power = PowerMonitor::start(Arc::new(move |event: PowerEvent| {
        if let Ok(tx) = power_tx.lock() {
            tx.send((Instant::now(), event)).ok();
        }
    }));
    println!(
        "-- power monitor start: {}",
        power
            .as_ref()
            .map_or_else(|e| format!("FAILED: {e}"), |_| "ok".into())
    );

    let counts = Arc::new(Counts::default());
    let started = Instant::now();
    let sink_counts = Arc::clone(&counts);
    let throttle = Mutex::new(MoveThrottle::new());
    let listener = InputListener::start(Arc::new(move |event: InputEvent| match event {
        InputEvent::KeyDown => {
            sink_counts.keys.fetch_add(1, Ordering::Relaxed);
        }
        InputEvent::MouseDown => {
            sink_counts.clicks.fetch_add(1, Ordering::Relaxed);
        }
        InputEvent::Wheel => {
            sink_counts.scrolls.fetch_add(1, Ordering::Relaxed);
        }
        InputEvent::MouseMove { x, y } => {
            sink_counts.moves_raw.fetch_add(1, Ordering::Relaxed);
            let now_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
            let admitted = throttle.lock().is_ok_and(|mut t| t.admit(now_ms));
            if admitted {
                sink_counts.moves_throttled.fetch_add(1, Ordering::Relaxed);
                if let Ok(mut d) = sink_counts.distance_px.lock() {
                    if let Some((px, py)) = d.1 {
                        d.0 += f64::from(x - px).hypot(f64::from(y - py));
                    }
                    d.1 = Some((x, y));
                }
            }
        }
    }));
    match &listener {
        Ok(l) => println!("-- input listener start: ok, status {:?}", l.status()),
        Err(e) => println!("-- input listener start: FAILED: {e}"),
    }

    let deadline = started + Duration::from_secs(seconds);
    let mut next_tick = started + Duration::from_secs(1);
    while Instant::now() < deadline {
        while let Ok((at, event)) = power_rx.try_recv() {
            println!(
                "[{:6.2}s] POWER EVENT {:?} ({})",
                at.duration_since(started).as_secs_f64(),
                event,
                event.electron_name()
            );
        }
        if Instant::now() >= next_tick {
            next_tick += Duration::from_secs(1);
            let d = counts.distance_px.lock().map_or(0.0, |d| d.0);
            println!(
                "[{:6.2}s] keys={} clicks={} moves(raw/throttled)={}/{} scroll={} dist={:.0}px idle={:?}s",
                started.elapsed().as_secs_f64(),
                counts.keys.load(Ordering::Relaxed),
                counts.clicks.load(Ordering::Relaxed),
                counts.moves_raw.load(Ordering::Relaxed),
                counts.moves_throttled.load(Ordering::Relaxed),
                counts.scrolls.load(Ordering::Relaxed),
                d,
                system_idle_seconds().ok(),
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    if let Ok(mut l) = listener {
        println!("-- status before stop: {:?}", l.status());
        let stop_started = Instant::now();
        l.stop();
        println!(
            "-- stop took {:?}; status after: {:?}",
            stop_started.elapsed(),
            l.status()
        );
    }
    drop(power);
    while let Ok((_, event)) = power_rx.try_recv() {
        println!("POWER EVENT (late) {event:?}");
    }
    println!("-- done");
}
