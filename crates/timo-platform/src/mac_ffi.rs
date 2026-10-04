//! Hand-written bindings for the handful of `CoreGraphics` / `CoreFoundation` /
//! `IOKit` / `ApplicationServices` calls this crate makes. Kept to exactly what is
//! used so every declaration can be checked against the SDK header by eye.

use std::ffi::c_void;

pub(crate) type CFTypeRef = *const c_void;
pub(crate) type CFMachPortRef = *mut c_void;
pub(crate) type CFRunLoopRef = *mut c_void;
pub(crate) type CFRunLoopSourceRef = *mut c_void;
pub(crate) type CFStringRef = *const c_void;
pub(crate) type CGEventRef = *mut c_void;
pub(crate) type CGEventTapProxy = *mut c_void;

pub(crate) type CGEventTapCallBack = unsafe extern "C" fn(
    proxy: CGEventTapProxy,
    event_type: u32,
    event: CGEventRef,
    user_info: *mut c_void,
) -> CGEventRef;

pub(crate) type IoPowerCallback = unsafe extern "C" fn(
    refcon: *mut c_void,
    service: u32,
    message_type: u32,
    message_argument: *mut c_void,
);

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub(crate) struct CGPoint {
    pub x: f64,
    pub y: f64,
}

// CGEventTapLocation / Placement / Options.
pub(crate) const K_CG_SESSION_EVENT_TAP: u32 = 1;
pub(crate) const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
pub(crate) const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;

// CGEventField.
pub(crate) const K_CG_KEYBOARD_EVENT_KEYCODE: u32 = 9;
pub(crate) const K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_1: u32 = 11;
pub(crate) const K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_2: u32 = 12;

// CGEventSourceStateID / CGEventType "any".
pub(crate) const K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE: i32 = 0;
pub(crate) const K_CG_ANY_INPUT_EVENT_TYPE: u32 = 0xFFFF_FFFF;

// IOKit messages (`iokit_common_msg(x)` = 0xE000_0000 | x).
pub(crate) const K_IO_MESSAGE_CAN_SYSTEM_SLEEP: u32 = 0xE000_0270;
pub(crate) const K_IO_MESSAGE_SYSTEM_WILL_SLEEP: u32 = 0xE000_0280;
pub(crate) const K_IO_MESSAGE_SYSTEM_WILL_POWER_ON: u32 = 0xE000_0320;

pub(crate) const K_CF_RUN_LOOP_RUN_FINISHED: i32 = 1;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    pub(crate) static kCFRunLoopCommonModes: CFStringRef;
    pub(crate) static kCFRunLoopDefaultMode: CFStringRef;

    pub(crate) fn CFMachPortCreateRunLoopSource(
        allocator: *const c_void,
        port: CFMachPortRef,
        order: i64,
    ) -> CFRunLoopSourceRef;
    pub(crate) fn CFMachPortInvalidate(port: CFMachPortRef);
    pub(crate) fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    pub(crate) fn CFRunLoopAddSource(
        rl: CFRunLoopRef,
        source: CFRunLoopSourceRef,
        mode: CFStringRef,
    );
    pub(crate) fn CFRunLoopRemoveSource(
        rl: CFRunLoopRef,
        source: CFRunLoopSourceRef,
        mode: CFStringRef,
    );
    pub(crate) fn CFRunLoopRunInMode(
        mode: CFStringRef,
        seconds: f64,
        return_after_source: bool,
    ) -> i32;
    pub(crate) fn CFRunLoopStop(rl: CFRunLoopRef);
    pub(crate) fn CFRelease(cf: CFTypeRef);
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    pub(crate) fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: CGEventTapCallBack,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    pub(crate) fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    pub(crate) fn CGEventTapIsEnabled(tap: CFMachPortRef) -> bool;
    pub(crate) fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    pub(crate) fn CGEventGetFlags(event: CGEventRef) -> u64;
    pub(crate) fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
    pub(crate) fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    pub(crate) fn CGPreflightListenEventAccess() -> bool;
    pub(crate) fn CGRequestListenEventAccess() -> bool;
    pub(crate) fn CGPreflightScreenCaptureAccess() -> bool;
    pub(crate) fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    pub(crate) static kAXTrustedCheckOptionPrompt: CFStringRef;
    pub(crate) fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    pub(crate) static kCFBooleanTrue: CFTypeRef;
    pub(crate) static kCFBooleanFalse: CFTypeRef;
    pub(crate) static kCFTypeDictionaryKeyCallBacks: c_void;
    pub(crate) static kCFTypeDictionaryValueCallBacks: c_void;
    pub(crate) fn CFDictionaryCreate(
        allocator: *const c_void,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        count: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFTypeRef;
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    pub(crate) fn IORegisterForSystemPower(
        refcon: *mut c_void,
        notify_port: *mut *mut c_void,
        callback: IoPowerCallback,
        notifier: *mut u32,
    ) -> u32;
    pub(crate) fn IODeregisterForSystemPower(notifier: *mut u32) -> i32;
    pub(crate) fn IOAllowPowerChange(kernel_port: u32, notification_id: isize) -> i32;
    pub(crate) fn IONotificationPortGetRunLoopSource(port: *mut c_void) -> CFRunLoopSourceRef;
    pub(crate) fn IONotificationPortDestroy(port: *mut c_void);
    pub(crate) fn IOServiceClose(connect: u32) -> i32;
}
