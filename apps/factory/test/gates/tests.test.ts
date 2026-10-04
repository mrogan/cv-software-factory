import { describe, expect, it } from 'vitest';
import { newIn } from '../../src/gates/image-scan.ts';
import { compare } from '../../src/gates/integrity.ts';
import { compareJourneys, type Seen, summary } from '../../src/gates/journeys.ts';
import { testsIn } from '../../src/gates/tests.ts';
import { changedTests, outcomes } from '../../src/gates/tests-first.ts';

const FILE = `import { describe, expect, it } from 'vitest';

// A comment that ends with a full stop.
describe('cart', () => {
  const pattern = /\\(it\\(/; // a regular expression with parentheses in it
  it('counts items', () => {
    expect(count([1, 2])).toBe(2);
    expect(\`\${count([])} items\`).toBe('0 items');
  });
  it.each([[1, 'one']])('names %i as %s', (n, name) => {
    expect(name).toBe(words(n));
  });
  it.skip('rounds pence', () => {
    assert.equal(round(1.005), 1.01);
  });
  describe.skip('later', () => {
    test('discounts', () => {});
  });
  it.todo('refunds');
  thing.test('not a test', () => {});
});
`;

describe('reading tests', () => {
  it('finds each test with its describe blocks, what disables it, and its assertions', () => {
    expect(testsIn(FILE).map(({ source: _, ...t }) => t)).toEqual([
      { name: 'cart > counts items', disabled: false, assertions: 2 },
      { name: 'cart > names %i as %s', disabled: false, assertions: 1 },
      { name: 'cart > rounds pence', disabled: 'skip', assertions: 1 },
      { name: 'cart > later > discounts', disabled: 'skip', assertions: 0 },
      { name: 'cart > refunds', disabled: 'todo', assertions: 0 },
    ]);
  });

  it('is not fooled by test-like text in strings, comments and templates', () => {
    const source = `it('real', () => {
      const s = "it('fake', () => { expect(1) })";
      // it('commented', () => {})
      const t = \`\${"it('in a template')"} expect(\`;
      expect(s).toBeTruthy();
    });`;
    expect(testsIn(source).map((t) => [t.name, t.assertions])).toEqual([['real', 1]]);
  });
});

describe('test integrity', () => {
  const base = new Map([
    ['test/cart.test.ts', FILE],
    [
      'test/money.test.ts',
      `it('adds', () => { expect(1).toBe(1); expect(2).toBe(2); });\nit('subtracts', () => { expect(0).toBe(0); });`,
    ],
    ['test/old.test.ts', `it('moves', () => { expect(1).toBe(1); });`],
  ]);

  it('passes added tests and assertions, and a test that moved file', () => {
    const change = new Map(base);
    change.delete('test/old.test.ts');
    change.set(
      'test/new.test.ts',
      `it('moves', () => { expect(1).toBe(1); });\nit('is new', () => { expect(1).toBe(1); });`,
    );
    change.set(
      'test/money.test.ts',
      `${base.get('test/money.test.ts')}\nit('multiplies', () => { expect(1).toBe(1); });`,
    );
    const { problems, added } = compare(base, change);
    expect(problems).toEqual([]);
    expect(added.map((a) => a.test).sort()).toEqual(['is new', 'multiplies']);
  });

  it('fails a deleted file, a deleted test, a skipped one, fewer assertions and .only', () => {
    const change = new Map(base);
    change.delete('test/old.test.ts');
    change.set('test/money.test.ts', `it('adds', () => { expect(1).toBe(1); });`);
    change.set(
      'test/cart.test.ts',
      FILE.replace("it('counts items'", "it.only('counts items'").replace('it.each(', 'it.skip.each('),
    );
    expect(compare(base, change).problems.map((p) => p.message)).toEqual([
      '"cart > counts items" is narrowed with .only, which skips every other test in its file',
      '"cart > names %i as %s" is skipped',
      '"adds" has 1 assertion, down from 2',
      '"subtracts" was deleted',
      'test/old.test.ts was deleted, with its 1 test',
    ]);
  });
});

