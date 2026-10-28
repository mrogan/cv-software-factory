import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { download, lockedPnpm, platformOf } from '../scripts/install-pnpm.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (file: string) => readFileSync(join(root, file), 'utf-8');

describe("the runner image's pnpm", () => {
  it("is the one mise.lock holds, which is package.json's packageManager, for each platform an image is built for", () => {
    const manager = /"packageManager": "pnpm@([^+"]+)/.exec(read('package.json'))?.[1];
    for (const platform of ['linux-arm64', 'linux-x64']) {
      const release = lockedPnpm(read('mise.lock'), platform);
      expect(release.version).toBe(manager);
      expect(release.url).toBe(`https://github.com/pnpm/pnpm/releases/download/v${manager}/pnpm-${platform}.tar.gz`);
      expect(release.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is installed from mise.lock by the script, with no corepack shim and no switching to another version', () => {
    const dockerfile = read('apps/runner/Dockerfile');
    expect(dockerfile).toContain('RUN node /tmp/pnpm/install-pnpm.ts /tmp/pnpm/mise.lock /opt/pnpm');
    expect(dockerfile).toContain('ENV npm_config_manage_package_manager_versions=false');
    expect(dockerfile).not.toMatch(/^RUN .*corepack/m);
    // The build context holds what the script reads.
    expect(read('apps/runner/Dockerfile.dockerignore').split('\n')).toEqual(
      expect.arrayContaining(['!mise.lock', '!apps/runner/scripts/install-pnpm.ts']),
    );
  });

  it('is only pnpm’s own release on GitHub, of the version locked', () => {
    const lock = read('mise.lock');
    const moved = lock.replaceAll('https://github.com/pnpm/pnpm/releases/download/', 'https://example.com/pnpm/');
    expect(() => lockedPnpm(moved, 'linux-x64')).toThrow("mise.lock's pnpm for linux-x64 is not pnpm's release");
    expect(() => lockedPnpm(lock, 'linux-riscv64')).toThrow('mise.lock holds no pnpm for linux-riscv64');
    expect(platformOf('arm64')).toBe('linux-arm64');
    expect(platformOf('x64')).toBe('linux-x64');
    expect(() => platformOf('s390x')).toThrow('holds no pnpm for s390x');
  });

  it('is refused when its download does not have the checksum mise.lock records', async () => {
    const body = Buffer.from('a release');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const release = { version: '12.15.0', url: 'https://github.com/pnpm/pnpm/releases/download/v12.15.0/x', sha256 };
    const serve = (async () => new Response(body)) as typeof fetch;
    await expect(download(release, serve)).resolves.toEqual(body);
    await expect(download({ ...release, sha256: '0'.repeat(64) }, serve)).rejects.toThrow(
      `has SHA-256 ${sha256}, and mise.lock records ${'0'.repeat(64)}`,
    );
    const missing = (async () => new Response('', { status: 404 })) as typeof fetch;
    await expect(download(release, missing)).rejects.toThrow(': 404');
  });
});
