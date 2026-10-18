import { expect } from 'vitest';
import { rgbaPng } from './encodePng';

/**
 * In-memory stand-ins for the three Expo modules, implementing exactly the
 * structural surface `src/native/expoModules.ts` declares. The fake
 * manipulator records every context it creates (resize chain, save options,
 * releases) so tests assert the adapter's CALLS, and its PNG output is a real
 * PNG so the thumbhash / dominantColor path runs end to end.
 */
export interface FakeImage {
  width: number;
  height: number;
  bytes?: Uint8Array;
}

export interface FakeExpoOptions {
  images?: Record<string, FakeImage>;
  /** The module's `SaveFormat` enum. `null` = the module exports none. */
  saveFormat?: Record<string, string> | null;
  /** Formats whose `saveAsync` rejects. */
  failSave?: string[];
  /** Fill colour of PNG output (for dominantColor). */
  color?: [number, number, number, number];
  crypto?: boolean;
}

const EXT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
};

export function createFakeExpo(opts: FakeExpoOptions = {}) {
  const disk = new Map<string, Uint8Array>();
  const images = new Map<string, FakeImage>();
  for (const [uri, img] of Object.entries(opts.images ?? {})) {
    images.set(uri, img);
    disk.set(uri, img.bytes ?? new Uint8Array(1000));
  }
  const cache = { uri: 'file:///cache/' };
  const log = {
    contexts: [] as Array<{ source: string; resizes: Array<{ width?: number | null; height?: number | null }> }>,
    saves: [] as Array<{ format: string | undefined; compress: number | undefined; width: number; height: number }>,
    released: 0,
    deleted: [] as string[],
    digests: 0,
  };
  let saved = 0;

  class FakeFile {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      const [first, second] = parts;
      if (first === cache) this.uri = `${cache.uri}${String(second)}`;
      else if (typeof first === 'string') this.uri = first;
      else this.uri = (first as { uri: string }).uri;
    }
    get exists() {
      return disk.has(this.uri);
    }
    get size() {
      return disk.get(this.uri)?.length ?? 0;
    }
    get type() {
      return EXT_TYPE[this.uri.split('.').pop()?.toLowerCase() ?? ''] ?? '';
    }
    async bytes() {
      const b = disk.get(this.uri);
      if (!b) throw new Error(`ENOENT ${this.uri}`);
      return b;
    }
    async arrayBuffer() {
      const b = await this.bytes();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    create() {
      disk.set(this.uri, new Uint8Array(0));
    }
    write(content: Uint8Array) {
      disk.set(this.uri, new Uint8Array(content));
    }
    delete() {
      log.deleted.push(this.uri);
      disk.delete(this.uri);
    }
  }

  class FakeImageRef {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    async saveAsync(o: { format?: string; compress?: number } = {}) {
      const format = o.format ?? 'jpeg';
      if (opts.failSave?.includes(format)) throw new Error(`encoder failed for ${format}`);
      log.saves.push({ format: o.format, compress: o.compress, width: this.width, height: this.height });
      const ext = format === 'jpeg' ? 'jpg' : format;
      const uri = `file:///cache/ImageManipulator/${++saved}.${ext}`;
      const color = opts.color ?? [200, 40, 10, 255];
      const bytes =
        format === 'png'
          ? rgbaPng(this.width, this.height, () => color).png
          : new Uint8Array(Math.max(1, Math.round((this.width * this.height * (o.compress ?? 1)) / 50)));
      disk.set(uri, bytes);
      return { uri, width: this.width, height: this.height };
    }
    release() {
      log.released++;
    }
  }

  const manipulator = {
    SaveFormat: opts.saveFormat === null ? undefined : (opts.saveFormat ?? { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' }),
    ImageManipulator: {
      manipulate(source: string | FakeImageRef) {
        const entry = {
          source: typeof source === 'string' ? source : 'ref',
          resizes: [] as Array<{ width?: number | null; height?: number | null }>,
        };
        log.contexts.push(entry);
        const context = {
          resize(size: { width?: number | null; height?: number | null }) {
            entry.resizes.push(size);
            return context;
          },
          async renderAsync() {
            let base: { width: number; height: number };
            if (typeof source === 'string') {
              const img = images.get(source);
              if (!img) throw new Error(`Cannot load image ${source}`);
              base = img;
            } else {
              base = source;
            }
            const last = entry.resizes.at(-1);
            return new FakeImageRef(last?.width ?? base.width, last?.height ?? base.height);
          },
          release() {
            log.released++;
          },
        };
        return context;
      },
    },
  };

  const fileSystem = { File: FakeFile, Paths: { cache } };
  const crypto = opts.crypto
    ? {
        async digest(algorithm: string, data: Uint8Array) {
          log.digests++;
          expect(algorithm).toBe('SHA-256');
          return globalThis.crypto.subtle.digest('SHA-256', data);
        },
      }
    : undefined;

  return { modules: { manipulator, fileSystem, crypto }, disk, log, images };
}
