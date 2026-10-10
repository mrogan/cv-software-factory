/**
 * Argo Rollouts' analysis of the app's canary, generated from the release policy (policy/release.ts).
 *
 *     node apps/factory/src/release/analysis.ts            # write the templates
 *     node apps/factory/src/release/analysis.ts --check    # fail if they are out of date (make check, CI)
 *
 * Two ClusterAnalysisTemplates, which the app's Rollout names:
 *
 * - `website-step`, at the end of each step: enough requests to judge, errors, latency and the journeys. A step whose
 *   canary has had too few requests fails, and says so.
 * - `website-background`, throughout the release: errors and latency, looked at every few minutes once the canary has
 *   had enough requests to judge.
 *
 * Canary and baseline are told apart by the pod-template hash Argo Rollouts gives each version, which the collector
 * adds to the app's metrics; the Rollout passes the two hashes as arguments. Each query sums over every route the app
 * named, so it does not depend on how the app names them, and compares shares and percentiles, not counts: the probes
 * and the crawler add requests to the baseline that the traffic split does not account for.
 *
 * The cluster-scoped templates live in this repository, deployed with the factory's images: nothing in the app's
 * repository can loosen them, and the journeys run on the same `factory-browser` the probes run, at the digest the
 * cluster pins (deploy/overlays/local/factory-image).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stringify } from 'yaml';
import { type Release, release } from '../../../../policy/release.ts';

export const TEMPLATES_FILE = join(import.meta.dirname, '../../../../deploy/base/analysis/templates.yaml');

/** The template names, as the app's Rollout refers to them. */
export const TEMPLATES = { step: 'website-step', background: 'website-background' } as const;

const PROMETHEUS = 'http://prometheus-server.telemetry';
const REQUESTS = 'http_server_request_duration_seconds';
/** The label the collector gives each record from the pod's `rollouts-pod-template-hash`. */
const HASH = 'k8s_pod_label_rollouts_pod_template_hash';

type Version = 'stable' | 'canary';

/**
 * The PromQL behind each measure, for one release policy. Each is written across lines, as the templates show it: a
 * version's figure on a line of its own.
 */
export function queries(r: Release) {
  const window = `[${r.windowMinutes}m]`;
  const of = (version: Version, extra = '') =>
    `{job="${r.app.metricsJob}", http_route!="", ${HASH}="{{args.${version}-hash}}"${extra}}`;
  const requests = (version: Version) => `sum(increase(${REQUESTS}_count${of(version)}${window}))`;
  const errorShare = (version: Version) =>
    `(sum(rate(${REQUESTS}_count${of(version, ', http_response_status_code=~"5.."')}${window})) or vector(0))\n` +
    `    / sum(rate(${REQUESTS}_count${of(version)}${window}))`;
  const latency = (version: Version) =>
    `histogram_quantile(${r.latency.percentile}, sum by (le) (rate(${REQUESTS}_bucket${of(version)}${window})))`;
  // Nothing is judged until the canary has had enough requests: the result is then empty, which passes. Once it has,
  // a baseline with nothing to compare (no series for its hash) is infinitely better than the canary, which fails.
  const judged = (expr: string) =>
    `(\n${expr}\nor on () vector(Inf)\n)\nand on () ${requests('canary')} >= ${r.minRequests}`;
  return {
    /** How many requests the canary answered in the window. */
    requests: `${requests('canary')} or vector(0)`,
    /** The canary's share of 5xx answers, less the baseline's. */
    errors: judged(`  (\n    ${errorShare('canary')}\n  )\n-\n  (\n    ${errorShare('stable')}\n  )`),
    /**
     * How far the canary's latency is past the most it may be: the baseline's, and a quarter more or 100 ms more,
     * whichever is more. Above nought fails.
     */
    latency: judged(
      `  ${latency('canary')}\n-\n  (\n    ${latency('stable')}\n    + clamp_min(${latency('stable')} * ${r.latency.maxRatioAbove}, ${r.latency.minSecondsAbove})\n  )`,
    ),
  };
}

const prometheus = (query: string) => ({ prometheus: { address: PROMETHEUS, query } });

/** Errors and latency, the measures from Prometheus, each passing when there is nothing yet to judge. */
function compared(r: Release) {
  const q = queries(r);
  return [
    { name: 'errors', successCondition: `len(result) == 0 || result[0] <= ${r.errors.maxAbove}`, query: q.errors },
    { name: 'latency', successCondition: 'len(result) == 0 || result[0] <= 0', query: q.latency },
  ];
}

