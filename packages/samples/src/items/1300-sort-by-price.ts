/**
 * An improvement waiting for Martin: he asked for it in his own words, and the planner wrote the spec, naming its title,
 * its flag, the page it changes and the side of the flag each criterion holds on, with one question nobody else can
 * answer.
 */
import { Item } from '../build.ts';

export default new Item('1300', '2026-10-03T09:40:00+01:00')
  .at('0:00', 'work-item.opened', 'martin', 'Martin asked for an improvement from the console', {
    kind: 'improvement',
    title: 'Sort products by price',
    sample: true,
    category: 'improvement',
  })
  .at('0:00', 'improvement.requested', 'martin', 'Martin asked for an improvement: Sort products by price', {
    words: 'Sort products by price. Cheapest first or dearest first, on the products page and within a department.',
    steppedUp: true,
  })
  .calls('planner', '0:20', '2:30', { calls: 3, input: 44_000, output: 3_600, cached: 0.3 })
  .at('2:40', 'spec.written', 'planner', 'Spec written with three acceptance criteria', {
    title: 'Sort products by price',
    outcome: 'Products can be sorted by price, either way, behind the sort-by-price flag',
    criteria: [
      {
        given: 'the products page',
        when: '“Price, low to high” is chosen',
        expect: 'the cheapest product comes first',
        withFlag: 'on',
      },
      {
        given: 'a department is chosen',
        when: 'a sort is chosen too',
        expect: 'it sorts within the department',
        withFlag: 'on',
      },
      { given: 'the flag is off', when: 'the products page is shown', expect: 'it is unchanged', withFlag: 'off' },
    ],
    scope: ['src/pages/products.ts', 'src/catalogue.ts', 'src/flags.ts', 'test/products.test.ts'],
    risks: [],
    rollout: 'Ships behind the sort-by-price flag, which goes on once the canary passes.',
    flag: 'sort-by-price',
    pages: ['/products'],
  })
  .at('3:10', 'hold.started', 'planner', 'The planner asks: where do products that are out of stock sort?', {
    stage: 'plan',
    kind: 'question',
    cause: 'question',
    reason: 'The spec waits for Martin to answer the planner’s question and approve it. Nothing is built before then.',
    question: 'Should products that are out of stock sort last, whatever their price?',
  })
  .at('3:11', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'Sort products by price',
    description:
      'The planner wrote a spec, with one question for Martin: where products that are out of stock go. Nothing is built before he approves it.',
    story:
      'Martin asked for a way to sort products by price. The planner wrote a spec with three acceptance criteria and one question it could not settle alone: where products that are out of stock should go, so it asked Martin. No code is written before he answers and approves the spec.',
  });
