//! `MemStore` of `timerService.test.ts`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use timo_core::js::ser::to_string;
use timo_core::timer::TimerError;
use timo_core::timer::traits::EntryStore;
use timo_core::timer::types::{
    Acknowledgement, EntryMatch, EntrySyncState, PendingEntrySyncState, ReadRecoveryNotice,
    TimerAwayState, TimerExitIntent, TimerOwner, TimerRecoveryNotice, UnsyncedEntry,
};
use timo_core::today_ledger::LocalLedgerEntry;
use timo_core::types::TimeEntry;

pub struct Inner {
    pub owner: Option<TimerOwner>,
    pub fail_next_upsert: bool,
    /// `store.upsert = () => { throw new Error(msg) }`
    pub fail_upsert_with: Option<String>,
    pub entries: Vec<TimeEntry>,
    pub states: HashMap<String, EntrySyncState>,
    pub ledger_reads: usize,
    pub liveness: Option<f64>,
    pub exit_intent: Option<TimerExitIntent>,
    pub away: Option<TimerAwayState>,
    pub recovery: Option<TimerRecoveryNotice>,
}

/// An in-memory `EntryStore` the tests can poke from outside the service.
#[derive(Clone)]
pub struct MemStore(pub Arc<Mutex<Inner>>);

fn json(entry: &TimeEntry) -> String {
    to_string(entry).unwrap()
}

impl MemStore {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(Inner {
            owner: Some(TimerOwner {
                user_id: "test-user".to_owned(),
                workspace_id: "test-workspace".to_owned(),
            }),
            fail_next_upsert: false,
            fail_upsert_with: None,
            entries: Vec::new(),
            states: HashMap::new(),
            ledger_reads: 0,
            liveness: None,
            exit_intent: None,
            away: None,
            recovery: None,
        })))
    }

    pub fn inner(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `[...store.entries.values()]`.
    pub fn all(&self) -> Vec<TimeEntry> {
        self.inner().entries.clone()
    }

    /// `store.upsert(entry)` called from a test.
    pub fn put(&self, entry: &TimeEntry) -> PendingEntrySyncState {
        self.clone().upsert(entry, None).unwrap()
    }

    pub fn open(&self) -> Option<TimeEntry> {
        self.get_open().unwrap()
    }

    pub fn unsynced(&self) -> Vec<UnsyncedEntry> {
        self.get_unsynced().unwrap()
    }
}

impl Inner {
    fn put(
        &mut self,
        entry: &TimeEntry,
        forced: Option<PendingEntrySyncState>,
    ) -> Result<PendingEntrySyncState, TimerError> {
        if self.fail_next_upsert {
            self.fail_next_upsert = false;
            return Err(TimerError::Store("sqlite_write_failed".to_owned()));
        }
        if let Some(message) = &self.fail_upsert_with {
            return Err(TimerError::Store(message.clone()));
        }
        let existing = self.states.get(&entry.id).copied();
        let next = forced.unwrap_or(match existing {
            Some(EntrySyncState::PendingCreate) | None => PendingEntrySyncState::PendingCreate,
            Some(_) => PendingEntrySyncState::PendingUpdate,
        });
        match self.entries.iter_mut().find(|e| e.id == entry.id) {
            Some(slot) => *slot = entry.clone(),
            None => self.entries.push(entry.clone()),
        }
        self.states.insert(entry.id.clone(), next.into());
        Ok(next)
    }

    fn same(&self, id: &str, expected: &TimeEntry) -> bool {
        self.entries
            .iter()
            .find(|e| e.id == id)
            .is_some_and(|c| json(c) == json(expected))
    }

    fn since(&self, since: f64) -> Vec<TimeEntry> {
        self.entries
            .iter()
            .filter(|e| e.ended_at.is_none_or(|end| end >= since))
            .rev()
            .cloned()
            .collect()
    }
}

impl EntryStore for MemStore {
    fn bind_owner(&mut self, owner: Option<TimerOwner>) {
        self.inner().owner = owner;
    }

    fn current_owner(&self) -> Option<TimerOwner> {
        self.inner().owner.clone()
    }

    fn claim_unowned_entries(&mut self, _: &TimerOwner) -> Result<usize, TimerError> {
        Ok(0)
    }

    fn claim_server_matched_entries(
        &mut self,
        _: &TimerOwner,
        _: &[EntryMatch],
    ) -> Result<usize, TimerError> {
        Ok(0)
    }

    fn upsert(
        &mut self,
        entry: &TimeEntry,
        sync_state: Option<PendingEntrySyncState>,
    ) -> Result<PendingEntrySyncState, TimerError> {
        self.inner().put(entry, sync_state)
    }

    fn switch_entry(
        &mut self,
        closed: &TimeEntry,
        next: &TimeEntry,
    ) -> Result<(PendingEntrySyncState, PendingEntrySyncState), TimerError> {
        let mut inner = self.inner();
        if inner.fail_next_upsert {
            inner.fail_next_upsert = false;
            return Err(TimerError::Store("sqlite_write_failed".to_owned()));
        }
        let first = inner.put(closed, None)?;
        let second = inner.put(next, Some(PendingEntrySyncState::PendingCreate))?;
        Ok((first, second))
    }

