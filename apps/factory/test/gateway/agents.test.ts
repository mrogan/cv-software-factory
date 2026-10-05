import { mkdtempSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts, EventWriter, endJobToken, issueJobToken } from '@software-factory/store';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { SpendPolicy } from '../../../../policy/spend.ts';
import { AgentCassettes, keyedRequest } from '../../src/gateway/agent-cassettes.ts';
import { AgentCalls, usageOf } from '../../src/gateway/agents.ts';
import { Cassettes } from '../../src/gateway/cassettes.ts';
import { Gateway, type Mode } from '../../src/gateway/gateway.ts';
import { costOf } from '../../src/gateway/prices.ts';
import { ProviderCaps } from '../../src/gateway/provider-caps.ts';
import { Anthropic, capOf, LocalModels, type ProviderName } from '../../src/gateway/providers.ts';
import { createGatewayServer } from '../../src/gateway/server.ts';
import { Spend } from '../../src/gateway/spend.ts';
import { capturingLog } from './helpers.ts';

/** A stream as Anthropic sends one, with the usage split between its start and its last delta. */
const sse = (text: string) =>
  [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-sonnet-5-5',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 500,
            output_tokens: 1,
          },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');

type Step =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | 'drop'
  /** A stream as given, and then the connection dropped if `drop`. */
  | { sse: string; drop?: boolean };

/** A stand-in for Anthropic's Messages API (and LM Studio's, which is the same). */
async function fakeProvider() {
  const steps: Step[] = [];
  const requests: { headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    requests.push({ headers: req.headers, body });
    const step = steps.shift();
    if (step === 'drop') return void req.socket.destroy();
    if (step && 'sse' in step) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(step.sse);
      if (step.drop) return void setTimeout(() => res.destroy(), 20);
      return void res.end();
    }
    if (step) {
      res.writeHead(step.status, { 'content-type': 'application/json', ...step.headers });
      return void res.end(JSON.stringify(step.body));
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return void res.end(sse('Fixed.'));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'message',
        content: [{ type: 'text', text: 'Fixed.' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
    );
  };
  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    script: (...next: Step[]) => void steps.push(...next),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let provider: Awaited<ReturnType<typeof fakeProvider>>;
let database: Database;
let server: Server | undefined;
let url: string;
let cassettesDir: string;
let caps: ProviderCaps;
const captured = capturingLog();

beforeAll(async () => {
  provider = await fakeProvider();
});
afterAll(() => provider.close());
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await database?.end();
});

interface Options {
  mode?: Mode;
  policy?: SpendPolicy;
  allLocal?: boolean;
  local?: string;
}

async function start({
  mode = 'replay-record',
  policy = { dayUsd: 20, monthUsd: null, workItemUsd: 5 },
  allLocal = false,
  local,
}: Options = {}) {
  database = await freshDatabase('agents');
  cassettesDir = mkdtempSync(join(tmpdir(), 'cassettes-'));
  const sql = database.writer;
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) });
  const spend = new Spend({ sql, events, profile: 'local', policy, log: captured.log });
  const providers: Partial<Record<ProviderName, Anthropic | LocalModels>> = {
    anthropic: new Anthropic({ apiKey: 'sk-ant-real-key', base: provider.url }),
    local: new LocalModels({ base: local ?? provider.url }),
  };
  caps = new ProviderCaps({
    sql,
    events,
    log: captured.log,
    probe: async (name) => (await providers[name]?.send('/v1/messages', '{}', {}))?.ok ?? false,
  });
  const agents = new AgentCalls({
    sql,
    spend,
    caps,
    cassettes: new AgentCassettes({ record: cassettesDir }),
    mode,
    profile: 'local',
    allLocal,
    providers,
    log: captured.log,
  });
  const gateway = new Gateway({
    sql,
    spend,
    cassettes: new Cassettes({ record: cassettesDir }),
    mode,
    log: captured.log,
  });
  server = createGatewayServer({ gateway, agents, spend, log: captured.log });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = await issueJobToken(sql, { job: 'coder-1001-1', workItem: '1001', agent: 'coder' });
  return { sql, token, events };
}

