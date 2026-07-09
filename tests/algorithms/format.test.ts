import { describe, expect, it } from 'vitest';
import type { ImageFormat } from '../../src/types';
import { FALLBACK_FORMAT, FORMAT_EXT, FORMAT_MIME, resolveFormat, supportsAlpha } from '../../src/algorithms/format';

const set = (...f: ImageFormat[]): ReadonlySet<ImageFormat> => new Set(f);

describe('resolveFormat', () => {
  it('defaults to webp when no preference and webp is encodable', () => {
    expect(resolveFormat(undefined, set('jpeg', 'webp'))).toBe('webp');
  });

  it('defaults to jpeg when webp is not encodable', () => {
    expect(resolveFormat(undefined, set('jpeg'))).toBe('jpeg');
  });

  it('honors a single preferred format when encodable', () => {
    expect(resolveFormat('avif', set('jpeg', 'webp', 'avif'))).toBe('avif');
  });

  it('walks an ordered preference list to the first encodable entry', () => {
    // Prefer avif, then webp, then jpeg; avif NOT encodable → webp.
    expect(resolveFormat(['avif', 'webp', 'jpeg'], set('jpeg', 'webp'))).toBe('webp');
  });

  it('falls back to any encodable format when no preference matches', () => {
    // Prefer avif only; not encodable → best encodable (webp before jpeg).
    expect(resolveFormat(['avif'], set('jpeg', 'webp'))).toBe('webp');
  });

  it('falls back to JPEG when nothing preferred is encodable and only jpeg is', () => {
    expect(resolveFormat(['avif', 'webp'], set('jpeg'))).toBe('jpeg');
  });

  it('never returns a non-encodable format', () => {
    const encodable = set('jpeg');
    for (const pref of [['avif'], ['webp'], ['avif', 'webp'], undefined] as const) {
      expect(encodable.has(resolveFormat(pref, encodable))).toBe(true);
    }
  });

  it('hard floor is JPEG', () => {
    expect(FALLBACK_FORMAT).toBe('jpeg');
  });
});

describe('format tables', () => {
  it('every format has a MIME and an extension', () => {
    for (const fmt of ['jpeg', 'webp', 'avif', 'png'] as const) {
      expect(FORMAT_MIME[fmt]).toMatch(/^image\//);
      expect(FORMAT_EXT[fmt]).toBeTruthy();
    }
  });
});

describe('supportsAlpha', () => {
  it('jpeg has no alpha; others do', () => {
    expect(supportsAlpha('jpeg')).toBe(false);
    expect(supportsAlpha('png')).toBe(true);
    expect(supportsAlpha('webp')).toBe(true);
    expect(supportsAlpha('avif')).toBe(true);
  });
});
