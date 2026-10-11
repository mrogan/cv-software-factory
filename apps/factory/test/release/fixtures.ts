/**
 * The app's Rollout and its AnalysisRuns, as Argo Rollouts writes them on the local cluster: 25% for three minutes,
 * then a step analysis; 50% for three minutes, then another; and a background analysis throughout. Each builder takes
 * the state a test needs and fills in the rest as the cluster has it.
 */
import { type AnalysisRun, analysisRunSchema, type Rollout, rolloutSchema } from '../../src/release/read.ts';

export const STABLE = '7fc778d748';
export const CANARY = '68ff668868';
export const digestOf = (hash: string) => `sha256:${hash.padEnd(64, '0')}`;
export const commitOf = (hash: string) => hash.padEnd(40, 'c');

const STEPS = [
  { setWeight: 25 },
  { pause: { duration: '3m' } },
  { analysis: { templates: [{ templateName: 'website-step', clusterScope: true }] } },
  { setWeight: 50 },
  { pause: { duration: '3m' } },
  { analysis: { templates: [{ templateName: 'website-step', clusterScope: true }] } },
];

export interface RolloutState {
  /** The version the spec asks for. */
  current: string;
  stable: string;
  stepIndex?: number;
  abort?: boolean;
  /** The canary's weight now; by default the weight of its step, or nought when aborted or done. */
  weight?: number;
  conditions?: { type: string; status: string; reason?: string; message?: string }[];
}

export function rollout(state: RolloutState): Rollout {
  return rolloutSchema.parse({
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Rollout',
    metadata: { name: 'website', namespace: 'website', generation: 5 },
    spec: {
      replicas: 1,
      strategy: { canary: { canaryService: 'website-canary', stableService: 'website', steps: STEPS } },
      template: {
        spec: {
          containers: [{ name: 'website', image: `ghcr.io/mrogan/cv-worlds-worst-website@${digestOf(state.current)}` }],
        },
      },
    },
    status: {
      currentPodHash: state.current,
      stableRS: state.stable,
      currentStepIndex: state.stepIndex ?? (state.current === state.stable ? STEPS.length : 0),
      ...(state.abort ? { abort: true } : {}),
      canary: {
        weights: {
          canary: { podTemplateHash: state.current, weight: state.weight ?? 0 },
          stable: { podTemplateHash: state.stable, weight: 100 - (state.weight ?? 0) },
        },
      },
      conditions: state.conditions ?? [],
      phase: state.abort ? 'Degraded' : 'Progressing',
    },
  });
}

type Phase = 'Running' | 'Successful' | 'Failed' | 'Error' | 'Inconclusive';

export interface RunState {
  /** By default as Argo names it: the release, the Rollout's revision, and the step's index. */
  name?: string;
  hash?: string;
  stable?: string;
  /** A step run's index in the steps, or none for the background run. */
  step?: number;
  phase?: Phase;
  /** Each metric's phase and latest value, as Argo keeps it. */
  metrics?: Record<string, { phase?: Phase; value?: string; message?: string }>;
  message?: string;
  created: string;
  completed?: string;
  terminate?: boolean;
}

const STEP_METRICS = {
  'enough-requests': { phase: 'Successful', value: '[223.5]' },
  errors: { phase: 'Successful', value: '[-0.0018]' },
  latency: { phase: 'Successful', value: '[-0.101]' },
  journeys: { phase: 'Successful' },
} as const;
const BACKGROUND_METRICS = {
  errors: { phase: 'Successful', value: '[-0.0003]' },
  latency: { phase: 'Successful', value: '[-0.095]' },
  journeys: { phase: 'Successful' },
} as const;
const CONDITIONS: Record<string, string> = {
  'enough-requests': 'result[0] >= 100',
  errors: 'len(result) == 0 || result[0] <= 0.01',
  latency: 'len(result) == 0 || result[0] <= 0',
};

export function run(state: RunState): AnalysisRun {
  const hash = state.hash ?? CANARY;
  const isStep = state.step !== undefined;
  const metrics = { ...(isStep ? STEP_METRICS : BACKGROUND_METRICS), ...state.metrics };
  const phase = state.phase ?? 'Successful';
  return analysisRunSchema.parse({
    metadata: {
      name: state.name ?? `website-${hash}-4${isStep ? `-${state.step}` : ''}`,
      namespace: 'website',
      creationTimestamp: state.created,
      labels: {
        'rollout-type': isStep ? 'Step' : 'Background',
        'rollouts-pod-template-hash': hash,
        ...(isStep ? { 'step-index': String(state.step) } : {}),
      },
      ownerReferences: [{ apiVersion: 'argoproj.io/v1alpha1', kind: 'Rollout', name: 'website', uid: 'u' }],
    },
    spec: {
      args: [
        { name: 'stable-hash', value: state.stable ?? STABLE },
        { name: 'canary-hash', value: hash },
      ],
      metrics: Object.keys(metrics).map((name) => ({
        name,
        ...(CONDITIONS[name] ? { successCondition: CONDITIONS[name] } : {}),
        failureLimit: isStep ? 0 : 1,
      })),
      ...(state.terminate ? { terminate: true } : {}),
    },
    status: {
      phase,
      startedAt: state.created,
      ...(state.completed ? { completedAt: state.completed } : {}),
      ...(state.message ? { message: state.message } : {}),
      metricResults: Object.entries(metrics).map(([name, m]) => ({
        name,
        phase: m.phase ?? 'Successful',
        count: 1,
        ...('message' in m && m.message ? { message: m.message } : {}),
        measurements: [
          {
            phase: m.phase ?? 'Successful',
            startedAt: state.created,
            finishedAt: state.completed ?? state.created,
            ...('value' in m && m.value ? { value: m.value } : {}),
          },
        ],
      })),
    },
  });
}
