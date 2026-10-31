import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonical,
  type RefusalFacts,
  recordBytes,
  recordHash,
  type SignedRefusal,
  signingKey,
  signRecord,
  verifyingKey,
  verifyRefusal,
} from '../src/signed-refusals.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

const FACTS: RefusalFacts = {
  repo: 'the-roganator/cv-worlds-worst-website',
  number: null,
  at: '2026-10-31T12:00:00.000Z',
  payload: {
    mechanism: 'github-guard',
    action: 'applyPatch branch factory/1400-cart in the-roganator/cv-worlds-worst-website',
    output: 'The patch changes .github/workflows/ci.yml, which no patch may.',
    guardrails: [1],
  },
};

/** A refusal as the GitHub worker answers it, signed with a key. */
function signed(key = privateKey, facts = FACTS): SignedRefusal {
  const bytes = recordBytes(facts);
  return { ...facts, record: recordHash(bytes), signature: signRecord(key, bytes) };
}

/** Through JSON, as it reaches the line. */
const sent = (refusal: unknown) => JSON.parse(JSON.stringify(refusal));

describe('a signed refusal', () => {
  it('verifies, through JSON, with the worker’s public key, and gives back what was signed', () => {
    const refusal = signed();
    const verified = verifyRefusal(publicKey, sent(refusal));
    expect(verified).toEqual({ ok: true, refusal });
    expect(refusal.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
  });

  it('is the same bytes whatever order its fields come in', () => {
    const reordered = {
      payload: {
        guardrails: [1],
        output: FACTS.payload.output,
        action: FACTS.payload.action,
        mechanism: 'github-guard' as const,
      },
      at: FACTS.at,
      number: null,
      repo: FACTS.repo,
    };
    expect(recordBytes(reordered)).toEqual(recordBytes(FACTS));
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it('does not verify when anything it covers is changed', () => {
    const refusal: SignedRefusal = sent(signed());
    const changes: [string, (r: SignedRefusal & { payload: { mechanism: string } }) => void][] = [
      ['the output', (r) => (r.payload.output = 'Nothing was refused.')],
      ['the guardrails', (r) => (r.payload.guardrails = [10])],
      ['the mechanism', (r) => (r.payload.mechanism = 'token-permission')],
      ['the repository', (r) => (r.repo = 'the-roganator/cv-software-factory')],
      ['the number', (r) => (r.number = 7)],
      ['the time', (r) => (r.at = '2026-10-31T12:00:01.000Z')],
      ['the record', (r) => (r.record = 'f'.repeat(64))],
    ];
    for (const [what, change] of changes) {
      const changed = structuredClone(refusal);
      change(changed);
      expect(verifyRefusal(publicKey, changed).ok, what).toBe(false);
    }
  });

  it('does not verify signed with another key, unsigned, or with a signature over another record', () => {
    expect(verifyRefusal(publicKey, sent(signed(other.privateKey)))).toEqual({
      ok: false,
      why: 'its signature does not verify',
    });
    const { signature: _, ...unsigned } = signed();
    expect(verifyRefusal(publicKey, sent(unsigned))).toEqual({ ok: false, why: 'it is not signed' });
    const another = signed(privateKey, { ...FACTS, number: 7 });
    expect(verifyRefusal(publicKey, { ...sent(signed()), signature: another.signature }).ok).toBe(false);
  });

  it('is only a GitHub worker’s mechanism’s, as it was made: nothing folded, and nothing a relay adds', () => {
    const gateway = signed(privateKey, { ...FACTS, payload: { ...FACTS.payload, mechanism: 'gateway' as never } });
    expect(verifyRefusal(publicKey, sent(gateway))).toMatchObject({ ok: false });
    const folded = signed(privateKey, { ...FACTS, payload: { ...FACTS.payload, count: 2 } as never });
    expect(verifyRefusal(publicKey, sent(folded))).toMatchObject({ ok: false });
    for (const answer of [undefined, null, 'refused', { ...sent(signed()), extra: true }]) {
      expect(verifyRefusal(publicKey, answer)).toMatchObject({ ok: false });
    }
  });

  it('is refused when the store would not keep its words as they were signed', () => {
    const padded = signed(privateKey, { ...FACTS, payload: { ...FACTS.payload, action: ' padded ' } });
    expect(verifyRefusal(publicKey, sent(padded))).toEqual({
      ok: false,
      why: 'its payload is not as the store would keep it',
    });
  });
});

describe('the keys', () => {
  it('are Ed25519, from PEM, and anything else is refused without quoting it', () => {
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    expect(signingKey(pem).asymmetricKeyType).toBe('ed25519');
    expect(verifyingKey(publicPem).asymmetricKeyType).toBe('ed25519');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => signingKey(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)).toThrow(
      'The refusal signing key is not Ed25519.',
    );
    expect(() => verifyingKey('not a key')).toThrow(/^The refusal key is not a public key in PEM\.$/);
    // A private key where the public one should be is refused, not quietly turned into its public half.
    expect(() => verifyingKey(pem)).toThrow('The refusal key is not an Ed25519 public key.');
  });
});
