//! OS-idle decisions and the two-stage idle monitor.
//!
//! Ports of `legacy/agent/src/main/services/idle/{decide,monitor}.ts`.

pub mod decide;
pub mod monitor;

pub use decide::{IdleInputs, compute_idle_start, should_prompt_idle};
pub use monitor::{
    HandlerOutcome, IdleEffect, IdleMonitor, IdlePhase, IdleSnapshot, IdleTickInput,
};
