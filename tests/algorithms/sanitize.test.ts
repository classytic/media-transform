import { describe, expect, it } from 'vitest';
import {
  stripImageMetadata,
  stripJpegMetadata,
  stripPngMetadata,
  stripWebpMetadata,
} from '../../src/algorithms/sanitize';

// ============ synthetic file builders (minimal valid structures) ============

function jpegSegment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

/** SOI + provided segments + SOS + fake entropy data + EOI. */
function buildJpeg(segments: number[][]): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    ...segments.flat(),
    0xff, 0xda, 0x00, 0x04, 0x01, 0x02, // SOS (len 4)
    0xaa, 0xbb, 0xcc, // entropy-coded data
    0xff, 0xd9, // EOI
  ]);
}

const APP0_JFIF = jpegSegment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00]); // "JFIF\0"
const APP1_EXIF = jpegSegment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x11, 0x22]); // "Exif\0\0" + gps-ish bytes
const APP2_ICC = jpegSegment(0xe2, [0x49, 0x43, 0x43, 0x5f]); // "ICC_"
const APP13_IPTC = jpegSegment(0xed, [0x50, 0x68, 0x6f, 0x74]); // "Phot"
const COM = jpegSegment(0xfe, [0x68, 0x69]); // comment "hi"

function pngChunk(type: string, data: number[]): number[] {
  const len = data.length;
  return [
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0, 0, 0, 0, // CRC (not validated by the stripper)
  ];
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function buildPng(chunks: number[][]): Uint8Array {
  return new Uint8Array([...PNG_SIG, ...chunks.flat()]);
}

function webpChunk(fourcc: string, data: number[]): number[] {
  const size = data.length;
  const bytes = [
    ...[...fourcc].map((c) => c.charCodeAt(0)),
    size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff,
    ...data,
  ];
  if (size % 2 === 1) bytes.push(0); // 2-byte alignment pad
  return bytes;
}

function buildWebp(chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  const riffSize = 4 + body.length; // "WEBP" + chunks
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // RIFF
    riffSize & 0xff, (riffSize >> 8) & 0xff, (riffSize >> 16) & 0xff, (riffSize >> 24) & 0xff,
    0x57, 0x45, 0x42, 0x50, // WEBP
    ...body,
  ]);
}

// ============================== JPEG ==============================

describe('stripJpegMetadata', () => {
  it('removes APP1/APP13/COM, keeps JFIF + ICC + image data', () => {
    const src = buildJpeg([APP0_JFIF, APP1_EXIF, APP2_ICC, APP13_IPTC, COM]);
    const out = stripJpegMetadata(src);
    expect(out).not.toBe(src);
    expect(out.length).toBeLessThan(src.length);

    const hex = Buffer.from(out).toString('hex');
    expect(hex).toContain('4a46494600'); // JFIF kept
    expect(hex).toContain('4943435f'); // ICC kept
    expect(hex).not.toContain('457869660000'); // Exif\0\0 gone
    expect(hex.startsWith('ffd8')).toBe(true);
    expect(hex.endsWith('ffd9')).toBe(true); // entropy data + EOI intact
    expect(hex).toContain('aabbcc'); // pixel data untouched
  });

  it('returns the SAME reference when there is nothing to strip', () => {
    const src = buildJpeg([APP0_JFIF, APP2_ICC]);
    expect(stripJpegMetadata(src)).toBe(src);
  });

  it('ignores non-JPEG bytes', () => {
    const src = new Uint8Array([1, 2, 3, 4]);
    expect(stripJpegMetadata(src)).toBe(src);
  });

  it('stops safely on a truncated/malformed segment length', () => {
    const src = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x01]); // APP1 claims huge length
    expect(stripJpegMetadata(src)).toBe(src); // nothing stripped, no throw
  });
});

// ============================== PNG ==============================

