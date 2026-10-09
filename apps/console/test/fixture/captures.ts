/**
 * What the capture script recorded about the test data's screenshots (capture.ts writes captures.json), and the
 * screenshot references the test data's events carry.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Screenshot } from '@software-factory/events';

export const LOG = fileURLToPath(new URL('./log/', import.meta.url));
export const ARTIFACTS = fileURLToPath(new URL('./log/artifacts/', import.meta.url));
export const CAPTURES = fileURLToPath(new URL('./captures.json', import.meta.url));

/**
 * The one version of the invented shop every page shows: a commit, as the app reports one between releases, so the
 * console's tests see a version too long to write whole.
 */
export const VERSION = '4f9c2e1b7d3a6058e9b1c4d2a7f3e6b9c0d1e2f3';

type Rect = { x: number; y: number; width: number; height: number };

export interface Captures {
  shots: Record<string, Omit<Screenshot, 'kind' | 'type' | 'version'>>;
  /** Where an element sits on a screenshot, by `<shot> <selector>`, or null when it is out of view. */
  elements: Record<string, Rect | null>;
}

const read = (): Captures => JSON.parse(readFileSync(CAPTURES, 'utf-8')) as Captures;

/** A screenshot by name. */
export function shot(name: string): Screenshot {
  const found = read().shots[name];
  if (!found) throw new Error(`No screenshot called ${name}: run the capture script`);
  return { kind: 'screenshot', type: 'image/png', version: VERSION, ...found };
}

/** Where an element is on a screenshot, or nothing when it is out of view. */
export function element(name: string, selector: string): Rect | undefined {
  const elements = read().elements;
  const key = `${name} ${selector}`;
  if (!(key in elements)) throw new Error(`No element ${selector} on ${name}: run the capture script`);
  return elements[key] ?? undefined;
}
