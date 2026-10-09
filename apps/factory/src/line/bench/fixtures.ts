/**
 * The bench's fixtures: invented work for each agent, from which its module builds the prompt the line would send.
 * A fixture names the app's commit it starts from, pinned, so a step recorded from it replays from the cassettes
 * for as long as they are kept; and, for a defect the app does not have, a seed the prepare step commits as the base.
 * A fixture for a step that reads a change (the reviewer's, the describer's) has the change too: a coder's patch,
 * which the bench commits on the base as the pull request's head.
 *
 * Every fixture is invented: a ticket, a spec or a pull request no visitor wrote. A cassette recorded from one holds
 * only that and the app's public code.
 */
import type { PayloadOf } from '@software-factory/events';
import { protectedFrom } from '../../github/paths.ts';
import { SMOKE_SCOPE, SMOKE_SEED } from '../../runners/smoke.ts';
import type { AgentDefinition } from '../agents/agent.ts';
import type { Signal } from '../agents/evidence.ts';
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
  /** A change committed on the base as the head, with its message, for a step that reads one. */
  change?: { patch: string; message: string };
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

/** The wrong price, seeded twice: in `pounds`, and copied into the product cards, which no longer call it. */
const CARDS_SEED = `${PRICE_SEED}diff --git a/src/pages/cards.ts b/src/pages/cards.ts
--- a/src/pages/cards.ts
+++ b/src/pages/cards.ts
@@ -3,7 +3,6 @@
  */
 import type { Product } from '../catalogue.ts';
 import { type Html, html } from '../html.ts';
-import { pounds } from '../money.ts';
 
 export function stockLine(stock: number): string {
   if (stock === 0) return 'None in stock';
@@ -14,7 +13,7 @@ export function productCard(product: Product): Html {
   return html\`<li class="card">
     <img src="/assets/drawings/\${product.drawing}" width="120" height="120">
     <h3><a href="/products/\${product.slug}">\${product.name}</a></h3>
-    <p class="price">\${pounds(product.pricePence)}</p>
+    <p class="price">£\${Math.trunc(product.pricePence / 100)}.\${product.pricePence % 100}</p>
     <p>\${product.summary}</p>
     <p class="quiet">Item \${product.id} · \${stockLine(product.stock)}</p>
   </li>\`;
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

/**
 * The coder's fix for the wrong price in `pounds`, as Claude wrote it from the `wrong-price` fixture, with the page's
 * test from its `cards-outside-scope` run: it meets every criterion, inside the scope.
 */
const PRICE_FIX = `diff --git a/src/money.ts b/src/money.ts
--- a/src/money.ts
+++ b/src/money.ts
@@ -1,4 +1,4 @@
 /** Prices are whole pence in the database and pounds on the page: 1250 → "£12.50". */
 export function pounds(pence: number): string {
-  return \`£\${Math.trunc(pence / 100)}.\${pence % 100}\`;
+  return \`£\${Math.trunc(pence / 100)}.\${String(pence % 100).padStart(2, '0')}\`;
 }
diff --git a/test/money.test.ts b/test/money.test.ts
--- a/test/money.test.ts
+++ b/test/money.test.ts
@@ -5,6 +5,9 @@ describe('pounds', () => {
   it.each([
     [1250, '£12.50'],
     [199, '£1.99'],
+    [600, '£6.00'],
+    [705, '£7.05'],
+    [10, '£0.10'],
   ])('writes %i pence as %s', (pence, expected) => {
     expect(pounds(pence)).toBe(expected);
   });
diff --git a/test/pages-product.test.ts b/test/pages-product.test.ts
--- a/test/pages-product.test.ts
+++ b/test/pages-product.test.ts
@@ -14,6 +14,10 @@ describe('a product page', () => {
     expect(textOf(body)).toContain('Thing, number 5 £2.25 A thing for the garden.');
   });
 
+  it('shows two zeros of pence for a price in whole pounds', async () => {
+    expect(textOf((await shop.get('/products/thing-4')).body)).toContain('Thing, number 4 £2.00');
+  });
+
   it('gives its item number, department and stock', async () => {
     const { body } = await shop.get('/products/thing-5');
     expect(textOf(body)).toContain('Item 5 Department Garden Stock 1 in stock');
`;

/** The commit message of the coder's fix for the wrong price: its title, and its note. */
const PRICE_FIX_MESSAGE = [
  'fix(money): always show two digits of pence',
  '',
  'pounds() printed the pence remainder without padding, so 600 pence showed as £6.0 and 705 pence as £7.5. The remainder is now padded to two digits. Tests added in test/money.test.ts (600, 705, 10 pence) and test/pages-product.test.ts (a whole-pound price on the product page shows £2.00); they failed before the fix and pass now, with the rest of the suite.',
].join('\n');

/**
 * The coder's fix from the `cards-outside-scope` fixture, as Claude wrote it: inside the scope, so `pounds` is fixed
 * and the cards, which no longer call it, are not; its note says they are.
 */
const CARDS_FIX = `diff --git a/src/money.ts b/src/money.ts
--- a/src/money.ts
+++ b/src/money.ts
@@ -1,4 +1,4 @@
 /** Prices are whole pence in the database and pounds on the page: 1250 → "£12.50". */
 export function pounds(pence: number): string {
-  return \`£\${Math.trunc(pence / 100)}.\${pence % 100}\`;
+  return \`£\${Math.trunc(pence / 100)}.\${String(pence % 100).padStart(2, '0')}\`;
 }
diff --git a/test/money.test.ts b/test/money.test.ts
--- a/test/money.test.ts
+++ b/test/money.test.ts
@@ -5,6 +5,10 @@ describe('pounds', () => {
   it.each([
     [1250, '£12.50'],
     [199, '£1.99'],
+    [600, '£6.00'],
+    [705, '£7.05'],
+    [10, '£0.10'],
+    [3500, '£35.00'],
   ])('writes %i pence as %s', (pence, expected) => {
     expect(pounds(pence)).toBe(expected);
   });
diff --git a/test/pages-product.test.ts b/test/pages-product.test.ts
--- a/test/pages-product.test.ts
+++ b/test/pages-product.test.ts
@@ -14,6 +14,10 @@ describe('a product page', () => {
     expect(textOf(body)).toContain('Thing, number 5 £2.25 A thing for the garden.');
   });
 
+  it('shows two zeros of pence for a price in whole pounds', async () => {
+    expect(textOf((await shop.get('/products/thing-4')).body)).toContain('Thing, number 4 £2.00');
+  });
+
   it('gives its item number, department and stock', async () => {
     const { body } = await shop.get('/products/thing-5');
     expect(textOf(body)).toContain('Item 5 Department Garden Stock 1 in stock');
`;

/** The coder's fix for the smoke run's off-by-one, after a review sent its first test back: test first, then the fix. */
const SMOKE_FIX = `diff --git a/src/smoke.ts b/src/smoke.ts
--- a/src/smoke.ts
+++ b/src/smoke.ts
@@ -1,4 +1,4 @@
 /** The index of a list's last item. */
 export function lastIndex(items: readonly unknown[]): number {
-  return items.length;
+  return items.length - 1;
 }
diff --git a/test/smoke.test.ts b/test/smoke.test.ts
new file mode 100644
--- /dev/null
+++ b/test/smoke.test.ts
@@ -0,0 +1,12 @@
+import { describe, expect, it } from 'vitest';
+import { lastIndex } from '../src/smoke.ts';
+
+describe('lastIndex', () => {
+  it('gives the index of the last of three items', () => {
+    expect(lastIndex(['a', 'b', 'c'])).toBe(2);
+  });
+
+  it('gives the index of the only item', () => {
+    expect(lastIndex(['a'])).toBe(0);
+  });
+});
`;

/** The ticket triage would open for the wrong price, as its public view has it. */
const PRICE_TICKET: PayloadOf<'ticket.opened'> = {
  title: 'A wrong result on /products/:slug',
  category: 'functional',
  severity: 'broken',
  fingerprint: { route: '/products/:slug', class: 'wrong-result' },
  traces: [],
};

/** What the probe saw of the wrong price. */
const PRICE_SIGNALS: Signal[] = [
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
];

/**
 * A spec for the wrong price, as the planner writes one: invented, like the ticket, after the spec Claude wrote from
 * the planner's `wrong-price` fixture.
 */
const PRICE_SPEC: PayloadOf<'spec.written'> = {
  outcome: 'Every price shows pounds and exactly two digits of pence, so 3500 pence is £35.00 and 705 pence is £7.05.',
  criteria: [
    { given: 'a price of 600 pence', when: 'pounds is called with it', expect: 'it returns £6.00', from: 'signal 1' },
    { given: 'a price of 705 pence', when: 'pounds is called with it', expect: 'it returns £7.05', from: 'signal 1' },
    { given: 'a price of 10 pence', when: 'pounds is called with it', expect: 'it returns £0.10', from: 'signal 1' },
    {
      given: 'a product that costs a whole number of pounds',
      when: 'a visitor opens its page',
      expect: 'the price shows two zeros of pence, such as £2.00',
      from: 'the ticket',
    },
  ],
  scope: ['src/money.ts', 'test/money.test.ts', 'test/pages-product.test.ts'],
  risks: [],
  rollout: 'Ships in the next release; product pages, cards and the API then show two digits of pence.',
};

/** The wrong price's spec, with a criterion on the product cards, whose file is outside its scope. */
const CARDS_SPEC: PayloadOf<'spec.written'> = {
  ...PRICE_SPEC,
  criteria: [
    ...PRICE_SPEC.criteria,
    {
      given: 'a product that costs a whole number of pounds',
      when: 'a visitor opens the product list',
      expect: 'its card shows the price with two zeros of pence, such as £2.00',
      from: 'the ticket',
    },
  ],
};

/**
 * The wrong price's spec, widened: a criterion for thousands separators, which no evidence of the ticket asks for,
 * though the planner says the ticket does. The fix the line wants is two digits of pence and nothing more.
 */
const WIDENED_SPEC: PayloadOf<'spec.written'> = {
  ...PRICE_SPEC,
  criteria: [
    ...PRICE_SPEC.criteria,
    {
      given: 'a price of 1234567 pence',
      when: 'pounds is called with it',
      expect: 'it returns £12,345.67, with a comma between thousands',
      from: 'the ticket',
    },
  ],
};

/** The coder's fix for the widened spec: two digits of pence, and the thousands separators no ticket asked for. */
const WIDENED_FIX = `diff --git a/src/money.ts b/src/money.ts
--- a/src/money.ts
+++ b/src/money.ts
@@ -1,4 +1,5 @@
 /** Prices are whole pence in the database and pounds on the page: 1250 → "£12.50". */
 export function pounds(pence: number): string {
-  return \`£\${Math.trunc(pence / 100)}.\${pence % 100}\`;
+  const whole = String(Math.trunc(pence / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
+  return \`£\${whole}.\${String(pence % 100).padStart(2, '0')}\`;
 }
diff --git a/test/money.test.ts b/test/money.test.ts
--- a/test/money.test.ts
+++ b/test/money.test.ts
@@ -5,6 +5,10 @@ describe('pounds', () => {
   it.each([
     [1250, '£12.50'],
     [199, '£1.99'],
+    [600, '£6.00'],
+    [705, '£7.05'],
+    [10, '£0.10'],
+    [1234567, '£12,345.67'],
   ])('writes %i pence as %s', (pence, expected) => {
     expect(pounds(pence)).toBe(expected);
   });
diff --git a/test/pages-product.test.ts b/test/pages-product.test.ts
--- a/test/pages-product.test.ts
+++ b/test/pages-product.test.ts
@@ -14,6 +14,10 @@ describe('a product page', () => {
     expect(textOf(body)).toContain('Thing, number 5 £2.25 A thing for the garden.');
   });
 
+  it('shows two zeros of pence for a price in whole pounds', async () => {
+    expect(textOf((await shop.get('/products/thing-4')).body)).toContain('Thing, number 4 £2.00');
+  });
+
   it('gives its item number, department and stock', async () => {
     const { body } = await shop.get('/products/thing-5');
     expect(textOf(body)).toContain('Item 5 Department Garden Stock 1 in stock');
`;

export const FIXTURES: { [A in LineAgent]: Record<string, Fixture<A>> } = {
  planner: {
    'wrong-price': {
      about: 'a clear defect, seeded: prices lose their second digit of pence (£35.0)',
      commit: APP_MAIN,
      seed: PRICE_SEED,
      input: {
        workItem: FIXTURE_WORK_ITEM,
        ticket: PRICE_TICKET,
        signals: PRICE_SIGNALS,
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
        ticket: {
          title: 'A wrong result from lastIndex',
          category: 'functional',
          severity: 'degraded',
          fingerprint: { route: '/', class: 'wrong-result' },
          traces: [],
        },
        signals: [],
        round: 1,
        protectedPaths: APP_PROTECTED,
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
    'wrong-price': {
      about: "the planner's wrong price, seeded, from a spec like the one it wrote: `pounds` drops a digit of pence",
      commit: APP_MAIN,
      seed: PRICE_SEED,
      input: {
        workItem: FIXTURE_WORK_ITEM,
        ticket: PRICE_TICKET,
        signals: PRICE_SIGNALS,
        spec: PRICE_SPEC,
        round: 1,
        protectedPaths: APP_PROTECTED,
      },
    },
    'cards-outside-scope': {
      about:
        'the wrong price, seeded in `pounds` and copied into the product cards, with a criterion on the cards but `src/pages/cards.ts` outside the scope',
      commit: APP_MAIN,
      seed: CARDS_SEED,
      input: {
        workItem: FIXTURE_WORK_ITEM,
        ticket: PRICE_TICKET,
        signals: PRICE_SIGNALS,
        spec: CARDS_SPEC,
        round: 1,
        protectedPaths: APP_PROTECTED,
      },
    },
  },
  reviewer: {
    'price-fixed': {
      about: "the coder's fix for the wrong price: every criterion met, inside the scope, so one to approve",
      commit: APP_MAIN,
      seed: PRICE_SEED,
      change: {
        patch: PRICE_FIX,
        message: PRICE_FIX_MESSAGE,
      },
      input: {
        workItem: FIXTURE_WORK_ITEM,
        ticket: PRICE_TICKET,
        signals: PRICE_SIGNALS,
        spec: PRICE_SPEC,
        pullRequest: 101,
        title: 'fix(money): always show two digits of pence',
        round: 1,
      },
    },
    'spec-widens': {
      about:
        'the wrong price, with a spec the planner widened: a criterion for thousands separators no evidence asks for, met by the change, so one to escalate',
      commit: APP_MAIN,
      seed: PRICE_SEED,
      change: {
        patch: WIDENED_FIX,
        message: [
          'fix(money): show two digits of pence, and separate thousands',
          '',
          'pounds() printed the pence remainder without padding, so 600 pence showed as £6.0. It now pads the pence to two digits and puts a comma between thousands of pounds, as the spec asks. Tests in test/money.test.ts cover 600, 705, 10 and 1234567 pence, and test/pages-product.test.ts checks a whole-pound price on its page.',
        ].join('\n'),
      },
      input: {
        workItem: FIXTURE_WORK_ITEM,
        ticket: PRICE_TICKET,
        signals: PRICE_SIGNALS,
        spec: WIDENED_SPEC,
        pullRequest: 104,
        title: 'fix(money): show two digits of pence, and separate thousands',
        round: 1,
      },
    },
    'cards-claimed': {
      about:
        "the coder's fix for the wrong price in `pounds` and the cards, inside a scope without the cards: its note says the cards are fixed, and they are not",
      commit: APP_MAIN,
      seed: CARDS_SEED,
      change: {
        patch: CARDS_FIX,
        message: [
          'fix(money): pad pence to two digits in prices',
          '',
          "pounds() printed the remainder of pence / 100 without padding, so 600 pence showed as £6.0, 705 as £7.5 and 3500 as £35.0. It now pads the pence to two digits. Tests in test/money.test.ts cover 600, 705, 10 and 3500 pence; test/pages-product.test.ts checks that /products/thing-4 (200 pence) shows £2.00. The product list and the API use the same pounds(), so the card is fixed too; the test catalogue's list page is outside the allowed scope, so it has no new test of its own. Nothing else was changed.",
        ].join('\n'),
      },
      input: {
        workItem: FIXTURE_WORK_ITEM,
        ticket: PRICE_TICKET,
        signals: PRICE_SIGNALS,
        spec: CARDS_SPEC,
        pullRequest: 102,
        title: 'fix(money): pad pence to two digits in prices',
        round: 1,
      },
    },
  },
  describer: {
    'wrong-price': {
      about: "the coder's fix for the wrong price, which the gates and the reviewer passed in one round",
      commit: APP_MAIN,
      seed: PRICE_SEED,
      change: { patch: PRICE_FIX, message: PRICE_FIX_MESSAGE },
      input: {
        workItem: '999999999',
        ticket: PRICE_TICKET,
        signals: PRICE_SIGNALS,
        spec: PRICE_SPEC,
        pullRequest: 101,
        title: 'fix(money): always show two digits of pence',
        reviews: [
          {
            pullRequest: 101,
            verdict: 'approved',
            note: 'Every criterion has a test that fails on the base and passes here, and the change stays inside its scope.',
            findings: [
              {
                path: 'test/money.test.ts',
                line: 10,
                blocking: false,
                rule: 5,
                comment: 'A case of 3500 pence would show the £35.00 the outcome names.',
              },
            ],
          },
        ],
        returns: [],
      },
    },
    'off-by-one': {
      about:
        "the smoke run's off-by-one, fixed in a second round after the review sent back a test that showed nothing",
      commit: APP_MAIN,
      seed: SMOKE_SEED,
      change: {
        patch: SMOKE_FIX,
        message: [
          'fix(smoke): give the index of the last item, not one past it',
          '',
          'lastIndex returned the length of the list, one past its last index. It returns the length less one now. test/smoke.test.ts checks a list of three items (2) and a list of one (0); both failed before the fix. The first round tested only an empty list, which the review said shows nothing of the criterion.',
        ].join('\n'),
      },
      input: {
        workItem: '999999999',
        ticket: {
          title: 'A wrong result from lastIndex',
          category: 'functional',
          severity: 'degraded',
          fingerprint: { route: '/', class: 'wrong-result' },
          traces: [],
        },
        signals: [],
        spec: {
          outcome: "`lastIndex` in src/smoke.ts returns the index of a list's last item.",
          criteria: [
            { given: 'a list of three items', when: '`lastIndex` is asked for its last index', expect: 'it returns 2' },
          ],
          scope: SMOKE_SCOPE,
          risks: [],
          rollout: 'Nothing calls `lastIndex` yet, so the fix ships as it is.',
        },
        pullRequest: 103,
        title: 'fix(smoke): give the index of the last item, not one past it',
        reviews: [
          {
            pullRequest: 103,
            verdict: 'changes-requested',
            note: 'The test checks only an empty list, so nothing shows criterion 1.',
            findings: [
              {
                path: 'test/smoke.test.ts',
                line: 5,
                blocking: true,
                criterion: 1,
                comment: 'An empty list says nothing of a list of three: test that lastIndex of three items is 2.',
              },
            ],
          },
          {
            pullRequest: 103,
            verdict: 'approved',
            note: 'The test now shows criterion 1, and fails on the base.',
            findings: [],
          },
        ],
        returns: [
          {
            from: 'review',
            reason: 'Review asked for changes: The test checks only an empty list, so nothing shows criterion 1.',
          },
        ],
      },
    },
  },
};
