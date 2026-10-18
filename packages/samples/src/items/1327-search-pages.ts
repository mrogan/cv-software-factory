/**
 * Waiting at the samples' end for work in flight: a second ticket on search, taken once #1325's planner was done,
 * whose spec scopes the same page as #1325's, which the coder is still working on. The line does not plan a second fix for what may be one defect: it
 * waits until #1325 is verified or closed, then looks again at this ticket's signal, and goes on only if it is still
 * there.
 */
import { Item } from '../build.ts';

export default new Item('1327', '2026-10-06T15:04:00+01:00')
  .probeTicket('0:00', {
    check: 'search pages through its results',
    route: '/search',
    version: 'v0.9.7',
    symptom: 'wrong-result',
    summary: 'Search journey: the second page of results for “brush” starts with the last result of the first',
    exchange: {
      method: 'GET',
      url: '/search?q=brush&page=2',
      status: 200,
      timings: { firstByteMs: 17, totalMs: 25 },
    },
    title: 'The second page of search results repeats the first’s last',
    category: 'functional',
    severity: 'cosmetic',
    description: 'Page through the results of a search, and each page starts with the last result of the page before.',
    story:
      'The search journey paged through the results for “brush” and found the second page starting with the first page’s last result. Triage opened a ticket from the probe’s own request.',
  })
  .calls('planner', '3:40', '5:50', { calls: 3, input: 31_000, output: 2_100, cached: 0.3 })
  .at('6:00', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
    outcome: 'Each page of search results starts after the last result of the page before',
    criteria: [
      {
        given: 'a search for “brush”',
        when: 'its second page is shown',
        expect: 'no result of the first page is on it',
      },
      { given: 'a search with one page of results', when: 'the results are shown', expect: 'each is listed once' },
    ],
    scope: ['src/pages/search.ts', 'test/search.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .at(
    '6:01',
    'wait.started',
    'factory',
    'Waits for #1325, whose spec also changes src/pages/search.ts and test/search.test.ts',
    {
      on: ['1325'],
      files: ['src/pages/search.ts', 'test/search.test.ts'],
      reason: 'Waits for #1325, whose spec also changes src/pages/search.ts and test/search.test.ts',
    },
  );
