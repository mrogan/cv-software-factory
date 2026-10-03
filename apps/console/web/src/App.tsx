/**
 * The console: events in, the page out. Everything below is drawn from `project(events, t)`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OriginContext } from './artifacts.ts';
import { Footer } from './components/Footer.tsx';
import { Header, LineStatus } from './components/Header.tsx';
import { Line } from './components/Line.tsx';
import { LogoSymbols } from './components/Logos.tsx';
import { Reel } from './components/Reel.tsx';
import { Sheet } from './components/Sheet.tsx';
import { States } from './components/States.tsx';
import { project, projectSheet } from './projection/index.ts';
import { useMotion, useTheme, useTime } from './settings.ts';
import { origin, useEvents } from './source.ts';

const params = new URLSearchParams(location.search);

export function App() {
  const from = useMemo(() => origin(), []);
  const source = useEvents(from);
  const latest = source.events.length ? Date.parse(source.events.at(-1)?.ts ?? '') : undefined;
  const t = useTime(latest, from.kind === 'live');
  const view = useMemo(() => project(source.events, t), [source.events, t]);
  const [theme, setTheme] = useTheme();
  const [motion, setMotion] = useMotion();
  const n = view.cards.length;

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
  const sheet = useMemo(() => (open ? projectSheet(source.events, open, t) : undefined), [open, source.events, t]);
  const sheetIndex = sheet ? view.cards.findIndex((card) => card.number === sheet.card.number) : -1;

  return (
    <OriginContext.Provider value={from}>
      <LogoSymbols />
      <Header line={view.header} theme={theme} onTheme={setTheme} motion={motion} onMotion={setMotion} />
      <main id="top">
        <div className="wrap">
          <section className="intro" aria-labelledby="app-name">
            <div>
              <h1 id="app-name">The World’s Worst Website</h1>
              <p className="sub">a deliberately broken shop, looked after by agents</p>
            </div>
            <span className="status phone-status">
              <LineStatus line={view.header} />
            </span>
          </section>
          <States source={source} view={view} />
          {n > 0 && (
            <>
              <Line view={view} motion={motion} onOpen={setOpen} />
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
      )}
    </OriginContext.Provider>
  );
}
