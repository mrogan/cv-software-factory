/** How a gate reports in GitHub Actions: a summary on the run's page, and annotations on the files. */
import { appendFile } from 'node:fs/promises';

/** Appends Markdown to the job's summary, or prints it outside Actions. */
export async function summarise(markdown: string): Promise<void> {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) await appendFile(file, `${markdown}\n`);
  else console.log(markdown);
}

/** An annotation, which GitHub shows on the file in the pull request's diff. */
export function annotate(level: 'error' | 'warning' | 'notice', message: string, file?: string): void {
  const encoded = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const where = file ? ` file=${encoded(file).replace(/,/g, '%2C').replace(/:/g, '%3A')}` : '';
  console.log(`::${level}${where}::${encoded(message)}`);
}

/** Text safe inside a Markdown table cell. */
export const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
