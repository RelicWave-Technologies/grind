//! Pure decisions behind input counting: which raw OS events count, and as what.
//!
//! These reproduce what `uiohook-napi` (libuiohook 1.x as bundled in
//! `uiohook-napi@1.5.4`) hands to `legacy/agent/src/main/services/activity/index.ts`,
//! which listens to exactly four JS events: `keydown`, `mousedown`, `wheel`,
//! `mousemove`. Everything is plain data in, plain data out, so it is tested on
//! any host with the OS-specific numbers spelled out below.
//!
//! PRIVACY: key codes are looked at only to decide *whether* an event counts.
//! They never leave this module.

#![cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "each platform uses only its own half; both halves are unit-tested on every host"
    )
)]

use super::InputEvent;

/// `CGEventType` values the macOS tap listens for.
pub(crate) mod cg {
    pub(crate) const LEFT_MOUSE_DOWN: u32 = 1;
    pub(crate) const RIGHT_MOUSE_DOWN: u32 = 3;
    pub(crate) const MOUSE_MOVED: u32 = 5;
    pub(crate) const LEFT_MOUSE_DRAGGED: u32 = 6;
    pub(crate) const RIGHT_MOUSE_DRAGGED: u32 = 7;
    pub(crate) const KEY_DOWN: u32 = 10;
    pub(crate) const FLAGS_CHANGED: u32 = 12;
    /// `NX_SYSDEFINED`: media keys and caps lock. Not a documented `CGEventType`.
    pub(crate) const SYS_DEFINED: u32 = 14;
    pub(crate) const SCROLL_WHEEL: u32 = 22;
    pub(crate) const OTHER_MOUSE_DOWN: u32 = 25;
    pub(crate) const OTHER_MOUSE_UP: u32 = 26;
    pub(crate) const OTHER_MOUSE_DRAGGED: u32 = 27;
    pub(crate) const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    pub(crate) const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
}

/// The `CGEventType`s the tap subscribes to, as a bit mask.
///
/// libuiohook also subscribes to key-up, left/right/other mouse-up (except as
/// below) and the flag/system events; up events never count, so we leave them out.
#[must_use]
pub(crate) fn mac_event_mask() -> u64 {
    [
        cg::KEY_DOWN,
        cg::FLAGS_CHANGED,
        cg::SYS_DEFINED,
        cg::LEFT_MOUSE_DOWN,
        cg::RIGHT_MOUSE_DOWN,
        cg::OTHER_MOUSE_DOWN,
        cg::OTHER_MOUSE_UP,
        cg::MOUSE_MOVED,
        cg::LEFT_MOUSE_DRAGGED,
        cg::RIGHT_MOUSE_DRAGGED,
        cg::OTHER_MOUSE_DRAGGED,
        cg::SCROLL_WHEEL,
    ]
    .iter()
    .fold(0u64, |mask, ty| mask | (1u64 << ty))
}

/// True when macOS has switched the tap off and it must be switched back on.
#[must_use]
pub(crate) fn tap_was_disabled(event_type: u32) -> bool {
    event_type == cg::TAP_DISABLED_BY_TIMEOUT || event_type == cg::TAP_DISABLED_BY_USER_INPUT
}

const FLAG_SHIFT: u64 = 0x0002_0000;
const FLAG_CONTROL: u64 = 0x0004_0000;
const FLAG_ALTERNATE: u64 = 0x0008_0000;
const FLAG_COMMAND: u64 = 0x0010_0000;

/// A modifier key's virtual key code and the flag bit that says it is down.
///
/// Left and right variants share one flag bit, so releasing one shift while the
/// other is held still reports "flag set" — and libuiohook counts that as a press.
const MODIFIER_KEYS: [(i64, u64); 8] = [
    (56, FLAG_SHIFT),     // kVK_Shift
    (60, FLAG_SHIFT),     // kVK_RightShift
    (59, FLAG_CONTROL),   // kVK_Control
    (62, FLAG_CONTROL),   // kVK_RightControl
    (55, FLAG_COMMAND),   // kVK_Command
    (54, FLAG_COMMAND),   // kVK_RightCommand
    (58, FLAG_ALTERNATE), // kVK_Option
    (61, FLAG_ALTERNATE), // kVK_RightOption
];