/** A call as the Agent SDK makes one: the token where the key would be, and the API's version and betas. */
const call = (token: string, body: Record<string, unknown>, path = '/v1/messages') =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

const agentRequest = (day = '2026-10-04', session = 'a') => ({
  model: 'claude-opus-5-5',
  max_tokens: 32000,
  stream: true,
  metadata: { user_id: `session-${session}` },
  system: [{ type: 'text', text: `You are the coder. Today's date is ${day}.`, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'Fix the cart.' }],
});

describe('agents through the gateway', () => {
  it('refuses a call without the token of a running job', async () => {
    const { sql, token } = await start();
    expect((await call('sk-ant-guess', agentRequest())).status).toBe(401);
    await endJobToken(sql, 'coder-1001-1');
    const ended = await call(token, agentRequest());
    expect(ended.status).toBe(401);
    expect(await ended.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    expect(provider.requests).toHaveLength(0);
  });

  it('sends the policy’s model and effort with the real key, relays the stream, and audits and records the call', async () => {
    provider.requests.length = 0;
    const { sql, token } = await start();
    const response = await call(token, agentRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(await response.text()).toBe(sse('Fixed.'));

    const [sent] = provider.requests;
    expect(sent?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      output_config: { effort: 'medium' },
      max_tokens: 32000,
    });
    // The cache markers pass through as the runner wrote them.
    expect(sent?.body.system).toEqual(agentRequest().system);
    expect(sent?.headers['x-api-key']).toBe('sk-ant-real-key');
    expect(sent?.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    expect(JSON.stringify(sent?.headers)).not.toContain(token);

    const [row] = await sql`select * from model_calls`;
    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 2000,
      cacheWriteTokens: 500,
      cacheWriteHourTokens: 0,
    };
    expect(row).toMatchObject({
      agent: 'coder',
      work_item: '1001',
      job: 'coder-1001-1',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 2000,
      cache_write_tokens: 500,
      outcome: 'answered',
    });
    expect(Number(row?.cost_usd)).toBeCloseTo(costOf('claude-sonnet-5-5', usage), 8);
    expect(readdirSync(cassettesDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('replays the same step on another day, in another session, without asking the provider', async () => {
    provider.requests.length = 0;
    const { sql, token } = await start();
    await (await call(token, agentRequest('2026-10-04', 'a'))).text();
    const again = await call(token, agentRequest('2026-10-05', 'b'));
    expect(await again.text()).toBe(sse('Fixed.'));
    expect(provider.requests).toHaveLength(1);
    expect((await sql`select outcome, cost_usd from model_calls order by at`).map((r) => r.outcome)).toEqual([
      'answered',
      'replayed',
    ]);
    // A changed prompt is a new call, and pays.
    await (await call(token, { ...agentRequest(), messages: [{ role: 'user', content: 'Fix the till.' }] })).text();
    expect(provider.requests).toHaveLength(2);
  });

  it('refuses every agent call while the line is stopped', async () => {
    const { token, events } = await start();
    await events.append({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: null,
      type: 'line.stopped',
      version: 1,
      actor: 'martin',
      summary: 'The line stopped',
      payload: { reason: 'testing' },
      artifacts: [],
    });
    const response = await call(token, agentRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringMatching(/line is stopped/) } });
  });

  it('treats spent credit as a cap: it says so once, waits, and clears when the provider answers', async () => {
    provider.requests.length = 0;
    const { sql, token } = await start();
    provider.script({
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      },
    });
    const refused = await call(token, agentRequest());
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('300');
    // While capped, nothing more reaches the provider.
    expect((await call(token, agentRequest())).status).toBe(429);
    expect(provider.requests).toHaveLength(1);

    await caps.probe();
    expect((await call(token, agentRequest())).status).toBe(200);
    const lines = await sql`select type, version, payload from events where type like 'spend.%' order by seq`;
    expect(lines).toEqual([
      {
        type: 'spend.capped',
        version: 2,
        payload: {
          cap: 'provider',
          provider: 'anthropic',
          reason: 'credit',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      },
      { type: 'spend.cleared', version: 2, payload: { cap: 'provider', provider: 'anthropic' } },
    ]);
  });

  it('sends every agent to the local model when asked, and caps it when nothing is listening', async () => {
    const { sql, token } = await start({ allLocal: true, local: 'http://127.0.0.1:9' });
    const refused = await call(token, agentRequest());
    expect(refused.status).toBe(429);
    const [capped] = await sql`select payload from events where type = 'spend.capped'`;
    expect(capped?.payload).toMatchObject({ cap: 'provider', provider: 'local', reason: 'unreachable' });
    const [row] = await sql`select provider, model, outcome from model_calls`;
    expect(row).toEqual({ provider: 'local', model: 'qwen/qwen3.8-27b', outcome: 'failed' });
  });

  it('holds a work item at its cap, and does not retry it', async () => {
    const { sql, token } = await start({ policy: { dayUsd: 20, monthUsd: null, workItemUsd: 0.001 } });
    await (await call(token, agentRequest())).text();
    const response = await call(token, { ...agentRequest(), messages: [{ role: 'user', content: 'More.' }] });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { type: 'permission_error', message: expect.stringMatching(/work-item spend cap/) },
    });
    expect((await sql`select outcome from model_calls order by at`).map((r) => r.outcome)).toEqual([
      'answered',
      'refused',
    ]);
  });

  it('replays only, without a cassette, as an error the SDK does not retry', async () => {
    const { token } = await start({ mode: 'replay' });
    const response = await call(token, agentRequest());
    expect(response.status).toBe(400);
  });

  it('counts tokens with the provider, or estimates', async () => {
    const { token } = await start({ mode: 'replay' });
    const response = await call(
      token,
      { messages: [{ role: 'user', content: 'x'.repeat(400) }] },
      '/v1/messages/count_tokens',
    );
    expect(await response.json()).toEqual({ input_tokens: expect.any(Number) });
  });
});

describe('reading the provider', () => {
  it('reads usage from a whole response and from a stream', () => {
    expect(
      usageOf(JSON.stringify({ type: 'message', usage: { input_tokens: 5, output_tokens: 2 } }), false),
    ).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
    });
    expect(usageOf(sse('x'), true)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 2000,
      cacheWriteTokens: 500,
      cacheWriteHourTokens: 0,
    });
  });

  it('tells a cap the factory does not own from any other refusal', () => {
    const error = (type: string, message: string) => JSON.stringify({ type: 'error', error: { type, message } });
    expect(capOf(402, error('billing_error', 'Payment required'))?.reason).toBe('credit');
    expect(
      capOf(400, error('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'))?.reason,
    ).toBe('credit');
    expect(
      capOf(400, error('invalid_request_error', 'You have reached your specified workspace API usage limits.'))?.reason,
    ).toBe('workspace-limit');
    expect(capOf(429, error('rate_limit_error', 'Too many requests'))).toBeUndefined();
    expect(capOf(400, error('invalid_request_error', 'max_tokens: too large'))).toBeUndefined();
  });

  it('keys a step without its session or its date', () => {
    expect(keyedRequest(agentRequest('2026-10-04', 'a'))).toEqual(keyedRequest(agentRequest('2027-01-31', 'b')));
  });
});

