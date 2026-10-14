/** The design system's custom elements, as JSX knows them. */
import type { HTMLAttributes } from 'preact';
import type { Beacon, Kind, Status } from '../../../../docs/design/system/station.ts';

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'sf-station': HTMLAttributes<HTMLElement> & {
        kind: Kind;
        status: Status;
        beacon?: Beacon | undefined;
        motion?: 'off' | undefined;
        decorative?: boolean | undefined;
        label?: string | undefined;
      };
    }
  }
}
