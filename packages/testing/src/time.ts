/**
 * The processor time, in milliseconds, that `work` took: what a test that holds code to a time limit measures. The
 * clock counts the time the process waits for a processor too, and a busy runner can take it off one part way for
 * longer than the work takes; processor time counts only what the process does.
 *
 * It counts the whole process, garbage collection included, which in a test is the test file alone: vitest runs each
 * file in a process of its own (`forks`, its default). A limit far above the work's time leaves room for a collection.
 */
export function processorTime(work: () => unknown): number {
  const started = process.cpuUsage();
  work();
  const { user, system } = process.cpuUsage(started);
  return (user + system) / 1000;
}
