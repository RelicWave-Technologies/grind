//! What `env.ts` and `process.platform` give the network layer.

use serde::Serialize;

/// Port of `heartbeatPayload.ts::currentPlatform` / `syncClient.ts::platform`:
/// anything that is not macOS or Windows is `linux`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Darwin,
    Win32,
    Linux,
}

impl Platform {
    /// The platform this binary runs on.
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Darwin
        } else if cfg!(target_os = "windows") {
            Self::Win32
        } else {
            Self::Linux
        }
    }

    /// `process.platform` as the wire and `deviceName` spell it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Darwin => "darwin",
            Self::Win32 => "win32",
            Self::Linux => "linux",
        }
    }
}

/// `env.ts::CALLBACK_SCHEME`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackScheme {
    Grind,
    Timo,
}

impl CallbackScheme {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Grind => "grind",
            Self::Timo => "timo",
        }
    }
}

/// Port of `env.ts` (`API_URL`, `CALLBACK_SCHEME`, `AGENT_VERSION`) and the device
/// facts `auth.ts` and `syncClient.ts` read from `os`/`process`.
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// `API_URL`, no trailing slash. Production: `https://timo.emiactech.com`.
    pub api_url: String,
    pub callback_scheme: CallbackScheme,
    /// `AGENT_VERSION` (`process.env.npm_package_version ?? '0.0.1'`).
    pub agent_version: String,
    pub platform: Platform,
    /// `os.hostname()`, for the `deviceName` of a password login.
    pub hostname: String,
}

impl ClientConfig {
    /// The values `env.ts` falls back to with nothing configured.
    #[must_use]
    pub fn local_default() -> Self {
        Self {
            api_url: "http://localhost:4000".to_owned(),
            callback_scheme: CallbackScheme::Timo,
            agent_version: "0.0.1".to_owned(),
            platform: Platform::current(),
            hostname: gethostname::gethostname().to_string_lossy().into_owned(),
        }
    }
}
