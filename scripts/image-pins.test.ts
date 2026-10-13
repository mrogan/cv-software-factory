import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Each of Docker's official images is pinned in several places: the cluster's manifests, admission's allow-list, the
 * Dockerfiles, the store's tests. Dependabot moves the pins it can read, and CI copies each one into GHCR
 * (scripts/ci-images.sh), so a pin that is left behind runs a different image from the others. Pins of one image are
 * those with the same name and tag suffix (node's alpine3.24 and trixie-slim are two images); prose is left out.
 */
const PIN = /public\.ecr\.aws\/docker\/library\/([a-z0-9._-]+):([A-Za-z0-9._-]+)@(sha256:[0-9a-f]{64})/g;

function pins() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf-8' }).split('\0');
  const found = new Map<string, Set<string>>();
  for (const file of files.filter((f) => f && !f.endsWith('.md'))) {
    for (const [, name, tag = '', digest] of readFileSync(file, 'utf-8').matchAll(PIN)) {
      const image = `${name}:*${tag.includes('-') ? tag.slice(tag.indexOf('-')) : ''}`;
      found.set(image, (found.get(image) ?? new Set()).add(`${tag}@${digest}`));
    }
  }
  return found;
}

describe("the pins of Docker's official images", () => {
  it('are found', () => {
    expect([...pins().keys()]).toEqual(expect.arrayContaining(['postgres:*-alpine3.24', 'node:*-alpine3.24']));
  });

  it('agree, image by image', () => {
    const disagree = [...pins()].filter(([, versions]) => versions.size > 1).map(([image, v]) => [image, [...v]]);
    expect(disagree).toEqual([]);
  });
});
