/**
 * The dashboards' colours, one meaning each on every dashboard: an outcome is the same colour wherever it is drawn,
 * and red, amber and green mean the same on every tile. The dashboards test holds every dashboard to it.
 *
 * - **Status** is for what is good or bad: a tile's thresholds and an outcome's series. Green is good, amber asks for
 *   a look (held, capped, refused), orange is something around an agent failing, red is a failure, grey is neither.
 * - **Series** is for identity, where nothing is good or bad: agents, the sources of signals, stable and canary. Its
 *   order is fixed, so a series keeps its colour whichever others are drawn beside it.
 *
 * Grafana draws one colour in both of its themes, so these are the dark theme's steps, Grafana's default, of a palette
 * validated for colour-blind readers. A tile's text with no judgement in it is Grafana's own `text`; an empty state
 * takes it too, so "No steps in this range" is never red.
 */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
  neutral: '#898781',
} as const;

/** Identity colours, in their fixed order: a ninth series is folded into others, never given a new colour. */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;

/** Grafana's own colours a dashboard may use: the theme's text, and none at all. */
export const GRAFANA = ['text', 'transparent'] as const;

/** Every outcome a series is labelled with, the line's, the gateway's and Verify's, and its status. */
export const OUTCOMES: Record<string, keyof typeof STATUS> = {
  done: 'good',
  promoted: 'good',
  cleared: 'good',
  answered: 'good',
  failed: 'critical',
  'max-turns': 'critical',
  'rolled-back': 'critical',
  persists: 'critical',
  errored: 'serious',
  'effects-failed': 'serious',
  capped: 'warning',
  held: 'warning',
  refused: 'warning',
  stale: 'neutral',
  stopped: 'neutral',
  aborted: 'neutral',
  replayed: 'neutral',
};

/** Each agent's colour, in the order of the events' vocabulary. */
export const AGENT_COLOURS = {
  triage: SERIES[0],
  planner: SERIES[1],
  coder: SERIES[2],
  reviewer: SERIES[3],
  describer: SERIES[4],
  'red-team': SERIES[5],
} as const;

/** Each source of a signal's colour: the senses in the vocabulary's order, then the planner. */
export const SOURCE_COLOURS = {
  probe: SERIES[0],
  crawler: SERIES[1],
  metrics: SERIES[2],
  logs: SERIES[3],
  canary: SERIES[4],
  report: SERIES[5],
  planner: SERIES[6],
} as const;
