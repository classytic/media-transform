// @vitest-environment node
// Node, not happy-dom: React Native has no `document`, and the adapter's
// Expo-web canvas probe must not run in the native cases.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { averageColorHex } from '../../src/algorithms/color';
import { sha256Hex } from '../../src/algorithms/hash';
import { PRESETS } from '../../src/algorithms/presets';
import { toUploadHints } from '../../src/image/uploadHints';
import {
  createExpoImageAdapter,
  createExpoMediaTransform,
  detectExpoEncodable,
} from '../../src/native/ExpoImageAdapter';
import { resolveTransformPlan } from '../../src/policy';
import { createFakeExpo } from '../support/fakeExpo';

const PHOTO = 'file:///picker/photo.jpg';
const SMALL = 'file:///picker/small.jpg';

// Minimal JPEG: SOI, APP1 "Exif\0\0" + GPS-ish bytes, SOS, data, EOI.
const exifJpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x11, 0x22, 0xff, 0xda, 0x00, 0x04, 0x01,
  0x02, 0xaa, 0xbb, 0xff, 0xd9,
]);
const cleanJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xaa, 0xbb, 0xff, 0xd9]);

function setup(extra: Parameters<typeof createFakeExpo>[0] = {}) {
  const fake = createFakeExpo({
    images: {
      [PHOTO]: { width: 4000, height: 3000, bytes: new Uint8Array(3_000_000) },
      [SMALL]: { width: 400, height: 300, bytes: exifJpeg },
      ...extra.images,
    },
    ...extra,
  });
  const mt = createExpoMediaTransform({ modules: fake.modules as never });
  return { ...fake, mt };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createExpoMediaTransform: sizing and encoding', () => {
  it('applies the chat preset: 4000x3000 → 1600x1200 WebP q0.82 through the halving plan', async () => {
    const { mt, log } = setup();
    const out = await mt.compressImage(PHOTO, { ...PRESETS.chat, thumbhash: false });

    expect(out).toMatchObject({ width: 1600, height: 1200, format: 'webp', passedThrough: false });
    expect(out.sourceBytes).toBe(3_000_000);
    expect(out.uri).toMatch(/^file:\/\/\/cache\/ImageManipulator\/\d+\.webp$/);
    expect(out.bytes).toBe(out.blob.size);
    // decode context on the URI, then the encode context on the decoded ImageRef
    expect(log.contexts[0]?.source).toBe(PHOTO);
    expect(log.contexts[1]?.source).toBe('ref');
    expect(log.contexts[1]?.resizes).toEqual([
      { width: 2000, height: 1500 },
      { width: 1600, height: 1200 },
    ]);
    expect(log.saves).toEqual([{ format: 'webp', compress: 0.82, width: 1600, height: 1200 }]);
  });

  it('re-encodes without resizing when the source is already within bounds', async () => {
    const { mt, log } = setup({ images: { 'file:///p/mid.jpg': { width: 1200, height: 900 } } });
    const out = await mt.compressImage('file:///p/mid.jpg', { maxEdge: 1600, format: 'jpeg', quality: 0.7 });
    expect(out).toMatchObject({ width: 1200, height: 900, format: 'jpeg' });
    expect(log.contexts[1]?.resizes).toEqual([]);
    expect(log.saves[0]).toMatchObject({ format: 'jpeg', compress: 0.7 });
  });

  it('accepts an asset object ({ uri }) like expo-image-picker returns', async () => {
    const { mt } = setup();
    const out = await mt.compressImage({ uri: PHOTO }, { maxEdge: 800, format: 'jpeg' });
    expect(out.width).toBe(800);
  });

  it('releases every native ref and context it created', async () => {
    const { mt, log } = setup();
    await mt.compressImage(PHOTO, { maxEdge: 1600, thumbhash: true });
    // decode (ref + ctx), encode (ref + ctx), rgba (ref + ctx)
    expect(log.released).toBe(6);
  });
});

describe('format detection and fallback', () => {
  it('detects JPEG/PNG/WebP from SaveFormat', () => {
    const { modules } = createFakeExpo();
    expect([...detectExpoEncodable(modules.manipulator as never)].sort()).toEqual(['jpeg', 'png', 'webp']);
  });

  it('keeps the JPEG/PNG floor when the module has no SaveFormat export', () => {
    const { modules } = createFakeExpo({ saveFormat: null });
    expect([...detectExpoEncodable(modules.manipulator as never)].sort()).toEqual(['jpeg', 'png']);
  });

  it('falls back to JPEG when WebP is not encodable', async () => {
    const { mt, log } = setup({ saveFormat: { JPEG: 'jpeg', PNG: 'png' } });
    const out = await mt.compressImage(PHOTO, { maxEdge: 1600, format: ['webp', 'jpeg'] });
    expect(out.format).toBe('jpeg');
    expect(log.saves[0]?.format).toBe('jpeg');
  });

  it('never claims AVIF: an AVIF-first preference resolves to WebP', async () => {
    const { mt } = setup();
    const out = await mt.compressImage(PHOTO, { maxEdge: 1600, format: ['avif', 'webp', 'jpeg'] });
    expect(out.format).toBe('webp');
  });

  it('honours an explicit encodable override (JPEG always kept)', async () => {
    const { modules } = createFakeExpo();
    const adapter = await createExpoImageAdapter({ modules: modules as never, encodable: ['png'] });
    expect([...adapter.encodable].sort()).toEqual(['jpeg', 'png']);
  });

  it('on Expo web, drops WebP when the canvas cannot encode it (Safari)', () => {
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, toDataURL: () => 'data:image/png;base64,AAAA' }),
    });
    const { modules } = createFakeExpo();
    expect(detectExpoEncodable(modules.manipulator as never).has('webp')).toBe(false);
  });

  it('on Expo web, keeps WebP when the canvas encodes it', () => {
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, toDataURL: (t: string) => `data:${t};base64,AAAA` }),
    });
    const { modules } = createFakeExpo();
    expect(detectExpoEncodable(modules.manipulator as never).has('webp')).toBe(true);
  });
});

