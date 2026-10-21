import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { files, HOSTS, isLocalName, issue, sign } from './local-ca.ts';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let made: ReturnType<typeof files>;

beforeAll(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'local-ca-test-')), 'local-ca');
  made = files(dir);
  issue(dir);
});
afterAll(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

/** A certificate signed with the authority's key by `step` itself, as anything that read the key could. */
function mintedOutside(name: string, san: string): { cert: string; key: string } {
  const cert = join(dir, `${name}.crt`);
  const key = join(dir, `${name}.key`);
  execFileSync(
    'step',
    [
      'certificate',
      'create',
      name,
      cert,
      key,
      '--san',
      san,
      '--ca',
      made.authority,
      '--ca-key',
      made.authorityKey,
      '--no-password',
      '--insecure',
      '--not-after',
      '24h',
    ],
    { stdio: 'ignore' },
  );
  return { cert, key };
}

/** How a TLS client that trusts the authority alone, as a browser on the Mac would, judges a server's certificate. */
async function handshake(cert: string, key: string, servername: string): Promise<string> {
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (socket) => socket.end());
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((settle) => {
      const socket = connect({ host: '127.0.0.1', port, servername, ca: readFileSync(made.authority) });
      socket.once('secureConnect', () => {
        socket.destroy();
        settle('accepted');
      });
      socket.once('error', (error: Error) => settle(error.message));
    });
  } finally {
    server.close();
  }
}

describe('the local certificate authority', () => {
  it('signs for localhost names and nothing else', () => {
    for (const name of ['localhost', 'console.localhost', 'a.b.localhost', 'Console.LOCALHOST']) {
      expect(isLocalName(name), name).toBe(true);
    }
    for (const name of [
      'github.com',
      'localhost.github.com',
      'evilocalhost',
      '127.0.0.1',
      '*.localhost',
      '',
      '.localhost',
    ]) {
      expect(isLocalName(name), name).toBe(false);
    }
    const cert = join(dir, 'refused.crt');
    expect(() => sign(dir, ['console.localhost', 'github.com'], cert, join(dir, 'refused.key'), 1)).toThrow(
      'localhost names only, not github.com',
    );
    expect(existsSync(cert)).toBe(false);
  });

  it('gives Traefik a certificate for its hosts that a client trusting the authority accepts', async () => {
    const certificate = new X509Certificate(readFileSync(made.certificate));
    expect(certificate.subjectAltName).toBe(HOSTS.map((host) => `DNS:${host}`).join(', '));
    expect(certificate.checkIssued(new X509Certificate(readFileSync(made.authority)))).toBe(true);
    await expect(handshake(made.certificate, made.certificateKey, 'console.localhost')).resolves.toBe('accepted');
  });

  it('constrains what its key can mint: a certificate for any other name fails path validation', async () => {
    const github = mintedOutside('github', 'github.com');
    await expect(handshake(github.cert, github.key, 'github.com')).resolves.toBe('permitted subtree violation');
    const lookalike = mintedOutside('lookalike', 'localhost.github.com');
    await expect(handshake(lookalike.cert, lookalike.key, 'localhost.github.com')).resolves.toBe(
      'permitted subtree violation',
    );
    const address = mintedOutside('address', '140.82.112.3');
    await expect(handshake(address.cert, address.key, 'github.com')).resolves.toBe('excluded subtree violation');
    const mailbox = mintedOutside('mailbox', 'someone@github.com');
    await expect(handshake(mailbox.cert, mailbox.key, 'github.com')).resolves.toBe('permitted subtree violation');
    const uri = mintedOutside('uri', 'https://github.com/');
    await expect(handshake(uri.cert, uri.key, 'github.com')).resolves.toBe('permitted subtree violation');
    // Go's verifier, as `step` runs it, refuses it too.
    const verified = spawnSync(
      'step',
      ['certificate', 'verify', github.cert, '--roots', made.authority, '--host', 'github.com'],
      {
        encoding: 'utf-8',
      },
    );
    expect(verified.status).not.toBe(0);
    expect(verified.stderr).toContain('not permitted by any constraint');
  });

  it.runIf(process.platform === 'darwin')('is held to its constraints by macOS, as Safari judges a certificate', () => {
    const github = mintedOutside('github-mac', 'github.com');
    const verify = (cert: string, host: string) =>
      spawnSync('security', ['verify-cert', '-c', cert, '-r', made.authority, '-p', 'ssl', '-s', host, '-L', '-q'], {
        stdio: 'ignore',
      }).status;
    expect(verify(made.certificate, 'console.localhost')).toBe(0);
    expect(verify(github.cert, 'github.com')).not.toBe(0);
  });

  it('keeps its keys to their owner', () => {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(made.authorityKey).mode & 0o777).toBe(0o600);
    expect(statSync(made.certificateKey).mode & 0o777).toBe(0o600);
  });

  it('renews the certificate in its last 30 days, and the authority in its last 90, and nothing sooner', () => {
    const authority = readFileSync(made.authority, 'utf-8');
    expect(issue(dir)).toEqual([]);
    expect(issue(dir, new Date(Date.now() + 59 * DAY))).toEqual([]);
    expect(issue(dir, new Date(Date.now() + 61 * DAY))).toEqual([expect.stringMatching(/^Made a certificate for/)]);
    expect(readFileSync(made.authority, 'utf-8')).toBe(authority);
    expect(issue(dir, new Date(Date.now() + 641 * DAY))).toEqual([
      expect.stringMatching(/^Made a local certificate authority/),
      expect.stringMatching(/^Made a certificate for/),
    ]);
    expect(readFileSync(made.authority, 'utf-8')).not.toBe(authority);
  });
});
