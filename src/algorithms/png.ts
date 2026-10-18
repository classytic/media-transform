/**
 * A small, pure PNG → RGBA decoder (with its own inflate).
 *
 * Why this exists: React Native has no canvas, so a native adapter cannot read
 * pixels back. `expo-image-manipulator` can only resize and SAVE (JPEG, PNG,
 * WebP). ThumbHash and `dominantColor` need raw RGBA at ~100px, so the native
 * adapter saves a tiny PNG and decodes it here. Hermes has no
 * `DecompressionStream` and no zlib, hence the hand-rolled inflate (RFC 1951,
 * stored + fixed + dynamic Huffman blocks).
 *
 * Scope is deliberately narrow: it decodes what a platform encoder writes at
 * thumbnail size (8/16-bit gray, gray+alpha, RGB, RGBA, palette with tRNS,
 * sub-byte gray/palette). Interlaced (Adam7) input is refused, not guessed.
 * CRCs are not verified: the input is a file this process just wrote, and a
 * corrupt stream still fails loudly in inflate or the size checks.
 *
 * Every failure THROWS. The caller (the native adapter) treats a throw as
 * "no placeholder", never as a failed upload.
 */

export interface DecodedRgba {
  data: Uint8Array;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

/** Refuse anything implausible before allocating for it (this decoder is for thumbnails). */
const MAX_PIXELS = 4096 * 4096;

/** Decode a PNG to 8-bit RGBA. Throws on anything malformed or unsupported. */
export function decodePngToRgba(bytes: Uint8Array): DecodedRgba {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('[media-transform] not a PNG');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatLength = 0;

  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = readU32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    const start = pos + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error(`[media-transform] PNG chunk ${type} overruns the file`);
    const body = bytes.subarray(start, end);

    if (type === 'IHDR') {
      width = readU32(body, 0);
      height = readU32(body, 4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      if (body[10] !== 0 || body[11] !== 0)
        throw new Error('[media-transform] unsupported PNG compression/filter method');
      if (body[12] !== 0) throw new Error('[media-transform] interlaced PNG is not supported');
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      idat.push(body);
      idatLength += body.length;
    } else if (type === 'IEND') {
      break;
    }
    pos = end + 4; // skip CRC
  }

  if (width <= 0 || height <= 0) throw new Error('[media-transform] PNG has no IHDR');
  if (width * height > MAX_PIXELS) throw new Error('[media-transform] PNG too large for the thumbnail decoder');
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`[media-transform] unsupported PNG color type ${colorType}`);
  if (!VALID_DEPTHS[colorType]?.includes(bitDepth)) {
    throw new Error(`[media-transform] unsupported PNG bit depth ${bitDepth} for color type ${colorType}`);
  }
  if (colorType === 3 && !palette) throw new Error('[media-transform] palette PNG without PLTE');
  if (idat.length === 0) throw new Error('[media-transform] PNG has no image data');

  const compressed = new Uint8Array(idatLength);
  let offset = 0;
  for (const part of idat) {
    compressed.set(part, offset);
    offset += part.length;
  }

  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const raw = zlibInflate(compressed, height * (rowBytes + 1));
  const pixels = unfilter(raw, height, rowBytes, bpp);
  return { data: toRgba(pixels, width, height, rowBytes, colorType, bitDepth, palette, transparency), width, height };
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const VALID_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function readU32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

// ── Filters (PNG spec §9) ────────────────────────────────────────────────────

function unfilter(raw: Uint8Array, height: number, rowBytes: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]!;
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    const prev = dst - rowBytes; // previous output row (y > 0)
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[src + x]!;
      const left = x >= bpp ? out[dst + x - bpp]! : 0;
      const up = y > 0 ? out[prev + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? out[prev + x - bpp]! : 0;
      let predicted: number;
      switch (filter) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = left;
          break;
        case 2:
          predicted = up;
          break;
        case 3:
          predicted = (left + up) >> 1;
          break;
        case 4:
          predicted = paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`[media-transform] bad PNG filter type ${filter}`);
      }
      out[dst + x] = (value + predicted) & 0xff;
    }
  }
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

