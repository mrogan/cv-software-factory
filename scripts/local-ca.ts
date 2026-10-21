/**
 * The local certificate authority behind https://console.localhost:8443, and the one certificate it gives Traefik.
 * `make up` runs it through `make local-tls`; `make untrust-ca` undoes it.
 *
 *     node scripts/local-ca.ts issue     make the authority if there is none, and renew the certificate when it is due
 *     node scripts/local-ca.ts trust     have the Mac trust the authority, for TLS servers only (macOS asks once)
 *     node scripts/local-ca.ts untrust   take it out of the login keychain, and delete its key and certificates
 *     node scripts/local-ca.ts dir       print where it keeps them
 *
 * The authority is made with `step` (mise.toml), because mkcert cannot constrain one. Its certificate carries critical
 * name constraints: DNS names `localhost` and below, mail and URIs at `localhost` names, and no IP address at all. So
 * whatever reads its key, on this Mac or off it, can mint certificates that a browser, macOS, OpenSSL or Go accepts for
 * `localhost` names alone, never for GitHub or anything else. This script signs nothing else either, and the Mac trusts
 * the authority for TLS servers only.
 *
 * It lives outside the repository, in `LOCAL_CA_DIR` (by default ~/.config/software-factory/local-ca), readable by
 * its owner alone, and outlives the cluster, so the Mac is asked to trust it once and not at every `make up`. The
 * authority lasts two years and is made again in its last 90 days, which asks again; the certificate lasts 90 days and
 * is renewed by any `make up` in its last 30.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** The names Traefik serves over HTTPS. Another local host moves to HTTPS by joining them. */
export const HOSTS = ['console.localhost'];
/** How the authority is named, in its certificate and in the login keychain. */
export const AUTHORITY_NAME = 'Software Factory local CA';
/** Where the console is, once Traefik has the certificate. */
export const CONSOLE_URL = 'https://console.localhost:8443';

const DAY = 24 * 60 * 60 * 1000;
const AUTHORITY_DAYS = 730;
const AUTHORITY_RENEW_DAYS = 90;
const CERTIFICATE_DAYS = 90;
const CERTIFICATE_RENEW_DAYS = 30;

/** The authority's certificate: a root that may sign leaves only, for `localhost` names only, for TLS servers only. */
const AUTHORITY_TEMPLATE = JSON.stringify({
  subject: { commonName: AUTHORITY_NAME },
  issuer: { commonName: AUTHORITY_NAME },
  keyUsage: ['certSign', 'crlSign'],
  extKeyUsage: ['serverAuth'],
  basicConstraints: { isCA: true, maxPathLen: 0 },
  nameConstraints: {
    critical: true,
    // A DNS constraint covers the name and every name below it: `localhost`, `console.localhost` and so on.
    permittedDNSDomains: ['localhost'],
    // A constraint binds only names of its own type, so without these a certificate for an IP address, a mailbox or
    // a URI would be unconstrained.
    excludedIPRanges: ['0.0.0.0/0', '::/0'],
    permittedEmailAddresses: ['localhost', '.localhost'],
    permittedURIDomains: ['localhost', '.localhost'],
  },
});

/** The certificate Traefik serves: for its names, for a TLS server and nothing else. */
const CERTIFICATE_TEMPLATE = `{
  "subject": {{ toJson .Subject }},
  "sans": {{ toJson .SANs }},
  "keyUsage": ["digitalSignature"],
  "extKeyUsage": ["serverAuth"]
}`;

export function caDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCAL_CA_DIR || join(homedir(), '.config', 'software-factory', 'local-ca');
}

/** The files in an authority's directory. */
export function files(dir: string) {
  return {
    authority: join(dir, 'ca.crt'),
    authorityKey: join(dir, 'ca.key'),
    certificate: join(dir, 'tls.crt'),
    certificateKey: join(dir, 'tls.key'),
  };
}

