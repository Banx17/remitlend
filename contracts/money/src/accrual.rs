//! Shared fixed-point accrual math (issue #1382).
//!
//! Every layer that has to reproduce the loan manager's interest accrual —
//! the contract, the backend and the frontend — must agree to the last
//! stroop. The naive formulation
//!
//! ```text
//! interest = principal * rate_bps * elapsed_ledgers / (10_000 * term_ledgers)
//! ```
//!
//! evaluated in each layer's native integer type drifts, because the layers
//! truncate at different points and because a per-ledger rate is not
//! representable in the low precision the contract used to work with (`1e6`).
//! This module defines the *canonical* fixed-point formulation used by all
//! three layers:
//!
//! * a cumulative *index* that accumulates **rate x time** in [`INDEX_SCALE`]
//!   units (`index_delta = rate_bps * elapsed_ledgers * RATE_SCALE`, exact
//!   because `RATE_SCALE = INDEX_SCALE / 10_000` is a whole number),
//! * an interest amount derived from the index delta
//!   (`floor(principal * index_delta / (INDEX_SCALE * term_ledgers / 1e6))`,
//!   carried at `1e-6` stroop precision so that no sub-stroop interest is
//!   lost between windows).
//!
//! The index is the unit of account for "how much rate has this loan
//! accumulated"; every accrual window is a difference of two index values, so
//! the layers only ever have to agree on the index, never on the window
//! boundaries. Because the index accumulates rate x time rather than a
//! truncated per-ledger rate, the interest derived from it is bit-for-bit
//! identical to the contract's previous
//! `principal * rate_bps * elapsed / (10_000 * term)` formulation, while
//! every layer now shares one code path.
//!
//! [`per_ledger_rate_scaled`] is still provided for the layers that have to
//! report the implied per-ledger rate, but it is a *reporting* helper and is
//! never used to accrue interest.
//!
//! [`mul_div`] performs the multiply-then-divide with a **256-bit widened**
//! intermediate product: `a * b` is computed exactly in 256 bits and only
//! then divided, so no precision is lost before the division and the result
//! is identical on every layer. The final quotient is checked against the
//! `i128` range; anything that does not fit is reported as
//! [`MathError::Overflow`] instead of silently wrapping.

use crate::{MathError, RoundingMode};
use core::cmp::Ordering;

/// Scale of the fixed-point index: `1e18` (18 decimal places).
///
/// `INDEX_SCALE` represents a factor of `1.0`; an index delta of
/// `INDEX_SCALE / 100` therefore means "one percent of rate has accrued".
pub const INDEX_SCALE: i128 = 1_000_000_000_000_000_000;

/// Maximum number of ledgers a single accrual window may span.
///
/// Ten years at a five second ledger. It bounds the multiplication inside
/// [`advance_index`] so that a corrupt `last_interest_ledger` cannot inflate
/// the index without limit.
pub const MAX_WINDOW_LEDGERS: i128 = 63_115_200;

/// Scale of the rate x time accumulator inside the index: `INDEX_SCALE /
/// 10_000`, i.e. the factor that turns basis points into a fraction of the
/// index scale. It is a whole number, so multiplying a rate in basis points
/// by it is exact.
pub const RATE_SCALE: i128 = INDEX_SCALE / 10_000;

/// Precision of the interest residual the loan manager carries between
/// accrual windows (one millionth of a stroop).
pub const RESIDUAL_SCALE: i128 = 1_000_000;

const LIMBS: usize = 4; // 4 * 64 = 256 bits

/// A 256-bit unsigned integer, little-endian 64-bit limbs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct U256([u64; LIMBS]);

impl U256 {
    fn from_u128(value: u128) -> U256 {
        U256([value as u64, (value >> 64) as u64, 0, 0])
    }

    fn is_zero(&self) -> bool {
        self.0 == [0; LIMBS]
    }

