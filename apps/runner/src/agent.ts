/**
 * The agent step, in the agent pod: the one of a runner's two pods that reaches the gateway and the line's handback,
 * and nothing else. It holds no credential: its job token is good for its work item and agent, at the gateway and
 * the handback, until the job ends.
 *
 * 1. It checks its own fence before it starts: the network policy that holds it reaches a pod a moment after the
 *    pod starts, so it waits until the internet is out of reach and the gateway is in it.
 * 2. It runs the agent on the Agent SDK (Claude Code), in the checkout the prepare pod left, with the gateway as
 *    its API and the step's turn limit. The working folder and the system prompt are the same on every run, so the
 *    gateway's cassettes replay a step run again.
 * 3. It hands back a patch of what the agent changed and the agent's last word. The patch is data: the line checks
 *    it against the spec's scope, and the GitHub worker applies it outside the sandbox.
 */
import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { git } from './git.ts';
import { type Ending, type Handback, repoDir, stepFrom } from './step.ts';

/** Somewhere on the internet the fence must keep the pod from. */
const CANARY = 'https://api.github.com';
const FENCE_WAIT_MS = 60_000;
const NOTE_LENGTH = 4000;
/** What a pod can be asked to hand back. */
const PATCH_BYTES = 1024 * 1024;

const reaches = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(3000) }).then(
    () => true,
    () => false,
  );

/** Waits until the pod is fenced: the canary out of reach, the gateway in it. */
export async function awaitFence(gateway: string, canary = CANARY, waitMs = FENCE_WAIT_MS): Promise<void> {
  const until = Date.now() + waitMs;
  for (;;) {
    const [out, gate] = await Promise.all([reaches(canary), reaches(`${gateway}/health`)]);
    if (!out && gate) return;
    if (Date.now() > until) {
      throw new Error(
        out ? `This pod can reach ${canary}: its fence is not up.` : 'This pod cannot reach the gateway.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** The system prompt's addition: who the agent is, which skill to use, and what its last message is for. */
function instructions(agent: string, skill: string | undefined): string {
  return [
    `You are the factory's ${agent}, working in a checkout of the app's repository with no network.`,
    skill ? `Use the ${skill} skill for this step.` : '',
    'Your last message is handed back with your changes: make it a short note of the decisions you made, for the next reader.',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface AgentOptions {
  /** False only in tests, which run without a cluster's network policy. */
  checkFence?: boolean;
  log?: (line: string) => void;
}

export async function runAgent(
  env = process.env,
  { checkFence = true, log = console.log }: AgentOptions = {},
): Promise<Handback> {
  const step = stepFrom(env);
  const gateway = env.ANTHROPIC_BASE_URL;
  if (!gateway || !env.ANTHROPIC_API_KEY) throw new Error('The gateway and the job token are not set.');
  if (checkFence) await awaitFence(gateway);
  const cwd = repoDir(env);

  let result: SDKResultMessage | undefined;
  let error: string | undefined;
  try {
    for await (const message of query({
      prompt: step.prompt,
      options: {
        cwd,
        maxTurns: step.maxTurns,
        ...(step.resume ? { resume: step.resume } : {}),
        // The sandbox is the fence: inside it, the agent needs no one's permission to edit or run.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // No settings from the checkout: a file in the app's repository cannot change how the agent runs.
        settingSources: [],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: instructions(step.agent, step.skill),
          excludeDynamicSections: true,
        },
        env: {
          ...env,
          // Nothing leaves but model calls, and those go to the gateway.
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          DISABLE_AUTOUPDATER: '1',
        },
        stderr: (line) => log(`agent: ${line.trimEnd()}`),
      },
    })) {
      if (message.type === 'result') result = message;
    }
  } catch (thrown) {
    error = (thrown as Error)?.message ?? String(thrown);
  }

  if (!error && !result) error = 'The agent ended without a result.';
  if (!error && result?.subtype !== 'success') error = result?.errors.join('; ') || result?.subtype;
  const ending: Ending =
    result?.subtype === 'success' ? 'finished' : result?.subtype === 'error_max_turns' ? 'max-turns' : 'failed';
  let patch = await changes(cwd);
  const tooBig = Buffer.byteLength(patch) > PATCH_BYTES;
  if (tooBig) {
    patch = '';
    error = `The patch is over ${PATCH_BYTES} bytes, so none is handed back.`;
  }
  return {
    ending: tooBig ? 'failed' : ending,
    patch,
    note: (result?.subtype === 'success' ? result.result : '').slice(0, NOTE_LENGTH),
    turns: result?.num_turns ?? 0,
    session: result?.session_id ?? null,
    ...(error ? { error: error.slice(0, NOTE_LENGTH) } : {}),
  };
}

/**
 * What the agent changed since the checkout's last commit, as a patch; then committed in the checkout, so that a later
 * round's patch holds only that round's changes. Renames are written as a deletion and an addition, which every
 * patch reader understands.
 */
export async function changes(cwd: string): Promise<string> {
  await git(cwd, 'add', '--all', '--', '.', ':(exclude).claude');
  const patch = await git(cwd, 'diff', '--cached', '--no-renames', '--no-ext-diff', '--no-color');
  // Its own name, whatever the checkout's settings say: the commit stays in the sandbox.
  if (patch) {
    await git(
      cwd,
      '-c',
      'user.name=runner',
      '-c',
      'user.email=runner@factory.invalid',
      'commit',
      '--quiet',
      '--no-verify',
      '--message',
      'Handed back',
    );
  }
  return patch;
}

/** Hands the result back to the line, with the job token. */
export async function handBack(env: NodeJS.ProcessEnv, handback: Handback): Promise<void> {
  const url = env.HANDBACK_URL;
  if (!url) throw new Error('HANDBACK_URL is not set.');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ANTHROPIC_API_KEY}` },
    body: JSON.stringify(handback),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`The handback was refused: ${response.status} ${await response.text()}`);
}
