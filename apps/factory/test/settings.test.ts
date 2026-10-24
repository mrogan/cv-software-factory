/**
 * Martin's settings within policy: the bounds (`policy/models.ts`, `policy/spend.ts`), the one check that turns a
 * settings event into the settings in force (`policy/settings.ts`), and the factory reading them from the store
 * (`src/settings.ts`), which takes only what his roles appended, and only what policy allows of it.
 */
import { issueJobToken } from '@software-factory/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../packages/store/test/database.ts';
import { EFFORTS, MODEL_AGENTS, MODELS } from '../../../policy/models.ts';
import { changesBetween, chosenOf, inForce } from '../../../policy/settings.ts';
import { CEILINGS, PROFILES, SPEND } from '../../../policy/spend.ts';
import { PRICES } from '../src/gateway/prices.ts';
import { stepCalls } from '../src/line/model-calls.ts';
import { lineSettings } from '../src/line/settings.ts';
import { highestWorkItemCap, latestChosen, SettingsReader } from '../src/settings.ts';
import { appendSettings, settingsPayload } from './settings-events.ts';

/**
 * What a price ranks a model by: what its calls cost, output first, as the gateway counts them, at its long prompt's
 * rate where it has one, so a model cheap only for short prompts cannot pass for cheaper than it is.
 */
const cost = (model: string) => {
  const price = PRICES[model];
  if (!price) throw new Error(`${model} has no price`);
  return (price.longPrompt?.times ?? 1) * (price.outputPerMillion * 1_000_000 + price.inputPerMillion);
};

describe('the bounds', () => {
  it('offer Claude Haiku, Sonnet and Opus on every profile, and Qwen where the profile has a local model', () => {
    for (const profile of PROFILES) {
      const models = MODELS[profile].models.map((m) => m.model);
      expect(models.filter((m) => m.startsWith('claude-'))).toEqual([
        'claude-haiku-5-5',
        'claude-sonnet-5-5',
        'claude-opus-5-5',
      ]);
      const local = MODELS[profile].local;
      expect(MODELS[profile].models.filter((m) => m.provider === 'local').map((m) => m.model)).toEqual(
        local ? [local.model] : [],
      );
    }
    expect(MODELS.local.local).toEqual({ model: 'qwen/qwen3.8-27b' });
    expect(MODELS.do.local).toBeNull();
    expect(MODELS.aws.local).toBeNull();
  });

  it('list each profile’s models cheapest first by the gateway’s prices, each priced, a local model first', () => {
    for (const profile of PROFILES) {
      const models = MODELS[profile].models;
      const costs = models.map((m) => cost(m.model));
      for (let i = 1; i < costs.length; i++) expect(costs[i], models[i]?.model).toBeGreaterThan(costs[i - 1] ?? 0);
      for (const m of models.filter((offered) => offered.provider === 'local')) expect(cost(m.model)).toBe(0);
    }
  });

  it('give each agent only models its profile offers, a most effort, and a default within them', () => {
    for (const profile of PROFILES) {
      const offered = MODELS[profile].models.map((m) => m.model);
      for (const agent of MODEL_AGENTS) {
        const bounds = MODELS[profile].agents[agent];
        expect(offered).toEqual(expect.arrayContaining([...bounds.models]));
        expect(bounds.models).toContain(bounds.default.model);
        expect(EFFORTS.indexOf(bounds.default.effort)).toBeLessThanOrEqual(EFFORTS.indexOf(bounds.maxEffort));
      }
    }
  });

  it('hold the figures Martin agreed: Sonnet at today’s efforts, up to high, and medium for the describer', () => {
    const agents = MODELS.local.agents;
    expect(Object.fromEntries(MODEL_AGENTS.map((a) => [a, [agents[a].default.effort, agents[a].maxEffort]]))).toEqual({
      planner: ['medium', 'high'],
      coder: ['medium', 'high'],
      reviewer: ['medium', 'high'],
      describer: ['low', 'medium'],
    });
    for (const agent of MODEL_AGENTS) expect(agents[agent].default.model).toBe('claude-sonnet-5-5');
  });

  it('keep the caps’ defaults, under ceilings of $25 a day, $250 a month and $10 a work item', () => {
    expect(SPEND).toEqual({
      local: { dayUsd: 20, monthUsd: null, workItemUsd: 1 },
      do: { dayUsd: 20, monthUsd: 100, workItemUsd: 1 },
      aws: { dayUsd: 20, monthUsd: 100, workItemUsd: 1 },
    });
    for (const profile of PROFILES) {
      expect(CEILINGS[profile]).toEqual({ dayUsd: 25, monthUsd: 250, workItemUsd: 10 });
      const defaults = SPEND[profile];
      expect(defaults.dayUsd).toBeLessThanOrEqual(CEILINGS[profile].dayUsd);
      expect(defaults.monthUsd ?? 0).toBeLessThanOrEqual(CEILINGS[profile].monthUsd);
      expect(defaults.workItemUsd).toBeLessThanOrEqual(CEILINGS[profile].workItemUsd);
    }
  });
});

