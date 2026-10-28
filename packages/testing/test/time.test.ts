import { describe, expect, it } from 'vitest';
import { processorTime } from '../src/index.ts';

// Spins until it has had the processor for `ms`, however long a busy machine makes that take on the clock.
const busy = (ms: number) => {
  const started = process.cpuUsage();
  const spent = () => {
    const { user, system } = process.cpuUsage(started);
    return (user + system) / 1000;
  };
  while (spent() < ms);
};
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

describe('processorTime', () => {
  it('counts the time the work keeps the processor busy', () => {
    expect(processorTime(() => busy(20))).toBeGreaterThanOrEqual(20);
  });

  it('leaves out the time the process waits', () => {
    expect(processorTime(() => sleep(50))).toBeLessThan(25);
  });
});