/** A stream's events, written as Anthropic writes them. */
const events = (...list: [string, unknown][]) =>
  list.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

describe('what the gateway lets through', () => {
  it('refuses a beta it does not know, a server tool, and a field it does not take, before calling anyone', async () => {
    provider.requests.length = 0;
    const { token } = await start();
    const send = (body: unknown, beta = 'interleaved-thinking-2025-05-14') =>
      fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': token, 'anthropic-beta': beta, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const beta = await send(agentRequest(), 'interleaved-thinking-2025-05-14,web-fetch-2025-09-10');
    expect(beta.status).toBe(400);
    expect(await beta.json()).toMatchObject({ error: { message: expect.stringContaining('web-fetch-2025-09-10') } });
    const search = await send({ ...agentRequest(), tools: [{ type: 'web_search_20260209', name: 'web_search' }] });
    expect(search.status).toBe(400);
    expect((await send({ ...agentRequest(), service_tier: 'priority' })).status).toBe(400);
    expect(
      (await send({ ...agentRequest(), tools: [{ name: 'Bash', input_schema: { type: 'object' } }] })).status,
    ).toBe(200);
    expect(provider.requests).toHaveLength(1);
  });

  it('checks the token before it reads the body, and takes a Bearer token as well as a key', async () => {
    const { token } = await start();
    const stranger = await fetch(`${url}/v1/messages`, { method: 'POST', body: 'not json at all' });
    expect(stranger.status).toBe(401);
    const bearer = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(bearer.status).toBe(400);
    expect(await bearer.json()).toMatchObject({ error: { message: 'The body is not JSON.' } });
    const huge = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token },
      body: 'x'.repeat(33 * 1024 * 1024),
    });
    expect(huge.status).toBe(413);
  });
});

