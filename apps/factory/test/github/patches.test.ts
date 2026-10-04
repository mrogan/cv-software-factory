import { describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { applyTo, filesIn, PatchRefused } from '../../src/github/patches.ts';
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
            : { body: { content: Buffer.from(BASE[file] ?? '').toString('base64') } };
        },
      },
      {
        method: 'POST',
        path: '/graphql',
        answer: () => ({ body: { data: { createCommitOnBranch: { commit: { oid: 'c'.repeat(40) } } } } }),
      },
    ]);
    const oid = await new LiveActions(github).applyPatch(REPO, {
      branch: 'fix/1',
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
      branch: 'fix/1',
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
      branch: 'fix/1',
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
