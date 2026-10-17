import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A pull request that changes only files under deploy/ builds no image in its checks (check.yml's `manifests` kind):
 * the images it would build are main's, since no Dockerfile copies anything from there. This keeps that true, for
 * every Dockerfile in the repository, a new one included.
 *
 * What a Dockerfile takes from its build context: each source of a COPY or ADD, and each bind mount of a RUN, but for
 * those that take from another stage or image (`--from`, `from=`), from a URL, or from a heredoc. The context's root,
 * or a pattern at its root, could take deploy/ with it, so it counts as taking it.
 */
function contextSources(dockerfile: string): string[] {
  const instructions = dockerfile
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const sources: string[] = [];
  for (const instruction of instructions) {
    const [, keyword = '', rest = ''] = instruction.match(/^(\S+)\s*(.*)$/) ?? [];
    const words = rest.split(/\s+/).filter(Boolean);
    const flags = words.filter((word) => word.startsWith('--'));
    switch (keyword.toUpperCase()) {
      case 'COPY':
      case 'ADD': {
        if (flags.some((flag) => flag.startsWith('--from='))) break;
        const args = rest.replace(/^(--\S+\s+)*/, '');
        const paths: string[] = args.startsWith('[') ? JSON.parse(args) : args.split(/\s+/);
        sources.push(...paths.slice(0, -1).filter((path) => !path.startsWith('<<') && !/^[a-z]+:\/\//.test(path)));
        break;
      }
      case 'RUN':
        for (const flag of flags.filter((flag) => flag.startsWith('--mount='))) {
          const options = new Map(
            flag
              .slice('--mount='.length)
              .split(',')
              .map((option) => [option.split('=')[0], option.split('=').slice(1).join('=')] as const),
          );
          if ((options.get('type') ?? 'bind') === 'bind' && !options.has('from')) {
            sources.push(options.get('source') ?? options.get('src') ?? '.');
          }
        }
        break;
    }
  }
  return sources;
}

/** Whether a source can take anything under deploy/. */
function takesDeploy(source: string) {
  const [first = ''] = source.replace(/^(\.?\/)+/, '').split('/');
  return first === '' || first === '.' || matchesGlob('deploy', first);
}

const dockerfiles = execFileSync('git', ['ls-files', '--', ':(glob)**/Dockerfile', ':(glob)**/Dockerfile.*'], {
  encoding: 'utf-8',
})
  .split('\n')
  .filter((file) => file && !file.endsWith('.dockerignore'));

describe('the Dockerfiles', () => {
  it('are found', () => {
    expect(dockerfiles).toEqual(
      expect.arrayContaining([
        'apps/console/Dockerfile',
        'apps/factory/Dockerfile',
        'apps/factory/Dockerfile.browser',
        'apps/runner/Dockerfile',
      ]),
    );
  });

  it.each(dockerfiles)('%s copies nothing from deploy/', (file) => {
    const sources = contextSources(readFileSync(file, 'utf-8'));
    expect(sources.filter(takesDeploy)).toEqual([]);
  });

  it('are read for each source they take from the context, and only those', () => {
    const sources = contextSources(
      [
        '# COPY deploy/ignored /x',
        'FROM node AS build',
        'COPY package.json pnpm-lock.yaml ./',
        'COPY --chown=1000:1000 --chmod=644 apps/x/src \\',
        '  apps/x/src',
        'ADD ["deploy/base", "/deploy"]',
        'ADD https://example.com/deploy/file /file',
        'COPY --from=build /repo/deploy /repo',
        'COPY <<EOF /deploy.txt',
        'RUN --mount=type=bind,source=deploy,target=/d --mount=type=cache,target=/c true',
        'RUN --mount=type=bind,from=build,source=deploy,target=/d true',
        'RUN --mount=target=/all true',
      ].join('\n'),
    );
    expect(sources).toEqual(['package.json', 'pnpm-lock.yaml', 'apps/x/src', 'deploy/base', 'deploy', '.']);
  });

  it('take deploy/ when a source is under it, the whole context, or a pattern that matches it', () => {
    const taking = ['deploy', 'deploy/', './deploy/base', '/deploy/overlays', '.', './', 'd*', '*', '[d]eploy/x'];
    const not = ['apps/factory/src', 'deployment.yaml', 'docs/deploy', 'policy', 'a*'];
    expect(taking.filter((source) => !takesDeploy(source))).toEqual([]);
    expect(not.filter(takesDeploy)).toEqual([]);
  });
});

describe("the manifests kind's exception", () => {
  it('is the file the Postgres beside the browser tests is pinned in', () => {
    const file = readFileSync('scripts/ci-images.sh', 'utf-8').match(/grep -oE "\$PIN" (\S+)/)?.[1];
    expect(file).toBe('deploy/base/postgres/statefulset.yaml');
    expect(readFileSync('.github/workflows/check.yml', 'utf-8')).toContain(`grep -qxF '${file}'`);
  });
});
