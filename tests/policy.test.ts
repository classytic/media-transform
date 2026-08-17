import { describe, expect, it } from 'vitest';
import {
  isTransformableImage,
  MEDIA_TRANSFORM_POLICY_VERSION,
  resolveTransformPlan,
  type MediaTransformPolicy,
} from '../src/policy';

const V = MEDIA_TRANSFORM_POLICY_VERSION;

/** The shape a commerce host would actually serve. */
const POLICY: MediaTransformPolicy = {
  version: V,
  rules: [
    {
      id: 'originals-untouched',
      when: { folder: ['documents', 'contracts'] },
      use: false,
    },
    {
      id: 'avatars',
      when: { folder: ['users'] },
      use: { preset: 'avatar' },
    },
    {
      id: 'product-imagery',
      when: { folder: ['products', 'categories'] },
      use: {
        preset: 'ecom',
        derivatives: [
          { name: 'thumbnail', maxEdge: 200 },
          { name: 'medium', maxEdge: 800 },
        ],
      },
    },
  ],
  fallback: { preset: 'chat' },
};

const facts = (over: Partial<Parameters<typeof resolveTransformPlan>[0]> = {}) => ({
  mimeType: 'image/jpeg',
  bytes: 3_000_000,
  folder: 'products',
  ...over,
});

describe('resolveTransformPlan', () => {
  it('applies the first matching rule, with its derivatives', () => {
    const plan = resolveTransformPlan(facts(), POLICY);
    expect(plan.transform).toBe(true);
    if (!plan.transform) return;
    expect(plan.options.maxEdge).toBe(2560); // from the `ecom` preset
    expect(plan.options.derivatives?.map((d) => d.name)).toEqual(['thumbnail', 'medium']);
  });

  /**
   * THE CASE THE USER ASKED FOR. A signed contract scan must reach storage
   * byte-for-byte; re-encoding it is irreversible and nothing would report it.
   */
  it('a folder marked `use: false` is never transformed', () => {
    const plan = resolveTransformPlan(facts({ folder: 'contracts' }), POLICY);
    expect(plan.transform).toBe(false);
    expect(plan.reason).toContain('originals-untouched');
  });

  it('falls back explicitly when no rule matches', () => {
    const plan = resolveTransformPlan(facts({ folder: 'somewhere-new' }), POLICY);
    expect(plan.transform).toBe(true);
    if (!plan.transform) return;
    expect(plan.options.maxEdge).toBe(1600); // `chat`
    expect(plan.reason).toBe('policy fallback');
  });

  it('a fallback of `false` means untouched, not "do whatever"', () => {
    const plan = resolveTransformPlan(facts({ folder: 'x' }), { version: V, fallback: false });
    expect(plan.transform).toBe(false);
  });

  it('rule order decides — first match wins', () => {
    const plan = resolveTransformPlan(facts({ folder: 'users' }), POLICY);
    expect(plan.transform).toBe(true);
    if (!plan.transform) return;
    expect(plan.reason).toContain('avatars');
  });

  it('overrides merge OVER the named preset', () => {
    const plan = resolveTransformPlan(facts({ folder: 'p' }), {
      version: V,
      fallback: { preset: 'ecom', quality: 0.5 },
    });
    expect(plan.transform).toBe(true);
    if (!plan.transform) return;
    expect(plan.options.maxEdge).toBe(2560); // kept from the preset
    expect(plan.options.quality).toBe(0.5); // overridden
  });

  // ── Conditions ────────────────────────────────────────────────────────────

  it('matches on mime wildcard and byte bounds', () => {
    const policy: MediaTransformPolicy = {
      version: V,
      rules: [{ id: 'big-pngs', when: { mimeType: ['image/png'], minBytes: 1_000 }, use: false }],
      fallback: { preset: 'chat' },
    };
    expect(resolveTransformPlan(facts({ mimeType: 'image/png', bytes: 5_000 }), policy).transform).toBe(false);
    // Under minBytes ⇒ rule does not match ⇒ fallback transforms it.
    expect(resolveTransformPlan(facts({ mimeType: 'image/png', bytes: 10 }), policy).transform).toBe(true);
    // Different mime ⇒ no match.
    expect(resolveTransformPlan(facts({ mimeType: 'image/jpeg', bytes: 5_000 }), policy).transform).toBe(true);
  });

  it('`image/*` matches any raster subtype', () => {
    const policy: MediaTransformPolicy = {
      version: V,
      rules: [{ when: { mimeType: ['image/*'] }, use: false }],
      fallback: { preset: 'chat' },
    };
    expect(resolveTransformPlan(facts({ mimeType: 'image/webp' }), policy).transform).toBe(false);
  });

  // ── Failure posture ───────────────────────────────────────────────────────

  /**
   * A v2 policy could carry the very rule that says "never touch legal scans".
   * Interpreting it with v1 semantics would apply a DIFFERENT policy than the
   * host wrote, so an unknown version does nothing and says so.
   */
  it('an unknown policy version transforms NOTHING and explains why', () => {
    const plan = resolveTransformPlan(facts(), { ...POLICY, version: 99 });
    expect(plan.transform).toBe(false);
    expect(plan.reason).toContain('version 99');
  });

  it('a non-image is never transformed, whatever the policy says', () => {
    const policy: MediaTransformPolicy = { version: V, fallback: { preset: 'ecom' } };
    expect(resolveTransformPlan(facts({ mimeType: 'application/pdf' }), policy).transform).toBe(false);
    expect(resolveTransformPlan(facts({ mimeType: 'video/mp4' }), policy).transform).toBe(false);
  });

  /**
   * SVG is `image/*` but it is MARKUP. Rasterising it destroys the property
   * that made it an SVG, and it would look like a successful compression.
   */
  it('SVG is excluded despite being image/*', () => {
    expect(isTransformableImage('image/svg+xml')).toBe(false);
    const policy: MediaTransformPolicy = {
      version: V,
      rules: [{ when: { mimeType: ['image/*'] }, use: { preset: 'ecom' } }],
      fallback: false,
    };
    expect(resolveTransformPlan(facts({ mimeType: 'image/svg+xml' }), policy).transform).toBe(false);
  });

  it('tolerates a mime with parameters', () => {
    expect(isTransformableImage('image/jpeg; charset=binary')).toBe(true);
  });

  /**
   * A broken policy document is not an uncertain input. Substituting another
   * preset would re-encode a print master at the wrong settings and report
   * success.
   */
  it('THROWS on a preset name that does not exist', () => {
    const policy = {
      version: V,
      fallback: { preset: 'ecomm' },
    } as unknown as MediaTransformPolicy;
    expect(() => resolveTransformPlan(facts(), policy)).toThrow(/unknown preset "ecomm"/);
  });

  it('the thrown error lists the valid presets', () => {
    const policy = { version: V, fallback: { preset: 'nope' } } as unknown as MediaTransformPolicy;
    expect(() => resolveTransformPlan(facts(), policy)).toThrow(/ecom/);
  });

  it('is pure — the same inputs give the same answer and the policy is not mutated', () => {
    const snapshot = JSON.stringify(POLICY);
    const a = resolveTransformPlan(facts(), POLICY);
    const b = resolveTransformPlan(facts(), POLICY);
    expect(a).toEqual(b);
    expect(JSON.stringify(POLICY)).toBe(snapshot);
  });
});

