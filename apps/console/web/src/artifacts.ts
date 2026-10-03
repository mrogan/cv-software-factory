/** Where the page finds an artifact by its hash: the server, or the event-log folder it was given. */
import { createContext, useContext } from 'react';
import { artifactUrl, type Origin } from './source.ts';

export const OriginContext = createContext<Origin>({ kind: 'live' });

export function useArtifactUrl(): (hash: string) => string {
  const from = useContext(OriginContext);
  return (hash) => artifactUrl(from, hash);
}
