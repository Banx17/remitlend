/**
 * Cross-layer fixed-point accrual math — frontend implementation (#1382).
 *
 * This module is the frontend's mirror of `contracts/money/src/accrual.rs` and
 * `backend/src/money/fixedPoint.ts`. It lets the UI project the amount a loan
 * will owe at a given ledger with the *same* arithmetic the contract settles
 * with, so a projected amount never disagrees with the settled one.
 *
 * The shared formulation is:
 *
 *   index_delta   = rate_bps / 10_000 * elapsed_ledgers        (1e18 scaled)
 *   index         = 1e18 + sum(index_delta)                    (cumulative)
 *   interest      = principal * index_delta / (1e18 * term)     (floored)
 *
 * Note: bigint literal syntax (`0n`) is deliberately avoided throughout this
 * file in favor of `BigInt(0)` — the frontend's `tsconfig.json` targets
 * ES2017, and `tsc` rejects BigInt literals below ES2020.
 */
import { RoundingMode, roundDiv, MoneyError } from "./format";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);
const TEN_THOUSAND = BigInt(10000);

/** Scale of the fixed-point index: `1e18` (18 decimal places). */
export const INDEX_SCALE = BigInt("1000000000000000000");

/**
 * Scale of the rate x time accumulator inside the index: `INDEX_SCALE /
 * 10_000`. Multiplying a rate in basis points by it is exact.
 */
export const RATE_SCALE = INDEX_SCALE / TEN_THOUSAND;

/** Precision of the interest residual the contract carries between windows. */
export const RESIDUAL_SCALE = BigInt(1000000);

/** Maximum number of ledgers a single accrual window may span (~10 years). */
export const MAX_WINDOW_LEDGERS = BigInt(63115200);

/** Largest magnitude the contract's `i128` arithmetic can represent. */
const I128_MAX = (ONE << BigInt(127)) - ONE;

/** Largest magnitude the contract's widened 256-bit product can represent. */
const U256_MAX = (ONE << BigInt(256)) - ONE;

/**
 * Multiply `a` by `b`, then divide by `d`, applying `mode` to the remainder.
 *
 * Mirrors `money::accrual::mul_div`: the product is evaluated exactly (the
 * contract in 256 bits, the frontend in `bigint`) and the division sees the
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
  if (d === ZERO) {
    throw new MoneyError("division by zero");
  }

  const product = a * b;
  if (product > U256_MAX || product < -U256_MAX) {
    throw new MoneyError("mul_div: the widened 256-bit product overflowed");
  }

  const result = roundDiv(product, d, mode);
  if (result > I128_MAX || result < -I128_MAX) {
    throw new MoneyError("mul_div: the result does not fit in i128");
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
  if (l < ZERO || l > MAX_WINDOW_LEDGERS) {
    throw new MoneyError(`index_delta: ${l} ledgers is outside the supported window`);
  }
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new MoneyError(`index_delta: invalid rate ${rateBps}`);
  }
  return BigInt(rateBps) * l * RATE_SCALE;
}

/** Advance a cumulative index by `delta`. */
export function advanceIndex(index: bigint, delta: bigint): bigint {
  if (delta < ZERO) {
    throw new MoneyError("advance_index: the delta must not be negative");
  }
  const updated = index + delta;
  if (updated > I128_MAX) {
    throw new MoneyError("advance_index: the index overflowed i128");
  }
  return updated;
}

/**
 * Interest accrued on `principal` for an index delta of `indexDeltaValue`.
 *
 * The result is expressed in units of 1e-6 stroops, matching the precision
 * the contract carries its interest residual at.
 */
export function interestFromIndexDelta(
  principal: bigint,
  indexDeltaValue: bigint,
  termLedgers: bigint | number,
): bigint {
  if (principal < ZERO || indexDeltaValue < ZERO) {
    throw new MoneyError("interest_from_index_delta: negative input");
  }
  const term = BigInt(termLedgers);
  if (term <= ZERO) {
    throw new MoneyError("interest_from_index_delta: the term must be positive");
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
  if (term <= ZERO) {
    throw new MoneyError("per_ledger_rate_scaled: the term must be positive");
  }
  return mulDiv(
    BigInt(rateBps) * INDEX_SCALE,
    ONE,
    TEN_THOUSAND * term,
    RoundingMode.Floor,
  );
}

/**
 * Factor between two index values, in 1e18 units.
 *
 * `indexFactor(now, origin)` is `1.0` when the index has not moved.
 */
export function indexFactor(index: bigint, origin: bigint): bigint {
  if (origin <= ZERO || index < ZERO) {
    throw new MoneyError("index_factor: invalid input");
  }
  return mulDiv(index, INDEX_SCALE, origin, RoundingMode.Floor);
}

/**
 * Project the interest a loan will have accrued at `targetLedger`.
 *
 * `settledIndex` is the loan's index at `settledLedger` (as reported by the
 * contract's `loan_index` view or by the backend's `interest_index` table) and
 * `settledInterest` the interest the contract had already booked at that
 * point. The projection is expressed in whole stroops and uses the same
 * flooring the contract applies, so it never over-states what the borrower
 * will owe.
 */
export function projectAccruedInterest(params: {
  principalStroops: bigint;
  rateBps: number;
  termLedgers: bigint | number;
  settledIndex: bigint;
  settledLedger: bigint | number;
  targetLedger: bigint | number;
  settledInterestStroops?: bigint;
}): bigint {
  const { principalStroops, rateBps, termLedgers } = params;
  const settledIndex = params.settledIndex;
  const settled = BigInt(params.settledLedger);
  const target = BigInt(params.targetLedger);
  const settledInterest = params.settledInterestStroops ?? ZERO;

  if (target <= settled) {
    return settledInterest;
  }
  if (principalStroops <= ZERO) {
    return settledInterest;
  }

  const elapsed = target - settled;
  // The exact index delta of the window — the same accumulation the contract
  // performs, so the projection cannot drift away from the settlement.
  const windowDelta = indexDelta(rateBps, elapsed);
  const projectedIndex = advanceIndex(settledIndex, windowDelta);

  // The whole-stroop interest of the window, with the sub-stroop remainder
  // dropped exactly like the contract drops it.
  const scaled = interestFromIndexDelta(
    principalStroops,
    projectedIndex - settledIndex,
    termLedgers,
  );
  const window = scaled / RESIDUAL_SCALE;

  return settledInterest + window;
}
