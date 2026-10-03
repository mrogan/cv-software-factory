/**
 * From an alert to a signal. Alertmanager's webhook carries the alerts that fired; each firing alert names a route
 * and a symptom class in its labels (alerts/rules.ts puts them there), and this fetches the rest: the series behind
 * it as a picture, the version of the app that served the requests, and the route as the app's logs name it.
 */
import { type InboxSignal, SYMPTOM_CLASSES } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import { z } from 'zod';
import type { Objectives } from '../../../../policy/objectives.ts';
import * as query from '../alerts/queries.ts';
import { OBJECTIVES } from '../alerts/rules.ts';
import type { Loki } from '../clients/loki.ts';
import type { Prometheus } from '../clients/prometheus.ts';
import { routeOf } from '../routes.ts';

/** Alertmanager's webhook, version 4. Only what the intake reads. */
const payload = z.object({
  alerts: z.array(
    z.object({
      status: z.enum(['firing', 'resolved']),
      labels: z.record(z.string(), z.string()),
      annotations: z.record(z.string(), z.string()).default({}),
      startsAt: z.string(),
    }),
  ),
});
export type Alert = z.infer<typeof payload>['alerts'][number];

/** An alert that can never become a signal, so Alertmanager should not send it again. */
export class Refused extends Error {}

export interface Backends {
  objectives: Objectives;
  prometheus: Prometheus;
  loki: Loki;
  now(): Date;
}

/** How much of the series behind an alert to show: an hour, a point a minute. */
const PICTURE = { seconds: 3600, stepSeconds: 60 };

/** Reads a webhook's body. */
export function parse(body: unknown): Alert[] {
  const result = payload.safeParse(body);
  if (!result.success) throw new Refused('The body is not an Alertmanager webhook');
  return result.data.alerts;
}

/** What an alert's objective is called, how it is measured and where it draws the line. */
function measure(o: Objectives, objective: string | undefined, scope: query.Scope) {
  if (objective === OBJECTIVES.errorRatio) {
    return {
      name: 'Share of requests with a 5xx status',
      unit: 'ratio',
      series: query.errorRatio(o, scope),
      check: 'error ratio',
      threshold: o.errorRatio.max,
    };
  }
  if (objective === OBJECTIVES.latency) {
    const percentile = query.percentileName(o.latency.percentile);
    return {
      name: `${percentile} latency`,
      unit: 's',
      series: query.latency(o, scope),
      check: `latency ${percentile}`,
      threshold: o.latency.maxSeconds,
    };
  }
  return undefined;
}

/** The signal for one firing alert. Throws `Refused` for one that names no route or symptom the factory knows. */
export async function signalFor(alert: Alert, backends: Backends): Promise<InboxSignal> {
  const { objectives: o, prometheus, loki } = backends;
  const now = backends.now();
  const { route: path, symptom, objective } = alert.labels;
  const symptomClass = SYMPTOM_CLASSES.find((known) => known === symptom);
  if (!path || !symptomClass) throw new Refused('The alert carries no route, or a symptom class the factory lacks');

  const scope = { route: path };
  const measured = measure(o, objective, scope);
  if (!measured) throw new Refused(`The alert is for an objective the factory does not know: ${objective}`);

  const start = new Date(now.getTime() - PICTURE.seconds * 1000);
  const [picture, versions, route] = await Promise.all([
    prometheus.range(measured.series, start, now, PICTURE.stepSeconds),
    prometheus.instant(query.versions(o, scope), now),
    routeOf(loki, o, path, now),
  ]);
  const version = versions.find((sample) => sample.labels.service_version)?.labels.service_version;
  if (!version) throw new Error(`Prometheus has no version for the requests to ${path}`);

  const firedAt = Date.parse(alert.startsAt);
  const index = Math.round((firedAt - start.getTime()) / 1000 / PICTURE.stepSeconds);
  const signal: InboxSignal = {
    sense: 'metrics',
    check: measured.check,
    route,
    version,
    symptom: symptomClass,
    observedAt: now.toISOString(),
    artifacts: [],
    ...(picture && picture.values.length >= 2
      ? {
          evidence: [
            {
              kind: 'metric' as const,
              name: measured.name,
              unit: measured.unit,
              objective: Number(alert.annotations.threshold ?? measured.threshold),
              start: picture.start.toISOString(),
              stepSeconds: picture.stepSeconds,
              values: picture.values,
              ...(index >= 0 && index < picture.values.length ? { marker: { index, label: 'alert fired' } } : {}),
            },
          ],
        }
      : {}),
  };
  const checked = validateSignal(signal);
  if (!checked.ok) throw new Refused(`The alert makes a signal the inbox would refuse: ${checked.problems.join('; ')}`);
  return signal;
}