describe('formats that must NOT enter the raster path', () => {
  /**
   * The adapter decodes to ONE ImageBitmap and encodes ONE frame, so an
   * animated GIF comes back as a still. Smaller file, successful upload,
   * correct-looking thumbnail — and the animation, usually the whole point of
   * the file, is gone with no error anywhere.
   */
  it('GIF is preserved, not transformed', () => {
    expect(isTransformableImage('image/gif')).toBe(false);
    const policy: MediaTransformPolicy = {
      version: V,
      rules: [{ when: { mimeType: ['image/*'] }, use: { preset: 'ecom' } }],
      fallback: { preset: 'ecom' },
    };
    expect(resolveTransformPlan(facts({ mimeType: 'image/gif' }), policy).transform).toBe(false);
  });

  it('the raster formats a canvas can safely round-trip still are', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic']) {
      expect(isTransformableImage(mime)).toBe(true);
    }
  });
});

/**
 * `preserve` and `unknown` both mean "not here" and must NEVER be conflated:
 * the first suppresses server processing too, the second demands it.
 *
 * Collapsing them shipped an unprocessed, EXIF-bearing original as though an
 * operator had chosen it — and an unrecognised policy VERSION is exactly the
 * case that would hit it in the field, on the day a server starts serving v2.
 */
describe('outcome — preserve vs unknown', () => {
  it('an explicit rule is PRESERVE', () => {
    const plan = resolveTransformPlan(facts({ folder: 'contracts' }), POLICY);
    expect(plan.outcome).toBe('preserve');
  });

  it('a `false` fallback is PRESERVE', () => {
    expect(resolveTransformPlan(facts({ folder: 'x' }), { version: V, fallback: false }).outcome).toBe(
      'preserve',
    );
  });

  it('an unreadable policy VERSION is UNKNOWN — the server must still process', () => {
    const plan = resolveTransformPlan(facts(), { ...POLICY, version: 99 });
    expect(plan.outcome).toBe('unknown');
    expect(plan.transform).toBe(false);
  });

  /** A server with sharp handles HEIC fine; this build just cannot re-encode it. */
  it('a format this build cannot round-trip is UNKNOWN, not preserve', () => {
    expect(resolveTransformPlan(facts({ mimeType: 'image/heic' }), POLICY).outcome).toBe('client');
    expect(resolveTransformPlan(facts({ mimeType: 'application/pdf' }), POLICY).outcome).toBe('unknown');
    expect(resolveTransformPlan(facts({ mimeType: 'image/gif' }), POLICY).outcome).toBe('unknown');
  });

  it('a transforming rule is CLIENT', () => {
    expect(resolveTransformPlan(facts(), POLICY).outcome).toBe('client');
  });
});
