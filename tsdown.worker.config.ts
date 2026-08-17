import { defineConfig } from 'tsdown';

/**
 * The Worker entry, built SELF-CONTAINED — separately from everything else.
 *
 * ## Why this needs its own config
 *
 * The main build lists `image/BrowserImageAdapter` and `image/workerProtocol` as
 * their own entries (they are public subpaths), so tsdown treats them as
 * EXTERNAL from `worker.js` and emits `import { … } from "./BrowserImageAdapter.js"`.
 * That is correct for a normal module and fatal for a worker: a bundler copies
 * the worker out to its own asset URL (`/_next/static/media/worker.<hash>.js`),
 * where those siblings do not exist.
 *
 * Measured in a real browser against a running Next/Turbopack app (2026-08-13):
 * the asset served `200`, `new Worker(...)` CONSTRUCTED fine, and then
 * `/_next/static/media/BrowserImageAdapter.js` `404`ed — so the module never
 * executed, never registered its `message` listener, and never answered. The
 * caller saw no error and no reply: the upload just hung until the timeout.
 *
 * Static analysis could not have caught this. The chunk was emitted, the URL was
 * right, and every unit test passed — the failure only exists once something
 * actually loads the file from that URL.
 *
 * So the worker is bundled with NOTHING external except real npm packages, which
 * a worker can still resolve. One file, no siblings.
 */
export default defineConfig({
  entry: { 'image/worker': 'src/image/worker.ts' },
  format: 'esm',
  platform: 'browser',
  dts: false,
  sourcemap: false,
  // NOT `clean` — this runs after the main build and must not delete it.
  clean: false,
  treeshake: true,
  deps: {
    // Bundle our own relative modules INTO the worker; keep third-party
    // (the optional `thumbhash` peer) external and lazily imported as before.
    skipNodeModulesBundle: true,
  },
});
