/**
 * The canary bird's route through the air: out of the cage, just above where it lands, it swings out over the line and
 * back, and is in the air about as long as on its way home from where it has walked off along the panel.
 */
import { describe, expect, it } from 'vitest';
import { route, routeLength, SWING, swingOut } from '../web/src/components/flight.ts';

// At 1440px: the cage, where it lands on the panel just below it, and the panel's top edge from side to side.
const cage = { x: 900, y: 40 };
const landing = { x: 910, y: 190 };
const [lo, hi] = [40, 1180];

describe('the flight out of the cage', () => {
  const swing = swingOut(cage, landing, lo, hi);
  const out = route(cage, landing, swing);

  it('swings toward the side with more room, as far as the bird walks', () => {
    expect(swing).toBe(-SWING);
    expect(swingOut({ x: 300, y: 40 }, { x: 310, y: 190 }, lo, hi)).toBe(SWING);
    // No further than the room there is.
    expect(swingOut({ x: 100, y: 40 }, { x: 110, y: 190 }, lo, 200)).toBe(90);
  });

  it('goes out over the line and back, and stays over the panel', () => {
    const xs = out.points.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(cage.x - SWING * 0.9);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(lo);
    expect(out.points.at(0)).toEqual(cage);
    expect(out.points.at(-1)?.x).toBeCloseTo(landing.x);
    expect(out.points.at(-1)?.y).toBeCloseTo(landing.y);
  });

  it('swung right, stays over the panel too', () => {
    const [from, to] = [
      { x: 300, y: 40 },
      { x: 310, y: 190 },
    ];
    const right = route(from, to, swingOut(from, to, 200, 520));
    const xs = right.points.map((p) => p.x);
    expect(Math.max(...xs)).toBeGreaterThan(from.x + SWING * 0.9);
    expect(Math.max(...xs)).toBeLessThanOrEqual(520);
    expect(right.facing).toBe(1);
  });

  it('turns about once in the air, to face the way it comes in to land', () => {
    expect(out.facing).toBe(-1);
    expect(out.turns).toHaveLength(1);
    expect(out.turns[0]?.facing).toBe(1);
    expect(out.turns[0]?.at).toBeGreaterThan(0.2);
    expect(out.turns[0]?.at).toBeLessThan(0.8);
  });

  it('is about as long, and takes about as long, as the flight home from along the panel', () => {
    const drop = route(cage, landing);
    const homes = [landing.x - 300, landing.x + 200, landing.x + 300].map((x) => route({ x, y: landing.y }, cage));
    // Without the swing it would be a short drop.
    expect(routeLength(drop)).toBeLessThan(0.6 * routeLength(out));
    for (const home of homes) {
      expect(routeLength(out) / routeLength(home)).toBeGreaterThan(0.8);
      expect(routeLength(out) / routeLength(home)).toBeLessThan(1.6);
      expect(out.duration / home.duration).toBeGreaterThan(0.9);
      expect(out.duration / home.duration).toBeLessThan(1.6);
    }
  });
});

describe('the flight home', () => {
  it('is unswung: one way across, no turn, and as long in time as it ever was', () => {
    const home = route({ x: 1200, y: 190 }, cage);
    expect(home.facing).toBe(-1);
    expect(home.turns).toEqual([]);
    expect(home.duration).toBeCloseTo((Math.hypot(300, 150) + 200) / 0.3);
    // Nearly straight up, it keeps the way it already faces.
    expect(route({ x: 902, y: 190 }, cage).facing).toBeUndefined();
  });
});
