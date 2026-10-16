/**
 * Whether a description's folded sections render, read line by line, with no renderer: the describer's result is
 * read with a synchronous `safeParse`, and `.claude/skills/visual-pr/bin/check.ts` checks Martin's descriptions with
 * the same rule before it asks GitHub's renderer.
 *
 * A folded section is a `<details>` with a `<summary>`. In GitHub Flavored Markdown, as in CommonMark, a line that
 * starts with either tag, opening or closing, starts an HTML block, and only a blank line ends it: every line until
 * then is kept as it is, so Markdown there is shown as text. That is the whole rule. A blank line after `<summary>`,
 * after `</summary>` and after `</details>` is what lets the Markdown beside them render; one before `</summary>` and
 * `</details>` is tidy but not needed, since such a tag may interrupt a paragraph or a list.
 *
 * It is no Markdown parser: it knows fenced code, where a tag is only text, and nothing else of Markdown. It reads a
 * description written in Markdown, as the describer's and Martin's are, not one written in HTML, as Dependabot's are.
 */

/** The tags that fold, opening or closing, at the start of a line, indented by three spaces at most. */
const FOLD = /^ {0,3}<\/?(?:details|summary)(?:[\s>]|$)/i;

/** Any HTML tag or comment, which an HTML block shows as HTML. */
const TAG = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi;
const HAS_TAG = /<!--|<\/?[a-z][^>]*>/i;

/**
 * Markdown, which an HTML block would show as text: a heading, a list's item, a quote, a fence or a table's row at
 * the start; strong emphasis, code or a link anywhere. Plain words are left alone, since they read the same as text.
 */
const MARKDOWN = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)|\*\*|__|`|\]\(/;

/**
 * A fence that opens or closes fenced code: three or more backticks or tildes, indented by three spaces at most. A
 * backtick fence's info string has no backtick: "```npm test``` runs it" is inline code.
 */
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

/** A quote's markers, which a fold inside a quote stands behind. */
const QUOTED = /^ {0,3}(?:> ?)+/;

/** Where a tag is only text: inline code of any number of backticks, and an HTML comment. */
const NOT_TAGS = /(`+)[^`][\s\S]*?\1|<!--[\s\S]*?-->/g;

const quote = (line: string) => `“${line.trim().slice(0, 80)}”`;

/** What would not render in a description's folded sections, a line for each problem; none when they all render. */
export function unrenderedFolds(markdown: string): string[] {
  const found: string[] = [];
  let fence = '';
  let inBlock = false;
  let depth = 0;
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(QUOTED, '');
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      // Closed by a fence of the same character, at least as long, with nothing after it.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length)) {
        fence = '';
      }
      continue;
    }
    if (!line.trim()) {
      inBlock = false;
      continue;
    }
    if (inBlock || FOLD.test(line)) {
      // Every line of the block is kept as it is: plain words read the same (a summary's title, say), Markdown not.
      if (MARKDOWN.test(line.replace(TAG, ' ').trim())) {
        const fix = HAS_TAG.test(line) ? 'put the Markdown on a line of its own' : 'leave a blank line before it';
        found.push(`a folded section shows ${quote(line)} as text: ${fix}`);
      }
      inBlock = true;
    } else if (marker) {
      fence = marker;
      continue;
    } else if (/^ {4}/.test(line)) {
      // Indented four spaces or more, outside a block: code, or a list's deeper content, where it is not followed.
      continue;
    }
    for (const [tag] of line.replace(NOT_TAGS, '').matchAll(/<\/?details\b/gi)) {
      depth += tag.startsWith('</') ? -1 : 1;
      if (depth < 0) {
        found.push('a </details> closes no <details>');
        depth = 0;
      }
    }
  }
  if (depth > 0) found.push('a <details> is not closed, so the rest of the description folds into it');
  return found;
}
