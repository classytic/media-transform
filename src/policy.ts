/**
 * The transform POLICY — the host decides what a client is allowed to do to an
 * upload, and the client obeys.
 *
 * ## Why this is not a client concern
 *
 * "Should this image be re-encoded, and into what?" is a product rule, not a UI
 * detail. A product photo wants 2560px zoomable detail; a blog hero wants
 * something smaller; a signed contract scan, a design source file, or a
 * print-resolution master must be stored EXACTLY as uploaded — re-encoding it
 * is irreversible data loss that no error would ever report.
 *
 * A UI that hardcodes `folder === 'users' ? 'avatar' : 'ecom'` has taken that
 * decision away from the deployment. The next surface (a mobile app, a bulk
 * importer, a partner integration) either re-derives the same table or diverges
 * from it, and the divergence is invisible because both produce valid images.
 * So the policy is DATA, served by the server that owns the media library, and
 * every client resolves against the same document.
 *
 * ## The contract
 *
 * {@link resolveTransformPlan} is pure — no I/O, no globals, no runtime
 * detection. Feed it the file's facts and the host's policy; it returns either
 * "leave it alone" (with a reason) or the exact {@link CompressImageSetOptions}
 * to run. That makes it testable, and usable from a browser, React Native, a
 * CLI importer, or a server doing the same job for a non-browser client.
 *
 * ## Failure posture, and why it leans this way
 *
 * Transforming is LOSSY and irreversible; not transforming costs bytes and is
 * recoverable — the server can always derive later from an original it still
 * has. So every uncertainty resolves toward NOT transforming:
 *
 *   - a policy `version` this build does not understand ⇒ do nothing, say why
 *   - a non-image mime type ⇒ do nothing (you cannot canvas-encode a PDF)
 *   - no rule matched ⇒ the REQUIRED `fallback`, never an implicit default
 *
 * The one case that THROWS is a policy naming a preset that does not exist.
 * That is a broken policy document, not an uncertain input, and quietly
 * substituting some other preset would compress a print master to 1600px while
 * every log line said success.
 */

import { PRESETS, type PresetName } from './algorithms/presets.js';
import type { CompressImageSetOptions, DerivativeSpec } from './image/compressImageSet.js';
import type { ImageFormat } from './types.js';

/** The only policy shape this build understands. */
export const MEDIA_TRANSFORM_POLICY_VERSION = 1;

/**
 * What to do when a rule matches. Overrides are merged OVER the named preset,
 * so a host states only its difference from a known-good baseline.
 */
export interface TransformSpec {
  /** A named baseline from `PRESETS` (`chat` | `llm` | `ecom` | `editor` | `avatar`…). */
  preset?: PresetName | undefined;
  maxEdge?: number | undefined;
  quality?: number | undefined;
  format?: ImageFormat | ImageFormat[] | undefined;
  /** Bytes under which an already-small image is passed through un-re-encoded. */
  passthroughUnder?: number | undefined;
  thumbhash?: boolean | undefined;
  dominantColor?: boolean | undefined;
  /** Extra sizes the CLIENT should produce and upload alongside the primary. */
  derivatives?: readonly DerivativeSpec[] | undefined;
}

/**
 * Conditions for a rule. Every present condition must match (AND); an absent
 * one matches anything.
 *
 * `mimeType` accepts a wildcard subtype (`image/*`). It never accepts a bare
 * `*`: a policy that means "everything" should say so by omitting the
 * condition, so a typo cannot silently become a catch-all.
 */
export interface TransformCondition {
  folder?: readonly string[] | undefined;
  mimeType?: readonly string[] | undefined;
  /** Inclusive lower bound on the ORIGINAL byte size. */
  minBytes?: number | undefined;
  /** Inclusive upper bound on the ORIGINAL byte size. */
  maxBytes?: number | undefined;
}

export interface TransformRule {
  /** Optional human note — surfaced in the decision's `reason`. */
  id?: string | undefined;
  when?: TransformCondition | undefined;
  /** `false` = upload the original untouched. */
  use: false | TransformSpec;
}

export interface MediaTransformPolicy {
  version: number;
  /** Evaluated in order; FIRST match wins, so put the specific rules first. */
  rules?: readonly TransformRule[] | undefined;
  /**
   * Applied when no rule matches. REQUIRED — an absent fallback would make
   * "no rule matched" mean whatever the client felt like, which is the whole
   * class of bug this contract exists to prevent.
   */
  fallback: false | TransformSpec;
}

export interface TransformFacts {
  mimeType: string;
  /** Original size in bytes. */
  bytes: number;
  folder?: string | undefined;
}

/**
 * THREE outcomes, because "do not transform" has two incompatible meanings and
 * only this function knows which one applies.
 *
 *   - `client`   — transform, like this.
 *   - `preserve` — the policy STATED these bytes are untouchable. Nobody
 *     re-encodes them, client or server.
 *   - `unknown`  — this build could not interpret the policy (unrecognised
 *     version), or the format is not one it can round-trip. The client must not
 *     transform, but the file still needs processing — hand it to the SERVER.
 *
 * A two-state answer collapsed `unknown` into `preserve`, and the consumer then
 * suppressed server processing too: an unrecognised policy version silently
 * shipped an unprocessed, EXIF-bearing original as though an operator had
 * chosen it. `transform` is kept as a boolean alongside `outcome` so existing
 * `if (plan.transform)` narrowing still compiles and still means "do it here".
 */
export type TransformPlan =
  | { transform: false; outcome: 'preserve'; reason: string }
  | { transform: false; outcome: 'unknown'; reason: string }
  | { transform: true; outcome: 'client'; reason: string; options: CompressImageSetOptions };

