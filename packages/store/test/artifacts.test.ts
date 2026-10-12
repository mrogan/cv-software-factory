import { mkdtempSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { DiskArtifacts, sha256 } from '../src/artifacts.ts';

const store = () => new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
const bytes = (s: string) => new TextEncoder().encode(s);

describe('the artifact store on disk', () => {
  it('names an artifact by the SHA-256 of its contents', async () => {
    const artifacts = store();
    const hash = await artifacts.put(bytes('FAIL test/money.test.ts'));
    expect(hash).toBe(sha256(bytes('FAIL test/money.test.ts')));
    expect(await artifacts.size(hash)).toBe(23);
    const stream = await artifacts.open(hash);
    expect(stream && (await text(stream))).toBe('FAIL test/money.test.ts');
  });

  it('stores the same contents once', async () => {
    const artifacts = store();
    await artifacts.put(bytes('same'));
    await artifacts.put(bytes('same'));
    expect(readdirSync(artifacts.dir)).toEqual([sha256(bytes('same'))]);
  });

  it('knows nothing of a hash it has not stored, or of anything that is not a hash', async () => {
    const artifacts = store();
    expect(await artifacts.size('0'.repeat(64))).toBeNull();
    expect(await artifacts.open('../../etc/passwd')).toBeNull();
  });

  it('deletes an artifact stored before it was judged unused, and nothing that is not a hash', async () => {
    const artifacts = store();
    const hash = await artifacts.put(bytes('a picture'));
    const judged = new Date(Date.now() + 1000);
    expect(await artifacts.remove(hash, judged)).toBe(true);
    expect(await artifacts.size(hash)).toBeNull();
    expect(await artifacts.remove(hash, judged)).toBe(true);
    await artifacts.remove('../../etc/passwd', judged);
    expect(readdirSync(artifacts.dir)).toEqual([]);
  });

  it('keeps an artifact stored again after it was judged unused', async () => {
    const artifacts = store();
    const hash = await artifacts.put(bytes('a picture'));
    const hour = 3_600_000;
    utimesSync(join(artifacts.dir, hash), new Date(Date.now() - 2 * hour), new Date(Date.now() - 2 * hour));
    const judged = new Date(Date.now() - hour);
    await artifacts.put(bytes('a picture'));
    expect(await artifacts.remove(hash, judged)).toBe(false);
    expect(await artifacts.size(hash)).toBe(9);
    expect(readdirSync(artifacts.dir)).toEqual([hash]);
  });
});