    /// Exact 256-bit product of two 128-bit values.
    fn mul_u128(a: u128, b: u128) -> U256 {
        const MASK: u128 = u64::MAX as u128;

        let a_lo = a & MASK;
        let a_hi = a >> 64;
        let b_lo = b & MASK;
        let b_hi = b >> 64;

        let ll = a_lo * b_lo;
        let lh = a_lo * b_hi;
        let hl = a_hi * b_lo;
        let hh = a_hi * b_hi;

        // limb 0 and the carry into limb 1.
        let limb0 = ll as u64;
        let mid = (ll >> 64) + (lh & MASK) + (hl & MASK);
        let limb1 = mid as u64;

        // limb 2 accumulates the two cross products' high halves.
        let mid2 = (lh >> 64) + (hl >> 64) + (hh & MASK) + (mid >> 64);
        let limb2 = mid2 as u64;

        // limb 3 holds the top 64 bits of the 256 bit product.
        let limb3 = ((hh >> 64) + (mid2 >> 64)) as u64;

        U256([limb0, limb1, limb2, limb3])
    }

    /// Compare two 192-bit values held in three 64-bit limbs.
    fn cmp192(a: &[u64; 3], b: &[u64; 3]) -> Ordering {
        for idx in (0..3).rev() {
            match a[idx].cmp(&b[idx]) {
                Ordering::Equal => continue,
                other => return other,
            }
        }
        Ordering::Equal
    }

    /// Subtract `b` from `a` (both three limbs), assuming `a >= b`.
    fn sub192(a: &[u64; 3], b: &[u64; 3]) -> [u64; 3] {
        let mut out = [0u64; 3];
        let mut borrow = 0u128;
        for idx in 0..3 {
            let subtrahend = (b[idx] as u128) + borrow;
            let (value, underflow) = (a[idx] as u128).overflowing_sub(subtrahend);
            out[idx] = value as u64;
            borrow = underflow as u128;
        }
        out
    }

    /// Divide by `divisor`, returning the quotient and the remainder.
    ///
    /// Uses a bitwise long division so that the dividend never has to fit in
    /// a native integer: the remainder is kept in three 64-bit limbs, which
    /// is enough because the divisor is at most 128 bits wide.
    fn divmod(&self, divisor: &U256) -> (U256, U256) {
        assert!(!divisor.is_zero(), "division by zero");

        // The divisor is at most 128 bits wide, so the remainder (always
        // smaller than the divisor) fits in two limbs and the shifted
        // remainder (at most `2 * divisor`) fits in three.
        let d = [divisor.0[0], divisor.0[1], divisor.0[2]];

        let mut remainder = [0u64; 3];
        let mut quotient = [0u64; LIMBS];

        for bit in (0..256).rev() {
            // remainder = remainder * 2 + bit
            remainder[2] = (remainder[2] << 1) | (remainder[1] >> 63);
            remainder[1] = (remainder[1] << 1) | (remainder[0] >> 63);
            remainder[0] = (remainder[0] << 1) | ((self.0[bit / 64] >> (bit % 64)) & 1);

            // if remainder >= divisor { remainder -= divisor; quotient bit = 1 }
            if U256::cmp192(&remainder, &d) != Ordering::Less {
                remainder = U256::sub192(&remainder, &d);
                quotient[bit / 64] |= 1u64 << (bit % 64);
            }
        }

        (
            U256(quotient),
            U256([remainder[0], remainder[1], remainder[2], 0]),
        )
    }

    /// Compare the 128 bit low half of two values. Only used for remainder
    /// comparisons, where the high half is known to be zero.
    fn cmp_low(a: &U256, b: &U256) -> Ordering {
        match a.0[1].cmp(&b.0[1]) {
            Ordering::Equal => a.0[0].cmp(&b.0[0]),
            other => other,
        }
    }

    /// Doubled value, used for the "half of the divisor" comparison.
    fn double(&self) -> Option<U256> {
        let mut limbs = [0u64; LIMBS];
        let mut carry = 0u64;
        for (idx, limb) in self.0.iter().enumerate() {
            let value = (*limb as u128) * 2 + (carry as u128);
            limbs[idx] = value as u64;
            carry = (value >> 64) as u64;
        }
        if carry != 0 {
            return None;
        }
        Some(U256(limbs))
    }

