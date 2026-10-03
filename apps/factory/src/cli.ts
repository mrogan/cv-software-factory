#!/usr/bin/env node
/**
 * The factory's command line (spec section 5.6 names it). Each group of commands is a module in `commands/`, with
 * its usage and a `run` that returns the exit code.
 *
 *     factory <group> <command> [options]
 */
import * as events from './commands/events.ts';

interface Group {
  USAGE: string;
  run(args: string[]): Promise<number>;
}

const GROUPS: Record<string, Group> = { events };

const [name, ...args] = process.argv.slice(2);
const group = name ? GROUPS[name] : undefined;
if (!group) {
  console.log(
    `Usage:\n${Object.values(GROUPS)
      .map((g) => g.USAGE)
      .join('\n')}`,
  );
  process.exit(name === undefined || name === '--help' || name === '-h' ? 0 : 2);
}
process.exitCode = await group.run(args);