// ── Pixel expansion ──────────────────────────────────────────────────────────

function toRgba(
  px: Uint8Array,
  width: number,
  height: number,
  rowBytes: number,
  colorType: number,
  bitDepth: number,
  palette: Uint8Array | null,
  trns: Uint8Array | null,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const maxSample = (1 << Math.min(bitDepth, 8)) - 1;

  /** The `bitDepth`-wide sample `index` of a row (sub-byte, 8 or 16 bit; 16 → raw 16-bit value). */
  const sample = (row: number, index: number): number => {
    const base = row * rowBytes;
    if (bitDepth === 8) return px[base + index]!;
    if (bitDepth === 16) return (px[base + index * 2]! << 8) | px[base + index * 2 + 1]!;
    const bitOffset = index * bitDepth;
    const byte = px[base + (bitOffset >> 3)]!;
    return (byte >> (8 - bitDepth - (bitOffset & 7))) & maxSample;
  };
  /** Scale a sample to 0..255 (16-bit keeps the high byte; sub-byte gray is stretched). */
  const to8 = (v: number): number => (bitDepth === 16 ? v >> 8 : bitDepth < 8 ? Math.round((v * 255) / maxSample) : v);

  const keyGray = colorType === 0 && trns && trns.length >= 2 ? (trns[0]! << 8) | trns[1]! : -1;
  const keyRgb =
    colorType === 2 && trns && trns.length >= 6
      ? [(trns[0]! << 8) | trns[1]!, (trns[2]! << 8) | trns[3]!, (trns[4]! << 8) | trns[5]!]
      : null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 0) {
        const g = sample(y, x);
        const v = to8(g);
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = g === keyGray ? 0 : 255;
      } else if (colorType === 2) {
        const r = sample(y, x * 3);
        const g = sample(y, x * 3 + 1);
        const b = sample(y, x * 3 + 2);
        out[o] = to8(r);
        out[o + 1] = to8(g);
        out[o + 2] = to8(b);
        out[o + 3] = keyRgb && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2] ? 0 : 255;
      } else if (colorType === 3) {
        const i = sample(y, x);
        const p = palette as Uint8Array;
        if (i * 3 + 2 >= p.length) throw new Error('[media-transform] PNG palette index out of range');
        out[o] = p[i * 3]!;
        out[o + 1] = p[i * 3 + 1]!;
        out[o + 2] = p[i * 3 + 2]!;
        out[o + 3] = trns && i < trns.length ? trns[i]! : 255;
      } else if (colorType === 4) {
        const v = to8(sample(y, x * 2));
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = to8(sample(y, x * 2 + 1));
      } else {
        out[o] = to8(sample(y, x * 4));
        out[o + 1] = to8(sample(y, x * 4 + 1));
        out[o + 2] = to8(sample(y, x * 4 + 2));
        out[o + 3] = to8(sample(y, x * 4 + 3));
      }
    }
  }
  return out;
}

// ── Inflate (RFC 1950 zlib wrapper + RFC 1951 DEFLATE) ──────────────────────

/** Inflate a zlib stream whose decompressed size is known exactly (PNG always knows it). */
export function zlibInflate(input: Uint8Array, expectedSize: number): Uint8Array {
  if (input.length < 2) throw new Error('[media-transform] zlib stream too short');
  const cmf = input[0]!;
  const flg = input[1]!;
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw new Error('[media-transform] bad zlib header');
  if (flg & 0x20) throw new Error('[media-transform] zlib preset dictionary is not supported');
  return inflateRaw(input.subarray(2), expectedSize);
}

interface Huffman {
  counts: Uint16Array; // codes per bit length 0..15
  symbols: Uint16Array; // symbols ordered by code
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths: ArrayLike<number>, offset: number, count: number): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < count; i++) counts[lengths[offset + i]!]!++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!;
  const symbols = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const len = lengths[offset + i]!;
    if (len) symbols[offs[len]!++] = i;
  }
  return { counts, symbols };
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;
function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (!fixedLit || !fixedDist) {
    const lengths = new Uint8Array(288);
    for (let i = 0; i < 144; i++) lengths[i] = 8;
    for (let i = 144; i < 256; i++) lengths[i] = 9;
    for (let i = 256; i < 280; i++) lengths[i] = 7;
    for (let i = 280; i < 288; i++) lengths[i] = 8;
    fixedLit = buildHuffman(lengths, 0, 288);
    fixedDist = buildHuffman(new Uint8Array(30).fill(5), 0, 30);
  }
  return { lit: fixedLit, dist: fixedDist };
}

