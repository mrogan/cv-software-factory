/**
 * Properties of how two scope entries share a file (`sharedPath`, `touches`, `scopesOverlap` in `line.ts`), over
 * entries and paths fast-check makes up. `events.test.ts` holds the examples. The line keeps two specs whose scopes
 * share a file from running at once, and the planner keeps a scope out of the protected paths, by these: a missed
 * overlap lets two patches change one file, or a scope name a path no patch may change, so each property here is held
 * against `inScope`, the one rule for what an entry takes in.
 *
 * Most pairs of entries are made from one path, each by writing some of its segments as `*`, `**` or part of a name,
 * so both take it in and the pair must overlap; the rest are made up apart, and mostly share nothing.
 *
 * The planner's check (`touches`) holds a folder to a pattern that matches anywhere only at the top, so a folder that
 * could hold such a file does not name it: it is held to refusing each path a protected entry takes in, each file or
 * pattern that shares a path with one, each entry that takes in a protected path or a file in a protected folder, and
 * each entry it refused before overlap was exact.
 *
 * A failure prints the seed and the shrunk counterexample: `fc.assert(..., { seed, path })` replays it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { inScope, pattern, scopesOverlap, sharedPath, touches } from '../src/line.ts';

/** A path segment: often a name entries share, sometimes one with a character a regular expression would read. */
const segment = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('src', 'test', 'docs', 'deploy', 'test.ts', 'latest.ts', 'a', 'ab') },
  { weight: 2, arbitrary: fc.stringMatching(/^[a-z0-9_.-]{1,5}$/).filter((s) => s !== '.' && s !== '..') },
  {
    weight: 1,
    arbitrary: fc.constantFrom('a+b', '(x)', '[y]', 'x|y', '$1', `a${String.fromCodePoint(0x2028)}b`, 'a\nb', 'é'),
  },
);
const path = fc.array(segment, { minLength: 1, maxLength: 5 }).map((s) => s.join('/'));

/** One segment of a scope entry made up on its own: a name, `*`, `**`, or a name with `*` for part of it. */
const globSegment = fc.oneof(
  { weight: 4, arbitrary: segment },
  { weight: 1, arbitrary: fc.constant('*') },
  { weight: 2, arbitrary: fc.constant('**') },
  { weight: 1, arbitrary: segment.map((s) => `*${s.slice(-3)}`) },
  { weight: 1, arbitrary: segment.map((s) => `${s.slice(0, 1)}*`) },
  { weight: 1, arbitrary: fc.tuple(segment, segment).map(([a, b]) => `${a.slice(0, 1)}**${b.slice(-1)}`) },
);
/** A scope entry made up on its own: a file, a folder ending in `/`, or a pattern. */
const anyEntry = fc
  .tuple(fc.array(globSegment, { minLength: 1, maxLength: 4 }), fc.boolean())
  .map(([globs, folder]) => `${globs.join('/')}${folder ? '/' : ''}`);

/**
 * A scope entry that takes in the path: each segment kept, or written as `*`, `**` or part of a name with `*`; a `**`
 * put in before a segment for no folders; or the path cut short to a folder above its last segment.
 */
const entryFor = (target: string) => {
  const names = target.split('/');
  return fc
    .tuple(
      fc.array(fc.constantFrom('keep', 'star', 'stars', 'head', 'tail', 'none'), {
        minLength: names.length,
        maxLength: names.length,
      }),
      fc.array(fc.boolean(), { minLength: names.length, maxLength: names.length }),
      fc.nat({ max: names.length }),
    )
    .map(([ways, extra, cut]) => {
      const folder = cut > 0 && cut < names.length;
      const globs = names.slice(0, folder ? cut : names.length).flatMap((name, i) => {
        const glob =
          ways[i] === 'star'
            ? '*'
            : ways[i] === 'stars'
              ? '**'
              : ways[i] === 'head'
                ? `${name.slice(0, 1)}*`
                : ways[i] === 'tail'
                  ? `*${name.slice(-2)}`
                  : name;
        // A `**` of its own before a segment stands for no folders; at the end it would ask for one more.
        return extra[i] && i < names.length - 1 && !folder ? ['**', glob] : [glob];
      });
      return `${globs.join('/')}${folder ? '/' : ''}`;
    });
};

/** A path and two entries that both take it in. */
const sharing = path.chain((target) => fc.tuple(fc.constant(target), entryFor(target), entryFor(target)));

