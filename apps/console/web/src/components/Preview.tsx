/**
 * Preview as visitor: Martin, still signed in, sees the console as anyone without his session does. The page below
 * reads the public events from the console's server, as a visitor's does, rather than the full ones with his parts
 * hidden, so what he sees is exactly what a visitor gets. Nothing of his shows while it lasts but this banner.
 */
import { useEffect, useRef } from 'react';

export function PreviewBanner({ onBack }: { onBack: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  // The button that started the preview has gone: the way back takes its focus.
  useEffect(() => back.current?.focus(), []);
  return (
    <section className="preview-banner" aria-label="Preview as visitor">
      <div className="wrap">
        <p>
          Previewing as a visitor: the public stream, as the server sends it to anyone without your session. You are
          still signed in.
        </p>
        <button type="button" ref={back} onClick={onBack}>
          Back to admin
        </button>
      </div>
    </section>
  );
}
