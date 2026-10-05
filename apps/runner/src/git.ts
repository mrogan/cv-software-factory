/**
 * Git, run as a child process in the job's checkout. Only the runner's pods run git in it, and with no settings but
 * their own: not the system's, and not a global file from a home the agent could write.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitWith({}, cwd, ...args);
}

/** Git with some variables of its own, such as a commit's dates. */
export async function gitWith(env: Record<string, string>, cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  return stdout;
}
