//! Splitting JSON text into the raw text of its members, so a replay can compare
//! whole values byte for byte and still read a few of them as inputs.
#![allow(
    clippy::string_slice,
    clippy::indexing_slicing,
    reason = "the scanner slices text it just measured; the fixture is trusted"
)]

/// End offset of the JSON value starting at `start` (at an object/array/string/scalar).
pub fn value_end(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    let mut depth = 0_usize;
    let mut in_string = false;
    let mut i = start;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            match b {
                b'\\' => i += 1,
                b'"' => {
                    in_string = false;
                    if depth == 0 {
                        return i + 1;
                    }
                }
                _ => {}
            }
        } else {
            match b {
                b'"' => in_string = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' | b',' if depth == 0 => return i,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return i + 1;
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    bytes.len()
}

/// The `(key, raw value text)` members of a JSON object, in order.
pub fn object_members(text: &str) -> Vec<(String, String)> {
    let bytes = text.as_bytes();
    assert_eq!(bytes.first(), Some(&b'{'), "not an object: {text}");
    let mut members = Vec::new();
    let mut i = 1;
    while i < bytes.len() && bytes[i] != b'}' {
        if bytes[i] == b',' {
            i += 1;
        }
        let key_end = value_end(text, i);
        let key = text[i + 1..key_end - 1].to_owned();
        assert_eq!(bytes[key_end], b':', "malformed member in {text}");
        let end = value_end(text, key_end + 1);
        members.push((key, text[key_end + 1..end].to_owned()));
        i = end;
    }
    members
}

/// The raw text of each item of a JSON array.
pub fn array_items(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    assert_eq!(bytes.first(), Some(&b'['), "not an array: {text}");
    let mut items = Vec::new();
    let mut i = 1;
    while i < bytes.len() && bytes[i] != b']' {
        if bytes[i] == b',' {
            i += 1;
        }
        let end = value_end(text, i);
        items.push(text[i..end].to_owned());
        i = end;
    }
    items
}

/// `JSON.stringify(JSON.parse(text))` for pretty-printed text: whitespace outside
/// strings removed, every number and string and the key order untouched.
pub fn minify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in text.chars() {
        if in_string {
            out.push(c);
            match (escaped, c) {
                (true, _) => escaped = false,
                (false, '\\') => escaped = true,
                (false, '"') => in_string = false,
                _ => {}
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
    out
}
