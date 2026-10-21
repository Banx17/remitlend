/**
 * hooks/useOwedProjection.test.ts
 *
 * Unit tests for useOwedProjection (#1382):
 *  – the projection at the settled ledger is the settled value
 *  – one ledger later the projection stays within one ledger of the
 *    settled value
 *  – the projection never disagrees with the amount the contract settles
 */

import { renderHook } from "@testing-library/react";
import { useOwedProjection } from "./useOwedProjection";
import { projectAccruedInterest } from "../../../lib/money/accrual";

const PRINCIPAL = BigInt("10000000000"); // 1_000 tokens in stroops
const RATE_BPS = 1200;
const TERM_LEDGERS = 17280;
const APPROVED_LEDGER = 20;
// A quarter of the term: 300 tokens of interest on 1_000 tokens at 12%.
const SETTLED_LEDGER = APPROVED_LEDGER + 4320;
const SETTLED_INTEREST = BigInt("300000000");
const SETTLED_INDEX = BigInt("1000000000000000000") + BigInt("518400000000000000000");

describe("useOwedProjection", () => {
  it("yields to the settled value at the settled ledger", () => {
    const { result } = renderHook(() =>
      useOwedProjection({
        principalStroops: PRINCIPAL,
        rateBps: RATE_BPS,
        termLedgers: TERM_LEDGERS,
        settledIndex: SETTLED_INDEX,
        settledLedger: SETTLED_LEDGER,
        settledInterestStroops: SETTLED_INTEREST,
        targetLedger: SETTLED_LEDGER,
      }),
    );

    expect(result.current.isSettled).toBe(true);
    expect(result.current.interestStroops).toBe(SETTLED_INTEREST);
    expect(result.current.owedStroops).toBe(PRINCIPAL + SETTLED_INTEREST);
  });

  it("stays within one ledger of the settled value", () => {
    const { result } = renderHook(() =>
      useOwedProjection({
        principalStroops: PRINCIPAL,
        rateBps: RATE_BPS,
        termLedgers: TERM_LEDGERS,
        settledIndex: SETTLED_INDEX,
        settledLedger: SETTLED_LEDGER,
        settledInterestStroops: SETTLED_INTEREST,
        targetLedger: SETTLED_LEDGER + 1,
      }),
    );

    const oneLedgerInterest = projectAccruedInterest({
      principalStroops: PRINCIPAL,
      rateBps: RATE_BPS,
      termLedgers: TERM_LEDGERS,
      settledIndex: SETTLED_INDEX,
      settledLedger: SETTLED_LEDGER,
      targetLedger: SETTLED_LEDGER + 1,
      settledInterestStroops: SETTLED_INTEREST,
    });

    expect(result.current.isSettled).toBe(false);
    expect(result.current.interestStroops).toBe(oneLedgerInterest);
    // The projection is at most one ledger of interest above the settled
    // value: 1_000 tokens at 12% over 17_280 ledgers is 69_444 stroops per
    // ledger.
    const extra = result.current.interestStroops - SETTLED_INTEREST;
    expect(extra).toBeGreaterThanOrEqual(BigInt(0));
    expect(extra).toBeLessThanOrEqual(BigInt(69444));
  });

  it("projects the same value as the shared accrual math", () => {
    const { result } = renderHook(() =>
      useOwedProjection({
        principalStroops: PRINCIPAL,
        repaidStroops: BigInt("4000000000"),
        rateBps: RATE_BPS,
        termLedgers: TERM_LEDGERS,
        settledIndex: SETTLED_INDEX,
        settledLedger: SETTLED_LEDGER,
        settledInterestStroops: SETTLED_INTEREST,
        targetLedger: SETTLED_LEDGER + 120,
      }),
    );

    const expected = projectAccruedInterest({
      principalStroops: PRINCIPAL - BigInt("4000000000"),
      rateBps: RATE_BPS,
      termLedgers: TERM_LEDGERS,
      settledIndex: SETTLED_INDEX,
      settledLedger: SETTLED_LEDGER,
      targetLedger: SETTLED_LEDGER + 120,
      settledInterestStroops: SETTLED_INTEREST,
    });

    expect(result.current.interestStroops).toBe(expected);
    expect(result.current.remainingPrincipalStroops).toBe(PRINCIPAL - BigInt("4000000000"));
    expect(result.current.owedStroops).toBe(
      PRINCIPAL - BigInt("4000000000") + expected,
    );
  });

  it("never projects a negative principal", () => {
    const { result } = renderHook(() =>
      useOwedProjection({
        principalStroops: PRINCIPAL,
        repaidStroops: PRINCIPAL * BigInt(2),
        rateBps: RATE_BPS,
        termLedgers: TERM_LEDGERS,
        targetLedger: APPROVED_LEDGER + 500,
      }),
    );

    expect(result.current.remainingPrincipalStroops).toBe(BigInt(0));
    expect(result.current.owedStroops).toBe(BigInt(0));
  });
});
