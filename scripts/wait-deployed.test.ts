import { execFile } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/** The end of `make up`, against a kubectl that answers with root's resources as the script's jsonpath prints them. */
const SCRIPT = fileURLToPath(new URL('./wait-deployed.sh', import.meta.url));

async function wait(resources: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'wait-deployed-'));
  const kubectl = join(dir, 'kubectl');
  await writeFile(
    kubectl,
    `#!/usr/bin/env bash\nprintf '%b' ${JSON.stringify(resources.map((r) => `${r}\n`).join(''))}\n`,
  );
  await chmod(kubectl, 0o755);
  return promisify(execFile)(SCRIPT, [], { env: { ...process.env, KUBECTL: kubectl, TIMEOUT: '0' } }).then(
    ({ stdout, stderr }) => ({ code: 0, out: stdout + stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
  );
}

const FACTORY = ['Deployment/line=Healthy', 'ConfigMap/policy=', 'Application/prometheus=Healthy'];

describe('waiting for Argo CD to deploy everything (make up)', () => {
  it('is done when everything root deploys is healthy, the website too', async () => {
    expect(await wait([...FACTORY, 'Application/website=Healthy'])).toEqual({ code: 0, out: '' });
  });

  it('is done when the website is mid-release or rolled back, and says so', async () => {
    const suspended = await wait([...FACTORY, 'Application/website=Suspended']);
    expect(suspended.code).toBe(0);
    expect(suspended.out).toContain('a release is in flight');
    const degraded = await wait([...FACTORY, 'Application/website=Degraded']);
    expect(degraded.code).toBe(0);
    expect(degraded.out).toContain('rolled back');
  });

  it('waits for the website to come up, and for anything else not yet healthy, naming each', async () => {
    const coming = await wait([...FACTORY, 'Application/website=Progressing']);
    expect(coming.code).toBe(1);
    expect(coming.out).toContain('Application/website=Progressing');
    const factory = await wait([
      'Deployment/line=Degraded',
      'Application/tempo=Suspended',
      'Application/website=Healthy',
    ]);
    expect(factory.code).toBe(1);
    expect(factory.out).toContain('Deployment/line=Degraded');
    expect(factory.out).toContain('Application/tempo=Suspended');
    expect(factory.out).not.toContain('website');
  });

  it('waits for root to be deployed at all', async () => {
    const nothing = await wait([]);
    expect(nothing.code).toBe(1);
    expect(nothing.out).toContain('Application/website=(not deployed)');
  });
});