    fn get_open(&self) -> Result<Option<TimeEntry>, TimerError> {
        Ok(self
            .inner()
            .entries
            .iter()
            .find(|e| e.ended_at.is_none())
            .cloned())
    }

    fn get_unsynced(&self) -> Result<Vec<UnsyncedEntry>, TimerError> {
        let inner = self.inner();
        Ok(inner
            .entries
            .iter()
            .filter_map(|e| {
                let state = inner
                    .states
                    .get(&e.id)
                    .copied()
                    .unwrap_or(EntrySyncState::PendingCreate);
                match state {
                    EntrySyncState::PendingCreate => Some(PendingEntrySyncState::PendingCreate),
                    EntrySyncState::PendingUpdate => Some(PendingEntrySyncState::PendingUpdate),
                    EntrySyncState::Synced => None,
                }
                .map(|sync_state| UnsyncedEntry {
                    entry: e.clone(),
                    sync_state,
                })
            })
            .collect())
    }

    fn has_unsynced(&self) -> Result<bool, TimerError> {
        Ok(!self.get_unsynced()?.is_empty())
    }

    fn is_pending_create(&self, entry_id: &str) -> Result<bool, TimerError> {
        Ok(self.inner().states.get(entry_id) == Some(&EntrySyncState::PendingCreate))
    }

    fn list_recent(&self, limit: f64) -> Result<Vec<TimeEntry>, TimerError> {
        let n = timo_core::js::number::f64_to_i64(limit).unwrap_or(0).max(0);
        Ok(self
            .inner()
            .entries
            .iter()
            .rev()
            .take(usize::try_from(n).unwrap_or(0))
            .cloned()
            .collect())
    }

    fn list_since(&self, since: f64) -> Result<Vec<TimeEntry>, TimerError> {
        Ok(self.inner().since(since))
    }

    fn list_ledger_entries(&self, since: f64) -> Result<Vec<LocalLedgerEntry>, TimerError> {
        let mut inner = self.inner();
        inner.ledger_reads += 1;
        Ok(inner
            .since(since)
            .into_iter()
            .map(|entry| LocalLedgerEntry {
                sync_state: inner
                    .states
                    .get(&entry.id)
                    .copied()
                    .unwrap_or(EntrySyncState::PendingCreate),
                entry,
                acknowledged_revision: None,
                acknowledged_hash: None,
            })
            .collect())
    }

    fn mark_created(&mut self, entry_id: &str, expected: &TimeEntry) -> Result<bool, TimerError> {
        let mut inner = self.inner();
        if !inner.same(entry_id, expected)
            || inner.states.get(entry_id) != Some(&EntrySyncState::PendingCreate)
        {
            return Ok(false);
        }
        inner
            .states
            .insert(entry_id.to_owned(), EntrySyncState::PendingUpdate);
        Ok(true)
    }

    fn mark_pending_create(
        &mut self,
        entry_id: &str,
        expected: &TimeEntry,
    ) -> Result<bool, TimerError> {
        let mut inner = self.inner();
        if !inner.same(entry_id, expected) {
            return Ok(false);
        }
        inner
            .states
            .insert(entry_id.to_owned(), EntrySyncState::PendingCreate);
        Ok(true)
    }

    fn mark_synced(
        &mut self,
        entry_id: &str,
        expected: &TimeEntry,
        _: &Acknowledgement,
    ) -> Result<bool, TimerError> {
        let mut inner = self.inner();
        if !inner.same(entry_id, expected) {
            return Ok(false);
        }
        inner
            .states
            .insert(entry_id.to_owned(), EntrySyncState::Synced);
        Ok(true)
    }

    fn set_liveness(&mut self, ts: f64) -> Result<(), TimerError> {
        self.inner().liveness = Some(ts);
        Ok(())
    }

    fn get_liveness(&self) -> Result<Option<f64>, TimerError> {
        Ok(self.inner().liveness)
    }

    fn set_exit_intent(&mut self, intent: &TimerExitIntent) -> Result<(), TimerError> {
        self.inner().exit_intent = Some(intent.clone());
        Ok(())
    }

    fn get_exit_intent(&self) -> Result<Option<TimerExitIntent>, TimerError> {
        Ok(self.inner().exit_intent.clone())
    }

    fn clear_exit_intent(&mut self) -> Result<(), TimerError> {
        self.inner().exit_intent = None;
        Ok(())
    }

    fn set_away_state(&mut self, state: &TimerAwayState) -> Result<(), TimerError> {
        self.inner().away = Some(state.clone());
        Ok(())
    }

    fn get_away_state(&self) -> Result<Option<TimerAwayState>, TimerError> {
        Ok(self.inner().away.clone())
    }

    fn clear_away_state(&mut self) -> Result<(), TimerError> {
        self.inner().away = None;
        Ok(())
    }

    fn set_recovery_notice(&mut self, notice: &TimerRecoveryNotice) -> Result<(), TimerError> {
        self.inner().recovery = Some(notice.clone());
        Ok(())
    }

    fn get_recovery_notice(&self) -> Result<Option<ReadRecoveryNotice>, TimerError> {
        Ok(self.inner().recovery.clone().map(ReadRecoveryNotice))
    }

    fn clear_recovery_notice(&mut self) -> Result<(), TimerError> {
        self.inner().recovery = None;
        Ok(())
    }
}
