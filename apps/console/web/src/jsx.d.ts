/** The design system's custom elements, as JSX knows them. */
import type { Beacon, Kind, Status } from '../../../../docs/design/system/station.ts';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'sf-station': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
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
