/**
 * The deploy watch fetches Sigstore's trust root through TUF, inside a container whose root filesystem is read-only.
 * TUF downloads each file into a directory of its own under the system's temporary directory before copying it into
 * its cache, so both must be writable, or every check fails with "error refreshing TUF metadata" and nothing is ever
 * proposed.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const GITHUB = fileURLToPath(new URL('../../../../deploy/base/factory/github.yaml', import.meta.url));

interface Container {
  name: string;
  env?: { name: string; value?: string }[];
  securityContext?: { readOnlyRootFilesystem?: boolean };
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
}

describe("the GitHub worker's sandbox", () => {
  it('gives TUF a writable /tmp and a writable cache under its read-only root', async () => {
    const deployment = parse(await readFile(GITHUB, 'utf-8'));
    const spec = deployment.spec.template.spec as { containers: Container[] };
    const worker = spec.containers.find((c) => c.name === 'github');
    if (!worker) throw new Error('No github container');
    expect(worker.securityContext?.readOnlyRootFilesystem).toBe(true);

    const cache = worker.env?.find((e) => e.name === 'TUF_CACHE_DIR')?.value;
    expect(cache).toBeDefined();
    const writable = (worker.volumeMounts ?? []).filter((m) => !m.readOnly).map((m) => m.mountPath);
    expect(writable).toContain('/tmp');
    expect(writable).toContain(cache);
  });
});
