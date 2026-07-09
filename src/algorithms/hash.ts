/**
 * Content hashing for the pre-upload dedup handshake: hash the (compressed)
 * bytes client-side, ask the server's `existsByHash` endpoint, and skip the
 * upload AND the server's processing entirely on a hit — the WhatsApp
 * "forwarding is instant" trick, and the cheapest possible load-shedding.
 *
 * Runtime-agnostic: WebCrypto (`crypto.subtle`) exists in every modern
 * browser, workers, Node ≥16 and React Native (with a polyfill). The hex
 * output matches what @classytic/media-kit stores for `hashStrategy:
 * 'sha256'` / server-side `upload()` dedup, so client and server agree.
 */

/** SHA-256 of a Blob / bytes as lowercase hex. */
export async function sha256Hex(data: Blob | Uint8Array | ArrayBuffer): Promise<string> {
  const buffer =
    data instanceof Blob ? await data.arrayBuffer() : data instanceof Uint8Array ? toArrayBuffer(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return toHex(new Uint8Array(digest));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Views may be offset into a larger buffer — slice to exactly the view.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
