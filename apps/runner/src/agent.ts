/**
 * The agent step, in the agent pod: the one of a runner's two pods that reaches the gateway and the line's handback,
 * and nothing else. It holds no credential: its job token is good for its work item and agent, at the gateway and
 * the handback, until the job ends.
 *
 * 1. It checks its own fence before it starts: the network policy that holds it reaches a pod a moment after the
 *    pod starts, so it waits until the internet is out of reach and the gateway is in it.
 * 2. It runs the agent on the Agent SDK (Claude Code), in the checkout the prepare pod left, with the gateway as
 *    its API and the step's turn limit. The working folder and the system prompt are the same on every run, so the
 *    gateway's cassettes replay a step run again. A step that names a skill has that one skill, from the runner's
 *    own plugin (`../plugin`), and is told to use it; a step that names none has no skills at all, and asks the model
 *    exactly what it asked before skills came in, so its cassettes still replay.
 * 3. It hands back a patch of what the agent changed and the agent's last word, and its structured result when the
 *    step asks for one. The patch is data: the line checks it against the spec's scope, and the GitHub worker
 *    applies it outside the sandbox. The result is data too: the line reads it through the agent's schema.
 */
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { git } from './git.ts';
import {
  type Ending,
  type Handback,
  RESULT_BYTES,
  repoDir,
  resultFilePath,
  resultPath,
  type Step,
  stepFrom,
} from './step.ts';

/** Somewhere on the internet the fence must keep the pod from, by address: the pod has no DNS. */
const CANARY = 'https://1.1.1.1';
const FENCE_WAIT_MS = 60_000;
const NOTE_LENGTH = 4000;
/** What a pod can be asked to hand back. */
const PATCH_BYTES = 1024 * 1024;

/**
 * How an attempt to reach an address went: reached it; blocked, as a network policy blocks (the connection refused,
 * reset or never answered); or failed some other way, such as a name that does not resolve, which proves nothing
 * about a fence.
 */
export async function attempt(url: string): Promise<'reached' | 'blocked' | 'unclear'> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return 'reached';
  } catch (error) {
    const code = ((error as Error)?.cause as { code?: string } | undefined)?.code ?? (error as Error)?.name;
    const blocks = [
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
      'TimeoutError',
    ];
    return blocks.includes(code ?? '') ? 'blocked' : 'unclear';
  }
}

/**
 * Waits until the pod is fenced: the canary blocked, as a policy blocks it, and the gateway reached. A canary that
 * cannot be resolved, or answers oddly, is not taken for a fence.
 */
