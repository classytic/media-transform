// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/**
 * The real loader against MOCKED peers. The packages are not installed here,
 * so each case mocks the specifiers it needs and re-imports the loader fresh.
 */
describe('loadExpoModules', () => {
  it('loads all three peers, unwrapping a CJS-interop `default` namespace', async () => {
    vi.resetModules();
    vi.doMock('expo-image-manipulator', () => ({
      ImageManipulator: { manipulate: () => null },
      SaveFormat: { JPEG: 'jpeg' },
    }));
    vi.doMock('expo-file-system', () => ({ default: { File: class {}, Paths: { cache: {} } } }));
    vi.doMock('expo-crypto', () => ({ digest: async () => new ArrayBuffer(32) }));
    const { loadExpoModules } = await import('../../src/native/expoModules');
    const m = await loadExpoModules();
    expect(typeof m.manipulator.ImageManipulator.manipulate).toBe('function');
    expect(typeof m.fileSystem.File).toBe('function');
    expect(typeof m.crypto?.digest).toBe('function');
  });

  it('treats a missing expo-crypto as optional', async () => {
    vi.resetModules();
    vi.doMock('expo-image-manipulator', () => ({ ImageManipulator: { manipulate: () => null } }));
    vi.doMock('expo-file-system', () => ({ File: class {}, Paths: { cache: {} } }));
    vi.doMock('expo-crypto', () => {
      throw new Error('Cannot find module expo-crypto');
    });
    const { loadExpoModules } = await import('../../src/native/expoModules');
    const m = await loadExpoModules();
    expect(m.crypto).toBeUndefined();
  });

  it('throws an install hint when a required peer is missing', async () => {
    vi.resetModules();
    vi.doMock('expo-image-manipulator', () => {
      throw new Error('Cannot find module expo-image-manipulator');
    });
    const { loadExpoModules } = await import('../../src/native/expoModules');
    await expect(loadExpoModules()).rejects.toThrow(/npx expo install expo-image-manipulator/);
  });
});
