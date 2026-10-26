/**
 * Examples of the paths a patch may change (`github/paths.ts`); `paths-properties.test.ts` holds what must be true of
 * every scope and CODEOWNERS file.
 */
import { describe, expect, it } from 'vitest';
import { inScope, ownedPaths, plainPath, protectedFrom } from '../../src/github/paths.ts';

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
});
