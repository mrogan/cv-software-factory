/**
 * `factory reviews`: what the reviewer's reviews add up to.
 *
 *     factory reviews rules [--rules <docs/REVIEWERS.md>]
 *
 * `rules` counts the reviewer's findings by the rule each cites, from every review in the event store (`line/rules.ts`).
 * Given the app's `docs/REVIEWERS.md`, it counts every rule there, and says which were never cited, and so could go,
 * and which are cited often, and so could become a lint rule, or move into `AGENTS.md` if they are invariants.
 * Connects with DATABASE_URL, or the PG* variables; it only reads.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { type PayloadOf, type RawEvent, upcast } from '@software-factory/events';
import postgres from 'postgres';
import { countRules, rulesIn, rulesTable } from '../line/rules.ts';

export const USAGE = '  factory reviews rules [--rules <docs/REVIEWERS.md>]';

export async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { rules: { type: 'string' } } });
  if (positionals.length !== 1 || positionals[0] !== 'rules') {
    console.log(`Usage:\n${USAGE}`);
    return 2;
  }
  const rules = values.rules ? rulesIn(await readFile(values.rules, 'utf-8')) : undefined;
  if (rules?.length === 0) {
    console.error(`${values.rules} has no numbered rules, such as "1. **Deep modules.**".`);
    return 2;
  }
  const { DATABASE_URL } = process.env;
  const sql = DATABASE_URL ? postgres(DATABASE_URL, { onnotice: () => {} }) : postgres({ onnotice: () => {} });
  try {
    const rows = await sql<RawEvent[]>`
      select type, version, payload from events where type = 'review.submitted' order by seq`;
    const reviews = rows.flatMap((row) => {
      const read = upcast(row);
      return read.ok ? [read.event.payload as PayloadOf<'review.submitted'>] : [];
    });
    console.log(rulesTable(countRules(reviews, rules)));
    return 0;
  } finally {
    await sql.end();
  }
}
