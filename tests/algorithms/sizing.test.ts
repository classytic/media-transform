import { describe, expect, it } from 'vitest';
import { computeTargetSize, isWithinConstraints, planDownscaleSteps } from '../../src/algorithms/sizing';

describe('computeTargetSize', () => {
  it('never enlarges a source already within bounds', () => {
    expect(computeTargetSize({ width: 800, height: 600 }, { maxEdge: 2000 })).toEqual({ width: 800, height: 600 });
  });

  it('downscales by longest edge, preserving aspect ratio', () => {
    // 4000x3000 landscape, maxEdge 1600 → scale 0.4 → 1600x1200
    expect(computeTargetSize({ width: 4000, height: 3000 }, { maxEdge: 1600 })).toEqual({ width: 1600, height: 1200 });
  });

  it('handles portrait (longest edge is height)', () => {
    expect(computeTargetSize({ width: 3000, height: 4000 }, { maxEdge: 1600 })).toEqual({ width: 1200, height: 1600 });
  });

  it('applies the MOST restrictive of several constraints', () => {
    // width 4000: maxWidth 1000 → scale .25; maxEdge 1600 → scale .4 → .25 wins
    expect(computeTargetSize({ width: 4000, height: 2000 }, { maxWidth: 1000, maxEdge: 1600 })).toEqual({
      width: 1000,
      height: 500,
    });
  });

  it('honors maxPixels for pathological aspect ratios', () => {
    // 10000x1000 = 10M px, cap 1M → scale sqrt(0.1) ≈ 0.316 → ~3162x316
    const out = computeTargetSize({ width: 10000, height: 1000 }, { maxPixels: 1_000_000 });
    expect(out.width * out.height).toBeLessThanOrEqual(1_000_000 * 1.01);
    expect(out.width / out.height).toBeCloseTo(10, 1);
  });

  it('rounds to whole pixels and never to zero', () => {
    const out = computeTargetSize({ width: 3, height: 1 }, { maxEdge: 1 });
    expect(out.width).toBeGreaterThanOrEqual(1);
    expect(out.height).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(out.width)).toBe(true);
    expect(Number.isInteger(out.height)).toBe(true);
  });

  it('returns 0x0 for a degenerate source', () => {
    expect(computeTargetSize({ width: 0, height: 100 }, { maxEdge: 50 })).toEqual({ width: 0, height: 0 });
  });

  it('no constraints → identity', () => {
    expect(computeTargetSize({ width: 1234, height: 567 }, {})).toEqual({ width: 1234, height: 567 });
  });
});

describe('isWithinConstraints', () => {
  it('true when no downscale is needed', () => {
    expect(isWithinConstraints({ width: 800, height: 600 }, { maxEdge: 1000 })).toBe(true);
  });
  it('false when a downscale is needed', () => {
    expect(isWithinConstraints({ width: 4000, height: 3000 }, { maxEdge: 1000 })).toBe(false);
  });
});

describe('planDownscaleSteps', () => {
  it('is empty when no downscale is needed', () => {
    expect(planDownscaleSteps({ width: 800, height: 600 }, { width: 800, height: 600 })).toEqual([]);
  });

  it('halves at most each step and lands exactly on the target', () => {
    const steps = planDownscaleSteps({ width: 4000, height: 3000 }, { width: 1600, height: 1200 });
    expect(steps.length).toBeGreaterThan(0);
    // Each step is at most 2x smaller than the previous.
    let prev = { width: 4000, height: 3000 };
    for (const s of steps) {
      expect(s.width).toBeGreaterThanOrEqual(Math.round(prev.width / 2));
      prev = s;
    }
    // Last step equals the target exactly.
    expect(steps[steps.length - 1]).toEqual({ width: 1600, height: 1200 });
  });

  it('a small downscale (<2x) is a single step straight to target', () => {
    expect(planDownscaleSteps({ width: 1000, height: 800 }, { width: 900, height: 720 })).toEqual([
      { width: 900, height: 720 },
    ]);
  });

  it('terminates for an extreme downscale without looping forever', () => {
    const steps = planDownscaleSteps({ width: 20000, height: 20000 }, { width: 10, height: 10 });
    expect(steps.length).toBeLessThanOrEqual(32);
    expect(steps[steps.length - 1]).toEqual({ width: 10, height: 10 });
  });
});
