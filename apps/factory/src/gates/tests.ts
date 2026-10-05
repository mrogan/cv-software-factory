/**
 * Reads the tests in a test file: each test's name (with the `describe` blocks around it), whether it is skipped, and
 * how many assertions it makes. Test integrity compares what a pull request's base has with what its change has.
 *
 * It scans the source rather than parsing it: no TypeScript compiler, so the gate runs on Node alone from a sparse
 * checkout, where a pull request cannot change it. The scanner knows strings, template literals, comments and regular
 * expressions well enough to find each call's closing parenthesis, which is all it needs.
 *
 * It understands Vitest's and Jest's shapes: `describe`, `it` and `test`, with their modifiers (`.skip`, `.only`,
 * `.todo`, `.each(...)`, `.skipIf(...)`, `.runIf(...)`), and `xit`, `xtest`, `xdescribe`.
 */

export interface TestCase {
  /** The `describe` names and the test's own, joined with " > ". */
  name: string;
  /** Skipped, left to do, or narrowed with `.only` (which skips every other test in the file). */
  disabled: false | 'skip' | 'todo' | 'only' | 'conditional';
  /** Calls to `expect` and `assert` inside the test's body, including in helpers it defines there. */
  assertions: number;
  /** The test's call as written, for telling whether a test changed. */
  source: string;
}

const BLOCKS = new Set(['describe', 'it', 'test', 'xit', 'xtest', 'xdescribe', 'suite', 'bench']);

const KEYWORDS_BEFORE_REGEX = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await'];

/** Which characters are code, rather than inside a string, comment or regular expression. */
function codeMask(source: string): boolean[] {
  const code = new Array<boolean>(source.length).fill(false);
  // One entry for each template expression (`${…}`) the scanner is in: the braces opened inside it.
  const expressions: number[] = [];
  let inTemplate = false;

  // Whether a `/` at this index starts a regular expression rather than dividing.
  const regexAllowed = (at: number) => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(source[j] ?? '')) j--;
    if (j < 0) return true;
    if ('([{,;:=!&|?+-*%<>~^'.includes(source[j] ?? '')) return true;
    const word = /[A-Za-z_$]+$/.exec(source.slice(Math.max(0, j - 10), j + 1))?.[0];
    return word !== undefined && KEYWORDS_BEFORE_REGEX.includes(word);
  };
  // The index just past what starts at `i` and ends at the first `end` not escaped, or at the line's end.
  const past = (i: number, end: string, oneLine: boolean) => {
    let j = i + 1;
    while (j < source.length && source[j] !== end && !(oneLine && source[j] === '\n')) j += source[j] === '\\' ? 2 : 1;
    return j + 1;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (inTemplate) {
      if (c === '\\') i += 2;
      else if (c === '`') {
        inTemplate = false;
        i++;
      } else if (c === '$' && next === '{') {
        expressions.push(0);
        inTemplate = false;
        i += 2;
      } else i++;
    } else if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'") {
      i = past(i, c, true);
    } else if (c === '`') {
      inTemplate = true;
      i++;
    } else if (c === '/' && regexAllowed(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j++;
      }
      i = j + 1;
    } else {
      const depth = expressions.at(-1);
      if (depth !== undefined && c === '{') expressions[expressions.length - 1] = depth + 1;
      if (depth !== undefined && c === '}') {
        if (depth === 0) {
          // The template expression ends, and the template it is in goes on.
          expressions.pop();
          inTemplate = true;
          i++;
          continue;
        }
        expressions[expressions.length - 1] = depth - 1;
      }
      code[i] = true;
      i++;
    }
  }
  return code;
}

/** The index just after the parenthesis that closes the one at `open`, counting only code. */
function closing(source: string, code: boolean[], open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (!code[i]) continue;
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/** A string literal's value, from its opening quote. Template literals keep their `${…}` as written. */
function literal(source: string, at: number): string | undefined {
  const quote = source[at];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  let value = '';
  for (let i = at + 1; i < source.length && source[i] !== quote; i++) {
    if (source[i] === '\\') {
      value += source[i + 1] ?? '';
      i++;
    } else value += source[i];
  }
  return value;
}

const CALL = /\b(describe|it|test|xit|xtest|xdescribe|suite|bench)((?:\s*\.\s*[A-Za-z]+)*)\s*\(/g;
const ASSERTION = /\b(?:expect|assert)(?:\s*\.\s*[A-Za-z]+)*\s*\(/g;

interface Block {
  kind: 'describe' | 'test';
  name: string;
  disabled: TestCase['disabled'];
  /** Where the call's arguments start and end. */
  from: number;
  to: number;
}

export function testsIn(source: string): TestCase[] {
  const code = codeMask(source);
  const blocks: Block[] = [];
  for (const match of source.matchAll(CALL)) {
    const at = match.index;
    if (!code[at]) continue;
    // A method of something else, such as `foo.test(`, is not a test.
    let before = at - 1;
    while (before >= 0 && (!code[before] || /\s/.test(source[before] ?? ''))) before--;
    if (source[before] === '.') continue;
    const head = match[1] as string;
    const modifiers = (match[2] ?? '')
      .split('.')
      .map((m) => m.trim())
      .filter(Boolean);
    let open = at + match[0].length - 1;
    // `.each(table)(name, fn)` and `.skipIf(cond)(name, fn)`: the name is in the second call.
    if (modifiers.some((m) => ['each', 'skipIf', 'runIf', 'for'].includes(m))) {
      const after = closing(source, code, open);
      const second = source.slice(after).match(/^\s*\(/);
      if (!second) continue;
      open = after + second[0].length - 1;
    }
    let nameAt = open + 1;
    while (/\s/.test(source[nameAt] ?? '')) nameAt++;
    const name = literal(source, nameAt);
    if (name === undefined || !BLOCKS.has(head)) continue;
    const disabled: TestCase['disabled'] =
      head.startsWith('x') || modifiers.includes('skip')
        ? 'skip'
        : modifiers.includes('todo')
          ? 'todo'
          : modifiers.includes('only')
            ? 'only'
            : modifiers.some((m) => m === 'skipIf' || m === 'runIf')
              ? 'conditional'
              : false;
    blocks.push({
      kind: head.endsWith('describe') || head === 'suite' ? 'describe' : 'test',
      name,
      disabled,
      from: open,
      to: closing(source, code, open),
    });
  }

  const assertions = [...source.matchAll(ASSERTION)].map((m) => m.index).filter((i) => code[i]);
  return blocks
    .filter((b) => b.kind === 'test')
    .map((test) => {
      const around = blocks.filter((b) => b.kind === 'describe' && b.from < test.from && b.to >= test.to);
      const describedDisabled = around.find((b) => b.disabled)?.disabled ?? false;
      return {
        name: [...around.map((b) => b.name), test.name].join(' > '),
        disabled: test.disabled || describedDisabled,
        assertions: assertions.filter((i) => i > test.from && i < test.to).length,
        source: source.slice(test.from, test.to),
      };
    });
}
