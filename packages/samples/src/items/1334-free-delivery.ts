/**
 * An improvement whose spec waits for Martin. He asked for it with the "+", in his own words, and his passkey; the
 * work item took its title from his first sentence, cut at a word, until the planner named it in the spec, with the
 * flag it goes behind, the page it changes and the side of the flag each criterion holds on. Every improvement's spec
 * waits for his approval, with his passkey again, before any code is written.
 */
import { Item } from '../build.ts';

const WORDS =
  'Tell people how much more they need to spend to get free delivery. Show it in the basket, under the total, and nowhere else.';

export default new Item('1334', '2026-10-05T08:50:00+01:00')
  .at('0:00', 'work-item.opened', 'martin', 'Martin asked for an improvement from the console', {
    kind: 'improvement',
    title: 'Tell people how much more they need to spend to get free…',
    sample: true,
    category: 'improvement',
  })
  .at(
    '0:00',
    'improvement.requested',
    'martin',
    'Martin asked for an improvement: Tell people how much more they need to spend to get free…',
    {
      words: WORDS,
      steppedUp: true,
    },
  )
  .calls('planner', '0:20', '3:40', { calls: 3, input: 36_000, output: 2_900, cached: 0.3 })
  .at('3:50', 'spec.written', 'planner', 'Spec: three acceptance criteria, behind the free-delivery-gap flag', {
    title: 'How far the basket is from free delivery',
    outcome: 'The basket says how much more would bring free delivery, under its total',
    criteria: [
      {
        given: 'a basket under the free delivery threshold',
        when: 'the basket is shown',
        expect: 'it says how much more would bring free delivery, under the total',
        from: 'the request',
        quote: 'how much more they need to spend to get free delivery',
        withFlag: 'on',
      },
      {
        given: 'a basket at or over the threshold',
        when: 'the basket is shown',
        expect: 'it says delivery is free',
        from: 'the request',
        quote: 'free delivery',
        withFlag: 'on',
      },
      {
        given: 'the flag is off',
        when: 'the basket is shown',
        expect: 'it is as before',
        from: 'the request',
        quote: 'Show it in the basket, under the total, and nowhere else',
        withFlag: 'off',
      },
    ],
    scope: ['src/pages/basket.ts', 'src/delivery.ts', 'public/site.css', 'test/basket.test.ts'],
    risks: [],
    rollout: 'Ships behind the free-delivery-gap flag, off, which Martin widens a stage at a time.',
    flag: 'free-delivery-gap',
    pages: ['/basket'],
  })
  .at('3:51', 'hold.started', 'factory', 'Waiting for Martin to approve the spec', {
    stage: 'plan',
    kind: 'approval',
    cause: 'spec',
    reason:
      'The spec of an improvement Martin asked for: it waits for his approval before any code is written, in every autonomy mode',
  })
  .at('3:52', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'How far the basket is from free delivery',
    description: 'The planner wrote the spec, behind its own flag. Nothing is built before Martin approves it.',
    story:
      'Martin asked for the basket to say how much more would bring free delivery. The planner named the change, the flag it goes behind and the page it changes, with three acceptance criteria, two with the flag on and one with it off. No code is written before Martin approves the spec, with his passkey.',
  });
