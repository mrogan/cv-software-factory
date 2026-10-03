/** A visitor's report that was not a defect: triage read it against the page and closed it, for a tenth of a penny. */
import { Item, JEV, jevCassette, triageAnswers } from '../build.ts';
import { shot } from '../captures.ts';

// Untrusted. It goes to Jev as data, never to a generative agent, and no public view carries it.
const REPORT = 'It says Gerald reads every message on a Thursday. It is Saturday. Will he still read mine on Thursday?';

export default new Item('1268', '2026-09-30T11:20:00+01:00')
  .at('0:00', 'work-item.opened', 'visitor', 'A visitor sent a report from the contact page', {
    kind: 'visitor-report',
    title: 'A report from the contact page',
    sample: true,
    visitor: { key: 'quiet-heron' },
  })
  .at(
    '0:00',
    'signal.received',
    'widget',
    'A visitor reported a problem on /contact',
    {
      sense: 'report',
      check: 'report widget',
      route: '/contact',
      version: 'v0.8.5',
      report: { page: '/contact', text: REPORT },
    },
    [shot('published/contact', 'v0.8.5')],
  )
  .at('0:01', 'judgement.made', 'triage', 'Triage: not a problem (0.93), no harm, no instructions (0.02)', {
    ...JEV,
    state: { report: { page: '/contact', text: REPORT } },
    answers: triageAnswers('not_a_problem', 0.93, [0.88, 0.09, 0.02, 0.01], 0.02),
    route: 'discard',
    costUsd: 0.0011,
    durationMs: 103,
    cassette: jevCassette('1268'),
  })
  .at('0:01', 'work-item.closed', 'triage', 'Closed with no ticket; kept in the triage log', {
    outcome: 'no-change',
    reason: 'Not a problem with the page: it works, and says what it should',
  })
  .at('0:02', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'A visitor’s question about the contact page',
    description:
      'Triage read the report against the page and found nothing wrong with it. No ticket, nothing built, a tenth of a penny.',
    story:
      'A visitor sent a report from the contact page. Report text is untrusted, so it went to Jev as data and never to a generative agent. Jev answered triage’s three typed questions: not a problem, no harm, no instructions for the system. Routing code closed it with no ticket, because the page works and says what it should. The report stays in the triage log, where Martin can read it.',
  });