export async function awaitFence(gateway: string, canary = CANARY, waitMs = FENCE_WAIT_MS): Promise<void> {
  const until = Date.now() + waitMs;
  for (;;) {
    const [out, gate] = await Promise.all([attempt(canary), attempt(`${gateway}/health`)]);
    if (out === 'blocked' && gate === 'reached') return;
    if (Date.now() > until) {
      throw new Error(
        gate !== 'reached'
          ? 'This pod cannot reach the gateway.'
          : `This pod's way to ${canary} is ${out}, not blocked: its fence is not shown to be up.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * The tools an agent may use: its checkout's files and a shell. Not the web (WebSearch asks the model's API for a
 * search, WebFetch reaches out), and not Claude Code's agents, schedules or worktrees.
 */
export const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];

/**
 * The runner's plugin, which holds every skill a step may name: in the image, read-only, beside this module. Not the
 * checkout's skills, nor any in the agent's home on the volume: the SDK is given no setting sources.
 */
export const PLUGIN = { name: 'factory', path: fileURLToPath(new URL('../plugin', import.meta.url)) };

/** A skill by the name the agent knows it by: the plugin's name, then the skill's. */
const skillName = (skill: string) => `${PLUGIN.name}:${skill}`;

/** What the SDK is given for a step's skill: the plugin, that skill alone, and the tool that loads it. */
async function skillOptions(step: Step) {
  if (!step.skill) return { tools: TOOLS };
  try {
    await access(join(PLUGIN.path, 'skills', step.skill, 'SKILL.md'));
  } catch {
    throw new Error(`The runner holds no skill called ${step.skill}.`);
  }
  return {
    tools: [...TOOLS, 'Skill'],
    plugins: [{ type: 'local' as const, path: PLUGIN.path }],
    skills: [skillName(step.skill)],
  };
}

/**
 * The system prompt's addition: who the agent is, which skill to use, where its result goes, and what its last
 * message is for.
 */
function instructions(step: Step, result: string, env: NodeJS.ProcessEnv): string {
  const files = Object.entries(step.resultFiles ?? {}).map(
    ([field, name]) => `its \`${field}\` to ${resultFilePath(name, env)}, as Markdown`,
  );
  return [
    `You are the factory's ${step.agent}, working in a checkout of the app's repository with no network.`,
    step.skill ? `Use the ${skillName(step.skill)} skill for this step.` : '',
    step.result
      ? `Write the step's result, as JSON, to ${result}: it is handed back beside your changes and is not one of them.`
      : '',
    files.length ? `Leave out of the JSON, and write as a file of its own, ${files.join(', and ')}.` : '',
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
  // What the step started from, so a commit the agent makes is still part of its patch.
  const base = (await git(cwd, 'rev-parse', 'HEAD')).trim();
  // The volume outlives the step: a result left by an earlier one must not be handed back as this one's.
  const resultFile = resultPath(env);
  const resultFiles = Object.fromEntries(
    Object.entries(step.resultFiles ?? {}).map(([field, name]) => [field, resultFilePath(name, env)]),
  );
  await Promise.all([resultFile, ...Object.values(resultFiles)].map((file) => rm(file, { force: true })));
  await mkdir(dirname(resultFile), { recursive: true });
  const { tools, ...skill } = await skillOptions(step);

  let result: SDKResultMessage | undefined;
  let error: string | undefined;
  try {
    for await (const message of query({
      prompt: step.prompt,
      options: {
        cwd,
        maxTurns: step.maxTurns,
        tools,
        ...skill,
        ...(step.resume ? { resume: step.resume } : {}),
        // The sandbox is the fence: inside it, the agent needs no one's permission to edit or run.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // No settings from the checkout: a file in the app's repository cannot change how the agent runs.
        settingSources: [],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: instructions(step, resultFile, env),
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
  let patch = await changes(cwd, base);
  const tooBig = Buffer.byteLength(patch) > PATCH_BYTES;
  if (tooBig) {
    patch = '';
    error = `The patch is over ${PATCH_BYTES} bytes, so none is handed back.`;
  }
  const written: { result?: unknown; problem?: string } = step.result ? await readResult(resultFile, resultFiles) : {};
  if (!error && written.problem) error = written.problem;
  return {
    ending: tooBig ? 'failed' : ending,
    patch,
    note: (result?.subtype === 'success' ? result.result : '').slice(0, NOTE_LENGTH),
    turns: result?.num_turns ?? 0,
    session: result?.session_id ?? null,
    ...(error ? { error: error.slice(0, NOTE_LENGTH) } : {}),
    ...('result' in written ? { result: written.result } : {}),
  };
}

/**
 * The result the agent wrote, if it is JSON and small enough, with each field it wrote as a file of its own read in.
 * What it says is the line's to judge, against the agent's schema; here it is only carried.
 */
export async function readResult(
  file: string,
  files: Record<string, string> = {},
): Promise<{ result?: unknown; problem?: string }> {
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch {
    return { problem: 'The agent wrote no result.' };
  }
  let result: unknown;
  try {
    result = JSON.parse(text) as unknown;
  } catch {
    return { problem: 'The result is not JSON.' };
  }
  if (Object.keys(files).length) {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      return { problem: 'The result is not a JSON object, so it cannot take the fields written as files.' };
    }
    for (const [field, path] of Object.entries(files)) {
      try {
        (result as Record<string, unknown>)[field] = await readFile(path, 'utf-8');
      } catch {
        return { problem: `The agent wrote no ${field}.` };
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES) {
    return { problem: `The result is over ${RESULT_BYTES} bytes.` };
  }
  return { result };
}

/**
 * What the agent changed since the commit the step started from, as a patch: committed or not, since an agent may
 * commit its work. Nothing of the sandbox's history leaves it: each step starts from a fresh checkout of the branch's
 * head on GitHub, so a round's patch holds that round's changes on what GitHub has, and a refused patch leaves nothing
 * behind. Renames are written as a deletion and an addition, which every patch reader understands.
 */
export async function changes(cwd: string, base: string): Promise<string> {
  // The runner's own `.claude/` is no part of the work, whether the agent left it alone or committed it.
  const work = ['--', '.', ':(exclude).claude'];
  await git(cwd, 'add', '--all', ...work);
  return git(cwd, 'diff', '--cached', '--no-renames', '--no-ext-diff', '--no-color', base, ...work);
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
