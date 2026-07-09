import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Two-tier harness. The PURE `algorithms/**` (sizing/format) need no DOM and
 * are the bulk of the coverage. The browser image layer and the React hook are
 * tested through an INJECTED fake `MediaTransform`/adapter (no real
 * `OffscreenCanvas` required), so the whole suite runs green in Node/happy-dom
 * CI without a headless browser. True end-to-end canvas encoding is a
 * browser-mode concern layered on later — the adapter seam keeps that optional.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: true,
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
    },
  },
});
