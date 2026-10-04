/**
 * The test integrity gate (spec 4.1): fails a change that deletes, skips or weakens an existing test.
 *
 *     node apps/factory/src/gates/test-integrity.ts <base checkout> <change checkout>
 *
 * Run by the shared workflow `app-gates.yml`, from this repository at the commit the app's repository pins, so a
 * pull request cannot change the rule it is judged by. Node alone: no dependencies.
 */

import { filesIn, TEST_FILE } from './files.ts';
import { compare } from './integrity.ts';
import { annotate, cell, summarise } from './report.ts';

export async function main([base, change]: string[]): Promise<number> {
  if (!base || !change) {
    console.error('Usage: test-integrity.ts <base checkout> <change checkout>');
    return 2;
  }
  const { problems, added } = compare(await filesIn(base, TEST_FILE), await filesIn(change, TEST_FILE));
  for (const p of problems) annotate('error', p.message, p.file);
  const rows = (findings: typeof problems) =>
    findings.map((f) => `| \`${cell(f.file)}\` | ${cell(f.message)} |`).join('\n');
  await summarise(
    [
      '## Test integrity',
      problems.length
        ? `This change weakens ${problems.length === 1 ? 'a test' : `${problems.length} tests`}. Existing tests may not be deleted, skipped or left with fewer assertions.\n\n| File | What changed |\n|---|---|\n${rows(problems)}`
        : 'No existing test was deleted, skipped or left with fewer assertions.',
      added.length
        ? `\n${added.length} test${added.length === 1 ? '' : 's'} added.\n\n| File | Test |\n|---|---|\n${rows(added)}`
        : '',
    ].join('\n\n'),
  );
  return problems.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
