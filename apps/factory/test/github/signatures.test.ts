/**
 * Signature checks, through the registry client and Sigstore's verifier, on a real signature: cosign's own release
 * image, signed by Sigstore's release pipeline with cosign 3 and kept in GHCR as ours are. The trust root is the one
 * Sigstore's TUF repository served when the fixture was taken, so the tests run offline.
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
  bundle?: Buffer;
  /** The digest the signature is kept beside. */
  beside?: string;
  /** An answer for every request, in place of the registry's. */
  status?: number;
}

/** GHCR, holding one signature of DIGEST as cosign leaves it, and keeping each request it was sent. */
function registry({ api = false, predicateType = SIGNATURE, bundle = BUNDLE, beside = DIGEST, status }: Served = {}) {
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
        annotations: { 'dev.sigstore.bundle.predicateType': predicateType },
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

describe('the pipeline', () => {
  it('is the repository’s build workflow on main, as GitHub Actions vouches for it', () => {
    expect(pipeline('mrogan/cv-worlds-worst-website')).toEqual({
      identity: 'https://github.com/mrogan/cv-worlds-worst-website/.github/workflows/build.yml@refs/heads/main',
      issuer: 'https://token.actions.githubusercontent.com',
    });
  });
});