/// `kCGEventFlagsChanged` → does libuiohook fire a *key pressed* event?
///
/// Port of `process_modifier_changed`: only the eight listed modifier keys, and
/// only when the matching flag bit is set after the change. Caps lock and Fn
/// produce nothing here.
#[must_use]
pub(crate) fn flags_changed_is_press(keycode: i64, flags: u64) -> bool {
    MODIFIER_KEYS
        .iter()
        .any(|&(code, bit)| code == keycode && flags & bit != 0)
}

/// `NX_SUBTYPE_AUX_CONTROL_BUTTONS`: the sub-type of system-defined events that
/// carries media / caps-lock key presses.
const NX_SUBTYPE_AUX_CONTROL_BUTTONS: i64 = 8;

/// `NX_KEYTYPE_*` values libuiohook turns into key events: sound up/down, caps
/// lock, mute, eject, play, and **fast / rewind** (19 / 20) — not next /
/// previous (17 / 18), which it does not handle. Brightness keys are absent too.
const COUNTED_SYSTEM_KEYS: [i64; 8] = [0, 1, 4, 7, 14, 16, 19, 20];

/// `NX_SYSDEFINED` → does libuiohook fire a *key pressed* event?
///
/// `subtype`/`data1` are `NSEvent.subtype` / `NSEvent.data1`. The key code is the
/// high 16 bits of `data1`; the key state is bits 8–15, and a state whose low bit
/// is 0 means "down" (0xA is down, 0xB is up).
#[must_use]
pub(crate) fn system_defined_is_press(subtype: i64, data1: i64) -> bool {
    if subtype != NX_SUBTYPE_AUX_CONTROL_BUTTONS {
        return false;
    }
    let data = data1 & 0xFFFF_FFFF;
    let key_code = (data & 0xFFFF_0000) >> 16;
    let key_state = (data & 0xFF00) >> 8;
    let key_down = key_state & 1 == 0;
    key_down && COUNTED_SYSTEM_KEYS.contains(&key_code)
}

/// Saturating float → `int16` for a `CGFloat` coordinate.
///
/// libuiohook stores `event_point.x` in an `int16_t`; in C the conversion
/// truncates toward zero and is undefined out of range. Rust's `as` is defined
/// to truncate toward zero, saturate, and map NaN to 0.
#[must_use]
#[allow(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    reason = "saturating float→int16 mirrors libuiohook's int16_t store; no safe std equivalent"
)]
pub(crate) fn trunc_to_i16(value: f64) -> i16 {
    value as i16
}

/// `(int16_t) pt.x` in C: keep the low 16 bits, reinterpret as signed.
#[must_use]
pub(crate) fn wrap_i16(value: i32) -> i16 {
    let [b0, b1, _, _] = value.to_le_bytes();
    i16::from_le_bytes([b0, b1])
}

/// Everything the macOS callback reads off a `CGEvent`, as plain numbers.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct MacRaw {
    pub kind: u32,
    pub keycode: i64,
    pub flags: u64,
    pub x: f64,
    pub y: f64,
    pub scroll_axis_1: i64,
    pub scroll_axis_2: i64,
    /// `(NSEvent.subtype, NSEvent.data1)`, filled only for `SYS_DEFINED`.
    pub system_defined: Option<(i64, i64)>,
}

/// One macOS `CGEvent` → what legacy counts, or nothing.
///
/// Port of `hook_event_proc` in libuiohook `darwin/input_hook.c` plus the
/// `uiohook-napi` event mapping (`MOUSE_DRAGGED` is delivered as `mousemove`).
#[must_use]
pub(crate) fn decode_mac(raw: &MacRaw) -> Option<InputEvent> {
    match raw.kind {
        cg::KEY_DOWN => Some(InputEvent::KeyDown),
        cg::FLAGS_CHANGED => {
            flags_changed_is_press(raw.keycode, raw.flags).then_some(InputEvent::KeyDown)
        }
        cg::SYS_DEFINED => raw
            .system_defined
            .is_some_and(|(subtype, data1)| system_defined_is_press(subtype, data1))
            .then_some(InputEvent::KeyDown),
        // `kCGEventOtherMouseUp` is deliberately here: libuiohook's switch calls
        // `process_button_pressed` for it (a bug), so legacy counts the release
        // of a middle/extra button as a second click. See PARITY.md.
        cg::LEFT_MOUSE_DOWN | cg::RIGHT_MOUSE_DOWN | cg::OTHER_MOUSE_DOWN | cg::OTHER_MOUSE_UP => {
            Some(InputEvent::MouseDown)
        }
        cg::MOUSE_MOVED
        | cg::LEFT_MOUSE_DRAGGED
        | cg::RIGHT_MOUSE_DRAGGED
        | cg::OTHER_MOUSE_DRAGGED => Some(InputEvent::MouseMove {
            x: trunc_to_i16(raw.x),
            y: trunc_to_i16(raw.y),
        }),
        cg::SCROLL_WHEEL => {
            (raw.scroll_axis_1 != 0 || raw.scroll_axis_2 != 0).then_some(InputEvent::Wheel)
        }
        _ => None,
    }
}

