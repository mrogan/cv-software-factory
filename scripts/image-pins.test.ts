import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Docker's official images are pinned by digest, and Dependabot moves the pins it can read. Node is pinned in three
 * Dockerfiles, which Dependabot moves together; a pin left behind runs a different image from the others. Postgres
 * has one pin, its StatefulSet's, which everything else that runs it reads, so that Dependabot's update of it is the
 * whole update. Pins of one image share a name, a major version and a tag suffix (node 24's alpine3.24 and
 * trixie-slim are two images, and so are Postgres 18 and 19 side by side during an upgrade). Prose is left out.
 * scripts/ci-images.sh copies the same pins into CI's GHCR.
 */
const PIN = /public\.ecr\.aws\/docker\/library\/([a-z0-9._-]+)(?::([A-Za-z0-9._-]+))?@(sha256:[0-9a-f]{64})/g;
const POSTGRES = 'deploy/base/postgres/statefulset.yaml';

/** Each image's pins, each as [file, tag@digest], from every file but prose: one file can pin an image twice. */
function pins(read = (file: string) => readFileSync(file, 'utf-8')) {
  const files = execFileSync('git', ['grep', '-lE', 'public\\.ecr\\.aws/docker/library/', '--', ':!*.md'], {
    encoding: 'utf-8',
  });
  const found = new Map<string, [string, string][]>();
  for (const file of files.split('\n').filter(Boolean)) {
    for (const [, name = '', tag, digest] of read(file).matchAll(PIN)) {
      const image = tag
        ? `${name}:${tag.split(/[.-]/)[0]}${tag.includes('-') ? tag.slice(tag.indexOf('-')) : ''}`
        : name;
      found.set(image, [...(found.get(image) ?? []), [file, `${tag ?? ''}@${digest}`]]);
    }
  }
  return found;
}

const disagreeing = (found: ReturnType<typeof pins>) =>
  [...found].filter(([, where]) => new Set(where.map(([, pin]) => pin)).size > 1);

describe("the pins of Docker's official images", () => {
  const found = pins();

  it('are found', () => {
    expect([...found.keys()]).toEqual(expect.arrayContaining(['postgres:18-alpine3.24', 'node:24-alpine3.24']));
  });

  it('agree, image by image', () => {
    expect(disagreeing(found)).toEqual([]);
  });

  it('disagree when one file pins an image twice, differently', () => {
    const DOCKERFILE = 'apps/console/Dockerfile';
    const twice = (file: string) => {
      const source = readFileSync(file, 'utf-8');
      const pinned = source.match(PIN)?.[0] ?? '';
      return file === DOCKERFILE ? `${source}\nFROM ${pinned.replace(/[0-9a-f]{64}$/, '2'.repeat(64))}\n` : source;
    };
    expect(disagreeing(pins(twice)).map(([image]) => image)).toEqual(['node:24-alpine3.24']);
  });

  it('pin Postgres once, in its StatefulSet', () => {
    const postgres = [...found].filter(([image]) => image.startsWith('postgres'));
    expect(postgres.flatMap(([, where]) => where.map(([file]) => file))).toEqual([POSTGRES]);
  });

  it("follow a Dependabot update of Postgres's one pin everywhere it runs", () => {
    const pinned = readFileSync(POSTGRES, 'utf-8').match(PIN)?.[0] ?? '';
    const moved = `public.ecr.aws/docker/library/postgres:18.7-alpine3.24@sha256:${'1'.repeat(64)}`;
    const bump = (file: string) => readFileSync(file, 'utf-8').replace(pinned, moved);

    expect(disagreeing(pins((file) => (file === POSTGRES ? bump(file) : readFileSync(file, 'utf-8'))))).toEqual([]);

    // Admission's allow-list for the factory's namespaces, rendered from a copy of deploy/ with the pin moved.
    const copy = mkdtempSync(join(tmpdir(), 'image-pins-'));
    cpSync('deploy', join(copy, 'deploy'), { recursive: true });
    writeFileSync(join(copy, POSTGRES), bump(POSTGRES));
    const rendered = execFileSync('kustomize', ['build', join(copy, 'deploy/overlays/local')], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(rendered).toContain(`'${moved}'`);
    expect(rendered).not.toContain(pinned);
  });
});