    /// Convert to `i128`, failing when the value does not fit.
    fn to_i128(&self) -> Option<i128> {
        if self.0[2] != 0 || self.0[3] != 0 {
            return None;
        }
        let value = ((self.0[1] as u128) << 64) | (self.0[0] as u128);
        if value > i128::MAX as u128 {
            return None;
        }
        Some(value as i128)
    }
}

/// Multiply `a` by `b`, then divide by `d`, applying `mode` to the
/// remainder.
///
/// The product `a * b` is evaluated exactly in 256 bits, so the division
/// sees the full precision of the mathematical result — no intermediate
/// truncation is possible. The rounded result must fit in an `i128`;
/// otherwise [`MathError::Overflow`] is returned.
pub fn mul_div(a: i128, b: i128, d: i128, mode: RoundingMode) -> Result<i128, MathError> {
    if d == 0 {
        return Err(MathError::DivByZero);
    }

    let negative = (a < 0) ^ (b < 0) ^ (d < 0);
    let (a_mag, b_mag, d_mag) = (a.unsigned_abs(), b.unsigned_abs(), d.unsigned_abs());

    let product = U256::mul_u128(a_mag, b_mag);
    let divisor = U256::from_u128(d_mag);
    let (quotient, remainder) = product.divmod(&divisor);

    let mut magnitude = quotient.to_i128().ok_or(MathError::Overflow)?;

    if !remainder.is_zero() {
        let round_away = match mode {
            RoundingMode::Floor => negative,
            RoundingMode::Ceil => !negative,
            RoundingMode::HalfUp => {
                let doubled = remainder.double().ok_or(MathError::Overflow)?;
                U256::cmp_low(&doubled, &divisor) != Ordering::Less
            }
            RoundingMode::HalfEven => {
                let doubled = remainder.double().ok_or(MathError::Overflow)?;
                match U256::cmp_low(&doubled, &divisor) {
                    Ordering::Greater => true,
                    Ordering::Equal => magnitude % 2 != 0,
                    Ordering::Less => false,
                }
            }
        };

        if round_away {
            magnitude = magnitude.checked_add(1).ok_or(MathError::Overflow)?;
        }
    }

    if negative {
        magnitude.checked_neg().ok_or(MathError::Overflow)
    } else {
        Ok(magnitude)
    }
}

/// Per-ledger rate expressed in [`INDEX_SCALE`] units.
///
/// `rate_bps / 10_000` is the rate charged over the whole term, so the
/// per-ledger rate is that value divided by the term length. The result is
/// truncated towards zero at 1e-18 precision, which is far below a stroop for
/// any realistic principal and therefore never changes a settled amount.
pub fn per_ledger_rate_scaled(rate_bps: u32, term_ledgers: i128) -> Result<i128, MathError> {
    if term_ledgers <= 0 {
        return Err(MathError::DivByZero);
    }
    if rate_bps == 0 {
        return Ok(0);
    }
    let numerator = (rate_bps as i128)
        .checked_mul(INDEX_SCALE)
        .ok_or(MathError::Overflow)?;
    let denominator = 10_000i128
        .checked_mul(term_ledgers)
        .ok_or(MathError::Overflow)?;
    mul_div(numerator, 1, denominator, RoundingMode::Floor)
}

/// Index delta accumulated over `ledgers` at `rate_bps`.
///
/// The index accumulates *rate x time* in [`INDEX_SCALE`] units: a rate of
/// `rate_bps` applied for `ledgers` ledgers adds
/// `rate_bps / 10_000 * ledgers * INDEX_SCALE` to the index. The product is
/// exact - `INDEX_SCALE / 10_000` is a whole number - so no precision is
/// lost while the index is advanced, and every layer derives the same
/// interest from the same index.
pub fn index_delta(rate_bps: u32, ledgers: i128) -> Result<i128, MathError> {
    if ledgers < 0 || ledgers > MAX_WINDOW_LEDGERS {
        return Err(MathError::Overflow);
    }
    (rate_bps as i128)
        .checked_mul(ledgers)
        .and_then(|v| v.checked_mul(RATE_SCALE))
        .ok_or(MathError::Overflow)
}

