/**
 * The processor time, in milliseconds, that the least of `tries` calls of `work` took: what a test that holds code to
 * a time limit measures. The clock counts the time the process waits for a processor too, and a busy runner can take
 * it off one part way for longer than the work takes; processor time counts only the work, and the least of a few
 * leaves out a garbage collection that fell in one of them.
 *
 * It counts the whole process, which in a test is the test file alone: vitest runs each file in a process of its own
 * (`forks`, its default).
 */
export function processorTime(work: () => unknown, tries = 1): number {
  let least = Number.POSITIVE_INFINITY;
  for (let i = 0; i < tries; i++) {
    const started = process.cpuUsage();
    work();
    const { user, system } = process.cpuUsage(started);
    least = Math.min(least, (user + system) / 1000);
  }
  return least;
}
