import { describe, expect, it } from 'vitest';
import { contentsReader, DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { applyTo, filesIn, PatchRefused } from '../../src/github/patches.ts';
import { plainPath } from '../../src/github/paths.ts';
import { calls, client, quiet, REPO, SHA } from './fake.ts';

const FIX = `diff --git a/src/count.ts b/src/count.ts
index 87bd8ed..285826d 100644
--- a/src/count.ts
+++ b/src/count.ts
@@ -1 +1 @@
-export const count = (xs: unknown[]) => xs.length - 1;
+export const count = (xs: unknown[]) => xs.length;
diff --git a/test/count.test.ts b/test/count.test.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/test/count.test.ts
@@ -0,0 +1 @@
+it('counts', () => expect(count([1])).toBe(1));
diff --git a/old.ts b/old.ts
deleted file mode 100644
index 1111111..0000000
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

const BASE: Record<string, string> = {
  'src/count.ts': 'export const count = (xs: unknown[]) => xs.length - 1;\n',
  'old.ts': 'gone\n',
};
const read = async (path: string) => BASE[path] ?? null;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('applying a patch outside the sandbox', () => {
  it('reads what each file is to become, added, changed or deleted', async () => {
    expect(filesIn(FIX).map((f) => [f.path, f.change])).toEqual([
      ['src/count.ts', 'modify'],
      ['test/count.test.ts', 'add'],
      ['old.ts', 'delete'],
    ]);
    const changes = await applyTo(FIX, read);
    expect(changes.deletions).toEqual(['old.ts']);
    expect(changes.additions.map((a) => [a.path, text(a.contents)])).toEqual([
      ['src/count.ts', 'export const count = (xs: unknown[]) => xs.length;\n'],
      ['test/count.test.ts', "it('counts', () => expect(count([1])).toBe(1));\n"],
    ]);
  });

  it('refuses what is not a plain text change, or does not apply', async () => {
    expect(() => filesIn('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')).toThrow(
      PatchRefused,
    );
    expect(() => filesIn('diff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts\n')).toThrow(PatchRefused);
    expect(() => filesIn('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n')).toThrow(PatchRefused);
    await expect(applyTo(FIX, async () => 'something else\n')).rejects.toThrow(/does not apply|already exists/);
  });

  it('commits through the API, reading the files at the head it goes on', async () => {
    const { github, sent } = client([
      {
        method: 'GET',
        path: /\/contents\//,
        answer: ({ path }) => {
          const file = decodeURIComponent(path.split('/contents/')[1]?.split('?')[0] ?? '');
          return BASE[file] === undefined
            ? { status: 404, body: { message: 'Not Found' } }
            : { body: { type: 'file', encoding: 'base64', content: Buffer.from(BASE[file] ?? '').toString('base64') } };
        },
      },
      {
        method: 'POST',
        path: '/graphql',
        answer: () => ({ body: { data: { createCommitOnBranch: { commit: { oid: 'c'.repeat(40) } } } } }),
      },
    ]);
    const oid = await new LiveActions(github).applyPatch(REPO, {
      branch: 'factory/1-cart',
      expectedHead: SHA,
      patch: FIX,
      message: 'fix: count',
    });
    expect(oid).toBe('c'.repeat(40));
    expect(
      calls(sent)
        .filter((s) => s.method === 'GET')
        .every((s) => s.path.endsWith(`?ref=${SHA}`)),
    ).toBe(true);
  });

  it('in a dry run, applies a second patch on top of the first commit it would have made', async () => {
    const records: unknown[] = [];
    const store = {
      put: async (bytes: Uint8Array) => {
        records.push(JSON.parse(text(bytes)));
        return String(records.length).padStart(64, 'd');
      },
    };
    const actions = new DryRunActions(
      store as never,
      quiet,
      () => new Date(),
      async (_repo, path) => BASE[path] ?? null,
    );
    const first = await actions.applyPatch(REPO, {
      branch: 'factory/1-cart',
      expectedHead: SHA,
      patch: FIX,
      message: 'fix: count',
    });
    const second = `--- a/src/count.ts
+++ b/src/count.ts
@@ -1 +1 @@
-export const count = (xs: unknown[]) => xs.length;
+export const count = (xs: readonly unknown[]) => xs.length;
`;
    await actions.applyPatch(REPO, {
      branch: 'factory/1-cart',
      expectedHead: first,
      patch: second,
      message: 'fix: count, round two',
    });
    const last = records.at(-1) as {
      args: { expectedHead: string; changes: { additions: { path: string; text: string }[] } };
    };
    expect(last.args.expectedHead).toBe(first);
    expect(last.args.changes.additions).toEqual([
      { path: 'src/count.ts', text: 'export const count = (xs: readonly unknown[]) => xs.length;\n' },
    ]);
  });
});

describe('what a patch may not do', () => {
  const header = (path: string, mode = '') =>
    `diff --git a/${path} b/${path}\n${mode}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;

  it('name a path that climbs out, or is absolute', () => {
    for (const path of ['src/../.github/workflows/x.yml', '/etc/passwd', 'src//x.ts', './x.ts']) {
      expect(() => filesIn(header(path)), path).toThrow(PatchRefused);
    }
  });

  it('name a path with a control character in it, as git quotes and escapes one', () => {
    for (const path of ['x\\ny.ts', 'x\\ty.ts', 'x\\001y.ts']) {
      const patch = `diff --git "a/${path}" "b/${path}"\n--- "a/${path}"\n+++ "b/${path}"\n@@ -1 +1 @@\n-a\n+b\n`;
      expect(() => filesIn(patch), path).toThrow(PatchRefused);
    }
    for (const path of ['x\ny.ts', 'x\ty.ts', 'x\u0001y.ts', 'x\u007fy.ts']) expect(plainPath(path), path).toBe(false);
  });

  it('add an executable, a symlink, or an empty file the fence would not see', () => {
    expect(() => filesIn(header('run.sh', 'new file mode 100755\n'))).toThrow('ordinary file');
    expect(() => filesIn(header('link', 'new file mode 120000\n'))).toThrow('ordinary file');
    expect(() => filesIn('diff --git a/empty.ts b/empty.ts\nnew file mode 100644\nindex 0000000..e69de29\n')).toThrow(
      /no change|changes nothing/,
    );
    expect(filesIn(header('fine.ts', 'new file mode 100644\n')).map((f) => f.path)).toEqual(['fine.ts']);
  });

  it('be anything but a unified diff, refused as the module refuses, not with the parser’s own error', () => {
    for (const patch of ['--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n-a\n', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n?b\n']) {
      expect(() => filesIn(patch), patch).toThrow(expect.objectContaining({ kind: 'unsupported' }));
    }
  });

  it('change lines it names no file for, or name a file and change no line of it', () => {
    expect(() => filesIn('@@ -1 +1 @@\n-a\n+b\n')).toThrow(expect.objectContaining({ kind: 'path' }));
    expect(() => filesIn('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n b\n')).toThrow('changes nothing');
    expect(() => filesIn('--- a/x\n+++ b/x\n@@ -0,0 +0,0 @@\n')).toThrow(PatchRefused);
  });

  it('name a file twice, so that its second change would be applied to the file without its first', () => {
    const change = (to: string) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+${to}\n`;
    expect(() => filesIn(change('b') + change('c'))).toThrow('more than once');
  });

  it('change a line twice, with hunks that overlap or come out of order', () => {
    const hunk = (at: number, from: string, to: string) => `@@ -${at} +${at} @@\n-${from}\n+${to}\n`;
    const patch = (...hunks: string[]) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n${hunks.join('')}`;
    expect(() => filesIn(patch(hunk(1, 'a', 'b'), hunk(1, 'a', 'b')))).toThrow('overlap or are out of order');
    expect(() => filesIn(patch(hunk(3, 'c', 'C'), hunk(1, 'a', 'A')))).toThrow('overlap or are out of order');
    const insert = '@@ -1,0 +2 @@\n+b\n';
    expect(() => filesIn(patch(insert, insert))).toThrow('overlap or are out of order');
    expect(filesIn(patch(hunk(1, 'a', 'A'), hunk(3, 'c', 'C'))).map((f) => f.path)).toEqual(['x']);
  });

  it('say one thing in git’s header and another in the lines under it', () => {
    const lines = '--- a/x\n+++ b/x\n@@ -1 +0,0 @@\n-a\n';
    expect(() => filesIn(`diff --git a/x b/x\ndeleted file mode 100644\n${lines}`)).toThrow('says otherwise');
    expect(() => filesIn(`diff --git a/evil b/evil\n${lines}`)).toThrow('says otherwise');
    const empty = 'diff --git a/e b/e\nnew file mode 100644\nindex 0000000..e69de29\n';
    const plain = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(() => filesIn(empty + plain('x') + plain('y'))).toThrow(PatchRefused);
  });

  it('be misread where a lone carriage return in a line looks as if it began one', () => {
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\rnew mode 100755\n';
    expect(filesIn(patch).map((f) => f.path)).toEqual(['x']);
  });

  it('delete a file that is not, at the commit, what it saw', async () => {
    const patch = 'diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
    expect((await applyTo(patch, async () => 'gone\n')).deletions).toEqual(['x']);
    for (const there of ['gone\nand more since\n', 'changed since\n']) {
      await expect(
        applyTo(patch, async () => there),
        there,
      ).rejects.toMatchObject({ kind: 'does-not-apply' });
    }
  });

  it('end a line otherwise than it says: what is committed keeps the patch’s line endings, not the file’s', async () => {
    const windows = async () => 'a\r\n';
    const changes = await applyTo('--- a/x\n+++ b/x\n@@ -1,0 +2 @@\n+b\n', windows);
    expect(changes.additions.map((a) => text(a.contents))).toEqual(['a\r\nb\n']);
    await expect(applyTo('--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n a\n+b\n', windows)).rejects.toMatchObject({
      kind: 'does-not-apply',
    });
  });

  it('change the workflows, the deployment, or a code-owned path, even in a dry run, whatever the line said', async () => {
    const files: Record<string, string> = {
      '.github/CODEOWNERS': '/Dockerfile @mrogan\n/src/money.ts @mrogan\n',
      'src/money.ts': 'old\n',
      Dockerfile: 'old\n',
    };
    const actions = new DryRunActions(
      { put: async () => 'e'.repeat(64) } as never,
      quiet,
      () => new Date(),
      async (_r, path) => files[path] ?? null,
    );
    const change = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
    for (const path of ['src/money.ts', 'Dockerfile']) {
      await expect(
        actions.applyPatch(REPO, { branch: 'factory/1-cart', expectedHead: SHA, patch: change(path), message: 'm' }),
      ).rejects.toMatchObject({ kind: 'protected' });
    }
    await expect(
      actions.applyPatch(REPO, {
        branch: 'factory/1-cart',
        expectedHead: SHA,
        patch: header('deploy/x.yaml'),
        message: 'm',
      }),
    ).rejects.toMatchObject({ kind: 'protected' });
  });

  it('change a file the API cannot send whole, or that is not text', async () => {
    const answers: Record<string, unknown> = {
      'big.ts': { type: 'file', encoding: 'none', content: '' },
      dir: [{ name: 'a' }],
      'latin1.ts': { type: 'file', encoding: 'base64', content: Buffer.from([0xe9, 0x0a]).toString('base64') },
    };
    const { github } = client([
      {
        method: 'GET',
        path: /\/contents\//,
        answer: ({ path }) => {
          const file = decodeURIComponent(path.split('/contents/')[1]?.split('?')[0] ?? '');
          return file in answers ? { body: answers[file] } : { status: 404, body: { message: 'Not Found' } };
        },
      },
    ]);
    const read = contentsReader(github);
    await expect(read(REPO, 'big.ts', SHA)).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(read(REPO, 'dir', SHA)).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(read(REPO, 'latin1.ts', SHA)).rejects.toThrow('not UTF-8');
    expect(await read(REPO, 'missing.ts', SHA)).toBeNull();
  });
});
