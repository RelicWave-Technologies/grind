//! Port of `apiClient.ts::{onAuthChange, notifyAuth}`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// `'loggedIn' | 'loggedOut'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStatus {
    LoggedIn,
    LoggedOut,
}

type Listener = Arc<dyn Fn(AuthStatus) + Send + Sync>;
type Registry = Arc<Mutex<Vec<(u64, Listener)>>>;

#[derive(Default)]
pub struct AuthListeners {
    registry: Registry,
    next_id: AtomicU64,
}

impl std::fmt::Debug for AuthListeners {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthListeners").finish_non_exhaustive()
    }
}

/// What `onAuthChange` returns: dropping it (or [`Subscription::off`]) unsubscribes.
pub struct Subscription {
    registry: Registry,
    id: u64,
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl Subscription {
    /// The returned `() => authListeners.delete(listener)`.
    pub fn off(self) {
        drop(self);
    }

    /// Keep the listener for the life of the client.
    pub fn keep(self) {
        std::mem::forget(self);
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Ok(mut all) = self.registry.lock() {
            all.retain(|(id, _)| *id != self.id);
        }
    }
}

impl AuthListeners {
    /// `onAuthChange(listener)`.
    pub fn subscribe(&self, listener: impl Fn(AuthStatus) + Send + Sync + 'static) -> Subscription {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut all) = self.registry.lock() {
            all.push((id, Arc::new(listener)));
        }
        Subscription {
            registry: Arc::clone(&self.registry),
            id,
        }
    }

    /// `notifyAuth(status)`: every listener, in subscription order.
    pub fn notify(&self, status: AuthStatus) {
        let snapshot: Vec<Listener> = self
            .registry
            .lock()
            .map(|all| all.iter().map(|(_, l)| Arc::clone(l)).collect())
            .unwrap_or_default();
        for listener in snapshot {
            listener(status);
        }
    }
}
