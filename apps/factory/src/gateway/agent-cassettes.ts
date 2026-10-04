/**
 * Cassettes for agents' calls: a Messages API response, recorded so that a runner's step can be replayed exactly,
 * call by call, and a step run again after a change pays only from the first call that differs.
 *
 * Two runs of the same agent on the same work send requests that differ in only two places: the request's metadata
 * (a session id) and the date written into the prompt. The key leaves both out, and runners work in a fixed folder,
 * so everything else that reaches the key is the work itself. The provider is part of the key, so a local model's
 * recording never stands in for Claude's.
 *
 * A cassette is `<key>.json` beside the judgements' cassettes, and holds the request as keyed and the response body
 * as it came over the wire: JSON, or the server-sent events of a stream.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const agentCassette = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.literal('messages'),
  provider: z.enum(['anthropic', 'local']),
  model: z.string().min(1),
  recordedAt: z.iso.datetime(),
  /** The request as keyed: what was sent, without what changes between identical runs. */
  request: z.record(z.string(), z.unknown()),
  stream: z.boolean(),
  response: z.string(),
});

export type AgentCassette = z.infer<typeof agentCassette>;

/** How a prompt names the day, which changes from one run to the next and nothing else does. */
const DATE = /Today's date is [^.\n"\\]+/g;

/** A request as its cassette is keyed: without its metadata, and with the date in its prompt left out. */
export function keyedRequest(body: Record<string, unknown>): Record<string, unknown> {
  const { metadata: _, ...rest } = body;
  return JSON.parse(JSON.stringify(rest).replace(DATE, "Today's date is (the day of the run)"));
}

export function agentCassetteKey(provider: string, request: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(['messages', provider, request]))
    .digest('hex');
}

export class AgentCassettes {
  readonly #dirs: readonly string[];
  readonly #recordTo: string | undefined;

  constructor({ record, read = [] }: { record?: string | undefined; read?: readonly string[] }) {
    this.#recordTo = record;
    this.#dirs = [...(record ? [record] : []), ...read];
  }

  /** The cassette for a key from the first folder that has one, or undefined. A damaged one is an error. */
  find(key: string): AgentCassette | undefined {
    for (const dir of this.#dirs) {
      const file = join(dir, `${key}.json`);
      if (!existsSync(file)) continue;
      const damaged = new Error(`Cassette ${file} is damaged: its contents do not match its key.`);
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(file, 'utf-8'));
      } catch {
        throw damaged;
      }
      const parsed = agentCassette.safeParse(json);
      if (!parsed.success || agentCassetteKey(parsed.data.provider, parsed.data.request) !== key) throw damaged;
      return parsed.data;
    }
    return undefined;
  }

  record(cassette: AgentCassette): void {
    if (!this.#recordTo) throw new Error('This gateway has no folder to record cassettes in.');
    mkdirSync(this.#recordTo, { recursive: true });
    const file = join(this.#recordTo, `${cassette.key}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(cassette, null, 2)}\n`);
    renameSync(temporary, file);
  }
}
