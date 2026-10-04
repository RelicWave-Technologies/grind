//! A serde serializer that writes exactly what `JSON.stringify` writes.
//!
//! `serde_json` prints `5.0` for a whole double, `1e21` where JavaScript prints
//! `1e+21`, and sorts nothing but also knows nothing of `-0`. Anything that must
//! be byte-identical to the TypeScript's JSON goes through [`to_string`]:
//! numbers use ECMAScript `Number::toString` (`-0` is `0`, `NaN` and the
//! infinities are `null`), strings are quoted as `JSON.stringify` quotes them,
//! and fields appear in declaration order with no whitespace.

use core::fmt::Display;

use serde::Serialize;
use serde::ser::{
    self, Impossible, SerializeMap, SerializeSeq, SerializeStruct, SerializeTuple,
    SerializeTupleStruct,
};
use thiserror::Error;

use super::json::quote;
use super::number::{i64_to_f64, number_to_string};

/// Something JSON.stringify cannot express (or this port does not need).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct SerError(String);

impl ser::Error for SerError {
    fn custom<T: Display>(msg: T) -> Self {
        Self(msg.to_string())
    }
}

/// `JSON.stringify(value)`.
pub fn to_string<T: Serialize + ?Sized>(value: &T) -> Result<String, SerError> {
    let mut out = String::new();
    value.serialize(Writer { out: &mut out })?;
    Ok(out)
}

fn unsupported<T>(what: &str) -> Result<T, SerError> {
    Err(SerError(format!(
        "{what} is not supported by the JSON.stringify writer"
    )))
}

struct Writer<'a> {
    out: &'a mut String,
}

/// An open `[...]` or `{...}`.
struct Compound<'a> {
    out: &'a mut String,
    first: bool,
    close: char,
}

impl<'a> Compound<'a> {
    fn open(out: &'a mut String, open: char, close: char) -> Self {
        out.push(open);
        Self {
            out,
            first: true,
            close,
        }
    }

    fn separator(&mut self) {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
    }

    fn finish(self) {
        self.out.push(self.close);
    }
}

impl<'a> ser::Serializer for Writer<'a> {
    type Ok = ();
    type Error = SerError;
    type SerializeSeq = Compound<'a>;
    type SerializeTuple = Compound<'a>;
    type SerializeTupleStruct = Compound<'a>;
    type SerializeTupleVariant = Impossible<(), SerError>;
    type SerializeMap = Compound<'a>;
    type SerializeStruct = Compound<'a>;
    type SerializeStructVariant = Impossible<(), SerError>;

    fn serialize_bool(self, v: bool) -> Result<(), SerError> {
        self.out.push_str(if v { "true" } else { "false" });
        Ok(())
    }

    fn serialize_i8(self, v: i8) -> Result<(), SerError> {
        self.serialize_f64(f64::from(v))
    }

    fn serialize_i16(self, v: i16) -> Result<(), SerError> {
        self.serialize_f64(f64::from(v))
    }

    fn serialize_i32(self, v: i32) -> Result<(), SerError> {
        self.serialize_f64(f64::from(v))
    }

    fn serialize_i64(self, v: i64) -> Result<(), SerError> {
        let exact = i64_to_f64(v).map_err(|e| SerError(e.to_string()))?;
        self.serialize_f64(exact)
    }

    fn serialize_u8(self, v: u8) -> Result<(), SerError> {
        self.serialize_f64(f64::from(v))
    }

    fn serialize_u16(self, v: u16) -> Result<(), SerError> {
        self.serialize_f64(f64::from(v))
    }

    fn serialize_u32(self, v: u32) -> Result<(), SerError> {
        self.serialize_f64(f64::from(v))
    }

    fn serialize_u64(self, v: u64) -> Result<(), SerError> {
        let signed = i64::try_from(v).map_err(|e| SerError(e.to_string()))?;
        self.serialize_i64(signed)
    }

