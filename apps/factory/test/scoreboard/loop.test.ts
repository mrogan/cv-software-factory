/**
 * The scoreboard's loop on a fake clock, with appends and passes made by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wakeLoop } from '../../src/scoreboard/loop.ts';

const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** A loop whose appends are `append()` and whose passes each wait for `finish()`. */
async function loop() {
  let wake = () => {};
  const listening = { unlisten: vi.fn(async () => {}) };
  const passes: PromiseWithResolvers<void>[] = [];
  const stop = Promise.withResolvers<void>();
  const done = wakeLoop(
    {
      listen: async (w) => {
        wake = w;
        return listening;
      },
      pass: () => {
        const pass = Promise.withResolvers<void>();
        passes.push(pass);
        return pass.promise;
      },
      everyMs: MINUTE,
    },
    stop.promise,
  );
  await vi.advanceTimersByTimeAsync(0);
  return {
    append: () => wake(),
    passes,
    /** Finishes the pass in flight, and lets the loop start the next if it was woken meanwhile. */
    finish: async () => {
      passes.at(-1)?.resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
    listening,
    stop: async () => {
      stop.resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
    done,
  };
}

describe("the scoreboard's loop", () => {
  it('runs a pass when an event is appended', async () => {
    const l = await loop();
    expect(l.passes).toHaveLength(0);
    l.append();
    expect(l.passes).toHaveLength(1);
    await l.finish();
    expect(l.passes).toHaveLength(1);
    l.append();
    expect(l.passes).toHaveLength(2);
  });

  it('runs exactly one more pass after one it was woken during, however often', async () => {
    const l = await loop();
    l.append();
    l.append();
    l.append();
    expect(l.passes).toHaveLength(1);
    await l.finish();
    expect(l.passes).toHaveLength(2);
    await l.finish();
    expect(l.passes).toHaveLength(2);
  });

  it('runs a pass every minute with nothing appended', async () => {
    const l = await loop();
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(l.passes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(l.passes).toHaveLength(1);
    await l.finish();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(l.passes).toHaveLength(2);
  });

  it('stops listening and waking when stopped, once the pass in flight is done', async () => {
    const l = await loop();
    l.append();
    await l.stop();
    expect(l.listening.unlisten).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    let finished = false;
    void l.done.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    await l.finish();
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(l.passes).toHaveLength(1);
  });
});
