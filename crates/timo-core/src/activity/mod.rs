//! Keyboard and mouse activity: per-minute counters, the at-most-once sealer,
//! the 0-100% bars and the dominant-window tracker.
//!
//! Ports of `legacy/agent/src/main/services/activity/{aggregator,minuteSealer,
//! percent,activeWindow}.ts`.

pub mod active_window;
pub mod aggregator;
pub mod minute_sealer;
pub mod percent;

pub use active_window::{ActiveWindowObservation, ActiveWindowTracker, DominantWindow};
pub use aggregator::{ActivityAggregator, ActivitySample, coefficient_of_variation};
pub use minute_sealer::{MinuteSealer, SealerHost};
pub use percent::{
    ActivityPercent, ActivityWindow, CLICKS_SAT_PER_MIN, KEYS_SAT_PER_MIN, MOUSE_PX_SAT_PER_MIN,
    SCROLL_SAT_PER_MIN, activity_percent,
};
