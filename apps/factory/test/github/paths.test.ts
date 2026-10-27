/**
 * Examples of the paths a patch may change (`github/paths.ts`); `paths-properties.test.ts` holds what must be true of
 * every scope and CODEOWNERS file.
 */
import { PATH_CHARS } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { inScope, ownedPaths, plainPath, protectedFrom, protectedWords } from '../../src/github/paths.ts';

describe('the paths a CODEOWNERS file gives a person', () => {
  it('take in everything in a folder its entry names without a trailing slash, as GitHub does', () => {
    const owned = ownedPaths('/deploy @mrogan\ndocs @mrogan\n');
    expect(inScope('deploy/website/values.yaml', owned)).toBe(true);
    expect(inScope('apps/docs/README.md', owned)).toBe(true);
    expect(inScope('deployment.md', owned)).toBe(false);
  });

  it('read `?`, one character, as `*`, and `/` alone as everything', () => {
    expect(inScope('src/a.ts', ownedPaths('/src/?.ts @mrogan'))).toBe(true);
    expect(inScope('src/money.ts', ownedPaths('/ @mrogan'))).toBe(true);
  });

  it('are told each once, as CODEOWNERS writes it, without the folder matched beside it', () => {
    const owned = protectedFrom('/Dockerfile @mrogan\nAGENTS.md @mrogan\n/docs/ @mrogan\n');
    expect(owned).toEqual([
      '.github/',
      'deploy/',
      'Dockerfile',
      'Dockerfile/',
      '**/AGENTS.md',
      '**/AGENTS.md/',
      'docs/',
    ]);
    expect(protectedWords(owned)).toEqual(['.github/', 'deploy/', 'Dockerfile', '**/AGENTS.md', 'docs/']);
  });

  it('are the workflows and the deployment alone when there is no CODEOWNERS file', () => {
    expect(protectedFrom(null)).toEqual(['.github/', 'deploy/']);
  });
});

describe('a plain path', () => {
  it('holds no C1 control character, such as the one a terminal reads as the start of an escape', () => {
    expect(plainPath('src/money.ts')).toBe(true);
    expect(plainPath('src/\u009b31mmoney.ts')).toBe(false);
    expect(plainPath('src/money\u0085.ts')).toBe(false);
  });

  it('holds no line or paragraph separator, or format character such as a bidi override', () => {
    expect(plainPath('deploy/a\u2028b.yaml')).toBe(false);
    expect(plainPath('src/a\u2029b.ts')).toBe(false);
    expect(plainPath('src/\u202emoney.ts')).toBe(false);
    expect(plainPath('src/mo\u200bney.ts')).toBe(false);
  });

  it('is no longer than an event records', () => {
    const long = (chars: number) => `src/${'a'.repeat(chars - 'src/.ts'.length)}.ts`;
    expect(plainPath(long(PATH_CHARS))).toBe(true);
    expect(plainPath(long(PATH_CHARS + 1))).toBe(false);
    expect(plainPath(long(1024 * 1024))).toBe(false);
  });
});
