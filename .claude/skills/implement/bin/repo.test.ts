import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_SH = join(import.meta.dirname, 'repo.sh');

let dir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function ownCommits(worktree: string): number {
  return Number(
    execFileSync('bash', ['-c', `. "${REPO_SH}" && own_commits "$1"`, 'test', worktree], { encoding: 'utf8' }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'own-commits-'));
  git(dir, 'init', '-q', '--bare', 'origin.git');
  git(dir, 'clone', '-q', 'origin.git', 'checkout');
  const checkout = join(dir, 'checkout');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'main');
  git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  git(checkout, 'switch', '-q', '-c', 'below');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'below 1');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'below 2');
  git(checkout, 'push', '-q', 'origin', 'below');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('own_commits', () => {
  it('counts nothing on a worktree made from the branch below in a stack', () => {
    const checkout = join(dir, 'checkout');
    git(checkout, 'worktree', 'add', '-q', '--no-track', join(dir, 'wt'), '-b', 'above', 'origin/below');
    expect(ownCommits(join(dir, 'wt'))).toBe(0);
  });

  it('counts the commits made on it since, from either base', () => {
    const checkout = join(dir, 'checkout');
    git(checkout, 'worktree', 'add', '-q', '--no-track', join(dir, 'stacked'), '-b', 'above', 'origin/below');
    git(join(dir, 'stacked'), 'commit', '-q', '--allow-empty', '-m', 'mine');
    expect(ownCommits(join(dir, 'stacked'))).toBe(1);
    git(checkout, 'worktree', 'add', '-q', '--no-track', join(dir, 'plain'), '-b', 'alone', 'origin/main');
    git(join(dir, 'plain'), 'commit', '-q', '--allow-empty', '-m', 'mine');
    git(join(dir, 'plain'), 'commit', '-q', '--allow-empty', '-m', 'mine too');
    expect(ownCommits(join(dir, 'plain'))).toBe(2);
  });
});
