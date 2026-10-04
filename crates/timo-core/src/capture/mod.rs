//! Pure screenshot logic: scheduling, retention planning, the activity window of
//! a shot, the thumbnail LRU and the upload retry policy.
//!
//! Ports of `legacy/agent/src/main/services/capture/{scheduler,retention,
//! asyncLru,uploader}.ts` and `activityWindowForShot` of `capture/index.ts`.

pub mod activity_window;
pub mod async_lru;
pub mod retention;
pub mod scheduler;
pub mod upload_policy;

pub use activity_window::{ActivityWindowRange, activity_window_for_shot};
pub use async_lru::{AsyncLru, LoadOutcome, Lookup};
pub use retention::{RetentionInput, RetentionPlan, RetentionRow, plan_screenshot_retention};
pub use scheduler::{
    CAPTURE_DEFER_MS, CAPTURE_QUIET_SECONDS, MAX_CAPTURE_DEFERRALS, next_delay_ms,
    should_defer_capture,
};
pub use upload_policy::{
    ScreenshotUploadFailureDecision, UploadError, screenshot_retry_delay_ms,
    screenshot_upload_failure_decision,
};
