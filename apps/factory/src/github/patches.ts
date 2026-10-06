/**
 * Applying a runner's patch outside the sandbox (ADR 0008). The patch is data: a unified diff, as `git diff` writes
 * one. It is read and applied here in memory, to files read from GitHub at the commit it goes on, and nothing runs git
 * in a working tree a sandbox has touched, where a planted hook or config would run with the worker's rights.
 *
 * Plain text changes only: a file added, changed or deleted, as an ordinary file (mode 100644), at a plain relative
 * path. A binary file, a rename, an executable or a symlink, a change of mode, a path with `..`, `.` or an empty
 * segment, a block with no change in it, and a patch that does not apply cleanly are refused.
 */
import { applyPatch, parsePatch, type StructuredPatch } from 'diff';
import type { FileChanges } from './actions.ts';
import { plainPath } from './paths.ts';

export type PatchProblem = 'unsupported' | 'path' | 'protected' | 'does-not-apply';

export class PatchRefused extends Error {
  override name = 'PatchRefused';
  readonly kind: PatchProblem;

  constructor(kind: PatchProblem, message: string) {
    super(message);
    this.kind = kind;
  }
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
  if (/^GIT binary patch$|^Binary files /m.test(patch))
    throw new PatchRefused('unsupported', 'The patch changes a binary file.');
  if (/^(rename|copy) (from|to) /m.test(patch))
    throw new PatchRefused('unsupported', 'The patch renames or copies a file.');
  if (/^(old|new) mode /m.test(patch)) throw new PatchRefused('unsupported', 'The patch changes a file’s mode.');
  if (/^(new|deleted) file mode (?!100644$)/m.test(patch)) {
    throw new PatchRefused('unsupported', 'The patch adds or deletes something other than an ordinary file.');
  }
  const files = parsePatch(patch)
    .filter((p) => p.oldFileName !== undefined || p.newFileName !== undefined)
    .map((p) => {
      const before = strip(p.oldFileName, 'a');
      const after = strip(p.newFileName, 'b');
      const path = after ?? before;
      if (!path) throw new PatchRefused('path', 'The patch names a file it does not say the path of.');
      if (!plainPath(path))
        throw new PatchRefused('path', `The patch names ${JSON.stringify(path)}, which is not a plain path.`);
      if (before && after && before !== after)
        throw new PatchRefused('unsupported', `The patch moves ${before} to ${after}.`);
      if (!p.hunks.length) throw new PatchRefused('unsupported', `The patch names ${path} and changes nothing in it.`);
      return { path, change: before === null ? 'add' : after === null ? 'delete' : 'modify', patch: p } as FilePatch;
    });
  // Every `diff --git` block must be one of those: a block with no hunks (an empty file added) has no lines for the
  // parser to read, and would otherwise slip past the fence unseen.
  const blocks = patch.match(/^diff --git /gm)?.length ?? 0;
  if (blocks > files.length) throw new PatchRefused('unsupported', 'The patch has a file with no change in it.');
  return files;
}

/**
 * The patch applied to the files it changes, as the additions and deletions of one commit. `read` gives a file's
 * contents at the commit the patch goes on, or null if it is not there.
 */
export async function applyTo(patch: string, read: (path: string) => Promise<string | null>): Promise<FileChanges> {
  const changes: FileChanges = { additions: [], deletions: [] };
  for (const file of filesIn(patch)) {
    const current = await read(file.path);
    if (file.change === 'add' && current !== null)
      throw new PatchRefused('does-not-apply', `${file.path} already exists.`);
    if (file.change !== 'add' && current === null)
      throw new PatchRefused('does-not-apply', `${file.path} is not there to change.`);
    if (file.change === 'delete') {
      changes.deletions.push(file.path);
      continue;
    }
    const next = applyPatch(current ?? '', file.patch);
    if (next === false) throw new PatchRefused('does-not-apply', `The patch does not apply to ${file.path}.`);
    changes.additions.push({ path: file.path, contents: new TextEncoder().encode(next) });
  }
  return changes;
}
