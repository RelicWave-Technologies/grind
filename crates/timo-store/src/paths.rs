//! Where the agent keeps its files.
//!
//! The Electron agent keeps everything in Electron's `userData` directory, named
//! after `productName` ("Timo"). The Tauri app must open the same directory, or
//! an upgraded install would lose its database, preferences and session. The
//! decision is a pure function of the platform and the environment values it is
//! handed, so both operating systems are tested on any host.

use std::env;
use std::path::{Path, PathBuf};

/// `productName` in `legacy/agent/package.json`: the last component of `userData`.
pub const APP_NAME: &str = "Timo";

/// The local database (timer ledger, activity, screenshots, Lark task cache).
pub const AGENT_DB: &str = "agent.db";
/// The encrypted session (Electron `safeStorage`).
pub const TOKENS_BIN: &str = "tokens.bin";
/// The encrypted in-flight Lark login (Electron `safeStorage`).
pub const PENDING_LARK_LOGIN_BIN: &str = "pending-lark-login.bin";
/// Device preferences.
pub const PREFERENCES_JSON: &str = "preferences.json";
/// The offline copy of the workspace time zone.
pub const WORKSPACE_TIME_JSON: &str = "workspace-time.json";
/// Log files (`main.log`, `main.log.1`).
pub const LOGS_DIR: &str = "logs";
/// Captured screenshots, one directory per UTC day.
pub const SCREENSHOTS_DIR: &str = "screenshots";

/// The operating systems the agent can run on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// macOS.
    MacOs,
    /// Windows.
    Windows,
    /// Linux (development only; the agent is not shipped there).
    Linux,
}

impl Platform {
    /// The platform this binary was built for.
    #[must_use]
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}

/// The environment values `userData` is derived from. An unset or empty value is `None`.
#[derive(Debug, Clone, Copy, Default)]
pub struct UserDirEnv<'a> {
    /// The user's home directory (`$HOME`).
    pub home: Option<&'a Path>,
    /// `%APPDATA%` (Windows roaming app data).
    pub app_data: Option<&'a Path>,
    /// `$XDG_CONFIG_HOME` (Linux).
    pub xdg_config_home: Option<&'a Path>,
}

/// What Electron's `app.getPath('userData')` returns for this app name:
/// macOS `~/Library/Application Support/Timo`, Windows `%APPDATA%\Timo`, Linux
/// `$XDG_CONFIG_HOME/Timo` or `~/.config/Timo`. `None` when the base directory is unknown.
#[must_use]
pub fn user_data_dir_for(platform: Platform, env: UserDirEnv<'_>) -> Option<PathBuf> {
    let base = match platform {
        Platform::MacOs => env.home?.join("Library").join("Application Support"),
        Platform::Windows => env.app_data?.to_path_buf(),
        Platform::Linux => env
            .xdg_config_home
            .map(Path::to_path_buf)
            .or_else(|| env.home.map(|home| home.join(".config")))?,
    };
    Some(base.join(APP_NAME))
}

/// An environment variable as a path; unset and empty are both `None`.
fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// [`user_data_dir_for`] for this machine: the one place the process environment is read.
#[must_use]
pub fn user_data_dir() -> Option<PathBuf> {
    let home = env_path("HOME").or_else(|| env_path("USERPROFILE"));
    let app_data = env_path("APPDATA");
    let xdg_config_home = env_path("XDG_CONFIG_HOME");
    user_data_dir_for(
        Platform::current(),
        UserDirEnv {
            home: home.as_deref(),
            app_data: app_data.as_deref(),
            xdg_config_home: xdg_config_home.as_deref(),
        },
    )
}

/// The files and directories inside one `userData` directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserDataPaths {
    root: PathBuf,
}

impl UserDataPaths {
    /// Paths under `root` (the directory [`user_data_dir`] returns, or a test's).
    #[must_use]
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The `userData` directory itself.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `agent.db`.
    #[must_use]
    pub fn agent_db(&self) -> PathBuf {
        self.root.join(AGENT_DB)
    }

    /// `tokens.bin`.
    #[must_use]
    pub fn tokens(&self) -> PathBuf {
        self.root.join(TOKENS_BIN)
    }

    /// `pending-lark-login.bin`.
    #[must_use]
    pub fn pending_lark_login(&self) -> PathBuf {
        self.root.join(PENDING_LARK_LOGIN_BIN)
    }

    /// `preferences.json`.
    #[must_use]
    pub fn preferences(&self) -> PathBuf {
        self.root.join(PREFERENCES_JSON)
    }

    /// `workspace-time.json`.
    #[must_use]
    pub fn workspace_time(&self) -> PathBuf {
        self.root.join(WORKSPACE_TIME_JSON)
    }

    /// `logs/`.
    #[must_use]
    pub fn logs(&self) -> PathBuf {
        self.root.join(LOGS_DIR)
    }

    /// `screenshots/`.
    #[must_use]
    pub fn screenshots(&self) -> PathBuf {
        self.root.join(SCREENSHOTS_DIR)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_is_application_support_timo() {
        let env = UserDirEnv {
            home: Some(Path::new("/Users/abhi")),
            ..UserDirEnv::default()
        };
        let dir = user_data_dir_for(Platform::MacOs, env);
        assert_eq!(
            dir,
            Some(PathBuf::from(
                "/Users/abhi/Library/Application Support/Timo"
            ))
        );
    }

    #[test]
    fn windows_is_roaming_appdata_timo_and_ignores_home() {
        let app_data = Path::new("C:\\Users\\abhi\\AppData\\Roaming");
        let env = UserDirEnv {
            home: Some(Path::new("C:\\Users\\abhi")),
            app_data: Some(app_data),
            ..UserDirEnv::default()
        };
        assert_eq!(
            user_data_dir_for(Platform::Windows, env),
            Some(app_data.join("Timo"))
        );
        assert_eq!(
            user_data_dir_for(Platform::Windows, UserDirEnv::default()),
            None
        );
    }

    #[test]
    fn linux_prefers_xdg_then_dot_config() {
        let home = Some(Path::new("/home/abhi"));
        let xdg = UserDirEnv {
            home,
            xdg_config_home: Some(Path::new("/cfg")),
            ..UserDirEnv::default()
        };
        assert_eq!(
            user_data_dir_for(Platform::Linux, xdg),
            Some(PathBuf::from("/cfg/Timo"))
        );
        let plain = UserDirEnv {
            home,
            ..UserDirEnv::default()
        };
        assert_eq!(
            user_data_dir_for(Platform::Linux, plain),
            Some(PathBuf::from("/home/abhi/.config/Timo"))
        );
    }

    #[test]
    fn macos_without_home_is_unknown() {
        assert_eq!(
            user_data_dir_for(Platform::MacOs, UserDirEnv::default()),
            None
        );
    }

    #[test]
    fn file_names_are_the_electron_agents() {
        let paths = UserDataPaths::new(PathBuf::from("/data/Timo"));
        let names = [
            (paths.agent_db(), "agent.db"),
            (paths.tokens(), "tokens.bin"),
            (paths.pending_lark_login(), "pending-lark-login.bin"),
            (paths.preferences(), "preferences.json"),
            (paths.workspace_time(), "workspace-time.json"),
            (paths.logs(), "logs"),
            (paths.screenshots(), "screenshots"),
        ];
        for (path, name) in names {
            assert_eq!(path, Path::new("/data/Timo").join(name));
        }
    }
}
