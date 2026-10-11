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

const fingerprint = z.union([
  z.strictObject({ route: z.union([z.string().regex(/^\/\S*$/), z.literal('*')]), class: z.enum(SYMPTOM_CLASSES) }),
  z.strictObject({ page: z.string().regex(/^\/\S*$/), text: z.string().trim().min(1) }),
]);

const key = z
  .array(z.strictObject({ id: z.string().min(1), fingerprint }))
  .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, 'an id is repeated');

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
  const where = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'the key'} (${issue.code})`);
  throw new Error(`The answer key is not valid: ${[...new Set(where)].slice(0, 5).join(', ')}.`);
}
