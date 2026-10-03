/**
 * Cassettes: a provider's response, recorded so that it can be replayed exactly. Jev does not promise the same
 * answer to the same request, so a cassette is the only exact replay (ADR 0003).
 *
 * A cassette is one file, `<key>.json`. Its key is the SHA-256 of the provider, the pinned model, the questions
 * and the state, in that order, written with `JSON.stringify`. The order of keys inside the questions is part of
 * the key, because the order of a Choice's options can change its answer. So callers build a request the same
 * way every time: question sets are typed code that does.
 *
 * A cassette keeps the raw body of the response, as it came over the wire. Replaying parses and checks it exactly
 * as a live response is. Committed cassettes come only from invented reports; recordings of real reports stay on
 * the cluster's volume.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { request as requestSchema, type TypeSafeRequest } from './typesafe.ts';

const cassetteFile = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  provider: z.string().min(1),
  model: z.string().min(1),
  recordedAt: z.iso.datetime(),
  request: requestSchema,
  /** The response body as it came over the wire. */
  response: z.string(),
});

export type Cassette = z.infer<typeof cassetteFile>;

/** The key of a request: see the top of this file. */
export function cassetteKey(provider: string, sent: TypeSafeRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([provider, sent.model, sent.questions, sent.state]))
    .digest('hex');
}

export class Cassettes {
  readonly #dirs: readonly string[];
  readonly #recordTo: string | undefined;

  /**
   * @param record the folder new cassettes go in, which is also read first
   * @param read further folders to read, in order, such as the committed evaluation cassettes
   */
  constructor({ record, read = [] }: { record?: string | undefined; read?: readonly string[] }) {
    this.#recordTo = record;
    this.#dirs = [...(record ? [record] : []), ...read];
  }

  /** The cassette for a key from the first folder that has one, or undefined. A damaged one is an error. */
  find(key: string): Cassette | undefined {
    for (const dir of this.#dirs) {
      const file = join(dir, `${key}.json`);
      if (!existsSync(file)) continue;
      // A parse error can quote the file, and a cassette may hold a visitor's report: say only that it is damaged.
      const damaged = new Error(`Cassette ${file} is damaged: its contents do not match its key.`);
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(file, 'utf-8'));
      } catch {
        throw damaged;
      }
      const parsed = cassetteFile.safeParse(json);
      if (
        !parsed.success ||
        parsed.data.key !== key ||
        cassetteKey(parsed.data.provider, parsed.data.request) !== key
      ) {
        throw damaged;
      }
      return parsed.data;
    }
    return undefined;
  }

  /** Writes a cassette to the recording folder, whole or not at all. */
  record(cassette: Cassette): void {
    if (!this.#recordTo) throw new Error('This gateway has no folder to record cassettes in.');
    mkdirSync(this.#recordTo, { recursive: true });
    const file = join(this.#recordTo, `${cassette.key}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(cassette, null, 2)}\n`);
    renameSync(temporary, file);
  }
}
