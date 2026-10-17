// Renders a pull request's description as GitHub does and says what did not render: node check.ts <file> | --pr <n>
// A <details> section is easy to break by a blank line: Markdown inside an HTML block stays literal until one ends
// it. The describer's rule for that, read line by line (folds.ts), goes first and names the line; GitHub's renderer
// then catches the rest. With --pr it checks the published body, where no local path may be left either: gh rewrites
// an attached file's path only when the upload works. Exit 0 when nothing is wrong, 1 with a line for each problem.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { outsideCode } from '../../../../apps/factory/src/line/agents/code.ts';
import { unrenderedFolds } from '../../../../apps/factory/src/line/agents/folds.ts';

/**
 * What is wrong with a description, given its Markdown and GitHub's rendering of it, which is empty when the folds
 * already failed; `published` adds local paths.
 */
export function problems(body: string, html: string, published: boolean, folds = unrenderedFolds(body)): string[] {
  const found: string[] = [...folds];
  const count = (re: RegExp) => html.match(re)?.length ?? 0;

  if (count(/<details[\s>]/g) !== count(/<\/details>/g)) found.push('a <details> is not closed');
  if (count(/<summary>/g) !== count(/<details[\s>]/g)) found.push('a <details> has no <summary>, or one has two');
  for (const [, inner] of html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)) {
    const title = (inner ?? '').trim();
    if (!/^<h[1-6][^>]*>[\s\S]*<\/h[1-6]>$/.test(title)) {
      found.push(`a summary is not one heading (blank lines around a "## title"?): ${title.slice(0, 80)}`);
    }
  }
  // Markdown left as text: what is outside code and pre, and still looks like Markdown.
  const text = html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code[\s\S]*?<\/code>/g, '');
  for (const line of text.split('\n')) {
    if (/^\s*(#{1,6} |[-*] |\d+\. |```)|\*\*|\]\(/.test(line)) found.push(`Markdown left as text: ${line.trim()}`);
  }
  if (published) {
    // Where a link or picture points, in each form Markdown and HTML allow: inline, a reference's definition, and src
    // or href; code, which shows such forms without being them, aside. Anything but a web address or an anchor is a
    // path on this Mac, which GitHub would show broken.
    const prose = outsideCode(body);
    const targets = [
      ...prose.matchAll(/\]\(\s*<?([^)\s>]+)/g),
      ...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)/gm),
      ...prose.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)/g),
    ].map((m) => m[1] ?? '');
    for (const target of targets) {
      if (!/^(https?:|mailto:|#)/.test(target)) found.push(`a local path is left: ${target}`);
    }
  }
  return found;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const pr = args[0] === '--pr' ? args[1] : undefined;
  if (!args[0] || (args[0] === '--pr' && !pr)) {
    console.error('usage: node check.ts <file> | --pr <n>');
    process.exit(2);
  }
  const gh = (...a: string[]) => execFileSync('gh', a, { encoding: 'utf8', input: '' });
  const body = pr ? gh('pr', 'view', pr, '--json', 'body', '-q', '.body') : readFileSync(args[0], 'utf8');
  const repo = gh('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner').trim();
  // GitHub's own renderer: it reads the text and publishes nothing. Not needed for folds the rule already named, whose
  // Markdown left as text it would name again.
  const folds = unrenderedFolds(body);
  const html = folds.length
    ? ''
    : execFileSync('gh', ['api', 'markdown', '-f', 'mode=gfm', '-f', `context=${repo}`, '-F', 'text=@-'], {
        encoding: 'utf8',
        input: body,
      });
  const found = problems(body, html, pr !== undefined, folds);
  for (const p of found) console.log(p);
  process.exit(found.length ? 1 : 0);
}
