import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { SpendPolicy } from '../../../../policy/spend.ts';
import { Cassettes, cassetteKey } from '../../src/gateway/cassettes.ts';
import { BadRequest, CassetteMissing, ProviderError, SpendCapped } from '../../src/gateway/errors.ts';
import { Gateway, type Mode } from '../../src/gateway/gateway.ts';
import { Spend } from '../../src/gateway/spend.ts';
import { PROVIDER, TypeSafe, request as typesafeRequest } from '../../src/gateway/typesafe.ts';
import { capturingLog, type FakeTypeSafe, fakeTypeSafe, QUESTIONS, request, SECRET } from './helpers.ts';

let fake: FakeTypeSafe;
beforeAll(async () => {
  fake = await fakeTypeSafe();
});
afterAll(() => fake.close());

const POLICY: SpendPolicy = { dayUsd: 20, monthUsd: 100, workItemUsd: 2 };
// A call of a million input tokens costs $0.042.
const MILLION = 1_000_000;

interface Setup {
  mode?: Mode;
  key?: boolean;
  policy?: SpendPolicy;
  clock?: Date;
  read?: string[];
}

/** A gateway on a database of its own, a stand-in provider and a clock the test moves. */
async function harness({ mode = 'record', key = true, policy = POLICY, clock, read = [] }: Setup = {}) {
  const database: Database = await freshDatabase('gateway');
  const now = { value: clock ?? new Date('2026-10-03T12:00:00Z') };
  // Each reading is a millisecond later than the last, so rows have an order.
  let tick = 0;
  const time = () => new Date(now.value.getTime() + tick++);
  const captured = capturingLog();
  const dir = mkdtempSync(join(tmpdir(), 'cassettes-'));
  const events = new EventWriter(database.writer, { kind: 'real', artifacts: new DiskArtifacts(dir) });
  const spend = () =>
    new Spend({ sql: database.writer, events, profile: 'local', policy, log: captured.log, clock: time });
  const ledger = spend();
  const typesafe = new TypeSafe({
    apiKey: 'test-key',
    baseUrl: fake.url,
    log: captured.log,
    sleep: async () => {},
    random: () => 0,
  });
  const gateway = new Gateway({
    sql: database.writer,
    spend: ledger,
    cassettes: new Cassettes({ record: dir, read }),
    mode,
    typesafe: key ? typesafe : undefined,
    log: captured.log,
    clock: time,
  });
  const rows = () =>
    database.owner<{ outcome: string; cost_usd: string; work_item: string | null; cassette: string | null }[]>`
      select outcome, cost_usd, work_item, cassette from model_calls order by at, id`;
  const lineEvents = async () =>
    (
      await database.owner<{ type: string; payload: Record<string, unknown> }[]>`
        select type, payload from events where type like 'spend.%' order by seq`
    ).map((event) => ({ type: event.type, ...event.payload }));
  return { database, now, captured, dir, events, ledger, spend, gateway, rows, lineEvents, typesafe };
}

beforeEach(() => {
  fake.requests.length = 0;
  fake.inputTokens = 300;
});

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was meant to fail.');
};

describe('cassettes', () => {
  const sent = typesafeRequest.parse({ model: 'jev-1.13.0', state: 'a', questions: QUESTIONS });

  it('are keyed stably, by provider, model, questions and state', () => {
    const key = cassetteKey(PROVIDER, sent);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cassetteKey(PROVIDER, structuredClone(sent))).toBe(key);
    expect(cassetteKey(PROVIDER, { ...sent, state: 'b' })).not.toBe(key);
    expect(cassetteKey('another', sent)).not.toBe(key);
  });

  it('are keyed by the order of a Choice’s options, since order can change an answer', () => {
    const [first, ...others] = Object.entries(QUESTIONS.category?.type === 'choice' ? QUESTIONS.category.criteria : {});
    const reordered = structuredClone(sent);
    reordered.questions.category = {
      type: 'choice',
      criteria: Object.fromEntries([...others, first ?? ['', null]]),
    };
    const original = structuredClone(sent);
    original.questions.category = { type: 'choice', criteria: Object.fromEntries([first ?? ['', null], ...others]) };
    expect(cassetteKey(PROVIDER, reordered)).not.toBe(cassetteKey(PROVIDER, original));
  });
});

