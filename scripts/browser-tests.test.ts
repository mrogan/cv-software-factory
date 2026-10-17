import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A pull request that changes only files under deploy/ skips the browser tests (check.yml's `manifests` kind), since
 * nothing they run reads from there. This keeps that true, for code added later too.
 *
 * What they run is found from where check.yml's browser jobs start: the console's build (Vite's config and the page it
 * builds), its Playwright tests (the config, the spec files and the server it starts) and the vitest `browser`
 * project's files. From there every file they import, a page's scripts and a stylesheet's imports, is followed through
 * the workspace's packages, so a new file, helper or package is covered the day it is used; third-party packages are
 * not followed. A file reads from deploy/ if its code, outside comments, names a path there, or `deploy` and one of
 * its folders as `join(…, 'deploy', 'base')` would.
 *
 * But for one file: CI runs the console's browser tests beside the Postgres its StatefulSet pins, and the live test's
 * own Postgres reads the same pin. The `manifests` kind leaves a change to it as `code`, so that is allowed, and
 * nothing else.
 */
const POSTGRES = 'deploy/base/postgres/statefulset.yaml';

const CHECK = '.github/workflows/check.yml';
const CONSOLE = 'apps/console';

const tracked = new Set(execFileSync('git', ['ls-files'], { encoding: 'utf-8' }).split('\n').filter(Boolean));
const read = (file: string) => readFileSync(file, 'utf-8');

/** The workspace's packages, each export of each by its specifier, as a file. */
function workspace() {
  const specifiers = new Map<string, string>();
  for (const manifest of [...tracked].filter((file) => /^(apps|packages)\/[^/]+\/package\.json$/.test(file))) {
    const { name, exports } = JSON.parse(read(manifest)) as { name: string; exports?: string | Record<string, string> };
    const entries = typeof exports === 'string' ? { '.': exports } : (exports ?? {});
    for (const [path, target] of Object.entries(entries)) {
      specifiers.set(posix.join(name, path), posix.join(dirname(manifest), target));
    }
  }
  return specifiers;
}

const packages = workspace();

/** The tracked file a specifier names from a file, if it is in the repository. */
function resolve(from: string, specifier: string): string | undefined {
  const bare = specifier.replace(/[?#].*$/, '');
  if (!bare.startsWith('.')) return packages.get(bare);
  const path = posix.normalize(posix.join(posix.dirname(from), bare));
  return [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`].find((candidate) => tracked.has(candidate));
}

/** What a file imports, loads or includes. */
function references(file: string, text: string) {
  const patterns = file.endsWith('.html')
    ? [/\b(?:src|href)="([^"]+)"/g]
    : file.endsWith('.css')
      ? [/@import\s+(?:url\()?['"]([^'"]+)['"]/g]
      : [/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map(([, specifier = '']) => specifier));
}

/** Every file reached from the entry points. */
function closure(entries: string[]) {
  const reached = new Set<string>();
  const stack = [...entries];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    if (!/\.(ts|tsx|js|mjs|html|css)$/.test(file)) continue;
    for (const specifier of references(file, read(file))) {
      const target = resolve(file, specifier);
      if (target) stack.push(target);
    }
  }
  return [...reached].sort();
}

/** deploy/'s own folders, as `join(…, 'deploy', 'base')` would name one. */
const folders = [...new Set([...tracked].flatMap((file) => file.match(/^deploy\/([^/]+)\//)?.[1] ?? []))];

/**
 * The places under deploy/ a file names, outside its comments: as a path, or as `deploy` and one of its folders, side
 * by side. A comment opens a line, so a glob's `/*` inside a string is not taken for one.
 */
function deployPaths(text: string) {
  const code = text
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*(\/\/|#).*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const parts = new RegExp(`['"\`]deploy['"\`]\\s*,\\s*['"\`](${folders.join('|')})['"\`]`, 'g');
  return [
    ...[...code.matchAll(/(?<![\w-])deploy\/[\w./*-]*/g)].map(([path]) => path),
    ...[...code.matchAll(parts)].map(([, folder]) => `deploy/${folder}`),
  ];
}

/** Where check.yml's browser tests start. */
function entries() {
  const config = read('vitest.config.ts');
  const browser = config.match(/name: 'browser',[\s\S]*?include: \[([^\]]*)\]/)?.[1] ?? '';
  const globs = [...browser.matchAll(/'([^']+)'/g)].map(([, glob = '']) => glob);
  const playwright = read(`${CONSOLE}/playwright.config.ts`);
  const testDir = playwright.match(/testDir: '([^']+)'/)?.[1] ?? '';
  const servers = [...playwright.matchAll(/command: 'node ([^']+)'/g)].map(([, script = '']) => `${CONSOLE}/${script}`);
  const root = read(`${CONSOLE}/vite.config.ts`).match(/root: '([^']+)'/)?.[1] ?? '';
  return {
    vitest: ['vitest.config.ts', ...[...tracked].filter((file) => globs.some((glob) => matchesGlob(file, glob)))],
    playwright: [
      `${CONSOLE}/playwright.config.ts`,
      ...[...tracked].filter((file) => file.startsWith(`${CONSOLE}/${testDir}/`) && file.endsWith('.ts')),
      ...servers,
    ],
    vite: [`${CONSOLE}/vite.config.ts`, `${CONSOLE}/${root}/index.html`],
  };
}

/** check.yml's jobs, each by its id, as written. */
function jobs() {
  const workflow = read(CHECK);
  const body = workflow.slice(workflow.indexOf('\njobs:\n'));
  return new Map(
    [...body.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\s*\n|\s*#.*\n)*)/gm)].map(([, id = '', job = '']) => [id, job]),
  );
}

const BROWSER_JOBS = ['console-browser', 'senses-browser', 'browser'];

describe('what the browser tests run', () => {
  const start = entries();
  const files = closure(Object.values(start).flat());

  it('is found from where they start', () => {
    expect(start.vitest).toEqual(expect.arrayContaining(['apps/factory/test/browser/probes.test.ts']));
    expect(start.playwright).toEqual(
      expect.arrayContaining(['apps/console/e2e/live.spec.ts', 'apps/console/src/server.ts']),
    );
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/console/web/src/main.tsx',
        'apps/factory/src/probes/index.ts',
        'packages/events/src/index.ts',
        'packages/store/test/postgres.ts',
      ]),
    );
  });

  it('reads nothing under deploy/ but the Postgres pin', () => {
    const reads = files.flatMap((file) =>
      deployPaths(read(file))
        .filter((path) => path !== POSTGRES)
        .map((path) => `${file}: ${path}`),
    );
    expect(reads).toEqual([]);
  });

  it('would be read as reading deploy/ for a path there, or deploy and a folder side by side, but not in a comment', () => {
    const text = [
      "const a = new URL('../../deploy/base/x.yaml', import.meta.url);",
      "const b = join(ROOT, 'deploy', 'overlays', 'local');",
      '/** The steps are in `deploy/base/analysis`. */',
      '  // deploy/overlays/local',
      "const c = ['release', 'deploy', 'verify'];",
      "const d = 'deployment/x';",
    ].join('\n');
    expect(deployPaths(text)).toEqual(['deploy/base/x.yaml', 'deploy/overlays']);
  });

  it('is what check.yml runs: no other step, and no other image from the kind job', () => {
    const all = jobs();
    const browser = BROWSER_JOBS.map((id) => all.get(id) ?? '');
    expect(browser.every(Boolean)).toBe(true);
    const runs = browser.flatMap((job) => [...job.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map(([, run = '']) => run));
    expect(new Set(runs)).toEqual(
      new Set([
        'corepack enable && pnpm install --frozen-lockfile --ignore-scripts',
        'pnpm --filter @software-factory/console build',
        'pnpm exec playwright test $TESTS',
        'pnpm exec vitest run --project browser',
        '|',
      ]),
    );
    expect(browser.flatMap(deployPaths)).toEqual([]);
    const outputs = new Set(
      browser.flatMap((job) => [...job.matchAll(/needs\.kind\.outputs\.(\w+)/g)].map(([, o]) => o)),
    );
    expect(outputs).toEqual(new Set(['kind', 'postgres', 'playwright']));
    // Those two images: the Postgres from its pin, by ci-images.sh, and Playwright's from Dockerfile.browser.
    const kind = all.get('kind') ?? '';
    expect(kind).toContain('echo "image=$(scripts/ci-images.sh postgres)"');
    expect(kind.match(/- id: playwright\n\s+run: (.+)/)?.[1]).toContain('apps/factory/Dockerfile.browser');
  });
});

describe("the manifests kind's exception", () => {
  it('is the file the Postgres beside the browser tests is pinned in', () => {
    const file = read('scripts/ci-images.sh').match(/grep -oE "\$PIN" (\S+)/)?.[1];
    expect(file).toBe(POSTGRES);
    expect(read(CHECK)).toContain(`grep -qxF '${POSTGRES}'`);
  });

  it('names a file that is there', () => {
    expect(tracked.has(join(POSTGRES))).toBe(true);
  });
});
