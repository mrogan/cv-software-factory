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
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

/** A quote's markers, which a fence or a fold inside a quote stands behind. */
export const QUOTED = /^ {0,3}(?:> ?)+/;
const MARKER = /^ {0,3}> ?/;

/** Fenced code: the fence that opened it, and how many quotes deep it stands. */
export interface Fence {
  marker: string;
  depth: number;
}

/** The fenced code a line opens, if it opens any. */
export function opens(line: string): Fence | undefined {
  const quoted = QUOTED.exec(line)?.[0] ?? '';
  const marker = FENCE.exec(line.slice(quoted.length))?.[1];
  return marker ? { marker, depth: quoted.split('>').length - 1 } : undefined;
}

/**
 * What a line is to the fenced code before it: `code`, a fence that closes it (`close`: the same character, at least
 * as long, with nothing after it), or past its end (`end`) when the quote it stands in has ended, as fenced code ends
 * with its quote. A quote's markers in code that is not quoted as deep are only code.
 */
export function within(fence: Fence, line: string): 'code' | 'close' | 'end' {
  let rest = line;
  for (let i = 0; i < fence.depth; i++) {
    const marker = MARKER.exec(rest)?.[0];
    if (marker === undefined) return 'end';
    rest = rest.slice(marker.length);
  }
  const marker = FENCE.exec(rest)?.[1] ?? '';
  const closes = marker[0] === fence.marker[0] && marker.length >= fence.marker.length;
  return closes && !rest.trim().slice(marker.length) ? 'close' : 'code';
}

/**
 * Inline code: a run of backticks closed by a run of exactly as many, within a paragraph (a line with nothing but a
 * quote's markers ends one too). An opening run with no such close is only text, as is a backtick escaped by a
 * backslash.
 */
export const INLINE = /(?<=^|[^`\\]|\\`)(`+)(?!`)(?:(?!\n[ \t>]*\n)[\s\S])*?(?<!`)\1(?!`)/g;

const blank = (text: string) => text.replace(/[^\n]/g, ' ');

/**
 * Markdown with its code blanked: each character of fenced or inline code, fences included, becomes a space, and each
 * line stays where it was, so what reads lines or what stood beside the code still finds them. Code left unclosed by
 * its fence runs to the end, or to the end of its quote, as in CommonMark.
 */
export function outsideCode(markdown: string): string {
  const out: string[] = [];
  let prose: string[] = [];
  let fence: Fence | undefined;
  const flush = () => {
    if (prose.length) out.push(prose.join('\n').replace(INLINE, blank));
    prose = [];
  };
  for (const line of markdown.split('\n')) {
    if (fence) {
      const at = within(fence, line);
      if (at !== 'end') {
        if (at === 'close') fence = undefined;
        out.push(blank(line));
        continue;
      }
      fence = undefined;
    }
    fence = opens(line);
    if (fence) {
      flush();
      out.push(blank(line));
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join('\n');
}
