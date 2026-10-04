//! Port of `legacy/agent/src/main/services/activity/activeWindow.ts`: which app
//! owned the most wall-clock time in a minute.

use serde::{Deserialize, Serialize};

use crate::js::number::{add, max, sort_cmp, sub};

/// Port of `ActiveWindowObservation`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindowObservation {
    pub ts: f64,
    pub app: Option<String>,
    pub app_bundle: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
}

/// Port of `DominantWindow`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DominantWindow {
    pub active_app: Option<String>,
    pub active_app_bundle: Option<String>,
    pub active_title: Option<String>,
    pub active_url: Option<String>,
}

impl DominantWindow {
    fn of(obs: &ActiveWindowObservation) -> Self {
        Self {
            active_app: obs.app.clone(),
            active_app_bundle: obs.app_bundle.clone(),
            active_title: obs.title.clone(),
            active_url: obs.url.clone(),
        }
    }
}

/// JavaScript truthiness of `string | null`: `null` and `''` are falsy.
fn has_text(value: Option<&String>) -> bool {
    value.is_some_and(|s| !s.is_empty())
}

fn is_known(obs: &ActiveWindowObservation) -> bool {
    has_text(obs.app.as_ref()) || has_text(obs.app_bundle.as_ref())
}

/// `` `${o.app ?? ''}\x01${o.appBundle ?? ''}` ``: the separator is the control
/// character U+0001 (invisible in most editors; the inventory misread it as no
/// separator). Two observations share a key only when a name itself contains
/// U+0001, e.g. `("a\u{1}b","c")` and `("a","b\u{1}c")`. Kept on purpose.
fn key_for(obs: &ActiveWindowObservation) -> String {
    format!(
        "{}\u{1}{}",
        obs.app.as_deref().unwrap_or(""),
        obs.app_bundle.as_deref().unwrap_or("")
    )
}

struct Slice<'a> {
    from: f64,
    to: f64,
    obs: &'a ActiveWindowObservation,
}

struct Tally<'a> {
    key: String,
    ms: f64,
    last_obs: &'a ActiveWindowObservation,
}

/// Port of `ActiveWindowTracker`.
#[derive(Debug, Clone)]
pub struct ActiveWindowTracker {
    observations: Vec<ActiveWindowObservation>,
    max_observations: usize,
}

impl Default for ActiveWindowTracker {
    fn default() -> Self {
        Self::new(60)
    }
}

impl ActiveWindowTracker {
    #[must_use]
    pub fn new(max_observations: usize) -> Self {
        Self {
            observations: Vec::new(),
            max_observations,
        }
    }

    /// Record one polled active-window sample; the oldest go past the cap.
    pub fn observe(&mut self, obs: ActiveWindowObservation) {
        self.observations.push(obs);
        if self.observations.len() > self.max_observations {
            let excess = self.observations.len() - self.max_observations;
            self.observations.drain(..excess);
        }
    }

    /// Port of `dominantFor`.
    #[must_use]
    pub fn dominant_for(&self, bucket_start: f64, bucket_end: f64) -> DominantWindow {
        let mut obs: Vec<&ActiveWindowObservation> = self.observations.iter().collect();
        if obs.is_empty() {
            return DominantWindow::default();
        }
        // Stable, like Array.prototype.sort.
        obs.sort_by(|a, b| sort_cmp(a.ts, b.ts));

        let slices = Self::slices(&obs, bucket_start, bucket_end);
        let tallies = Self::tally(&slices);
        if tallies.is_empty() {
            // No slice counted: fall back to the newest observation overall.
            return match obs.last() {
                Some(last) if is_known(last) => DominantWindow::of(last),
                _ => DominantWindow::default(),
            };
        }
        let mut winner: Option<&Tally<'_>> = None;
        for t in &tallies {
            // Strict `>` over insertion order: the first key wins a tie.
            if winner.is_none_or(|w| t.ms > w.ms) {
                winner = Some(t);
            }
        }
        winner.map_or_else(DominantWindow::default, |w| DominantWindow::of(w.last_obs))
    }

    /// The time slices of `[bucketStart, bucketEnd)`, each owned by the
    /// observation that was live during it.
    fn slices<'a>(
        obs: &[&'a ActiveWindowObservation],
        bucket_start: f64,
        bucket_end: f64,
    ) -> Vec<Slice<'a>> {
        let mut prior: Option<&'a ActiveWindowObservation> = None;
        for o in obs {
            if o.ts <= bucket_start {
                prior = Some(*o);
            } else {
                break;
            }
        }
        let Some(start_obs) = prior.or_else(|| obs.first().copied()) else {
            return Vec::new();
        };
        let mut cursor_obs = start_obs;
        let mut cursor_ts = max(
            bucket_start,
            if prior.is_some() {
                bucket_start
            } else {
                start_obs.ts
            },
        );
        let mut slices = Vec::new();
        for next in obs
            .iter()
            .copied()
            .filter(|o| o.ts > bucket_start && o.ts < bucket_end)
        {
            if next.ts > cursor_ts {
                slices.push(Slice {
                    from: cursor_ts,
                    to: next.ts,
                    obs: cursor_obs,
                });
            }
            cursor_obs = next;
            cursor_ts = next.ts;
        }
        if cursor_ts < bucket_end {
            slices.push(Slice {
                from: cursor_ts,
                to: bucket_end,
                obs: cursor_obs,
            });
        }
        slices
    }

    /// Only slices with a positive length and a known app count.
    fn counts(slice: &Slice<'_>) -> bool {
        sub(slice.to, slice.from) > 0.0 && is_known(slice.obs)
    }

    fn tally<'a>(slices: &[Slice<'a>]) -> Vec<Tally<'a>> {
        let mut tallies: Vec<Tally<'a>> = Vec::new();
        for s in slices.iter().filter(|s| Self::counts(s)) {
            let dur = sub(s.to, s.from);
            let key = key_for(s.obs);
            if let Some(t) = tallies.iter_mut().find(|t| t.key == key) {
                t.ms = add(t.ms, dur);
                t.last_obs = s.obs;
            } else {
                tallies.push(Tally {
                    key,
                    ms: dur,
                    last_obs: s.obs,
                });
            }
        }
        tallies
    }

    /// Drop everything older than `before`, keeping the newest older one as the
    /// anchor for the next bucket.
    pub fn prune(&mut self, before: f64) {
        if self.observations.is_empty() {
            return;
        }
        let mut anchor: Option<ActiveWindowObservation> = None;
        let mut kept = Vec::new();
        for o in self.observations.drain(..) {
            if o.ts < before {
                anchor = Some(o);
            } else {
                kept.push(o);
            }
        }
        self.observations = anchor.into_iter().chain(kept).collect();
    }

    /// Count current observations.
    #[must_use]
    pub fn size(&self) -> usize {
        self.observations.len()
    }

    /// Drop all cached observations.
    pub fn clear(&mut self) {
        self.observations.clear();
    }
}
