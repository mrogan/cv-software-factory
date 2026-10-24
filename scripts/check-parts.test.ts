import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CI runs `make check` in parts on runners of their own (check.yml), and the one check the ruleset requires of it
 * passes only when they all did. If `make check` gained a part that CI did not run, that part would be checked on the
 * laptop only.
 */
const workflow = readFileSync('.github/workflows/check.yml', 'utf-8');
const makefile = readFileSync('Makefile', 'utf-8');

/** check.yml's jobs, each by its id, as written. */
const jobs = new Map(
  [...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\s*\n|\s*#.*\n)*)/gm)].map(
    ([, id = '', job = '']) => [id, job],
  ),
);

describe('make check in CI', () => {
  it('runs every part of make check, and nothing else of make', () => {
    const parts = makefile.match(/^check: ([\w -]+?) ##/m)?.[1]?.split(' ') ?? [];
    expect(parts).toEqual(['check-static', 'check-tests']);
    const made = [...workflow.matchAll(/run: make (\S+)/g)].map(([, target]) => target);
    expect(made.sort()).toEqual(parts);
  });

  it('runs every shard of the tests', () => {
    const shards =
      jobs
        .get('tests')
        ?.match(/shard: \[([^\]]*)\]/)?.[1]
        ?.split(', ') ?? [];
    expect(shards.length).toBeGreaterThan(1);
    expect(shards).toEqual(shards.map((_, i) => `${i + 1}/${shards.length}`));
    expect(jobs.get('tests')).toMatch(
      /run: make check-tests SHARD="\$SHARD"\n\s+env:\n\s+SHARD: \$\{\{ matrix\.shard \}\}/,
    );
    // `make check` runs every shard, even with SHARD in the environment.
    expect(makefile).toMatch(/^check: override SHARD :=$/m);
    expect(makefile).toMatch(
      /^\tpnpm exec vitest run --project unit --project database \$\(if \$\(SHARD\),--shard \$\(SHARD\)\)$/m,
    );
  });

  it('runs the required check whatever its parts did, a cancelled run included', () => {
    const check = jobs.get('check') ?? '';
    expect(check).toMatch(/^ {4}name: lint, types, tests$/m);
    expect(check).toMatch(/^ {4}needs: \[kind, static, tests\]$/m);
    // Otherwise a part that failed, or a run cancelled, would skip the check, and a skipped job counts as passed.
    expect(check).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m);
    // The tests are skipped for a release and nothing else.
    expect(jobs.get('tests')).toMatch(
      /^ {4}if: \$\{\{ !cancelled\(\) && needs\.kind\.outputs\.kind != 'release' \}\}$/m,
    );
  });
});

/** The required check's script, run with its parts' results, and `gh` answering as main's run of it would. */
function required(
  env: { KIND: string; STATIC: string; TESTS: string; BASE?: string },
  main: { run?: string; state?: string; fails?: number } = {},
) {
  const script = jobs.get('check')?.match(/run: \|\n((?: {10}.*\n|\s*\n)+)/)?.[1] ?? '';
  expect(script).not.toBe('');
  const bin = mkdtempSync(join(tmpdir(), 'check-'));
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // GH_FAILS: how many calls fail before it answers, as one would when GitHub's API does.
  stub(
    'gh',
    [
      'calls=$(($(cat "$0.calls" 2>/dev/null || echo 0) + 1)); echo "$calls" > "$0.calls"',
      '[ "$calls" -gt "$GH_FAILS" ] || exit 1',
      'case "$*" in *"/jobs"*) printf %s "$MAIN_STATE" ;; *) printf %s "$MAIN_RUN" ;; esac',
    ].join('\n'),
  );
  stub('sleep', 'exit 0');
  // At most five tries at main's run, not the script's 72: enough to outlast GH_FAILS and then give up, without the
  // hundreds of processes 72 tries start, which made a test take seconds on a busy machine. Fewer, if the script asks
  // for fewer.
  stub('seq', 'n=$(($1 < 5 ? $1 : 5)); i=1; while [ "$i" -le "$n" ]; do echo "$i"; i=$((i + 1)); done');
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'mrogan/cv-software-factory',
      BASE: 'abc123',
      MAIN_RUN: main.run ?? '',
      MAIN_STATE: main.state ?? '',
      GH_FAILS: String(main.fails ?? 0),
      ...env,
    },
    encoding: 'utf-8',
  });
  rmSync(bin, { recursive: true });
  return result.status;
}

describe('the required check', () => {
  it.each(['failure', 'cancelled', 'skipped'])('fails a pull request when a part of its tests was %s', (tests) => {
    expect(required({ KIND: 'code', STATIC: 'success', TESTS: tests })).toBe(1);
    expect(required({ KIND: 'deploy', STATIC: 'success', TESTS: tests })).toBe(1);
  });

  it('fails any pull request whose static half did not pass, a release too', () => {
    expect(required({ KIND: 'code', STATIC: 'failure', TESTS: 'success' })).toBe(1);
    const passed = { run: '42', state: 'completed success' };
    expect(required({ KIND: 'release', STATIC: 'cancelled', TESTS: 'skipped' }, passed)).toBe(1);
  });

  it('passes a pull request whose parts all passed', () => {
    expect(required({ KIND: 'code', STATIC: 'success', TESTS: 'success' })).toBe(0);
  });

  it('passes a release only once main has passed it on the commit the release is made on', () => {
    const release = { KIND: 'release', STATIC: 'success', TESTS: 'skipped' };
    expect(required(release, { run: '42', state: 'completed success' })).toBe(0);
    expect(required(release, { run: '42', state: 'completed failure' })).toBe(1);
    expect(required(release, { run: '42', state: 'completed cancelled' })).toBe(1);
    // Never finished, or never ran: it gives up, failed.
    expect(required(release, { run: '42', state: 'in_progress null' })).toBe(1);
    expect(required(release)).toBe(1);
    expect(required({ ...release, BASE: '' }, { run: '42', state: 'completed success' })).toBe(1);
  });

  it("asks again when GitHub's API fails", () => {
    const release = { KIND: 'release', STATIC: 'success', TESTS: 'skipped' };
    expect(required(release, { run: '42', state: 'completed success', fails: 3 })).toBe(0);
  });
});