describe('placeholders and upload hints', () => {
  it('produces a thumbhash and dominantColor from a ≤100px PNG, and cleans the temp file', async () => {
    const { mt, log, disk } = setup({ color: [10, 120, 250, 255] });
    const out = await mt.compressImage(PHOTO, { ...PRESETS.chat, dominantColor: true });

    expect(out.thumbhash).toBeInstanceOf(Uint8Array);
    expect(out.dominantColor).toBe(averageColorHex(new Uint8Array([10, 120, 250, 255])));
    const pngSave = log.saves.find((s) => s.format === 'png');
    expect(pngSave).toMatchObject({ width: 100, height: 75 });
    expect(log.deleted.some((u) => u.endsWith('.png'))).toBe(true);
    expect([...disk.keys()].some((u) => u.endsWith('.png'))).toBe(false);

    const hints = toUploadHints(out);
    expect(hints).toMatchObject({ width: 1600, height: 1200, dominantColor: out.dominantColor });
    expect(hints.thumbhash).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(hints.thumbhash?.length).toBeLessThanOrEqual(128); // media-kit's limit
  });

  it('a placeholder failure never fails the upload', async () => {
    const { mt } = setup({ failSave: ['png'] });
    const out = await mt.compressImage(PHOTO, { ...PRESETS.chat, dominantColor: true });
    expect(out.width).toBe(1600);
    expect(out.thumbhash).toBeUndefined();
    expect(out.dominantColor).toBeUndefined();
  });
});

describe('passthrough privacy (no re-encode)', () => {
  it('strips EXIF/GPS from a small passed-through JPEG into a cache file', async () => {
    const { mt, disk } = setup();
    const out = await mt.compressImage(SMALL, { ...PRESETS.chat, thumbhash: false });

    expect(out.passedThrough).toBe(true);
    expect(out.format).toBe('jpeg');
    expect(out.uri).not.toBe(SMALL);
    expect(out.uri).toMatch(/^file:\/\/\/cache\/media-transform-.+\.jpg$/);
    const stored = disk.get(out.uri) as Uint8Array;
    expect(Buffer.from(stored).includes(Buffer.from('Exif'))).toBe(false);
    expect(out.bytes).toBe(stored.length);
    expect(out.bytes).toBeLessThan(exifJpeg.length);
  });

  it('returns the source itself when there is nothing to strip, and discard never deletes it', async () => {
    const { mt, disk } = setup({ images: { 'file:///p/clean.jpg': { width: 200, height: 100, bytes: cleanJpeg } } });
    const out = await mt.compressImage('file:///p/clean.jpg', { ...PRESETS.chat, thumbhash: false });
    expect(out.passedThrough).toBe(true);
    expect(out.uri).toBe('file:///p/clean.jpg');
    mt.discard(out);
    await Promise.resolve();
    await Promise.resolve();
    expect(disk.has('file:///p/clean.jpg')).toBe(true);
  });
});

