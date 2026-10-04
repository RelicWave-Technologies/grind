//! `timer_meta`: liveness and the three JSON records. SQL from `sqliteStore.ts`.

use rusqlite::{OptionalExtension, named_params, params};
use serde::Serialize;
use serde_json::Value;
use timo_core::js::number::number_to_string;
use timo_core::js::ser::to_string;
use timo_core::timer::TimerError;

use super::db::{db_err, lock};
use super::entry_store::SqliteEntryStore;
use super::js_number::number_from_string;

const UPSERT_META: &str = "INSERT INTO timer_meta (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value";

impl SqliteEntryStore {
    fn meta_value(&self, key: &str) -> Result<Option<String>, TimerError> {
        let Some(owner) = &self.owner else {
            return Ok(None);
        };
        lock(&self.db)
            .query_row(
                "SELECT value FROM timer_meta WHERE key = ?",
                params![Self::meta_key(owner, key)],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_err)
    }

    /// `setLiveness`: `String(ts)`.
    pub(super) fn write_liveness(&self, ts: f64) -> Result<(), TimerError> {
        let owner = self.require_owner()?;
        lock(&self.db)
            .execute(
                UPSERT_META,
                named_params! { "@key": Self::meta_key(owner, "liveness"), "@value": number_to_string(ts) },
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// `getLiveness`: `Number(value)`, non-finite is `null`.
    pub(super) fn read_liveness(&self) -> Result<Option<f64>, TimerError> {
        Ok(self
            .meta_value("liveness")?
            .map(|text| number_from_string(&text))
            .filter(|n| n.is_finite()))
    }

    /// `setJsonMeta`: `JSON.stringify(value)`.
    pub(super) fn set_json_meta<T: Serialize>(
        &self,
        key: &str,
        value: &T,
    ) -> Result<(), TimerError> {
        let owner = self.require_owner()?;
        let text = to_string(value).map_err(|e| TimerError::Store(e.to_string()))?;
        lock(&self.db)
            .execute(
                UPSERT_META,
                named_params! { "@key": Self::meta_key(owner, key), "@value": text },
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// `getJsonMeta`: unparseable JSON is `null`.
    pub(super) fn get_json_meta(&self, key: &str) -> Result<Option<Value>, TimerError> {
        Ok(self
            .meta_value(key)?
            .and_then(|text| serde_json::from_str::<Value>(&text).ok()))
    }

    /// `deleteMeta`: a no-op without an owner.
    pub(super) fn delete_meta(&self, key: &str) -> Result<(), TimerError> {
        let Some(owner) = &self.owner else {
            return Ok(());
        };
        lock(&self.db)
            .execute(
                "DELETE FROM timer_meta WHERE key = ?",
                params![Self::meta_key(owner, key)],
            )
            .map_err(db_err)?;
        Ok(())
    }
}
