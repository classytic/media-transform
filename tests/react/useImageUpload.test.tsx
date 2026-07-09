import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useImageUpload, type ImageUploadPayload } from '../../src/react/useImageUpload';
import type { CompressImageResult, MediaTransform } from '../../src/types';

const fakeResult = (): CompressImageResult => ({
  blob: new Blob([new Uint8Array(1000)], { type: 'image/webp' }),
  format: 'webp',
  width: 1600,
  height: 1200,
  bytes: 1000,
  sourceBytes: 10_000,
  passedThrough: false,
});

const transform = (impl?: MediaTransform['compressImage']): MediaTransform => ({
  compressImage: impl ?? vi.fn(async () => fakeResult()),
});

const file = () => new Blob([new Uint8Array(10_000)], { type: 'image/jpeg' });

describe('useImageUpload', () => {
  it('upload-on-pick: processes then uploads immediately, ending ready with the ref', async () => {
    const seen: ImageUploadPayload[] = [];
    const upload = vi.fn(async (payload: ImageUploadPayload) => {
      seen.push(payload);
      return 'media-123';
    });
    const { result } = renderHook(() => useImageUpload({ transform: transform(), upload }));

    let ref: string | null = null;
    await act(async () => {
      ref = await result.current.pick(file(), { maxEdge: 1600 });
    });

    expect(ref).toBe('media-123');
    expect(result.current.status).toBe('ready');
    expect(result.current.uploaded).toBe('media-123');
    expect(result.current.result?.format).toBe('webp');
    // The transport received the COMPRESSED blob, with the original alongside.
    expect(seen[0]?.blob).toBe(result.current.result?.blob);
    expect(seen[0]?.result).not.toBeNull();
    expect(seen[0]?.source.size).toBe(10_000);
  });

  it('process: false uploads the ORIGINAL untouched (the send-as-document path)', async () => {
    const compress = vi.fn(async () => fakeResult());
    const upload = vi.fn(async (p: ImageUploadPayload) => p.blob.size);
    const { result } = renderHook(() => useImageUpload({ transform: transform(compress), upload }));

    await act(async () => {
      await result.current.pick(file(), { process: false });
    });

    expect(compress).not.toHaveBeenCalled();
    expect(result.current.result).toBeNull();
    expect(result.current.uploaded).toBe(10_000); // original bytes uploaded
  });

  it('no transform configured → always uploads originals', async () => {
    const upload = vi.fn(async (p: ImageUploadPayload) => p.result === null);
    const { result } = renderHook(() => useImageUpload({ upload }));
    await act(async () => {
      await result.current.pick(file());
    });
    expect(result.current.uploaded).toBe(true);
  });

  it('a second pick supersedes the first (stale upload ref never lands)', async () => {
    // Identify picks by their source size — pick #1 is superseded during its
    // COMPRESSION stage, so its upload must never even start.
    const upload = vi.fn(async (p: ImageUploadPayload, ctx: { signal: AbortSignal }) => {
      await Promise.resolve();
      if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return `ref-${p.source.size}`;
    });
    const { result } = renderHook(() => useImageUpload({ transform: transform(), upload }));

    const fileOf = (size: number) => new Blob([new Uint8Array(size)], { type: 'image/jpeg' });
    await act(async () => {
      const first = result.current.pick(fileOf(111));
      const second = result.current.pick(fileOf(222));
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBeNull(); // superseded mid-compress → dropped
      expect(b).toBe('ref-222');
    });
    expect(upload).toHaveBeenCalledTimes(1); // pick #1 never reached upload
    expect(result.current.uploaded).toBe('ref-222');
    expect(result.current.status).toBe('ready');
  });

  it('upload failure surfaces as error status', async () => {
    const upload = vi.fn(async () => {
      throw new Error('network down');
    });
    const { result } = renderHook(() => useImageUpload({ transform: transform(), upload }));
    let ref: unknown;
    await act(async () => {
      ref = await result.current.pick(file());
    });
    expect(ref).toBeNull();
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('network down');
  });

  it('cancel() mid-upload aborts; state does not become ready', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const upload = vi.fn(async (_p: ImageUploadPayload, ctx: { signal: AbortSignal }) => {
      await gate;
      if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return 'ref';
    });
    const { result } = renderHook(() => useImageUpload({ transform: transform(), upload }));

    let pending!: Promise<string | null>;
    await act(async () => {
      pending = result.current.pick(file());
      await Promise.resolve(); // reach the uploading stage
    });
    act(() => result.current.cancel());
    await act(async () => {
      release();
      expect(await pending).toBeNull();
    });
    expect(result.current.uploaded).toBeNull();
  });

  it('reset() clears everything back to idle', async () => {
    const upload = vi.fn(async () => 'ref');
    const { result } = renderHook(() => useImageUpload({ transform: transform(), upload }));
    await act(async () => {
      await result.current.pick(file());
    });
    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
    expect(result.current.uploaded).toBeNull();
  });
});

describe('useImageUpload — dedup handshake', () => {
  it('skips the upload entirely on a dedup hit (server load never happens)', async () => {
    const upload = vi.fn(async () => 'uploaded-ref');
    const check = vi.fn(async () => 'existing-ref');
    const { result } = renderHook(() => useImageUpload({ transform: transform(), upload, dedupe: { check } }));

    let ref: string | null = null;
    await act(async () => {
      ref = await result.current.pick(file());
    });

    expect(ref).toBe('existing-ref');
    expect(result.current.status).toBe('ready');
    expect(result.current.uploaded).toBe('existing-ref');
    expect(upload).not.toHaveBeenCalled(); // the whole point
    // check received a real sha256 hex of the compressed blob
    const [hash, payload] = check.mock.calls[0]!;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.hash).toBe(hash);
  });

  it('proceeds with a normal upload on a dedup miss, forwarding the hash', async () => {
    const seen: Array<{ hash?: string | undefined }> = [];
    const upload = vi.fn(async (p: ImageUploadPayload) => {
      seen.push({ hash: p.hash });
      return 'uploaded-ref';
    });
    const { result } = renderHook(() =>
      useImageUpload({ transform: transform(), upload, dedupe: { check: async () => null } }),
    );
    await act(async () => {
      await result.current.pick(file());
    });
    expect(result.current.uploaded).toBe('uploaded-ref');
    expect(seen[0]?.hash).toMatch(/^[0-9a-f]{64}$/); // hash rides along to confirm
  });

  it('fails OPEN: a broken dedup endpoint never blocks the send', async () => {
    const upload = vi.fn(async () => 'uploaded-ref');
    const { result } = renderHook(() =>
      useImageUpload({
        transform: transform(),
        upload,
        dedupe: {
          check: async () => {
            throw new Error('dedup endpoint down');
          },
        },
      }),
    );
    await act(async () => {
      await result.current.pick(file());
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.uploaded).toBe('uploaded-ref');
  });

  it('supports a custom hasher', async () => {
    const check = vi.fn(async () => null);
    const upload = vi.fn(async () => 'r');
    const { result } = renderHook(() =>
      useImageUpload({ upload, dedupe: { check, hash: async () => 'custom-hash' } }),
    );
    await act(async () => {
      await result.current.pick(file());
    });
    expect(check).toHaveBeenCalledWith('custom-hash', expect.objectContaining({ hash: 'custom-hash' }));
  });
});
