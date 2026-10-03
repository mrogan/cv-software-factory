/** A defect the logs noticed: searches left no log record, so a slow one could not be followed. */
import { commitFor, digestFor, Item, JEV, jevCassette, traceFor, triageAnswers } from '../build.ts';

const trace = traceFor('1265/before');
const after = [traceFor('1265/after/1'), traceFor('1265/after/2')];

export default new Item('1265', '2026-09-29T14:10:00+01:00')
  .at('0:00', 'work-item.opened', 'factory', 'The log check opened a work item', {
    kind: 'defect-fix',
    title: 'Searches leave no log record',
    sample: true,
  })
  .at('0:01', 'signal.received', 'logs', 'No log record for 214 searches in the last hour', {
    sense: 'logs',
    check: 'a log record for every request',
    route: '/search',
    version: 'v0.8.4',
    evidence: {
      kind: 'logs',
      route: '/search',
      version: 'v0.8.4',
      requests: 214,
      lines: [],
      trace: {
        id: trace,
        spans: [
          { name: 'GET /search', offsetMs: 0, durationMs: 41 },
          { name: 'catalogue.search', offsetMs: 6, durationMs: 12 },
          { name: 'render search', offsetMs: 19, durationMs: 18 },
        ],
      },
    },
  })
  .at('0:30', 'judgement.made', 'triage', 'Triage: observability (0.91), degraded, no instructions (0.00)', {
    ...JEV,
    state: { signal: { route: '/search', check: 'a log record for every request' } },
    answers: triageAnswers('observability', 0.91, [0.04, 0.17, 0.71, 0.08], 0.002),
    route: 'ticket',
    costUsd: 0.0009,
    durationMs: 94,
    cassette: jevCassette('1265'),
  })
  .at('0:31', 'ticket.opened', 'triage', 'Ticket #1265: observability, degraded', {
    title: 'Searches leave no log record',
    category: 'observability',
    severity: 'degraded',
    fingerprint: { route: '/search', class: 'missing-log' },
    traces: [trace],
  })
  .calls('planner', '0:40', '2:20', { calls: 3, input: 34_000, output: 2_800, cached: 0.3 })
  .at('2:30', 'spec.written', 'planner', 'Spec: every request on every route leaves one log record', {
    outcome: 'Every request to every route leaves one log record, carrying its trace id',
    criteria: [
      { given: 'any route', when: 'it answers a request', expect: 'one log record names the method, status and time' },
      { given: 'a search', when: 'its log record is written', expect: 'it carries the trace id of the request' },
      { given: 'a search for nothing at all', when: 'it answers', expect: 'it is logged like any other' },
    ],
    scope: ['src/pages/search.ts', 'test/logging.test.ts'],
    risks: [],
    rollout: 'Ships as a normal release behind the canary.',
  })
  .calls('coder', '2:40', '8:50', { calls: 17, input: 470_000, output: 10_400, cached: 0.86 })
  .at('9:00', 'pull-request.pushed', 'coder', 'Failing test first, then the fix · PR #1266', {
    number: 1266,
    title: 'fix(search): log every search, like every other request',
    branch: 'factory/1265-search-logs',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/search.ts', added: 4, removed: 1 },
      { path: 'test/logging.test.ts', added: 31, removed: 0 },
    ],
  })
  .gates('9:10', { pullRequest: 1266 })
  .calls('reviewer', '11:40', '12:50', { calls: 2, input: 39_000, output: 2_100, cached: 0.5 })
  .at('13:00', 'review.submitted', 'reviewer', 'Approved', {
    pullRequest: 1266,
    verdict: 'approved',
    comments: 1,
    note: 'The new test covers every route, not only search, so the next route to forget cannot.',
  })
  .at('13:10', 'pull-request.merged', 'factory', 'PR #1266 merged: low risk, so no one needed to approve it', {
    number: 1266,
    commit: commitFor('1265/merge'),
    by: 'factory',
  })
  .at('14:20', 'release.started', 'rollouts', 'v0.8.5 signed and admitted; canary at 25%', {
    version: 'v0.8.5',
    previous: 'v0.8.4',
    digest: digestFor('v0.8.5'),
    signed: true,
    admitted: true,
  })
  .at('15:10', 'canary.stepped', 'rollouts', 'Canary at 25%: every check passing', {
    version: 'v0.8.5',
    weight: 25,
    analysis: {
      errorRate: { canary: 0.0019, baseline: 0.0021 },
      p99Ms: { canary: 128, baseline: 131 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
  })
  .at('16:50', 'release.promoted', 'rollouts', 'v0.8.5 promoted to 100%', { version: 'v0.8.5', previous: 'v0.8.4' })
  .verify('21:00', 'A log record, with its trace, for every search for 20 minutes', {
    check: 'A log record for every search',
    against: 'v0.8.4',
    version: 'v0.8.5',
    evidence: {
      kind: 'logs',
      route: '/search',
      version: 'v0.8.5',
      requests: 226,
      lines: [
        { ts: '2026-09-29T13:29:07.412Z', level: 'info', message: 'GET /search 200 39ms', traceId: after[0] ?? null },
        { ts: '2026-09-29T13:29:11.087Z', level: 'info', message: 'GET /search 200 42ms', traceId: after[1] ?? null },
      ],
      trace: {
        id: after[0] ?? '',
        spans: [
          { name: 'GET /search', offsetMs: 0, durationMs: 39 },
          { name: 'catalogue.search', offsetMs: 5, durationMs: 11 },
          { name: 'render search', offsetMs: 17, durationMs: 17 },
          { name: 'log record', offsetMs: 38, durationMs: 0, note: 'new' },
        ],
      },
    },
  })
  .at('21:01', 'work-item.closed', 'factory', 'Closed: verified', {
    outcome: 'verified',
    reason: 'Every search leaves a log record with its trace',
  })
  .at('21:02', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'Searches left no log record',
    description:
      'Every route but search wrote a log line for each request, so a slow search could not be followed from the logs. Now every search does.',
    story:
      'The log check counts log records against requests on every route. On search it found 214 requests in an hour and not one record, so a slow search could be seen in a trace but never found from the logs. Triage opened a ticket with the trace attached. The coder wrote a test that every route logs each request, watched it fail on search, then added the missing record. After release, every search has logged its line, with its trace id, for twenty minutes.',
  });
