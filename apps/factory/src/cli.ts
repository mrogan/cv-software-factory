#!/usr/bin/env node
/**
 * The factory's command line (spec section 5.6 names it). Each group of commands is a module in `commands/`, with
 * its usage and a `run` that returns the exit code.
 *
 *     factory <group> <command> [options]
 */
import * as crawler from './commands/crawler.ts';
import * as events from './commands/events.ts';
import * as gateway from './commands/gateway.ts';
import * as line from './commands/line.ts';
import * as probes from './commands/probes.ts';
import * as triage from './commands/triage.ts';

interface Group {
  USAGE: string;
  run(args: string[]): Promise<number>;
}

const GROUPS: Record<string, Group> = { crawler, events, gateway, line, probes, triage };

const [name, ...args] = process.argv.slice(2);
const group = name ? GROUPS[name] : undefined;
const usage = (groups: Group[]) => `Usage:\n${groups.map((g) => g.USAGE).join('\n')}`;
if (!group) {
  console.log(usage(Object.values(GROUPS)));
  process.exit(name === undefined || name === '--help' || name === '-h' ? 0 : 2);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage([group]));
  process.exit(0);
}
try {
  process.exitCode = await group.run(args);
} catch (error) {
  // A mistyped option is the person's mistake, not the command's: say what was wrong, and how it is used.
  if (!(error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'))) throw error;
  console.error(`${error.message}\n\n${usage([group])}`);
  process.exitCode = 2;
}
