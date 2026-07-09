import { describe, expect, it } from 'vitest';
import { blobToBase64, blobToDataUrl, bytesToBase64, toLlmImagePayload } from '../../src/image/llmPayload';
import type { CompressImageResult } from '../../src/types';

describe('bytesToBase64', () => {
  it('matches Buffer base64 across padding cases (0, 1, 2 remainder bytes)', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 6, 255, 256, 1000]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 7 + 13) % 256);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('handles a large payload without stack issues', () => {
    const big = new Uint8Array(2_000_000).fill(0xab);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});

describe('blob helpers', () => {
  it('blobToBase64 + blobToDataUrl round-trip content and type', async () => {
    const bytes = new Uint8Array([255, 216, 255, 217]);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' });
    const b64 = await blobToBase64(blob);
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    expect(await blobToDataUrl(blob)).toBe(`data:image/jpeg;base64,${b64}`);
  });
});

describe('toLlmImagePayload', () => {
  it('packages a compress result for both Anthropic and OpenAI shapes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result: CompressImageResult = {
      blob: new Blob([bytes as unknown as BlobPart], { type: 'image/webp' }),
      format: 'webp',
      width: 1568,
      height: 1176,
      bytes: 3,
      sourceBytes: 100,
      passedThrough: false,
    };
    const payload = await toLlmImagePayload(result);
    expect(payload.mediaType).toBe('image/webp'); // Anthropic source.media_type
    expect(payload.base64).toBe(Buffer.from(bytes).toString('base64')); // Anthropic source.data
    expect(payload.dataUrl).toBe(`data:image/webp;base64,${payload.base64}`); // OpenAI image_url.url
    expect(payload.width).toBe(1568);
    expect(payload.bytes).toBe(3);
  });

  it('is byte-stable: identical input → identical payload (prompt-cache friendly)', async () => {
    const make = (): CompressImageResult => ({
      blob: new Blob([new Uint8Array([9, 8, 7]) as unknown as BlobPart], { type: 'image/jpeg' }),
      format: 'jpeg',
      width: 10,
      height: 10,
      bytes: 3,
      sourceBytes: 3,
      passedThrough: false,
    });
    const [a, b] = await Promise.all([toLlmImagePayload(make()), toLlmImagePayload(make())]);
    expect(a.base64).toBe(b.base64);
    expect(a.dataUrl).toBe(b.dataUrl);
  });
});