describe('tests first', () => {
  const base = new Map([['test/a.test.ts', `it('old', () => { expect(1).toBe(1); });`]]);
  const change = new Map([
    ['test/a.test.ts', `it('old', () => { expect(1).toBe(1); });\nit('new %s', () => { expect(2).toBe(2); });`],
    ['test/support/helper.ts', 'export const x = 1;'],
  ]);

  it('copies what changed in test folders, and looks for the new and changed tests only', () => {
    const { copy, manifest } = changedTests(base, change);
    expect(copy).toEqual(['test/a.test.ts', 'test/support/helper.ts']);
    expect(manifest).toEqual({
      root: '',
      files: ['test/a.test.ts'],
      tests: [{ file: 'test/a.test.ts', name: 'new %s' }],
    });
  });

  it('reads Vitest’s results, filling in placeholders, and a file that would not load as failed', () => {
    const manifest = {
      root: '/work/base',
      files: ['test/a.test.ts', 'test/b.test.ts'],
      tests: [
        { file: 'test/a.test.ts', name: 'new %s' },
        { file: 'test/a.test.ts', name: 'other' },
        { file: 'test/b.test.ts', name: 'needs a new helper' },
      ],
    };
    const results = {
      testResults: [
        {
          name: '/work/base/test/a.test.ts',
          status: 'failed',
          assertionResults: [
            { ancestorTitles: [], title: 'new thing', status: 'failed' },
            { ancestorTitles: [], title: 'other', status: 'passed' },
          ],
        },
        { name: '/work/base/test/b.test.ts', status: 'failed', message: 'Cannot find module', assertionResults: [] },
      ],
    };
    expect(outcomes(manifest, results).map((o) => o.outcome)).toEqual(['failed', 'passed', 'failed']);
  });
});

