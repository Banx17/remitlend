/**
 * Accrued-interest math for backend loan views (issues #1600 and #1382).
 *
 * The loan manager contract accrues interest on the *remaining* principal
 * (`loan.amount - loan.principal_paid`, see `accrue_interest` in
 * `contracts/loan_manager/src/lib.rs`), not on the originally approved
 * amount. The backend's event store records each `LoanRepaid` event as a
 * single total amount (the contract publishes one amount; the
 * principal/interest split is contract-internal state), so the
 * principal-repayment signal available from `contract_events` is the
 * cumulative repaid total.
 *
 * Issue #1382 makes the accrual *windowed*: the contract settles an accrual
 * window on every repayment and charges the interest of a window on the
 * principal that was outstanding during it, so a loan that is repaid in two
 * instalments is not charged the interest of the whole term on the original
 * principal. The backend replays those windows here:
 *
 * - `accrueWindows` walks the windows of a loan (the windows that were
 *   closed by a repayment, plus the window that is still open) and charges
 *   each window on the principal that was outstanding during it.
 * - The interest of a closed window is taken from the `interest_index`
 *   snapshot the indexer stored for the contract's `accrue` event when the
 *   snapshot is available, and recomputed with the shared fixed-point math
 *   (`./fixedPoint.js`) when it is not. The recomputation uses the same
 *   1e-6 stroop residual as the contract, so both paths agree to the last
 *   stroop.
 * - `splitRepayment` mirrors the contract's `proportional_repayment_split`:
 *   a repayment is shared between the outstanding principal, the accrued
 *   interest and the late fees with the largest-remainder method, capped by
 *   each bucket. The contract publishes the repaid amount only, so the
 *   split is what tells the replay how much principal a window left.
 *
 * Dispute freeze: when a loan has an open dispute, both the list and detail
 * endpoints stop accrual at the ledger closest to (at or before) the open
 * dispute's creation instead of at the current ledger. The detail endpoint
 * resolves that freeze ledger from `loan_disputes`/`contract_events`, and the
 * borrower-list SQL mirrors the same lookup, so a disputed loan reports
 * identical `accruedInterest` and `totalOwed` values through either endpoint.
 *
 * All amounts are integer stroop counts (the unit `contract_events.amount`
 * is stored in, mirroring `contracts/money`); callers convert to display
 * units at the API boundary.
 */
import { roundDiv, RoundingMode, MoneyError } from './decimal.js';
import { indexDelta, interestFromIndexDelta, RESIDUAL_SCALE } from './fixedPoint.js';

/**
 * Parse a `contract_events.amount` value into a bigint stroop count.
 *
 * The column is Postgres `NUMERIC` and can format an integer stroop count
 * with an all-zero fractional part (e.g. `150.0`), so accept that but reject
 * any genuinely fractional stroop amount rather than silently truncating
 * it.
 */
export function parseStroopAmount(raw: string | null | undefined): bigint {
  if (!raw) return 0n;
  const [wholeRaw, fraction = ''] = raw.split('.');
  const whole = wholeRaw && wholeRaw.length > 0 ? wholeRaw : '0';
  if (fraction.length > 0 && /[1-9]/.test(fraction)) {
    throw new MoneyError(`amount must be an integer stroop count, got "${raw}"`);
  }
  return BigInt(whole);
}

/**
 * Remaining unpaid principal (`principal - repaid`), floored at zero once
 * the loan is fully repaid so accrual never goes negative.
 */
export function remainingPrincipal(principalStroops: bigint, totalRepaidStroops: bigint): bigint {
  return principalStroops > totalRepaidStroops ? principalStroops - totalRepaidStroops : 0n;
}

/**
 * Simple interest accrued on `remainingPrincipalStroops` over
 * `elapsedLedgers` at `interestRateBps` across `termLedgers`, floored to a
 * whole stroop count.
 *
 * Mirrors the contract's `accrue_interest` formula in
 * `contracts/loan_manager/src/lib.rs`:
 *
 *   remaining_principal * rate_bps * elapsed_ledgers / (10_000 * term_ledgers)
 *
 * (The contract evaluates that numerator at 1e6 intermediate precision and
 * carries the fractional remainder forward as `interest_residual`; the
 * floored integer result here is identical for display purposes, since the
 * residual is at most one stroop and never rounds a value up.)
 */
