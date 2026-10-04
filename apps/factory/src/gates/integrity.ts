/**
 * Test integrity: whether a change weakens the tests it was given. An agent that cannot make a test pass could make
 * it pass by changing the test, so a change fails this gate when an existing test is deleted, skipped, narrowed with
 * `.only`, or left with fewer assertions. Adding tests, and adding assertions, pass.
 *
 * A test is known by its file and its name. A test that moved to a new file under the same name has moved, not gone.
 */
import { type TestCase, testsIn } from './tests.ts';

export interface Finding {
  file: string;
  test?: string;
  message: string;
}

export interface Integrity {
  /** What weakens the tests: any one fails the gate. */
  problems: Finding[];
  /** Tests added, for the summary. */
  added: Finding[];
}

const DISABLED: Record<Exclude<TestCase['disabled'], false>, string> = {
  skip: 'is skipped',
  todo: 'is left to do',
  only: 'is narrowed with .only, which skips every other test in its file',
  conditional: 'now runs only on a condition',
};

/** Compares the test files of a pull request's base with its change's, each by path. */
export function compare(base: Map<string, string>, change: Map<string, string>): Integrity {
  const problems: Finding[] = [];
  const added: Finding[] = [];
  const tests = (files: Map<string, string>) =>
    new Map([...files].map(([file, source]) => [file, testsIn(source)] as const));
  const before = tests(base);
  const after = tests(change);
  // Tests in files the base did not have, by name: where a moved test went.
  const moved = new Map<string, { file: string; test: TestCase }>();
  for (const [file, cases] of after) if (!before.has(file)) for (const t of cases) moved.set(t.name, { file, test: t });

  for (const [file, cases] of before) {
    const now = after.get(file);
    if (!now && !cases.some((t) => moved.has(t.name))) {
      problems.push({
        file,
        message: `${file} was deleted, with its ${cases.length} test${cases.length === 1 ? '' : 's'}`,
      });
      continue;
    }
    for (const was of cases) {
      const same = now?.find((t) => t.name === was.name);
      const found = same ? { file, test: same } : moved.get(was.name);
      if (!found) {
        problems.push({ file, test: was.name, message: `"${was.name}" was deleted` });
        continue;
      }
      const { test: is, file: where } = found;
      if (is.disabled && !was.disabled) {
        problems.push({ file: where, test: was.name, message: `"${was.name}" ${DISABLED[is.disabled]}` });
      }
      if (is.assertions < was.assertions) {
        problems.push({
          file: where,
          test: was.name,
          message: `"${was.name}" has ${is.assertions} assertion${is.assertions === 1 ? '' : 's'}, down from ${was.assertions}`,
        });
      }
    }
  }
  for (const [file, cases] of after) {
    const had = before.get(file) ?? [];
    for (const t of cases) {
      const isMove = !before.has(file) && [...before.values()].some((c) => c.some((w) => w.name === t.name));
      if (!had.some((w) => w.name === t.name) && !isMove)
        added.push({ file, test: t.name, message: `"${t.name}" was added` });
      // A test that arrives already disabled weakens nothing that was there, but is worth seeing.
      if (t.disabled === 'only' && !had.some((w) => w.name === t.name)) {
        problems.push({ file, test: t.name, message: `"${t.name}" ${DISABLED.only}` });
      }
    }
  }
  return { problems, added };
}
