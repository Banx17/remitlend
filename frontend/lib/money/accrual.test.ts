/**
 * Frontend parity tests for the shared fixed-point accrual math (#1382).
 *
 * The golden vectors are the contract's reference values; replaying them here
 * is what keeps a projected amount equal to the amount the contract settles.
 */
import * as fs from "fs";
import * as path from "path";
import { RoundingMode } from "./format";
import {
  INDEX_SCALE,
  MAX_WINDOW_LEDGERS,
  RATE_SCALE,
  RESIDUAL_SCALE,
  advanceIndex,
  indexDelta,
  indexFactor,
  interestFromIndexDelta,
  mulDiv,
  perLedgerRateScaled,
  projectAccruedInterest,
} from "./accrual";

// `tsc` rejects BigInt literal syntax (`0n`) below ES2020, and this
// frontend's tsconfig.json targets ES2017 — see accrual.ts's header comment.
const b = (n: number): bigint => BigInt(n);

const VECTORS_PATH = path.resolve(
  __dirname,
  "../../../contracts/testdata/accrual_vectors.json",
);

interface AccrualVector {
  name: string;
  rateBps: number;
  termLedgers: number;
  principalStroops: string;
  elapsedLedgers: number;
  indexDelta: string;
  indexAfter: string;
  perLedgerRateScaled: string;
  interestScaled: string;
  interestStroops: string;
}

interface AccrualVectors {
  indexScale: string;
  rateScale: string;
  residualScale: string;
  vectors: AccrualVector[];
}

describe("fixed point accrual math", () => {
  it("multiplies and divides with the contract rounding modes", () => {
    expect(mulDiv(b(7), b(3), b(2), RoundingMode.Floor)).toBe(b(10));
    expect(mulDiv(b(7), b(3), b(2), RoundingMode.HalfUp)).toBe(b(11));
    expect(mulDiv(b(-7), b(3), b(2), RoundingMode.Floor)).toBe(b(-11));
    expect(mulDiv(b(0), b(5), b(3))).toBe(b(0));
  });

  it("rounds half to even like the money policy", () => {
    expect(mulDiv(b(5), b(1), b(2), RoundingMode.HalfEven)).toBe(b(2));
    expect(mulDiv(b(7), b(1), b(2), RoundingMode.HalfEven)).toBe(b(4));
    expect(mulDiv(b(9), b(1), b(2), RoundingMode.HalfEven)).toBe(b(4));
  });

  it("rejects a zero denominator", () => {
    expect(() => mulDiv(b(1), b(1), b(0))).toThrow(/division by zero/);
  });

  it("accumulates the index exactly", () => {
    const delta = indexDelta(1200, 4320);
    expect(delta).toBe(BigInt(1200) * BigInt(4320) * RATE_SCALE);
    expect(advanceIndex(INDEX_SCALE, delta)).toBe(INDEX_SCALE + delta);
  });

  it("rejects an absurd accrual window", () => {
    expect(() => indexDelta(1200, MAX_WINDOW_LEDGERS + BigInt(1))).toThrow(/window/);
    expect(() => indexDelta(1200, BigInt(-1))).toThrow(/window/);
  });

  it("derives the interest from the index delta", () => {
    const principal = BigInt(1000000000);
    const term = BigInt(17280);
    for (const elapsed of [BigInt(1), BigInt(100), BigInt(4320), BigInt(17280)]) {
      const delta = indexDelta(1200, elapsed);
      const viaIndex = interestFromIndexDelta(principal, delta, term);
      const viaFormula =
        (principal * BigInt(1200) * elapsed * RESIDUAL_SCALE) / (BigInt(10000) * term);
      expect(viaIndex).toBe(viaFormula);
    }
  });

  it("keeps the sub stroop remainder in the residual", () => {
    expect(interestFromIndexDelta(b(1), INDEX_SCALE / b(2), b(1))).toBe(b(500000));
    expect(interestFromIndexDelta(b(1), INDEX_SCALE / b(2) / RESIDUAL_SCALE, b(1))).toBe(b(0));
  });

  it("reports the index factor relative to the origination index", () => {
    expect(indexFactor(INDEX_SCALE, INDEX_SCALE)).toBe(INDEX_SCALE);
  });
});

describe("projected accrued interest", () => {
  it("projects the same amount the contract settles", () => {
    const projected = projectAccruedInterest({
      principalStroops: BigInt(1000000000),
      rateBps: 1200,
      termLedgers: 17280,
      settledIndex: INDEX_SCALE,
      settledLedger: 0,
      targetLedger: 4320,
    });
    // 12% of 100 tokens over a quarter of the term.
    expect(projected).toBe(BigInt(30000000));
  });

  it("returns the settled interest when the target is in the past", () => {
    const projected = projectAccruedInterest({
      principalStroops: BigInt(1000000000),
      rateBps: 1200,
      termLedgers: 17280,
      settledIndex: INDEX_SCALE,
      settledLedger: 4320,
      targetLedger: 1000,
      settledInterestStroops: BigInt(1234),
    });
    expect(projected).toBe(BigInt(1234));
  });
});

describe("golden accrual vectors", () => {
  const doc = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8")) as AccrualVectors;

  it("are the contract reference values", () => {
    expect(BigInt(doc.indexScale)).toBe(INDEX_SCALE);
    expect(BigInt(doc.rateScale)).toBe(RATE_SCALE);
    expect(BigInt(doc.residualScale)).toBe(RESIDUAL_SCALE);
    expect(doc.vectors.length).toBeGreaterThan(0);
  });

  it.each(doc.vectors.map((vector) => [vector.name, vector] as const))(
    "reproduces \"%s\"",
    (_name, vector) => {
      const delta = indexDelta(vector.rateBps, vector.elapsedLedgers);
      expect(delta.toString()).toBe(vector.indexDelta);
      expect(advanceIndex(INDEX_SCALE, delta).toString()).toBe(vector.indexAfter);
      expect(perLedgerRateScaled(vector.rateBps, vector.termLedgers).toString()).toBe(
        vector.perLedgerRateScaled,
      );

      const interest = interestFromIndexDelta(
        BigInt(vector.principalStroops),
        delta,
        vector.termLedgers,
      );
      expect(interest.toString()).toBe(vector.interestScaled);
      expect((interest / RESIDUAL_SCALE).toString()).toBe(vector.interestStroops);
    },
  );
});