/// Advance a cumulative index by `delta`.
pub fn advance_index(index: i128, delta: i128) -> Result<i128, MathError> {
    if delta < 0 {
        return Err(MathError::Overflow);
    }
    index.checked_add(delta).ok_or(MathError::Overflow)
}

/// Interest accrued on `principal` for an index delta of `index_delta`.
///
/// The result is expressed in units of `1e-6` stroops, which is the
/// precision the loan manager carries its interest residual at: the caller
/// floors the returned value to whole stroops and carries the remainder
/// forward, so no sub-stroop interest is lost across accrual windows.
///
///   interest = principal * index_delta / (INDEX_SCALE * term_ledgers / 1e6)
///
/// Because `index_delta` is exact, this is bit-for-bit identical to the
/// contract's previous `principal * rate_bps * elapsed / (10_000 * term)`
/// formulation while sharing one code path with the backend and frontend.
pub fn interest_from_index_delta(
    principal: i128,
    index_delta: i128,
    term_ledgers: i128,
) -> Result<i128, MathError> {
    if principal < 0 || index_delta < 0 {
        return Err(MathError::Overflow);
    }
    if term_ledgers <= 0 {
        return Err(MathError::DivByZero);
    }
    let denominator = INDEX_SCALE
        .checked_div(RESIDUAL_SCALE)
        .and_then(|v| v.checked_mul(term_ledgers))
        .ok_or(MathError::Overflow)?;
    mul_div(principal, index_delta, denominator, RoundingMode::Floor)
}