function inflateRaw(src: Uint8Array, expectedSize: number): Uint8Array {
  const out = new Uint8Array(expectedSize);
  let outPos = 0;
  let inPos = 0;
  let bitBuf = 0;
  let bitCount = 0;

  const bit = (): number => {
    if (bitCount === 0) {
      if (inPos >= src.length) throw new Error('[media-transform] deflate stream truncated');
      bitBuf = src[inPos++]!;
      bitCount = 8;
    }
    const b = bitBuf & 1;
    bitBuf >>= 1;
    bitCount--;
    return b;
  };
  const bits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v |= bit() << i;
    return v;
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bit();
      const count = h.counts[len]!;
      if (code - first < count) return h.symbols[index + code - first]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('[media-transform] invalid deflate Huffman code');
  };
  const emit = (byte: number): void => {
    if (outPos >= expectedSize) throw new Error('[media-transform] deflate output exceeds the PNG size');
    out[outPos++] = byte;
  };

  let final = 0;
  while (!final) {
    final = bit();
    const type = bits(2);
    if (type === 0) {
      // Stored: drop to a byte boundary, then LEN / NLEN and raw bytes.
      bitBuf = 0;
      bitCount = 0;
      if (inPos + 4 > src.length) throw new Error('[media-transform] deflate stream truncated');
      const len = src[inPos]! | (src[inPos + 1]! << 8);
      const nlen = src[inPos + 2]! | (src[inPos + 3]! << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('[media-transform] corrupt stored deflate block');
      inPos += 4;
      if (inPos + len > src.length) throw new Error('[media-transform] deflate stream truncated');
      for (let i = 0; i < len; i++) emit(src[inPos + i]!);
      inPos += len;
      continue;
    }

    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) {
      ({ lit, dist } = fixedTables());
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const clen = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]!] = bits(3);
      const clenTable = buildHuffman(clen, 0, 19);
      const lengths = new Uint8Array(hlit + hdist);
      let n = 0;
      while (n < hlit + hdist) {
        const sym = decode(clenTable);
        if (sym < 16) {
          lengths[n++] = sym;
          continue;
        }
        let repeat: number;
        let value = 0;
        if (sym === 16) {
          if (n === 0) throw new Error('[media-transform] deflate repeat with no previous length');
          value = lengths[n - 1]!;
          repeat = 3 + bits(2);
        } else if (sym === 17) {
          repeat = 3 + bits(3);
        } else {
          repeat = 11 + bits(7);
        }
        if (n + repeat > hlit + hdist) throw new Error('[media-transform] deflate code lengths overrun');
        for (let i = 0; i < repeat; i++) lengths[n++] = value;
      }
      lit = buildHuffman(lengths, 0, hlit);
      dist = buildHuffman(lengths, hlit, hdist);
    } else {
      throw new Error('[media-transform] invalid deflate block type');
    }

    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        emit(sym);
        continue;
      }
      if (sym === 256) break;
      const li = sym - 257;
      if (li >= LENGTH_BASE.length) throw new Error('[media-transform] invalid deflate length symbol');
      const length = LENGTH_BASE[li]! + bits(LENGTH_EXTRA[li]!);
      const di = decode(dist);
      if (di >= DIST_BASE.length) throw new Error('[media-transform] invalid deflate distance symbol');
      const distance = DIST_BASE[di]! + bits(DIST_EXTRA[di]!);
      if (distance > outPos) throw new Error('[media-transform] deflate distance before stream start');
      for (let i = 0; i < length; i++) emit(out[outPos - distance]!);
    }
  }

  if (outPos !== expectedSize) throw new Error('[media-transform] deflate output is shorter than the PNG size');
  return out;
}
