//! Port of `legacy/agent/src/main/services/capture/asyncLru.ts`: a small
//! promise-aware LRU for immutable thumbnails.
//!
//! The TypeScript caches the *promise*, so a second `get` while a load is in
//! flight shares it. Here the cache keeps the in-flight marker and the loaded
//! value; the caller starts the load a `Lookup::Miss` asks for and reports how
//! it ended with [`AsyncLru::settle`], which is the `.then` the TypeScript
//! attaches.

use thiserror::Error;

/// `new AsyncLru(maxEntries)` with something that is not a positive integer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("maxEntries must be a positive integer")]
pub struct InvalidMaxEntries;

/// What `get` found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup<T> {
    /// A load for this key is in flight; share it.
    Pending,
    /// A loaded value is cached.
    Hit(T),
    /// Nothing cached: the caller must start `load()` and report with `settle`
    /// using this token.
    Miss(u64),
}

/// How a load ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadOutcome<T> {
    /// Resolved to a value.
    Loaded(T),
    /// Resolved to `null`: not retained.
    Missing,
    /// Rejected: not retained.
    Failed,
}

#[derive(Debug, Clone)]
enum Slot<T> {
    Pending(u64),
    Ready(T),
}

/// Port of `AsyncLru<T>`. Insertion order is the recency order.
#[derive(Debug, Clone)]
pub struct AsyncLru<T> {
    values: Vec<(String, Slot<T>)>,
    max_entries: usize,
    next_token: u64,
}

impl<T: Clone> AsyncLru<T> {
    /// `max_entries` is the JavaScript number; anything but a positive integer
    /// throws in the constructor.
    pub fn new(max_entries: f64) -> Result<Self, InvalidMaxEntries> {
        let max = crate::js::number::f64_to_i64(max_entries)
            .ok()
            .filter(|n| *n >= 1)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(InvalidMaxEntries)?;
        Ok(Self {
            values: Vec::new(),
            max_entries: max,
            next_token: 0,
        })
    }

    /// `get(key, load)` up to the point the load would start.
    pub fn get(&mut self, key: &str) -> Lookup<T> {
        if let Some(at) = self.values.iter().position(|(k, _)| k == key) {
            // delete + set: becomes the most recent.
            let (k, slot) = self.values.remove(at);
            let found = match &slot {
                Slot::Pending(_) => Lookup::Pending,
                Slot::Ready(v) => Lookup::Hit(v.clone()),
            };
            self.values.push((k, slot));
            return found;
        }
        self.next_token += 1;
        let token = self.next_token;
        self.values.push((key.to_owned(), Slot::Pending(token)));
        while self.values.len() > self.max_entries {
            self.values.remove(0);
        }
        Lookup::Miss(token)
    }

    /// The load started for `token` ended. Only the entry still holding that
    /// very load is touched (`this.values.get(key) === pending`).
    pub fn settle(&mut self, key: &str, token: u64, outcome: LoadOutcome<T>) {
        let Some(at) = self.values.iter().position(|(k, _)| k == key) else {
            return;
        };
        let same = self
            .values
            .get(at)
            .is_some_and(|(_, s)| matches!(s, Slot::Pending(t) if *t == token));
        if !same {
            return;
        }
        match outcome {
            LoadOutcome::Loaded(v) => {
                if let Some((_, slot)) = self.values.get_mut(at) {
                    *slot = Slot::Ready(v);
                }
            }
            LoadOutcome::Missing | LoadOutcome::Failed => {
                self.values.remove(at);
            }
        }
    }

    /// Number of cached keys (pending included).
    #[must_use]
    pub fn len(&self) -> usize {
        self.values.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// The keys from least to most recent.
    #[must_use]
    pub fn keys(&self) -> Vec<&str> {
        self.values.iter().map(|(k, _)| k.as_str()).collect()
    }
}
