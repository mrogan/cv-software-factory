/**
 * The viewer's settings, which the page holds and never stores: Paper always comes first and Ink is a choice
 * made on the page, and motion follows the viewer's system setting unless they switch it here.
 *
 * `?theme=ink` and `?motion=off` set them from the address, for tests and for sharing a view.
 */
import { useEffect, useState } from 'react';

export type Theme = 'paper' | 'ink';

const params = () => new URLSearchParams(location.search);

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (params().get('theme') === 'ink' ? 'ink' : 'paper'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [theme, setTheme];
}

export function useMotion(): [boolean, (on: boolean) => void] {
  const [motion, setMotion] = useState(
    () => params().get('motion') !== 'off' && !matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    // Styles key their animations off this, and the stations draw their still pose.
    document.documentElement.dataset.motion = motion ? 'on' : 'off';
  }, [motion]);
  return [motion, setMotion];
}

/**
 * The time the console draws: `?t=` pins it, a recording is drawn at its last event, and the live view at now,
 * moving on every ten seconds and never behind the newest event, whatever the viewer's clock says.
 */
export function useTime(latest: number | undefined, live: boolean): number {
  const pinned = Date.parse(params().get('t') ?? '');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isNaN(pinned) || !live) return;
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [pinned, live]);
  if (!Number.isNaN(pinned)) return pinned;
  if (!live) return latest ?? now;
  return Math.max(now, latest ?? 0);
}
