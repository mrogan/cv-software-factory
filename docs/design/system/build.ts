/**
 * Generate tokens.css from tokens.json and check colour contrast. The JSON is the source.
 *
 *     node docs/design/system/build.ts            # write tokens.css
 *     node docs/design/system/build.ts --check    # fail if tokens.css is out of date (make check, CI)
 *
 * Fails if a pair that carries meaning drops below its WCAG 2.2 AA threshold in either theme.
 * Plain TypeScript with no dependencies, run by Node's built-in type stripping.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, 'tokens.json');
const OUT = join(import.meta.dirname, 'tokens.css');

/** [foreground, background, minimum]. 4.5 for text; 3 for large text and graphics (WCAG 1.4.11). */
type Pair = [fg: string, bg: string, min: number];

const CONTRAST_PAIRS: Pair[] = [
  ['text', 'bg', 4.5], ['text-2', 'raised', 4.5],
  ['text-muted', 'bg', 4.5], ['text-muted', 'raised', 4.5], ['text-muted', 'surface', 4.5],
  ['signal', 'bg', 4.5], ['signal', 'raised', 4.5], ['on-signal', 'signal', 4.5],
  ['ok', 'bg', 4.5], ['ok', 'raised', 4.5], ['on-ok', 'ok', 4.5], ['ok-text', 'ok-wash', 4.5],
  ['attn', 'bg', 4.5], ['attn', 'raised', 4.5], ['on-attn', 'attn', 4.5], ['on-inverse', 'text', 4.5],
  // Station: chassis linework and LED glyphs are graphics that carry state.
  ['text', 'raised', 3], ['station-led-dim', 'station-face', 3], ['station-led-on', 'station-face', 3],
  ['station-led-ok', 'station-face', 3], ['station-led-attn', 'station-face', 3],
  ['signal', 'surface', 3], ['ok', 'surface', 3], ['attn', 'surface', 3],
];

/** A W3C design token group: `$`-prefixed keys are metadata, the rest are tokens. */
type Group<V = string> = Record<string, { $value: V } | string>;

interface TypeRole {
  fontFamily: string;
  fontSize: string;
  lineHeight: string | number;
  letterSpacing?: string;
  fontStyle?: string;
  textTransform?: string;
  fontVariantNumeric?: string;
}

interface Tokens {
  theme: Record<string, Group>;
  font: Group<string[]>;
  type: Group<TypeRole>;
  space: Group;
  radius: Group;
  stroke: Group;
  motion: Group<string | number[]>;
  shadow: { popover: { $value: Record<'offsetX' | 'offsetY' | 'blur' | 'spread' | 'color', string> } };
  station: Group;
}

/** The tokens in a group, skipping `$` metadata. */
function entries<V>(group: Group<V>): [string, V][] {
  return Object.entries(group).flatMap(([k, t]) => (k.startsWith('$') || typeof t === 'string' ? [] : [[k, t.$value]]));
}

/** A value that must exist, or the tokens file is broken. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`tokens.json: missing ${what}`);
  return value;
}

function colours(tokens: Tokens, theme: string): Record<string, string> {
  return Object.fromEntries(entries(must(tokens.theme[theme], `theme ${theme}`)));
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Prints every pair and returns the ones below their threshold. */
function report(tokens: Tokens): string[] {
  const low: string[] = [];
  for (const theme of Object.keys(tokens.theme)) {
    const c = colours(tokens, theme);
    for (const [fg, bg, need] of CONTRAST_PAIRS) {
      const r = contrast(must(c[fg], `${theme}.${fg}`), must(c[bg], `${theme}.${bg}`));
      const flag = r < need ? '  LOW' : '';
      console.log(`${theme.padEnd(5)} ${fg.padStart(16)} on ${bg.padEnd(12)} ${r.toFixed(2).padStart(5)} (needs ${need})${flag}`);
      if (flag) low.push(`${theme}: ${fg} on ${bg}`);
    }
  }
  return low;
}

function fontStack(values: string[]): string {
  return values.map((v) => (v.includes(' ') ? `'${v}'` : v)).join(', ');
}

function block(selector: string, values: Record<string, string>): string {
  return `${selector} {\n${Object.entries(values).map(([k, v]) => `  --${k}: ${v};\n`).join('')}}\n`;
}

function css(tokens: Tokens): string {
  const shared: Record<string, string> = {};
  for (const [name, v] of entries(tokens.font)) shared[`font-${name}`] = fontStack(v);
  for (const group of ['space', 'radius', 'stroke'] as const) {
    for (const [name, v] of entries(tokens[group])) shared[`${group}-${name}`] = v;
  }
  for (const [name, v] of entries(tokens.motion)) {
    shared[`motion-${name}`] = Array.isArray(v) ? `cubic-bezier(${v.join(', ')})` : v;
  }
  const s = tokens.shadow.popover.$value;
  shared['shadow-popover'] = `${s.offsetX} ${s.offsetY} ${s.blur} ${s.spread} ${s.color}`;
  for (const [name, v] of entries(tokens.station)) shared[`station-${name}`] = v;

  const out = [
    '/* Generated from tokens.json by build.ts. Do not edit by hand. */\n',
    block(':root', { ...colours(tokens, 'paper'), ...shared }),
    block('[data-theme="ink"], .theme-ink', colours(tokens, 'ink')),
    block('[data-theme="paper"], .theme-paper', colours(tokens, 'paper')),
  ];

  // Type roles as utility classes, so markup and components can share them.
  for (const [name, v] of entries(tokens.type)) {
    const family = v.fontFamily.replace(/[{}]/g, '').split('.')[1];
    const decl = [`font-family: var(--font-${family})`, `font-size: ${v.fontSize}`, `line-height: ${v.lineHeight}`];
    if (v.letterSpacing) decl.push(`letter-spacing: ${v.letterSpacing}`);
    if (v.fontStyle) decl.push(`font-style: ${v.fontStyle}`);
    if (v.textTransform) decl.push(`text-transform: ${v.textTransform}`);
    if (v.fontVariantNumeric) decl.push(`font-variant-numeric: ${v.fontVariantNumeric}`);
    out.push(`.t-${name} { ${decl.join('; ')}; font-weight: 400 }\n`);
  }
  return out.join('');
}

const tokens: Tokens = JSON.parse(readFileSync(SRC, 'utf-8'));
const built = css(tokens);
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf-8') !== built) {
    console.error(`${relative(process.cwd(), OUT)} is out of date: run node ${relative(process.cwd(), import.meta.filename)}`);
    process.exit(1);
  }
  console.log(relative(process.cwd(), OUT), 'is up to date');
} else {
  writeFileSync(OUT, built);
  console.log('wrote', relative(process.cwd(), OUT));
}
const low = report(tokens);
if (low.length) {
  console.error(`contrast below threshold: ${low.join('; ')}`);
  process.exit(1);
}