describe('the settings in force', () => {
  it('are policy’s defaults with no settings event, and nothing outside policy', () => {
    const settings = inForce('local');
    expect(settings.outside).toEqual([]);
    expect(settings.agents.coder).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(settings.agents.describer).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' });
    expect(settings.caps).toEqual(SPEND.local);
    expect(inForce('do').caps).toEqual(SPEND.do);
  });

  it('are Martin’s choice where it is within policy, a local model with no effort', () => {
    const settings = inForce(
      'local',
      settingsPayload({
        agents: {
          coder: { model: 'claude-opus-5-5', effort: 'high' },
          reviewer: { model: 'qwen/qwen3.8-27b' },
          describer: { model: 'claude-haiku-5-5', effort: 'medium' },
        },
        caps: { dayUsd: 25, monthUsd: 250, workItemUsd: 10 },
      }),
    );
    expect(settings.outside).toEqual([]);
    expect(settings.agents.coder).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' });
    expect(settings.agents.reviewer).toEqual({ provider: 'local', model: 'qwen/qwen3.8-27b' });
    expect(settings.agents.describer).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium' });
    expect(settings.caps).toEqual({ dayUsd: 25, monthUsd: 250, workItemUsd: 10 });
  });

  it('give an agent left on a model no longer offered its default model, keep its effort, and say so', () => {
    // Claude Haiku 4.5 was offered until Haiku 5.5 took its place, so a store may hold a setting that names it.
    const settings = inForce(
      'local',
      settingsPayload({ agents: { coder: { model: 'claude-haiku-4-5', effort: 'low' } } }),
    );
    expect(settings.outside).toEqual(['coder.model']);
    expect(settings.agents.coder).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' });
    expect(settings.agents.reviewer).toEqual(inForce('local').agents.reviewer);
  });

  it('take policy’s default for each field outside it, whatever shape it has', () => {
    const outside = [
      // A model the profile does not offer, one nobody offers, and no model at all.
      { agents: { coder: { model: 'qwen/qwen3.8-27b', effort: 'medium' } }, profile: 'do', field: 'coder.model' },
      { agents: { coder: { model: 'claude-opus-9', effort: 'medium' } }, field: 'coder.model' },
      { agents: { coder: { model: 42, effort: 'medium' } }, field: 'coder.model' },
      { agents: { coder: { effort: 'medium' } }, field: 'coder.model' },
      { agents: { coder: 'claude-opus-5-5' }, field: 'coder.model', also: 'coder.effort' },
      // More effort than the agent's most, an effort that is none of Claude's, and none for a Claude model.
      { agents: { describer: { model: 'claude-sonnet-5-5', effort: 'high' } }, field: 'describer.effort' },
      { agents: { coder: { model: 'claude-sonnet-5-5', effort: 'max' } }, field: 'coder.effort' },
      { agents: { coder: { model: 'claude-sonnet-5-5', effort: 'ultra' } }, field: 'coder.effort' },
      { agents: { coder: { model: 'claude-sonnet-5-5' } }, field: 'coder.effort' },
      // Zero, below nothing, null where policy has a cap, not a number, not finite, above the ceiling.
      { caps: { dayUsd: 0 }, field: 'caps.dayUsd' },
      { caps: { dayUsd: -5 }, field: 'caps.dayUsd' },
      { caps: { dayUsd: null }, field: 'caps.dayUsd' },
      { caps: { dayUsd: '25' }, field: 'caps.dayUsd' },
      { caps: { dayUsd: Number.POSITIVE_INFINITY }, field: 'caps.dayUsd' },
      { caps: { dayUsd: Number.NaN }, field: 'caps.dayUsd' },
      { caps: { dayUsd: 25.01 }, field: 'caps.dayUsd' },
      { caps: { monthUsd: null }, profile: 'do', field: 'caps.monthUsd' },
      { caps: { monthUsd: 0 }, field: 'caps.monthUsd' },
      { caps: { monthUsd: 1e9 }, field: 'caps.monthUsd' },
      { caps: { workItemUsd: 0 }, field: 'caps.workItemUsd' },
      { caps: { workItemUsd: 11 }, field: 'caps.workItemUsd' },
      { caps: { workItemUsd: { usd: 5 } }, field: 'caps.workItemUsd' },
    ] as const;
    for (const { field, profile = 'local', also, ...over } of outside as readonly {
      field: string;
      profile?: 'local' | 'do';
      also?: string;
      agents?: Record<string, unknown>;
      caps?: Record<string, unknown>;
    }[]) {
      // Every other field as policy's defaults have it on the profile.
      const caps = { monthUsd: SPEND[profile].monthUsd, ...over.caps };
      const settings = inForce(profile, settingsPayload({ ...over, caps }));
      expect(settings.outside, JSON.stringify(over)).toEqual(also ? [field, also] : [field]);
      expect(settings.agents, JSON.stringify(over)).toEqual(inForce(profile).agents);
      expect(settings.caps, JSON.stringify(over)).toEqual(SPEND[profile]);
    }
  });

  it('take no effort for a local model, which LM Studio sets, and say one given for it is outside policy', () => {
    const settings = inForce(
      'local',
      settingsPayload({ agents: { coder: { model: 'qwen/qwen3.8-27b', effort: 'low' } } }),
    );
    expect(settings.agents.coder).toEqual({ provider: 'local', model: 'qwen/qwen3.8-27b' });
    expect(settings.outside).toEqual(['coder.effort']);
  });

  it('take every default from a payload that is not settings at all', () => {
    for (const payload of [null, 'opus everywhere', 42, [], { agents: [], caps: 'none' }, {}]) {
      const settings = inForce('do', payload);
      expect(settings.agents).toEqual(inForce('do').agents);
      expect(settings.caps).toEqual(SPEND.do);
    }
    expect(inForce('do', {}).outside).toContain('caps.dayUsd');
  });

  it('leave the month without a cap on local while Martin leaves it as policy’s default', () => {
    expect(inForce('local', settingsPayload({ caps: { monthUsd: null } }))).toMatchObject({
      caps: { monthUsd: null },
      outside: [],
    });
    expect(inForce('local', settingsPayload({ caps: { monthUsd: 120 } })).caps.monthUsd).toBe(120);
  });

  it('round-trip as a settings event carries them', () => {
    const settings = inForce('local', settingsPayload({ agents: { coder: { model: 'qwen/qwen3.8-27b' } } }));
    expect(inForce('local', chosenOf(settings))).toEqual(settings);
    expect(chosenOf(settings).agents.coder).toEqual({ model: 'qwen/qwen3.8-27b' });
  });
});

