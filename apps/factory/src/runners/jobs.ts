/**
 * A runner's Kubernetes objects, in the `runners` namespace: a volume per work item, and two Jobs per step.
 *
 * - The volume lives as long as the work item, so the checkout, its dependencies and the agent's session are there
 *   for the next step: the coder resumes its own session after review.
 * - The prepare Job checks out the commit and installs it. Its pod may reach GitHub and the npm registry, so it keeps
 *   its home, its settings and pnpm's store in an empty folder of its own, and runs nothing the agent could have left
 *   on the volume (apps/runner/src/prepare.ts).
 * - The agent Job runs the agent. Its pod reaches the gateway and the line's handback, and nothing else, and has no
 *   DNS; it holds its job token, which is not a credential anywhere else.
 * - The volume goes when the work item is over (`Runners.finish`).
 *
 * Both run the `factory-runner` image under the restricted Pod Security Standard, with no service account token and
 * a read-only root file system, and each has a deadline.
 */
import type { Step } from '../../../runner/src/step.ts';

export const NAMESPACE = 'runners';
const LABEL = 'factory.mrogan.dev';

export interface JobNames {
  /**
   * The step's job, such as `reviewer-1002-1-4`: the agent, the work item, the agent's round, and how many steps the
   * work item has started, whichever agent ran them. That one is the reviewer's first round and the work item's
   * fourth step. The count makes each job's name unique.
   */
  job: string;
  workItem: string;
}

/**
 * A Kubernetes name from parts (`attempt` is the work item's count of steps): lower case, digits and dashes, and
 * short enough.
 */
export const jobName = (agent: string, workItem: string, round: number, attempt = 1) =>
  `${agent}-${workItem}-${round}-${attempt}`
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
  /** The addresses of the gateway's and the handback's names: the agent pod has no DNS to look them up. */
  hosts: { ip: string; hostnames: string[] }[];
}

const env = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));

function job(
  names: JobNames,
  part: 'prepare' | 'agent',
  settings: JobSettings,
  variables: Record<string, string>,
  pod: Record<string, unknown> = {},
) {
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
          ...pod,
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
                // pnpm, at the version the image holds, read-only: neither pod can change the pnpm the other runs.
                COREPACK_HOME: '/opt/corepack',
                ...(part === 'prepare'
                  ? { PREPARE: '/prepare', HOME: '/prepare/home', npm_config_store_dir: '/prepare/store' }
                  : { HOME: '/work/home' }),
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
                ...(part === 'prepare' ? [{ name: 'prepare', mountPath: '/prepare' }] : []),
              ],
            },
          ],
          volumes: [
            { name: 'work', persistentVolumeClaim: { claimName: volumeName(names.workItem) } },
            { name: 'tmp', emptyDir: {} },
            ...(part === 'prepare' ? [{ name: 'prepare', emptyDir: {} }] : []),
          ],
        },
      },
    },
  };
}

export const prepareJob = (names: JobNames, step: Step, settings: JobSettings) =>
  job(names, 'prepare', settings, { RUNNER_STEP: JSON.stringify(step) });

export const agentJob = (names: JobNames, step: Step, settings: AgentSettings) =>
  job(
    names,
    'agent',
    settings,
    {
      RUNNER_STEP: JSON.stringify(step),
      ANTHROPIC_BASE_URL: settings.gatewayUrl,
      // Its job token, where the Agent SDK looks for a key. The gateway and the handback take it, while the job runs. It
      // is in the Job's spec, which only the line can read in `runners`; it is worth nothing once the job ends.
      ANTHROPIC_API_KEY: settings.token,
      HANDBACK_URL: settings.handbackUrl,
    },
    {
      // No DNS: a query for a name of its choosing would be a way out. It knows the gateway's and the handback's
      // addresses, and asks a resolver that is not there for anything else, which fails at once.
      dnsPolicy: 'None',
      dnsConfig: { nameservers: ['127.0.0.1'] },
      hostAliases: settings.hosts,
    },
  );
