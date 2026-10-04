//! The two pure reducers behind the agent's shift prompts.
//!
//! - [`decide`]: the "Ready to work?" popup that opens a shift
//!   (`legacy/agent/src/main/services/shift/decide.ts`).
//! - [`untracked`]: the "Are you working?" nudge for the rest of the day
//!   (`.../shift/untracked.ts`).
//!
//! Both take the clock and the zone as arguments and touch no OS. The service
//! that owns the timers and the popup (`shift/index.ts`, SC-61) stays in the app.
pub mod decide;
pub mod schedule;
pub mod untracked;