/** Any two entries, made from one path or made up apart. */
const pair = fc.oneof(
  sharing.map(([, a, b]) => [a, b] as const),
  fc.tuple(anyEntry, anyEntry),
  fc.tuple(anyEntry, path),
);

/**
 * `touches` as it read before `sharedPath`: the entry tried as text against each path, and a sample of each path, its
 * `*` as `x`, tried against the entry. Kept here to hold the planner to refusing every scope it refused then, and the line to every overlap it saw.
 */
function touchedBefore(entry: string, paths: readonly string[]): boolean {
  const asText = (p: string) => new RegExp(pattern(p).source.replaceAll('(?:.*/)?', '.*'), 's');
  if (paths.some((p) => asText(p).test(entry))) return true;
  const within = pattern(entry);
  return paths.some((p) => {
    const sample = p.replace(/^\*\*\//, '').replace(/\*/g, 'x');
    return sample.endsWith('/') ? within.test(`${sample}x`) || within.test(sample.slice(0, -1)) : within.test(sample);
  });
}

describe('two scope entries that share a file', () => {
  it('are made by the generator to take in the path they were made from', () => {
    fc.assert(
      fc.property(sharing, ([target, a, b]) => {
        expect(inScope(target, [a])).toBe(true);
        expect(inScope(target, [b])).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('overlap whenever a path is in both, whichever way round', () => {
    fc.assert(
      fc.property(sharing, ([, a, b]) => {
        expect(sharedPath(a, b)).toBeDefined();
        expect(scopesOverlap([a], [b])).toEqual([a]);
        expect(scopesOverlap([b], [a])).toEqual([b]);
      }),
      { numRuns: 1000 },
    );
  });

  it('overlap whenever a path made up apart is in both', () => {
    fc.assert(
      fc.property(anyEntry, anyEntry, path, (a, b, target) => {
        if (inScope(target, [a]) && inScope(target, [b])) expect(scopesOverlap([a], [b])).toEqual([a]);
      }),
      { numRuns: 1000 },
    );
  });

  it('share only a path both take in, by the one rule', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => {
        const shared = sharedPath(a, b);
        if (shared !== undefined) {
          expect(inScope(shared, [a])).toBe(true);
          expect(inScope(shared, [b])).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('overlap the same either way round', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => {
        expect(sharedPath(a, b) === undefined).toBe(sharedPath(b, a) === undefined);
        expect(scopesOverlap([a], [b]).length).toBe(scopesOverlap([b], [a]).length);
      }),
      { numRuns: 500 },
    );
  });

  it('overlap wherever they overlapped before', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => {
        if (touchedBefore(a, [b]) || touchedBefore(b, [a])) expect(scopesOverlap([a], [b])).toEqual([a]);
      }),
      { numRuns: 1000 },
    );
  });

  it('always include an entry and itself', () => {
    fc.assert(
      fc.property(anyEntry, (a) => {
        expect(sharedPath(a, a)).toBeDefined();
        expect(scopesOverlap([a], [a])).toEqual([a]);
      }),
    );
  });
});

describe("the planner's check of a scope against the protected paths", () => {
  it('refuses every path a protected entry takes in', () => {
    fc.assert(
      fc.property(sharing, fc.array(anyEntry, { maxLength: 3 }), ([target, guarded], others) => {
        expect(touches(target, [...others, guarded])).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('refuses every entry that takes in a protected path, or a file in a protected folder', () => {
    fc.assert(
      fc.property(sharing, fc.nat(), fc.array(anyEntry, { maxLength: 3 }), ([target, entry], cut, others) => {
        // The protected path the entry takes in, or a folder above it.
        const names = target.split('/');
        const depth = cut % names.length;
        const guarded = depth === 0 ? target : `${names.slice(0, depth).join('/')}/`;
        expect(touches(entry, [...others, guarded])).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('refuses every file or pattern that shares a path with a protected entry', () => {
    fc.assert(
      fc.property(sharing, fc.array(anyEntry, { maxLength: 3 }), ([, entry, guarded], others) => {
        fc.pre(!entry.endsWith('/'));
        expect(touches(entry, [...others, guarded])).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('refuses every entry it refused before', () => {
    fc.assert(
      fc.property(pair, fc.array(anyEntry, { maxLength: 2 }), ([entry, guarded], others) => {
        const paths = [...others, guarded];
        if (touchedBefore(entry, paths)) expect(touches(entry, paths)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});
