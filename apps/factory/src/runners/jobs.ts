/**
 * A runner's Kubernetes objects, in the `runners` namespace: a volume per work item, and two Jobs per step.
 *
 * - The volume lives as long as the work item, so the checkout, its dependencies and the agent's session are there
 *   for the next step: the coder resumes its own session after review.
 * - The prepare Job checks out the commit and installs it. Its pod may reach GitHub and the npm registry.
 * - The agent Job runs the agent. Its pod reaches the gateway and the line's handback, and nothing else; it holds its
 *   job token, which is not a credential anywhere else.
 *
 * Both run the `factory-runner` image under the restricted Pod Security Standard, with no service account token and
 * a read-only root file system, and each has a deadline.
 */
import type { Step } from '../../../runner/src/step.ts';

export const NAMESPACE = 'runners';
const LABEL = 'factory.mrogan.dev';

export interface JobNames {
  /** The step's job, such as `coder-1001-2`: the agent, the work item and the round. */
  job: string;
  workItem: string;
}

/** A Kubernetes name from parts: lower case, digits and dashes, and short enough. */
export const jobName = (agent: string, workItem: string, round: number) =>
  `${agent}-${workItem}-${round}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 52);

export const volumeName = (workItem: string) => `work-${workItem}`;

export function volume(workItem: string) {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: volumeName(workItem),
      namespace: NAMESPACE,
      labels: { 'app.kubernetes.io/part-of': 'software-factory', [`${LABEL}/work-item`]: workItem },
    },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '2Gi' } } },
  };
}

export interface JobSettings {
  image: string;
  /** How long the pod may run, in seconds. */
  deadlineSeconds: number;
}

export interface AgentSettings extends JobSettings {
  gatewayUrl: string;
  handbackUrl: string;
  token: string;
}

const env = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));

function job(names: JobNames, part: 'prepare' | 'agent', settings: JobSettings, variables: Record<string, string>) {
  const labels = {
    'app.kubernetes.io/part-of': 'software-factory',
    'app.kubernetes.io/component': 'runner',
    [`${LABEL}/runner`]: part,
    [`${LABEL}/work-item`]: names.workItem,
    [`${LABEL}/job`]: names.job,
  };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: `${names.job}-${part}`, namespace: NAMESPACE, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: settings.deadlineSeconds,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            fsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: part,
              image: settings.image,
              args: [part],
              env: env({
                WORK: '/work',
                HOME: '/work/home',
                COREPACK_HOME: '/work/corepack',
                npm_config_store_dir: '/work/pnpm-store',
                ...variables,
              }),
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: { requests: { cpu: '100m', memory: '512Mi' }, limits: { memory: '2Gi' } },
              volumeMounts: [
                { name: 'work', mountPath: '/work' },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'work', persistentVolumeClaim: { claimName: volumeName(names.workItem) } },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
}

export const prepareJob = (names: JobNames, step: Step, settings: JobSettings) =>
  job(names, 'prepare', settings, { RUNNER_STEP: JSON.stringify(step) });

export const agentJob = (names: JobNames, step: Step, settings: AgentSettings) =>
  job(names, 'agent', settings, {
    RUNNER_STEP: JSON.stringify(step),
    ANTHROPIC_BASE_URL: settings.gatewayUrl,
    // Its job token, where the Agent SDK looks for a key. The gateway and the handback take it, while the job runs.
    ANTHROPIC_API_KEY: settings.token,
    HANDBACK_URL: settings.handbackUrl,
  });
