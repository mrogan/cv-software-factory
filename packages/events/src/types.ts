/**
 * The event types, as TypeScript sees them. Payloads are inferred from the Zod schemas, so the schema and the type
 * cannot drift; everything here is erased at runtime, so the browser can import it freely.
 */
import type { z } from 'zod';
import type { artifactRef, evidence, inboxSignal, PAYLOADS } from './schemas.ts';
import type { EventType } from './versions.ts';
import type { Actor } from './vocabulary.ts';

export type { EventType } from './versions.ts';

export type ArtifactRef = z.infer<typeof artifactRef>;
export type Screenshot = Extract<ArtifactRef, { kind: 'screenshot' }>;
export type Evidence = z.infer<typeof evidence>;
/** A signal as a sense leaves it in the inbox (schemas.ts). */
export type InboxSignal = z.infer<typeof inboxSignal>;

/**
 * A payload at its type's current version. A public view has the same shape: what it leaves out (report text, a
 * visitor's key) is optional in every payload, so an event read back from a public record is still a valid event.
 */
export type PayloadOf<K extends EventType> = z.infer<(typeof PAYLOADS)[K]>;

interface Envelope<K extends EventType> {
  /** A UUID, chosen by whoever appends the event, so a retried append cannot store it twice. */
  id: string;
  /** The store's total order, from 1. */
  seq: number;
  /** When it happened, in ISO 8601. */
  ts: string;
  /** The work item's number, or null for an event about the line as a whole. */
  work_item: string | null;
  type: K;
  /** The version of this type's payload. Reading upcasts every event to the current one. */
  version: number;
  actor: Actor;
  /** The plain-English line shown to people. */
  summary: string;
  artifacts: ArtifactRef[];
}

/** The parts of an event a public view may change. Written once, when the event is appended. */
export interface View<K extends EventType = EventType> {
  summary: string;
  payload: PayloadOf<K>;
  artifacts: ArtifactRef[];
}

/** An event as the store keeps it: the whole of it, and its public view. */
export type StoredEvent<K extends EventType = EventType> = K extends EventType
  ? Envelope<K> & { payload: PayloadOf<K>; public: View<K> }
  : never;

/** An event as anyone but Martin may see it: its public view in the envelope's place. Event-log files hold these. */
export type PublicEvent<K extends EventType = EventType> = K extends EventType
  ? Envelope<K> & { payload: PayloadOf<K> }
  : never;

/** An event before the store has seen it. */
export type NewEvent<K extends EventType = EventType> = K extends EventType
  ? Omit<Envelope<K>, 'seq'> & { payload: PayloadOf<K> }
  : never;
