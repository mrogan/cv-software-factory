/**
 * The answer key as the scoreboard is given it, from the private checkout: `make up` pipes it into the scoreboard's
 * Secret, and it is never written to a file.
 *
 *     node scripts/answer-key.ts ../cv-software-factory-private | kubectl -n scoreboard create secret …
 *
 * Each entry in `defects/<id>/entry.json` gives its id and fingerprint, and nothing else: not its title, its symptom,
 * where it is or how it was made. The key is checked as the scoreboard checks it when it starts, so a key it would
 * refuse never reaches the cluster; a problem is reported by where it is, never with what the key holds.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseKey } from '../apps/factory/src/scoreboard/key.ts';
import type { KeyEntry } from '../policy/scoreboard.ts';

/** Each defect's id and fingerprint, in the order of their directories. */
export function answerKey(checkout: string): KeyEntry[] {
  const defects = join(checkout, 'defects');
  const entries = readdirSync(defects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      let entry: { id?: unknown; fingerprint?: unknown };
      try {
        entry = JSON.parse(readFileSync(join(defects, name, 'entry.json'), 'utf-8'));
      } catch {
        throw new Error(`An entry in ${defects} cannot be read as JSON.`);
      }
      return { id: entry.id, fingerprint: entry.fingerprint };
    });
  return parseKey(JSON.stringify(entries));
}

if (import.meta.main) {
  const [checkout] = process.argv.slice(2);
  if (!checkout) {
    console.error('Usage: node scripts/answer-key.ts <the private checkout>');
    process.exit(2);
  }
  try {
    process.stdout.write(JSON.stringify(answerKey(checkout)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The answer key cannot be read.');
    process.exit(1);
  }
}
