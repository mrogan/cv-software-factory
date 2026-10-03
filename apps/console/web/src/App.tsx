/**
 * The console: events in, the page out. Everything below is drawn from `project(events, t)`.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OriginContext } from './artifacts.ts';
import { Footer } from './components/Footer.tsx';
import { Header, LineStatus } from './components/Header.tsx';
import { Line } from './components/Line.tsx';
import { LogoSymbols } from './components/Logos.tsx';
import { Reel } from './components/Reel.tsx';

import { EmptyReel, States } from './components/States.tsx';
import { project, projectSheet } from './projection/index.ts';
import { useMotion, useTheme, useTime } from './settings.ts';
import { origin, useEvents } from './source.ts';

const params = new URLSearchParams(location.search);

/** The sheet's code arrives when the first sheet opens: the first view does not need it. */
const Sheet = lazy(() => import('./components/Sheet.tsx').then((module) => ({ default: module.Sheet })));

export function App() {
  const from = useMemo(() => origin(), []);
  const source = useEvents(from);
  const latest = source.events.length ? Date.parse(source.events.at(-1)?.ts ?? '') : undefined;
  const t = useTime(latest, from.kind === 'live');
  const view = useMemo(() => project(source.events, t), [source.events, t]);
  const [theme, setTheme] = useTheme();
  const [motion, setMotion] = useMotion();
  const n = view.cards.length;
  // The store has answered at least once: an empty one is empty, not loading.
  const settled = source.connection === 'live' || source.connection === 'recorded' || source.events.length > 0;

  // The reel rests on the latest work item unless the viewer moves it, or asked for one in the address.
  const asked = params.get('item');
  const [centre, setCentre] = useState<number | undefined>(undefined);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const atNow = useRef(true);
  const resting = Math.max(0, Math.min(n - 1, centre ?? n - 1));

  useEffect(() => {
    if (!n || centre !== undefined) return;
    const index = view.cards.findIndex((card) => card.number === asked);
    if (index >= 0) {
      atNow.current = index >= n - 1;
      setCentre(index);
      if (params.has('sheet')) setOpen(asked ?? undefined);
    }
  }, [n, centre, asked, view.cards]);

  // Following the line: a viewer watching now stays at now as new work items arrive.
  useEffect(() => {
    if (atNow.current && centre !== undefined && n) setCentre(n - 1);
  }, [n, centre]);

  const onCentre = useCallback(
    (index: number) => {
      atNow.current = index >= n - 1;
      setCentre(index);
    },
    [n],
  );
  // The first meaningful view: the line drawn from the factory's events. The speed test waits for this mark.
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || !n) return;
    marked.current = true;
    performance.mark('sf:first-view');
  }, [n]);

  const sheet = useMemo(() => (open ? projectSheet(source.events, open, t) : undefined), [open, source.events, t]);
  const sheetIndex = sheet ? view.cards.findIndex((card) => card.number === sheet.card.number) : -1;

  return (
    <OriginContext.Provider value={from}>
      <LogoSymbols />
      <Header
        line={view.header}
        connection={source.connection}
        theme={theme}
        onTheme={setTheme}
        motion={motion}
        onMotion={setMotion}
      />
      <main id="top">
        <div className="wrap">
          <section className="intro" aria-labelledby="app-name">
            <div>
              <h1 id="app-name">The World’s Worst Website</h1>
              <p className="sub">a deliberately broken shop, looked after by agents</p>
            </div>
            <span className="status phone-status">
              <LineStatus line={view.header} connection={source.connection} />
            </span>
          </section>
          <States source={source} view={view} />
          {/* The stations draw at once, idle, and take their states as the events arrive. */}
          <Line view={view} motion={motion} onOpen={setOpen} pending={!source.events.length && !settled} />
          {n === 0 && settled && <EmptyReel />}
          {n > 0 && (
            <>
              <Reel
                view={view}
                centre={resting}
                onCentre={onCentre}
                onOpen={(index) => setOpen(view.cards[index]?.number)}
                motion={motion}
                asked={asked !== null}
              />
            </>
          )}
        </div>
      </main>
      <Footer />
      {sheet && (
        <Suspense fallback={null}>
          <Sheet
            sheet={sheet}
            index={sheetIndex}
            count={n}
            motion={motion}
            onStep={(index) => {
              onCentre(index);
              setOpen(view.cards[index]?.number);
            }}
            onClose={() => setOpen(undefined)}
          />
        </Suspense>
      )}
    </OriginContext.Provider>
  );
}
