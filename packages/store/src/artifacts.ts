/**
 * Artifacts: screenshots, diffs and outputs captured when they happen, because their sources expire. Each is named
 * by the SHA-256 of its contents, so it never changes and can be cached for good, and storing it twice costs nothing.
 *
 * On `local` they are files on disk, in the same layout as an event log's artifacts folder. Spaces and S3 will
 * implement the same interface.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
    if ((await this.size(hash)) === bytes.byteLength) {
      // Stored already: touched, so a deletion that judged it unused before now leaves it (`remove`). One that took it
      // away in between leaves nothing to touch, and it is written again.
      try {
        await utimes(this.path(hash), new Date(), new Date());
        return hash;
      } catch {}
    }
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

  /**
   * Deletes an artifact, if it was last stored before `unusedSince`, and says whether it is gone. Only its writer may,
   * and only once nothing names it: an event that names it would name nothing. One stored again since the writer judged
   * it unused stays, as a new event may be about to name it. The probes worker deletes the pictures no release needs.
   *
   * It is moved aside before its time is read, so a `put` of the same bytes, in this process or another on the same
   * folder, either touched it first and it is put back, or finds it gone and writes it again.
   */
  async remove(hash: string, unusedSince: Date): Promise<boolean> {
    if (!isHash(hash)) return true;
    const aside = join(this.dir, `.${hash}.${process.pid}.removing`);
    try {
      await rename(this.path(hash), aside);
    } catch {
      return true;
    }
    if ((await stat(aside)).mtimeMs >= unusedSince.getTime()) {
      await rename(aside, this.path(hash));
      return false;
    }
    await rm(aside, { force: true });
    return true;
  }

  private path(hash: string): string {
    return join(this.dir, hash);
  }
}
