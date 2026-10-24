/**
 * A visitor's suggestion, parked for Martin: Jev judged it a request for something new, and only Martin asks for an
 * improvement. He answered it in words, which leave it waiting until he rejects it (or, from Part B, turns it into an
 * improvement). The work item was opened by a visitor's report, so his words stay his: visitors see that he answered,
 * and not what he said.
 */
import { Item, JEV, jevCassette, triageAnswers } from '../build.ts';
import { shot } from '../captures.ts';

// Untrusted. It goes to Jev as data, never to a generative agent, and no public view carries it.
const REPORT = 'Could search find things by colour too? I typed green and got nothing, but there are green mugs.';

const parked = new Item('1329', '2026-10-06T12:12:00+01:00')
  .at('0:00', 'work-item.opened', 'visitor', 'A visitor sent a report from the search page', {
    kind: 'visitor-report',
    title: 'A report from the search page',
    sample: true,
    category: 'improvement',
    visitor: { key: 'amber-wren' },
  })
  .at(
    '0:00',
    'signal.received',
    'widget',
    'A visitor reported a problem on /search',
    {
      sense: 'report',
      check: 'report widget',
      route: '/search',
      version: 'v0.9.7',
      report: { page: '/search', text: REPORT },
    },
    [shot('published/search', 'v0.9.7')],
  )
  .at('0:01', 'judgement.made', 'triage', 'Triage: suggestion (0.91), no harm, no instructions (0.01)', {
    ...JEV,
    state: { report: { page: '/search', text: REPORT } },
    answers: triageAnswers('suggestion', 0.91, [0.86, 0.11, 0.02, 0.01], 0.01),
    route: 'park',
    costUsd: 0.0012,
    durationMs: 97,
    cassette: jevCassette('1329'),
  })
  .at('0:01', 'hold.started', 'triage', 'Waiting for Martin: a visitor suggested a change', {
    stage: 'triage',
    kind: 'approval',
    cause: 'suggestion',
    reason: 'A visitor asked for something new, and only Martin asks for improvements: it waits for Martin to decide.',
  });

const hold = parked.events.at(-1)?.id;

export default parked
  .at('0:02', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'A visitor’s suggestion',
    description:
      'Jev read it as a request for something new, not a fault. Triage parked it for Martin, who alone asks for improvements.',
    story:
      'A visitor sent a report from the search page. Jev judged it a suggestion: a request for new behaviour rather than a fault. Only Martin can ask for an improvement, so routing code parked it for Martin instead of opening a ticket.',
  })
  .at('2:23:00', 'hold.answered', 'martin', 'Martin answered the hold in words', {
    decision: 'answered',
    answer: 'Worth having: I’ll ask for colour in search from Plan once improvements ship.',
    ...(hold && { hold }),
    report: true,
  });
