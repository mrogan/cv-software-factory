/**
 * The answer key, as the scoreboard is given it: a JSON file of `[{id, fingerprint}]`, mounted from its Secret. With
 * no file, the scoreboard has no key and is off.
 *
 * Nothing here ever prints what the key holds. A key that is not valid is refused with where it is wrong (an entry's
 * position and the field), never with the value, and a file that is not JSON with no quotation of it, as `JSON.parse`'s
 * own message would give.
 */
import { readFile } from 'node:fs/promises';
import { SYMPTOM_CLASSES } from '@software-factory/events';
import { z } from 'zod';
import type { KeyEntry } from '../../../../policy/scoreboard.ts';

/** As a ticket's fingerprint is bounded (`ticket.opened`), so that every entry is one a ticket could match. */
const route = z
  .string()
  .regex(/^\/\S*$/)
  .max(200);
const fingerprint = z.union([
  z.strictObject({ route: z.union([route, z.literal('*')]), class: z.enum(SYMPTOM_CLASSES) }),
  z.strictObject({ page: route, text: z.string().trim().min(1).max(200) }),
]);

/** What makes two fingerprints the same entry: a passage's case does not count, as `matches` ignores it. */
const sameness = (f: KeyEntry['fingerprint']) =>
  'route' in f ? JSON.stringify(['route', f.route, f.class]) : JSON.stringify(['page', f.page, f.text.toLowerCase()]);

const key = z.array(z.strictObject({ id: z.string().min(1), fingerprint })).superRefine((entries, context) => {
  // Each id, and each fingerprint, once: a fingerprint twice would count one ticket's find twice.
  for (const [field, of] of [
    ['id', (entry: KeyEntry) => entry.id],
    ['fingerprint', (entry: KeyEntry) => sameness(entry.fingerprint)],
  ] as const) {
    const seen = new Map<string, number>();
    entries.forEach((entry, i) => {
      const first = seen.get(of(entry));
      if (first === undefined) seen.set(of(entry), i);
      else context.addIssue({ code: 'custom', path: [i, field], message: `repeats entry ${first}'s ${field}` });
    });
  }
});

/** The key's entries, or null when there is no file at `path`. */
export async function loadKey(path: string): Promise<KeyEntry[] | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  return parseKey(text);
}

/** The key's entries from its file's text. */
export function parseKey(text: string): KeyEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The answer key is not JSON.');
  }
  const parsed = key.safeParse(json);
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues.map((issue) =>
    // A repeat names the entry it repeats, by position; every other message could quote a value, so only its code.
    issue.code === 'custom'
      ? `${issue.path.join('.')} ${issue.message}`
      : `${issue.path.join('.') || 'the key'} (${issue.code})`,
  );
  throw new Error(`The answer key is not valid: ${[...new Set(where)].slice(0, 5).join(', ')}.`);
}
