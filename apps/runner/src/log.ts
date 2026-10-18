/**
 * What a runner's pods print: one JSON object a line, each naming its job, its work item and its pod, so a line read
 * on its own says whose it is. The line keeps each pod's log with the step before it deletes the step's Jobs
 * (`apps/factory/src/runners/steps.ts`).
 *
 *     {"time":"…","level":"info","job":"coder-1002-1-4","workItem":"1002","pod":"agent","msg":"tool call","turn":3,"tool":"Read"}
 *
 * The job and the work item come from the Job's environment (RUNNER_JOB, RUNNER_WORK_ITEM); a step run outside a Job,
 * as the bench runs one, has neither, and its lines leave them out.
 */

export type Pod = 'prepare' | 'agent';

/** Writes one line: a message, and fields that say more. `level` among them makes it a warning or an error. */
export type Log = (msg: string, fields?: Record<string, unknown>) => void;

export function runnerLog(env: NodeJS.ProcessEnv, pod: Pod, write: (line: string) => void = console.log): Log {
  const names = { job: env.RUNNER_JOB, workItem: env.RUNNER_WORK_ITEM, pod };
  return (msg, fields = {}) =>
    write(JSON.stringify({ time: new Date().toISOString(), level: 'info', ...names, msg, ...fields }));
}

/**
 * Free text on a line, cut to a bound: the line keeps a pod's last lines, so each must be short for those lines to
 * fit. The same bound as a handback's error.
 */
export const bounded = (text: string): string => text.slice(0, 4000);

/** An error's own words, as a line's `error`. */
export const errorText = (error: unknown): string => bounded(error instanceof Error ? error.message : String(error));
