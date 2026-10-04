//! The shape of `preferences.json`: coercing whatever the file holds over the
//! defaults, and writing it back exactly as `JSON.stringify(cache, null, 2)` does.

use serde_json::Value;
use timo_core::js::json::quote;
use timo_core::js::number::number_to_string;

/// Port of `FloatingBarPreferences`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FloatingBarPreferences {
    /// User toggle: show the always-on-top mini bar while tracking.
    pub visible: bool,
    /// Last dragged position; `None` = use the default corner.
    pub x: Option<f64>,
    /// See `x`.
    pub y: Option<f64>,
}

/// Port of `Preferences`.
#[derive(Debug, Clone, PartialEq)]
pub struct Preferences {
    /// The floating bar's visibility and position.
    pub floating_bar: FloatingBarPreferences,
    /// Lark task guid the user last tracked against, so reopening Timo offers the
    /// work they were actually on.
    pub last_lark_task_guid: Option<String>,
}

impl Default for Preferences {
    /// Port of `DEFAULTS`.
    fn default() -> Self {
        Self {
            floating_bar: FloatingBarPreferences {
                visible: true,
                x: None,
                y: None,
            },
            last_lark_task_guid: None,
        }
    }
}

/// `value[key]` when `value` is an object (any other JS value has no such property).
fn prop<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|o| o.get(key))
}

/// `typeof v === 'number' && Number.isFinite(v) ? v : null`.
fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// Merge a parsed (possibly partial or old) value over defaults defensively.
/// Port of `legacy/agent/src/main/services/preferences.ts::coerce`.
#[must_use]
pub fn coerce(raw: &Value) -> Preferences {
    let fb = prop(raw, "floatingBar").unwrap_or(&Value::Null);
    let defaults = Preferences::default();
    Preferences {
        floating_bar: FloatingBarPreferences {
            visible: prop(fb, "visible")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.floating_bar.visible),
            x: finite(prop(fb, "x")),
            y: finite(prop(fb, "y")),
        },
        last_lark_task_guid: prop(raw, "lastLarkTaskGuid")
            .and_then(Value::as_str)
            .filter(|g| !g.is_empty())
            .map(str::to_owned),
    }
}

/// `JSON.stringify(n)` for a number: non-finite values are `null`.
fn number(n: Option<f64>) -> String {
    match n {
        Some(n) if n.is_finite() => number_to_string(n),
        _ => "null".to_owned(),
    }
}

/// `JSON.stringify(prefs, null, 2)`: two-space indent, no trailing newline, keys
/// in declaration order (`floatingBar { visible, x, y }`, then `lastLarkTaskGuid`).
/// Port of the serialisation in `preferences.ts::flush`.
#[must_use]
pub fn serialize(prefs: &Preferences) -> String {
    let bar = &prefs.floating_bar;
    let guid = prefs
        .last_lark_task_guid
        .as_deref()
        .map_or_else(|| "null".to_owned(), quote);
    format!(
        "{{\n  \"floatingBar\": {{\n    \"visible\": {},\n    \"x\": {},\n    \"y\": {}\n  }},\n  \"lastLarkTaskGuid\": {}\n}}",
        bar.visible,
        number(bar.x),
        number(bar.y),
        guid
    )
}