describe('what the provider answers', () => {
  it('a whole message, not streamed: relayed, audited and recorded', async () => {
    provider.requests.length = 0;
    const { sql, token } = await start();
    const response = await call(token, { ...agentRequest(), stream: false });
    expect(await response.json()).toMatchObject({ type: 'message', usage: { input_tokens: 10 } });
    const [row] = await sql`select input_tokens, output_tokens, outcome from model_calls`;
    expect(row).toEqual({ input_tokens: 10, output_tokens: 3, outcome: 'answered' });
  });

  it('counts an hour’s cache writes apart, and a delta’s nulls change nothing', async () => {
    const { sql, token } = await start();
    provider.script({
      sse: events(
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              type: 'message',
              usage: {
                input_tokens: 100,
                cache_read_input_tokens: 2000,
                cache_creation_input_tokens: 500,
                cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
                output_tokens: 1,
              },
            },
          },
        ],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: {
              output_tokens: 40,
              input_tokens: null,
              cache_read_input_tokens: null,
              cache_creation_input_tokens: null,
            },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ),
    });
    await (await call(token, agentRequest())).text();
    const [row] =
      await sql`select input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd from model_calls`;
    expect(row).toMatchObject({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 2000,
      cache_write_tokens: 500,
    });
    const usage = {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
      cacheWriteHourTokens: 500,
    };
    expect(Number(row?.cost_usd)).toBeCloseTo(costOf('claude-sonnet-5-5', usage), 8);
  });

  it('a stream that reports an error, or breaks off, is audited at what it cost, and keeps no cassette', async () => {
    const { sql, token } = await start();
    const start_ = [
      'message_start',
      { type: 'message_start', message: { type: 'message', usage: { input_tokens: 300, output_tokens: 1 } } },
    ] as [string, unknown];
    const delta = ['message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 25 } }] as [
      string,
      unknown,
    ];
    provider.script({
      sse: events(start_, delta, [
        'error',
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      ]),
    });
    await (await call(token, agentRequest())).text();
    provider.script({ sse: events(start_, delta), drop: true });
    await (await call(token, agentRequest('2026-10-06')).catch(() => undefined))?.text().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = await sql`select outcome, output_tokens, cost_usd from model_calls order by at`;
    expect(rows.map((r) => [r.outcome, r.output_tokens])).toEqual([
      ['failed', 25],
      ['failed', 25],
    ]);
    expect(rows.every((r) => Number(r.cost_usd) > 0)).toBe(true);
    expect(readdirSync(cassettesDir).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('passes a rate limit or an overload through with its retry-after, for the SDK to wait out', async () => {
    const { token } = await start();
    provider.script(
      {
        status: 429,
        body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
        headers: { 'retry-after': '12' },
      },
      { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } },
    );
    const limited = await call(token, agentRequest());
    expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '12']);
    expect((await call(token, agentRequest())).status).toBe(529);
  });
});
