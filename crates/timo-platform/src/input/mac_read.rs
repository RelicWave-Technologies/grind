//! Reading the few `CGEvent` fields the counting decision needs, and nothing else.
//! Key codes are read for modifier changes alone; ordinary key presses are never
//! inspected. Split from `mac.rs` to keep both files small.

use objc2::encode::{Encoding, RefEncode};
use objc2::msg_send;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{AnyClass, AnyObject};

use super::decide::{MacRaw, cg};
use crate::mac_ffi as ffi;

/// Read only the fields the decision for this event type needs. Key codes are
/// read for modifier changes alone; ordinary key presses are never inspected.
///
/// # Safety
/// `event` must be a live `CGEvent`.
pub(super) unsafe fn read_raw(kind: u32, event: ffi::CGEventRef) -> MacRaw {
    let mut raw = MacRaw {
        kind,
        ..MacRaw::default()
    };
    // SAFETY: `event` is live per this function's contract.
    unsafe {
        match kind {
            cg::FLAGS_CHANGED => {
                raw.keycode =
                    ffi::CGEventGetIntegerValueField(event, ffi::K_CG_KEYBOARD_EVENT_KEYCODE);
                raw.flags = ffi::CGEventGetFlags(event);
            }
            cg::MOUSE_MOVED
            | cg::LEFT_MOUSE_DRAGGED
            | cg::RIGHT_MOUSE_DRAGGED
            | cg::OTHER_MOUSE_DRAGGED => {
                let point = ffi::CGEventGetLocation(event);
                raw.x = point.x;
                raw.y = point.y;
            }
            cg::SCROLL_WHEEL => {
                raw.scroll_axis_1 = ffi::CGEventGetIntegerValueField(
                    event,
                    ffi::K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_1,
                );
                raw.scroll_axis_2 = ffi::CGEventGetIntegerValueField(
                    event,
                    ffi::K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_2,
                );
            }
            cg::SYS_DEFINED => raw.system_defined = system_defined_fields(event),
            _ => {}
        }
    }
    raw
}

/// An opaque `CGEventRef` target with the encoding `NSEvent +eventWithCGEvent:` expects.
#[repr(C)]
struct OpaqueCgEvent {
    _private: [u8; 0],
}

// SAFETY: matches the Objective-C type encoding `^{__CGEvent=}` of a `CGEventRef`.
unsafe impl RefEncode for OpaqueCgEvent {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("__CGEvent", &[]));
}

/// `(NSEvent.subtype, NSEvent.data1)` for an `NX_SYSDEFINED` event — how
/// libuiohook (built with `USE_OBJC`, as `uiohook-napi` is) reads media keys.
///
/// # Safety
/// `event` must be a live `CGEvent`.
pub(super) unsafe fn system_defined_fields(event: ffi::CGEventRef) -> Option<(i64, i64)> {
    autoreleasepool(|_| {
        let class = AnyClass::get(c"NSEvent")?;
        // SAFETY: `+eventWithCGEvent:` takes a CGEventRef and returns an autoreleased NSEvent or nil.
        let ns_event: Option<Retained<AnyObject>> =
            unsafe { msg_send![class, eventWithCGEvent: event.cast::<OpaqueCgEvent>()] };
        let ns_event = ns_event?;
        // SAFETY: `-subtype` returns a short and `-data1` an NSInteger on any NSEvent.
        let (subtype, data1): (i16, isize) =
            unsafe { (msg_send![&*ns_event, subtype], msg_send![&*ns_event, data1]) };
        Some((i64::from(subtype), i64::try_from(data1).ok()?))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::decide;
    use objc2_foundation::NSPoint;

    /// Build a real `NSEvent` of type system-defined, take its `CGEvent`, and read
    /// the fields back through the same code the tap uses — on a non-main thread,
    /// as the tap does.
    fn read_back(subtype: i16, data1: isize) -> Option<(i64, i64)> {
        std::thread::spawn(move || {
            autoreleasepool(|_| {
                let class = AnyClass::get(c"NSEvent")?;
                // SAFETY: documented factory method; arguments match its Objective-C signature.
                let ns_event: Option<Retained<AnyObject>> = unsafe {
                    msg_send![
                        class,
                        otherEventWithType: 14usize,
                        location: NSPoint::new(0.0, 0.0),
                        modifierFlags: 0usize,
                        timestamp: 0.0f64,
                        windowNumber: 0isize,
                        context: std::ptr::null::<AnyObject>(),
                        subtype: subtype,
                        data1: data1,
                        data2: 0isize
                    ]
                };
                let ns_event = ns_event?;
                // SAFETY: `-CGEvent` returns the event's CGEventRef, valid while `ns_event` lives.
                let cg: *mut OpaqueCgEvent = unsafe { msg_send![&*ns_event, CGEvent] };
                if cg.is_null() {
                    return None;
                }
                // SAFETY: `cg` is a live CGEvent for the duration of this call.
                unsafe { system_defined_fields(cg.cast()) }
            })
        })
        .join()
        .ok()
        .flatten()
    }

    #[test]
    fn media_key_fields_survive_the_cg_event_round_trip() {
        let data1 = (19isize << 16) | (0x0A << 8); // fast-forward, key down
        assert_eq!(
            read_back(8, data1),
            Some((8, i64::try_from(data1).unwrap()))
        );
    }

    #[test]
    fn round_tripped_fields_drive_the_decision() {
        let down = read_back(8, (7isize << 16) | (0x0A << 8)).expect("fields");
        assert!(
            decide::system_defined_is_press(down.0, down.1),
            "mute down counts"
        );
        let up = read_back(8, (7isize << 16) | (0x0B << 8)).expect("fields");
        assert!(
            !decide::system_defined_is_press(up.0, up.1),
            "mute up does not"
        );
    }
}
