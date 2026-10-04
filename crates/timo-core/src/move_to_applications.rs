//! Port of `legacy/agent/src/main/services/moveToApplications.ts`: the
//! move-to-Applications orchestration, with every step injected.

use serde::Serialize;

/// Port of `MoveToApplicationsResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum MoveToApplicationsResult {
    Moved(MovedOk),
    Refused(MoveRefused),
}

/// `{ ok: true }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MovedOk {
    pub ok: bool,
}

/// `{ ok: false, reason }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MoveRefused {
    pub ok: bool,
    pub reason: MoveRefusal,
}

/// `'TRACKING_ACTIVE' | 'CANCELLED' | 'MOVE_FAILED'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum MoveRefusal {
    #[serde(rename = "TRACKING_ACTIVE")]
    TrackingActive,
    #[serde(rename = "CANCELLED")]
    Cancelled,
    #[serde(rename = "MOVE_FAILED")]
    MoveFailed,
}

impl MoveToApplicationsResult {
    const OK: Self = Self::Moved(MovedOk { ok: true });

    const fn refused(reason: MoveRefusal) -> Self {
        Self::Refused(MoveRefused { ok: false, reason })
    }
}

/// `move()` threw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoveThrew;

/// Port of `MoveToApplicationsDeps`.
pub trait MoveToApplicationsDeps {
    /// `isTracking()`.
    fn is_tracking(&mut self) -> bool;
    /// `await confirm()`.
    fn confirm(&mut self) -> impl Future<Output = bool>;
    /// `await cleanup()`.
    fn cleanup(&mut self) -> impl Future<Output = ()>;
    /// `move()`: whether the app moved; `Err` when it threw.
    fn move_app(&mut self) -> Result<bool, MoveThrew>;
    /// `invalidateCleanup()`.
    fn invalidate_cleanup(&mut self);
}

/// Port of `moveToApplications`.
pub async fn move_to_applications<D: MoveToApplicationsDeps>(
    deps: &mut D,
) -> MoveToApplicationsResult {
    if deps.is_tracking() {
        return MoveToApplicationsResult::refused(MoveRefusal::TrackingActive);
    }
    if !deps.confirm().await {
        return MoveToApplicationsResult::refused(MoveRefusal::Cancelled);
    }

    deps.cleanup().await;
    match deps.move_app() {
        Ok(true) => MoveToApplicationsResult::OK,
        Ok(false) => {
            deps.invalidate_cleanup();
            MoveToApplicationsResult::refused(MoveRefusal::Cancelled)
        }
        Err(MoveThrew) => {
            deps.invalidate_cleanup();
            MoveToApplicationsResult::refused(MoveRefusal::MoveFailed)
        }
    }
}
