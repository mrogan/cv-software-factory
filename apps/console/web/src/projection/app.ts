/**
 * What the console knows of the app beside its events: the one copy it keeps, since its image holds neither the
 * app's repository nor the factory's code. The line's limits and the scope's path rule it reads from
 * `@software-factory/events`, which the line reads them from too.
 */

/**
 * The app's rules for reviewing, as its `docs/REVIEWERS.md` words them (mrogan/cv-worlds-worst-website at d854a4b).
 * A finding cites a rule by number; the console prints the rule beside it, because "rule 3" alone means nothing to
 * someone who has not read them. The events carry the number only.
 */
export const RULES: Record<number, { title: string; text: string }> = {
  1: {
    title: 'Deep modules',
    text: 'A module hides a decision behind a small interface. Pages and the API read the shop through the catalogue, never the database.',
  },
  2: {
    title: 'Collaborators come in',
    text: 'A module is given its database, catalogue or reports, so a test can pass its own; only createShop wires them together.',
  },
  3: {
    title: 'Test at the seams',
    text: 'Tests go through the shop over HTTP, on the test catalogue, and check what a visitor sees: text, links and status, not markup or internals.',
  },
  4: {
    title: 'One form inside',
    text: 'Money is whole pence and dates are ISO strings until a page shows them; formatting happens once, at the edge.',
  },
  5: {
    title: 'Nothing new to install',
    text: 'The shop runs on Node’s own modules. A new runtime dependency, or a framework in disguise, is a finding.',
  },
};