/// Factor between two index values, in [`INDEX_SCALE`] units.
///
/// `index_factor(now, origin)` is `1.0` when the index has not moved and
/// grows with every accrued ledger. It is the multiplicative form of the
/// index and is used when a balance is expressed relative to the index value
/// at origination.
pub fn index_factor(index: i128, origin: i128) -> Result<i128, MathError> {
    if origin <= 0 || index < 0 {
        return Err(MathError::Overflow);
    }
    mul_div(index, INDEX_SCALE, origin, RoundingMode::Floor)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn mul_div_matches_plain_integer_math() {
        assert_eq!(mul_div(7, 3, 2, RoundingMode::Floor), Ok(10));
        assert_eq!(mul_div(7, 3, 2, RoundingMode::HalfUp), Ok(11));
        assert_eq!(mul_div(-7, 3, 2, RoundingMode::Floor), Ok(-11));
        assert_eq!(mul_div(-7, 3, 2, RoundingMode::HalfUp), Ok(-11));
        assert_eq!(mul_div(0, 5, 3, RoundingMode::HalfUp), Ok(0));
        assert_eq!(mul_div(5, 0, 3, RoundingMode::HalfUp), Ok(0));
    }

    #[test]
    fn mul_div_rejects_zero_denominator() {
        assert_eq!(
            mul_div(1, 1, 0, RoundingMode::Floor),
            Err(MathError::DivByZero)
        );
    }

    #[test]
    fn mul_div_rounds_half_even_like_the_money_policy() {
        // 5/2 = 2.5 -> 2 (even), 7/2 = 3.5 -> 4 (even), 9/2 = 4.5 -> 4 (even)
        assert_eq!(mul_div(5, 1, 2, RoundingMode::HalfEven), Ok(2));
        assert_eq!(mul_div(7, 1, 2, RoundingMode::HalfEven), Ok(4));
        assert_eq!(mul_div(9, 1, 2, RoundingMode::HalfEven), Ok(4));
        assert_eq!(mul_div(3, 1, 2, RoundingMode::HalfEven), Ok(2));
    }

    #[test]
    fn mul_div_matches_round_div_for_small_values() {
        for a in 0..40i128 {
            for b in 0..40i128 {
                for d in 1..20i128 {
                    for mode in [
                        RoundingMode::Floor,
                        RoundingMode::Ceil,
                        RoundingMode::HalfUp,
                        RoundingMode::HalfEven,
                    ] {
                        assert_eq!(
                            mul_div(a, b, d, mode),
                            crate::round_div(a * b, d, mode),
                            "a={a} b={b} d={d} mode={mode:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn mul_div_uses_the_full_256_bit_product() {
        // 2^63 * 2^63 = 2^126, which still fits in an i128 but the
        // intermediate product of two large values does not.
        let a = 1i128 << 63;
        assert_eq!(mul_div(a, a, 1, RoundingMode::Floor), Ok(1i128 << 126));
        assert_eq!(mul_div(a, a, 2, RoundingMode::Floor), Ok(1i128 << 125));
    }

    #[test]
    fn mul_div_reports_overflow_instead_of_wrapping() {
        let max = i128::MAX;
        assert_eq!(
            mul_div(max, 2, 1, RoundingMode::Floor),
            Err(MathError::Overflow)
        );
        assert_eq!(
            mul_div(max, max, 1, RoundingMode::Floor),
            Err(MathError::Overflow)
        );
    }

    #[test]
    fn mul_div_handles_negative_denominators() {
        assert_eq!(mul_div(7, 3, -2, RoundingMode::Floor), Ok(-11));
        assert_eq!(mul_div(-7, 3, -2, RoundingMode::Floor), Ok(10));
        assert_eq!(mul_div(7, -3, 2, RoundingMode::Floor), Ok(-11));
    }

    #[test]
    fn per_ledger_rate_scaled_is_exact_at_scale() {
        // 1200 bps (12%) spread over 10_000 ledgers => 1.2e-5 per ledger,
        // which is exactly representable in 1e18 units.
        let rate = per_ledger_rate_scaled(1_200, 10_000).unwrap();
        assert_eq!(rate, 12_000_000_000_000);
    }

    #[test]
    fn per_ledger_rate_scaled_rejects_zero_term() {
        assert_eq!(per_ledger_rate_scaled(1_200, 0), Err(MathError::DivByZero));
    }

    #[test]
    fn index_delta_is_exact() {
        // 1200 bps over 4320 ledgers: rate * time in 1e18 units.
        assert_eq!(
            index_delta(1_200, 4_320).unwrap(),
            1_200 * 4_320 * 100_000_000_000_000
        );
    }

    #[test]
    fn index_delta_rejects_absurd_windows() {
        assert_eq!(
            index_delta(1_200, MAX_WINDOW_LEDGERS + 1),
            Err(MathError::Overflow)
        );
        assert_eq!(index_delta(1_200, -1), Err(MathError::Overflow));
    }

    #[test]
    fn advance_index_grows_linearly() {
        let delta = index_delta(1_200, 4_320).unwrap();
        let index = advance_index(INDEX_SCALE, delta).unwrap();
        assert_eq!(index, INDEX_SCALE + 1_200 * 4_320 * 100_000_000_000_000);
    }

    #[test]
    fn interest_from_index_delta_matches_the_flat_formula() {
        // The index formulation must be bit-for-bit identical to the
        // contract's previous `principal * rate * elapsed / (10_000 * term)`
        // computation, otherwise settled amounts would change.
        let principal = 1_000_000_000i128; // 100 tokens
        let rate_bps = 1_200u32;
        let term = 17_280i128;
        for elapsed in [1i128, 100, 4_320, 17_280] {
            let delta = index_delta(rate_bps, elapsed).unwrap();
            let via_index = interest_from_index_delta(principal, delta, term).unwrap();
            let via_formula =
                principal * (rate_bps as i128) * elapsed * 1_000_000 / (10_000 * term);
            assert_eq!(via_index, via_formula, "elapsed={elapsed}");
        }
    }

    #[test]
    fn interest_from_index_delta_floors() {
        // Half a stroop of interest is not payable, it stays in the residual.
        assert_eq!(
            interest_from_index_delta(1, INDEX_SCALE / 2, 1).unwrap(),
            500_000
        );
        assert_eq!(
            interest_from_index_delta(1, INDEX_SCALE / 2 / 1_000_000, 1).unwrap(),
            0
        );
    }

    #[test]
    fn index_factor_is_one_at_origination() {
        assert_eq!(index_factor(INDEX_SCALE, INDEX_SCALE), Ok(INDEX_SCALE));
        assert_eq!(
            index_factor(INDEX_SCALE + INDEX_SCALE / 10, INDEX_SCALE),
            Ok(INDEX_SCALE + INDEX_SCALE / 10)
        );
    }
}
