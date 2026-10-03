/**
 * Artifacts: screenshots, diffs and outputs captured when they happen, because their sources expire. Each is named
 * by the SHA-256 of its contents, so it never changes and can be cached for good, and storing it twice costs nothing.
 *
 * On `local` they are files on disk, in the same layout as an event log's artifacts folder. Spaces and S3 will
 * implement the same interface.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const isHash = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

export interface ArtifactStore {
  /** Stores the bytes and returns their hash. */
  put(bytes: Uint8Array): Promise<string>;
  /** The stored size in bytes, or null if there is no such artifact. */
  size(hash: string): Promise<number | null>;
  /** The artifact's contents, or null if there is no such artifact. */
  open(hash: string): Promise<Readable | null>;
}

export class DiskArtifacts implements ArtifactStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async put(bytes: Uint8Array): Promise<string> {
    const hash = sha256(bytes);
    if ((await this.size(hash)) === bytes.byteLength) return hash;
    await mkdir(this.dir, { recursive: true });
    // Written beside its final name, then renamed: a reader never sees half an artifact.
    const partial = join(this.dir, `.${hash}.${process.pid}.partial`);
    await writeFile(partial, bytes, { mode: 0o444 });
    await rename(partial, this.path(hash));
    return hash;
  }

  async size(hash: string): Promise<number | null> {
    if (!isHash(hash)) return null;
    try {
      return (await stat(this.path(hash))).size;
    } catch {
      return null;
    }
  }

  async open(hash: string): Promise<Readable | null> {
    return (await this.size(hash)) === null ? null : createReadStream(this.path(hash));
  }

  private path(hash: string): string {
    return join(this.dir, hash);
  }
}
