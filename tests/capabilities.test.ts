import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBrowserImageSupported, isWebCodecsVideoSupported } from '../src/capabilities';

describe('isBrowserImageSupported', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('true when createImageBitmap + OffscreenCanvas(convertToBlob) exist', () => {
    vi.stubGlobal('createImageBitmap', () => {});
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        convertToBlob() {}
      },
    );
    expect(isBrowserImageSupported()).toBe(true);
  });

  it('false when OffscreenCanvas is absent', () => {
    vi.stubGlobal('createImageBitmap', () => {});
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(isBrowserImageSupported()).toBe(false);
  });

  it('false when convertToBlob is missing from OffscreenCanvas', () => {
    vi.stubGlobal('createImageBitmap', () => {});
    vi.stubGlobal('OffscreenCanvas', class {});
    expect(isBrowserImageSupported()).toBe(false);
  });
});

describe('isWebCodecsVideoSupported', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('true when VideoEncoder + VideoFrame exist', () => {
    vi.stubGlobal('VideoEncoder', class {});
    vi.stubGlobal('VideoFrame', class {});
    expect(isWebCodecsVideoSupported()).toBe(true);
  });

  it('false when WebCodecs is absent', () => {
    vi.stubGlobal('VideoEncoder', undefined);
    vi.stubGlobal('VideoFrame', undefined);
    expect(isWebCodecsVideoSupported()).toBe(false);
  });
});
