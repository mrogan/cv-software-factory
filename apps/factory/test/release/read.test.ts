import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { type AnalysisRun, journeysCounted } from '../../src/release/read.ts';
import type { Kube } from '../../src/runners/kube.ts';
import { run } from './fixtures.ts';

/** Kubernetes holding one journeys Job's pod, whose container has ended with `message`, or is still running (null). */
function kubeWith(job: string, message: string | null | undefined): Kube {
  return {
    async get<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
      if (path !== `/api/v1/namespaces/website/pods?labelSelector=${encodeURIComponent(`job-name=${job}`)}`) {
        return schema.parse({ items: [] });
      }
      const state = message === null ? { running: {} } : { terminated: { message } };
      const items = message === undefined ? [] : [{ status: { containerStatuses: [{ name: 'journeys', state }] } }];
      return schema.parse({ items });
    },
    create: () => Promise.reject(new Error('The release watch changes nothing')),
    remove: () => Promise.reject(new Error('The release watch changes nothing')),
  };
}

/** A step's run, whose journeys measure's Job was `job`. */
function stepRun(job: string): AnalysisRun {
  const step = run({ step: 2, created: '2026-10-11T09:00:00Z', completed: '2026-10-11T09:03:30Z' });
  const journeys = step.status.metricResults.find((m) => m.name === 'journeys');
  for (const m of journeys?.measurements ?? []) m.metadata = { 'job-name': job, 'job-namespace': 'website' };
  return step;
}

const JOB = 'uid-step.journeys.1';
const counted = { base: { passed: 41, ran: 48 }, change: { passed: 40, ran: 48 } };

describe('the journeys’ counts at a step', () => {
  it('reads each version’s, the canary’s as the change’s, from what the step’s Job wrote', async () => {
    const message = JSON.stringify({ regressions: [], counts: counted });
    expect(await journeysCounted(kubeWith(JOB, message), 'website', stepRun(JOB))).toEqual({
      canary: [40, 48],
      baseline: [41, 48],
    });
  });

  it('has none from an older gate’s message, a crashed gate, a Job still running or gone, or a run that names none', async () => {
    const older = JSON.stringify({ regressions: [] });
    for (const message of [older, 'Error: Chromium crashed', null, undefined]) {
      expect(await journeysCounted(kubeWith(JOB, message), 'website', stepRun(JOB))).toBeUndefined();
    }
    const unnamed = run({ step: 2, created: '2026-10-11T09:00:00Z', completed: '2026-10-11T09:03:30Z' });
    const message = JSON.stringify({ regressions: [], counts: counted });
    expect(await journeysCounted(kubeWith(JOB, message), 'website', unnamed)).toBeUndefined();
  });
});
