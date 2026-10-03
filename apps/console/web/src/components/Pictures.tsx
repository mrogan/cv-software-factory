/**
 * The picture on a card, and at full size in its sheet. A picture is evidence the factory captured, never an
 * illustration: screenshots with the probe's marks, a metric series, log lines, a scan, a refusal, a judgement.
 */
import type { Evidence, PayloadOf, Screenshot } from '@software-factory/events';
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react';
import { useArtifactUrl } from '../artifacts.ts';
import { axis, clock, figure, plural } from '../format.ts';
import type { Picture as PictureData, Tag } from '../projection/index.ts';
import { Glyph } from './Glyph.tsx';
import { LogoMark, logoFor } from './Logos.tsx';

const TAG_TONE: Record<Tag, 'faint' | 'attn' | 'ok'> = {
  BEFORE: 'faint',
  BROKEN: 'attn',
  FIXED: 'ok',
  AFTER: 'ok',
  NOW: 'attn',
};

const PAGE_NAME: Record<string, string> = {
  '/': 'the home page',
  '/products': 'the product list',
  '/search': 'the search page',
  '/contact': 'the contact page',
};

const pageName = (route: string) => PAGE_NAME[route] ?? route;

/** A screenshot of the app, with the probe's marks drawn where it looked. */
export function Shot({ shot, eager = false }: { shot: Screenshot; eager?: boolean }) {
  const url = useArtifactUrl();
  const [failed, setFailed] = useState(false);
  const marks = shot.boxes.map((box) => box.label).filter(Boolean);
  const alt = `Screenshot of ${pageName(shot.route)} at ${shot.version}${marks.length ? `, marked: ${marks.join('; ')}` : ''}`;
  return (
    <div className="shot">
      {failed ? (
        <div className="shot-missing" role="img" aria-label={`${alt}. It could not be loaded.`}>
          <span className="label">Screenshot unavailable</span>
          <span>
            The console could not load this screenshot of {pageName(shot.route)}. The rest of the work item is still
            here.
          </span>
        </div>
      ) : (
        <img
          src={url(shot.hash)}
          alt={alt}
          width={shot.width}
          height={shot.height}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
      {!failed &&
        shot.boxes.map((box) => (
          <span
            key={`${box.x},${box.y},${box.kind}`}
            className={`mk ${box.kind} ${box.y + box.height > shot.height * 0.8 ? 'up' : ''}`}
            style={{
              left: `${(box.x / shot.width) * 100}%`,
              top: `${(box.y / shot.height) * 100}%`,
              width: `${(box.width / shot.width) * 100}%`,
              height: `${(box.height / shot.height) * 100}%`,
            }}
            aria-hidden="true"
          >
            {box.label && <span className="mk-label">{box.label}</span>}
          </span>
        ))}
    </div>
  );
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * Where a wipe starts: between the two sides' marks when it can be, so both show; otherwise just left of the
 * after side's mark, so the change shows and the earlier state is a drag away.
 */
export function startAt(before: Screenshot, after: Screenshot): number {
  const right = Math.max(...before.boxes.map((b) => ((b.x + b.width) / before.width) * 100));
  const left = Math.min(...after.boxes.map((b) => (b.x / after.width) * 100));
  if (!before.boxes.length && !after.boxes.length) return 50;
  if (!after.boxes.length) return clamp(Math.max(50, right + 3), 8, 94);
  if (!before.boxes.length) return clamp(Math.min(50, left - 3), 6, 92);
  return right < left ? clamp((right + left) / 2, 8, 92) : clamp(left - 2, 6, 92);
}

/**
 * Before and after, with a wipe between them. The handle moves with the pointer or the arrow keys; the position is
 * kept on the element, not in React, so dragging it draws frames without rendering anything.
 */
function Wipe({ before, after, tags, interactive }: Extract<PictureData, { type: 'wipe' }> & { interactive: boolean }) {
  const wipe = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);
  const at = useRef(startAt(before, after));
  const set = (value: number) => {
    at.current = Math.max(0, Math.min(100, value));
    wipe.current?.style.setProperty('--at', `${at.current}%`);
    handle.current?.setAttribute('aria-valuenow', String(Math.round(at.current)));
  };
  // The starting place, once; from then on the handle moves it.
  useLayoutEffect(() => {
    wipe.current?.style.setProperty('--at', `${at.current}%`);
  }, []);
  const fromPointer = (event: PointerEvent) => {
    const box = wipe.current?.getBoundingClientRect();
    if (box) set(((event.clientX - box.left) / box.width) * 100);
  };
  const [a, b] = tags;
  return (
    <div className="wipe" ref={wipe}>
      <div className="a">
        <Shot shot={before} eager={interactive} />
      </div>
      <div className="b">
        <Shot shot={after} eager={interactive} />
      </div>
      <span className="div" />
      <span
        ref={handle}
        className="handle"
        role="slider"
        tabIndex={interactive ? 0 : -1}
        aria-label={`Compare ${a.toLowerCase()} and ${b.toLowerCase()}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(at.current)}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => dragging.current && fromPointer(event)}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onKeyDown={(event: KeyboardEvent) => {
          const step = { ArrowLeft: -5, ArrowRight: 5, Home: -100, End: 100 }[event.key];
          if (step === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          set(at.current + step);
        }}
      >
        <Glyph name="arrows" />
      </span>
      <span className={`wtag l tone-${TAG_TONE[a]}`}>
        <span className="dot" />
        {a} · {before.version}
      </span>
      <span className={`wtag r tone-${TAG_TONE[b]}`}>
        <span className="dot" />
        {b} · {after.version}
      </span>
    </div>
  );
}

/** Pages that look exactly as they did, in a strip of their own screenshots. */
function Unchanged({ pages }: { pages: Screenshot[] }) {
  const url = useArtifactUrl();
  if (!pages.length) return null;
  return (
    <div className="unchanged">
      <span className="thumbs" aria-hidden="true">
        {pages.map((page) => (
          <img key={page.hash} src={url(page.hash)} alt="" loading="lazy" />
        ))}
      </span>
      <span>No visible change: {plural(pages.length, 'page')} match the version before, 0.0% of pixels</span>
    </div>
  );
}

interface Series {
  values: (number | null)[];
  tone: 'signal' | 'attn' | 'muted';
  label: string;
}

const TICKS = ['none', 'half', 'all'] as const;

/** A line chart: one axis, thin lines, the last value labelled where it ends. */
function LineChart(props: {
  series: Series[];
  unit: string;
  xLabels: [index: number, text: string][];
  marker?: { index: number; label: string; low?: boolean } | undefined;
  objective?: number | undefined;
  label: string;
}) {
  const { series, unit, xLabels, marker, objective, label } = props;
  const [w, h, l, r, t, b] = [600, 210, 40, 104, 14, 24];
  const n = Math.max(...series.map((s) => s.values.length));
  const top = Math.max(objective ?? 0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const { max: yMax, ticks } = axis(top);
  const x = (i: number) => l + (i / Math.max(1, n - 1)) * (w - l - r);
  const y = (v: number) => t + (1 - v / yMax) * (h - t - b);
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      {ticks.map((v, i) => (
        <g key={TICKS[i]}>
          <line className="grid" x1={l} x2={w - r} y1={y(v)} y2={y(v)} />
          <text className="axis" x={l - 8} y={y(v) + 3.5} textAnchor="end">
            {figure(v)}
          </text>
        </g>
      ))}
      {objective !== undefined && (
        <g>
          <line className="objective" x1={l} x2={w - r} y1={y(objective)} y2={y(objective)} />
          <text className="axis" x={w - r + 8} y={y(objective) + 3.5}>
            objective
          </text>
        </g>
      )}
      {marker && (
        <g>
          <line className="marker" x1={x(marker.index)} x2={x(marker.index)} y1={t - 6} y2={h - b} />
          <text className="axis" x={x(marker.index) + 6} y={marker.low ? h - b - 8 : t + 2}>
            {marker.label}
          </text>
        </g>
      )}
      {series.map((s) => {
        const points = s.values.flatMap((v, i) => (v === null ? [] : [[x(i), y(v), v] as const]));
        const end = points.at(-1);
        if (!end) return null;
        return (
          <g key={s.label} className={`series ${s.tone}`}>
            <path d={`M${points.map(([px, py]) => `${px} ${py}`).join(' L')}`} />
            <circle cx={end[0]} cy={end[1]} r="3.5" />
            <text className="end" x={end[0] + 8} y={end[1] + 3.5}>
              {s.label} · {figure(end[2])} {unit}
            </text>
          </g>
        );
      })}
      {xLabels.map(([i, text]) => (
        <text key={i} className="axis" x={x(i)} y={h - 6} textAnchor="middle">
          {text}
        </text>
      ))}
    </svg>
  );
}

type Metric = Extract<Evidence, { kind: 'metric' }>;

function MetricPicture({ evidence, unchanged }: { evidence: Metric; unchanged: Screenshot[] }) {
  const values = evidence.values;
  const at = (i: number) => Date.parse(evidence.start) + i * evidence.stepSeconds * 1000;
  // Before is the middle of the values before the release, so one odd sample cannot move it.
  const split = evidence.marker?.index ?? values.length;
  const earlier = values
    .slice(0, split)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const before = earlier[Math.floor(earlier.length / 2)] ?? 0;
  const after = values.filter((v): v is number => v !== null).at(-1) ?? before;
  const quarters = [0, 1, 2, 3].map((q) => Math.round((q * (values.length - 1)) / 3));
  return (
    <div className="pad">
      <div className="row spread">
        <div>
          <div className="cap">{evidence.name}</div>
          <div className="big">
            <s>{figure(before)}</s> →{' '}
            <span className="ok">
              {figure(after)} {evidence.unit}
            </span>
          </div>
        </div>
        <div className="cap right">
          {clock(at(0))} – {clock(at(values.length - 1))}
        </div>
      </div>
      <LineChart
        label={`${evidence.name} over time, from ${figure(before)} to ${figure(after)} ${evidence.unit}`}
        series={[{ values, tone: 'signal', label: evidence.name.split(' ')[0] ?? '' }]}
        unit={evidence.unit}
        objective={evidence.objective}
        marker={evidence.marker}
        xLabels={quarters.map((i) => [i, clock(at(i))])}
      />
      <Unchanged pages={unchanged} />
    </div>
  );
}

type Logs = Extract<Evidence, { kind: 'logs' }>;

function Terminal({ logs, title }: { logs: Logs; title: string }) {
  return (
    <div className="term">
      <span className="t-dim">
        {title} · {logs.version}
      </span>
      {'\n'}
      {logs.lines.length === 0 ? (
        <span className="t-bad">
          no log record for {logs.requests} requests to {logs.route}
        </span>
      ) : (
        logs.lines.map((line) => (
          <span key={line.ts}>
            <span className="t-dim">{clock(Date.parse(line.ts))}</span> {line.level} {line.message}{' '}
            {line.traceId ? (
              <span className="t-good">trace {line.traceId.slice(0, 16)}</span>
            ) : (
              <span className="t-bad">trace ∅</span>
            )}
            {'\n'}
          </span>
        ))
      )}
    </div>
  );
}

function LogsPicture({ before, after }: { before: Logs | undefined; after: Logs }) {
  const spans = after.trace?.spans ?? [];
  const total = Math.max(1, ...spans.map((s) => s.offsetMs + s.durationMs));
  return (
    <div className="pad">
      <div className="row cap">
        <LogoMark name="otel" className="logo small" />
        Log lines from {after.route}, before and after
      </div>
      <div className="logs">
        {before && <Terminal logs={before} title="before" />}
        <Terminal logs={after} title="after" />
      </div>
      {spans.length > 0 && (
        <div className="wf" role="img" aria-label={`The trace a log line now links to, ${spans.length} spans`}>
          {spans.map((span) => (
            <div className="wf-row" key={span.name}>
              <span>{span.name}</span>
              <span className="wf-track">
                <b
                  style={{
                    marginLeft: `${(span.offsetMs / total) * 100}%`,
                    width: `${Math.max(1, (span.durationMs / total) * 100)}%`,
                  }}
                />
              </span>
              <span>
                {span.durationMs} ms{span.note ? ` · ${span.note}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Dependency = NonNullable<PayloadOf<'work-item.opened'>['dependency']>;

function Package({ dependency, small = false }: { dependency: Dependency; small?: boolean }) {
  const logo = logoFor(dependency.name);
  return (
    <div className={`pkg ${small ? 'small' : ''}`}>
      {logo ? <LogoMark name={logo} /> : <Glyph name="dependency" className="glyph pkg-glyph" />}
      <div>
        <div className="name">{dependency.name}</div>
        <div className="bump">
          <s>{dependency.from}</s>→<span>{dependency.to}</span>
          {dependency.security && <span className="cap">security release</span>}
        </div>
      </div>
    </div>
  );
}

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

function ScanPicture({ dependency, findings, unchanged }: Extract<PictureData, { type: 'scan' }>) {
  const most = Math.max(1, ...SEVERITIES.flatMap((s) => [findings.before[s], findings.after[s]]));
  return (
    <div className="pad">
      <Package dependency={dependency} />
      <div>
        <div className="row cap">
          <LogoMark name="trivy" className="logo small" />
          Image scan, before and after
        </div>
        <div className="sev">
          {SEVERITIES.map((s) => (
            <div className="sev-row" key={s}>
              <span>{s[0]?.toUpperCase() + s.slice(1)}</span>
              <span className="bars" aria-hidden="true">
                <i style={{ width: `${(findings.before[s] / most) * 100}%` }} />
                {findings.after[s] ? (
                  <i className="after" style={{ width: `${(findings.after[s] / most) * 100}%` }} />
                ) : (
                  <i className="after zero" />
                )}
              </span>
              <span className="n">
                {findings.before[s]} → {findings.after[s]}
              </span>
            </div>
          ))}
        </div>
      </div>
      <Unchanged pages={unchanged} />
    </div>
  );
}

function RollbackPicture({ dependency, rollback }: Extract<PictureData, { type: 'rollback' }>) {
  const { analysis } = rollback;
  const time = (i: number) => {
    const s = i * analysis.stepSeconds;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const n = Math.max(analysis.canary.length, analysis.baseline.length);
  const minutes = [0, 1, 2, 3, 4].map((m) => Math.round((m * 60) / analysis.stepSeconds)).filter((i) => i < n);
  return (
    <div className="pad">
      <div className="row spread">
        {dependency ? <Package dependency={dependency} small /> : <span />}
        <div className="cap right">
          {analysis.metric}, {analysis.unit}
          <br />
          canary at {rollback.weight}%
        </div>
      </div>
      <LineChart
        label={`${analysis.metric} on the canary against the baseline, rolled back at ${time(analysis.at)}`}
        series={[
          { values: analysis.canary, tone: 'attn', label: 'canary' },
          { values: analysis.baseline, tone: 'muted', label: 'baseline' },
        ]}
        unit={analysis.unit}
        marker={{ index: analysis.at, label: `rolled back · ${time(analysis.at)}`, low: true }}
        xLabels={minutes.map((i) => [i, time(i)])}
      />
      <div className="unchanged">
        <Glyph name="check" />
        <span>
          Baseline traffic never saw it: {100 - rollback.weight}% stayed on {rollback.restored} throughout.
        </span>
      </div>
    </div>
  );
}

/** Lines of output, each with a key of its own, even where the same text repeats. */
function keyedLines(output: string): { text: string; key: string }[] {
  const seen = new Map<string, number>();
  return output.split('\n').map((text) => {
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return { text, key: `${count}:${text}` };
  });
}

function RefusalPicture({ mechanism, output }: Extract<PictureData, { type: 'refusal' }>) {
  return (
    <div className="pad">
      <div className="row cap">
        <Glyph name="red-team" />
        {mechanism}: its own output, as recorded
      </div>
      <pre className="term">
        {/* Shown verbatim; the lines that say no, in the alarm colour. */}
        {keyedLines(output).map(({ text, key }) => (
          <span
            key={key}
            className={/✕|denied|failed|blocked/.test(text) ? 't-bad' : text.startsWith('→') ? 't-dim' : ''}
          >
            {text}
            {'\n'}
          </span>
        ))}
      </pre>
      <div className="unchanged">
        <Glyph name="check" />
        <span>The site never changed.</span>
      </div>
    </div>
  );
}

const QUESTION: Record<string, string> = {
  category: 'What kind of problem?',
  severity: 'How badly does it hurt?',
  injection: 'Instructions for a system?',
};

const ROUTE: Record<PayloadOf<'judgement.made'>['route'], string> = {
  ticket: 'a ticket',
  park: 'parked for Martin',
  quarantine: 'quarantined',
  discard: 'closed, no ticket',
};

type Answer = PayloadOf<'judgement.made'>['answers'][number];

/** One typed answer as words and the probability behind them. */
export function answerOf(answer: Answer): { text: string; p: number } {
  if (answer.type === 'choice') {
    return { text: answer.answer.replaceAll('_', ' '), p: answer.probabilities[answer.answer] ?? 0 };
  }
  if (answer.type === 'score') {
    const level = Math.max(0, Math.min(answer.levels.length - 1, Math.round(answer.expected)));
    return { text: answer.levels[level] ?? '', p: answer.probabilities[level] ?? 0 };
  }
  return answer.probability >= 0.5 ? { text: 'yes', p: answer.probability } : { text: 'no', p: 1 - answer.probability };
}

function JudgementPicture({ page, judgement }: Extract<PictureData, { type: 'judgement' }>) {
  return (
    <div className="pad">
      <div className="split">
        {page && (
          <div className="thumb">
            <Shot shot={page} />
          </div>
        )}
        <div className="verdict">
          <div className="row cap">
            <LogoMark name="jev" className="logo small" />
            Jev · {judgement.questionSet} · {judgement.model}
          </div>
          <div className="jev">
            {judgement.answers.map((answer) => {
              const { text, p } = answerOf(answer);
              return (
                <div className="jev-row" key={answer.key}>
                  <span className="q">{QUESTION[answer.key] ?? answer.question}</span>
                  <span className="p" aria-hidden="true">
                    <i style={{ width: `${p * 100}%` }} />
                  </span>
                  <span className="a">
                    {text} {p.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="routing">
            Routing: <b>{ROUTE[judgement.route]}.</b> A report’s text is untrusted: no generative agent ever reads it.
          </div>
        </div>
      </div>
    </div>
  );
}

function SpecPicture({ spec, question }: Extract<PictureData, { type: 'spec' }>) {
  return (
    <div className="pad">
      <div className="spec">
        <div className="cap attn">Spec · waiting for Martin</div>
        <div className="outcome">{spec.outcome}</div>
        <div className="gwt">
          {spec.criteria.map((c) => (
            <div key={c.given + c.when}>
              <b>GIVEN</b> {c.given} <b>WHEN</b> {c.when} <b>THEN</b> {c.expect}
            </div>
          ))}
        </div>
        {question && <div className="ask">The planner asks: {question}</div>}
      </div>
    </div>
  );
}

export function Picture({ picture, interactive }: { picture: PictureData; interactive: boolean }) {
  return (
    <div className={`vis vis-${picture.type}`}>
      {picture.type === 'wipe' && <Wipe {...picture} interactive={interactive} />}
      {picture.type === 'screenshot' && <Shot shot={picture.shot} />}
      {picture.type === 'metric' && <MetricPicture evidence={picture.evidence} unchanged={picture.unchanged} />}
      {picture.type === 'logs' && <LogsPicture before={picture.before} after={picture.after} />}
      {picture.type === 'package' && (
        <div className="pad">
          <Package dependency={picture.dependency} />
          <div className="lockfile">
            {picture.files.map((file) => (
              <div key={file.path}>
                <span>{file.path}</span>
                <span className="plus">+{file.added}</span>
                <span className="minus">−{file.removed}</span>
              </div>
            ))}
          </div>
          {picture.checks && (
            <div className="row checks">
              <Glyph name="check" />
              {picture.checks.passed === picture.checks.total
                ? `All ${picture.checks.total} required checks passed`
                : `${picture.checks.passed} of ${picture.checks.total} required checks passed`}
            </div>
          )}
          <Unchanged pages={picture.unchanged} />
        </div>
      )}
      {picture.type === 'scan' && <ScanPicture {...picture} />}
      {picture.type === 'rollback' && <RollbackPicture {...picture} />}
      {picture.type === 'refusal' && <RefusalPicture {...picture} />}
      {picture.type === 'judgement' && <JudgementPicture {...picture} />}
      {picture.type === 'spec' && <SpecPicture {...picture} />}
      {picture.type === 'none' && (
        <div className="pad empty-picture">
          <span className="cap">Nothing captured yet</span>
        </div>
      )}
    </div>
  );
}
