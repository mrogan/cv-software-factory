import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { matchesGlob, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A pull request that changes only files under deploy/ builds no image in its checks (check.yml's `manifests` kind):
 * the images it would build are main's, since no Dockerfile copies anything from there. This keeps that true, for
 * every Dockerfile in the repository, a new one included.
 *
 * What a Dockerfile takes from its build context: each source of a COPY or ADD (an ONBUILD one too), and each bind
 * mount of a RUN, but for those that take from another stage or image (`--from`, `from=`), from a URL, or from a
 * heredoc. The context's root, a pattern at its root that matches deploy, or a variable there could take deploy/ with
 * it, so each counts as taking it.
 */
function contextSources(dockerfile: string): string[] {
  // The escape character, a backslash unless a parser directive at the top names another.
  const escapeCharacter =
    dockerfile.match(/^(?:#[ \t]*\w+[ \t]*=.*\n)*#[ \t]*escape[ \t]*=[ \t]*([\\`])[ \t]*(?:\n|$)/i)?.[1] ?? '\\';
  const ending = new RegExp(`${escapeCharacter === '`' ? '`' : '\\\\'}\\s*$`);
  // Comment lines go first, as Docker drops them inside a continued instruction too; then heredoc bodies, which are
  // not instructions.
  const lines = dockerfile.split('\n').filter((line) => !line.trim().startsWith('#'));
  const instructions: string[] = [];
  let heredoc: string | undefined;
  let continued = '';
  for (const line of lines) {
    if (heredoc !== undefined) {
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    if (ending.test(line)) {
      continued += `${line.replace(ending, '')} `;
      continue;
    }
    const instruction = (continued + line).trim();
    continued = '';
    if (!instruction) continue;
    instructions.push(instruction);
    // A heredoc opens after a space in a RUN, COPY or ADD, never inside arithmetic like `$((1<<2))`.
    heredoc = /^(ONBUILD\s+)?(RUN|COPY|ADD)\s/i.test(instruction)
      ? instruction.match(/(?:^|\s)<<-?["']?(\w+)["']?/)?.[1]
      : undefined;
  }
  const sources: string[] = [];
  for (const instruction of instructions) {
    const [, keyword = '', rest = ''] = instruction.replace(/^ONBUILD\s+/i, '').match(/^(\S+)\s*(.*)$/) ?? [];
    const words = rest.split(/\s+/).filter(Boolean);
    const flags = words.filter((word) => word.startsWith('--'));
    switch (keyword.toUpperCase()) {
      case 'COPY':
      case 'ADD': {
        if (flags.some((flag) => flag.startsWith('--from='))) break;
        const args = rest.replace(/^(--\S+\s+)*/, '');
        // The shell form's words may be quoted.
        const paths: string[] = args.startsWith('[')
          ? JSON.parse(args)
          : (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^(["'])(.*)\1$/, '$2'));
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
  const [first = ''] = posix.normalize(`/${source}`).slice(1).split('/');
  return first === '' || first.includes('$') || matchesGlob('deploy', first);
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
        'RUN echo $((1<<2))',
        'COPY package.json pnpm-lock.yaml ./',
        'COPY --chown=1000:1000 --chmod=644 apps/x/src \\',
        '  apps/x/src',
        'ADD ["deploy/base", "/deploy"]',
        'ADD https://example.com/deploy/file /file',
        'COPY --from=build /repo/deploy /repo',
        'COPY <<EOF /deploy.txt',
        'COPY . /not-an-instruction',
        'EOF',
        'COPY policy \\',
        '# a comment inside a continued instruction',
        '  deploy/overlays /p',
        'ONBUILD ADD deploy/onbuild /o',
        'COPY "deploy/quoted" \'/q\'',
        'RUN --mount=type=bind,source=deploy,target=/d --mount=type=cache,target=/c true',
        'RUN --mount=type=bind,from=build,source=deploy,target=/d true',
        'RUN --mount=target=/all true',
      ].join('\n'),
    );
    expect(sources).toEqual([
      'package.json',
      'pnpm-lock.yaml',
      'apps/x/src',
      'deploy/base',
      'policy',
      'deploy/overlays',
      'deploy/onbuild',
      'deploy/quoted',
      'deploy',
      '.',
    ]);
  });

  it('take deploy/ when a source is under it, the whole context, or a pattern or variable that could match it', () => {
    const taking = [
      'deploy',
      'deploy/',
      './deploy/base',
      '/deploy/overlays',
      'apps/../deploy/base',
      '.',
      './',
      'd*',
      '*',
      '[d]eploy/x',
      '$DIR/base',
    ];
    const not = ['apps/factory/src', 'deployment.yaml', 'docs/deploy', 'policy', 'a*'];
    expect(taking.filter((source) => !takesDeploy(source))).toEqual([]);
    expect(not.filter(takesDeploy)).toEqual([]);
  });

  it('continue instructions with the escape character a parser directive names', () => {
    const dockerfile = [
      '# syntax=docker/dockerfile:1',
      '# escape=`',
      'FROM node',
      'COPY package.json `',
      '  deploy/base /x',
    ];
    expect(contextSources(dockerfile.join('\n'))).toEqual(['package.json', 'deploy/base']);
  });
});

/** The Dockerfiles each workflow builds, by the `file:` its build steps name. */
const built = (workflow: string) =>
  [...readFileSync(workflow, 'utf-8').matchAll(/^\s+file: (\S+)$/gm)].map(([, file = '']) => file);

describe('the images built', () => {
  it.each(['.github/workflows/build.yml', '.github/workflows/check.yml'])(
    'in %s are from Dockerfiles found here',
    (workflow) => {
      expect(built(workflow).length).toBeGreaterThan(0);
      expect(built(workflow).filter((file) => !dockerfiles.includes(file))).toEqual([]);
    },
  );

  it('are built again on main for nothing under deploy/', () => {
    const build = readFileSync('.github/workflows/build.yml', 'utf-8');
    const paths = build.match(/^ {4}paths:\n((?: {6}- .+\n)+)/m)?.[1]?.match(/- (.+)/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => takesDeploy(path.slice(2).replace(/^(["'])(.*)\1$/, '$2')))).toEqual([]);
  });
});
