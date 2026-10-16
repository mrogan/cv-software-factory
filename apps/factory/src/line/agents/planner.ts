/**
 * The planner: turns a ticket into a spec the coder can be held to, or says it cannot. It reads the app's repository
 * at the commit the fix will start from, and hands back the spec in the fixed template (`spec.written`): the outcome,
 * Given/When/Then criteria the coder can write as failing tests, the files that may change, risk tags and a rollout
 * note. Or it rejects the ticket, or asks Martin a question, and the work item holds for him.
 *
 * What it is told is the ticket's public view and what the senses saw, by their typed fields (`evidence.ts`): never
 * a visitor's words, and never a log message, which may carry them.
 *
 * A fix does what its ticket's evidence asks, and no more: each criterion names what in that evidence it comes from
 * (`from`), and quotes the words there that ask for it (`quote`). The schema refuses a spec whose quote is not in
 * what its criterion names, as the planner was told it, so a criterion the planner widened cannot claim words the
 * evidence never had; whether the words it quotes do ask for the criterion is the reviewer's to judge, with the
 * words in front of it. One nothing asks for does not belong in the spec. Anything else the planner notices on the way goes in
 * its `findings`, which the line leaves in triage's inbox as signals from the planner (`findingSignal`). Triage judges
 * them as it judges a visitor's report, and trusts them no more: a visitor can read the app's public code and try to
 * persuade an agent that a line of it holds a bug, so the planner's word alone never opens a ticket.
 *
 * It stops at a diagnosis: the code at fault, and why. Reproducing the defect (a server, requests, a script) is the
 * coder's, whose first step is a failing test. On Qwen, planners that reproduced it found the cause in a few minutes
 * and spent the rest of their 30 to 45 doing so.
 *
 * The planner has the checkout's tools, but nothing it changes leaves the sandbox: the line reads only its result,
 * and the coder's step starts from a fresh checkout. Its scope is held to the line's rules here, by the schema: a
 * plain path in the repository, never naming the workflows, the deployment, or a path the app's CODEOWNERS gives
 * Martin, as the repository has them at that commit. A fix that needs one is not the line's to make, and the planner
 * says so by rejecting the ticket. The line's fence holds the coder's patch to the same paths at its commit
 * (`coder.ts`), and the GitHub worker refuses every protected file a patch changes, as the last word.
 */
import type { InboxSignal, PayloadOf } from '@software-factory/events';
import { RISKS } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { z } from 'zod';
import { inScope, NEVER, pattern, plainPath } from '../../github/paths.ts';
import { count, defineAgent, holdDraft, words } from './agent.ts';
import { numbered, routeOf, type Signal, seen, ticketLines } from './evidence.ts';

export interface PlannerInput {
  workItem: string;
  /** The ticket, as its public view has it. */
  ticket: PayloadOf<'ticket.opened'>;
  /** What each sense saw, in the order they saw it. A report's signal is not here. */
  signals: Signal[];
  /** The paths no scope may name at the commit: the workflows, the deployment and what CODEOWNERS gives a person. */
  protectedPaths: readonly string[];
  /** Martin's answers to the holds at Plan, each with what he was asked. */
  answers: { asked: string; answer: string }[];
  /** Each verification that found the signal persisting after a fix for this ticket was released. */
  persisted?: PayloadOf<'verification.finished'>[];
  /** Each time the ticket reopened: a fix for it was verified in production, and the same defect came back. */
  reopened?: PayloadOf<'work-item.reopened'>[];
  /** Why the planner's last attempt failed, such as a scope its schema refused, so it does not hand that back again. */
  failure?: string | null | undefined;
}

/**
 * Whether a scope entry takes in a protected path: names one, is a folder or pattern with one in it, or is a
 * protected folder's name without its slash. A protected folder stands for a file in it, and one that matches
 * anywhere (an entry with no leading slash in CODEOWNERS) for its name at the top.
 */
