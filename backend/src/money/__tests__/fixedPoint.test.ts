/**
 * Backend parity tests for the shared fixed-point accrual math (#1382).
 *
 * The golden vectors are the contract's reference values; replaying them here
 * is what keeps the amount the API reports equal to the amount the contract
 * settles.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { RoundingMode } from '../decimal.js';
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
} from '../fixedPoint.js';

const VECTORS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../contracts/testdata/accrual_vectors.json',
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

describe('fixed point accrual math', () => {
  it('multiplies and divides with the contract rounding modes', () => {
    expect(mulDiv(7n, 3n, 2n, RoundingMode.Floor)).toBe(10n);
    expect(mulDiv(7n, 3n, 2n, RoundingMode.HalfUp)).toBe(11n);
    expect(mulDiv(-7n, 3n, 2n, RoundingMode.Floor)).toBe(-11n);
    expect(mulDiv(-7n, 3n, 2n, RoundingMode.HalfUp)).toBe(-11n);
    expect(mulDiv(0n, 5n, 3n)).toBe(0n);
  });

  it('rounds half to even like the money policy', () => {
    expect(mulDiv(5n, 1n, 2n, RoundingMode.HalfEven)).toBe(2n);
    expect(mulDiv(7n, 1n, 2n, RoundingMode.HalfEven)).toBe(4n);
    expect(mulDiv(9n, 1n, 2n, RoundingMode.HalfEven)).toBe(4n);
  });

  it('uses the full 256 bit product', () => {
    const a = 1n << 63n;
    expect(mulDiv(a, a, 1n, RoundingMode.Floor)).toBe(1n << 126n);
  });

  it('rejects a zero denominator and an out of range result', () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(/division by zero/);
    expect(() => mulDiv((1n << 127n) - 1n, 2n, 1n)).toThrow(/i128/);
  });

  it('accumulates the index exactly', () => {
    const delta = indexDelta(1200, 4320);
    expect(delta).toBe(1200n * 4320n * RATE_SCALE);
    expect(advanceIndex(INDEX_SCALE, delta)).toBe(INDEX_SCALE + delta);
  });

  it('rejects an absurd accrual window', () => {
    expect(() => indexDelta(1200, MAX_WINDOW_LEDGERS + 1n)).toThrow(/window/);
    expect(() => indexDelta(1200, -1)).toThrow(/window/);
  });

  it('derives the interest from the index delta', () => {
    const principal = 1_000_000_000n;
    const rateBps = 1200;
    const term = 17_280n;
    for (const elapsed of [1n, 100n, 4320n, 17_280n]) {
      const delta = indexDelta(rateBps, elapsed);
      const viaIndex = interestFromIndexDelta(principal, delta, term);
      const viaFormula =
        (principal * BigInt(rateBps) * elapsed * RESIDUAL_SCALE) / (10_000n * term);
      expect(viaIndex).toBe(viaFormula);
    }
  });

  it('keeps the sub stroop remainder in the residual', () => {
    expect(interestFromIndexDelta(1n, INDEX_SCALE / 2n, 1n)).toBe(500_000n);
    expect(interestFromIndexDelta(1n, INDEX_SCALE / 2n / RESIDUAL_SCALE, 1n)).toBe(0n);
  });

  it('reports the index factor relative to the origination index', () => {
    expect(indexFactor(INDEX_SCALE, INDEX_SCALE)).toBe(INDEX_SCALE);
  });
});

describe('golden accrual vectors', () => {
  const doc = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8')) as AccrualVectors;

  it('are the contract reference values', () => {
    expect(BigInt(doc.indexScale)).toBe(INDEX_SCALE);
    expect(BigInt(doc.rateScale)).toBe(RATE_SCALE);
    expect(BigInt(doc.residualScale)).toBe(RESIDUAL_SCALE);
    expect(doc.vectors.length).toBeGreaterThan(0);
  });

  it.each(doc.vectors.map((vector) => [vector.name, vector] as const))(
    'reproduces "%s"',
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
