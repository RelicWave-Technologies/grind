//! Shared support for the timer integration tests: the Rust twins of the
//! parity harness (`parity/src/scenarios/timer*.ts`).
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines,
    clippy::indexing_slicing,
    clippy::string_slice,
    reason = "each test crate uses a subset of these helpers; tests unwrap and assert, the scanner slices \
              text it measured itself, and the op dispatchers are flat matches that mirror the switch \
              in parity/src/scenarios/timerRun.ts one case per arm"
)]

pub mod dump;
pub mod members;
pub mod ops;
pub mod records;
pub mod replay;
pub mod scenario;
pub mod world;
