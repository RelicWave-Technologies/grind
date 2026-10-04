//! The two URL encoders the TypeScript calls, byte for byte.

/// One uppercase hex digit of a nibble.
fn hex_digit(nibble: u8) -> char {
    char::from(if nibble < 10 {
        b'0' + nibble
    } else {
        b'A' + nibble - 10
    })
}

fn push_percent(out: &mut String, byte: u8) {
    out.push('%');
    out.push(hex_digit(byte >> 4));
    out.push(hex_digit(byte & 0x0F));
}

/// `new URLSearchParams(pairs).toString()`: application/x-www-form-urlencoded.
/// Keeps `A-Za-z0-9*-._`, writes a space as `+`, escapes every other byte of the
/// UTF-8 as `%XX`.
#[must_use]
pub fn search_params(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (i, (key, value)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        form_encode(&mut out, key);
        out.push('=');
        form_encode(&mut out, value);
    }
    out
}

fn form_encode(out: &mut String, text: &str) {
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            other => push_percent(out, other),
        }
    }
}

/// `encodeURIComponent(text)`: keeps `A-Za-z0-9-_.!~*'()`.
#[must_use]
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(char::from(byte)),
            other => push_percent(&mut out, other),
        }
    }
    out
}