function mimeMatches(mime: string, patterns: readonly string[]): boolean {
  const lower = mime.toLowerCase();
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    if (pat.endsWith('/*')) return lower.startsWith(`${pat.slice(0, -1)}`);
    return lower === pat;
  });
}

function conditionMatches(facts: TransformFacts, when: TransformCondition | undefined): boolean {
  if (!when) return true;
  if (when.folder && !when.folder.includes(facts.folder ?? '')) return false;
  if (when.mimeType && !mimeMatches(facts.mimeType, when.mimeType)) return false;
  if (when.minBytes !== undefined && facts.bytes < when.minBytes) return false;
  if (when.maxBytes !== undefined && facts.bytes > when.maxBytes) return false;
  return true;
}

/**
 * Merge a spec over its named preset into concrete options.
 *
 * THROWS on an unknown preset name — see the module docblock. `undefined`
 * overrides do not clobber preset values (an explicitly-absent key means
 * "unspecified", not "off").
 */
function toOptions(spec: TransformSpec): CompressImageSetOptions {
  let base: CompressImageSetOptions = {};
  if (spec.preset !== undefined) {
    const preset = PRESETS[spec.preset];
    if (!preset) {
      throw new Error(
        `[media-transform] policy names unknown preset "${spec.preset}". ` +
          `Known presets: ${Object.keys(PRESETS).join(', ')}. Refusing to substitute a ` +
          'different one — that would silently re-encode with the wrong settings.',
      );
    }
    base = { ...preset };
  }
  const out: CompressImageSetOptions = { ...base };
  if (spec.maxEdge !== undefined) out.maxEdge = spec.maxEdge;
  if (spec.quality !== undefined) out.quality = spec.quality;
  if (spec.format !== undefined) out.format = spec.format;
  if (spec.passthroughUnder !== undefined) out.passthroughUnder = spec.passthroughUnder;
  if (spec.thumbhash !== undefined) out.thumbhash = spec.thumbhash;
  if (spec.dominantColor !== undefined) out.dominantColor = spec.dominantColor;
  if (spec.derivatives !== undefined) out.derivatives = spec.derivatives;
  return out;
}

/**
 * Decide what a client should do with one upload. Pure.
 *
 * @throws if the policy names a preset that does not exist.
 */
export function resolveTransformPlan(facts: TransformFacts, policy: MediaTransformPolicy): TransformPlan {
  // An unrecognised policy version must not be interpreted with today's
  // semantics — a v2 field this build ignores could be the very rule that says
  // "never touch legal scans". Refusing to transform is the recoverable answer.
  if (policy.version !== MEDIA_TRANSFORM_POLICY_VERSION) {
    return {
      transform: false,
      // NOT `preserve` — the policy did not say to keep these bytes, this build
      // merely could not read it. The server must still process the file.
      outcome: 'unknown',
      reason: `policy version ${policy.version} is not understood by this build (expected ${MEDIA_TRANSFORM_POLICY_VERSION})`,
    };
  }

  // Only raster images can be decoded and re-encoded here. SVG is deliberately
  // excluded despite being `image/*`: it is markup, rasterising it destroys the
  // thing that makes it an SVG.
  if (!isTransformableImage(facts.mimeType)) {
    // Also `unknown`, not `preserve`: this build cannot round-trip the format,
    // which says nothing about whether the deployment wants it processed. A
    // server with sharp handles HEIC and TIFF perfectly well.
    return {
      transform: false,
      outcome: 'unknown',
      reason: `${facts.mimeType} is not a raster image this build can re-encode`,
    };
  }

  for (const rule of policy.rules ?? []) {
    if (!conditionMatches(facts, rule.when)) continue;
    const label = rule.id ? `rule "${rule.id}"` : 'matched rule';
    return rule.use === false
      ? { transform: false, outcome: 'preserve', reason: `${label} keeps the original untouched` }
      : { transform: true, outcome: 'client', reason: label, options: toOptions(rule.use) };
  }

  return policy.fallback === false
    ? { transform: false, outcome: 'preserve', reason: 'policy fallback keeps the original untouched' }
    : { transform: true, outcome: 'client', reason: 'policy fallback', options: toOptions(policy.fallback) };
}

/**
 * Raster image types this package can decode AND re-encode.
 *
 * An allow-list, not `startsWith('image/')`: that would sweep in `image/svg+xml`
 * (markup — rasterising it is destruction, not compression) and future types no
 * decoder here supports, and the failure would be a corrupted asset rather than
 * a skip.
 */
export function isTransformableImage(mimeType: string): boolean {
  return TRANSFORMABLE.has(mimeType.toLowerCase().split(';')[0]?.trim() ?? '');
}

/**
 * `image/gif` is deliberately ABSENT.
 *
 * The browser adapter decodes to a single `ImageBitmap` and encodes one raster
 * frame, so re-encoding an animated GIF silently returns the first frame as a
 * still. The file gets smaller, the upload succeeds, the thumbnail looks right
 * — and the animation is gone, which is usually the entire reason the file was
 * a GIF. There is no error anywhere in that sequence.
 *
 * A still GIF would survive, but nothing here can tell the two apart without
 * parsing the container, and guessing wrong destroys content irreversibly. So
 * GIFs are preserved as uploaded. Re-admit them only alongside an
 * animation-aware encoder AND a frame-count check.
 *
 * `image/svg+xml` is absent for the adjacent reason: it is markup, and
 * rasterising it destroys the property that made it an SVG.
 */
const TRANSFORMABLE = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
]);
