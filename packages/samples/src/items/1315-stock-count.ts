/**
 * Held at Build by the scope fence: the coder changed the catalogue as well as the product page, twice. The first
 * refusal went back to the coder with the fence's output; the second holds the work item for Martin. Neither patch
 * reached GitHub.
 */
import { Item } from '../build.ts';

const SCOPE = 'scope: src/pages/product.ts, test/product.test.ts';

export default new Item('1315', '2026-10-06T09:12:00+01:00')
  .probeTicket('0:00', {
    check: 'a product page shows its stock',
    route: '/products/ladder',
    version: 'v0.9.7',
    symptom: 'wrong-result',
    summary: 'Product journey: the ladder says 0 in stock, and the basket takes one',
    exchange: { method: 'GET', url: '/products/ladder', status: 200, timings: { firstByteMs: 14, totalMs: 22 } },
    title: 'The product page shows the wrong stock',
    category: 'functional',
    severity: 'degraded',
    description: 'A product page says none are in stock when there are, and the basket takes one anyway.',
    story:
      'The product journey found the ladder’s page saying 0 in stock while the basket took one. Triage opened a ticket from the probe’s own request.',
  })
  .calls('planner', '0:20', '2:00', { calls: 3, input: 29_000, output: 1_900, cached: 0.3 })
  .at('2:10', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
    outcome: 'A product page shows the stock the basket sees',
    criteria: [
      { given: 'three ladders in stock', when: 'the ladder’s page is shown', expect: 'it says 3 in stock' },
      { given: 'none in stock', when: 'the page is shown', expect: 'it says so, and offers no basket button' },
    ],
    scope: ['src/pages/product.ts', 'test/product.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '2:20', '8:30', { calls: 14, input: 250_000, output: 5_600, cached: 0.86 })
  .at('8:40', 'action.refused', 'factory', 'The scope fence refused the coder’s patch: src/catalogue.ts', {
    mechanism: 'scope-fence',
    action: 'Push the coder’s round 1 to a new pull request',
    output: [
      SCOPE,
      'allowed src/pages/product.ts +6 −2',
      'allowed test/product.test.ts +21 −0',
      'refused src/catalogue.ts +12 −4',
    ].join('\n'),
    files: [
      { path: 'src/pages/product.ts', added: 6, removed: 2, allowed: true },
      { path: 'test/product.test.ts', added: 21, removed: 0, allowed: true },
      { path: 'src/catalogue.ts', added: 12, removed: 4, allowed: false },
    ],
  })
  .calls('coder', '8:50', '13:10', { calls: 9, input: 190_000, output: 3_800, cached: 0.9 })
  .at('13:20', 'action.refused', 'factory', 'The scope fence refused the coder’s patch: src/catalogue.ts', {
    mechanism: 'scope-fence',
    action: 'Push the coder’s round 1 to a new pull request',
    output: [
      SCOPE,
      'allowed src/pages/product.ts +5 −2',
      'allowed test/product.test.ts +21 −0',
      'refused src/catalogue.ts +9 −3',
    ].join('\n'),
    files: [
      { path: 'src/pages/product.ts', added: 5, removed: 2, allowed: true },
      { path: 'test/product.test.ts', added: 21, removed: 0, allowed: true },
      { path: 'src/catalogue.ts', added: 9, removed: 3, allowed: false },
    ],
  })
  .at('13:21', 'hold.started', 'factory', 'Held for Martin at build', {
    stage: 'build',
    kind: 'held',
    cause: 'scope',
    reason: 'The scope fence refused the coder’s patch 2 times: it changed files outside the spec’s scope',
  });
