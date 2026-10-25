import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newKey, publicKey } from './share-key.ts';

const script = fileURLToPath(new URL('share-key.ts', import.meta.url));
const run = (command: string, input?: string) =>
  spawnSync(process.execPath, [script, command], { input, encoding: 'utf-8' });

describe('the generator’s signing key', () => {
  it('is a new Ed25519 key each time, whose public half checks what it signs', () => {
    const [one, two] = [newKey(), newKey()];
    expect(one).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(one).not.toBe(two);
    expect(createPrivateKey(one).asymmetricKeyType).toBe('ed25519');
    const pub = publicKey(one);
    expect(pub).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----\n$/);
    const signature = sign(null, Buffer.from('a page'), createPrivateKey(one));
    expect(verify(null, Buffer.from('a page'), createPublicKey(pub), signature)).toBe(true);
    expect(verify(null, Buffer.from('a page'), createPublicKey(publicKey(two)), signature)).toBe(false);
  });

  it('gives a public key from a private one only: never from nothing, a public key or another kind', () => {
    expect(() => publicKey('')).toThrow('not a private key');
    expect(() => publicKey(publicKey(newKey()))).toThrow('not a private key');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    expect(() => publicKey(rsa)).toThrow('rsa key, not Ed25519');
  });

  it('goes through pipes, as make share-key uses it, and fails without printing what it was given', () => {
    const made = execFileSync(process.execPath, [script, 'new'], { encoding: 'utf-8' });
    expect(run('public', made)).toMatchObject({ status: 0, stdout: publicKey(made), stderr: '' });
    const broken = `${made.slice(0, 60)}garbled`;
    const refused = run('public', broken);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).not.toContain('garbled');
    expect(run('neither').status).toBe(2);
  });
});
