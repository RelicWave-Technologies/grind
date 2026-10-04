//! IPC commands that need no services. Channel `window:openMain` is command
//! `window_open_main`; the full table is in apps/desktop/README.md. Every
//! command here is also listed in `names.rs` and granted in `capabilities/`.
//! Anything not here is `not ported yet` in the TypeScript bridge.

pub mod app;
mod error;
#[cfg(test)]
mod names;
pub mod settings;
pub mod window;

pub use error::CommandError;

#[cfg(test)]
mod tests {
    use super::names::COMMANDS;

    const MAIN: &str = include_str!("../../capabilities/main.json");
    const OVERLAY: &str = include_str!("../../capabilities/overlay.json");

    fn permission(command: &str) -> String {
        format!("\"allow-{}\"", command.replace('_', "-"))
    }

    #[test]
    fn every_command_is_granted_to_a_window() {
        for command in COMMANDS {
            let wanted = permission(command);
            assert!(
                MAIN.contains(&wanted) || OVERLAY.contains(&wanted),
                "{command} is registered but no capability grants {wanted}"
            );
        }
    }

    #[test]
    fn no_capability_grants_a_command_that_is_not_registered() {
        for capability in [MAIN, OVERLAY] {
            for line in capability.lines().filter(|l| l.contains("\"allow-")) {
                let granted = line.trim().trim_end_matches(',');
                let known = COMMANDS.iter().any(|c| permission(c) == granted);
                assert!(known || granted.contains(':'), "unknown grant {granted}");
            }
        }
    }
}
