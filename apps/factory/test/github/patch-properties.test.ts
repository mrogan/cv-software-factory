/**
 * Properties of applying a runner's patch outside the sandbox (`src/github/patches.ts`, ADR 0008), over patches
 * fast-check makes up: diffs written here, in git's format, between made-up versions of made-up files; those diffs
 * with one thing the module refuses spliced in; and those diffs mangled, or text that is no diff at all. The patch is
 * written by an agent in the sandbox, so whatever it holds, the worker either commits exactly what it says, to paths
 * the fence reads, or refuses it with its own refusal. `patches.test.ts` holds the examples.
 *
 * A failure prints the seed and the shrunk case that broke the property: `fc.assert(..., { seed, path })` replays it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyTo, filesIn, type PatchProblem, PatchRefused } from '../../src/github/patches.ts';
import { plainPath } from '../../src/github/paths.ts';

/**
 * Lines a file may hold, few enough that they repeat and a hunk's context could match in more than one place, and
 * some that look like a patch's own lines once a hunk's mark is put before them.
 */
const TEXTS = [
  'a',
  'b',
  'c',
  '',
  '  return x;',
  '}',
  '-- a/evil.ts',
  '++ b/evil.ts',
  '@@ -1 +1 @@',
  '\\ No newline at end of file',
  'diff --git a/x b/x',
  'new file mode 100755',
  'rename from x',
  '\tindented',
  'ünïcode ✓',
  'windows\r',
];

/** A path segment as git writes one unquoted: never `.` or `..`, nor the `~` the spliced paths below use. */
const segment = fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/).filter((s) => s !== '.' && s !== '..');
const filePath = fc.array(segment, { minLength: 1, maxLength: 3 }).map((s) => s.join('/'));

type Mark = ' ' | '-' | '+';
interface Op {
  mark: Mark;
  text: string;
}

interface FileSpec {
  path: string;
  change: 'add' | 'modify' | 'delete';
  ops: Op[];
  /** Whether the file ends in a newline before the change, and after it. */
  oldEol: boolean;
  newEol: boolean;
  /** Lines of context around each change, as `git diff -U<n>` writes. */
  context: number;
}

interface Written {
  spec: FileSpec;
  /** The file before the patch, or null when the patch adds it. */
  before: string | null;
  /** The file after it, or null when the patch deletes it. */
  after: string | null;
  block: string;
  /** Each hunk's lines from before, to find one a change elsewhere would break. */
  hunkOld: string[][];
}

const text = fc.constantFrom(...TEXTS);
const op = (marks: Mark[]) => fc.record({ mark: fc.constantFrom(...marks), text }).map((o) => o as Op);

/** What a file's change is, apart from its path: lines kept, deleted and added, in order. */
const changeOf = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      change: fc.constant('modify' as const),
      ops: fc
        .array(fc.oneof({ weight: 3, arbitrary: op([' ']) }, { weight: 2, arbitrary: op(['-', '+']) }), {
          minLength: 1,
          maxLength: 30,
        })
        .filter((ops) => ops.some((o) => o.mark !== ' ')),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      change: fc.constant('add' as const),
      ops: fc.array(op(['+']), { minLength: 1, maxLength: 8 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      change: fc.constant('delete' as const),
      ops: fc.array(op(['-']), { minLength: 1, maxLength: 8 }),
    }),
  },
);

const eol = fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) });
/**
 * Which lines end as Windows ends one, with a carriage return before the newline: none; every line of the file before
 * the change, and none the change adds; or every line either side.
 */
const windows = fc.oneof(
  { weight: 4, arbitrary: fc.constant('none' as const) },
  { weight: 1, arbitrary: fc.constant('before' as const) },
  { weight: 1, arbitrary: fc.constant('all' as const) },
);
const ending = (crlf: 'none' | 'before' | 'all', o: Op): Op =>
  crlf === 'all' || (crlf === 'before' && o.mark !== '+') ? { ...o, text: `${o.text}\r` } : o;

const fileSpecs = fc.uniqueArray(filePath, { minLength: 1, maxLength: 4 }).chain((paths) =>
  fc.tuple(
    ...paths.map((path) =>
      fc.record({ c: changeOf, crlf: windows, oldEol: eol, newEol: eol, context: fc.integer({ min: 0, max: 3 }) }).map(
        ({ c: { change, ops }, crlf, ...rest }): FileSpec => ({
          path,
          change,
          ops: ops.map((o) => ending(crlf, o)),
          ...rest,
        }),
      ),
    ),
  ),
);

