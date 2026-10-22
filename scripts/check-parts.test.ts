import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * CI runs `make check` in parts on runners of their own (check.yml), and the one check the ruleset requires of it
 * passes only when they all did. A part `make check` gains and CI does not run would be checked on the laptop only.
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
    expect(makefile).toMatch(
      /^\tpnpm exec vitest run --project unit --project database \$\(if \$\(SHARD\),--shard \$\(SHARD\)\)$/m,
    );
  });

  it('passes the required check only when every part passed, and runs it when one failed', () => {
    const check = jobs.get('check') ?? '';
    expect(check).toMatch(/^ {4}name: lint, types, tests$/m);
    expect(check).toMatch(/^ {4}needs: \[static, tests\]$/m);
    // Otherwise a part that failed, or a run cancelled, would skip the check, and a skipped job counts as passed.
    expect(check).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m);
    expect(check).toContain('[ "$STATIC" = success ] && [ "$TESTS" = success ]');
  });
});
