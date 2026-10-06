/**
 * The bench's fixtures: invented work for each agent, from which its module builds the prompt the line would send.
 * A fixture names the app's commit it starts from, pinned, so a step recorded from it replays from the cassettes
 * for as long as they are kept; and, for a defect the app does not have, a seed the prepare step commits as the base.
 *
 * Every fixture is invented: a ticket, a spec or a pull request no visitor wrote. A cassette recorded from one holds
 * only that and the app's public code.
 */
import { protectedFrom } from '../../github/paths.ts';
import { SMOKE_SCOPE, SMOKE_SEED } from '../../runners/smoke.ts';
import type { AgentDefinition } from '../agents/agent.ts';
import type { AGENTS } from '../agents/index.ts';
import type { LineAgent } from '../machine.ts';

/** What an agent's step is given, as its definition takes it. */
export type InputOf<A extends LineAgent> = (typeof AGENTS)[A] extends AgentDefinition<infer I, unknown> ? I : never;

/** The work item a fixture's prompt names: one no ticket has. */
export const FIXTURE_WORK_ITEM = '999999999';

export interface Fixture<A extends LineAgent> {
  /** What the fixture asks of the agent, in a line. */
  about: string;
  /** The app's commit the step starts from. */
  commit: string;
  /** A patch committed on the commit as the step's base. */
  seed?: string;
  input: InputOf<A>;
}

/** The app's main when the smoke run's seed was last tried on it. */
const APP_MAIN = 'd487739846fd73c2af39652960aa65ed4cdb8422';

/**
 * The app's CODEOWNERS at `APP_MAIN`, without its comments, and the paths no scope may name there. A copy by hand,
 * which the line reads from GitHub instead (`protectedPaths`): it holds for `APP_MAIN` only, and a fixture pinned to
 * a later commit needs it copied again.
 */
const APP_CODEOWNERS = [
  '/.github/',
  '/deploy/',
  '/Dockerfile',
  '/.dockerignore',
  '/pnpm-workspace.yaml',
  '/release-please-config.json',
  '/Makefile',
  '/mise.toml',
  '/lefthook.yml',
  '/biome.json',
  '/tsconfig.json',
  '/vitest.config.ts',
  '/scripts/commit-msg.ts',
  '/AGENTS.md',
  '/docs/BRIEF.md',
  '/docs/REVIEWERS.md',
  '/SECURITY.md',
  '/LICENSE',
]
  .map((path) => `${path} @mrogan`)
  .join('\n');
const APP_PROTECTED = protectedFrom(APP_CODEOWNERS);

/** A price written with its pence as a number, not two digits: £35.0 for £35.00, £2.5 for £2.05. */
const PRICE_SEED = `diff --git a/src/money.ts b/src/money.ts
--- a/src/money.ts
+++ b/src/money.ts
@@ -1,4 +1,4 @@
 /** Prices are whole pence in the database and pounds on the page: 1250 → "£12.50". */
 export function pounds(pence: number): string {
-  return \`£\${(pence / 100).toFixed(2)}\`;
+  return \`£\${Math.trunc(pence / 100)}.\${pence % 100}\`;
 }
diff --git a/test/money.test.ts b/test/money.test.ts
--- a/test/money.test.ts
+++ b/test/money.test.ts
@@ -4,8 +4,6 @@ import { pounds } from '../src/money.ts';
 describe('pounds', () => {
   it.each([
     [1250, '£12.50'],
-    [5, '£0.05'],
-    [100, '£1.00'],
     [199, '£1.99'],
   ])('writes %i pence as %s', (pence, expected) => {
     expect(pounds(pence)).toBe(expected);
`;

/** The image leaves out every file under public/ but the style sheet, though the server and its tests have them. */
const ASSETS_SEED = `diff --git a/.dockerignore b/.dockerignore
--- a/.dockerignore
+++ b/.dockerignore
@@ -4,6 +4,6 @@
 !pnpm-lock.yaml
 !pnpm-workspace.yaml
 !src
-!public
+!public/*.css
 !scripts/seed.ts
 !data/catalogue.json
`;

