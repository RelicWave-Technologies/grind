//! Hand-written tests for the `js` helpers that have no JavaScript counterpart
//! to dump (checked conversions) or that deliberately refuse input
//! (`Date` strings outside the supported ISO shapes).
#![cfg(test)]

use timo_core::js::date::{DateParse, parse};
use timo_core::js::number::{NumberError, f64_to_i64, i64_to_f64};

mod checked_conversions {
    use super::*;

    #[test]
    fn i64_to_f64_is_exact_or_an_error() {
        assert_eq!(i64_to_f64(0), Ok(0.0));
        assert_eq!(
            i64_to_f64(-9_007_199_254_740_992),
            Ok(-9_007_199_254_740_992.0)
        );
        assert_eq!(
            i64_to_f64(9_007_199_254_740_992),
            Ok(9_007_199_254_740_992.0)
        );
        // 2^53 + 1 is the first integer a double cannot hold.
        assert_eq!(
            i64_to_f64(9_007_199_254_740_993),
            Err(NumberError::NotRepresentable(9_007_199_254_740_993))
        );
        // 2^53 + 2 is representable.
        assert_eq!(
            i64_to_f64(9_007_199_254_740_994),
            Ok(9_007_199_254_740_994.0)
        );
        assert_eq!(
            i64_to_f64(i64::MAX),
            Err(NumberError::NotRepresentable(i64::MAX))
        );
        assert_eq!(i64_to_f64(i64::MIN), Ok(-9_223_372_036_854_775_808.0));
    }

    #[test]
    fn f64_to_i64_accepts_only_whole_numbers_in_range() {
        assert_eq!(f64_to_i64(5.0), Ok(5));
        assert_eq!(f64_to_i64(-0.0), Ok(0));
        assert_eq!(f64_to_i64(-9_223_372_036_854_775_808.0), Ok(i64::MIN));
        assert_eq!(
            f64_to_i64(9_007_199_254_740_994.0),
            Ok(9_007_199_254_740_994)
        );
        for bad in [
            1.5,
            -0.5,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            9_223_372_036_854_775_808.0,
            1e300,
        ] {
            assert!(
                matches!(f64_to_i64(bad), Err(NumberError::NotAnInteger(_))),
                "{bad}"
            );
        }
    }
}

mod date_strings_outside_the_supported_shapes {
    use super::*;

    #[test]
    fn are_reported_unsupported_rather_than_guessed() {
        for s in [
            "2024-01-01T00:00:00",      // no offset: V8 reads local time
            "2024-01-01T00:00:00.5",    // same
            "2024-01-01 00:00:00Z",     // space separator (legacy parser)
            "2024-01-01t00:00:00z",     // lower case (legacy parser)
            "2024-06-15Z",              // date-only with a zone
            "2024-01-01T00:00:00+0530", // offset without a colon
            "hello 2020",               // V8 ignores leading words
            "Jan 1 2020",
            "2020/01/02",
            " 2024-01-01T00:00:00Z",
            "-000000-01-01", // legacy path, local time
            "2024-001",
        ] {
            assert_eq!(parse(s), DateParse::Unsupported, "{s:?}");
        }
    }

    #[test]
    fn the_empty_string_is_an_invalid_date() {
        assert_eq!(parse(""), DateParse::Invalid);
    }

    #[test]
    fn supported_shapes_parse() {
        assert_eq!(parse("1970-01-01T00:00:01.000Z"), DateParse::Time(1000.0));
        assert_eq!(parse("2024-02-30"), DateParse::Time(1_709_251_200_000.0)); // V8 rolls Feb 30 into March
        assert_eq!(parse("2024-13-01T00:00:00Z"), DateParse::Invalid);
    }
}
