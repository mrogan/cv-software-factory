/**
 * Signature checks, through the registry client and Sigstore's verifier, on real signatures: cosign's own release
 * image, signed by Sigstore's release pipeline with cosign 3, and the factory's own image, as GHCR serves its
 * signature and attestations to the deploy watch. The trust root is the one Sigstore's TUF repository served when the
 * first fixture was taken, so the tests run offline.
 */
import { readFileSync } from 'node:fs';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { describe, expect, it } from 'vitest';
import { Registry, RegistryError } from '../../src/github/registry.ts';
import { pipeline, Signatures, type Signer, UnsignedError } from '../../src/github/signatures.ts';

const fixture = (name: string) => readFileSync(new URL(name, import.meta.url));
const BUNDLE = fixture('./cosign-signature.json');
const TRUST = TrustedRoot.fromJSON(JSON.parse(fixture('./trusted-root.json').toString()));

const IMAGE = 'sigstore/cosign/cosign';
/** The image the fixture signs: cosign v3.1.3's index. */
const DIGEST = 'sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8';
const COSIGN: Signer = {
  identity: 'keyless@projectsigstore.iam.gserviceaccount.com',
  issuer: 'https://accounts.google.com',
};

const SIGNATURE = 'https://sigstore.dev/cosign/sign/v1';
const sha = (c: string) => `sha256:${c.repeat(64)}`;

interface Served {
  /** The registry has the referrers API, rather than the tag that stands in for it (GHCR has not). */
  api?: boolean;
  /** What the referrers list says each one is. */
  predicateType?: string;
  /** Whether the list says it at all: the bundle's manifest, served without annotations here, does not. */
  listed?: boolean;
  bundle?: Buffer;
  /** The digest the signature is kept beside. */
  beside?: string;
  /** An answer for every request, in place of the registry's. */
  status?: number;
}

