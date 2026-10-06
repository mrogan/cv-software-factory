/**
 * The describer: with a fresh context, once review has settled, writes the pull request's title and description
 * from the ticket, the spec and the final diff, and the work item's summary for the console's sheet.
 *
 * The prompt here is the least that does the job; milestone 5's task 13 writes the describer properly, with its
 * skill.
 */
import type { PayloadOf } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { z } from 'zod';
import { defineAgent, need, words } from './agent.ts';
import { refersTo } from './coder.ts';

export interface DescriberInput {
  workItem: string;
  ticket: PayloadOf<'ticket.opened'>;
  spec: PayloadOf<'spec.written'>;
  pullRequest: number;
  base: string;
}

export const describerResult = z.strictObject({
  /** The pull request's title, as a Conventional Commit. */
  title: words(200),
  /** Its description, in Markdown. */
  body: words(60_000),
  summary: PAYLOADS['work-item.summarised'],
});

export type DescriberResult = z.infer<typeof describerResult>;

export const describer = defineAgent<DescriberInput, DescriberResult>({
  agent: 'describer',
  maxTurns: 20,
  deadlineSeconds: 10 * 60,
  input: ({ workItem, state, base }) => ({
    workItem,
    ticket: need(state.ticket, 'a ticket'),
    spec: need(state.spec, 'a spec'),
    pullRequest: need(state.pullRequest, 'a pull request').number,
    base,
  }),
  schema: () => describerResult,
  prompt: ({ workItem, ticket, spec, pullRequest, base }) =>
    [
      `Describe pull request #${pullRequest}, the fix for ticket #${workItem} (${ticket.title}): the diff from ${base} to the checkout's head.`,
      `What it set out to do: ${spec.outcome}`,
      'Write its title as a Conventional Commit, and a description that fits the change: a line if a line will do.',
      'Then a summary for the work item: a title, two lines for its card (`description`), and a paragraph (`story`).',
      'The result is {"title","body","summary":{"title","description","story"}}.',
    ].join('\n'),
  // Each write here leaves the pull request as it says, however often it is done: no `once` is needed.
  apply: async (described, _handback, { pullRequest: number }, context) => {
    const pr = await context.read('pullRequest', { number });
    await context.act('updatePullRequest', {
      number,
      title: described.title,
      body: `${described.body}\n\n${refersTo(context.issue)}`.trim(),
    });
    if (pr.draft) await context.act('readyForReview', { pullRequest: { number, url: '', nodeId: pr.nodeId } });
    return [
      { type: 'work-item.summarised', actor: 'describer', summary: 'Summary written', payload: described.summary },
    ];
  },
});