function touches(entry: string, protectedPaths: readonly string[]): boolean {
  if (inScope(entry, protectedPaths)) return true;
  const within = pattern(entry);
  return protectedPaths.some((path) => {
    const sample = path.replace(/^\*\*\//, '').replace(/\*/g, 'x');
    return sample.endsWith('/') ? within.test(`${sample}x`) || within.test(sample.slice(0, -1)) : within.test(sample);
  });
}

/** What is wrong with a scope entry, if anything: it must be a plain path in the repository, and keep out of the protected paths. */
function scopeProblem(entry: string, protectedPaths: readonly string[]): string | undefined {
  // A folder ends in its slash; the rest of it is a path like any other.
  if (!plainPath(entry.endsWith('/') ? entry.slice(0, -1) : entry))
    return `${entry} is not a plain path in the repository`;
  if (touches(entry, protectedPaths)) return `${entry} names a path no patch may change`;
  return undefined;
}

/**
 * What a criterion may come from, in the words the prompt gives each: the ticket, each signal by its number from 1,
 * and Martin's answers with what he was asked. A criterion's quote is looked for here.
 */
export interface Sources {
  ticket: string;
  signals: string[];
  answers: string;
}

/** One of Martin's answers, with what he was asked, as the prompt tells it and a quote is looked for in it. */
const answered = (a: PlannerInput['answers'][number]) => `${a.asked} He said: ${a.answer}`;

/** The sources of a plan's input, as its prompt tells them. */
export const sourcesOf = ({
  ticket,
  signals,
  answers,
}: Pick<PlannerInput, 'ticket' | 'signals' | 'answers'>): Sources => ({
  ticket: [ticket.title, ...ticketLines(ticket, signals)].join('\n'),
  signals: signals.map((signal) => seen(signal).join('\n')),
  answers: answers.map(answered).join('\n'),
});

/** No sources at all: every quote is refused. */
const NOTHING: Sources = { ticket: '', signals: [], answers: '' };

/**
 * Words as a quote is matched: in one case, with one kind of apostrophe and quotation mark, and one space between
 * words. A quote may come in quotation marks, and end in a full stop or other mark the evidence does not have there.
 */
const plain = (words: string) =>
  words.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const unquoted = (quote: string) =>
  plain(quote)
    .replace(/^["'([{]+|["'.,;:!?)\]}…]+$/g, '')
    .trim();

/** Whether words are in a source as whole words: never the inside of a word, which would let a few letters pass. */
const within = (words: string, source: string) => {
  const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(plain(source));
};

/**
 * What is wrong with a criterion's `from` and `quote`, if anything: `from` names the ticket, a signal there is by its
 * number, or Martin's answer when he has given one, and the quote, word for word, is in one of the sources it names.
 */
export function quoteProblem(from: string, quote: string, sources: Sources): string | undefined {
  const named: string[] = [];
  if (/\bticket\b/i.test(from)) named.push(sources.ticket);
  // `signal 2`, `signals 1 and 2`, `signals 1, 3`, `signal #2`
  for (const [, list = ''] of from.matchAll(/\bsignals?\s*((?:#?\d+(?:\s*(?:,|and|&|\+|-|–)\s*)?)+)/gi)) {
    for (const [n] of list.matchAll(/\d+/g)) {
      const signal = sources.signals[Number(n) - 1];
      if (signal === undefined) return `there is no signal ${n}`;
      named.push(signal);
    }
  }
  if (/\banswer/i.test(from)) {
    if (!sources.answers) return 'Martin has answered nothing yet';
    named.push(sources.answers);
  }
  if (!named.length) return 'from names the ticket, a signal by its number, or Martin’s answer';
  const words = unquoted(quote);
  if (words.split(' ').length < 2) return 'a quote is the words that ask for the criterion: two or more of them';
  if (!named.some((source) => within(words, source)))
    return `the quote is not in ${from}: copy the words that ask for the criterion from there, word for word`;
  return undefined;
}

/**
 * The spec, with a scope of plain paths that keeps out of the protected paths, and every criterion naming what in the
 * ticket's evidence it comes from, and quoting the words there that ask for it.
 */
const specWithin = (protectedPaths: readonly string[], sources: Sources) =>
  PAYLOADS['spec.written'].superRefine((spec, ctx) => {
    spec.scope.forEach((entry, i) => {
      const problem = scopeProblem(entry, protectedPaths);
      if (problem) ctx.addIssue({ code: 'custom', path: ['scope', i], message: problem });
    });
    spec.criteria.forEach((criterion, i) => {
      if (!criterion.from) {
        const message = 'a criterion names what in the ticket or the signals asks for it';
        ctx.addIssue({ code: 'custom', path: ['criteria', i, 'from'], message });
      } else if (!criterion.quote) {
        const message = 'a criterion quotes the words in what it is from that ask for it';
        ctx.addIssue({ code: 'custom', path: ['criteria', i, 'quote'], message });
      } else {
        const problem = quoteProblem(criterion.from, criterion.quote, sources);
        if (problem) ctx.addIssue({ code: 'custom', path: ['criteria', i, 'quote'], message: problem });
      }
    });
  });

/** The most findings one plan leaves triage. */
export const MAX_PLANNER_FINDINGS = 5;

/** A path of the app with no query: a page a visitor opens, or a route as the app's code names it. */
const path = (example: string) =>
  z
    .string()
    .trim()
    .regex(/^\/[^\s?#]*$/, `a path such as ${example}, with no query`)
    .max(200);

/**
 * Something the planner noticed that its ticket does not ask for: where it shows, as a page and as the route that
 * serves it (as a visitor's report has both), and what it is, in its own words. Triage reads the words as it reads a
 * visitor's report: as untrusted data.
 */
const finding = z.strictObject({
  page: path('/products/camera'),
  route: path('/products/:slug'),
  text: words(300),
});

export type PlannerFinding = z.infer<typeof finding>;

const findings = z.array(finding).max(MAX_PLANNER_FINDINGS).default([]);

/**
 * The planner's result, with its scope held to the protected paths given; with none, to the rules of the line that
 * hold whatever the repository's CODEOWNERS says. Its criteria quote the sources given (`sourcesOf`); with none, no
 * spec fits.
 */
export const plannerResult = (protectedPaths: readonly string[] = NEVER, sources: Sources = NOTHING) =>
  z.discriminatedUnion('verdict', [
    z.strictObject({ verdict: z.literal('spec'), spec: specWithin(protectedPaths, sources), findings }),
    /** The ticket cannot be made testable, is not a defect in the app, or needs a fix the line may not make. */
    z.strictObject({ verdict: z.literal('reject'), reason: words(300), findings }),
    /** Something about what the app should do that only Martin can say. */
    z.strictObject({ verdict: z.literal('question'), question: words(300), findings }),
  ]);

export type PlannerResult = z.infer<ReturnType<typeof plannerResult>>;

/** What each risk tag says of a fix, so the planner tags what the fix does, not what the defect did. */
const RISK_MEANINGS: Record<(typeof RISKS)[number], string> = {
  'test-loosening': 'it changes or removes an assertion an existing test makes',
  'dependency-change': 'it adds, removes or updates a dependency',
  'security-headers': 'it changes the headers the app sends',
  'out-of-scope': 'it changes behaviour beyond what the ticket is about',
};

const SPEC_TEMPLATE = [
  '- `outcome`: one sentence, what is true once the fix is in.',
  '- `criteria`: one to twelve acceptance criteria, each an object of `given`, `when`, `expect` (the then), `from` and `quote`, in a sentence each. A criterion says what a visitor or a caller of the code sees, not how the code changes. Each is a test the coder can write with the repository’s own tests: it fails at this commit and passes once the fix is in. `from` names what above asks for it: `the ticket`, a signal by its number (`signal 1`), or `Martin’s answer`. `quote` copies, word for word, the words there that ask for it: two or more, in one unbroken stretch with nothing left out, at most 200 characters; the line refuses a spec whose quote is not in what its criterion names. A criterion nothing above asks for does not belong in the spec, however wrong the code it would mend.',
  '- `scope`: the files the coder may change, its tests among them, and no more than the fix needs: a path from the top of the repository, a folder ending in `/`, or a pattern with `*`.',
  `- \`risks\`: a list of tags, each exactly one of these words, for what the fix itself does; usually it is empty. ${RISKS.map((r) => `${r}: ${RISK_MEANINGS[r]}`).join('; ')}.`,
  '- `rollout`: a sentence or two on how the fix ships and what would show it worked.',
  'Every string is a plain sentence or a path, at most 200 characters (the rollout 300).',
];

/**
 * A planner's finding as a signal for triage's inbox: its own source, with its words where a report's are, which no
 * public view and no generative agent reads. It names the ticket being planned and the commit the planner read.
 */
export function findingSignal(
  found: PlannerFinding,
  workItem: string,
  commit: string,
): Omit<InboxSignal, 'observedAt'> {
  return {
    sense: 'planner',
    check: `planning ticket #${workItem}`,
    route: routeOf(found.route),
    version: commit,
    report: { page: routeOf(found.page), text: found.text },
    planning: workItem,
    artifacts: [],
  };
}

export const planner = defineAgent<PlannerInput, PlannerResult>({
  agent: 'planner',
  maxTurns: 30,
  deadlineSeconds: 15 * 60,
  input: async ({ workItem, state, commit, failure, ticket, signals, read }) => ({
    workItem,
    ticket: await ticket(),
    signals: await signals(),
    protectedPaths: await read('protectedPaths', { ref: commit }),
    answers: state.answers,
    persisted: state.persisted,
    reopened: state.reopened,
    failure,
  }),
  schema: (input) => plannerResult(input.protectedPaths, sourcesOf(input)),
  prompt: ({ workItem, ticket, signals, protectedPaths, answers, persisted = [], reopened = [], failure }) =>
    [
      `Plan the fix for ticket #${workItem}: ${ticket.title}.`,
      ...ticketLines(ticket, signals),
      ...(signals.length ? ['', 'What the senses saw, by number:', ...numbered(signals)] : []),
      ...(answers.length ? ['', 'Martin was asked, and answered:', ...answers.map((a) => `- ${answered(a)}`)] : []),
      ...(persisted.length
        ? [
            '',
            'A fix for this ticket was merged and released before, and the signal persisted:',
            ...persisted.map(
              (v) => `- The ${v.sense ?? 'sense'} still saw “${v.check}” on ${v.version ?? 'the new version'}.`,
            ),
            'Find out why that fix did not clear it before you plan another.',
          ]
        : []),
      ...(reopened.length
        ? [
            '',
            'A fix for this ticket was verified in production before, and the defect came back:',
            ...reopened.map((r) => `- The ${r.sense} saw “${r.check}” again on ${r.version}.`),
            'Find out what brought it back, and what let it through, before you plan another fix.',
          ]
        : []),
      ...(failure ? ['', `Your last attempt at this plan failed: ${failure}. Do not hand back the same again.`] : []),
      '',
      'Find the cause in the repository: start from the route, and read the code that serves it and its tests. Stop as soon as you can name the code at fault and say why it does what the evidence shows: that diagnosis is all the plan needs, and most plans need a dozen tool calls or fewer.',
      'Do not reproduce the defect: start no server, send no requests, write no scripts, and run no tests. The coder’s first step is a failing test that reproduces it, and your criteria say what that test shows. You plan; the coder fixes. Change nothing: no change of yours leaves this checkout.',
      '',
      'A fix does what the ticket’s evidence asks, and no more. The app is full of other defects: anything else you notice that is wrong with it, or that it could do better, goes in `findings`, never in the spec. Triage judges each one as it judges a visitor’s report; it opens no ticket on your word alone. Leave `findings` empty when you noticed nothing else.',
      '',
      'Then write the result, one of three, each with its `findings`:',
      '1. {"verdict":"spec","spec":{"outcome","criteria":[{"given","when","expect","from","quote"}],"scope":[],"risks":[],"rollout"},"findings":[{"page","route","text"}]}, the spec the coder will be held to:',
      ...SPEC_TEMPLATE.map((line) => `   ${line}`),
      `2. {"verdict":"reject","reason"} when you cannot make it testable: the cause is not in this repository, or you cannot find the defect the evidence shows, or no test could tell the fix from the defect. Reject it too when the fix needs a path no scope may name: ${protectedPaths.join(', ')}. The reason is one or two short sentences for Martin, at most 300 characters, naming the file or what is missing.`,
      '3. {"verdict":"question","question"} when the fix turns on what the app should do, which only Martin can say: one question he can answer in a line, at most 300 characters.',
      `\`findings\`: at most ${MAX_PLANNER_FINDINGS}, each with \`page\`, a page of the app that shows it, as the path a visitor opens (\`/\` when it shows on none); \`route\`, the route that serves that page, as the app’s code names it, such as \`/products/:slug\`; and \`text\`, what is wrong or could be better, in a sentence or two of at most 300 characters.`,
    ].join('\n'),
  apply: async (planned, _handback, _input, context) => {
    // A finding is known by where it is and what it says, so the same one handed back by a later plan, after a
    // question or a replan, is not left again.
    for (const found of planned.findings) {
      const key = `finding ${found.route} ${found.page} ${found.text}`;
      await context.leaveSignal(key, findingSignal(found, context.workItem, context.commit));
    }
    const left = planned.findings.length ? `; ${count(planned.findings.length, 'finding')} left for triage` : '';
    switch (planned.verdict) {
      case 'spec': {
        const { spec } = planned;
        const summary = `Spec written: ${count(spec.criteria.length, 'criterion', 'criteria')}, ${count(spec.scope.length, 'path')} in scope${left}`;
        return [{ type: 'spec.written', actor: 'planner', summary, payload: spec }];
      }
      case 'reject':
        return [
          holdDraft('planner', { stage: 'plan', kind: 'held', cause: 'ticket-rejected', reason: planned.reason }),
        ];
      case 'question':
        return [
          holdDraft('planner', {
            stage: 'plan',
            kind: 'question',
            cause: 'question',
            reason: 'The planner needs an answer to write the spec',
            question: planned.question,
          }),
        ];
    }
  },
});