export function accrueInterest(params: {
  remainingPrincipalStroops: bigint;
  interestRateBps: number;
  elapsedLedgers: number;
  termLedgers: number;
}): bigint {
  const { remainingPrincipalStroops, interestRateBps, elapsedLedgers, termLedgers } = params;
  if (
    remainingPrincipalStroops <= 0n ||
    interestRateBps <= 0 ||
    elapsedLedgers <= 0 ||
    termLedgers <= 0
  ) {
    return 0n;
  }
  const numerator = remainingPrincipalStroops * BigInt(interestRateBps) * BigInt(elapsedLedgers);
  const denominator = 10_000n * BigInt(termLedgers);
  return roundDiv(numerator, denominator, RoundingMode.Floor);
}

/**
 * A settlement of a loan: a repayment that closed an accrual window.
 *
 * The loan manager accrues interest when a window closes, not continuously:
 * every repayment settles the interest accrued so far and starts a new
 * window on the remaining principal.
 */
export interface LoanSettlement {
  /** Ledger the settlement happened at. */
  ledger: number;
  /** Amount repaid, in whole stroops. */
  amountStroops: bigint;
  /**
   * Interest the contract booked for the window this settlement closed, in
   * whole stroops (from the `accrue` event).
   *
   * When it is present the contract's own number is used, so the off-chain
   * view reports exactly the amount the contract settled. When it is absent
   * (loans that predate the accrual index) the window is recomputed with
   * the shared fixed-point math.
   */
  bookedInterestStroops?: bigint;
  /**
   * Residual the contract carried into the next window, in millionths of a
   * stroop.
   */
  residual?: bigint;
}

/**
 * The result of replaying a loan's accrual windows.
 */
export interface WindowedAccrual {
  /** Interest accrued in each window, in whole stroops. */
  windowInterestStroops: bigint[];
  /** Interest accrued and not yet paid, in whole stroops. */
  outstandingInterestStroops: bigint;
  /** Principal that has not been repaid, in whole stroops. */
  remainingPrincipalStroops: bigint;
  /** Total amount repaid across the settlements, in whole stroops. */
  totalRepaidStroops: bigint;
  /** Ledger the last window was closed at. */
  lastSettledLedger: number;
}

/**
 * Interest accrued on `principalStroops` over one accrual window.
 *
 * Mirrors the contract's `accrue_interest`: the interest is computed at
 * 1e-6 of a stroop, floored to whole stroops, and the remainder is carried
 * into the next window together with the residual that was carried into this
 * one.
 *
 * @returns the interest of the window in whole stroops and the residual to
 * carry into the next window, in millionths of a stroop.
 */
export function accrueWindowInterest(params: {
  principalStroops: bigint;
  interestRateBps: number;
  elapsedLedgers: number;
  termLedgers: number;
  residual: bigint;
}): { interestStroops: bigint; residual: bigint } {
  const { principalStroops, interestRateBps, elapsedLedgers, termLedgers, residual } = params;
  if (
    principalStroops <= 0n ||
    interestRateBps <= 0 ||
    elapsedLedgers <= 0 ||
    termLedgers <= 0
  ) {
    return { interestStroops: 0n, residual };
  }

  const delta = indexDelta(interestRateBps, BigInt(elapsedLedgers));
  // The interest of the window in millionths of a stroop.
  const totalInterest = interestFromIndexDelta(
    principalStroops,
    delta,
    BigInt(termLedgers),
  );

  const interestDelta = totalInterest / RESIDUAL_SCALE;
  const newResidual = totalInterest - interestDelta * RESIDUAL_SCALE;
  const combinedResidual = residual + newResidual;
  const additionalInterest = combinedResidual / RESIDUAL_SCALE;
  const finalResidual = combinedResidual - additionalInterest * RESIDUAL_SCALE;

  return {
    interestStroops: interestDelta + additionalInterest,
    residual: finalResidual,
  };
}

/**
 * Split a repayment across the outstanding principal, interest and late fee.
 *
 * Mirrors the contract's `proportional_repayment_split`: every bucket
 * receives the share of the repayment that matches its share of the total
 * debt, the largest remainder wins the leftover stroops, and no bucket can
 * be paid more than it is owed.
 */
