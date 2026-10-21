/**
 * hooks/useOwedProjection.ts
 *
 * Projects the amount a loan will owe at a given ledger (#1382).
 *
 * The loan manager settles an accrual window on every repayment, and the
 * interest of a window is charged on the principal that was outstanding
 * during it. The backend replays those windows and reports the amount that
 * is owed right now; the UI wants to show what the loan *will* owe a little
 * later without contradicting the contract.
 *
 * This hook projects with the same arithmetic the contract settles with
 * (see `frontend/lib/money/accrual.ts`, the mirror of
 * `contracts/money/src/accrual.rs`), so:
 *
 *  – at the settled ledger the projection *is* the settled value,
 *  – one ledger later it differs from the settled value by at most the
 *    interest of a single ledger,
 *  – it can never drift away from the amount the contract settles.
 */

import { useMemo } from "react";
import { INDEX_SCALE, projectAccruedInterest } from "../../../lib/money/accrual";

export interface OwedProjectionInput {
  /** Principal of the loan, in stroops. */
  principalStroops: bigint;
  /** Amount already repaid, in stroops. */
  repaidStroops?: bigint;
  /** Interest rate of the loan, in basis points. */
  rateBps: number;
  /** Term of the loan, in ledgers. */
  termLedgers: number;
  /** The loan's cumulative accrual index, as settled on-chain. */
  settledIndex?: bigint;
  /** The ledger the last settlement was made at. */
  settledLedger?: number;
  /** The interest that was settled on-chain, in stroops. */
  settledInterestStroops?: bigint;
  /** The ledger to project to. */
  targetLedger: number;
}

export interface OwedProjection {
  /** The projected outstanding interest, in stroops. */
  interestStroops: bigint;
  /** The projected amount owed, in stroops. */
  owedStroops: bigint;
  /** The principal that is still outstanding, in stroops. */
  remainingPrincipalStroops: bigint;
  /** Whether the projection is the settled value (there is nothing to project). */
  isSettled: boolean;
}

/**
 * Project the amount a loan owes at `targetLedger`.
 */
export function useOwedProjection(input: OwedProjectionInput): OwedProjection {
  const {
    principalStroops,
    repaidStroops,
    rateBps,
    termLedgers,
    settledIndex,
    settledLedger,
    settledInterestStroops,
    targetLedger,
  } = input;

  return useMemo(() => {
    const settled = settledLedger ?? 0;
    const repaid = repaidStroops ?? BigInt(0);
    const remainingPrincipalStroops =
      principalStroops > repaid ? principalStroops - repaid : BigInt(0);

    const interestStroops = projectAccruedInterest({
      principalStroops: remainingPrincipalStroops,
      rateBps,
      termLedgers,
      settledIndex: settledIndex ?? INDEX_SCALE,
      settledLedger: settled,
      targetLedger,
      settledInterestStroops,
    });

    return {
      interestStroops,
      owedStroops: remainingPrincipalStroops + interestStroops,
      remainingPrincipalStroops,
      isSettled: targetLedger <= settled,
    };
  }, [
    principalStroops,
    repaidStroops,
    rateBps,
    termLedgers,
    settledIndex,
    settledLedger,
    settledInterestStroops,
    targetLedger,
  ]);
}

export default useOwedProjection;
