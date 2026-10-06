/** An improvement waiting for Martin: the spec is written, with one question nobody else can answer. */
import { Item } from '../build.ts';

export default new Item('1300', '2026-10-03T09:40:00+01:00')
  .at('0:00', 'work-item.opened', 'martin', 'Martin asked for an improvement from the console', {
    kind: 'improvement',
    title: 'Sort products by price',
    sample: true,
    category: 'improvement',
  })
  .calls('planner', '0:20', '2:30', { calls: 3, input: 44_000, output: 3_600, cached: 0.3 })
  .at('2:40', 'spec.written', 'planner', 'Spec written with three acceptance criteria', {
    outcome: 'Products can be sorted by price, either way, behind the sort-by-price flag',
    criteria: [
      {
        given: 'the products page',
        when: '“Price, low to high” is chosen',
        expect: 'the cheapest product comes first',
      },
      { given: 'a department is chosen', when: 'a sort is chosen too', expect: 'it sorts within the department' },
      { given: 'the flag is off', when: 'the products page is shown', expect: 'it is unchanged' },
    ],
    scope: ['src/pages/products.ts', 'src/catalogue.ts', 'src/flags.ts', 'test/products.test.ts'],
    risks: [],
    rollout: 'Ships behind the sort-by-price flag, which goes on once the canary passes.',
    flag: 'sort-by-price',
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
      'The spec is written and waiting for Martin, with one question from the planner. Nothing is built until he approves it.',
    story:
      'Martin asked for a way to sort products by price. The planner wrote a spec with three acceptance criteria and one question it could not settle alone: where products that are out of stock should go. No code is written until Martin answers and approves the spec.',
  });
