/**
 * What the capture script recorded about the samples' screenshots (capture.ts writes captures.json), and the
 * screenshot references the samples' events carry.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Screenshot } from '@software-factory/events';

export const LOG = fileURLToPath(new URL('../log/', import.meta.url));
export const ARTIFACTS = fileURLToPath(new URL('../log/artifacts/', import.meta.url));
export const CAPTURES = fileURLToPath(new URL('../captures.json', import.meta.url));

export interface Captures {
  /** The commit of the app every variant was made from. */
  app: string;
  shots: Record<string, Omit<Screenshot, 'kind' | 'type' | 'version'>>;
  /** For each variant's page, the share of pixels that differ from the same page as published. */
  changed: Record<string, number>;
}

const captures = JSON.parse(readFileSync(CAPTURES, 'utf-8')) as Captures;

/** A screenshot by name, as the version of the app it shows. */
export function shot(name: string, version: string): Screenshot {
  const found = captures.shots[name];
  if (!found) throw new Error(`No screenshot called ${name}: run the capture script`);
  return { kind: 'screenshot', type: 'image/png', version, ...found };
}

/** The share of a variant's page that differs from the page as published. */
export function changed(name: string): number {
  const found = captures.changed[name];
  if (found === undefined) throw new Error(`No comparison for ${name}: run the capture script`);
  return found;
}