const range = (start: number, length: number) => `${length ? start + 1 : start}${length === 1 ? '' : `,${length}`}`;

/** One file's block of a patch, as `git diff --no-renames` writes it, and the file either side of it. */
function write(spec: FileSpec): Written {
  const ops = [...spec.ops];
  const oldSide = (o: Op) => o.mark !== '+';
  const newSide = (o: Op) => o.mark !== '-';
  const lastOld = ops.findLastIndex(oldSide);
  const lastNew = ops.findLastIndex(newSide);
  // An empty last line with no newline is no line at all.
  const oldEol = lastOld < 0 || spec.oldEol || ops[lastOld]?.text === '';
  const newEol = lastNew < 0 || spec.newEol || ops[lastNew]?.text === '';
  // A line kept that ends one side with no newline, and on the other has one, is a line changed.
  const lacking = (i: number) => (i === lastOld && !oldEol) !== (i === lastNew && !newEol);
  const kept = [lastOld, lastNew].find((i) => i >= 0 && ops[i]?.mark === ' ' && lacking(i));
  if (kept !== undefined) {
    const { text } = ops[kept] as Op;
    ops.splice(kept, 1, { mark: '-', text }, { mark: '+', text });
  }
  const iOld = ops.findLastIndex(oldSide);
  const iNew = ops.findLastIndex(newSide);
  const join = (lines: Op[], end: boolean) =>
    lines.length ? lines.map((o) => o.text).join('\n') + (end ? '\n' : '') : '';
  const before = spec.change === 'add' ? null : join(ops.filter(oldSide), oldEol);
  const after = spec.change === 'delete' ? null : join(ops.filter(newSide), newEol);

  // Hunks: each change with `context` lines either side, joined where their context meets.
  const changed = ops.flatMap((o, i) => (o.mark === ' ' ? [] : [i]));
  const groups: [number, number][] = [];
  for (const i of changed) {
    const last = groups.at(-1);
    if (last && i - spec.context <= last[1] + spec.context + 1) last[1] = i;
    else groups.push([i, i]);
  }
  const oldBefore = (i: number) => ops.slice(0, i).filter(oldSide).length;
  const newBefore = (i: number) => ops.slice(0, i).filter(newSide).length;
  const hunkOld: string[][] = [];
  const hunks = groups.map(([first, last]) => {
    const from = Math.max(0, first - spec.context);
    const to = Math.min(ops.length - 1, last + spec.context);
    const lines = ops.slice(from, to + 1);
    hunkOld.push(lines.filter(oldSide).map((o) => o.text));
    const body = lines.flatMap((o, k) => {
      const i = from + k;
      const marker = (i === iOld && !oldEol) || (i === iNew && !newEol) ? ['\\ No newline at end of file'] : [];
      return [`${o.mark}${o.text}`, ...marker];
    });
    const header = `@@ -${range(oldBefore(from), lines.filter(oldSide).length)} +${range(newBefore(from), lines.filter(newSide).length)} @@`;
    return [header, ...body].join('\n');
  });

  const { path, change } = spec;
  const block = [
    `diff --git a/${path} b/${path}`,
    ...(change === 'add' ? ['new file mode 100644'] : change === 'delete' ? ['deleted file mode 100644'] : []),
    `index 1111111..2222222${change === 'modify' ? ' 100644' : ''}`,
    `--- ${change === 'add' ? '/dev/null' : `a/${path}`}`,
    `+++ ${change === 'delete' ? '/dev/null' : `b/${path}`}`,
    ...hunks,
  ].join('\n');
  return { spec, before, after, block: `${block}\n`, hunkOld };
}

const patches = fileSpecs.map((specs) => {
  const files = specs.map(write);
  return { files, patch: files.map((f) => f.block).join('') };
});

/** A reader of the files before the patch, which keeps the paths it is asked for. */
function reader(files: Written[], tamper: (path: string, contents: string | null) => string | null = (_, c) => c) {
  const asked: string[] = [];
  const read = async (path: string) => {
    asked.push(path);
    return tamper(path, files.find((f) => f.spec.path === path)?.before ?? null);
  };
  return { read, asked };
}

const decoded = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Refused, with the module's own refusal and nothing else; the kind when it is. */
async function refusal(run: () => Promise<unknown>): Promise<PatchProblem | 'accepted'> {
  try {
    await run();
    return 'accepted';
  } catch (error) {
    if (error instanceof PatchRefused) return error.kind;
    throw error;
  }
}

