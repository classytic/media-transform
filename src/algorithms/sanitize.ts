/**
 * Pure, LOSSLESS metadata stripping — remove EXIF/GPS/XMP/comment segments
 * from image bytes WITHOUT re-encoding pixels (no quality loss, no CPU-heavy
 * decode). Used by the compress passthrough path: an image small enough to
 * skip re-encoding must still not leak the photographer's location.
 *
 * Runtime-agnostic (plain Uint8Array walkers) — usable in the browser, a
 * worker, Node, or React Native. Color-critical data (ICC profiles) is KEPT;
 * only identifying metadata is removed. Every function returns the ORIGINAL
 * array reference when nothing was stripped, so callers can cheaply detect
 * "unchanged" by identity.
 */

/**
 * JPEG: drop APP1 (EXIF incl. GPS, XMP), APP13 (Photoshop/IPTC) and COM
 * (comment) segments. Keeps APP0 (JFIF), APP2 (ICC color profile) and APP14
 * (Adobe transform — required to decode CMYK JPEGs correctly).
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  // SOI marker required.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;

  const STRIP = new Set([0xe1, 0xed, 0xfe]); // APP1, APP13, COM
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  let stripped = false;

  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]!;
    // Standalone markers (no length field): TEM, RSTn. SOI can't repeat but
    // treat defensively. Copy and continue.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    // SOS — entropy-coded data follows until EOI; copy the remainder verbatim.
    if (marker === 0xda) break;
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2 || i + 2 + length > bytes.length) break; // malformed — stop, copy rest
    if (STRIP.has(marker)) {
      stripped = true;
    } else {
      parts.push(bytes.subarray(i, i + 2 + length));
    }
    i += 2 + length;
  }

  if (!stripped) return bytes;
  parts.push(bytes.subarray(i));
  return concat(parts);
}

/**
 * PNG: drop ancillary metadata chunks — eXIf (EXIF incl. GPS), tEXt/zTXt/iTXt
 * (free text; XMP travels in iTXt) and tIME. Keeps structure + color chunks
 * (IHDR/PLTE/IDAT/IEND, gAMA, iCCP, sRGB, ...).
 */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || !SIG.every((b, idx) => bytes[idx] === b)) return bytes;

  const STRIP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let i = 8;
  let stripped = false;

  while (i + 8 <= bytes.length) {
    const length = (bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!;
    const type = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!);
    const total = 8 + length + 4; // len + type + data + crc
    if (length < 0 || i + total > bytes.length) break; // malformed — stop, copy rest
    if (STRIP.has(type)) {
      stripped = true;
    } else {
      parts.push(bytes.subarray(i, i + total));
    }
    i += total;
    if (type === 'IEND') break;
  }

  if (!stripped) return bytes;
  parts.push(bytes.subarray(i));
  return concat(parts);
}

/**
 * WebP (RIFF): drop `EXIF` and `XMP ` chunks, clear the corresponding
 * presence flags in the VP8X header (strict decoders cross-check them), and
 * patch the RIFF size. Keeps `ICCP` (color).
 */
export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  const ascii = (offset: number, len: number) => String.fromCharCode(...bytes.subarray(offset, offset + len));
  if (bytes.length < 12 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') return bytes;

  const STRIP = new Set(['EXIF', 'XMP ']);
  const parts: Uint8Array[] = [];
  let i = 12;
  let stripped = false;
  let vp8xPartIndex = -1;

  while (i + 8 <= bytes.length) {
    const fourcc = ascii(i, 4);
    const size = bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | (bytes[i + 7]! << 24);
    const total = 8 + size + (size % 2); // chunks are 2-byte aligned
    if (size < 0 || i + 8 + size > bytes.length) break;
    if (STRIP.has(fourcc)) {
      stripped = true;
    } else {
      if (fourcc === 'VP8X') vp8xPartIndex = parts.length;
      parts.push(bytes.subarray(i, Math.min(i + total, bytes.length)));
    }
    i += total;
  }

  if (!stripped) return bytes;

  // Rebuild: header (patched size) + kept chunks, with VP8X EXIF/XMP flags cleared.
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12), 0);
  out.set(body, 12);
  const riffSize = out.length - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >> 24) & 0xff;
  if (vp8xPartIndex >= 0) {
    // Locate VP8X in `out`: 12 + offset of that part within body.
    let offset = 12;
    for (let p = 0; p < vp8xPartIndex; p++) offset += parts[p]!.length;
    // Flags byte is the first payload byte (offset + 8). Clear EXIF (0x08) and XMP (0x04).
    out[offset + 8] = out[offset + 8]! & ~0x0c;
  }
  return out;
}

/**
 * Dispatch by MIME type. Unknown/unsupported types are returned UNCHANGED —
 * callers deciding privacy policy should treat "same reference back" as
 * "nothing was (or could be) stripped".
 */
export function stripImageMetadata(bytes: Uint8Array, mimeType: string): Uint8Array {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return stripJpegMetadata(bytes);
    case 'image/png':
      return stripPngMetadata(bytes);
    case 'image/webp':
      return stripWebpMetadata(bytes);
    default:
      return bytes;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
