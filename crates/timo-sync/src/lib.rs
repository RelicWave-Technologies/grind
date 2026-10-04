//! Network: the Timo API client, sync drains, screenshot uploader and auth.
#![forbid(unsafe_code)]

pub mod activity_drain;
pub mod activity_sync;
pub mod api;
pub mod auth;
pub mod auth_events;
mod auth_types;
pub mod config;
pub mod error;
pub mod heartbeat;
pub mod heartbeat_payload;
pub mod http;
pub mod insights;
pub mod lark;
pub mod pending_login;
mod refresh;
pub mod timer_sync;
pub mod tokens;
pub mod uploader;
pub mod uploader_policy;
mod uploader_types;
pub mod urlenc;
pub mod wire;

pub use api::ApiClient;
pub use auth_events::{AuthStatus, Subscription};
pub use config::{CallbackScheme, ClientConfig, Platform};
pub use error::ApiError;
pub use http::{Method, RequestOptions};
