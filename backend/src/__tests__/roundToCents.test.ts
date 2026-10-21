import { roundToCents } from '../controllers/loanController.js';

describe('roundToCents half-even rounding', () => {
  it('applies banker rounding (half-even) for .5 cent cases', () => {
    expect(roundToCents(0.125)).toBe(0.12);
    expect(roundToCents(0.135)).toBe(0.14);
    expect(roundToCents(10.005)).toBe(10.0);
    expect(roundToCents(10.015)).toBe(10.02);
  });

  it('handles negative half-even rounding symmetrically', () => {
    expect(roundToCents(-0.125)).toBe(-0.12);
    expect(roundToCents(-0.135)).toBe(-0.14);
  });

  it('rounds non-tie values to nearest cent', () => {
    expect(roundToCents(10.004)).toBe(10.0);
    expect(roundToCents(10.006)).toBe(10.01);
    expect(roundToCents(12.3456)).toBe(12.35);
    expect(roundToCents(12.3412)).toBe(12.34);
    expect(roundToCents(0.0049)).toBe(0);
  });
});

// Issue #1372: `roundToCents` used to truncate towards zero, so every owed
// amount that was not an exact multiple of a cent was systematically rounded
// down and the protocol undercharged the difference. The helper now rounds to
// the nearest cent; these tests pin that behaviour so it cannot silently
// regress into truncation.
describe('roundToCents never truncates owed amounts towards zero (#1372)', () => {
  it('rounds up when the third decimal is greater than or equal to 5', () => {
    expect(roundToCents(0.126)).toBe(0.13);
    expect(roundToCents(0.0051)).toBe(0.01);
    expect(roundToCents(1.239)).toBe(1.24);
    expect(roundToCents(120.0084)).toBe(120.01);
    expect(roundToCents(1000.0084)).toBe(1000.01);
    expect(roundToCents(999.999)).toBe(1000);
  });

  it('is never smaller than the truncated value and stays within half a cent', () => {
    const samples = [
      0.001, 0.0049, 0.005, 0.006, 0.0099, 1.005, 12.3456, 99.994, 1000.07, 12345.6789,
    ];

    for (const value of samples) {
      const rounded = roundToCents(value);
      const truncated = Math.floor(value * 100) / 100;

      expect(rounded).toBeGreaterThanOrEqual(truncated);
      // A tolerance of 1e-9 absorbs the binary representation error of the
      // half-cent boundary (e.g. 1.005 - 1 === 0.005000000000000004).
      expect(Math.abs(rounded - value)).toBeLessThanOrEqual(0.005 + 1e-9);
    }
  });

  it('rounds a mixed set of owed amounts to the nearest cent', () => {
    const expected = new Map<number, number>([
      [0.126, 0.13],
      [0.134, 0.13],
      [1.005, 1.0],
      [1.015, 1.02],
      [2.675, 2.68],
      [7.685, 7.68],
      [100.004, 100.0],
      [100.006, 100.01],
    ]);

    for (const [value, expectedCents] of expected) {
      expect(roundToCents(value)).toBe(expectedCents);
    }
  });
});