/** Whether the authority may sign for a name: `localhost` or a name below it, and nothing else. */
export function isLocalName(name: string): boolean {
  const labels = name.toLowerCase().split('.');
  return labels.at(-1) === 'localhost' && labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function step(args: string[]): void {
  try {
    execFileSync('step', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error("step isn't installed: run 'mise install'.");
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`step ${args.slice(0, 2).join(' ')} failed${stderr ? `: ${stderr}` : '.'}`);
  }
}

/** Runs `step` with a template, written to a directory of its own for the moment it takes. */
function stepWithTemplate(template: string, args: string[]): void {
  const scratch = mkdtempSync(join(tmpdir(), 'local-ca-'));
  try {
    const path = join(scratch, 'template.json');
    writeFileSync(path, template);
    step([...args, '--template', path]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function read(path: string): X509Certificate | undefined {
  return existsSync(path) ? new X509Certificate(readFileSync(path)) : undefined;
}

function daysLeft(certificate: X509Certificate, now: Date): number {
  return (new Date(certificate.validTo).getTime() - now.getTime()) / DAY;
}

function dnsNames(certificate: X509Certificate): string[] {
  return (certificate.subjectAltName ?? '')
    .split(', ')
    .filter((name) => name.startsWith('DNS:'))
    .map((name) => name.slice(4))
    .sort();
}

/** Makes the authority. Its key is unencrypted, so that `make up` runs unattended; its name constraints bound it. */
export function makeAuthority(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const { authority, authorityKey } = files(dir);
  rmSync(authority, { force: true });
  rmSync(authorityKey, { force: true });
  stepWithTemplate(AUTHORITY_TEMPLATE, [
    'certificate',
    'create',
    AUTHORITY_NAME,
    authority,
    authorityKey,
    '--kty',
    'EC',
    '--crv',
    'P-256',
    '--not-after',
    `${AUTHORITY_DAYS * 24}h`,
    '--no-password',
    '--insecure',
  ]);
  chmodSync(authorityKey, 0o600);
}

/** Signs a certificate for local names, with a key of its own. Refuses any name that is not a `localhost` name. */
export function sign(dir: string, names: string[], certificatePath: string, keyPath: string, days: number): void {
  const [first] = names;
  if (!first) throw new Error('A certificate needs a name.');
  const foreign = names.filter((name) => !isLocalName(name));
  if (foreign.length > 0) {
    throw new Error(`The local authority signs for localhost names only, not ${foreign.join(', ')}.`);
  }
  const { authority, authorityKey } = files(dir);
  rmSync(certificatePath, { force: true });
  rmSync(keyPath, { force: true });
  stepWithTemplate(CERTIFICATE_TEMPLATE, [
    'certificate',
    'create',
    first,
    certificatePath,
    keyPath,
    ...names.flatMap((name) => ['--san', name]),
    '--ca',
    authority,
    '--ca-key',
    authorityKey,
    '--kty',
    'EC',
    '--crv',
    'P-256',
    '--not-after',
    `${days * 24}h`,
    '--no-password',
    '--insecure',
  ]);
  chmodSync(keyPath, 0o600);
}

/**
 * Makes the authority if there is none or it is near its end, and the certificate if it is missing, near its end,
 * for other names, or from another authority. Says what it did, a line each.
 */
export function issue(dir: string, now = new Date()): string[] {
  const said: string[] = [];
  const paths = files(dir);
  let authority = read(paths.authority);
  if (!authority || !existsSync(paths.authorityKey) || daysLeft(authority, now) < AUTHORITY_RENEW_DAYS) {
    makeAuthority(dir);
    authority = read(paths.authority) as X509Certificate;
    said.push(`Made a local certificate authority in ${dir}, for localhost names only.`);
  }
  const certificate = read(paths.certificate);
  const current =
    certificate &&
    existsSync(paths.certificateKey) &&
    certificate.checkIssued(authority) &&
    certificate.verify(authority.publicKey) &&
    daysLeft(certificate, now) >= CERTIFICATE_RENEW_DAYS &&
    dnsNames(certificate).join() === [...HOSTS].sort().join();
  if (!current) {
    sign(dir, HOSTS, paths.certificate, paths.certificateKey, CERTIFICATE_DAYS);
    said.push(`Made a certificate for ${HOSTS.join(', ')}, good for ${CERTIFICATE_DAYS} days; make up renews it.`);
  }
  return said;
}

/** Whether macOS trusts the certificate Traefik serves, as Safari would judge it. */
function trusted(dir: string): boolean {
  const [host = ''] = HOSTS;
  const result = spawnSync(
    'security',
    ['verify-cert', '-c', files(dir).certificate, '-p', 'ssl', '-s', host, '-L', '-q'],
    {
      stdio: 'ignore',
    },
  );
  return result.status === 0;
}

const LOSS = [
  `  Without it, browsers warn at ${CONSOLE_URL}: the console still shows the factory past the warning, but`,
  '  the admin sign-in will not work there (Safari drops its secure cookie, and passkeys need a trusted certificate).',
  "  Run 'make up' again to be asked again.",
];

/** Has the Mac trust the authority, for TLS servers only, in the login keychain. macOS asks for the password once. */
export function trust(dir: string): string[] {
  if (process.platform !== 'darwin') {
    return [
      `  Trust ${files(dir).authority} in your browser or your system's store for ${CONSOLE_URL} to work without a warning.`,
    ];
  }
  if (trusted(dir)) return [`  The Mac trusts the local certificate authority. 'make untrust-ca' removes it.`];
  console.log('  Asking macOS to trust the local certificate authority, for localhost names only (it asks once)...');
  const keychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
  spawnSync('security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', keychain, files(dir).authority], {
    stdio: 'inherit',
  });
  if (trusted(dir)) return [`  The Mac trusts the local certificate authority. 'make untrust-ca' removes it.`];
  return ['  The Mac does not trust the local certificate authority.', ...LOSS];
}

/** Takes every copy of the authority out of the login keychain, its trust with it, and deletes its directory. */
export function untrust(dir: string): string[] {
  const said: string[] = [];
  if (process.platform === 'darwin') {
    const found = spawnSync('security', ['find-certificate', '-a', '-c', AUTHORITY_NAME, '-Z'], { encoding: 'utf-8' });
    const hashes = [...(found.stdout ?? '').matchAll(/^SHA-1 hash: ([0-9A-F]+)$/gm)].map(([, hash]) => hash as string);
    for (const hash of hashes) {
      const deleted = spawnSync('security', ['delete-certificate', '-t', '-Z', hash], { stdio: 'inherit' });
      if (deleted.status !== 0) throw new Error(`The keychain kept the local authority ${hash}.`);
    }
    said.push(
      hashes.length > 0
        ? '  The Mac no longer trusts the local certificate authority.'
        : '  The login keychain holds no local certificate authority.',
    );
  }
  rmSync(dir, { recursive: true, force: true });
  said.push(`  Deleted ${dir}: the next 'make up' makes a new authority and asks again.`);
  return said;
}

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  const dir = caDir();
  try {
    const said =
      command === 'issue'
        ? issue(dir).map((line) => `  ${line}`)
        : command === 'trust'
          ? trust(dir)
          : command === 'untrust'
            ? untrust(dir)
            : command === 'dir'
              ? [dir]
              : undefined;
    if (!said) {
      console.error('Usage: node scripts/local-ca.ts issue | trust | untrust | dir');
      process.exit(2);
    }
    for (const line of said) console.log(line);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
