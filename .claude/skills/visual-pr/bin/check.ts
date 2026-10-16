// Renders a pull request's description as GitHub does and says what did not render: node check.ts <file> | --pr <n>
// A <details> section is easy to break by a blank line: Markdown inside an HTML block stays literal until one ends
// it. With --pr it checks the published body, where no local path may be left either: gh rewrites an attached file's
// path only when the upload works. Exit 0 when nothing is wrong, 1 with a line for each problem.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const pr = args[0] === '--pr' ? args[1] : undefined;
if (!args[0] || (args[0] === '--pr' && !pr)) {
  console.error('usage: node check.ts <file> | --pr <n>');
  process.exit(2);
}

const gh = (...a: string[]) => execFileSync('gh', a, { encoding: 'utf8', input: '' });
const body = pr ? gh('pr', 'view', pr, '--json', 'body', '-q', '.body') : readFileSync(args[0], 'utf8');
const repo = gh('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner').trim();
// GitHub's own renderer: it reads the text and publishes nothing.
const html = execFileSync('gh', ['api', 'markdown', '-f', 'mode=gfm', '-f', `context=${repo}`, '-F', 'text=@-'], {
  encoding: 'utf8',
  input: body,
});

const problems: string[] = [];
const count = (re: RegExp) => html.match(re)?.length ?? 0;

if (count(/<details[\s>]/g) !== count(/<\/details>/g)) problems.push('a <details> is not closed');
for (const [, inner] of html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)) {
  const title = (inner ?? '').trim();
  if (!/^<h[1-6][^>]*>[\s\S]*<\/h[1-6]>$/.test(title)) {
    problems.push(`a summary is not one heading (blank lines around a "## title"?): ${title.slice(0, 80)}`);
  }
}
// Markdown left as text: what is outside code and pre, and still looks like Markdown.
const text = html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code[\s\S]*?<\/code>/g, '');
for (const line of text.split('\n')) {
  if (/^\s*(#{1,6} |[-*] |\d+\. |```)|\*\*|\]\(/.test(line)) problems.push(`Markdown left as text: ${line.trim()}`);
}
if (pr) {
  for (const [path] of body.matchAll(/\]\((\/|~|\.\.?\/)[^)]*\)/g)) problems.push(`a local path is left: ${path}`);
}

for (const p of problems) console.log(p);
process.exit(problems.length ? 1 : 0);