export const FIXTURES: { [A in LineAgent]: Record<string, Fixture<A>> } = {
  planner: {
    'wrong-price': {
      about: 'a clear defect, seeded: prices lose their second digit of pence (£35.0)',
      commit: APP_MAIN,
      seed: PRICE_SEED,
      input: {
        workItem: FIXTURE_WORK_ITEM,
        ticket: {
          title: 'A wrong result on /products/:slug',
          category: 'functional',
          severity: 'broken',
          fingerprint: { route: '/products/:slug', class: 'wrong-result' },
          traces: [],
        },
        signals: [
          {
            sense: 'probe',
            check: 'a price is in pounds and two digits of pence',
            route: '/products/:slug',
            version: 'd487739',
            symptom: 'wrong-result',
            evidence: [
              {
                kind: 'http',
                method: 'GET',
                url: '/products/camera',
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                timings: { firstByteMs: 12, totalMs: 15 },
                redirects: [],
              },
            ],
          },
        ],
        protectedPaths: APP_PROTECTED,
        answers: [],
      },
    },
    'words-not-here': {
      about: 'one it cannot make testable: a visitor reports words the app has nowhere',
      commit: APP_MAIN,
      input: {
        workItem: FIXTURE_WORK_ITEM,
        ticket: {
          title: 'A visitor reports wrong words on /about',
          category: 'content',
          severity: 'cosmetic',
          fingerprint: { page: '/about', text: 'Every order ships free the next working day, wrapped in tissue.' },
          traces: [],
        },
        // A report's signal never reaches the planner.
        signals: [],
        protectedPaths: APP_PROTECTED,
        answers: [],
      },
    },
    'assets-left-out': {
      about: 'one whose fix is in a protected path, seeded: the image leaves out the drawings and scripts',
      commit: APP_MAIN,
      seed: ASSETS_SEED,
      input: {
        workItem: FIXTURE_WORK_ITEM,
        ticket: {
          title: 'An image does not load on every page',
          category: 'navigation',
          severity: 'cosmetic',
          fingerprint: { route: '*', class: 'broken-image' },
          traces: [],
        },
        signals: [
          {
            sense: 'crawler',
            check: 'every image on a page loads',
            route: '*',
            version: 'd487739',
            symptom: 'broken-image',
            evidence: [
              {
                kind: 'http',
                method: 'GET',
                url: '/assets/drawings/camera.svg',
                status: 404,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                timings: { firstByteMs: 3, totalMs: 4 },
                redirects: [],
              },
              {
                kind: 'http',
                method: 'GET',
                url: '/assets/site.css',
                status: 200,
                headers: { 'content-type': 'text/css; charset=utf-8' },
                timings: { firstByteMs: 2, totalMs: 3 },
                redirects: [],
              },
              {
                kind: 'console',
                route: '/products',
                version: 'd487739',
                messages: [
                  {
                    level: 'error',
                    text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
                    source: 'http://website.localhost:8080/assets/report.js',
                  },
                ],
              },
            ],
          },
        ],
        protectedPaths: APP_PROTECTED,
        answers: [],
      },
    },
  },
  coder: {
    'off-by-one': {
      about: "the smoke run's seeded off-by-one: `lastIndex` returns one past a list's last index",
      commit: APP_MAIN,
      seed: SMOKE_SEED,
      input: {
        workItem: FIXTURE_WORK_ITEM,
        round: 1,
        spec: {
          outcome: "`lastIndex` in src/smoke.ts returns the index of a list's last item.",
          criteria: [
            { given: 'a list of three items', when: '`lastIndex` is asked for its last index', expect: 'it returns 2' },
          ],
          scope: SMOKE_SCOPE,
          risks: [],
          rollout: 'Nothing calls `lastIndex` yet, so the fix ships as it is.',
        },
      },
    },
  },
  reviewer: {},
  describer: {},
};
