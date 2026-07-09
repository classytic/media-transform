/**
 * Runtime feature detection. Callers use these to decide between client-side
 * compression and an "upload the original + let the server handle it" fallback
 * — the same graceful-degradation posture vixel-ui's export path takes with
 * `typeof VideoEncoder !== 'undefined'`.
 */

/** True when the browser image-compression path can run (Canvas encode available). */
export function isBrowserImageSupported(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof new OffscreenCanvas(1, 1).convertToBlob === 'function'
  );
}

/** True when WebCodecs video encoding is available (the client video-transcode path). */
export function isWebCodecsVideoSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}
