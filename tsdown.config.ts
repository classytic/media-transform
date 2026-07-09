import { defineConfig } from 'tsdown';

/**
 * Tree-shaken ESM output — one entry per subpath export. Types are emitted
 * separately via `tsc --emitDeclarationOnly` (see package.json `build`).
 *
 * Bundles NOTHING from node_modules (`skipNodeModulesBundle`): the optional
 * `thumbhash` peer (and any future muxer / WASM codec) stays external and is
 * loaded via `await import()` at the call site. No sourcemaps (they leak
 * source). No `"use client"` banner — this package has zero React; it's pure
 * browser/runtime code that a React binding wraps elsewhere.
 *
 * ONE entry per module (not per barrel): each maps to a granular subpath
 * export so consumers import exactly one leaf and a bundler loads nothing
 * else — the Vercel "avoid barrel imports" contract, enforced at the build.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
    capabilities: 'src/capabilities.ts',
    'algorithms/sizing': 'src/algorithms/sizing.ts',
    'algorithms/format': 'src/algorithms/format.ts',
    'algorithms/sanitize': 'src/algorithms/sanitize.ts',
    'algorithms/presets': 'src/algorithms/presets.ts',
    'algorithms/hash': 'src/algorithms/hash.ts',
    'algorithms/color': 'src/algorithms/color.ts',
    'image/llmPayload': 'src/image/llmPayload.ts',
    'image/uploadHints': 'src/image/uploadHints.ts',
    'image/compressImage': 'src/image/compressImage.ts',
    'image/ImageIOAdapter': 'src/image/ImageIOAdapter.ts',
    'image/BrowserImageAdapter': 'src/image/BrowserImageAdapter.ts',
    'image/workerProtocol': 'src/image/workerProtocol.ts',
    'image/worker': 'src/image/worker.ts',
    'react/useImageCompress': 'src/react/useImageCompress.ts',
    'react/useImageUpload': 'src/react/useImageUpload.ts',
  },
  format: 'esm',
  platform: 'browser',
  dts: false,
  sourcemap: false,
  clean: true,
  treeshake: true,
  deps: { skipNodeModulesBundle: true },
});
