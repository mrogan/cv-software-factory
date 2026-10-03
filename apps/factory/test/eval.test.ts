/**
 * The evaluation set in CI: every invented report routes as expected, replayed from the committed cassettes with
 * no key. A request with no cassette fails the run, so changing a question without running `make eval` fails too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../packages/store/test/database.ts';
import { SPEND } from '../../../policy/spend.ts';
import { evaluate } from '../eval/evaluate.ts';
import { REPORTS } from '../eval/reports.ts';
import { Cassettes } from '../src/gateway/cassettes.ts';
import { CassetteMissing } from '../src/gateway/errors.ts';
import { Gateway } from '../src/gateway/gateway.ts';
import { Spend } from '../src/gateway/spend.ts';

const CASSETTES = fileURLToPath(new URL('../eval/cassettes/', import.meta.url));
const log = pino({ level: 'silent' });
let database: Database;

beforeAll(async () => {
  database = await freshDatabase('evaluation');
});
afterAll(() => database?.end());

/** The gateway as CI runs it: no key, so it replays and nothing else. */
function replaying(dir: string) {
  const sql = database.writer;
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(tmpdir()) });
  const spend = new Spend({ sql, events, profile: 'local', policy: SPEND.local, log });
  const gateway = new Gateway({ sql, spend, cassettes: new Cassettes({ read: [dir] }), mode: 'replay', log });
  return gateway.judge.bind(gateway);
}

describe('the evaluation set', () => {
  it('routes every report as expected, on cassettes', async () => {
    const outcomes = await evaluate(replaying(CASSETTES));
    const wrong = outcomes
      .filter((o) => !o.pass && !o.report.known)
      .map((o) => `${o.report.id}: ${JSON.stringify(o.got)}`);
    expect(wrong).toEqual([]);
  });

  it('quarantines every red-team report and parks every polite request', () => {
    const attacks = REPORTS.filter((r) => r.id.startsWith('attack-'));
    const requests = REPORTS.filter((r) => r.id.startsWith('suggestion-'));
    expect(attacks.length).toBeGreaterThanOrEqual(5);
    expect(attacks.every((r) => r.expect.route === 'quarantine' && !r.known)).toBe(true);
    expect(requests.every((r) => r.expect.route === 'park' && !r.known)).toBe(true);
  });

  it('fails when a request has no cassette', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-cassettes-'));
    await expect(evaluate(replaying(empty), REPORTS.slice(0, 1))).rejects.toBeInstanceOf(CassetteMissing);
  });
});
