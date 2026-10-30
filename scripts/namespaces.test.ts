import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * The Makefile makes a namespace before it writes a Secret there, and Argo CD makes the same namespaces from
 * deploy/base/namespaces.yaml, each with its pod security label. Applying a bare Namespace over one of those takes the
 * label away, and pods there are admitted without the restricted profile until Argo CD syncs it again, so the Makefile
 * makes a namespace only when there is none, and never writes to one that exists.
 */

/** The Makefile's `namespace` helper, run by make itself against a kubectl that logs each call. */
async function namespace(cluster: 'has it' | 'has none' | 'cannot be read', createFails = false) {
  const dir = await mkdtemp(join(tmpdir(), 'namespace-'));
  const log = join(dir, 'calls');
  const kubectl = join(dir, 'kubectl');
  await writeFile(
    kubectl,
    `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(log)}
case "$1" in
  get) ${{ 'has it': 'echo namespace/factory', 'has none': 'exit 0', 'cannot be read': 'echo "Unable to connect to the server" >&2; exit 1' }[cluster]} ;;
  create) ${createFails ? 'echo "Unable to connect to the server" >&2; exit 1' : 'echo "namespace/$3 created"'} ;;
esac
`,
  );
  await chmod(kubectl, 0o755);
  const makefile = join(dir, 'Makefile');
  await writeFile(makefile, `include ${join(process.cwd(), 'Makefile')}\nns:\n\t@$(call namespace,factory)\n`);
  // Not the outer make's flags (`make check` runs the tests), which would have this one talk about directories and jobs.
  const { MAKEFLAGS, MFLAGS, MAKELEVEL, ...env } = process.env;
  try {
    const result = await promisify(execFile)('make', ['-s', '-f', makefile, `KUBECTL=${kubectl}`, 'ns'], { env }).then(
      ({ stdout, stderr }) => ({ code: 0, out: stdout + stderr }),
      (e: { code: number | string; stdout?: string; stderr?: string }) => {
        if (typeof e.code === 'string') throw e; // make itself did not run
        return { code: e.code, out: `${e.stdout}${e.stderr}` };
      },
    );
    const calls = (await readFile(log, 'utf-8')).trim().split('\n');
    return { ...result, calls };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('making a namespace from the Makefile', () => {
  it('leaves one that exists alone, and says nothing', async () => {
    expect(await namespace('has it')).toEqual({
      code: 0,
      out: '',
      calls: ['get namespace factory -o name --ignore-not-found'],
    });
  });

  it('creates one that is missing, and says nothing', async () => {
    expect(await namespace('has none')).toEqual({
      code: 0,
      out: '',
      calls: ['get namespace factory -o name --ignore-not-found', 'create namespace factory'],
    });
  });

  it('fails, and says why, when it can make none', async () => {
    const { code, out } = await namespace('has none', true);
    expect(code).not.toBe(0);
    expect(out).toContain('Unable to connect to the server');
  });

  it('creates none, and stops, when it cannot tell whether there is one', async () => {
    const { code, out, calls } = await namespace('cannot be read');
    expect(code).not.toBe(0);
    expect(out).toContain('Unable to connect to the server');
    expect(calls).toEqual(['get namespace factory -o name --ignore-not-found']);
  });

  it('is the only way the Makefile, the scripts and the skills make one', () => {
    const files = [
      'Makefile',
      ...['scripts', ...readdirSync('.claude/skills').map((skill) => `.claude/skills/${skill}/bin`)]
        .filter((dir) => existsSync(dir))
        .flatMap((dir) => readdirSync(dir, { withFileTypes: true }).map((f) => `${dir}/${f.name}`))
        .filter((f) => statSync(f).isFile() && !f.endsWith('.test.ts')),
    ];
    for (const file of files) {
      // Continued lines joined, so a pipe on the next line is seen.
      const lines = readFileSync(file, 'utf-8').replaceAll('\\\n', ' ').split('\n');
      const made = lines.filter((line) => /create (namespace|ns)\b/.test(line) && !line.startsWith('namespace = '));
      expect(made, file).toEqual([]);
      const applied = lines.filter((line) => /kind:\s*Namespace/.test(line) && /apply/.test(line));
      expect(applied, file).toEqual([]);
    }
  });
});
