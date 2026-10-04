/**
 * Applying a runner's patch outside the sandbox (ADR 0008). The patch is data: a unified diff, as `git diff` writes
 * one. It is read and applied here in memory, to files read from GitHub at the commit it goes on, and nothing runs git
 * in a working tree a sandbox has touched, where a planted hook or config would run with the worker's rights.
 *
 * Plain text changes only: a file added, changed or deleted. A binary file, a rename or a change of mode is refused,
 * as is a patch that does not apply cleanly.
 */
import { applyPatch, parsePatch, type StructuredPatch } from 'diff';
import type { FileChanges } from './actions.ts';

export class PatchRefused extends Error {
  override name = 'PatchRefused';
}

export interface FilePatch {
  path: string;
  change: 'add' | 'modify' | 'delete';
  patch: StructuredPatch;
}

const strip = (name: string | undefined, side: 'a' | 'b') =>
  name === undefined || name === '/dev/null' ? null : name.replace(new RegExp(`^${side}/`), '');

/** The files a patch changes, and how. */
export function filesIn(patch: string): FilePatch[] {
  if (/^GIT binary patch$|^Binary files /m.test(patch)) throw new PatchRefused('The patch changes a binary file.');
  if (/^(rename|copy) (from|to) /m.test(patch)) throw new PatchRefused('The patch renames or copies a file.');
  if (/^(old|new) mode /m.test(patch)) throw new PatchRefused('The patch changes a file’s mode.');
  return parsePatch(patch)
    .filter((p) => p.oldFileName !== undefined || p.newFileName !== undefined)
    .map((p) => {
      const before = strip(p.oldFileName, 'a');
      const after = strip(p.newFileName, 'b');
      const path = after ?? before;
      if (!path) throw new PatchRefused('The patch names a file it does not say the path of.');
      if (before && after && before !== after) throw new PatchRefused(`The patch moves ${before} to ${after}.`);
      return { path, change: before === null ? 'add' : after === null ? 'delete' : 'modify', patch: p } as FilePatch;
    });
}

/**
 * The patch applied to the files it changes, as the additions and deletions of one commit. `read` gives a file's
 * contents at the commit the patch goes on, or null if it is not there.
 */
export async function applyTo(patch: string, read: (path: string) => Promise<string | null>): Promise<FileChanges> {
  const changes: FileChanges = { additions: [], deletions: [] };
  for (const file of filesIn(patch)) {
    const current = await read(file.path);
    if (file.change === 'add' && current !== null) throw new PatchRefused(`${file.path} already exists.`);
    if (file.change !== 'add' && current === null) throw new PatchRefused(`${file.path} is not there to change.`);
    if (file.change === 'delete') {
      changes.deletions.push(file.path);
      continue;
    }
    const next = applyPatch(current ?? '', file.patch);
    if (next === false) throw new PatchRefused(`The patch does not apply to ${file.path}.`);
    changes.additions.push({ path: file.path, contents: new TextEncoder().encode(next) });
  }
  return changes;
}
