/**
 * The factory image holds only what its Dockerfile copies, with the production dependencies of the packages it
 * installs. A module the CLI reaches that is not in it fails only when a command reaches it in the cluster, so this
 * follows every import from `src/cli.ts` and `src/telemetry.ts`, the lazy ones too, as Node would run them in the
 * image: a type-only import is erased, so it loads nothing; anything else must be a file the image copies, a package
 * the importing package depends on, or Node's own.
 *
 * It reads the image's contents from the Dockerfile rather than building it, so it runs with the other tests and
 * needs no Docker, and it follows imports a command makes only when it runs, which loading each command would not.
 */
import { existsSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const DOCKERFILE = join(ROOT, 'apps/factory/Dockerfile');

/** What the image copies from the repository, as paths from its root. */
function copied(): string[] {
  return readFileSync(DOCKERFILE, 'utf8')
    .split('\n')
    .filter((line) => /^COPY\s/.test(line) && !line.includes('--from'))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
}

const inImage = (file: string, paths: string[]) => {
  const path = relative(ROOT, file);
  return paths.some((p) => path === p || path.startsWith(`${p.replace(/\/$/, '')}/`));
};

/** Each module specifier a file loads when Node runs it: its types stripped, as Node strips them. */
function specifiers(source: string): string[] {
  const code = stripTypeScriptTypes(source, { mode: 'strip' });
  const found: string[] = [];
  // Biome formats every static import and re-export to start its line, so a comment never matches.
  for (const match of code.matchAll(/^(?:import|export)\s(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm)) {
    found.push(match[1] as string);
  }
  for (const line of code.split('\n')) {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
    for (const match of line.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1] as string);
  }
  return found;
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  exports?: Record<string, string>;
}

/** The package a file belongs to: its nearest package.json, and where that is. */
function packageOf(file: string): { dir: string; manifest: Manifest } {
  let dir = dirname(file);
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return { dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest };
}

const WORKSPACE: Record<string, string> = {
  '@software-factory/events': 'packages/events',
  '@software-factory/store': 'packages/store',
  '@software-factory/triage': 'packages/triage',
  '@software-factory/factory': 'apps/factory',
};

/** Every problem with loading the CLI in the image: a file it does not hold, or a package nobody installs there. */
function walk(): { problems: string[]; loaded: string[] } {
  const paths = copied();
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = ['apps/factory/src/cli.ts', 'apps/factory/src/telemetry.ts'].map((f) => join(ROOT, f));
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!inImage(file, paths)) {
      found.push(`${relative(ROOT, file)} is not in the image`);
      continue;
    }
    if (!file.endsWith('.ts')) continue;
    const owner = packageOf(file);
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier));
        continue;
      }
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      const where = `${relative(ROOT, file)} imports ${specifier}`;
      if (name === undefined || !owner.manifest.dependencies?.[name]) {
        if (name !== owner.manifest.name) found.push(`${where}, which ${owner.manifest.name} does not depend on`);
        continue;
      }
      const workspace = WORKSPACE[name];
      if (!workspace) continue;
      const manifest = JSON.parse(readFileSync(join(ROOT, workspace, 'package.json'), 'utf8')) as Manifest;
      const target = manifest.exports?.[`.${specifier.slice(name.length)}`];
      if (!target) found.push(`${where}, which ${name} does not export`);
      else queue.push(join(ROOT, workspace, target));
    }
  }
  return { problems: found, loaded: [...seen].map((file) => relative(ROOT, file)) };
}

describe('the factory image', () => {
  it('holds every module the CLI loads, the lazy ones too', () => {
    const { problems, loaded } = walk();
    expect(problems).toEqual([]);
    // It reached the line's worker, which `factory line serve` imports only once it runs.
    expect(loaded).toContain('apps/factory/src/line/worker.ts');
    expect(loaded).toContain('packages/events/src/schemas.ts');
  });

  it('finds the imports Node runs, and not the ones it erases', () => {
    const source = [
      "import type { Step } from '../../runner/src/step.ts';",
      "import { type Handback, RESULT_BYTES } from '../../runner/src/limits.ts';",
      "import { z } from 'zod';",
      "export * from './more.ts';",
      '/** Lazily, as in `await import("./not-this.ts")`. */',
      "const { Line } = await import('../line/worker.ts');",
    ].join('\n');
    expect(specifiers(source)).toEqual(['../../runner/src/limits.ts', 'zod', './more.ts', '../line/worker.ts']);
  });
});
