//! The layout of a stored entry: key order and unknown keys.
//!
//! The TypeScript reads a row with `{...raw, revision, closeReason, pauseReason}` and
//! changes it only by object spread (`{...entry, endedAt}`), so the key order the row
//! was written in, and any key this version does not know (the `projectId`/`taskId` of
//! the first betas), survive to the next `JSON.stringify`. That text is also what the
//! `json = ?` guards of `markCreated`/`markPendingCreate`/`markSynced` compare. An entry
//! therefore remembers its layout and writes itself back the same way: an existing key
//! keeps its place when its value changes, a missing key is appended at the end.
//!
//! A fresh entry has no layout and is written in the order of `createTimeEntry`'s
//! object literal, which is also the order of the struct.

use core::fmt;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::TimeEntry;

/// A JSON value whose objects keep their key order (`serde_json::Value` sorts them).
/// Numbers are doubles, as `JSON.parse` makes them.
#[derive(Debug, Clone, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

impl Serialize for JsonValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(b) => serializer.serialize_bool(*b),
            Self::Number(n) => serializer.serialize_f64(*n),
            Self::String(s) => serializer.serialize_str(s),
            Self::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Self::Object(members) => {
                let mut map = serializer.serialize_map(Some(members.len()))?;
                for (key, value) in members {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = JsonValue;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_unit<E>(self) -> Result<JsonValue, E> {
        Ok(JsonValue::Null)
    }

    fn visit_bool<E>(self, v: bool) -> Result<JsonValue, E> {
        Ok(JsonValue::Bool(v))
    }

    fn visit_f64<E>(self, v: f64) -> Result<JsonValue, E> {
        Ok(JsonValue::Number(v))
    }

    // `JSON.parse` reads every number as the nearest double: so does parsing the text.
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<JsonValue, E> {
        v.to_string()
            .parse()
            .map(JsonValue::Number)
            .map_err(E::custom)
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<JsonValue, E> {
        v.to_string()
            .parse()
            .map(JsonValue::Number)
            .map_err(E::custom)
    }

    fn visit_str<E>(self, v: &str) -> Result<JsonValue, E> {
        Ok(JsonValue::String(v.to_owned()))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<JsonValue, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(JsonValue::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<JsonValue, A::Error> {
        let mut members: Vec<(String, JsonValue)> = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, JsonValue>()? {
            // `JSON.parse` keeps the first position and the last value of a repeated key.
            match members.iter_mut().find(|(existing, _)| *existing == key) {
                Some(slot) => slot.1 = value,
                None => members.push((key, value)),
            }
        }
        Ok(JsonValue::Object(members))
    }
}

impl<'de> Deserialize<'de> for JsonValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ValueVisitor)
    }
}

impl JsonValue {
    /// As a `serde_json::Value`, for the typed reads (key order is not kept).
    #[must_use]
    pub fn to_serde(&self) -> serde_json::Value {
        match self {
            Self::Null => serde_json::Value::Null,
            Self::Bool(b) => serde_json::Value::Bool(*b),
            Self::Number(n) => {
                serde_json::Number::from_f64(*n).map_or(serde_json::Value::Null, Into::into)
            }
            Self::String(s) => serde_json::Value::String(s.clone()),
            Self::Array(items) => items.iter().map(Self::to_serde).collect(),
            Self::Object(members) => members
                .iter()
                .map(|(k, v)| (k.clone(), v.to_serde()))
                .collect(),
        }
    }
}

/// The keys of `TimeEntry`, in the order of `createTimeEntry`'s object literal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    Id,
    ClientUuid,
    UserId,
    LarkTaskGuid,
    Source,
    Revision,
    StartedAt,
    EndedAt,
    PauseReason,
    CloseReason,
    Segments,
}

const CANONICAL: [Key; 11] = [
    Key::Id,
    Key::ClientUuid,
    Key::UserId,
    Key::LarkTaskGuid,
    Key::Source,
    Key::Revision,
    Key::StartedAt,
    Key::EndedAt,
    Key::PauseReason,
    Key::CloseReason,
    Key::Segments,
];

