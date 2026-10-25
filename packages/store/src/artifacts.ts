/**
 * Artifacts: screenshots, diffs and outputs captured when they happen, because their sources expire. Each is named
 * by the SHA-256 of its contents, so it never changes and can be cached for good, and storing it twice costs nothing.
 *
 * On `local` they are files on disk, in the same layout as an event log's artifacts folder. Spaces and S3 will
 * implement the same interface.
 */
import { createHash } from 'node:crypto';
import { type FileHandle, mkdir, open as openFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const isHash = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

/** An artifact opened for reading: its contents, and the size of the very file they are read from. */
export interface OpenedArtifact {
  body: Readable;
  size: number;
}

export interface ArtifactStore {
  /** Stores the bytes and returns their hash. */
  put(bytes: Uint8Array): Promise<string>;
  /** The stored size in bytes, or null if there is no such artifact. */
  size(hash: string): Promise<number | null>;
  /**
   * The artifact's contents and their size, or null if there is no such artifact. Both come from one opening, so a
   * file replaced or removed meanwhile cannot give a size that is not the size of the bytes read.
   */
  open(hash: string): Promise<OpenedArtifact | null>;
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

  async open(hash: string): Promise<OpenedArtifact | null> {
    if (!isHash(hash)) return null;
    let handle: FileHandle;
    try {
      handle = await openFile(this.path(hash), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
        return null;
      throw error;
    }
    // Measured through the handle, not the path: a `put` renaming over the name, or a `remove` taking it away, leaves
    // this file as it was, and the stream reads it. The stream owns the handle, and closes it when it ends or is closed.
    try {
      const { size } = await handle.stat();
      return { body: handle.createReadStream(), size };
    } catch (error) {
      await handle.close();
      throw error;
    }
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
