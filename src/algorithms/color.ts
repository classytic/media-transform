/**
 * Pure color math over raw RGBA bytes. Used to compute a `dominantColor`
 * display hint client-side (the same field media-kit's server processing
 * derives with sharp), so client-processed uploads carry complete metadata.
 */

/**
 * Alpha-weighted average color of RGBA pixels as `#rrggbb` (lowercase).
 * Alpha weighting keeps transparent padding from washing the result toward
 * black. Returns `#000000` for empty/fully-transparent input.
 */
export function averageColorHex(rgba: Uint8Array): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    r += rgba[i]! * a;
    g += rgba[i + 1]! * a;
    b += rgba[i + 2]! * a;
    weight += a;
  }
  if (weight === 0) return '#000000';
  return `#${channel(r / weight)}${channel(g / weight)}${channel(b / weight)}`;
}

function channel(value: number): string {
  return Math.min(255, Math.max(0, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}
