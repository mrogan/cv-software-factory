/**
 * Whether an image was signed by the pipeline that should have built it: cosign's keyless signature, made by the
 * repository's `build.yml` on main with the workflow's own OIDC identity, and kept beside the image in GHCR.
 *
 *     verify(image, digest, signer)   resolves if a signature by the signer covers the digest; throws UnsignedError
 *                                     with the reason if none does
 *
 * Cosign keeps each signature as a Sigstore bundle in an artifact that refers to the image. The bundle holds a DSSE
 * envelope around an in-toto statement naming the image's digest, the certificate Fulcio gave the workflow, and
 * Rekor's proof that it was logged. Sigstore's own verifier checks the bundle against Sigstore's trust root, fetched
 * and kept current through TUF; this module finds the bundles, says whose signature to accept, and checks that the
 * signed statement is a signature of this digest, not of another image or an attestation.
 *
 * Checked here, in Node, with Sigstore's JavaScript verifier rather than the cosign binary: it adds a few small
 * packages to the factory image instead of a hundred megabytes of Go, and its tests run offline on a real bundle.
 */
import { bundleFromJSON } from '@sigstore/bundle';
import type { TrustedRoot } from '@sigstore/protobuf-specs';
import { getTrustedRoot } from '@sigstore/tuf';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';
import { z } from 'zod';
import type { Referrer, Registry } from './registry.ts';

/** Whose signature an image must carry: the workflow's identity, as Fulcio wrote it, and who vouched for it. */
export interface Signer {
  identity: string;
  issuer: string;
}

/** The identity GitHub Actions gives a workflow's OIDC token, which Fulcio puts in the certificate. */
export const GITHUB_ACTIONS = 'https://token.actions.githubusercontent.com';

/** The repository's own build workflow, run on main: the only signer of the images it builds. */
export const pipeline = (repo: string): Signer => ({
  identity: `https://github.com/${repo}/.github/workflows/build.yml@refs/heads/main`,
  issuer: GITHUB_ACTIONS,
});

const BUNDLE = 'application/vnd.dev.sigstore.bundle.v0.3+json';
/** What cosign signs an image with: a statement of this type naming its digest. Attestations have their own types. */
const SIGNATURE = 'https://sigstore.dev/cosign/sign/v1';
/** The annotation cosign puts on a bundle's manifest to say what type of statement it holds. */
const PREDICATE_TYPE = 'dev.sigstore.bundle.predicateType';

const STATEMENT = z.object({
  _type: z.literal('https://in-toto.io/Statement/v1'),
  subject: z.array(z.object({ digest: z.record(z.string(), z.string()) })),
  predicateType: z.string(),
});
const CLAIM = z.object({ predicateType: z.string() });

/**
 * An image with no signature its pipeline made: `unsigned` when it has none at all, as while its signing job runs or
 * when it was pushed by hand; `refused` when it has signatures, but none is the signer's, of this image.
 */
export class UnsignedError extends Error {
  override name = 'UnsignedError';
  readonly kind: 'unsigned' | 'refused';

