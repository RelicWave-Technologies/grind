//! macOS hardware tests: they need a logged-in GUI session and the terminal (or
//! the test binary's responsible app) to have Input Monitoring *and* Accessibility
//! (Accessibility is what lets `CGEventPost` inject the synthetic events).
//!
//! ```text
//! cargo test -p timo-platform --test hardware_mac -- --ignored --nocapture --test-threads=1
//! ```
//!
//! The synthetic input is chosen to be harmless: F19 (no default binding), a button
//! 9 "other mouse" press/release, a 1-line scroll, and a 12 px pointer nudge that is
//! put back. Nothing is typed into your windows.
#![cfg(target_os = "macos")]
#![allow(
    unsafe_code,
    clippy::print_stdout,
    clippy::float_arithmetic,
    reason = "hardware tests inject real OS events through raw CoreGraphics"
)]

use std::ffi::c_void;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use timo_platform::input::{InputEvent, InputListener};

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> *mut c_void;
    fn CGEventCreateMouseEvent(
        source: *const c_void,
        kind: u32,
        at: CGPoint,
        button: u32,
    ) -> *mut c_void;
    fn CGEventCreateScrollWheelEvent2(
        source: *const c_void,
        units: u32,
        count: u32,
        w1: i32,
        w2: i32,
        w3: i32,
    ) -> *mut c_void;
    fn CGEventSetIntegerValueField(event: *mut c_void, field: u32, value: i64);
    fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
    fn CGEventPost(tap: u32, event: *mut c_void);
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
}

const HID_TAP: u32 = 0;
const MOUSE_MOVED: u32 = 5;
const OTHER_MOUSE_DOWN: u32 = 25;
const OTHER_MOUSE_UP: u32 = 26;
const BUTTON_NUMBER_FIELD: u32 = 3;
const KEY_F19: u16 = 80;

fn post(event: *mut c_void) {
    // SAFETY: `event` was just created by CoreGraphics; it is posted once and released.
    unsafe {
        CGEventPost(HID_TAP, event);
        CFRelease(event);
    }
    std::thread::sleep(Duration::from_millis(60));
}

fn pointer() -> CGPoint {
    // SAFETY: CGEventCreate(NULL) returns a fresh event carrying the current pointer location.
    unsafe {
        let probe = CGEventCreate(std::ptr::null());
        let at = CGEventGetLocation(probe);
        CFRelease(probe);
        at
    }
}

fn move_to(at: CGPoint) {
    // SAFETY: a plain mouse-moved event at a screen point.
    post(unsafe { CGEventCreateMouseEvent(std::ptr::null(), MOUSE_MOVED, at, 0) });
}

fn other_button(kind: u32, at: CGPoint) {
    // SAFETY: button 9 is an extra button with no default action; the field write targets that same event.
    let event = unsafe {
        let event = CGEventCreateMouseEvent(std::ptr::null(), kind, at, 2);
        CGEventSetIntegerValueField(event, BUTTON_NUMBER_FIELD, 9);
        event
    };
    post(event);
}

#[test]
#[ignore = "needs a GUI session with Input Monitoring + Accessibility; see the file header"]
fn synthetic_input_is_counted_exactly_as_legacy_would_count_it() {
    let seen = Arc::new(Mutex::new(Vec::<InputEvent>::new()));
    let sink_seen = Arc::clone(&seen);
    let mut listener = InputListener::start(Arc::new(move |e: InputEvent| {
        if let Ok(mut v) = sink_seen.lock() {
            v.push(e);
        }
    }))
    .expect("listener starts (Input Monitoring granted?)");
    std::thread::sleep(Duration::from_millis(300));

    // A human using the machine adds real events to the stream, so exact counts are
    // only asserted when the machine has been untouched for a few seconds.
    let hands_off = timo_platform::idle::system_idle_seconds().is_ok_and(|s| s >= 3);
    // TIMO_SKIP_KEY=1 leaves the key out, for running uiohook-napi under plain Node alongside
    // (its macOS key path needs the AppKit main queue and hangs without it).
    let with_key = std::env::var_os("TIMO_SKIP_KEY").is_none();
    inject_synthetic_input(with_key);
    std::thread::sleep(Duration::from_millis(300));
    listener.stop();

    let events = seen.lock().expect("sink lock").clone();
    assert_counts(&events, with_key, hands_off);
}