const WM_KEYDOWN: u32 = 0x0100;
const WM_SYSKEYDOWN: u32 = 0x0104;
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_MBUTTONDOWN: u32 = 0x0207;
const WM_MOUSEWHEEL: u32 = 0x020A;
const WM_XBUTTONDOWN: u32 = 0x020B;
const WM_MOUSEHWHEEL: u32 = 0x020E;
const WM_NCXBUTTONDOWN: u32 = 0x00AB;

/// `WH_KEYBOARD_LL` message → count? Every key-down counts, including
/// auto-repeat and injected keys; libuiohook filters neither.
#[must_use]
pub(crate) fn decode_win_key(message: u32) -> Option<InputEvent> {
    matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN).then_some(InputEvent::KeyDown)
}

/// State libuiohook keeps between Windows mouse messages.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct WinMouseState {
    /// `static POINT last_click` — zero-initialised, set on every button press.
    last_click: (i32, i32),
}

impl WinMouseState {
    /// `WH_MOUSE_LL` message at screen point `(x, y)` → what legacy counts.
    ///
    /// Port of `mouse_hook_event_proc`. A move to exactly the last click point
    /// is dropped (`process_mouse_moved` only reports a move once the pointer
    /// differs from `last_click`); the comparison uses the full 32-bit point,
    /// the reported coordinates are the `int16_t` wrap.
    pub(crate) fn decode(&mut self, message: u32, x: i32, y: i32) -> Option<InputEvent> {
        match message {
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
            | WM_NCXBUTTONDOWN => {
                self.last_click = (x, y);
                Some(InputEvent::MouseDown)
            }
            WM_MOUSEMOVE if (x, y) != self.last_click => Some(InputEvent::MouseMove {
                x: wrap_i16(x),
                y: wrap_i16(y),
            }),
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL => Some(InputEvent::Wheel),
            _ => None,
        }
    }
}

/// The pointer-move throttle legacy applies in `activity/index.ts`: the OS fires
/// moves at the pointer's full poll rate, and ~20 Hz is kept.
///
/// `now_ms` is whatever clock the consumer feeds the aggregator (legacy uses
/// `serverAlignedNow()`); this crate never reads a clock for it.
#[derive(Clone, Copy, Debug, Default)]
pub struct MoveThrottle {
    last_move_ms: i64,
}

