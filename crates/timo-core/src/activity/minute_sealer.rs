//! Port of `legacy/agent/src/main/services/activity/minuteSealer.ts`: the
//! at-most-once bookkeeping around the aggregator.

use super::aggregator::{ActivityAggregator, ActivitySample};
use crate::js::math::{div, mul};
use crate::js::number::floor;

/// The two injected dependencies of `MinuteSealerDeps`.
pub trait SealerHost {
    /// `deps.now()`: the clock the minute buckets are floored from.
    fn now(&mut self) -> f64;
    /// `deps.persist(sample, entryId)`. Called at most once per `bucketStart`.
    fn persist(&mut self, sample: &ActivitySample, entry_id: Option<&str>);
}

/// `Math.floor(ms / 60_000) * 60_000`: on a fractional `ms` the division is done
/// in floating point first, exactly as written.
fn minute_floor(ms: f64) -> f64 {
    mul(floor(div(ms, 60_000.0)), 60_000.0)
}

/// Port of `MinuteSealer`.
#[derive(Debug)]
pub struct MinuteSealer<H: SealerHost> {
    host: H,
    agg: ActivityAggregator,
    recording: bool,
    recording_entry_id: Option<String>,
    bucket_start: f64,
    last_emitted_bucket: f64,
}

impl<H: SealerHost> MinuteSealer<H> {
    pub fn new(mut host: H) -> Self {
        let bucket_start = minute_floor(host.now());
        Self {
            host,
            agg: ActivityAggregator::new(),
            recording: false,
            recording_entry_id: None,
            bucket_start,
            last_emitted_bucket: -1.0,
        }
    }

    /// The injected host (tests read what it recorded).
    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    /// Mirror of "timer running and not paused"; stashes the entry for
    /// attribution only when switching on.
    pub fn set_recording(&mut self, on: bool, entry_id: Option<&str>) {
        self.recording = on;
        if on {
            self.recording_entry_id = entry_id.map(str::to_owned);
        }
    }

    pub fn on_key(&mut self, ts: f64) {
        if self.recording {
            self.agg.on_key(ts);
        }
    }

    pub fn on_click(&mut self) {
        if self.recording {
            self.agg.on_click();
        }
    }

    pub fn on_scroll(&mut self) {
        if self.recording {
            self.agg.on_scroll();
        }
    }

    pub fn on_move(&mut self, ts: f64, x: f64, y: f64) {
        if self.recording {
            self.agg.on_move(ts, x, y);
        }
    }

    /// Called on the ~60 s timer: seals the bucket that just elapsed, then
    /// advances to the current minute.
    pub fn tick(&mut self) -> Option<f64> {
        let sealed = self.seal(self.bucket_start);
        self.bucket_start = minute_floor(self.host.now());
        sealed
    }

    /// Seals the in-flight minute without advancing (quit / shutdown).
    pub fn seal_partial(&mut self) -> Option<f64> {
        self.seal(self.bucket_start)
    }

    fn seal(&mut self, bucket: f64) -> Option<f64> {
        // Already emitted (race / restart-within-minute): drop, don't overwrite.
        if bucket <= self.last_emitted_bucket {
            self.agg.flush(bucket);
            return None;
        }
        if self.agg.is_empty() {
            self.agg.flush(bucket);
            return None;
        }
        let sample = self.agg.flush(bucket);
        self.last_emitted_bucket = bucket;
        self.host
            .persist(&sample, self.recording_entry_id.as_deref());
        Some(bucket)
    }
}
