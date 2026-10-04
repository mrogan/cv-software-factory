/**
 * Starts the gateway: the store, the spend ledger, the cassettes, the provider and the HTTP server, wired from a
 * `GatewayConfig`. `factory gateway` is the entry point, and loads `telemetry.ts` before this module.
 */
import { tmpdir } from 'node:os';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import postgres from 'postgres';
import { MODELS } from '../../../../policy/models.ts';
import { SPEND } from '../../../../policy/spend.ts';
import { log } from '../log.ts';
import { AgentCassettes } from './agent-cassettes.ts';
import { AgentCalls, usageOf } from './agents.ts';
import { Cassettes } from './cassettes.ts';
import type { GatewayConfig } from './config.ts';
import { Gateway } from './gateway.ts';
import { costOf } from './prices.ts';
import { ProviderCaps } from './provider-caps.ts';
import { Anthropic, LocalModels, type MessagesProvider, type ProviderName } from './providers.ts';
import { createGatewayServer } from './server.ts';
import { Spend } from './spend.ts';
import { TypeSafe } from './typesafe.ts';

export async function startGateway(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env) {
  const options = { onnotice: () => {}, max: 4 };
  const sql = env.DATABASE_URL ? postgres(env.DATABASE_URL, options) : postgres(options);
  // The line events the gateway appends have no artifacts, so the store it is given is never read.
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(tmpdir()) });
  const spend = new Spend({ sql, events, profile: config.profile, policy: SPEND[config.profile], log });
  const typesafe = config.apiKey
    ? new TypeSafe({ apiKey: config.apiKey, log, ...(config.typesafeUrl ? { baseUrl: config.typesafeUrl } : {}) })
    : undefined;
  const gateway = new Gateway({
    sql,
    spend,
    cassettes: new Cassettes({ record: config.cassettesDir, read: config.cassettesRead }),
    mode: config.mode,
    typesafe,
    log,
  });
  // Agents' providers: Anthropic with the key, and the profile's local model, which needs none.
  const providers: Partial<Record<ProviderName, MessagesProvider>> = {};
  if (config.anthropicKey) {
    providers.anthropic = new Anthropic({
      apiKey: config.anthropicKey,
      ...(config.anthropicUrl ? { base: config.anthropicUrl } : {}),
    });
  }
  const local = MODELS[config.profile].local;
  if (local) providers.local = new LocalModels({ base: config.localModelsUrl });
  // A capped provider is asked one small question, a few minutes apart, until it answers.
  const probe = async (name: ProviderName) => {
    const provider = providers[name];
    if (!provider) return false;
    const model = name === 'local' && local ? local.model : 'claude-haiku-4-5';
    const response = await provider.send(
      '/v1/messages',
      JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with one word.' }] }),
      {},
      AbortSignal.timeout(30_000),
    );
    const usage = response.ok ? usageOf(await response.text(), false) : { inputTokens: 0, outputTokens: 0 };
    if (!response.ok) await response.body?.cancel();
    // Every call is audited and counted, the gateway's own included.
    await sql`
      insert into model_calls (id, agent, provider, model, question_set, input_tokens, output_tokens, cost_usd,
                               duration_ms, outcome)
      values (${crypto.randomUUID()}, 'gateway', ${name}, ${model}, 'probe', ${usage.inputTokens}, ${usage.outputTokens},
              ${response.ok ? costOf(model, usage) : 0}, 0, ${response.ok ? 'answered' : 'failed'})`;
    return response.ok;
  };
  const caps = new ProviderCaps({ sql, events, log, probe });
  const agents = new AgentCalls({
    sql,
    spend,
    caps,
    cassettes: new AgentCassettes({ record: config.cassettesDir, read: config.cassettesRead }),
    mode: config.mode,
    profile: config.profile,
    allLocal: config.allLocal,
    providers,
    log,
  });
  await spend.resume();
  spend.start();
  await caps.resume();
  caps.start();

  const server = createGatewayServer({ gateway, agents, spend, log });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  log.info(
    {
      port: config.port,
      mode: gateway.mode,
      profile: config.profile,
      agents: Object.keys(providers),
      allLocal: config.allLocal,
    },
    `gateway listening on :${config.port}`,
  );

  /** Finishes the requests in flight, then lets go of the store. */
  const stop = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await spend.stop();
    await caps.stop();
    await sql.end();
  };
  return { server, stop };
}