impl MoveThrottle {
    /// Legacy `MOVE_THROTTLE_MS`.
    pub const INTERVAL_MS: i64 = 50;

    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// `if (t - lastMoveTs < MOVE_THROTTLE_MS) return; lastMoveTs = t;`
    pub fn admit(&mut self, now_ms: i64) -> bool {
        if now_ms.saturating_sub(self.last_move_ms) < Self::INTERVAL_MS {
            return false;
        }
        self.last_move_ms = now_ms;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(kind: u32) -> MacRaw {
        MacRaw {
            kind,
            ..MacRaw::default()
        }
    }

    #[test]
    fn mac_mask_covers_exactly_the_counted_types() {
        let mask = mac_event_mask();
        for ty in [1u32, 3, 5, 6, 7, 10, 12, 14, 22, 25, 26, 27] {
            assert_ne!(mask & (1u64 << ty), 0, "type {ty} missing");
        }
        // key up (11), left/right mouse up (2, 4) are never counted.
        for ty in [2u32, 4, 11] {
            assert_eq!(
                mask & (1u64 << ty),
                0,
                "type {ty} should not be listened to"
            );
        }
    }

    #[test]
    fn plain_key_down_counts_including_repeat() {
        assert_eq!(decode_mac(&raw(cg::KEY_DOWN)), Some(InputEvent::KeyDown));
    }

    #[test]
    fn modifier_counts_only_when_its_flag_is_set() {
        let mut shift_down = raw(cg::FLAGS_CHANGED);
        shift_down.keycode = 56;
        shift_down.flags = FLAG_SHIFT;
        assert_eq!(decode_mac(&shift_down), Some(InputEvent::KeyDown));

        let mut shift_up = shift_down;
        shift_up.flags = 0;
        assert_eq!(decode_mac(&shift_up), None);
    }

    #[test]
    fn releasing_one_shift_while_the_other_is_held_still_counts() {
        // Quirk copied from libuiohook: the flag bit is shared by both shifts.
        let mut ev = raw(cg::FLAGS_CHANGED);
        ev.keycode = 60;
        ev.flags = FLAG_SHIFT;
        assert_eq!(decode_mac(&ev), Some(InputEvent::KeyDown));
    }

    #[test]
    fn all_eight_modifier_keys_are_recognised_and_others_are_not() {
        for (code, bit) in MODIFIER_KEYS {
            assert!(flags_changed_is_press(code, bit));
            assert!(!flags_changed_is_press(code, 0));
        }
        assert!(!flags_changed_is_press(57, 0x0001_0000), "caps lock");
        assert!(!flags_changed_is_press(63, 0x0080_0000), "fn");
        assert!(
            !flags_changed_is_press(56, FLAG_COMMAND),
            "wrong flag for key"
        );
    }

    #[test]
    fn system_defined_counts_only_listed_keys_pressed_down() {
        let down = |key: i64| (key << 16) | (0x0A << 8);
        let up = |key: i64| (key << 16) | (0x0B << 8);
        for key in [0, 1, 4, 7, 14, 16, 19, 20] {
            assert!(system_defined_is_press(8, down(key)), "key {key} down");
            assert!(!system_defined_is_press(8, up(key)), "key {key} up");
        }
        // next (17), previous (18), brightness (2, 3): not handled by libuiohook.
        for key in [2, 3, 17, 18, 21] {
            assert!(!system_defined_is_press(8, down(key)), "key {key}");
        }
        assert!(!system_defined_is_press(7, down(0)), "wrong subtype");
    }

    #[test]
    fn system_defined_needs_the_ns_event_fields() {
        let mut ev = raw(cg::SYS_DEFINED);
        assert_eq!(decode_mac(&ev), None);
        ev.system_defined = Some((8, (7 << 16) | (0x0A << 8)));
        assert_eq!(decode_mac(&ev), Some(InputEvent::KeyDown));
    }

    #[test]
    fn every_mac_button_down_counts_and_other_button_up_counts_too() {
        for kind in [
            cg::LEFT_MOUSE_DOWN,
            cg::RIGHT_MOUSE_DOWN,
            cg::OTHER_MOUSE_DOWN,
            cg::OTHER_MOUSE_UP,
        ] {
            assert_eq!(
                decode_mac(&raw(kind)),
                Some(InputEvent::MouseDown),
                "kind {kind}"
            );
        }
        assert_eq!(decode_mac(&raw(2)), None, "left mouse up");
        assert_eq!(decode_mac(&raw(4)), None, "right mouse up");
    }

    #[test]
    fn drags_and_moves_are_both_mouse_moves_with_truncated_coords() {
        for kind in [
            cg::MOUSE_MOVED,
            cg::LEFT_MOUSE_DRAGGED,
            cg::RIGHT_MOUSE_DRAGGED,
            cg::OTHER_MOUSE_DRAGGED,
        ] {
            let mut ev = raw(kind);
            ev.x = 100.9;
            ev.y = -3.9;
            assert_eq!(
                decode_mac(&ev),
                Some(InputEvent::MouseMove { x: 100, y: -3 })
            );
        }
    }

    #[test]
    fn mac_coordinates_saturate_instead_of_wrapping() {
        assert_eq!(trunc_to_i16(40_000.0), i16::MAX);
        assert_eq!(trunc_to_i16(-40_000.0), i16::MIN);
        assert_eq!(trunc_to_i16(f64::NAN), 0);
    }

    #[test]
    fn scroll_counts_only_with_motion_on_either_axis() {
        let mut ev = raw(cg::SCROLL_WHEEL);
        assert_eq!(decode_mac(&ev), None);
        ev.scroll_axis_1 = -1;
        assert_eq!(decode_mac(&ev), Some(InputEvent::Wheel));
        ev.scroll_axis_1 = 0;
        ev.scroll_axis_2 = 2;
        assert_eq!(decode_mac(&ev), Some(InputEvent::Wheel));
    }

    #[test]
    fn unknown_mac_events_are_ignored() {
        assert_eq!(decode_mac(&raw(11)), None);
        assert_eq!(decode_mac(&raw(0)), None);
    }

    #[test]
    fn tap_disable_notices_are_recognised() {
        assert!(tap_was_disabled(cg::TAP_DISABLED_BY_TIMEOUT));
        assert!(tap_was_disabled(cg::TAP_DISABLED_BY_USER_INPUT));
        assert!(!tap_was_disabled(cg::KEY_DOWN));
    }

    #[test]
    fn windows_counts_key_and_syskey_down_only() {
        assert_eq!(decode_win_key(WM_KEYDOWN), Some(InputEvent::KeyDown));
        assert_eq!(decode_win_key(WM_SYSKEYDOWN), Some(InputEvent::KeyDown));
        assert_eq!(decode_win_key(0x0101), None, "WM_KEYUP");
        assert_eq!(decode_win_key(0x0105), None, "WM_SYSKEYUP");
    }

    #[test]
    fn windows_counts_every_button_down() {
        let mut st = WinMouseState::default();
        for msg in [
            WM_LBUTTONDOWN,
            WM_RBUTTONDOWN,
            WM_MBUTTONDOWN,
            WM_XBUTTONDOWN,
        ] {
            assert_eq!(st.decode(msg, 5, 5), Some(InputEvent::MouseDown));
        }
        assert_eq!(st.decode(0x0202, 5, 5), None, "WM_LBUTTONUP");
    }

    #[test]
    fn windows_move_at_the_last_click_point_is_dropped() {
        let mut st = WinMouseState::default();
        assert_eq!(
            st.decode(WM_LBUTTONDOWN, 300, 200),
            Some(InputEvent::MouseDown)
        );
        assert_eq!(st.decode(WM_MOUSEMOVE, 300, 200), None);
        assert_eq!(
            st.decode(WM_MOUSEMOVE, 301, 200),
            Some(InputEvent::MouseMove { x: 301, y: 200 })
        );
        // Back onto the click point later is still dropped (only a new click resets it).
        assert_eq!(st.decode(WM_MOUSEMOVE, 300, 200), None);
    }

    #[test]
    fn windows_initial_last_click_is_the_origin() {
        let mut st = WinMouseState::default();
        assert_eq!(st.decode(WM_MOUSEMOVE, 0, 0), None);
        assert_eq!(
            st.decode(WM_MOUSEMOVE, 1, 0),
            Some(InputEvent::MouseMove { x: 1, y: 0 })
        );
    }

    #[test]
    fn windows_coordinates_wrap_like_a_c_int16_cast() {
        assert_eq!(wrap_i16(32_767), 32_767);
        assert_eq!(wrap_i16(32_768), -32_768);
        assert_eq!(wrap_i16(65_536 + 7), 7);
        assert_eq!(wrap_i16(-1), -1);
        assert_eq!(wrap_i16(-32_769), 32_767);
    }

    #[test]
    fn windows_wheel_counts_both_axes_and_negative_coordinates_survive() {
        let mut st = WinMouseState::default();
        assert_eq!(st.decode(WM_MOUSEWHEEL, 0, 0), Some(InputEvent::Wheel));
        assert_eq!(st.decode(WM_MOUSEHWHEEL, 0, 0), Some(InputEvent::Wheel));
        assert_eq!(
            st.decode(WM_MOUSEMOVE, -1920, -5),
            Some(InputEvent::MouseMove { x: -1920, y: -5 })
        );
    }

    #[test]
    fn move_throttle_matches_legacy_arithmetic() {
        let mut th = MoveThrottle::new();
        // lastMoveTs starts at 0, so a first move at t < 50 is dropped.
        assert!(!th.admit(49));
        assert!(th.admit(50));
        assert!(!th.admit(99));
        assert!(th.admit(100));
        assert!(th.admit(1_000_000));
    }
}
