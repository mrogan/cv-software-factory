/**
 * The canary bird's route through the air (`Bird.tsx`): a pure function from where it takes off to where it lands, so
 * the unit tests reach it without a browser. Every flight is one curve, rising from where it takes off and falling onto
 * where it lands, with a flutter across it, and slower the further it goes.
 *
 * Home from the panel, where it has walked off along the top edge, the curve is already a long one. Out of the cage it
 * would be a short drop, as the cage is just above where it lands, so the flight out swings the curve aside, out over
 * the line and back, to be in the air about as long as on the way home.
 */

export type Point = { x: number; y: number };

export interface Route {
  /** Where it is at each of the flight's evenly timed keyframes, the first where it takes off, the last where it lands. */
  points: Point[];
  /** How long the flight takes, in milliseconds. */
  duration: number;
  /** Which way it faces as it takes off: 1 to the right, -1 to the left, or the way it faces already. */
  facing: number | undefined;
  /** Where in the flight (0 to 1) it turns about, if it does, and which way it faces after. */
  turns: { at: number; facing: number }[];
}

/** How far aside a flight out swings at most, in pixels: about as far as the bird walks between rests on the panel. */
export const SWING = 180;
const STEPS = 48;
/** How far a cubic Bézier curve with both its middle points moved aside by one goes aside itself, at its middle. */
const BULGE = 0.75;

const bez = (t: number, a: number, b: number, c: number, d: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * The route from `from` to `to`, swung `swing` pixels aside at its widest (to the right if positive, to the left if
 * negative): 0 for a flight home.
 */
export function route(from: Point, to: Point, swing = 0): Route {
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  const aside = swing / BULGE;
  // Swung, it climbs higher as it leaves, up and out over the line before it comes round to land.
  const c1 = { x: from.x + dx * 0.12 + aside, y: from.y - 70 - Math.abs(swing) * 0.4 };
  const c2 = { x: to.x - dx * 0.3 + aside, y: to.y - 120 };
  const points: Point[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const e = ease(t);
    const wobble = 5 * Math.sin(Math.PI * t) * Math.sin(t * Math.PI * 9);
    points.push({ x: bez(e, from.x, c1.x, c2.x, to.x), y: bez(e, from.y, c1.y, c2.y, to.y) + wobble });
  }
  // The curve's way across, by its first move of more than a pixel aside, and each time that way changes. A flight
  // nearly straight up or down, and not swung, keeps the way the bird already faces.
  const turns: Route['turns'] = [];
  let facing: number | undefined;
  let way: number | undefined;
  if (swing !== 0 || Math.abs(dx) > 4) {
    let at = from.x;
    points.forEach((p, i) => {
      const d = p.x - at;
      if (Math.abs(d) < 1) return;
      const now = d > 0 ? 1 : -1;
      if (way === undefined) facing = now;
      else if (now !== way) turns.push({ at: i / STEPS, facing: now });
      way = now;
      at = p.x;
    });
  }
  const duration = clamp((Math.hypot(dx, dy) + Math.abs(swing) + 200) / 0.3, 1400, 3400);
  return { points, duration, facing, turns };
}

/**
 * How far aside a flight out from `from` to `to` swings, toward the side with more room between `lo` and `hi` (the
 * stretch it stays over), and no further than that room.
 */
export function swingOut(from: Point, to: Point, lo: number, hi: number): number {
  const right = hi - Math.max(from.x, to.x);
  const left = Math.min(from.x, to.x) - lo;
  return right >= left ? Math.max(0, Math.min(SWING, right)) : -Math.max(0, Math.min(SWING, left));
}

/** How far a route goes through the air, in pixels: the sum of its keyframes' steps. */
export function length(r: Route): number {
  let sum = 0;
  for (let i = 1; i < r.points.length; i++) {
    const [a, b] = [r.points[i - 1], r.points[i]];
    if (a && b) sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}
