import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'blink.ts');

/** A PNG of one colour, as small as a valid one gets. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bits per channel
  header.writeUInt8(2, 9); // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function blink(before: Buffer, after: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'blink-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'before.png'), before);
  writeFileSync(join(dir, 'after.png'), after);
  // A folder that does not exist yet, as scratch/pr/<branch>/ on a clean checkout.
  const out = join(dir, 'pr', 'branch', 'snapshot.svg');
  const run = spawnSync(process.execPath, [SCRIPT, join(dir, 'before.png'), join(dir, 'after.png'), out], {
    encoding: 'utf8',
  });
  return { run, svg: () => readFileSync(out, 'utf8') };
}

describe('blink.ts', () => {
  it('writes one SVG with both PNGs, Before blinking over After, into a folder it makes', () => {
    const before = png(4, 3);
    const after = png(4, 5);
    const { run, svg } = blink(before, after);
    expect(run.status).toBe(0);
    const text = svg();
    // As tall as the taller picture, under a band of 32.
    expect(text).toContain('width="4" height="37" viewBox="0 0 4 37"');
    expect(text).toContain(`data:image/png;base64,${before.toString('base64')}`);
    expect(text).toContain(`data:image/png;base64,${after.toString('base64')}`);
    expect(text.indexOf('>After<')).toBeLessThan(text.indexOf('>Before<'));
    expect(text).toMatch(/<g class="before">[\s\S]*<animate attributeName="opacity" values="1;0" keyTimes="0;0.5"/);
    expect(text).toContain('prefers-reduced-motion: reduce');
  });

  it('refuses a file that is not a PNG', () => {
    const { run } = blink(Buffer.from('not a picture'), png(1, 1));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('before.png is not a PNG');
  });
});
