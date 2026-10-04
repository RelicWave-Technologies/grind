//! Every window the app has, as data. Port of the `BrowserWindow` options in
//! legacy/agent/src/main/{window,popover,floating,attentionWindow,readyToWork}.ts
//! and windows/overlay.ts. The window table in apps/desktop/README.md is this file.

/// Precedence between overlays (legacy `OverlayRank`). `Ambient` is furniture
/// (timer bar, popover, shift toast); `Prompt` is asking the user something and
/// must not be buried by the furniture. macOS orders them by panel level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rank {
    Ambient,
    Prompt,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    /// The resizable application window with a custom title bar.
    Main,
    /// A frameless, transparent, always-on-top surface (an NSPanel on macOS).
    Overlay { rank: Rank, shadow: bool },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowSpec {
    /// Tauri window label; capabilities are scoped by it.
    pub label: &'static str,
    /// Renderer hash route (`src/main.tsx`); empty is the main app.
    pub hash: &'static str,
    /// Logical size at creation.
    pub width: f64,
    pub height: f64,
    pub min: Option<(f64, f64)>,
    pub kind: Kind,
}

/// 960x640 (min 720x460), hidden-inset title bar, traffic lights at (16, 18),
/// background `#F2F2F7`, created hidden (shown unless launched at login).
pub const MAIN: WindowSpec = WindowSpec {
    label: "main",
    hash: "",
    width: 960.0,
    height: 640.0,
    min: Some((720.0, 460.0)),
    kind: Kind::Main,
};

/// 300x340 anchored under the tray icon; dismisses on blur. Default OS shadow.
pub const POPOVER: WindowSpec = WindowSpec {
    label: "popover",
    hash: "popover",
    width: 300.0,
    height: 340.0,
    min: None,
    kind: Kind::Overlay {
        rank: Rank::Ambient,
        shadow: true,
    },
};

/// 268x44, hugs the pill exactly: no OS shadow (the pill draws its own).
pub const FLOATING: WindowSpec = WindowSpec {
    label: "floating",
    hash: "floating",
    width: 268.0,
    height: 44.0,
    min: None,
    kind: Kind::Overlay {
        rank: Rank::Ambient,
        shadow: false,
    },
};

/// Created at the largest prompt size (480x332); resized per prompt later.
pub const ATTENTION: WindowSpec = WindowSpec {
    label: "attention",
    hash: "attention",
    width: 480.0,
    height: 332.0,
    min: None,
    kind: Kind::Overlay {
        rank: Rank::Prompt,
        shadow: true,
    },
};

/// 320x168 toast, top-right of the active display.
pub const READY_TO_WORK: WindowSpec = WindowSpec {
    label: "ready-to-work",
    hash: "ready-to-work",
    width: 320.0,
    height: 168.0,
    min: None,
    kind: Kind::Overlay {
        rank: Rank::Ambient,
        shadow: true,
    },
};

#[cfg(test)]
pub const ALL: [WindowSpec; 5] = [MAIN, POPOVER, FLOATING, ATTENTION, READY_TO_WORK];

/// macOS panel level for an overlay. 28 is Airnote's proven HUD level (above
/// fullscreen apps with `full_screen_auxiliary`); a prompt sits one above the
/// furniture, which is what legacy's relative level offset did.
#[cfg_attr(
    not(target_os = "macos"),
    allow(
        dead_code,
        reason = "panel levels exist only on macOS; the logic stays host-testable"
    )
)]
const PANEL_LEVEL_AMBIENT: i32 = 28;
#[cfg_attr(
    not(target_os = "macos"),
    allow(
        dead_code,
        reason = "panel levels exist only on macOS; the logic stays host-testable"
    )
)]
const PANEL_LEVEL_PROMPT: i32 = 29;

impl WindowSpec {
    /// The page the webview loads: `index.html`, plus `#hash` for a surface.
    #[must_use]
    pub fn url(&self) -> String {
        let query = dev_query();
        if self.hash.is_empty() {
            format!("index.html{query}")
        } else {
            format!("index.html{query}#{}", self.hash)
        }
    }

    #[must_use]
    #[cfg_attr(
        not(target_os = "macos"),
        allow(
            dead_code,
            reason = "panel levels exist only on macOS; the logic stays host-testable"
        )
    )]
    pub fn panel_level(&self) -> i32 {
        match self.kind {
            Kind::Overlay {
                rank: Rank::Prompt, ..
            } => PANEL_LEVEL_PROMPT,
            _ => PANEL_LEVEL_AMBIENT,
        }
    }

    #[must_use]
    pub fn has_shadow(&self) -> bool {
        match self.kind {
            Kind::Overlay { shadow, .. } => shadow,
            Kind::Main => true,
        }
    }
}

/// Debug builds: `TIMO_DEV_LAB=lab&prompt=PERMISSION` appends `?lab&prompt=...`
/// to every window URL, which makes the renderer use the lab's fake bridge
/// (apps/desktop/lab/devWindow.ts). Always empty in release builds.
#[cfg(debug_assertions)]
fn dev_query() -> String {
    std::env::var("TIMO_DEV_LAB")
        .map(|q| format!("?{q}"))
        .unwrap_or_default()
}

#[cfg(not(debug_assertions))]
fn dev_query() -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_routes_are_unique() {
        for (i, a) in ALL.iter().enumerate() {
            for b in ALL.iter().skip(i + 1) {
                assert_ne!(a.label, b.label);
                assert_ne!(a.hash, b.hash);
            }
        }
    }

    #[test]
    fn urls_carry_the_hash_route_the_renderer_switches_on() {
        assert_eq!(MAIN.url(), "index.html");
        assert_eq!(POPOVER.url(), "index.html#popover");
        assert_eq!(READY_TO_WORK.url(), "index.html#ready-to-work");
    }

    #[test]
    fn a_prompt_outranks_the_furniture() {
        assert!(ATTENTION.panel_level() > FLOATING.panel_level());
        assert_eq!(FLOATING.panel_level(), POPOVER.panel_level());
    }

    #[test]
    fn only_the_floating_bar_goes_without_an_os_shadow() {
        let bare: Vec<_> = ALL
            .iter()
            .filter(|w| !w.has_shadow())
            .map(|w| w.label)
            .collect();
        assert_eq!(bare, ["floating"]);
    }
}