describe('derivatives, policy and cleanup', () => {
  it('resolves the host policy from describe() facts and produces derivative files', async () => {
    const { mt, disk } = setup();
    const facts = await mt.describe(PHOTO, 'incidents');
    expect(facts).toEqual({ mimeType: 'image/jpeg', bytes: 3_000_000, folder: 'incidents' });

    const plan = resolveTransformPlan(facts, {
      version: 1,
      rules: [
        {
          id: 'field-photos',
          when: { folder: ['incidents'] },
          use: { preset: 'chat', derivatives: [{ name: 'thumb', maxEdge: 320 }] },
        },
      ],
      fallback: false,
    });
    expect(plan.transform).toBe(true);
    if (!plan.transform) return;

    const set = await mt.compressImageSet(PHOTO, { ...plan.options, thumbhash: false });
    expect(set).toMatchObject({ width: 1600, height: 1200, skipped: [] });
    expect(set.derivatives).toHaveLength(1);
    expect(set.derivatives[0]).toMatchObject({ name: 'thumb', width: 320, height: 240 });
    expect(set.derivatives[0]?.uri).toMatch(/^file:\/\/\/cache\/ImageManipulator\//);

    mt.discard(set);
    await new Promise((r) => setTimeout(r, 0));
    expect(disk.has(set.uri)).toBe(false);
    expect(disk.has(set.derivatives[0]?.uri as string)).toBe(false);
    expect(disk.has(PHOTO)).toBe(true);
  });

  it('a failed derivative lands in `skipped` even without a DOMException global (React Native)', async () => {
    vi.stubGlobal('DOMException', undefined);
    const { mt } = setup({ failSave: ['png'] });
    const set = await mt.compressImageSet(PHOTO, {
      maxEdge: 1600,
      format: 'jpeg',
      derivatives: [{ name: 'thumb', maxEdge: 320, format: 'png' }],
    });
    expect(set.width).toBe(1600);
    expect(set.skipped).toEqual([{ name: 'thumb', reason: 'encode-failed', detail: 'encoder failed for png' }]);
  });

  it('an abort without a DOMException global still rejects with an AbortError', async () => {
    vi.stubGlobal('DOMException', undefined);
    const { mt } = setup();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(mt.compressImage(PHOTO, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('dedup hash', () => {
  it('uses expo-crypto when installed and matches the core sha256Hex', async () => {
    const { mt, log, disk } = setup({ crypto: true });
    const out = await mt.compressImage(PHOTO, { maxEdge: 1600, format: 'jpeg' });
    const hex = await mt.sha256(out.uri);
    expect(log.digests).toBe(1);
    expect(hex).toBe(await sha256Hex(disk.get(out.uri) as Uint8Array));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the bytes to PUT (RN fetch cannot send a File body)', async () => {
    const { mt, disk } = setup();
    const out = await mt.compressImage(PHOTO, { maxEdge: 1600, format: 'jpeg' });
    expect(await mt.bytes(out.uri)).toEqual(disk.get(out.uri));
  });

  it('falls back to WebCrypto without expo-crypto', async () => {
    const { mt, disk } = setup();
    expect(await mt.sha256(PHOTO)).toBe(await sha256Hex(disk.get(PHOTO) as Uint8Array));
  });

  it('throws an install hint when neither expo-crypto nor WebCrypto exists', async () => {
    vi.stubGlobal('crypto', undefined);
    const { mt } = setup();
    await expect(mt.sha256(PHOTO)).rejects.toThrow(/expo-crypto/);
  });
});

describe('error paths', () => {
  it('names the URI when the native decoder cannot open it', async () => {
    const { mt, log } = setup();
    await expect(mt.compressImage('file:///missing.jpg')).rejects.toThrow(
      /could not decode image file:\/\/\/missing\.jpg/,
    );
    expect(log.released).toBe(1); // the decode context
  });

  it('refuses to encode a format the runtime cannot write', async () => {
    const { modules } = createFakeExpo({ images: { [PHOTO]: { width: 10, height: 10 } } });
    const adapter = await createExpoImageAdapter({ modules: modules as never });
    const image = await adapter.decode(adapter.toBlob(PHOTO));
    await expect(adapter.resizeAndEncode(image, { width: 5, height: 5 }, [], 'avif', 0.8)).rejects.toThrow(
      /avif is not encodable/,
    );
    image.close();
  });

  it('refuses an image another adapter decoded', async () => {
    const { modules } = createFakeExpo();
    const adapter = await createExpoImageAdapter({ modules: modules as never });
    const foreign = { handle: {}, width: 1, height: 1, close: () => undefined };
    await expect(adapter.resizeAndEncode(foreign, { width: 1, height: 1 }, [], 'jpeg', 0.8)).rejects.toThrow(
      /did not decode/,
    );
  });

  it('stages a bare Blob in the cache to decode it, then removes it', async () => {
    const { modules, disk, images } = createFakeExpo();
    const adapter = await createExpoImageAdapter({ modules: modules as never });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    // The fake decoder only knows registered URIs: register whatever the adapter stages.
    const realSet = disk.set.bind(disk);
    disk.set = (uri: string, bytes: Uint8Array) => {
      if (uri.startsWith('file:///cache/media-transform-')) images.set(uri, { width: 8, height: 4 });
      return realSet(uri, bytes);
    };
    const image = await adapter.decode(blob);
    expect(image.width).toBe(8);
    const staged = [...disk.keys()].find((u) => u.startsWith('file:///cache/media-transform-'));
    expect(staged).toMatch(/\.png$/);
    image.close();
    expect(disk.has(staged as string)).toBe(false);
  });
});

describe('loading the optional peers', () => {
  it('retries a failed module load on the next call instead of caching the failure', async () => {
    const { modules } = createFakeExpo({ images: { [PHOTO]: { width: 10, height: 10 } } });
    let attempts = 0;
    const flaky = {
      get manipulator() {
        attempts++;
        if (attempts === 1) throw new Error('not yet');
        return modules.manipulator;
      },
      fileSystem: modules.fileSystem,
    };
    const mt = createExpoMediaTransform({ modules: flaky as never });
    await expect(mt.compressImage(PHOTO)).rejects.toThrow(/not yet/);
    await expect(mt.compressImage(PHOTO, { format: 'jpeg' })).resolves.toMatchObject({ width: 10 });
  });
});