impl Key {
    const fn name(self) -> &'static str {
        match self {
            Self::Id => "id",
            Self::ClientUuid => "clientUuid",
            Self::UserId => "userId",
            Self::LarkTaskGuid => "larkTaskGuid",
            Self::Source => "source",
            Self::Revision => "revision",
            Self::StartedAt => "startedAt",
            Self::EndedAt => "endedAt",
            Self::PauseReason => "pauseReason",
            Self::CloseReason => "closeReason",
            Self::Segments => "segments",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        CANONICAL.into_iter().find(|key| key.name() == name)
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Slot {
    Known(Key),
    Extra(String, JsonValue),
}

/// Where each key of a stored entry sits. `Default` is "no layout": the canonical order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EntryShape(Option<Vec<Slot>>);

/// The three keys `parseEntry` adds when a row lacks them, in its order.
pub const PARSE_ADDS: [&str; 3] = ["revision", "closeReason", "pauseReason"];

impl EntryShape {
    /// The layout of a stored object, then of the spread `parseEntry` makes of it:
    /// `missing` names the keys it appends when the row lacks them.
    #[must_use]
    pub fn from_doc(doc: &[(String, JsonValue)], missing: &[&str]) -> Self {
        let mut slots: Vec<Slot> = doc
            .iter()
            .map(|(name, value)| {
                Key::from_name(name)
                    .map_or_else(|| Slot::Extra(name.clone(), value.clone()), Slot::Known)
            })
            .collect();
        for name in missing {
            if let Some(key) = Key::from_name(name)
                && !slots.contains(&Slot::Known(key))
            {
                slots.push(Slot::Known(key));
            }
        }
        let has_guid = slots.contains(&Slot::Known(Key::LarkTaskGuid));
        let canonical: Vec<Slot> = CANONICAL
            .into_iter()
            .filter(|key| has_guid || *key != Key::LarkTaskGuid)
            .map(Slot::Known)
            .collect();
        Self((slots != canonical).then_some(slots))
    }

    /// The entry's members, in layout order, then any known key the layout lacks.
    pub fn write<M: SerializeMap>(&self, entry: &TimeEntry, map: &mut M) -> Result<(), M::Error> {
        let Some(slots) = &self.0 else {
            return CANONICAL.into_iter().try_for_each(|k| entry.put(k, map));
        };
        for slot in slots {
            match slot {
                Slot::Known(key) => entry.put(*key, map)?,
                Slot::Extra(name, value) => map.serialize_entry(name, value)?,
            }
        }
        CANONICAL
            .into_iter()
            .filter(|key| !slots.contains(&Slot::Known(*key)))
            .try_for_each(|key| entry.put(key, map))
    }
}

impl TimeEntry {
    /// One known member; `larkTaskGuid` is the only one that can be absent.
    fn put<M: SerializeMap>(&self, key: Key, map: &mut M) -> Result<(), M::Error> {
        let name = key.name();
        match key {
            Key::Id => map.serialize_entry(name, &self.id),
            Key::ClientUuid => map.serialize_entry(name, &self.client_uuid),
            Key::UserId => map.serialize_entry(name, &self.user_id),
            Key::LarkTaskGuid => self
                .lark_task_guid
                .as_ref()
                .map_or(Ok(()), |guid| map.serialize_entry(name, guid)),
            Key::Source => map.serialize_entry(name, &self.source),
            Key::Revision => map.serialize_entry(name, &self.revision),
            Key::StartedAt => map.serialize_entry(name, &self.started_at),
            Key::EndedAt => map.serialize_entry(name, &self.ended_at),
            Key::PauseReason => map.serialize_entry(name, &self.pause_reason),
            Key::CloseReason => map.serialize_entry(name, &self.close_reason),
            Key::Segments => map.serialize_entry(name, &self.segments),
        }
    }
}
