import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/algorithms/hash';
import { PRESETS } from '../../src/algorithms/presets';
import { resolveFormat } from '../../src/algorithms/format';
import type { CompressImageOptions } from '../../src/types';

describe('PRESETS', () => {
  it('every preset is a valid CompressImageOptions bundle with sane bounds', () => {
    for (const [name, preset] of Object.entries(PRESETS) as Array<[string, CompressImageOptions]>) {
      expect(preset.maxEdge, name).toBeGreaterThan(0);
      expect(preset.quality, name).toBeGreaterThan(0);
      expect(preset.quality, name).toBeLessThanOrEqual(1);
      // Every preset's format preference must resolve even on a JPEG-only runtime.
      expect(resolveFormat(preset.format, new Set(['jpeg', 'png']))).toBeTruthy();
    }
  });

  it('llm preset stays inside every vision provider budget (Anthropic 1568 sweet spot)', () => {
    expect(PRESETS.llm.maxEdge).toBeLessThanOrEqual(1568);
    expect(PRESETS.llm.passthroughUnder).toBe(0); // byte-stable output for prompt caching
  });

  it('use-case ordering holds: thumbnail < avatar < chat ≤ llm < ecom < editor', () => {
    expect(PRESETS.thumbnail.maxEdge).toBeLessThan(PRESETS.avatar.maxEdge);
    expect(PRESETS.avatar.maxEdge).toBeLessThan(PRESETS.chat.maxEdge);
    expect(PRESETS.ecom.maxEdge).toBeGreaterThan(PRESETS.chat.maxEdge);
    expect(PRESETS.editor.maxEdge).toBeGreaterThan(PRESETS.ecom.maxEdge);
    expect(PRESETS.ecom.quality).toBeGreaterThan(PRESETS.chat.quality!);
    expect(PRESETS.editor.quality).toBeGreaterThan(PRESETS.ecom.quality!);
  });

  it('presets are spreadable + overridable', () => {
    const custom: CompressImageOptions = { ...PRESETS.chat, quality: 0.95 };
    expect(custom.maxEdge).toBe(1600);
    expect(custom.quality).toBe(0.95);
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256 of "abc"', async () => {
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Hex(bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('Blob and Uint8Array of the same content hash identically', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = new Blob([bytes as unknown as BlobPart]);
    expect(await sha256Hex(blob)).toBe(await sha256Hex(bytes));
  });

  it('handles offset views correctly (hashes only the view)', async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5); // [1,2,3]
    expect(await sha256Hex(view)).toBe(await sha256Hex(new Uint8Array([1, 2, 3])));
  });
});