describe('a change of settings', () => {
  const with_ = (over: Parameters<typeof settingsPayload>[0]) => inForce('local', settingsPayload(over));
  const before = with_({});

  it('raises for a dearer model or more effort, and lowers for a cheaper one or less', () => {
    expect(
      changesBetween('local', before, with_({ agents: { coder: { model: 'claude-opus-5-5', effort: 'medium' } } })),
    ).toEqual({
      changes: [{ field: 'model', agent: 'coder', before: 'claude-sonnet-5-5', after: 'claude-opus-5-5' }],
      actions: ['agent.raise'],
    });
    expect(
      changesBetween('local', before, with_({ agents: { coder: { model: 'claude-sonnet-5-5', effort: 'high' } } }))
        .actions,
    ).toEqual(['agent.raise']);
    expect(
      changesBetween('local', before, with_({ agents: { coder: { model: 'claude-haiku-5-5', effort: 'low' } } }))
        .actions,
    ).toEqual(['agent.lower']);
  });

  it('puts a local model below every Claude model, with no effort', () => {
    const local = with_({ agents: { coder: { model: 'qwen/qwen3.8-27b' } } });
    expect(changesBetween('local', before, local)).toEqual({
      changes: [
        { field: 'model', agent: 'coder', before: 'claude-sonnet-5-5', after: 'qwen/qwen3.8-27b' },
        { field: 'effort', agent: 'coder', before: 'medium', after: null },
      ],
      actions: ['agent.lower'],
    });
    expect(
      changesBetween('local', local, with_({ agents: { coder: { model: 'claude-haiku-5-5', effort: 'low' } } })),
    ).toMatchObject({ actions: ['agent.raise'] });
  });

  it('raises a cap above its figure, and counts no cap above any', () => {
    expect(changesBetween('local', before, with_({ caps: { workItemUsd: 2 } }))).toEqual({
      changes: [{ field: 'cap', cap: 'work-item', beforeUsd: 1, afterUsd: 2 }],
      actions: ['caps.raise'],
    });
    const month = with_({ caps: { monthUsd: 100 } });
    expect(changesBetween('local', before, month).actions).toEqual(['caps.lower']);
    expect(changesBetween('local', month, before)).toEqual({
      changes: [{ field: 'cap', cap: 'month', beforeUsd: 100, afterUsd: null }],
      actions: ['caps.raise'],
    });
  });

  it('is each of what it does when it raises one thing and lowers another', () => {
    const mixed = with_({
      agents: { coder: { model: 'claude-opus-5-5', effort: 'low' } },
      caps: { dayUsd: 10 },
    });
    expect(changesBetween('local', before, mixed).actions.sort()).toEqual(['agent.lower', 'agent.raise', 'caps.lower']);
    expect(changesBetween('local', before, before)).toEqual({ changes: [], actions: [] });
  });
});