/// F19 down/up (optional), a one-line scroll, an extra-button press/release, and a
/// 12 px pointer nudge that is put back.
fn inject_synthetic_input(with_key: bool) {
    let home = pointer();
    // SAFETY: F19 and a one-line scroll are harmless synthetic events.
    unsafe {
        if with_key {
            post(CGEventCreateKeyboardEvent(std::ptr::null(), KEY_F19, true));
            post(CGEventCreateKeyboardEvent(std::ptr::null(), KEY_F19, false));
        }
        post(CGEventCreateScrollWheelEvent2(
            std::ptr::null(),
            1,
            1,
            1,
            0,
            0,
        ));
    }
    other_button(OTHER_MOUSE_DOWN, home);
    other_button(OTHER_MOUSE_UP, home);
    move_to(CGPoint {
        x: home.x + 12.0,
        y: home.y,
    });
    move_to(home);
}

/// F19 down counts once, up never; one scroll; an extra button's press AND release
/// both count (libuiohook quirk, PARITY.md #1); at least the two pointer nudges.
fn assert_counts(events: &[InputEvent], with_key: bool, hands_off: bool) {
    let count = |p: fn(&InputEvent) -> bool| events.iter().filter(|e| p(e)).count();
    let keys = count(|e| matches!(e, InputEvent::KeyDown));
    let wheels = count(|e| matches!(e, InputEvent::Wheel));
    let downs = count(|e| matches!(e, InputEvent::MouseDown));
    let moves = count(|e| matches!(e, InputEvent::MouseMove { .. }));
    println!("hands_off={hands_off} keys={keys} wheels={wheels} mouse_downs={downs} moves={moves}");
    if hands_off {
        assert_eq!(
            keys,
            usize::from(with_key),
            "F19 down counts once, up never"
        );
        assert_eq!(wheels, 1, "one scroll event");
        assert_eq!(downs, 2, "other-button press and release both count");
    } else {
        assert!(
            keys >= usize::from(with_key) && wheels >= 1 && downs >= 2,
            "machine was in use; counts can only be higher"
        );
    }
    assert!(moves >= 2, "at least the two nudges");
}

#[test]
#[ignore = "needs a GUI session with Input Monitoring; see the file header"]
fn stop_is_clean_and_listener_can_restart() {
    for round in 0..3 {
        let mut listener = InputListener::start(Arc::new(|_: InputEvent| {}))
            .unwrap_or_else(|e| panic!("round {round}: {e}"));
        assert!(listener.status().running);
        listener.stop();
        assert!(!listener.status().running);
    }
}

#[test]
#[ignore = "needs a GUI session; see the file header"]
fn a_second_listener_is_refused() {
    let first = InputListener::start(Arc::new(|_: InputEvent| {})).expect("first starts");
    let second = InputListener::start(Arc::new(|_: InputEvent| {}));
    assert!(matches!(
        second,
        Err(timo_platform::PlatformError::AlreadyRunning(_))
    ));
    drop(first);
    assert!(
        InputListener::start(Arc::new(|_: InputEvent| {})).is_ok(),
        "restart after drop works"
    );
}

#[test]
#[ignore = "registers with IOKit/AppKit notification centres; run in the foreground (see header)"]
fn power_monitor_registers_stops_and_restarts_cleanly() {
    use timo_platform::idle::{IdleState, system_idle_state};
    use timo_platform::power::{PowerEvent, PowerMonitor};

    let seen = Arc::new(Mutex::new(Vec::<PowerEvent>::new()));
    for round in 0..3 {
        let sink_seen = Arc::clone(&seen);
        let started = std::time::Instant::now();
        let mut monitor = PowerMonitor::start(Arc::new(move |e: PowerEvent| {
            if let Ok(mut v) = sink_seen.lock() {
                v.push(e);
            }
        }))
        .unwrap_or_else(|e| panic!("round {round}: {e}"));
        let start_took = started.elapsed();
        std::thread::sleep(Duration::from_millis(400));
        let state = system_idle_state(3600).expect("idle state");
        assert_eq!(state, IdleState::Active, "nothing is locked and idle < 1 h");
        let stopped = std::time::Instant::now();
        monitor.stop();
        println!(
            "round {round}: start {start_took:?}, stop {:?}",
            stopped.elapsed()
        );
    }
    // No power event happens on its own while this runs.
    assert!(
        seen.lock().expect("lock").is_empty(),
        "spurious power events: {:?}",
        seen.lock().expect("lock")
    );
}
