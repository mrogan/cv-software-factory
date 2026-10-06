/**
 * The factory's dashboard reads spend from the gateway's counter, not from events: the gateway adds every priced
 * call to it as the call is made, so the panel is the same whatever shape `model.called` has (one event per step
 * since version 2). This holds the panel's queries to the counter's name, as Prometheus names an OpenTelemetry
 * counter: its name, then `_total`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPEND_METRIC } from '../../src/gateway/metrics.ts';

interface Panel {
  title?: string;
  panels?: Panel[];
  targets?: { expr?: string }[];
}

const dashboard = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../deploy/base/telemetry/dashboards/factory.json', import.meta.url)),
    'utf-8',
  ),
) as { panels: Panel[] };

const all = (panels: Panel[]): Panel[] => panels.flatMap((panel) => [panel, ...all(panel.panels ?? [])]);

describe('the factory’s dashboard', () => {
  const spend = all(dashboard.panels).filter((panel) => /spend/i.test(panel.title ?? ''));

  it('has its spend panels', () => {
    expect(spend.map((panel) => panel.title)).toEqual(['Gateway spend in the period', 'Gateway spend']);
  });

  it('reads spend only from the counter the gateway adds every priced call to', () => {
    for (const panel of spend) {
      const metrics = (panel.targets ?? []).flatMap((target) => target.expr?.match(/factory_[a-z_]+/g) ?? []);
      expect(metrics, panel.title).toEqual([`${SPEND_METRIC}_total`]);
    }
  });
});