describe('journeys', () => {
  const seen = (check: string, failed: boolean, trouble?: string): Seen => ({
    sense: 'probe',
    check,
    route: '/',
    failed,
    ...(trouble ? { trouble } : {}),
  });

  it('fails only on what passes on the base and fails on the change twice', async () => {
    const runs: Record<string, Seen[][]> = {
      base: [
        [
          seen('broken', true),
          seen('fine', false),
          seen('regressed', false),
          seen('flaky', false),
          seen('unsure', false, 'timed out'),
          seen('fixed', true),
        ],
      ],
      change: [
        [
          seen('broken', true),
          seen('fine', false),
          seen('regressed', true),
          seen('flaky', true),
          seen('unsure', true),
          seen('fixed', false),
          seen('new page', true),
        ],
        [
          seen('broken', true),
          seen('fine', false),
          seen('regressed', true),
          seen('flaky', false),
          seen('unsure', true),
          seen('fixed', false),
          seen('new page', true),
        ],
      ],
    };
    const observed: string[] = [];
    const c = await compareJourneys(
      async (app) => {
        observed.push(app);
        return runs[app]?.shift() ?? [];
      },
      'base',
      'change',
    );
    expect(observed).toEqual(['base', 'change', 'change']);
    expect(c.regressions.map((s) => s.check)).toEqual(['regressed', 'new page']);
    expect(c.flaky.map((s) => s.check)).toEqual(['flaky']);
    expect(c.unsure.map((s) => s.check)).toEqual(['unsure']);
    expect(c.unchanged.map((s) => s.check)).toEqual(['broken']);
    expect(c.fixed.map((s) => s.check)).toEqual(['fixed']);
    expect(summary(c)).toMatch(/^## Journeys\n\n2 checks that pass on the base fail on this change, twice\./);
  });

  it('runs the change once when nothing new fails', async () => {
    let calls = 0;
    const c = await compareJourneys(
      async () => {
        calls++;
        return [seen('broken', true)];
      },
      'base',
      'change',
    );
    expect(calls).toBe(2);
    expect(c.regressions).toEqual([]);
  });
});

describe('image scan', () => {
  const report = (...v: [string, string, string, string][]) => ({
    Results: [
      {
        Target: 'app',
        Vulnerabilities: v.map(([id, pkg, version, severity]) => ({
          VulnerabilityID: id,
          PkgName: pkg,
          InstalledVersion: version,
          Severity: severity,
        })),
      },
    ],
  });

  it('fails on a high or critical vulnerability the change brings in, and not on one the base has', () => {
    const base = report(['CVE-1', 'openssl', '3.0', 'CRITICAL'], ['CVE-2', 'zlib', '1.2', 'LOW']);
    const change = report(
      ['CVE-1', 'openssl', '3.1', 'CRITICAL'],
      ['CVE-3', 'left-pad', '1.0', 'HIGH'],
      ['CVE-4', 'tar', '6', 'MEDIUM'],
    );
    const { added, failing, removed } = newIn(base, change);
    expect(added.map((v) => v.VulnerabilityID)).toEqual(['CVE-3', 'CVE-4']);
    expect(failing.map((v) => v.VulnerabilityID)).toEqual(['CVE-3']);
    expect(removed.map((v) => v.VulnerabilityID)).toEqual(['CVE-2']);
  });
});

describe('journeys, when a check cannot finish on the change', () => {
  const seen = (check: string, failed: boolean, trouble?: string): Seen => ({
    sense: 'probe',
    check,
    route: '/',
    failed,
    ...(trouble ? { trouble } : {}),
  });

  it('fails the gate when it passed on the base and could not finish on the change, twice', async () => {
    const runs: Seen[][] = [
      [seen('buy', false), seen('search', false)],
      [seen('buy', false, 'the button to click is not there'), seen('search', false, 'timed out')],
      [seen('buy', false, 'the button to click is not there'), seen('search', false)],
    ];
    const c = await compareJourneys(async () => runs.shift() ?? [], 'base', 'change');
    expect(c.regressions.map((s) => [s.check, s.trouble])).toEqual([['buy', 'the button to click is not there']]);
    expect(c.flaky.map((s) => s.check)).toEqual(['search']);
    expect(summary(c)).toContain('the button to click is not there');
  });
});

describe('the gates’ scripts, end to end', () => {
  const dirs = async (files: Record<string, string>) => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'gate-'));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    return dir;
  };

  it('test integrity: duplicate names in one file, a test added skipped, and one deleted', async () => {
    const { main } = await import('../../src/gates/test-integrity.ts');
    const twice = `describe('a', () => { it('x', () => { expect(1).toBe(1); }); });\ndescribe('b', () => { it('x', () => { expect(1).toBe(1); }); });`;
    const base = await dirs({ 'test/a.test.ts': twice });
    const kept = await dirs({ 'test/a.test.ts': `${twice}\nit.skip('later', () => {});` });
    const lost = await dirs({ 'test/a.test.ts': `describe('a', () => { it('x', () => { expect(1).toBe(1); }); });` });
    const output: string[] = [];
    const log = console.log;
    console.log = (line: string) => void output.push(line);
    try {
      expect(await main([base, kept])).toBe(0);
      expect(output.join('\n')).toContain('"later" was added, but is skipped');
      expect(await main([base, lost])).toBe(1);
      expect(output.join('\n')).toContain('"b > x" was deleted');
    } finally {
      console.log = log;
    }
  });

  it('image scan: a report with no results is no vulnerability, new or old', async () => {
    const { main } = await import('../../src/gates/image-scan.ts');
    const dir = await dirs({
      'base.json': '{}',
      'change.json': '{"Results":[{"Target":"app","Vulnerabilities":null}]}',
    });
    const log = console.log;
    console.log = () => {};
    try {
      expect(await main([`${dir}/base.json`, `${dir}/change.json`])).toBe(0);
    } finally {
      console.log = log;
    }
  });

  it('tests first: a result is a file’s by its exact path from the checkout', () => {
    const manifest = { root: '/work/base', files: ['test/a.test.ts'], tests: [{ file: 'test/a.test.ts', name: 'x' }] };
    const elsewhere = {
      testResults: [
        {
          name: '/work/base/src/test/a.test.ts',
          status: 'failed',
          assertionResults: [{ ancestorTitles: [], title: 'x', status: 'failed' }],
        },
      ],
    };
    expect(outcomes(manifest, elsewhere).map((o) => o.outcome)).toEqual(['did not run']);
  });
});