describe('a patch as git writes it', () => {
  it('reads back the paths and kinds of change it was written with', () => {
    fc.assert(
      fc.property(patches, ({ files, patch }) => {
        expect(filesIn(patch).map((f) => [f.path, f.change])).toEqual(files.map((f) => [f.spec.path, f.spec.change]));
      }),
    );
  });

  it('applies to the files it was made from to give exactly the files it was made to', async () => {
    await fc.assert(
      fc.asyncProperty(patches, async ({ files, patch }) => {
        const changes = await applyTo(patch, reader(files).read);
        expect(changes.deletions).toEqual(files.filter((f) => f.after === null).map((f) => f.spec.path));
        expect(changes.additions.map((a) => [a.path, decoded(a.contents)])).toEqual(
          files.filter((f) => f.after !== null).map((f) => [f.spec.path, f.after]),
        );
      }),
    );
  });
});

/**
 * One thing the module's header refuses, spliced into a patch it would take, before the block at `at`. Each says the
 * kinds of refusal that are right for it.
 */
interface Spoiler {
  name: string;
  kinds: PatchProblem[];
  splice: (blocks: string[], at: number, files: Written[]) => string[];
}

/** A path no generated one can be, for a block spliced in. */
const SPLICED = 'spliced~.ts';
/** A block adding a one-line file at `path`, with the mode given. */
const addBlock = (path: string, mode: string) =>
  `diff --git a/${path} b/${path}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;
const insert = (blocks: string[], at: number, block: string) => [...blocks.slice(0, at), block, ...blocks.slice(at)];
/** Lines put into the block at `at`, after its `diff --git` line. */
const intoHeader = (blocks: string[], at: number, lines: string) =>
  blocks.map((b, i) => (i === at ? b.replace(/\n/, `\n${lines}`) : b));
/** The block at `at`, naming `bad` wherever it names its own path. */
const renamed = (blocks: string[], at: number, files: Written[], bad: string) => {
  const path = (files[at] as Written).spec.path;
  return blocks.map((b, i) =>
    i === at ? b.replaceAll(`a/${path}`, `a/${bad}`).replaceAll(`b/${path}`, `b/${bad}`) : b,
  );
};

const badPath = fc.oneof(
  fc.tuple(filePath, fc.constantFrom('..', '.', ''), filePath).map(([x, bad, y]) => `${x}/${bad}/${y}`),
  fc.tuple(fc.constantFrom('..', '.'), filePath).map(([bad, y]) => `${bad}/${y}`),
  filePath.map((p) => `/${p}`),
  filePath.map((p) => `${p}/`),
);
/** A path with a control character or backslash in it, as git quotes and escapes one. */
const escaped = fc.tuple(segment, fc.constantFrom('\\t', '\\n', '\\001', '\\177', '\\\\'), segment);

const spoilers = (bad: string, [x, code, y]: [string, string, string]): Spoiler[] => [
  {
    name: 'a binary file',
    kinds: ['unsupported'],
    splice: (blocks, at) =>
      insert(
        blocks,
        at,
        `diff --git a/${SPLICED} b/${SPLICED}\nindex 1111111..2222222 100644\nBinary files a/${SPLICED} and b/${SPLICED} differ\n`,
      ),
  },
  {
    name: 'a binary patch',
    kinds: ['unsupported'],
    splice: (blocks, at) =>
      insert(
        blocks,
        at,
        `diff --git a/${SPLICED} b/${SPLICED}\nnew file mode 100644\nindex 0000000..2222222\nGIT binary patch\nliteral 3\nKcmZ?wbN~PV\n\nliteral 0\nKcmV+b0RR6000031\n`,
      ),
  },
  {
    name: 'a rename',
    kinds: ['unsupported'],
    splice: (blocks, at, files) =>
      intoHeader(blocks, at, `similarity index 90%\nrename from ${files[at]?.spec.path}\nrename to ${SPLICED}\n`),
  },
  {
    name: 'a copy',
    kinds: ['unsupported'],
    splice: (blocks, at, files) => intoHeader(blocks, at, `copy from ${files[at]?.spec.path}\ncopy to ${SPLICED}\n`),
  },
  {
    name: 'a change of mode',
    kinds: ['unsupported'],
    splice: (blocks, at) => intoHeader(blocks, at, 'old mode 100644\nnew mode 100755\n'),
  },
  {
    name: 'a move without a rename',
    kinds: ['unsupported'],
    splice: (blocks, at, files) =>
      blocks.map((b, i) => {
        const path = files[i]?.spec.path;
        return i === at && files[i]?.spec.change === 'modify' ? b.replace(`+++ b/${path}`, `+++ b/${SPLICED}`) : b;
      }),
  },
  ...['100755', '120000', '160000', '040000'].map((mode) => ({
    name: `a file added with mode ${mode}`,
    kinds: ['unsupported'] as PatchProblem[],
    splice: (blocks: string[], at: number) => insert(blocks, at, addBlock(SPLICED, mode)),
  })),
  {
    name: 'a file deleted with mode 120000',
    kinds: ['unsupported'],
    splice: (blocks, at) =>
      insert(
        blocks,
        at,
        `diff --git a/${SPLICED} b/${SPLICED}\ndeleted file mode 120000\n--- a/${SPLICED}\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`,
      ),
  },
  {
    name: `the path ${JSON.stringify(bad)}`,
    kinds: ['path'],
    splice: (blocks, at, files) => renamed(blocks, at, files, bad),
  },
  {
    name: `the quoted path ${x}${code}${y}`,
    kinds: ['path'],
    splice: (blocks, at) =>
      insert(
        blocks,
        at,
        `diff --git "a/${x}${code}${y}" "b/${x}${code}${y}"\nnew file mode 100644\n--- /dev/null\n+++ "b/${x}${code}${y}"\n@@ -0,0 +1 @@\n+x\n`,
      ),
  },
  {
    name: 'an empty file added',
    kinds: ['unsupported'],
    splice: (blocks, at) =>
      insert(blocks, at, `diff --git a/${SPLICED} b/${SPLICED}\nnew file mode 100644\nindex 0000000..e69de29\n`),
  },
  {
    name: 'a file named with no hunk',
    kinds: ['unsupported'],
    splice: (blocks, at) =>
      insert(blocks, at, `diff --git a/${SPLICED} b/${SPLICED}\n--- a/${SPLICED}\n+++ b/${SPLICED}\n`),
  },
  {
    name: 'a hunk with no change in it',
    kinds: ['unsupported'],
    splice: (blocks, at) =>
      insert(
        blocks,
        at,
        `diff --git a/${SPLICED} b/${SPLICED}\n--- a/${SPLICED}\n+++ b/${SPLICED}\n@@ -1,2 +1,2 @@\n a\n b\n`,
      ),
  },
  {
    name: 'a hunk before any file is named',
    kinds: ['path', 'unsupported'],
    splice: (blocks) => [`@@ -1 +1 @@\n-a\n+b\n`, ...blocks],
  },
  {
    name: 'a file named twice',
    kinds: ['unsupported'],
    splice: (blocks, at, files) => {
      const { path } = (files[at] as Written).spec;
      return [...blocks, `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y\n`];
    },
  },
];

describe('a patch with one thing in it the module refuses', () => {
  const spoiled = fc
    .tuple(patches, badPath, escaped)
    .chain(([written, bad, esc]) =>
      fc.tuple(
        fc.constant(written),
        fc.constantFrom(...spoilers(bad, esc)),
        fc.integer({ min: 0, max: written.files.length - 1 }),
      ),
    );

  it('is refused for what it is, before a file is read, whatever else it holds', async () => {
    await fc.assert(
      fc.asyncProperty(spoiled, async ([{ files, patch }, spoiler, at]) => {
        const blocks = spoiler.splice(
          files.map((f) => f.block),
          at,
          files,
        );
        const spoilt = blocks.join('');
        // A spoiler that could not apply to the block chosen leaves the patch as it was; that is no test of it.
        fc.pre(spoilt !== patch);
        const { read, asked } = reader(files);
        expect(spoiler.kinds, spoiler.name).toContain(await refusal(() => applyTo(spoilt, read)));
        expect(asked, spoiler.name).toEqual([]);
      }),
    );
  });
});

describe('a patch the files at the commit do not match', () => {
  /** A file the patch changes, and what it finds there instead of what it was made from. */
  const mismatched = patches.chain(({ files, patch }) =>
    fc.tuple(fc.constant({ files, patch }), fc.integer({ min: 0, max: files.length - 1 }), fc.nat()),
  );

  it('is refused as not applying', async () => {
    await fc.assert(
      fc.asyncProperty(mismatched, async ([{ files, patch }, at, pick]) => {
        const target = files[at] as Written;
        const lines = target.hunkOld.flat();
        // Whatever stood in a hunk, changed everywhere it stands, so the hunk cannot match anywhere in the file; a
        // file to add is there already; a file to delete has more in it than the patch saw; a file to change, with no
        // line before it in any hunk, is not there at all.
        const line = lines[pick % Math.max(1, lines.length)];
        const tamper = (path: string, contents: string | null) => {
          if (path !== target.spec.path) return contents;
          if (contents === null) return 'already here\n';
          if (target.spec.change === 'delete' && pick % 2) return `${contents}added since\n`;
          if (line === undefined) return null;
          return contents
            .split('\n')
            .map((l) => (l === line ? `${l} changed since` : l))
            .join('\n');
        };
        expect(await refusal(() => applyTo(patch, reader(files, tamper).read))).toBe('does-not-apply');
      }),
    );
  });
});

describe('any text at all, given as a patch', () => {
  /** Lines a patch is made of, and lines that are nearly them. */
  const patchLine = fc.oneof(
    fc.constantFrom(
      'diff --git a/x b/x',
      'diff --git a/../x b/../x',
      '--- a/x',
      '+++ b/x',
      '--- /dev/null',
      '+++ /dev/null',
      '+++ b/y',
      '--- a//x',
      '+++ "b/x\\ty"',
      'new file mode 100644',
      'deleted file mode 100644',
      'index 0000000..e69de29',
      '@@ -1 +1 @@',
      '@@ -0,0 +1 @@',
      '@@ -1 +0,0 @@',
      '@@ -1,2 +1,2 @@',
      '@@ -2,0 +3 @@',
      '\\ No newline at end of file',
      '-a',
      '+b',
      ' a',
      '',
    ),
    fc.string({ maxLength: 12 }),
    fc.tuple(fc.constantFrom(' ', '-', '+', '@', '\\', 'd'), fc.string({ maxLength: 6 })).map(([c, s]) => c + s),
  );
  const nearlyPatch = fc.array(patchLine, { maxLength: 20 }).map((lines) => lines.join('\n'));

  /** A patch git would write, with a few of its lines dropped, repeated, swapped or changed. */
  const mangled = fc
    .tuple(
      patches,
      fc.array(
        fc.record({
          how: fc.constantFrom('drop', 'repeat', 'swap', 'insert', 'retype'),
          at: fc.nat(),
          other: fc.nat(),
          line: patchLine,
          mark: fc.constantFrom(' ', '-', '+', '@', '\\', 'd'),
        }),
        { minLength: 1, maxLength: 4 },
      ),
    )
    .map(([{ files, patch }, edits]) => {
      const lines = patch.split('\n');
      for (const { how, at, other, line, mark } of edits) {
        const i = at % lines.length;
        const j = other % lines.length;
        if (how === 'drop') lines.splice(i, 1);
        else if (how === 'repeat') lines.splice(i, 0, lines[i] ?? '');
        else if (how === 'swap') [lines[i], lines[j]] = [lines[j] ?? '', lines[i] ?? ''];
        else if (how === 'insert') lines.splice(i, 0, line);
        else lines[i] = mark + (lines[i] ?? '').slice(1);
      }
      return { files, patch: lines.join('\n') };
    });

  const anyPatch = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 200 }).map((patch) => ({ files: [] as Written[], patch })),
    nearlyPatch.map((patch) => ({ files: [] as Written[], patch })),
    mangled,
  );
  /** What a reader finds: the files the patch was made from, or for a path it was not, anything. */
  const found = fc.oneof(fc.constant(null), fc.constantFrom('a\n', 'a\nb\n', 'x\n', '', 'a'));

  it('is refused with the module’s own refusal, or commits only plain paths, once each, that the fence reads', async () => {
    await fc.assert(
      fc.asyncProperty(anyPatch, found, async ({ files, patch }, other) => {
        let read: string[];
        try {
          read = filesIn(patch).map((f) => f.path);
        } catch (error) {
          expect(error).toBeInstanceOf(PatchRefused);
          return;
        }
        for (const path of read) expect(plainPath(path), path).toBe(true);
        expect(new Set(read).size).toBe(read.length);
        let changes: Awaited<ReturnType<typeof applyTo>>;
        try {
          changes = await applyTo(patch, reader(files, (_, c) => c ?? other).read);
        } catch (error) {
          expect(error).toBeInstanceOf(PatchRefused);
          return;
        }
        const committed = [...changes.additions.map((a) => a.path), ...changes.deletions];
        expect(new Set(committed).size).toBe(committed.length);
        for (const path of committed) expect(read).toContain(path);
      }),
    );
  });
});
