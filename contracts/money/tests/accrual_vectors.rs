//! Golden-vector parity test (issue #1382).
//!
//! The vectors in `contracts/testdata/accrual_vectors.json` are the contract's
//! reference values. The backend and the frontend replay the same file in
//! their own test suites, so a change in one layer that moves an accrual
//! number fails the CI job that runs all three.

use money::accrual::{
    advance_index, index_delta, interest_from_index_delta, per_ledger_rate_scaled, INDEX_SCALE,
    RATE_SCALE, RESIDUAL_SCALE,
};
use serde_json::Value;

const VECTORS: &str = include_str!("../../testdata/accrual_vectors.json");

/// Read an integer from the vector file.
///
/// Amounts are stored as strings because they exceed the safe integer range;
/// small counters are stored as plain numbers. Both are accepted.
fn as_i128(value: &Value, key: &str) -> i128 {
    let raw = value
        .get(key)
        .unwrap_or_else(|| panic!("missing key {key}"));
    match raw {
        Value::String(text) => text
            .parse::<i128>()
            .unwrap_or_else(|_| panic!("key {key} must be a decimal string")),
        Value::Number(number) => number
            .as_i64()
            .unwrap_or_else(|| panic!("key {key} must be an integer"))
            as i128,
        _ => panic!("key {key} must be a string or a number"),
    }
}

#[test]
fn golden_vectors_match_the_contract_implementation() {
    let doc: Value = serde_json::from_str(VECTORS).expect("the golden vectors must be valid JSON");

    assert_eq!(as_i128(&doc, "indexScale"), INDEX_SCALE);
    assert_eq!(as_i128(&doc, "rateScale"), RATE_SCALE);
    assert_eq!(as_i128(&doc, "residualScale"), RESIDUAL_SCALE);

    let vectors = doc
        .get("vectors")
        .and_then(Value::as_array)
        .expect("the golden vectors must hold a vectors array");
    assert!(!vectors.is_empty(), "the golden vectors must not be empty");

    for vector in vectors {
        let name = vector.get("name").and_then(Value::as_str).unwrap_or("?");

        let rate_bps = vector
            .get("rateBps")
            .and_then(Value::as_u64)
            .expect("rateBps") as u32;
        let term_ledgers = as_i128(vector, "termLedgers");
        let principal = as_i128(vector, "principalStroops");
        let elapsed = as_i128(vector, "elapsedLedgers");

        let delta = index_delta(rate_bps, elapsed).expect("index delta");
        assert_eq!(delta, as_i128(vector, "indexDelta"), "{name}: index delta");

        let index = advance_index(INDEX_SCALE, delta).expect("index");
        assert_eq!(index, as_i128(vector, "indexAfter"), "{name}: index");

        let rate_scaled = per_ledger_rate_scaled(rate_bps, term_ledgers).expect("per ledger rate");
        assert_eq!(
            rate_scaled,
            as_i128(vector, "perLedgerRateScaled"),
            "{name}: per ledger rate"
        );

        let interest = interest_from_index_delta(principal, delta, term_ledgers).expect("interest");
        assert_eq!(
            interest,
            as_i128(vector, "interestScaled"),
            "{name}: interest"
        );

        assert_eq!(
            interest / RESIDUAL_SCALE,
            as_i128(vector, "interestStroops"),
            "{name}: interest in stroops"
        );
    }
}
