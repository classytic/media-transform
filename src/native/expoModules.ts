/**
 * The Expo modules the native adapter drives, described STRUCTURALLY.
 *
 * Only the members this package calls are declared, so the shapes double as
 * documentation of exactly which Expo API surface the adapter depends on (and
 * the tests' fakes implement precisely these). Checked against the SDK 55
 * sources: `expo-image-manipulator` 55.0.x (the contextual
 * `ImageManipulator.manipulate(uri).resize().renderAsync()` →
 * `ImageRef.saveAsync({ format, compress })` API; the deprecated
 * `manipulateAsync` is never used), `expo-file-system` 55.0.x (the object API:
 * `File` / `Paths`; the deprecated `expo-file-system/legacy` is never used) and
 * `expo-crypto` 55.0.x (`digest`).
 *
 * ## Why every import sits alone inside a `try`
 *
 * The peers are OPTIONAL. Metro resolves `import('x')` at bundle time and fails
 * the whole bundle when `x` is missing, EXCEPT when the import is inside a
 * `try` block and the project allows optional dependencies, which Expo's Metro
 * config does (`allowOptionalDependencies: true`). So `expo-crypto` absent is a
 * clean fallback rather than a red screen. The specifiers stay static string
 * literals: Metro cannot follow a computed one.
 */

/** A rendered native image (`ImageRef` / `SharedRef<'image'>`). */
export interface ExpoImageRef {
  readonly width: number;
  readonly height: number;
  saveAsync(options?: {
    format?: string;
    compress?: number;
    base64?: boolean;
  }): Promise<{ uri: string; width: number; height: number }>;
  /** Free the native bitmap now instead of at GC (`SharedObject.release`). */
  release?(): void;
}

/** `ImageManipulatorContext`: chainable, work scheduled on a background thread. */
export interface ExpoManipulatorContext {
  resize(size: { width?: number | null; height?: number | null }): ExpoManipulatorContext;
  renderAsync(): Promise<ExpoImageRef>;
  release?(): void;
}

export interface ExpoImageManipulatorModule {
  ImageManipulator: {
    manipulate(source: string | ExpoImageRef): ExpoManipulatorContext;
  };
  /** The `SaveFormat` enum (`{ JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' }`); used for feature detection. */
  SaveFormat?: Readonly<Record<string, string>>;
}

/**
 * `expo-file-system`'s `File`. The real class `implements Blob` (`size`,
 * `type`, `arrayBuffer()`, `slice()`, `stream()`), so it can be the `blob` of a
 * {@link CompressImageResult} and be uploaded with `fetch(url, { body: file })`.
 */
export interface ExpoFile extends Blob {
  readonly uri: string;
  readonly exists: boolean;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  create(options?: { overwrite?: boolean; intermediates?: boolean }): void;
  write(content: Uint8Array): void;
  delete(): void;
}

export interface ExpoFileSystemModule {
  File: new (...uris: (string | ExpoFile | object)[]) => ExpoFile;
  Paths: { readonly cache: object };
}

export interface ExpoCryptoModule {
  /** `digest(CryptoDigestAlgorithm.SHA256, bytes)`; the enum value is the string `'SHA-256'`. */
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

/** Everything the native path needs. Inject it (tests, custom builds) or let {@link loadExpoModules} find it. */
export interface ExpoModules {
  manipulator: ExpoImageManipulatorModule;
  fileSystem: ExpoFileSystemModule;
  /** Optional: the SHA-256 for the dedup handshake. Absent ⇒ WebCrypto, if the runtime has it. */
  crypto?: ExpoCryptoModule | undefined;
}

function missing(name: string, cause: unknown): Error {
  return new Error(
    `[media-transform] the native image path needs "${name}" (npx expo install ${name}). ` +
      `It is an optional peer of @classytic/media-transform: install it in the app. Cause: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
  );
}

/**
 * A bundler may hand back the CJS-interop namespace (`{ default: module }`)
 * instead of the module itself; take whichever one carries `key`.
 */
function interop<T>(mod: T & { default?: T }, key: string): T {
  return mod !== null && typeof mod === 'object' && !(key in mod) && mod.default ? mod.default : mod;
}

/** Load the Expo peers. Throws a clear install hint when a REQUIRED one is missing. */
export async function loadExpoModules(): Promise<ExpoModules> {
  let manipulator: ExpoImageManipulatorModule;
  try {
    manipulator = interop(await import('expo-image-manipulator'), 'ImageManipulator');
  } catch (err) {
    throw missing('expo-image-manipulator', err);
  }
  let fileSystem: ExpoFileSystemModule;
  try {
    fileSystem = interop(await import('expo-file-system'), 'File');
  } catch (err) {
    throw missing('expo-file-system', err);
  }
  let crypto: ExpoCryptoModule | undefined;
  try {
    crypto = interop(await import('expo-crypto'), 'digest');
  } catch {
    crypto = undefined; // optional: fall back to WebCrypto at hash time
  }
  return { manipulator, fileSystem, crypto };
}
