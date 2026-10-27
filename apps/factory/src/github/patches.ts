/**
 * Applying a runner's patch outside the sandbox (ADR 0008). The patch is data: a unified diff, as `git diff` writes
 * one. It is read and applied here in memory, to files read from GitHub at the commit it goes on, and nothing runs git
 * in a working tree a sandbox has touched, where a planted hook or config would run with the worker's rights.
 *
 * Plain text changes only: a file added, changed or deleted, as an ordinary file (mode 100644), at a plain relative
 * path, once in the patch. A binary file, a rename, an executable or a symlink, a change of mode, a path `plainPath`
 * refuses (one with `..`, `.` or an empty segment, a backslash or a control character, or one longer than an event
 * records, among others), a file named twice, a block with no change in it, hunks that overlap or are out of order, a
 * git header that says otherwise than the lines under it, text that is not a unified diff, and a patch that does not
 * apply cleanly are refused, each with a `PatchRefused`; so is a patch that changes no file, when it is to be applied.
 * What applies is what the patch says, line endings and all.
 */
import { PATH_CHARS } from '@software-factory/events';
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

/**
 * Where a hunk sits in the file before it, as a span of line numbers: an insertion (no line from before) sits between
 * the line it follows and the next, so two at the same place overlap.
 */
const span = ({ oldStart, oldLines }: StructuredPatch['hunks'][number]): [number, number] =>
  oldLines ? [oldStart, oldStart + oldLines - 1] : [oldStart + 0.5, oldStart + 0.5];

/** The files a patch changes, and how. */
export function filesIn(patch: string): FilePatch[] {
  // Line by line, split as the parser splits: a pattern's `^` with the `m` flag also starts a line after a lone `\r`.
  const lines = patch.split('\n');
  const any = (pattern: RegExp) => lines.some((line) => pattern.test(line));
  if (any(/^GIT binary patch$|^Binary files /))
    throw new PatchRefused('unsupported', 'The patch changes a binary file.');
  if (any(/^(rename|copy) (from|to) /)) throw new PatchRefused('unsupported', 'The patch renames or copies a file.');
  if (any(/^(old|new) mode /)) throw new PatchRefused('unsupported', 'The patch changes a file’s mode.');
  if (any(/^(new|deleted) file mode (?!100644$)/)) {
    throw new PatchRefused('unsupported', 'The patch adds or deletes something other than an ordinary file.');
  }
  let parsed: StructuredPatch[];
  try {
    parsed = parsePatch(patch);
  } catch (error) {
    throw new PatchRefused('unsupported', `The patch is not a unified diff: ${(error as Error).message}`);
  }
  const entries = parsed
    // The parser gives a nameless entry for text with no file in it; one with hunks is a change with no path.
    .filter((p) => p.oldFileName !== undefined || p.newFileName !== undefined || p.hunks.length);
  // A patch as git writes it is a `diff --git` block for each file, and nothing else: a block with no hunks (an empty
  // file added) would otherwise slip past the fence unseen, and a plain `---`/`+++` block would make up the count.
  const headers = lines.filter((line) => line.startsWith('diff --git '));
  if (headers.length && (headers.length !== entries.length || entries.some((p) => !p.isGit)))
    throw new PatchRefused('unsupported', 'The patch has a file block that is not one change to one file.');
  const files = entries.map((p, i) => {
    const before = strip(p.oldFileName, 'a');
    const after = strip(p.newFileName, 'b');
    const path = after ?? before;
    if (!path) throw new PatchRefused('path', 'The patch names a file it does not say the path of.');
    // Said first, and with the path cut short: the refusal reaches the coder's next try only in its first words.
    if (path.length > PATH_CHARS)
      throw new PatchRefused(
        'path',
        `The patch names a path of ${path.length} characters, longer than ${PATH_CHARS}, which is not a plain path: ${JSON.stringify(path.slice(0, 60))}…`,
      );
    if (!plainPath(path))
      throw new PatchRefused('path', `The patch names ${JSON.stringify(path)}, which is not a plain path.`);
    if (before && after && before !== after)
      throw new PatchRefused('unsupported', `The patch moves ${before} to ${after}.`);
    if (!p.hunks.some((h) => h.lines.some((l) => l.startsWith('+') || l.startsWith('-'))))
      throw new PatchRefused('unsupported', `The patch names ${path} and changes nothing in it.`);
    // git's header says what the `---`/`+++` lines under it say: the same file, added or deleted only if they say so.
    const header = headers[i] === undefined ? undefined : parsePatch(headers[i])[0];
    if (
      header &&
      (strip(header.oldFileName, 'a') !== path ||
        strip(header.newFileName, 'b') !== path ||
        (p.isCreate && before !== null) ||
        (p.isDelete && after !== null))
    )
      throw new PatchRefused('unsupported', `The patch’s header for ${path} says otherwise than its lines.`);
    // Each hunk is applied to the file as it was, so one that overlaps or comes before the last would change it twice.
    const tangled = p.hunks.some((hunk, h) => {
      const last = p.hunks[h - 1];
      return last !== undefined && span(hunk)[0] <= span(last)[1];
    });
    if (tangled) throw new PatchRefused('unsupported', `The patch’s hunks for ${path} overlap or are out of order.`);
    return { path, change: before === null ? 'add' : after === null ? 'delete' : 'modify', patch: p } as FilePatch;
  });
  // Each block is applied to the file as it was, so a second block for a path would undo the first.
  const seen = new Set<string>();
  for (const { path } of files) {
    if (seen.has(path)) throw new PatchRefused('unsupported', `The patch names ${path} more than once.`);
    seen.add(path);
  }
  return files;
}

/**
 * The patch applied to the files it changes, as the additions and deletions of one commit. `read` gives a file's
 * contents at the commit the patch goes on, or null if it is not there.
 */
export async function applyTo(patch: string, read: (path: string) => Promise<string | null>): Promise<FileChanges> {
  const changes: FileChanges = { additions: [], deletions: [] };
  const files = filesIn(patch);
  // Text with no file in it reads as no change, which is not a commit to make.
  if (!files.length) throw new PatchRefused('unsupported', 'The patch changes no file.');
  for (const file of files) {
    const current = await read(file.path);
    if (file.change === 'add' && current !== null)
      throw new PatchRefused('does-not-apply', `${file.path} already exists.`);
    if (file.change !== 'add' && current === null)
      throw new PatchRefused('does-not-apply', `${file.path} is not there to change.`);
    // Line endings as the patch has them, never converted to the file's, so what is committed is what it says.
    const next = applyPatch(current ?? '', file.patch, { autoConvertLineEndings: false });
    // A file deleted is deleted only as the patch saw it: all of it, as it is at the commit.
    if (next === false || (file.change === 'delete' && next !== ''))
      throw new PatchRefused('does-not-apply', `The patch does not apply to ${file.path}.`);
    if (file.change === 'delete') {
      changes.deletions.push(file.path);
      continue;
    }
    changes.additions.push({ path: file.path, contents: new TextEncoder().encode(next) });
  }
  return changes;
}