  constructor(kind: UnsignedError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface SignaturesOptions {
  registry: Pick<Registry, 'referrers' | 'artifact' | 'blob'>;
  /** Sigstore's trust root: by default through TUF, kept in `cachePath`. */
  trustedRoot?: () => Promise<TrustedRoot>;
  /** Where TUF keeps what it fetched; by default, the user's cache. */
  cachePath?: string | undefined;
}

export class Signatures {
  readonly #registry: SignaturesOptions['registry'];
  readonly #trustedRoot: () => Promise<TrustedRoot>;
  /** A digest's signature cannot change, so each signer and digest is verified once. */
  readonly #verified = new Set<string>();

  constructor({ registry, trustedRoot, cachePath }: SignaturesOptions) {
    this.#registry = registry;
    this.#trustedRoot = trustedRoot ?? (() => getTrustedRoot(cachePath ? { cachePath } : {}));
  }

  async verify(image: string, digest: string, signer: Signer): Promise<void> {
    const key = `${signer.issuer} ${signer.identity} ${image}@${digest}`;
    if (this.#verified.has(key)) return;
    let verifier: Verifier | undefined;
    const refused: string[] = [];
    for (const referrer of await this.#registry.referrers(image, digest)) {
      const signature = await this.#signature(image, referrer);
      if (!signature) continue;
      // Fetched for each image it has not verified yet, so a rotated key is seen; TUF fetches only what changed.
      verifier ??= new Verifier(toTrustMaterial(await this.#trustedRoot()));
      const refusal = signature.blob ? refuse(verifier, signature.blob, digest, signer) : 'it holds no bundle';
      if (!refusal) {
        this.#verified.add(key);
        return;
      }
      refused.push(`${referrer.digest.slice(0, 'sha256:'.length + 12)}…: ${refusal}`);
    }
    if (!refused.length) throw new UnsignedError('unsigned', `${image}@${digest} has no signature`);
    throw new UnsignedError(
      'refused',
      `${image}@${digest} has no signature by ${signer.identity} (${refused.join('; ')})`,
    );
  }

  /**
   * A referrer's bundle, if it says it holds a signature, not an attestation; undefined if it does not. What it holds
   * is read from the referrers list where it says (the referrers API copies it there), from the bundle's own manifest
   * where it does not (the tag GHCR keeps them under), and from the statement in the bundle if neither says: an image
   * with attestations but no signature yet is unsigned, not refused. A registry that cannot answer fails the check, as
   * an error of its own: it says nothing about the signature.
   */
  async #signature(image: string, referrer: Referrer): Promise<{ blob: Buffer | undefined } | undefined> {
    if (referrer.artifactType !== BUNDLE) return undefined;
    const listed = referrer.annotations?.[PREDICATE_TYPE];
    // Skipped unread: an attestation's bundle can run to megabytes, as an SBOM's does.
    if (listed && listed !== SIGNATURE) return undefined;
    const artifact = await this.#registry.artifact(image, referrer.digest);
    const said = listed || artifact.annotations?.[PREDICATE_TYPE];
    if (said && said !== SIGNATURE) return undefined;
    const [layer] = artifact.layers;
    const blob = layer?.mediaType === BUNDLE ? await this.#registry.blob(image, layer.digest) : undefined;
    if (!said && blob && claimed(blob) !== SIGNATURE) return undefined;
    return { blob };
  }
}

/** A bundle's envelope and the statement in it, unverified; throws if the blob is not a bundle around a statement. */
function unwrap(blob: Buffer) {
  const bundle = bundleFromJSON(JSON.parse(blob.toString('utf-8')));
  if (bundle.content.$case !== 'dsseEnvelope') throw new Error('it signs no statement');
  return { bundle, payload: JSON.parse(bundle.content.dsseEnvelope.payload.toString('utf-8')) as unknown };
}

/**
 * The type of statement a bundle says it holds, unverified, only to tell a signature from an attestation, of any
 * in-toto version; undefined if it cannot be read, in which case the bundle is checked, and refused, as a signature.
 */
function claimed(blob: Buffer): string | undefined {
  try {
    return CLAIM.parse(unwrap(blob).payload).predicateType;
  } catch {
    return undefined;
  }
}

/** Why a bundle is not the signer's signature of the digest, or undefined if it is. */
function refuse(verifier: Verifier, blob: Buffer, digest: string, signer: Signer): string | undefined {
  try {
    const { bundle, payload } = unwrap(blob);
    // The issuer is compared exactly; the identity is compared here, not by the verifier, which reads it as a
    // regular expression, unanchored: `…@refs/heads/main` would accept a branch named `main-anything`.
    const { identity } = verifier.verify(toSignedEntity(bundle), { extensions: { issuer: signer.issuer } });
    const san = identity?.subjectAlternativeName;
    if (san !== signer.identity) return `it is signed by ${san ?? 'no identity'}`;
    // Only the envelope's payload is signed: the statement in it must be a signature, and of this digest.
    const statement = STATEMENT.parse(payload);
    if (statement.predicateType !== SIGNATURE) return `it is a ${statement.predicateType}`;
    if (!statement.subject.some((s) => `sha256:${s.digest.sha256}` === digest)) return 'it signs another image';
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
