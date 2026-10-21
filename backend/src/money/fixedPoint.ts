/**
 * Cross-layer fixed-point accrual math — backend implementation (#1382).
 *
 * This module is the backend's mirror of `contracts/money/src/accrual.rs`. It
 * is the *only* place in the backend that may derive an accrued interest
 * amount, and it derives it the same way the contract does, so the amount
 * the API reports and the amount the contract settles are the same number.
 *
 * The shared formulation is:
 *
 *   index_delta   = rate_bps / 10_000 * elapsed_ledgers        (1e18 scaled)
 *   index         = 1e18 + sum(index_delta)                    (cumulative)
 *   interest      = principal * index_delta / (1e18 * term)     (floored)
 *
 * The interest is floored at 1e-6 of a stroop — the precision the contract
 * carries its interest residual at — so the sub-stroop remainder can be
 * carried forward exactly like the contract carries it.
 *
 * The contract multiplies in 256 bits (see `money::accrual::mul_div`); the
 * backend uses `bigint` and applies the same explicit range checks so an
 * out-of-range value fails loudly here instead of silently producing a
 * number the contract could never settle.
 */
import { RoundingMode, roundDiv, MoneyError } from './decimal.js';

/** Scale of the fixed-point index: `1e18` (18 decimal places). */
export const INDEX_SCALE = 1_000_000_000_000_000_000n;

/**
 * Scale of the rate x time accumulator inside the index: `INDEX_SCALE /
 * 10_000`. Multiplying a rate in basis points by it is exact.
 */
export const RATE_SCALE = INDEX_SCALE / 10_000n;

/** Precision of the interest residual the contract carries between windows. */
export const RESIDUAL_SCALE = 1_000_000n;

/** Maximum number of ledgers a single accrual window may span (~10 years). */
export const MAX_WINDOW_LEDGERS = 63_115_200n;

/** Largest magnitude the contract's `i128` arithmetic can represent. */
const I128_MAX = (1n << 127n) - 1n;

/** Largest magnitude the contract's widened 256-bit product can represent. */
const U256_MAX = (1n << 256n) - 1n;

/**
 * Multiply `a` by `b`, then divide by `d`, applying `mode` to the remainder.
 *
 * Mirrors `money::accrual::mul_div`: the product is evaluated exactly (the
 * contract in 256 bits, the backend in `bigint`) and the division sees the
 * full precision of the mathematical result.
 *
 * @throws {MoneyError} when the divisor is zero, when the product does not
 * fit the contract's 256-bit product, or when the result does not fit the
 * contract's `i128` range.
 */
export function mulDiv(
  a: bigint,
  b: bigint,
  d: bigint,
  mode: RoundingMode = RoundingMode.HalfUp,
): bigint {
  if (d === 0n) {
    throw new MoneyError('division by zero');
  }

  const product = a * b;
  if (product > U256_MAX || product < -U256_MAX) {
    throw new MoneyError('mul_div: the widened 256-bit product overflowed');
  }

  const result = roundDiv(product, d, mode);
  if (result > I128_MAX || result < -I128_MAX) {
    throw new MoneyError('mul_div: the result does not fit in i128');
  }
  return result;
}

/**
 * Index delta accumulated over `ledgers` at `rateBps`.
 *
 * The index accumulates *rate x time* in 1e18 units. The product is exact, so
 * no precision is lost while the index advances.
 */
export function indexDelta(rateBps: number, ledgers: bigint | number): bigint {
  const l = BigInt(ledgers);
  if (l < 0n || l > MAX_WINDOW_LEDGERS) {
    throw new MoneyError(`index_delta: ${l} ledgers is outside the supported window`);
  }
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new MoneyError(`index_delta: invalid rate ${rateBps}`);
  }
  return BigInt(rateBps) * l * RATE_SCALE;
}

/** Advance a cumulative index by `delta`. */
export function advanceIndex(index: bigint, delta: bigint): bigint {
  if (delta < 0n) {
    throw new MoneyError('advance_index: the delta must not be negative');
  }
  const updated = index + delta;
  if (updated > I128_MAX) {
    throw new MoneyError('advance_index: the index overflowed i128');
  }
  return updated;
}

/**
 * Interest accrued on `principal` for an index delta of `indexDelta`.
 *
 * The result is expressed in units of 1e-6 stroops, matching the precision
 * the contract carries its interest residual at: the caller floors it to
 * whole stroops and carries the remainder forward.
 */
export function interestFromIndexDelta(
  principal: bigint,
  indexDeltaValue: bigint,
  termLedgers: bigint | number,
): bigint {
  if (principal < 0n || indexDeltaValue < 0n) {
    throw new MoneyError('interest_from_index_delta: negative input');
  }
  const term = BigInt(termLedgers);
  if (term <= 0n) {
    throw new MoneyError('interest_from_index_delta: the term must be positive');
  }
  const denominator = (INDEX_SCALE / RESIDUAL_SCALE) * term;
  return mulDiv(principal, indexDeltaValue, denominator, RoundingMode.Floor);
}

/**
 * Per-ledger rate expressed in 1e18 units.
 *
 * `rateBps / 10_000` is the rate charged over the whole term, so the
 * per-ledger rate is that value divided by the term length.
 */
export function perLedgerRateScaled(
  rateBps: number,
  termLedgers: bigint | number,
): bigint {
  const term = BigInt(termLedgers);
  if (term <= 0n) {
    throw new MoneyError('per_ledger_rate_scaled: the term must be positive');
  }
  return mulDiv(BigInt(rateBps) * INDEX_SCALE, 1n, 10_000n * term, RoundingMode.Floor);
}

/**
 * Factor between two index values, in 1e18 units.
 *
 * `indexFactor(now, origin)` is `1.0` when the index has not moved.
 */
export function indexFactor(index: bigint, origin: bigint): bigint {
  if (origin <= 0n || index < 0n) {
    throw new MoneyError('index_factor: invalid input');
  }
  return mulDiv(index, INDEX_SCALE, origin, RoundingMode.Floor);
}
