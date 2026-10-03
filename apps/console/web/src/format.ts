/**
 * Words and figures as the console writes them: British English, times where the viewer is, money in dollars
 * because that is what the models are billed in.
 */

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** 16:20 */
export const clock = (at: number) => time.format(at);

/** Thu 16:20 */
export const shortWhen = (at: number) => `${weekday.format(at)} ${time.format(at)}`;

/** Thu 1 Oct */
export const dayLabel = (at: number) => day.format(at);

/** Thu 1 Oct, 16:20 */
export const when = (at: number) => `${day.format(at)}, ${time.format(at)}`;

/** 31 min, 1 h 4 min, 1 d 19 h, 9 d, or 1 s for something very quick. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 && days < 7 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** The time since an item opened, as the sheet's scrubber shows it: T+04:20, or T+1:02:30 past an hour. */
export function sinceStart(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `T+${h}:${two(m)}:${two(s)}` : `T+${two(m)}:${two(s)}`;
}

/** $0.31, or <$0.01 for less than a cent. */
export const money = (usd: number) => (usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

/** 540k, 12k, 900 */
export const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

/** 4.6%, 0.0% */
export const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

const significant = new Intl.NumberFormat('en-GB', { maximumSignificantDigits: 3 });

/** 642, 0.015, 1,500: a measurement, to three significant figures. */
export const figure = (value: number) => significant.format(value);

/**
 * A chart's axis for values up to `top`: a round maximum a little above it, and ticks at none, half and all of it.
 * Fractions (an error rate of 0.02, a latency of 0.8 s) get fractional ticks.
 */
export function axis(top: number): { max: number; ticks: [number, number, number] } {
  if (!(top > 0)) return { max: 1, ticks: [0, 0.5, 1] };
  const step = 10 ** Math.floor(Math.log10(top));
  // toPrecision drops floating-point dust: 0.1 × 3 is 0.30000000000000004.
  const max = Number((Math.ceil((top * 1.1) / step) * step).toPrecision(12));
  return { max, ticks: [0, Number((max / 2).toPrecision(12)), max] };
}

/** 1 PR, 2 PRs */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Sentence case for a stage or other lower-case name. */
export const capital = (word: string) => (word[0]?.toUpperCase() ?? '') + word.slice(1);