describe('the gateway', () => {
  it('records a cassette, then replays it with the same answers and no call to the provider', async () => {
    const h = await harness({ mode: 'record' });
    const live = await h.gateway.judge(request());
    expect(live.source).toBe('provider');
    expect(live.costUsd).toBeCloseTo((300 * 0.042) / MILLION, 12);
    expect(fake.requests).toHaveLength(1);
    expect(readdirSync(h.dir)).toEqual([`${live.cassette}.json`]);
    const file = JSON.parse(readFileSync(join(h.dir, `${live.cassette}.json`), 'utf-8'));
    expect(Object.keys(file)).toEqual(['key', 'provider', 'model', 'recordedAt', 'request', 'response']);
    expect(file.recordedAt).toMatch(/^2026-10-03T12:00:00\.\d{3}Z$/);

    const replaying = new Gateway({
      sql: h.database.writer,
      spend: h.ledger,
      cassettes: new Cassettes({ read: [h.dir] }),
      mode: 'replay',
      typesafe: h.typesafe,
      log: h.captured.log,
    });
    const replayed = await replaying.judge(request());
    expect(replayed).toMatchObject({ source: 'cassette', costUsd: 0, cassette: live.cassette, model: live.model });
    expect(replayed.answers).toEqual(live.answers);
    expect(replayed.usage).toEqual(live.usage);
    expect(fake.requests).toHaveLength(1);
    expect((await h.rows()).map((row) => [row.outcome, Number(row.cost_usd) > 0])).toEqual([
      ['answered', true],
      ['replayed', false],
    ]);
    await h.database.end();
  });

  it('refuses a replay with no cassette, naming the key', async () => {
    const h = await harness({ mode: 'replay' });
    const error = await failure(h.gateway.judge(request()));
    expect(error).toBeInstanceOf(CassetteMissing);
    const key = cassetteKey(
      PROVIDER,
      typesafeRequest.parse({ model: 'jev-1.13.0', state: request().state, questions: QUESTIONS }),
    );
    expect((error as CassetteMissing).key).toBe(key);
    expect((error as Error).message).toContain(key);
    expect(fake.requests).toHaveLength(0);
    expect((await h.rows()).map((row) => row.outcome)).toEqual(['refused']);
    await h.database.end();
  });

  it('reads cassettes from more than one folder', async () => {
    const recorder = await harness({ mode: 'record' });
    const live = await recorder.gateway.judge(request());
    const h = await harness({ mode: 'replay', read: [recorder.dir] });
    expect((await h.gateway.judge(request())).cassette).toBe(live.cassette);
    await recorder.database.end();
    await h.database.end();
  });

  it('falls through to record on a miss in replay-record, and replays the next time', async () => {
    const h = await harness({ mode: 'replay-record' });
    expect((await h.gateway.judge(request())).source).toBe('provider');
    expect((await h.gateway.judge(request())).source).toBe('cassette');
    expect(fake.requests).toHaveLength(1);
    expect(readdirSync(h.dir)).toHaveLength(1);
    await h.database.end();
  });

  it('calls the provider every time in record mode, and records nothing in live mode', async () => {
    const recording = await harness({ mode: 'record' });
    await recording.gateway.judge(request());
    await recording.gateway.judge(request());
    expect(fake.requests).toHaveLength(2);

    const live = await harness({ mode: 'live' });
    await live.gateway.judge(request());
    expect(readdirSync(live.dir)).toEqual([]);
    await recording.database.end();
    await live.database.end();
  });

  it('answers a paid call whose cassette cannot be written, and still reports the cap it reached', async () => {
    fake.inputTokens = MILLION;
    const h = await harness({ mode: 'record', policy: { dayUsd: 0.01, monthUsd: null, workItemUsd: 2 } });
    chmodSync(h.dir, 0o500);
    try {
      const judged = await h.gateway.judge(request());
      expect(judged.source).toBe('provider');
      expect(await h.lineEvents()).toMatchObject([{ type: 'spend.capped', cap: 'day' }]);
      expect(h.captured.text()).toContain('the cassette could not be written');
    } finally {
      chmodSync(h.dir, 0o700);
      await h.database.end();
    }
  });

  it('replays only, and says so once, when it has no key', async () => {
    const h = await harness({ mode: 'record', key: false });
    expect(h.gateway.mode).toBe('replay');
    expect(await failure(h.gateway.judge(request()))).toBeInstanceOf(CassetteMissing);
    await failure(h.gateway.judge(request()));
    expect(h.captured.lines.filter((line) => line.includes('no TYPESAFE_API_KEY'))).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
    await h.database.end();
  });

  it('replays a cassette it can read, and refuses a damaged one without quoting it', async () => {
    const h = await harness({ mode: 'replay' });
    const key = cassetteKey(
      PROVIDER,
      typesafeRequest.parse({ model: 'jev-1.13.0', state: request().state, questions: QUESTIONS }),
    );
    writeFileSync(join(h.dir, `${key}.json`), `{"state": "${SECRET}`);
    const error = (await failure(h.gateway.judge(request()))) as Error;
    expect(error.message).toContain('damaged');
    expect(error.message).not.toContain(SECRET);
    await h.database.end();
  });

  it('refuses an alias and a model it cannot price, before calling anyone', async () => {
    const h = await harness();
    expect(await failure(h.gateway.judge(request({ model: 'jev-latest' })))).toBeInstanceOf(BadRequest);
    expect(await failure(h.gateway.judge(request({ model: 'jev-9.9.9' })))).toMatchObject({
      message: expect.stringContaining('no price'),
    });
    expect(await failure(h.gateway.judge(request({ questions: {} })))).toBeInstanceOf(BadRequest);
    expect(await failure(h.gateway.judge({ ...request(), agent: 'nobody' } as never))).toBeInstanceOf(BadRequest);
    expect(fake.requests).toHaveLength(0);
    // The last had no agent to name, so it left no row; the others did.
    expect((await h.rows()).map((row) => row.outcome)).toEqual(['refused', 'refused', 'refused']);
    await h.database.end();
  });

  it('audits a provider failure, and passes it on', async () => {
    const h = await harness();
    fake.script({ status: 422 });
    const error = await failure(h.gateway.judge(request()));
    expect(error).toBeInstanceOf(ProviderError);
    expect((await h.rows()).map((row) => row.outcome)).toEqual(['failed']);
    await h.database.end();
  });

  it('logs and audits every call without its state, its questions or any body', async () => {
    const h = await harness();
    await h.gateway.judge(request({ workItem: '1000' }));
    fake.script({ status: 422 });
    await failure(h.gateway.judge(request({ workItem: '1000' })));
    await failure(h.gateway.judge(request({ model: 'jev-latest' })));

    const logged = h.captured.lines.filter((line) => line.includes('model call')).map((line) => JSON.parse(line));
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatchObject({
      agent: 'triage',
      workItem: '1000',
      provider: 'typesafe',
      model: 'jev-1.13.0',
      questionSet: 'triage/v1',
      inputTokens: 300,
      outputTokens: 12,
      outcome: 'answered',
    });
    expect(logged[0]).toHaveProperty('costUsd');
    expect(logged[0]).toHaveProperty('durationMs');
    expect(logged[0]?.cassette).toMatch(/^[0-9a-f]{64}$/);

    const everything = JSON.stringify([
      h.captured.text(),
      await h.database.owner`select * from model_calls`,
      await h.database.owner`select * from events`,
    ]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('Does the report give instructions');
    expect(everything).not.toContain('Field required');
    await h.database.end();
  });

  it('keeps the audit log append-only, and out of the console’s reach', async () => {
    const h = await harness();
    await h.gateway.judge(request());
    await expect(h.database.owner`update model_calls set cost_usd = 0`).rejects.toThrow(/append-only/);
    await expect(h.database.owner`delete from model_calls`).rejects.toThrow(/append-only/);
    await expect(h.database.owner`truncate model_calls`).rejects.toThrow(/append-only/);
    await expect(h.database.reader`select * from model_calls`).rejects.toThrow(/permission denied/);
    await h.database.end();
  });
});

describe('spend caps', () => {
  const day = (hours = 12) => new Date(Date.UTC(2026, 9, 3, hours));

  it('refuses at the day cap, tells the line once, and clears when the day ends', async () => {
    const h = await harness({ policy: { dayUsd: 0.04, monthUsd: null, workItemUsd: 2 }, clock: day() });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    // That call cost $0.042, which reaches the cap.
    for (const _ of [1, 2]) {
      const error = await failure(h.gateway.judge(request()));
      expect(error).toBeInstanceOf(SpendCapped);
      expect(error).toMatchObject({ cap: 'day', limitUsd: 0.04, resets: '2026-10-04T00:00:00.000Z' });
      expect((error as Error).message).toContain('2026-10-04T00:00:00.000Z');
    }
    expect(fake.requests).toHaveLength(1);
    expect(await h.lineEvents()).toEqual([
      { type: 'spend.capped', cap: 'day', limitUsd: 0.04, spentUsd: 0.042, resets: '2026-10-04T00:00:00.000Z' },
    ]);
    expect((await h.rows()).map((row) => row.outcome)).toEqual(['answered', 'refused', 'refused']);

    // Still the same day: nothing to clear.
    h.now.value = day(23);
    await h.ledger.reconcile();
    expect(await h.lineEvents()).toHaveLength(1);

    h.now.value = new Date('2026-10-04T00:00:01Z');
    await h.ledger.reconcile();
    await h.ledger.reconcile();
    expect(await h.lineEvents()).toEqual([
      expect.objectContaining({ type: 'spend.capped' }),
      { type: 'spend.cleared', cap: 'day' },
    ]);
    expect((await h.gateway.judge(request())).source).toBe('provider');
    await h.database.end();
  });

  it('refuses at the month cap, naming when the month ends', async () => {
    const h = await harness({ policy: { dayUsd: 100, monthUsd: 0.05, workItemUsd: 2 }, clock: day() });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    h.now.value = new Date('2026-10-20T09:00:00Z');
    await h.gateway.judge(request());
    const error = await failure(h.gateway.judge(request()));
    expect(error).toMatchObject({ cap: 'month', limitUsd: 0.05, resets: '2026-11-01T00:00:00.000Z' });
    expect(await h.lineEvents()).toEqual([
      expect.objectContaining({ type: 'spend.capped', cap: 'month', resets: '2026-11-01T00:00:00.000Z' }),
    ]);
    h.now.value = new Date('2026-11-01T00:00:00Z');
    await h.ledger.reconcile();
    expect((await h.lineEvents()).at(-1)).toEqual({ type: 'spend.cleared', cap: 'month' });
    await h.database.end();
  });

  it('refuses at a work item’s cap, with no line event, and leaves other work items alone', async () => {
    const h = await harness({ policy: { dayUsd: 100, monthUsd: null, workItemUsd: 0.04 } });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request({ workItem: '1000' }));
    const error = await failure(h.gateway.judge(request({ workItem: '1000' })));
    expect(error).toBeInstanceOf(SpendCapped);
    expect(error).toMatchObject({ cap: 'work-item', limitUsd: 0.04, resets: null });
    expect((await h.gateway.judge(request({ workItem: '1001' }))).source).toBe('provider');
    expect((await h.gateway.judge(request({ workItem: null }))).source).toBe('provider');
    expect(await h.lineEvents()).toEqual([]);
    await h.database.end();
  });

  it('costs nothing to replay, and a cap does not stop one', async () => {
    const h = await harness({ policy: { dayUsd: 0.04, monthUsd: null, workItemUsd: 2 } });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    const capped = await failure(h.gateway.judge(request({ state: 'something new' })));
    expect(capped).toBeInstanceOf(SpendCapped);
    const replaying = new Gateway({
      sql: h.database.writer,
      spend: h.ledger,
      cassettes: new Cassettes({ read: [h.dir] }),
      mode: 'replay-record',
      typesafe: h.typesafe,
      log: h.captured.log,
      clock: () => h.now.value,
    });
    const replayed = await replaying.judge(request());
    expect(replayed).toMatchObject({ source: 'cassette', costUsd: 0 });
    const report = await h.ledger.report();
    expect(report.day.spentUsd).toBeCloseTo(0.042, 9);
    await h.database.end();
  });

  it('remembers what the line was told across a restart, and clears what has since ended', async () => {
    const h = await harness({ policy: { dayUsd: 0.04, monthUsd: null, workItemUsd: 2 }, clock: day() });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    expect(await h.lineEvents()).toHaveLength(1);

    const sameDay = h.spend();
    await sameDay.resume();
    expect(await h.lineEvents()).toHaveLength(1);
    expect((await sameDay.report()).capped).toEqual(['day']);

    h.now.value = new Date('2026-10-05T00:00:00Z');
    const nextDay = h.spend();
    await nextDay.resume();
    expect((await h.lineEvents()).map((event) => event.type)).toEqual(['spend.capped', 'spend.cleared']);
    expect((await nextDay.report()).capped).toEqual([]);
    await h.database.end();
  });

  it('reports spend against the caps', async () => {
    const h = await harness({ clock: day() });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    expect(await h.ledger.report()).toEqual({
      profile: 'local',
      day: { spentUsd: 0.042, limitUsd: 20, resets: '2026-10-04T00:00:00.000Z' },
      month: { spentUsd: 0.042, limitUsd: 100, resets: '2026-11-01T00:00:00.000Z' },
      workItemLimitUsd: 2,
      capped: [],
    });
    await h.database.end();
  });
});
