import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/github/config.ts';

describe('the GitHub worker’s settings', () => {
  it('fail closed on the dry run: an unclear answer, or nowhere to record, stops it starting', () => {
    expect(() => configFromEnv({ GITHUB_DRY_RUN: 'yes', ARTIFACTS_DIR: '/tmp/a' })).toThrow('must be true or false');
    expect(() => configFromEnv({ GITHUB_DRY_RUN: 'true' })).toThrow('ARTIFACTS_DIR');
    expect(configFromEnv({ GITHUB_DRY_RUN: 'True', ARTIFACTS_DIR: '/tmp/a' }).dryRun).toBe(true);
    expect(configFromEnv({}).dryRun).toBe(false);
  });

  it('listen on loopback unless told otherwise, on a port that is a port', () => {
    expect(configFromEnv({}).host).toBe('127.0.0.1');
    expect(configFromEnv({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(() => configFromEnv({ PORT: 'eighty' })).toThrow('port number');
  });
});
