import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answerKey } from './answer-key.ts';

/** A private checkout of invented entries, shaped like the real one's. */
function checkout(entries: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'answer-key-'));
  for (const [name, entry] of Object.entries(entries)) {
    mkdirSync(join(dir, 'defects', name), { recursive: true });
    writeFileSync(join(dir, 'defects', name, 'entry.json'), JSON.stringify(entry));
  }
  return dir;
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the answer key from the private checkout', () => {
  it('takes each entry’s id and fingerprint, and nothing else', () => {
    const dir = checkout({
      'b-slow': {
        id: 'b-slow',
        title: 'An invented title',
        symptom: 'An invented symptom',
        location: ['src/invented.ts'],
        fingerprint: { route: '*', class: 'slow-response' },
      },
      'a-typo': { id: 'a-typo', title: 'Another', fingerprint: { page: '/about', text: 'teh shop' } },
    });
    made.push(dir);
    expect(answerKey(dir)).toEqual([
      { id: 'a-typo', fingerprint: { page: '/about', text: 'teh shop' } },
      { id: 'b-slow', fingerprint: { route: '*', class: 'slow-response' } },
    ]);
  });

  it('refuses a key the scoreboard would refuse, saying where and never what', () => {
    const dir = checkout({
      'a-wrong': { id: 'a-wrong', fingerprint: { route: '/secret-route', class: 'not-a-class' } },
    });
    made.push(dir);
    expect(() => answerKey(dir)).toThrow(/^The answer key is not valid: 0\.fingerprint/);
    expect(() => answerKey(dir)).not.toThrow(/secret-route|not-a-class|a-wrong/);
  });

  it('refuses an entry that is not JSON without quoting it', () => {
    const dir = checkout({});
    made.push(dir);
    mkdirSync(join(dir, 'defects', 'a-broken'), { recursive: true });
    writeFileSync(join(dir, 'defects', 'a-broken', 'entry.json'), '{"id": "a-broken", ');
    expect(() => answerKey(dir)).toThrow('cannot be read as JSON');
    expect(() => answerKey(dir)).not.toThrow(/a-broken/);
  });
});
