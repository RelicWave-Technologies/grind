//! Business-day and timezone maths: a port of `packages/types/src/timezone.ts`.
//!
//! Which worked time counts as "today" is decided here, and that feeds pay, so
//! the results must equal what the legacy app computed: `Intl` on **Electron
//! 33.2.0** (ICU 74.2, tzdata 2024a). The zone data is `jiff-tzdb` 0.1.0, the
//! release that embeds the same tzdata 2024a; `tzif` and `posix` read it.
//! `PARITY.md` records the versions, what each runtime accepts, and the one
//! place the two can disagree (tzdata drift after 2024a).
//!
//! Every function takes the zone as a string id and resolves it itself, like
//! the TypeScript: there is no hidden state, and the TypeScript's caches
//! (validity, formatters, day windows) are not ported because eviction order
//! cannot change an answer.
pub mod civil;
pub mod error;
pub mod instants;
pub mod median;
pub mod parts;
pub mod posix;
pub mod schema;
pub mod tzif;
pub mod window;
pub mod zone;

pub use error::TzError;
pub use instants::{instant_for_zoned_date_time, possible_instants_for_zoned_date_time};
pub use median::median_minute;
pub use parts::{ZonedDateTimeParts, time_clip, zoned_date_time_parts};
pub use schema::{DEFAULT_TIME_ZONE, js_trim, js_trim_start, parse_time_zone};
pub use window::{DayWindow, date_key_in_time_zone, local_day_window_in_time_zone};
pub use zone::is_valid_time_zone;
