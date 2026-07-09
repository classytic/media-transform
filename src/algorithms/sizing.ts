/**
 * Pure, runtime-agnostic sizing math. No DOM, no canvas — just numbers, so it
 * is exhaustively unit-testable in Node and shared byte-for-byte between the
 * browser and (future) React Native adapters.
 */
import type { Dimensions, SizeConstraints } from '../types.js';

/**
 * Compute the target dimensions for a source under a set of constraints.
 *
 * - Preserves aspect ratio (rounds to whole pixels, never to 0).
 * - NEVER enlarges: a source already within every constraint is returned as-is.
 * - The most restrictive constraint wins (a scale factor is derived per
 *   constraint and the smallest is applied once).
 */
export function computeTargetSize(source: Dimensions, constraints: SizeConstraints): Dimensions {
  const { width, height } = source;
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };

  const scales: number[] = [1];
  if (constraints.maxEdge !== undefined) scales.push(constraints.maxEdge / Math.max(width, height));
  if (constraints.maxWidth !== undefined) scales.push(constraints.maxWidth / width);
  if (constraints.maxHeight !== undefined) scales.push(constraints.maxHeight / height);
  if (constraints.maxPixels !== undefined) scales.push(Math.sqrt(constraints.maxPixels / (width * height)));

  // Downscale only — clamp the smallest scale to 1 so we never enlarge.
  const scale = Math.min(...scales, 1);
  if (scale >= 1) return { width, height };

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** True when `source` already satisfies every constraint (no downscale needed). */
export function isWithinConstraints(source: Dimensions, constraints: SizeConstraints): boolean {
  const target = computeTargetSize(source, constraints);
  return target.width === source.width && target.height === source.height;
}

/**
 * Plan a STEPPED downscale. Halving the largest edge at most each step keeps a
 * bilinear/`drawImage` resample sharp — a single big one-shot downscale in a
 * 2D canvas is visibly blurry (the classic "canvas downscale is soft" bug).
 * Each returned step is at most 2x smaller than the previous; the last equals
 * the target exactly.
 *
 * Returns `[]` when no downscale is needed (source already at/below target).
 */
export function planDownscaleSteps(source: Dimensions, target: Dimensions): Dimensions[] {
  if (target.width >= source.width && target.height >= source.height) return [];

  const steps: Dimensions[] = [];
  let current = source;
  // Guard against a pathological loop; a halving chain from any realistic
  // image reaches the target in well under 32 steps.
  for (let i = 0; i < 32; i++) {
    const next: Dimensions = {
      width: Math.max(target.width, Math.round(current.width / 2)),
      height: Math.max(target.height, Math.round(current.height / 2)),
    };
    // If halving would overshoot the target, jump straight to the target.
    if (next.width <= target.width || next.height <= target.height) {
      steps.push(target);
      break;
    }
    steps.push(next);
    current = next;
  }
  return steps;
}
