import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequest, ProviderError } from '../../src/gateway/errors.ts';
import { retryAfterMs, TypeSafe, type TypeSafeOptions } from '../../src/gateway/typesafe.ts';
import { capturingLog, type FakeTypeSafe, fakeTypeSafe, request, SECRET } from './helpers.ts';

let fake: FakeTypeSafe;
beforeAll(async () => {
  fake = await fakeTypeSafe();
});
afterAll(() => fake.close());

const { model, state, questions } = request();
const sent = { model, state, questions };

/** An adapter that waits for no one, and records how long it would have waited. */
function adapter(options: Partial<TypeSafeOptions> = {}) {
  const sleeps: number[] = [];
  const captured = capturingLog();
  const typesafe = new TypeSafe({
    apiKey: 'test-key',
    baseUrl: fake.url,
    log: captured.log,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
    ...options,
  });
  fake.requests.length = 0;
  return { typesafe, sleeps, captured };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was meant to fail.');
};

describe('the TypeSafe adapter', () => {
  it('asks the questions with the key, and returns the checked answers and the body as it came', async () => {
    const { typesafe } = adapter();
    const { response, body } = await typesafe.judge(sent);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.authorization).toBe('Bearer test-key');
    expect(fake.requests[0]?.body).toEqual(sent);
    expect(response.answers.injection).toEqual({ type: 'noul', noul: 0.04 });
    expect(response.usage).toEqual({ input_tokens: 300, output_tokens: 12 });
    expect(JSON.parse(body)).toMatchObject({ model: 'jev-1.13.0' });
  });

  it('retries a 429, waiting as long as Retry-After asks', async () => {
    const { typesafe, sleeps } = adapter();
    fake.script({ status: 429, headers: { 'retry-after': '2' } });
    await typesafe.judge(sent);
    expect(fake.requests).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('reads a Retry-After that is an HTTP date, and never waits more than 30 seconds', async () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(retryAfterMs(new Date(now + 5000).toUTCString(), now)).toBe(5000);
    expect(retryAfterMs(new Date(now - 5000).toUTCString(), now)).toBe(0);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();

    const { typesafe, sleeps } = adapter({ now: () => now });
    fake.script({ status: 429, headers: { 'retry-after': new Date(now + 3000).toUTCString() } });
    fake.script({ status: 429, headers: { 'retry-after': '600' } });
    await typesafe.judge(sent);
    expect(sleeps).toEqual([3000, 30_000]);
  });

  it('retries a 529 and a 5xx with exponential backoff and jitter', async () => {
    const { typesafe, sleeps } = adapter({ random: () => 1 });
    fake.script({ status: 529 }, { status: 503 }, { status: 500 });
    await typesafe.judge(sent);
    expect(fake.requests).toHaveLength(4);
    // The ceiling doubles from 500 ms; the wait is somewhere between half of it and all of it.
    expect(sleeps).toEqual([500, 1000, 2000]);

    const { typesafe: unlucky, sleeps: least } = adapter({ random: () => 0 });
    fake.script({ status: 529 }, { status: 503 }, { status: 500 });
    await unlucky.judge(sent);
    expect(least).toEqual([250, 500, 1000]);
  });

  it('gives up after three retries, saying what kind of failure it was', async () => {
    const { typesafe, sleeps } = adapter();
    fake.script({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    const error = await failure(typesafe.judge(sent));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'server', status: 503 });
    expect(fake.requests).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
  });

  it.each([400, 401, 404, 422])('does not retry a %i', async (status) => {
    const { typesafe, sleeps } = adapter();
    fake.script({ status });
    expect(await failure(typesafe.judge(sent))).toMatchObject({ kind: 'rejected', status });
    expect(fake.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('times out, and retries a timeout', async () => {
    const { typesafe } = adapter({ timeoutMs: 50, maxRetries: 1 });
    fake.script('hang', 'hang');
    expect(await failure(typesafe.judge(sent))).toMatchObject({ kind: 'timeout' });
    expect(fake.requests).toHaveLength(2);
  });

  it('retries a dropped connection', async () => {
    const { typesafe } = adapter();
    fake.script('drop');
    await typesafe.judge(sent);
    expect(fake.requests).toHaveLength(2);
    const { typesafe: giving } = adapter({ maxRetries: 0 });
    fake.script('drop');
    expect(await failure(giving.judge(sent))).toMatchObject({ kind: 'network' });
  });

  it('never puts a 422, which echoes the request, in an error or a log line', async () => {
    const { typesafe, captured } = adapter();
    fake.script({ status: 422 });
    const error = (await failure(typesafe.judge(sent))) as ProviderError;
    // The stand-in's 422 does echo the request, as TypeSafe's does.
    expect(JSON.stringify(sent)).toContain(SECRET);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('Field required');
    expect(JSON.stringify({ ...error, message: error.message, stack: error.stack })).not.toContain(SECRET);
    expect(captured.text()).not.toContain(SECRET);
    expect(captured.text()).not.toContain('Bearer');
    expect(captured.text()).not.toContain('test-key');
  });

  it('logs a retry without the response', async () => {
    const { typesafe, captured } = adapter();
    fake.script({ status: 500, body: { detail: SECRET } });
    await typesafe.judge(sent);
    expect(captured.text()).toContain('"retry":1');
    expect(captured.text()).not.toContain(SECRET);
  });

  it('refuses a response that does not match the documented shape, without quoting it', async () => {
    const { typesafe } = adapter();
    fake.script({ status: 200, body: { model, answers: { category: { type: 'choice', choice: SECRET } }, usage: {} } });
    const error = await failure(typesafe.judge(sent));
    expect(error).toMatchObject({ kind: 'malformed' });
    expect((error as Error).message).not.toContain(SECRET);
    expect(fake.requests).toHaveLength(1);
  });

  it('refuses a response that names another model, or that answers other questions, or a choice not offered', async () => {
    const { typesafe } = adapter();
    const good = (await typesafe.judge(sent)).response;
    const mutated = (change: (r: typeof good) => unknown) => change(structuredClone(good));
    const cases = [
      mutated((r) => ({ ...r, model: 'jev-1.14.0' })),
      mutated((r) => ({ ...r, answers: { ...r.answers, extra: r.answers.injection } })),
      mutated((r) => ({ ...r, answers: { ...r.answers, injection: r.answers.severity } })),
      mutated((r) => ({ ...r, answers: { ...r.answers, category: { ...r.answers.category, choice: 'constructor' } } })),
    ];
    for (const body of cases) {
      fake.script({ status: 200, body });
      expect(await failure(typesafe.judge(sent))).toMatchObject({ kind: 'malformed' });
    }
  });

  it('refuses an alias, and a request TypeSafe would refuse, before sending anything', async () => {
    const { typesafe } = adapter();
    expect(await failure(typesafe.judge({ ...sent, model: 'jev-latest' }))).toBeInstanceOf(BadRequest);
    expect(await failure(typesafe.judge({ ...sent, questions: {} }))).toBeInstanceOf(BadRequest);
    expect(await failure(typesafe.judge({ ...sent, questions: { q: { type: 'ask' } } }))).toBeInstanceOf(BadRequest);
    expect(fake.requests).toHaveLength(0);
  });
});
