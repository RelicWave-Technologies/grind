//! Timo desktop shell: windows, tray and IPC wiring only. No business logic.
//! Everything the app *does* (timer, ledgers, sync) lives in `crates/` and is
//! wired in as it is ported; until then the TypeScript bridge reports
//! `not ported yet: <command>` for those channels. Rules: AGENTS.md
//! "Desktop: Tauri + Rust".

mod app;
mod commands;
mod dto;
mod guard;
mod paths;
mod placement;
mod plugins;
mod screen;
mod tray;
mod windows;

#[cfg(debug_assertions)]
mod dev;

pub use app::run;
