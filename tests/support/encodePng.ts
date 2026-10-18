import { constants, deflateSync } from 'node:zlib';

/**
 * Test-only PNG ENCODER built on Node's zlib, so the hand-rolled decoder is
 * checked against a real deflate implementation (stored, fixed and dynamic
 * Huffman blocks) and every PNG row filter.
 */
export interface EncodeOptions {
  width: number;
  height: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  bitDepth: 1 | 2 | 4 | 8 | 16;
  /** Raw samples per row, packed as the PNG spec lays them out (no filter byte). */
  rows: Uint8Array[];
  /** Filter per row (cycled). Default: all five. */
  filters?: number[];
  palette?: Uint8Array;
  trns?: Uint8Array;
  /** zlib knobs: level 0 = stored blocks; strategy Z_FIXED = fixed Huffman. */
  level?: number;
  strategy?: number;
  interlace?: boolean;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // CRC left zero: the decoder under test does not verify it.
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function encodePng(o: EncodeOptions): Uint8Array {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[o.colorType];
  const bpp = Math.max(1, (channels * o.bitDepth) >> 3);
  const filters = o.filters ?? [0, 1, 2, 3, 4];
  const rowBytes = o.rows[0]?.length ?? 0;
  const raw = new Uint8Array(o.height * (rowBytes + 1));
  for (let y = 0; y < o.height; y++) {
    const f = filters[y % filters.length] ?? 0;
    const row = o.rows[y] as Uint8Array;
    const prev = y > 0 ? (o.rows[y - 1] as Uint8Array) : new Uint8Array(rowBytes);
    raw[y * (rowBytes + 1)] = f;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= bpp ? (row[x - bpp] ?? 0) : 0;
      const up = prev[x] ?? 0;
      const upLeft = x >= bpp ? (prev[x - bpp] ?? 0) : 0;
      const pred = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      raw[y * (rowBytes + 1) + 1 + x] = ((row[x] ?? 0) - pred) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, o.width);
  v.setUint32(4, o.height);
  ihdr[8] = o.bitDepth;
  ihdr[9] = o.colorType;
  ihdr[12] = o.interlace ? 1 : 0;
  const idat = deflateSync(raw, {
    level: o.level ?? 6,
    strategy: o.strategy ?? constants.Z_DEFAULT_STRATEGY,
  });
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...(o.palette ? [chunk('PLTE', o.palette)] : []),
    ...(o.trns ? [chunk('tRNS', o.trns)] : []),
    // Split IDAT in two to exercise multi-chunk concatenation.
    chunk('IDAT', new Uint8Array(idat.subarray(0, idat.length >> 1))),
    chunk('IDAT', new Uint8Array(idat.subarray(idat.length >> 1))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A width x height 8-bit RGBA PNG filled from `pixel(x, y)`. */
export function rgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
  extra: Partial<EncodeOptions> = {},
): { png: Uint8Array; rgba: Uint8Array } {
  const rgba = new Uint8Array(width * height * 4);
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width * 4);
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      row.set(p, x * 4);
      rgba.set(p, (y * width + x) * 4);
    }
    rows.push(row);
  }
  return { png: encodePng({ width, height, colorType: 6, bitDepth: 8, rows, ...extra }), rgba };
}
