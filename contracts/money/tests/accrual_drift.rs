//! Randomised drift and monotonicity checks for the shared accrual math.
//!
//! The contract used to accrue interest from a truncated per-ledger rate,
//! which made the accrued amount depend on *how* a term was split into
//! windows. The fixed-point index removes that dependency: the interest of a
//! window is a function of the index delta, and the index delta is exact.
//! These tests assert that property over random inputs:
//!
//! * the index based interest is within one stroop of the closed form,
//! * splitting a term into windows does not change the total,
//! * the accrued interest never decreases as time passes.

use money::accrual::{advance_index, index_delta, interest_from_index_delta, RESIDUAL_SCALE};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

/// The interest the contract used to compute, evaluated exactly.
///
/// `floor(principal * rate_bps * elapsed / (10_000 * term_ledgers))`.
fn closed_form(principal: i128, rate_bps: u32, elapsed: i128, term_ledgers: i128) -> i128 {
    let numerator = principal as u128 * rate_bps as u128 * elapsed as u128;
    let denominator = 10_000u128 * term_ledgers as u128;
    (numerator / denominator) as i128
}

/// The interest the index based accrual produces, in whole stroops.
fn indexed(principal: i128, rate_bps: u32, elapsed: i128, term_ledgers: i128) -> i128 {
    let delta = index_delta(rate_bps, elapsed).unwrap();
    let scaled = interest_from_index_delta(principal, delta, term_ledgers).unwrap();
    scaled / RESIDUAL_SCALE
}

fn principal(rng: &mut StdRng) -> i128 {
    // 1 token to 10_000_000 tokens, in stroops.
    let tokens = rng.gen_range(1u64..10_000_000_000);
    (tokens as i128) * 10_000_000
}

#[test]
fn indexed_interest_matches_the_closed_form_within_one_stroop() {
    let mut rng = StdRng::seed_from_u64(0x1382_0001);
    for _ in 0..2_000 {
        let p = principal(&mut rng);
        let rate_bps: u32 = rng.gen_range(0..=10_000);
        let term_ledgers: i128 = rng.gen_range(1..=100_000);
        let elapsed: i128 = rng.gen_range(0..=term_ledgers);

        let expected = closed_form(p, rate_bps, elapsed, term_ledgers);
        let actual = indexed(p, rate_bps, elapsed, term_ledgers);
        let drift = (expected - actual).abs();
        assert!(
            drift <= 1,
            "p={p} rate={rate_bps} term={term_ledgers} elapsed={elapsed} \
             expected={expected} actual={actual} drift={drift}"
        );
    }
}

#[test]
fn splitting_a_term_into_windows_does_not_change_the_total() {
    let mut rng = StdRng::seed_from_u64(0x1382_0002);
    for _ in 0..2_000 {
        let p = principal(&mut rng);
        let rate_bps: u32 = rng.gen_range(0..=10_000);
        let term_ledgers: i128 = rng.gen_range(1..=100_000);
        let total: i128 = rng.gen_range(0..=term_ledgers);
        let split_at: i128 = rng.gen_range(0..=total);

        let whole =
            interest_from_index_delta(p, index_delta(rate_bps, total).unwrap(), term_ledgers)
                .unwrap();

        let first =
            interest_from_index_delta(p, index_delta(rate_bps, split_at).unwrap(), term_ledgers)
                .unwrap();
        let second = interest_from_index_delta(
            p,
            index_delta(rate_bps, total - split_at).unwrap(),
            term_ledgers,
        )
        .unwrap();

        // The two windows are floored independently, so the total can be at
        // most one stroop below the undivided window, and never above it.
        let split = first + second;
        assert!(
            split <= whole && whole - split < RESIDUAL_SCALE,
            "p={p} rate={rate_bps} term={term_ledgers} total={total} \
             split_at={split_at} whole={whole} split={split}"
        );
    }
}

#[test]
fn accrued_interest_never_decreases() {
    let mut rng = StdRng::seed_from_u64(0x1382_0003);
    for _ in 0..1_000 {
        let p = principal(&mut rng);
        let rate_bps: u32 = rng.gen_range(0..=10_000);
        let term_ledgers: i128 = rng.gen_range(1..=100_000);

        let mut index = 0i128;
        let mut accrued = 0i128;
        let mut previous = 0i128;
        for _ in 0..10 {
            let ledgers: i128 = rng.gen_range(0..=10_000);
            let delta = index_delta(rate_bps, ledgers).unwrap();
            index = advance_index(index, delta).unwrap();
            accrued += interest_from_index_delta(p, delta, term_ledgers).unwrap();
            assert!(
                accrued >= previous,
                "p={p} rate={rate_bps} term={term_ledgers} accrued={accrued} previous={previous}"
            );
            previous = accrued;
        }
    }
}

#[test]
fn the_index_only_moves_forward() {
    let mut rng = StdRng::seed_from_u64(0x1382_0004);
    let mut index = 0i128;
    for _ in 0..1_000 {
        let rate_bps: u32 = rng.gen_range(0..=10_000);
        let ledgers: i128 = rng.gen_range(0..=10_000);
        let delta = index_delta(rate_bps, ledgers).unwrap();
        let next = advance_index(index, delta).unwrap();
        assert!(next >= index);
        index = next;
    }
}
