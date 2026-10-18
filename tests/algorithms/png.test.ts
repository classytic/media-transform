import { constants, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePngToRgba, zlibInflate } from '../../src/algorithms/png';
import { encodePng, rgbaPng } from '../support/encodePng';

/** A noisy-but-deterministic image: exercises every filter predictor and real LZ77 matches. */
const pattern = (x: number, y: number): [number, number, number, number] => [
  (x * 37 + y * 11) & 0xff,
  (x * y + 7) & 0xff,
  ((x ^ y) * 13) & 0xff,
  x % 5 === 0 ? 128 : 255,
];

describe('zlibInflate (vs node:zlib)', () => {
  const data = new Uint8Array(20_000);
  for (let i = 0; i < data.length; i++) data[i] = (i % 251) ^ ((i >> 7) & 0x3f);

  it.each([
    ['stored blocks (level 0)', { level: 0 }],
    ['fixed Huffman (Z_FIXED)', { strategy: constants.Z_FIXED }],
    ['dynamic Huffman (default)', {}],
    ['dynamic Huffman, max compression', { level: 9 }],
    ['Huffman-only (no LZ77 matches)', { strategy: constants.Z_HUFFMAN_ONLY }],
    ['RLE (distance-1 matches)', { strategy: constants.Z_RLE }],
  ])('round-trips %s', (_label, opts) => {
    const out = zlibInflate(new Uint8Array(deflateSync(data, opts)), data.length);
    expect(out).toEqual(data);
  });

  it('round-trips highly repetitive input (long back-references, length 258)', () => {
    const zeros = new Uint8Array(70_000);
    expect(zlibInflate(new Uint8Array(deflateSync(zeros)), zeros.length)).toEqual(zeros);
  });

  it('rejects a bad zlib header', () => {
    expect(() => zlibInflate(new Uint8Array([0x00, 0x00, 0x01]), 1)).toThrow(/zlib header/);
  });

  it('rejects output larger than the declared size', () => {
    expect(() => zlibInflate(new Uint8Array(deflateSync(data)), 100)).toThrow(/exceeds/);
  });

  it('rejects output shorter than the declared size', () => {
    expect(() => zlibInflate(new Uint8Array(deflateSync(data)), data.length + 1)).toThrow(/shorter/);
  });

  it('rejects a truncated stream', () => {
    const z = new Uint8Array(deflateSync(data));
    expect(() => zlibInflate(z.subarray(0, z.length >> 1), data.length)).toThrow();
  });
});

describe('decodePngToRgba', () => {
  it.each([
    ['dynamic', {}],
    ['stored', { level: 0 }],
    ['fixed', { strategy: constants.Z_FIXED }],
  ])('decodes 8-bit RGBA with all five row filters (%s deflate)', (_label, extra) => {
    const { png, rgba } = rgbaPng(37, 23, pattern, extra);
    const out = decodePngToRgba(png);
    expect(out.width).toBe(37);
    expect(out.height).toBe(23);
    expect(out.data).toEqual(rgba);
  });

  it('decodes 8-bit RGB (alpha = 255)', () => {
    const rows = Array.from({ length: 4 }, (_, y) => new Uint8Array([10 * y, 20, 30, 40, 50, 60 + y]));
    const out = decodePngToRgba(encodePng({ width: 2, height: 4, colorType: 2, bitDepth: 8, rows }));
    expect([...out.data.subarray(0, 8)]).toEqual([0, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('decodes 16-bit RGBA by keeping the high byte (iOS writes 16-bit for wide-gamut photos)', () => {
    const rows = [new Uint8Array([0xab, 0xcd, 0x12, 0x34, 0xff, 0x00, 0x80, 0x01])];
    const out = decodePngToRgba(encodePng({ width: 1, height: 1, colorType: 6, bitDepth: 16, rows }));
    expect([...out.data]).toEqual([0xab, 0x12, 0xff, 0x80]);
  });

  it('decodes gray and gray+alpha', () => {
    const gray = decodePngToRgba(
      encodePng({ width: 2, height: 1, colorType: 0, bitDepth: 8, rows: [new Uint8Array([7, 200])] }),
    );
    expect([...gray.data]).toEqual([7, 7, 7, 255, 200, 200, 200, 255]);
    const ga = decodePngToRgba(
      encodePng({ width: 1, height: 1, colorType: 4, bitDepth: 8, rows: [new Uint8Array([90, 30])] }),
    );
    expect([...ga.data]).toEqual([90, 90, 90, 30]);
  });

  it('decodes 1-bit gray (sub-byte samples stretched to 0/255)', () => {
    // 10 px wide → 2 bytes per row; pattern 1010101010
    const rows = [new Uint8Array([0b10101010, 0b10000000])];
    const out = decodePngToRgba(encodePng({ width: 10, height: 1, colorType: 0, bitDepth: 1, rows }));
    const r = [...out.data].filter((_, i) => i % 4 === 0);
    expect(r).toEqual([255, 0, 255, 0, 255, 0, 255, 0, 255, 0]);
  });

  it('decodes a 4-bit palette with tRNS', () => {
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const trns = new Uint8Array([255, 0]); // index 1 transparent, index 2 implicitly opaque
    const rows = [new Uint8Array([0x01, 0x20])]; // indices 0,1,2,0
    const out = decodePngToRgba(encodePng({ width: 4, height: 1, colorType: 3, bitDepth: 4, rows, palette, trns }));
    expect([...out.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 255, 0, 0, 255]);
  });

  it('honours an RGB colour-key tRNS', () => {
    const rows = [new Uint8Array([1, 2, 3, 9, 9, 9])];
    const trns = new Uint8Array([0, 1, 0, 2, 0, 3]);
    const out = decodePngToRgba(encodePng({ width: 2, height: 1, colorType: 2, bitDepth: 8, rows, trns }));
    expect(out.data[3]).toBe(0);
    expect(out.data[7]).toBe(255);
  });

  it('refuses non-PNG input', () => {
    expect(() => decodePngToRgba(new Uint8Array([0xff, 0xd8, 0xff]))).toThrow(/not a PNG/);
  });

  it('refuses interlaced PNGs instead of guessing', () => {
    const { png } = rgbaPng(4, 4, pattern, { interlace: true });
    expect(() => decodePngToRgba(png)).toThrow(/interlaced/);
  });

  it('refuses an invalid bit depth for the colour type', () => {
    const rows = [new Uint8Array([0])];
    expect(() => decodePngToRgba(encodePng({ width: 1, height: 1, colorType: 2, bitDepth: 4, rows }))).toThrow(
      /bit depth/,
    );
  });

  it('refuses a palette image without PLTE', () => {
    const rows = [new Uint8Array([0])];
    expect(() => decodePngToRgba(encodePng({ width: 1, height: 1, colorType: 3, bitDepth: 8, rows }))).toThrow(/PLTE/);
  });

  it('refuses a chunk that overruns the file', () => {
    const { png } = rgbaPng(4, 4, pattern);
    expect(() => decodePngToRgba(png.subarray(0, 40))).toThrow();
  });
});
