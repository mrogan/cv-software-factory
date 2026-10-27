/**
 * ZAP's rules for the console's scan (`zap/rules.tsv`, ADR 0012): every exception keeps its reason beside it, and is an
 * exception, never a rule made stricter or a finding moved out of scope without a word. The image is pinned by digest.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rules = readFileSync(new URL('../zap/rules.tsv', import.meta.url), 'utf-8')
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'));

describe("the ZAP scan's exceptions", () => {
  it('are each a rule, a level that lets the scan pass, its name and a reason', () => {
    for (const line of rules) {
      const [id = '', level = '', name = '', reason = '', ...rest] = line.split('\t');
      expect(id, line).toMatch(/^\d+$/);
      expect(['IGNORE', 'INFO'], line).toContain(level);
      expect(name, line).toMatch(/^\(.+\)$/);
      expect(reason.trim().length, `${line}: a reason, in a sentence`).toBeGreaterThan(40);
      expect(rest, line).toEqual([]);
    }
  });

  it('name each rule once', () => {
    const ids = rules.map((line) => line.split('\t')[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

it('runs ZAP from an image pinned by digest', () => {
  // Read, not imported: importing the scan would run it.
  const scan = readFileSync(new URL('../zap/scan.ts', import.meta.url), 'utf-8');
  const image = /ZAP_IMAGE =\s+'([^']+)'/.exec(scan)?.[1];
  expect(image).toMatch(/^ghcr\.io\/zaproxy\/zaproxy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
});

it('gives ZAP a port of its own, clear of the harness and below the range outgoing connections take theirs from', () => {
  const scan = readFileSync(new URL('../zap/scan.ts', import.meta.url), 'utf-8');
  const constant = (name: string) =>
    Number(new RegExp(`const ${name} = ([\\d_]+);`).exec(scan)?.[1]?.replaceAll('_', ''));
  const port = constant('ZAP_PORT');
  // Linux's ephemeral range starts at 32768 by default, and macOS's and Windows's higher still.
  expect(port).toBeGreaterThan(1024);
  expect(port).toBeLessThan(32_768);
  // The harness's proxy listens on PORT, and the console's server on the port after it (`../e2e/admin.ts`).
  expect([constant('PORT'), constant('PORT') + 1]).not.toContain(port);
  expect(scan).toContain("'-P', String(ZAP_PORT)");
});