    fn serialize_f32(self, v: f32) -> Result<(), SerError> {
        self.serialize_f64(f64::from(v))
    }

    fn serialize_f64(self, v: f64) -> Result<(), SerError> {
        if v.is_finite() {
            self.out.push_str(&number_to_string(v));
        } else {
            self.out.push_str("null");
        }
        Ok(())
    }

    fn serialize_char(self, v: char) -> Result<(), SerError> {
        self.serialize_str(v.encode_utf8(&mut [0; 4]))
    }

    fn serialize_str(self, v: &str) -> Result<(), SerError> {
        self.out.push_str(&quote(v));
        Ok(())
    }

    fn serialize_bytes(self, _: &[u8]) -> Result<(), SerError> {
        unsupported("bytes")
    }

    fn serialize_none(self) -> Result<(), SerError> {
        self.serialize_unit()
    }

    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<(), SerError> {
        value.serialize(self)
    }

    fn serialize_unit(self) -> Result<(), SerError> {
        self.out.push_str("null");
        Ok(())
    }

    fn serialize_unit_struct(self, _: &'static str) -> Result<(), SerError> {
        self.serialize_unit()
    }

    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
    ) -> Result<(), SerError> {
        self.serialize_str(variant)
    }

    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        value: &T,
    ) -> Result<(), SerError> {
        value.serialize(self)
    }

    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: &T,
    ) -> Result<(), SerError> {
        unsupported("newtype variant")
    }

    fn serialize_seq(self, _: Option<usize>) -> Result<Compound<'a>, SerError> {
        Ok(Compound::open(self.out, '[', ']'))
    }

    fn serialize_tuple(self, len: usize) -> Result<Compound<'a>, SerError> {
        self.serialize_seq(Some(len))
    }

    fn serialize_tuple_struct(self, _: &'static str, len: usize) -> Result<Compound<'a>, SerError> {
        self.serialize_seq(Some(len))
    }

    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Impossible<(), SerError>, SerError> {
        unsupported("tuple variant")
    }

    fn serialize_map(self, _: Option<usize>) -> Result<Compound<'a>, SerError> {
        Ok(Compound::open(self.out, '{', '}'))
    }

    fn serialize_struct(self, _: &'static str, _: usize) -> Result<Compound<'a>, SerError> {
        self.serialize_map(None)
    }

    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Impossible<(), SerError>, SerError> {
        unsupported("struct variant")
    }
}

impl SerializeSeq for Compound<'_> {
    type Ok = ();
    type Error = SerError;

    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), SerError> {
        self.separator();
        value.serialize(Writer { out: self.out })
    }

    fn end(self) -> Result<(), SerError> {
        self.finish();
        Ok(())
    }
}

impl SerializeTuple for Compound<'_> {
    type Ok = ();
    type Error = SerError;

    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), SerError> {
        SerializeSeq::serialize_element(self, value)
    }

    fn end(self) -> Result<(), SerError> {
        SerializeSeq::end(self)
    }
}

impl SerializeTupleStruct for Compound<'_> {
    type Ok = ();
    type Error = SerError;

    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), SerError> {
        SerializeSeq::serialize_element(self, value)
    }

    fn end(self) -> Result<(), SerError> {
        SerializeSeq::end(self)
    }
}

impl SerializeMap for Compound<'_> {
    type Ok = ();
    type Error = SerError;

    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), SerError> {
        self.separator();
        key.serialize(Writer { out: self.out })?;
        self.out.push(':');
        Ok(())
    }

    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), SerError> {
        value.serialize(Writer { out: self.out })
    }

    fn end(self) -> Result<(), SerError> {
        self.finish();
        Ok(())
    }
}

impl SerializeStruct for Compound<'_> {
    type Ok = ();
    type Error = SerError;

    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), SerError> {
        SerializeMap::serialize_key(self, key)?;
        SerializeMap::serialize_value(self, value)
    }

    fn end(self) -> Result<(), SerError> {
        self.finish();
        Ok(())
    }
}
