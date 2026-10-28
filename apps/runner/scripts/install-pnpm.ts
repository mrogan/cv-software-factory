#!/usr/bin/env node
/**
 * Puts the pnpm mise.lock holds into the runner image, from the release mise.lock names for the image's platform and
 * only if its download has the checksum mise.lock records. pnpm comes from the one place this repository pins it,
 * so `mise upgrade` moves the runners' pnpm with the toolchain's. It is pnpm's own executable: corepack is not
 * involved, so nothing in the image fetches a pnpm when a checkout's `packageManager` names another.
 *
 *     node apps/runner/scripts/install-pnpm.ts <mise.lock> <folder>
 *
 * The folder gets the release's contents: the `pnpm` executable and the `dist/` it reads beside it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A release of pnpm, as mise.lock names it for one platform. */
export interface Release {
  version: string;
  url: string;
  /** The download's SHA-256, in hex. */
  sha256: string;
}

/** mise.lock's name for a Linux platform, by Node's name for its architecture. */
export function platformOf(arch: string = process.arch): string {
  if (arch === 'arm64') return 'linux-arm64';
  if (arch === 'x64') return 'linux-x64';
  throw new Error(`mise.lock holds no pnpm for ${arch}: it locks linux-arm64 and linux-x64`);
}

/** The pnpm mise.lock holds for a platform. Only pnpm's own release on GitHub, of that version, is taken. */
export function lockedPnpm(lock: string, platform: string): Release {
  const text = lock.replace(/\r\n?/g, '\n');
  const entry = /^\[\[tools\.pnpm\]\]\n([\s\S]*?)(?=^\[\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  const version = /^version = "(\d+\.\d+\.\d+)"$/m.exec(entry)?.[1];
  const section = entry.split(`[tools.pnpm."platforms.${platform}"]\n`)[1]?.split(/\n(?=\[)/)[0] ?? '';
  const url = /^url = "([^"]+)"$/m.exec(section)?.[1];
  const sha256 = /^checksum = "sha256:([0-9a-f]{64})"$/m.exec(section)?.[1];
  if (!version || !url || !sha256) throw new Error(`mise.lock holds no pnpm for ${platform}, with its checksum`);
  const release = `https://github.com/pnpm/pnpm/releases/download/v${version}/`;
  if (!url.startsWith(release)) throw new Error(`mise.lock's pnpm for ${platform} is not pnpm's release: ${url}`);
  return { version, url, sha256 };
}

/** Downloads a release, refusing it unless its SHA-256 is the one mise.lock records. */
export async function download(release: Release, get: typeof fetch = fetch): Promise<Buffer> {
  const response = await get(release.url);
  if (!response.ok) throw new Error(`${release.url}: ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (sha256 !== release.sha256) {
    throw new Error(`${release.url} has SHA-256 ${sha256}, and mise.lock records ${release.sha256}`);
  }
  return body;
}

async function main([lockFile, folder]: string[]): Promise<number> {
  if (!lockFile || !folder) {
    console.error('Usage: node apps/runner/scripts/install-pnpm.ts <mise.lock> <folder>');
    return 2;
  }
  const release = lockedPnpm(readFileSync(lockFile, 'utf-8'), platformOf());
  const temporary = mkdtempSync(join(tmpdir(), 'pnpm-'));
  const archive = join(temporary, 'pnpm.tar.gz');
  writeFileSync(archive, await download(release));
  mkdirSync(folder, { recursive: true });
  execFileSync('tar', ['--extract', '--gzip', '--no-same-owner', '--file', archive, '--directory', folder]);
  rmSync(temporary, { recursive: true });
  // The executable is at the release's root, and is the version locked.
  const runs = execFileSync(join(folder, 'pnpm'), ['--version'], { encoding: 'utf-8' }).trim();
  if (runs !== release.version) throw new Error(`${release.url} holds pnpm ${runs}, not ${release.version}`);
  console.log(`pnpm ${release.version}, from ${release.url}, checked against mise.lock`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
