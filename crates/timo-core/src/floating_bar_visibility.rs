//! Port of `legacy/agent/src/main/services/floatingBarVisibility.ts`: the pure
//! visibility policy for the floating timer bar. Timer state, the persistent
//! Settings preference and a one-session dismiss are deliberately separate.

/// Port of `FloatingBarVisibilityPolicy`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FloatingBarVisibilityPolicy {
    active_entry_id: Option<String>,
    dismissed_entry_id: Option<String>,
    preference_visible: bool,
}

impl Default for FloatingBarVisibilityPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl FloatingBarVisibilityPolicy {
    #[must_use]
    pub fn new() -> Self {
        Self {
            active_entry_id: None,
            dismissed_entry_id: None,
            preference_visible: true,
        }
    }

    /// `syncTimer(entryId, preferenceVisible)`.
    pub fn sync_timer(&mut self, entry_id: Option<&str>, preference_visible: bool) -> bool {
        self.preference_visible = preference_visible;
        if entry_id != self.active_entry_id.as_deref() {
            self.active_entry_id = entry_id.map(str::to_owned);
            if entry_id != self.dismissed_entry_id.as_deref() {
                self.dismissed_entry_id = None;
            }
        }
        self.should_show()
    }

    /// `dismissCurrent()`.
    pub fn dismiss_current(&mut self) -> bool {
        self.dismissed_entry_id.clone_from(&self.active_entry_id);
        self.should_show()
    }

    /// `setPreferenceVisible(visible)`.
    pub fn set_preference_visible(&mut self, visible: bool) -> bool {
        self.preference_visible = visible;
        if visible {
            self.dismissed_entry_id = None;
        }
        self.should_show()
    }

    fn should_show(&self) -> bool {
        self.preference_visible
            && self.active_entry_id.is_some()
            && self.active_entry_id != self.dismissed_entry_id
    }
}
