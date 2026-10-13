/**
 * The scoreboard's loop: a pass whenever it is woken, by an append or by the timer, one pass at a time. A wake during
 * a pass runs one more after it, however many wakes came, so nothing appended meanwhile goes uncounted.
 */

export interface LoopOptions {
  /** Starts listening for appends, calling `wake` on each, and again once it is listening. */
  listen: (wake: () => void) => Promise<{ unlisten: () => Promise<void> }>;
  pass: () => Promise<void>;
  /** Told of a pass that failed. The next wake runs another. */
  failed: (error: unknown) => void;
  /** How often to wake with nothing appended. */
  everyMs: number;
}

/** Runs passes until `stopped`, called once the loop is listening, resolves; then waits for the pass in flight. */
export async function wakeLoop(
  { listen, pass, failed, everyMs }: LoopOptions,
  stopped: () => Promise<void>,
): Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const wake = () => {
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        await pass().catch(failed);
      } while (again);
      running = null;
    })();
  };

  const subscription = await listen(wake);
  const timer = setInterval(wake, everyMs);
  await stopped();
  clearInterval(timer);
  await subscription.unlisten();
  await running;
}