/** GHCR, holding one signature of DIGEST as cosign leaves it, and keeping each request it was sent. */
function registry({
  api = false,
  predicateType = SIGNATURE,
  listed = true,
  bundle = BUNDLE,
  beside = DIGEST,
  status,
}: Served = {}) {
  const requests: string[] = [];
  const answer = (body: unknown) =>
    new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  const referrers = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: sha('1'),
        artifactType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        ...(listed && { annotations: { 'dev.sigstore.bundle.predicateType': predicateType } }),
      },
    ],
  };
  const fetcher = (async (input: string) => {
    const path = new URL(input).pathname;
    requests.push(path);
    if (path === '/token') return answer({ token: 'anon' });
    if (status) return new Response(null, { status });
    if (api && path === `/v2/${IMAGE}/referrers/${beside}`) return answer(referrers);
    if (!api && path === `/v2/${IMAGE}/manifests/${beside.replace(':', '-')}`) return answer(referrers);
    if (path === `/v2/${IMAGE}/manifests/${sha('1')}`) {
      return answer({ layers: [{ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', digest: sha('2') }] });
    }
    if (path === `/v2/${IMAGE}/blobs/${sha('2')}`) return answer(bundle);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { registry: new Registry({ base: 'https://ghcr.test', fetch: fetcher }), requests };
}

const signatures = (served?: Served) => {
  const { registry: r, requests } = registry(served);
  return { signatures: new Signatures({ registry: r, trustedRoot: async () => TRUST }), requests };
};

describe('signature checks', () => {
  it('accept a signature by the signer, of the digest, found through the tag that stands in for referrers', async () => {
    const { signatures: s, requests } = signatures();
    await expect(s.verify(IMAGE, DIGEST, COSIGN)).resolves.toBeUndefined();
    expect(requests).toContain(`/v2/${IMAGE}/manifests/${DIGEST.replace(':', '-')}`);
  });

  it('use the referrers API where the registry has it', async () => {
    const { signatures: s } = signatures({ api: true });
    await expect(s.verify(IMAGE, DIGEST, COSIGN)).resolves.toBeUndefined();
  });

  it('read a bundle’s statement when neither the list nor its manifest says what it holds', async () => {
    const { signatures: s } = signatures({ api: true, listed: false });
    await expect(s.verify(IMAGE, DIGEST, COSIGN)).resolves.toBeUndefined();
  });

  it('verify a digest once: a signature cannot change', async () => {
    const { signatures: s, requests } = signatures();
    await s.verify(IMAGE, DIGEST, COSIGN);
    const asked = requests.length;
    await s.verify(IMAGE, DIGEST, COSIGN);
    expect(requests).toHaveLength(asked);
  });

  it('refuse a signature by anyone else, saying whose they wanted', async () => {
    for (const signer of [
      pipeline('mrogan/cv-software-factory'),
      { ...COSIGN, issuer: 'https://token.actions.githubusercontent.com' },
    ]) {
      const { signatures: s } = signatures();
      const refused = s.verify(IMAGE, DIGEST, signer);
      await expect(refused).rejects.toBeInstanceOf(UnsignedError);
      await expect(refused).rejects.toMatchObject({ kind: 'refused' });
      await expect(refused).rejects.toThrow(`has no signature by ${signer.identity}`);
    }
  });

  it('compare the identity whole: a name that only begins the signer’s is another signer', async () => {
    // As a workflow on a branch named `main-anything` would be, beside `…/build.yml@refs/heads/main`.
    const { signatures: s } = signatures();
    const refused = s.verify(IMAGE, DIGEST, { ...COSIGN, identity: 'keyless@projectsigstore' });
    await expect(refused).rejects.toMatchObject({
      kind: 'refused',
      message: expect.stringContaining(`it is signed by ${COSIGN.identity}`),
    });
  });

  it('refuse an image with no signature at all, as one built and pushed by hand', async () => {
    const { signatures: s } = signatures();
    await expect(s.verify(IMAGE, sha('9'), COSIGN)).rejects.toMatchObject({
      kind: 'unsigned',
      message: `${IMAGE}@${sha('9')} has no signature`,
    });
  });

  it('refuse a signature of another image, though it is the signer’s and valid', async () => {
    // As if the signature had been copied to sit beside another digest.
    const { signatures: s } = signatures({ beside: sha('9') });
    await expect(s.verify(IMAGE, sha('9'), COSIGN)).rejects.toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('it signs another image'),
    });
  });

  it('refuse a signature that has been tampered with', async () => {
    const bundle = JSON.parse(BUNDLE.toString());
    bundle.dsseEnvelope.signatures[0].sig = Buffer.from('not the signature').toString('base64');
    const { signatures: s } = signatures({ bundle: Buffer.from(JSON.stringify(bundle)) });
    await expect(s.verify(IMAGE, DIGEST, COSIGN)).rejects.toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('could not be verified'),
    });
  });

  it('do not count an attestation as a signature', async () => {
    const { signatures: s } = signatures({ predicateType: 'https://spdx.dev/Document' });
    await expect(s.verify(IMAGE, DIGEST, COSIGN)).rejects.toMatchObject({ kind: 'unsigned' });
  });

  it('fail with the registry’s own error when it cannot answer: that says nothing about the signature', async () => {
    const { signatures: s } = signatures({ status: 503 });
    const failed = s.verify(IMAGE, DIGEST, COSIGN);
    await expect(failed).rejects.toBeInstanceOf(RegistryError);
    await expect(failed).rejects.not.toBeInstanceOf(UnsignedError);
  });
});

/**
 * The factory's image as GHCR served it, by path: the tag that stands in for referrers, whose list says only that each
 * is a bundle, the manifests of the signature and the two SBOM attestations its pipeline made, and the signature's
 * bundle. The attestations' bundles, megabytes each, are not kept: nothing should ask for them.
 */
const FACTORY = 'mrogan/cv-software-factory/factory';
const FACTORY_DIGEST = 'sha256:72f3bb2ce966434502d006e2cabdb56e1321422328530df111ed205ff0764765';
const GHCR_SERVED: Record<string, unknown> = JSON.parse(fixture('./ghcr-factory.json').toString());
const STANDS_IN = `/v2/${FACTORY}/manifests/${FACTORY_DIGEST.replace(':', '-')}`;
/** The factory's signature: its manifest, and the bundle in it. */
const SIGNED = `/v2/${FACTORY}/manifests/sha256:f52729db1d88ef30df3350c52cdc752daf7ddb9a4c522e929062c1b5e9df2733`;
const SIGNED_BUNDLE = `/v2/${FACTORY}/blobs/sha256:5350048a230546a5eb347aa57e76c526e4aa55cff6e2e3aed5b1ae6b9bc0a0fb`;

interface Manifest {
  annotations?: Record<string, string>;
}

/** GHCR as it served the factory's image, changed by `change`, keeping each request it was sent. */
function ghcr(change: (served: Record<string, unknown>) => void = () => {}) {
  const served = structuredClone(GHCR_SERVED);
  change(served);
  const requests: string[] = [];
  const fetcher = (async (input: string) => {
    const path = new URL(input).pathname;
    requests.push(path);
    if (path === '/token') return new Response(JSON.stringify({ token: 'anon' }));
    return path in served ? new Response(JSON.stringify(served[path])) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const registry = new Registry({ base: 'https://ghcr.test', fetch: fetcher });
  return { signatures: new Signatures({ registry, trustedRoot: async () => TRUST }), requests };
}

/** The tag that stands in for referrers, without the signature: as while the pipeline's signing job runs. */
const unsigned = (served: Record<string, unknown>) => {
  const index = served[STANDS_IN] as { manifests: { digest: string }[] };
  index.manifests = index.manifests.filter((m) => !SIGNED.endsWith(m.digest));
};

/**
 * Only the signature, its manifest saying nothing of what it holds, so its statement must be read. The attestations go:
 * their bundles, which would be read too, are not kept.
 */
const unannotated = (served: Record<string, unknown>) => {
  const index = served[STANDS_IN] as { manifests: { digest: string }[] };
  index.manifests = index.manifests.filter((m) => SIGNED.endsWith(m.digest));
  delete (served[SIGNED] as Manifest).annotations;
};

describe('signature checks on GHCR, as our pipeline leaves them', () => {
  const FACTORY_PIPELINE = pipeline('mrogan/cv-software-factory');

  it('read what each bundle holds from its manifest, as the tag that stands in for referrers does not say', async () => {
    const { signatures: s, requests } = ghcr();
    expect(JSON.stringify(GHCR_SERVED[STANDS_IN])).not.toContain('annotations');
    await expect(s.verify(FACTORY, FACTORY_DIGEST, FACTORY_PIPELINE)).resolves.toBeUndefined();
    // The SBOMs' bundles are not served here: asking for one would have failed the check.
    expect(requests.filter((r) => r.includes('/blobs/'))).toEqual([SIGNED_BUNDLE]);
  });

  it('stop at the first signature that verifies, reading nothing after it', async () => {
    // The signature listed first, and an attestation after it the registry cannot serve.
    const { signatures: s } = ghcr((served) => {
      const index = served[STANDS_IN] as { manifests: { digest: string }[] };
      index.manifests.sort((a, b) => Number(SIGNED.endsWith(b.digest)) - Number(SIGNED.endsWith(a.digest)));
      delete served[`/v2/${FACTORY}/manifests/${index.manifests[1]?.digest}`];
    });
    await expect(s.verify(FACTORY, FACTORY_DIGEST, FACTORY_PIPELINE)).resolves.toBeUndefined();
  });

  it('call an image with attestations but no signature yet unsigned, not refused', async () => {
    const { signatures: s } = ghcr(unsigned);
    await expect(s.verify(FACTORY, FACTORY_DIGEST, FACTORY_PIPELINE)).rejects.toMatchObject({
      kind: 'unsigned',
      message: `${FACTORY}@${FACTORY_DIGEST} has no signature`,
    });
  });

  it('refuse the signature for another signer', async () => {
    const { signatures: s } = ghcr();
    await expect(s.verify(FACTORY, FACTORY_DIGEST, pipeline('mrogan/cv-worlds-worst-website'))).rejects.toMatchObject({
      kind: 'refused',
    });
  });

  it('read a bundle’s statement when nothing says what it holds', async () => {
    const { signatures: s } = ghcr(unannotated);
    await expect(s.verify(FACTORY, FACTORY_DIGEST, FACTORY_PIPELINE)).resolves.toBeUndefined();
  });

  it('call an attestation unsigned when only its statement says what it is', async () => {
    // The signature's bundle, with the statement in it made an SBOM's: no longer valid, but not a signature either.
    const { signatures: s } = ghcr((served) => {
      unannotated(served);
      const bundle = served[SIGNED_BUNDLE] as { dsseEnvelope: { payload: string } };
      const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString());
      statement.predicateType = 'https://spdx.dev/Document';
      bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
    });
    await expect(s.verify(FACTORY, FACTORY_DIGEST, FACTORY_PIPELINE)).rejects.toMatchObject({ kind: 'unsigned' });
  });
});

describe('the pipeline', () => {
  it('is the repository’s build workflow on main, as GitHub Actions vouches for it', () => {
    expect(pipeline('mrogan/cv-worlds-worst-website')).toEqual({
      identity: 'https://github.com/mrogan/cv-worlds-worst-website/.github/workflows/build.yml@refs/heads/main',
      issuer: 'https://token.actions.githubusercontent.com',
    });
  });
});
