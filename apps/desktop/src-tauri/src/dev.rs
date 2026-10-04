//! Debug builds only: `TIMO_DEV_SHOW=popover,floating,attention,ready` shows
//! those windows shortly after launch, so each can be looked at (and
//! screenshotted) without the services that normally show them. Compiled out of
//! release builds.

use std::time::Duration;

use tauri::AppHandle;

use crate::windows::present::{self, Anchor};
use crate::windows::spec;

const SETTLE: Duration = Duration::from_millis(1500);

pub fn show_requested(app: &AppHandle) {
    let Ok(wanted) = std::env::var("TIMO_DEV_SHOW") else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SETTLE);
        for name in wanted.split(',').map(str::trim) {
            show(&app, name);
        }
    });
}

fn show(app: &AppHandle, name: &str) {
    match name {
        "popover" => show_popover(app),
        "floating" => present::show_floating_bar(app),
        "attention" => present::show_overlay(app, spec::ATTENTION, Anchor::Center),
        "ready" => present::show_overlay(app, spec::READY_TO_WORK, Anchor::TopRight),
        other => tracing::warn!(other, "dev: unknown window in TIMO_DEV_SHOW"),
    }
}

fn show_popover(app: &AppHandle) {
    if let Some(rect) = crate::tray::icon_rect(app) {
        present::show_overlay(app, spec::POPOVER, Anchor::Tray(rect));
    } else {
        tracing::warn!("dev: no tray rect yet, popover not shown");
    }
}