describe('stripPngMetadata', () => {
  it('removes eXIf/tEXt/iTXt/tIME, keeps IHDR/iCCP/IDAT/IEND', () => {
    const src = buildPng([
      pngChunk('IHDR', new Array(13).fill(1)),
      pngChunk('iCCP', [1, 2, 3]),
      pngChunk('eXIf', [9, 9, 9]),
      pngChunk('tEXt', [65, 0, 66]),
      pngChunk('iTXt', [7, 7]),
      pngChunk('tIME', [1, 2, 3, 4, 5, 6, 7]),
      pngChunk('IDAT', [42, 42]),
      pngChunk('IEND', []),
    ]);
    const out = stripPngMetadata(src);
    expect(out).not.toBe(src);

    const ascii = Buffer.from(out).toString('latin1');
    expect(ascii).toContain('IHDR');
    expect(ascii).toContain('iCCP');
    expect(ascii).toContain('IDAT');
    expect(ascii).toContain('IEND');
    expect(ascii).not.toContain('eXIf');
    expect(ascii).not.toContain('tEXt');
    expect(ascii).not.toContain('iTXt');
    expect(ascii).not.toContain('tIME');
  });

  it('returns the SAME reference for a clean PNG', () => {
    const src = buildPng([pngChunk('IHDR', new Array(13).fill(1)), pngChunk('IDAT', [1]), pngChunk('IEND', [])]);
    expect(stripPngMetadata(src)).toBe(src);
  });

  it('ignores non-PNG bytes', () => {
    const src = new Uint8Array([1, 2, 3]);
    expect(stripPngMetadata(src)).toBe(src);
  });
});

// ============================== WebP ==============================

describe('stripWebpMetadata', () => {
  it('removes EXIF/XMP chunks, clears VP8X flags, patches RIFF size', () => {
    // VP8X payload: flags byte with ICC(0x20)+EXIF(0x08)+XMP(0x04) set, then 9 reserved/dim bytes.
    const vp8x = webpChunk('VP8X', [0x2c, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
    const src = buildWebp([
      vp8x,
      webpChunk('ICCP', [1, 2, 3, 4]),
      webpChunk('EXIF', [9, 9, 9, 9, 9]),
      webpChunk('XMP ', [8, 8]),
      webpChunk('VP8 ', [1, 2, 3, 4, 5, 6]),
    ]);
    const out = stripWebpMetadata(src);
    expect(out).not.toBe(src);

    const ascii = Buffer.from(out).toString('latin1');
    expect(ascii).toContain('ICCP');
    expect(ascii).toContain('VP8X');
    expect(ascii).toContain('VP8 ');
    expect(ascii).not.toContain('EXIF');
    expect(ascii).not.toContain('XMP ');

    // RIFF size patched to actual content length
    const riffSize = out[4]! | (out[5]! << 8) | (out[6]! << 16) | (out[7]! << 24);
    expect(riffSize).toBe(out.length - 8);

    // VP8X flags: EXIF (0x08) and XMP (0x04) cleared, ICC (0x20) kept
    const vp8xOffset = ascii.indexOf('VP8X');
    const flags = out[vp8xOffset + 8]!;
    expect(flags & 0x08).toBe(0);
    expect(flags & 0x04).toBe(0);
    expect(flags & 0x20).toBe(0x20);
  });

  it('returns the SAME reference for a clean WebP', () => {
    const src = buildWebp([webpChunk('VP8 ', [1, 2, 3, 4])]);
    expect(stripWebpMetadata(src)).toBe(src);
  });

  it('ignores non-WebP bytes', () => {
    const src = new Uint8Array([1, 2, 3]);
    expect(stripWebpMetadata(src)).toBe(src);
  });
});

// ============================ dispatcher ============================

describe('stripImageMetadata', () => {
  it('dispatches by MIME and returns unknown types unchanged', () => {
    const jpeg = buildJpeg([APP1_EXIF]);
    expect(stripImageMetadata(jpeg, 'image/jpeg')).not.toBe(jpeg);
    const gif = new Uint8Array([0x47, 0x49, 0x46]);
    expect(stripImageMetadata(gif, 'image/gif')).toBe(gif);
    expect(stripImageMetadata(jpeg, 'image/JPEG')).not.toBe(jpeg); // case-insensitive
  });
});
