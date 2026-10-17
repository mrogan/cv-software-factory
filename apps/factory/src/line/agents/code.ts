/**
 * Where Markdown has code, by CommonMark's rules for fences and inline code, read with no parser: fenced code, where a
 * tag, a link or a mention is only text, and inline code of any number of backticks. Indented code is not known here,
 * since four spaces may as well be a list's deeper content. Shared by `folds.ts`, by `mentions` in `agent.ts` and by
 * `.claude/skills/visual-pr/bin/check.ts`, so that the three agree on what is code.
 */

/**
 * A fence that opens or closes fenced code: three or more backticks or tildes, indented by three spaces at most. A
 * backtick fence's info string has no backtick: "```npm test``` runs it" is inline code.
 */
export const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

/** Whether a line closes a fence's code: a fence of the same character, at least as long, with nothing after it. */
export function closes(fence: string, line: string): boolean {
  const marker = FENCE.exec(line)?.[1];
  return !!marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length);
}

/** A quote's markers, which a fence or a fold inside a quote stands behind. */
export const QUOTED = /^ {0,3}(?:> ?)+/;

/**
 * Inline code: a run of backticks closed by a run of exactly as many, within a paragraph. An opening run with no such
 * close is only text.
 */
export const INLINE = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;

const blank = (text: string) => text.replace(/[^\n]/g, ' ');

/**
 * Markdown with its code blanked: each character of fenced or inline code, fences included, becomes a space, and each
 * line stays where it was, so what reads lines or what stood beside the code still finds them. Code left unclosed by
 * its fence runs to the end, as in CommonMark.
 */
export function outsideCode(markdown: string): string {
  const out: string[] = [];
  let prose: string[] = [];
  let fence = '';
  const flush = () => {
    if (prose.length) out.push(prose.join('\n').replace(INLINE, blank));
    prose = [];
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(QUOTED, '');
    if (fence) {
      if (closes(fence, line)) fence = '';
      out.push(blank(raw));
      continue;
    }
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      flush();
      fence = marker;
      out.push(blank(raw));
    } else {
      prose.push(raw);
    }
  }
  flush();
  return out.join('\n');
}