const LABELS = { 'app.kubernetes.io/name': 'journeys', 'app.kubernetes.io/part-of': 'software-factory' };

/**
 * The journeys gate (`factory gate journeys`), as a Job in the app's namespace: the stable Service is the base and the
 * canary's the change, and the Job fails when a check that passes on the base fails on the change twice.
 */
function journeys(r: Release) {
  return {
    metadata: { labels: LABELS },
    spec: {
      // The gate runs a failing check again itself; a Job that fails has found something, or could not look.
      backoffLimit: 0,
      activeDeadlineSeconds: 900,
      template: {
        metadata: { labels: LABELS },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          // The restricted Pod Security Standard, which the namespace enforces. Chromium runs without its own sandbox,
          // as in the probes; the pod's fences hold instead.
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'journeys',
              // Pinned by digest with the factory's images (kustomize `images:`).
              image: 'factory-browser',
              args: ['src/cli.ts', 'gate', 'journeys', '--base', r.app.stable, '--change', r.app.canary],
              resources: { requests: { cpu: '200m', memory: '512Mi' }, limits: { memory: '2Gi' } },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'tmp', mountPath: '/tmp' },
                { name: 'shm', mountPath: '/dev/shm' },
              ],
            },
          ],
          volumes: [
            { name: 'tmp', emptyDir: {} },
            // Chromium keeps shared memory here, and the default 64Mi is too small for a page.
            { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
          ],
        },
      },
    },
  };
}

const ARGS = [{ name: 'stable-hash' }, { name: 'canary-hash' }];

function template(name: string, metrics: unknown[]) {
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'ClusterAnalysisTemplate',
    metadata: {
      name,
      // Argo Rollouts' kinds arrive with its Application, which may not have synced yet.
      annotations: { 'argocd.argoproj.io/sync-options': 'SkipDryRunOnMissingResource=true' },
    },
    spec: { args: ARGS, metrics },
  };
}

/** What each template is for, as a comment above it in the file. */
const PURPOSE: Record<string, (r: Release) => string> = {
  [TEMPLATES.step]: () =>
    'At the end of each step: enough requests to judge, then errors, latency and the journeys against the baseline.',
  [TEMPLATES.background]: (r) =>
    `Throughout the release: errors and latency against the baseline, every ${r.background.intervalMinutes}m once there is enough to judge.`,
};

/** The two templates, as Kubernetes objects. */
export function templatesFor(r: Release) {
  const q = queries(r);
  const step = template(TEMPLATES.step, [
    {
      name: 'enough-requests',
      successCondition: `result[0] >= ${r.minRequests}`,
      failureLimit: 0,
      provider: prometheus(q.requests),
    },
    ...compared(r).map(({ name, successCondition, query }) => ({
      name,
      successCondition,
      failureLimit: 0,
      provider: prometheus(query),
    })),
    { name: 'journeys', failureLimit: 0, provider: { job: journeys(r) } },
  ]);
  const background = template(
    TEMPLATES.background,
    compared(r).map(({ name, successCondition, query }) => ({
      name,
      interval: `${r.background.intervalMinutes}m`,
      successCondition,
      failureLimit: r.background.failures - 1,
      provider: prometheus(query),
    })),
  );
  return [step, background];
}

/** The templates file's text. */
export function render(r: Release): string {
  const header = `# Generated from policy/release.ts by apps/factory/src/release/analysis.ts. Do not edit it: change the policy, then
# run \`node apps/factory/src/release/analysis.ts\`. \`make check\` fails when this file is out of date.
`;
  const documents = templatesFor(r).map(
    (t) => `---\n# ${PURPOSE[t.metadata.name]?.(r)}\n${stringify(t, { lineWidth: 0, aliasDuplicateObjects: false })}`,
  );
  return header + documents.join('');
}

/** Whether the file holds something other than what the policy calls for. */
export function outOfDate(r: Release, file: string = TEMPLATES_FILE): boolean {
  try {
    return readFileSync(file, 'utf8') !== render(r);
  } catch {
    return true;
  }
}

if (import.meta.main) {
  const where = relative(process.cwd(), TEMPLATES_FILE);
  if (process.argv.includes('--check')) {
    if (outOfDate(release)) {
      console.error(`${where} is out of date with policy/release.ts. Run: node apps/factory/src/release/analysis.ts`);
      process.exit(1);
    }
    console.log(`${where} is current.`);
  } else {
    writeFileSync(TEMPLATES_FILE, render(release));
    console.log(`Wrote ${where}.`);
  }
}
