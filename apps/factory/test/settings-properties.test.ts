/**
 * Properties of the one check of Martin's settings (`policy/settings.ts`), over payloads fast-check makes up: mostly
 * settings, some fields within policy and some not, and now and then anything at all. `settings.test.ts` holds the
 * examples; these hold what must be true of every payload, since the check reads whatever a settings event says.
 *
 * A failure prints the seed and the shrunk payload that broke the property: `fc.assert(..., { seed, path })`
 * replays it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EFFORTS, MODEL_AGENTS, MODELS } from '../../../policy/models.ts';
import {
  CAP_NAMES,
  CAPS,
  type CapField,
  changesBetween,
  chosenOf,
  type InForce,
  inForce,
} from '../../../policy/settings.ts';
import { CEILINGS, PROFILES, type Profile, SPEND } from '../../../policy/spend.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const profile = fc.constantFrom(...PROFILES);

/** Every model any profile offers, so a model one profile offers is tried on another that does not. */
const anyModel = [...new Set(PROFILES.flatMap((p) => MODELS[p].models.map((m) => m.model)))];

const model = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...anyModel) },
  { weight: 1, arbitrary: fc.string() },
  { weight: 1, arbitrary: fc.anything() },
);
const effort = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...EFFORTS) },
  { weight: 1, arbitrary: fc.string() },
  { weight: 1, arbitrary: fc.anything() },
);
/** Figures either side of every ceiling and of nothing, and what is not a figure at all. */
const cap = fc.oneof(
  { weight: 4, arbitrary: fc.double({ min: -1, max: 300 }) },
  { weight: 2, arbitrary: fc.integer({ min: -1, max: 300 }) },
  { weight: 1, arbitrary: fc.double() },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.anything() },
);

/** Something like a settings event's payload, any field of which may be missing. */
const chosen = fc.oneof(
  {
    weight: 9,
    arbitrary: fc.record(
      {
        agents: fc.record(
          Object.fromEntries(MODEL_AGENTS.map((agent) => [agent, fc.record({ model, effort }, { requiredKeys: [] })])),
          { requiredKeys: [] },
        ),
        caps: fc.record(Object.fromEntries(CAPS.map((field) => [field, cap])), { requiredKeys: [] }),
      },
      { requiredKeys: [] },
    ),
  },
  { weight: 1, arbitrary: fc.anything() },
);

/** Settings in force on a profile, from a made-up payload. */
const settingsOn = (p: Profile) => chosen.map((payload) => inForce(p, payload));

const asked = (payload: unknown, path: string[]): unknown =>
  path.reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), payload);

describe('the settings in force, whatever the payload', () => {
  it('are within policy, field by field', () => {
    fc.assert(
      fc.property(profile, chosen, (p, payload) => {
        const { agents, caps } = inForce(p, payload);
        for (const agent of MODEL_AGENTS) {
          const bounds = MODELS[p].agents[agent];
          const given = agents[agent];
          expect(bounds.models).toContain(given.model);
          expect(MODELS[p].models.find((m) => m.model === given.model)?.provider).toBe(given.provider);
          if (given.provider === 'local') expect(given).not.toHaveProperty('effort');
          else expect(EFFORTS.indexOf(given.effort)).toBeLessThanOrEqual(EFFORTS.indexOf(bounds.maxEffort));
        }
        for (const field of CAPS) {
          const usd = caps[field];
          // No cap only where policy's own default is none: zero, null or anything else is never "no cap".
          if (usd === null) expect(SPEND[p][field]).toBeNull();
          else {
            expect(Number.isFinite(usd)).toBe(true);
            expect(usd).toBeGreaterThan(0);
            expect(usd).toBeLessThanOrEqual(CEILINGS[p][field]);
          }
        }
      }),
    );
  });

  it('are what Martin chose in every field they do not list as outside policy, and not in any they do', () => {
    fc.assert(
      fc.property(profile, chosen, (p, payload) => {
        const settings = inForce(p, payload);
        const fields = [
          ...MODEL_AGENTS.flatMap((agent) => [
            { name: `${agent}.model`, path: ['agents', agent, 'model'], value: settings.agents[agent].model },
            {
              name: `${agent}.effort`,
              path: ['agents', agent, 'effort'],
              value: 'effort' in settings.agents[agent] ? settings.agents[agent].effort : undefined,
            },
          ]),
          ...CAPS.map((field) => ({ name: `caps.${field}`, path: ['caps', field], value: settings.caps[field] })),
        ];
        // A payload that is not settings at all chose nothing, so nothing it chose is outside policy.
        if (!isRecord(payload)) {
          expect(settings.outside).toEqual([]);
          return;
        }
        for (const { name, path, value } of fields) {
          if (settings.outside.includes(name)) expect(asked(payload, path)).not.toBe(value);
          else expect(asked(payload, path)).toBe(value);
        }
      }),
    );
  });

  it('are in force as they are once saved: a settings event of them is wholly within policy', () => {
    fc.assert(
      fc.property(profile, chosen, (p, payload) => {
        const settings = inForce(p, payload);
        expect(inForce(p, chosenOf(settings))).toEqual({ ...settings, outside: [] });
      }),
    );
  });
});

/** The settings a change of settings leads to, applied to where it starts as a settings event. */
function applied(p: Profile, from: InForce, changes: ReturnType<typeof changesBetween>['changes']): InForce {
  const event = chosenOf(from);
  const fieldOf = Object.fromEntries(Object.entries(CAP_NAMES).map(([field, name]) => [name, field])) as Record<
    (typeof CAP_NAMES)[CapField],
    CapField
  >;
  for (const change of changes) {
    if (change.field === 'model') event.agents[change.agent].model = change.after;
    else if (change.field === 'effort') {
      if (change.after === null) delete event.agents[change.agent].effort;
      else event.agents[change.agent].effort = change.after;
    } else event.caps[fieldOf[change.cap]] = change.afterUsd as number;
  }
  return inForce(p, event);
}

const opposite = {
  'agent.raise': 'agent.lower',
  'agent.lower': 'agent.raise',
  'caps.raise': 'caps.lower',
  'caps.lower': 'caps.raise',
} as const;

describe('a change between any two settings in force', () => {
  const pair = profile.chain((p) => fc.tuple(fc.constant(p), settingsOn(p), settingsOn(p)));

  it('is nothing from settings to themselves', () => {
    fc.assert(
      fc.property(pair, ([p, before]) => {
        expect(changesBetween(p, before, before)).toEqual({ changes: [], actions: [] });
      }),
    );
  });

  it('names every field that changed: applied to where it starts, it gives where it ends', () => {
    fc.assert(
      fc.property(pair, ([p, before, after]) => {
        const { changes } = changesBetween(p, before, after);
        expect(applied(p, before, changes)).toEqual({ ...after, outside: [] });
      }),
    );
  });

  it('raises one way exactly where it lowers the other, so a raise is never passed off as a lowering', () => {
    fc.assert(
      fc.property(pair, ([p, before, after]) => {
        const there = changesBetween(p, before, after).actions;
        const back = changesBetween(p, after, before).actions;
        expect([...back].sort()).toEqual(there.map((action) => opposite[action]).sort());
      }),
    );
  });
});
