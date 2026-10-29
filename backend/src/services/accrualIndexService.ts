/**
 * Accrual index snapshots (#1382).
 *
 * The loan manager publishes an `accrue` event whenever it settles an
 * accrual window. The event carries the loan's cumulative index, the index
 * delta of the window, the interest the window produced and the sub-stroop
 * residual that was carried into the next window. The event indexer stores
 * those snapshots in the `interest_index` table; this service reads them
 * back so the loan endpoints can reproduce the contract's own accrual
 * off-chain instead of re-deriving it from a single one-shot formula.
 */
import { query } from '../db/connection.js';
import logger from '../utils/logger.js';
import { parseStroopAmount } from '../money/loanAccrual.js';

/**
 * A snapshot of one settled accrual window.
 */
export interface AccrueSnapshot {
  /** Ledger the window was settled at. */
  ledger: number;
  /** Interest the contract booked for the window, in whole stroops. */
  interestStroops: bigint;
  /** Residual the contract carried into the next window, in millionths of a stroop. */
  residual: bigint;
}

/**
 * Load the accrual snapshots of the given loans.
 *
 * The snapshots are grouped by loan id and ordered by ledger, so a caller
 * can pair them with the settlements (repayments) that closed the windows.
 * A loan that has no snapshots - a loan that predates the accrual index, or
 * a loan whose snapshots have not been indexed yet - simply has none, and
 * the caller recomputes the window with the shared fixed-point math.
 */
export async function loadAccrueSnapshots(
  loanIds: number[],
): Promise<Map<number, AccrueSnapshot[]>> {
  const byLoan = new Map<number, AccrueSnapshot[]>();
  if (loanIds.length === 0) {
    return byLoan;
  }

  let rows: Record<string, unknown>[];
  try {
    const result = await query(
      `SELECT loan_id, ledger, interest_delta, residual
         FROM interest_index
        WHERE loan_id = ANY($1::int[])
        ORDER BY loan_id ASC, ledger ASC, id ASC`,
      [loanIds],
    );
    rows = result.rows as Record<string, unknown>[];
  } catch (error) {
    // The table is created by a migration; a deployment that has not run it
    // yet must still serve the loan endpoints.
    logger.withContext().warn('Failed to load accrual index snapshots', { error });
    return byLoan;
  }

  for (const row of rows) {
    const loanId = Number(row.loan_id);
    const ledger = Number(row.ledger);
    if (!Number.isFinite(loanId) || !Number.isFinite(ledger)) {
      continue;
    }
    const snapshots = byLoan.get(loanId) ?? [];
    snapshots.push({
      ledger,
      interestStroops: parseStroopAmount(String(row.interest_delta ?? '0')),
      residual: parseStroopAmount(String(row.residual ?? '0')),
    });
    byLoan.set(loanId, snapshots);
  }

  return byLoan;
}

/**
 * Pair the settlements of a loan with the accrual snapshots that closed
 * their windows.
 *
 * A snapshot and the settlement that closed its window are published in the
 * same transaction, so they share a ledger. A settlement without a snapshot
 * - a repayment that happened in the same ledger as the previous one, so
 * the contract had no window to settle - is left without booked interest
 * and is recomputed by the caller.
 *
 * @returns the snapshot of every settlement, in the order of the
 * settlements. An entry is `undefined` when the contract did not settle a
 * window for that settlement.
 */
export function pairSnapshotsWithSettlements(
  settlements: { ledger: number }[],
  snapshots: AccrueSnapshot[],
): (AccrueSnapshot | undefined)[] {
  const byLedger = new Map<number, AccrueSnapshot[]>();
  for (const snapshot of snapshots) {
    const queue = byLedger.get(snapshot.ledger) ?? [];
    queue.push(snapshot);
    byLedger.set(snapshot.ledger, queue);
  }

  return settlements.map((settlement) => byLedger.get(settlement.ledger)?.shift());
}