export function splitRepayment(dues: bigint[], amountStroops: bigint): bigint[] {
  const payments = dues.map(() => 0n);
  const remainders = dues.map(() => -1n);

  const totalDebt = dues.reduce((sum, due) => sum + due, 0n);
  if (totalDebt <= 0n || amountStroops <= 0n) {
    return payments;
  }

  // The contract rejects a repayment that exceeds the total debt, so a
  // settlement never does. Cap it anyway: a bucket must never be paid more
  // than it is owed.
  const amount = amountStroops > totalDebt ? totalDebt : amountStroops;

  let allocated = 0n;
  dues.forEach((due, idx) => {
    if (due <= 0n) return;
    const scaled = amount * due;
    const payment = roundDiv(scaled, totalDebt, RoundingMode.Floor);
    payments[idx] = payment;
    remainders[idx] = scaled - payment * totalDebt;
    allocated += payment;
  });

  let unallocated = amount - allocated;
  while (unallocated > 0n) {
    let selected: number | null = null;
    for (let idx = 0; idx < dues.length; idx += 1) {
      const due = dues[idx] ?? 0n;
      const payment = payments[idx] ?? 0n;
      const remainder = remainders[idx] ?? -1n;
      if (due <= payment || remainder < 0n) continue;
      const best = selected === null ? -1n : (remainders[selected] ?? -1n);
      if (selected === null || remainder > best) {
        selected = idx;
      }
    }
    if (selected === null) break;
    payments[selected] = (payments[selected] ?? 0n) + 1n;
    remainders[selected] = -1n;
    unallocated -= 1n;
  }

  return payments;
}

/**
 * Replay a loan's accrual windows and report what the loan currently owes.
 *
 * The loan manager settles an accrual window whenever the loan is repaid,
 * liquidated or refinanced. Each window accrues interest on the principal
 * that was outstanding during it, and the repayment is then split across
 * the outstanding principal, the accrued interest and the accrued late fee.
 * Replaying those windows reproduces the contract's own numbers off-chain;
 * computing a single window over the whole term instead (the previous
 * behaviour) drifts as soon as a loan is repaid in more than one instalment.
 */
export function accrueWindows(params: {
  principalStroops: bigint;
  interestRateBps: number;
  termLedgers: number;
  /** Ledger the loan was approved at; the first window starts here. */
  approvedLedger: number;
  /** Settlements in any order; they are replayed in ledger order. */
  settlements: LoanSettlement[];
  /** Ledger the open window ends at. */
  currentLedger: number;
  /** Late fee charged on the loan so far, in whole stroops. */
  lateFeeStroops?: bigint;
}): WindowedAccrual {
  const {
    principalStroops,
    interestRateBps,
    termLedgers,
    approvedLedger,
    currentLedger,
  } = params;

  const settlements = [...params.settlements].sort((a, b) => a.ledger - b.ledger);

  let remainingPrincipal = principalStroops > 0n ? principalStroops : 0n;
  let outstandingInterest = 0n;
  let lateFeeDue = params.lateFeeStroops ?? 0n;
  let residual = 0n;
  let lastLedger = approvedLedger;
  const windowInterestStroops: bigint[] = [];

  for (const settlement of settlements) {
    const elapsed = Math.max(0, settlement.ledger - lastLedger);
    let interest: bigint;
    if (settlement.bookedInterestStroops !== undefined) {
      // The contract booked this window itself: use its number so the
      // off-chain view matches the on-chain one exactly.
      interest = settlement.bookedInterestStroops;
      residual = settlement.residual ?? residual;
    } else {
      const window = accrueWindowInterest({
        principalStroops: remainingPrincipal,
        interestRateBps,
        elapsedLedgers: elapsed,
        termLedgers,
        residual,
      });
      interest = window.interestStroops;
      residual = window.residual;
    }
    outstandingInterest += interest;
    windowInterestStroops.push(interest);

    const [principalPayment = 0n, interestPayment = 0n, lateFeePayment = 0n] = splitRepayment(
      [remainingPrincipal, outstandingInterest, lateFeeDue],
      settlement.amountStroops,
    );
    remainingPrincipal -= principalPayment;
    outstandingInterest -= interestPayment;
    lateFeeDue -= lateFeePayment;
    lastLedger = settlement.ledger;
  }

  // The open window: the interest accrued since the last settlement.
  const openWindow = accrueWindowInterest({
    principalStroops: remainingPrincipal,
    interestRateBps,
    elapsedLedgers: Math.max(0, currentLedger - lastLedger),
    termLedgers,
    residual,
  });
  outstandingInterest += openWindow.interestStroops;
  windowInterestStroops.push(openWindow.interestStroops);

  return {
    windowInterestStroops,
    outstandingInterestStroops: outstandingInterest,
    remainingPrincipalStroops: remainingPrincipal,
    totalRepaidStroops: settlements.reduce((sum, s) => sum + s.amountStroops, 0n),
    lastSettledLedger: lastLedger,
  };
}
