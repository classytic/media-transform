import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAbortError, isAbortError } from '../../src/algorithms/abort';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('abort errors across runtimes', () => {
  it('is a real DOMException where the runtime has one (browser behaviour unchanged)', () => {
    const err = createAbortError();
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe('AbortError');
    expect(isAbortError(err)).toBe(true);
  });

  it('is a plain Error named AbortError where DOMException is missing (React Native)', () => {
    vi.stubGlobal('DOMException', undefined);
    const err = createAbortError('stop');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
    expect(err.message).toBe('stop');
    expect(isAbortError(err)).toBe(true);
  });

  it('recognises nothing else as an abort', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});
