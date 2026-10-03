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

/** 1 PR, 2 PRs */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Sentence case for a stage or other lower-case name. */
export const capital = (word: string) => (word[0]?.toUpperCase() ?? '') + word.slice(1);