describe('the factory reading the settings', () => {
  let database: Database;
  beforeAll(async () => {
    database = await freshDatabase('settings');
  });
  afterAll(() => database?.end());

  it('reads the latest Martin’s roles appended, and holds what it reads to policy', async () => {
    const reader = (now = 0) => new SettingsReader(database.as.gateway, 'local', { clock: () => new Date(now) });
    expect(await reader().now()).toEqual(inForce('local'));
    // No worker may append one: row security refuses it.
    await expect(appendSettings(database.as.line, settingsPayload({ caps: { dayUsd: 25 } }))).rejects.toThrow(
      /row-level security/,
    );
    await appendSettings(
      database.operator,
      settingsPayload({ agents: { coder: { model: 'claude-opus-5-5', effort: 'high' } } }),
    );
    expect((await reader().now()).agents.coder).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    // One outside policy, from Martin's own role, so row security lets it in: it has no effect.
    await appendSettings(
      database.admin,
      settingsPayload({
        agents: { coder: { model: 'claude-opus-5-5', effort: 'max' }, reviewer: { model: 'gpt-9' } },
        caps: { dayUsd: 1e6, monthUsd: 0, workItemUsd: -1 },
      }),
    );
    const settings = await reader().now();
    expect(settings.outside.sort()).toEqual([
      'caps.dayUsd',
      'caps.monthUsd',
      'caps.workItemUsd',
      'coder.effort',
      'reviewer.effort',
      'reviewer.model',
    ]);
    expect(settings.agents.coder).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium' });
    expect(settings.agents.reviewer).toEqual(inForce('local').agents.reviewer);
    expect(settings.caps).toEqual(SPEND.local);
  });

  it('gives a job the settings in force when its token was issued, and keeps them for it', async () => {
    const db = await freshDatabase('settings_jobs');
    try {
      await appendSettings(
        db.admin,
        settingsPayload({ agents: { coder: { model: 'claude-haiku-5-5', effort: 'low' } } }),
      );
      await issueJobToken(db.as.line, { job: 'coder-1001-1', workItem: '1001', agent: 'coder' });
      await appendSettings(
        db.admin,
        settingsPayload({ agents: { coder: { model: 'claude-opus-5-5', effort: 'high' } } }),
      );
      const reader = new SettingsReader(db.as.gateway, 'local');
      expect((await reader.forJob('coder-1001-1'))?.agents.coder.model).toBe('claude-haiku-5-5');
      // A reader started since reads the same: what was in force as the job began.
      expect((await new SettingsReader(db.as.line, 'local').forJob('coder-1001-1'))?.agents.coder.model).toBe(
        'claude-haiku-5-5',
      );
      expect((await reader.now()).agents.coder.model).toBe('claude-opus-5-5');
      expect(await reader.forJob('no-such-job')).toBeUndefined();
      // A soak's spend is judged against the highest cap on a work item in force since it began.
      const since = new Date();
      expect(await highestWorkItemCap(db.as.line, 'local', since)).toBe(1);
      await appendSettings(db.admin, settingsPayload({ caps: { workItemUsd: 4 } }));
      await appendSettings(db.admin, settingsPayload({ caps: { workItemUsd: 2 } }));
      expect(await highestWorkItemCap(db.as.line, 'local', since)).toBe(4);
      expect(await highestWorkItemCap(db.as.line, 'local', new Date())).toBe(2);
      expect(await latestChosen(db.as.line, new Date(0))).toBeUndefined();

      // The line records the effort the gateway sent, read the same way; none for a local model, or under ALL_LOCAL.
      const line = lineSettings(new SettingsReader(db.as.line, 'local'), false);
      expect(await line.effortOf('coder-1001-1', 'coder')).toBe('low');
      expect(await lineSettings(new SettingsReader(db.as.line, 'local'), true).effortOf('coder-1001-1', 'coder')).toBe(
        undefined,
      );
      await db.as.gateway`
        insert into model_calls (id, agent, work_item, provider, model, question_set, input_tokens, output_tokens,
                                 cost_usd, duration_ms, outcome, job)
        values (${crypto.randomUUID()}, 'coder', '1001', 'anthropic', 'claude-haiku-5-5', 'messages', 10, 5, 0.001, 900,
                'answered', 'coder-1001-1')`;
      expect((await stepCalls(db.as.line, 'coder-1001-1', 'coder', 50, 'low'))?.settings).toEqual({
        effort: 'low',
        maxTurns: 50,
      });
      expect((await stepCalls(db.as.line, 'coder-1001-1', 'coder', 50))?.settings).toEqual({ maxTurns: 50 });
    } finally {
      await db.end();
    }
  });
});
