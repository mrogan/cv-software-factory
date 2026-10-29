import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { factoryRules, flagRules, HOLD_ALERT_MINUTES, LEVELS, martinRules } from '../src/alerts/rules.ts';
import { APP_REPOSITORY } from '../src/line/worker.ts';
import { DEPLOY, manifests } from './deploy.ts';

/**
 * Alertmanager as deploy/ declares it (docs/COMPONENTS/ALERTING.md): it sends each alert by its `level` label, to
 * Martin's phone through Pushover or to no one, and the app's objective alerts, which have no level, to the intake; and
 * its fence lets in only Prometheus and Grafana, and lets it reach only DNS, the intake and the internet on 443.
 * `make egress` shows the fence on the cluster.
 */
interface Route {
  receiver?: string;
  matchers?: string[];
  continue?: boolean;
  group_by?: string[];
  repeat_interval?: string;
  routes?: Route[];
}
interface Pushover {
  token_file?: string;
  user_key_file?: string;
  token?: string;
  user_key?: string;
  priority?: string;
  title?: string;
  message?: string;
  html?: boolean;
  url?: string;
  url_title?: string;
  send_resolved?: boolean;
}
interface Receiver {
  name: string;
  webhook_configs?: { url: string; send_resolved?: boolean }[];
  pushover_configs?: Pushover[];
  [other: string]: unknown;
}
interface Inhibition {
  source_matchers: string[];
  target_matchers: string[];
  equal?: string[];
}
interface Values {
  server: { alertmanagers?: Record<string, unknown>[] };
  alertmanager: {
    extraArgs?: Record<string, string>;
    extraSecretMounts?: {
      name: string;
      mountPath: string;
      subPath: string;
      secretName: string;
      readOnly: boolean;
      optional: boolean;
    }[];
    templates?: Record<string, string>;
    config: { route: Route; receivers: Receiver[]; templates?: string[]; inhibit_rules?: Inhibition[] };
  };
}

// The notify and inform receivers are the page receiver's settings merged with their own priority (`<<:`), as Helm
// reads it.
const values = async (file = 'base/telemetry/values/prometheus.yaml') =>
  parse(await readFile(join(DEPLOY, file), 'utf-8'), { merge: true }) as Values;

/** The profiles, each an overlay with its own values for Prometheus's chart. */
const PROFILES = ['local'];

/** One of Alertmanager's matchers, `name="value"`, `name!="value"`, `name=~"regex"` or `name!~"regex"`. */
function matches(matcher: string, labels: Record<string, string>): boolean {
  const [, name = '', op, quoted = ''] = /^(\w+)(=~|!~|!=|=)"(.*)"$/.exec(matcher) ?? [];
  if (!op) throw new Error(`The test does not read the matcher ${matcher}`);
  const value = labels[name] ?? '';
  const wanted = JSON.parse(`"${quoted}"`) as string;
  // Alertmanager anchors a regular expression at both ends; a label that is not there is the empty string.
  if (op === '=') return value === wanted;
  if (op === '!=') return value !== wanted;
  const regex = new RegExp(`^(?:${wanted})$`);
  return op === '=~' ? regex.test(value) : !regex.test(value);
}

/**
 * The receivers an alert reaches, as Alertmanager walks its routes: depth first, the first child that matches takes it
 * unless it says to continue, and a route none of whose children match takes it itself.
 */
function receivers(route: Route, labels: Record<string, string>): string[] {
  const reached: string[] = [];
  for (const child of route.routes ?? []) {
    if (!(child.matchers ?? []).every((m) => matches(m, labels))) continue;
    // A child with no receiver of its own inherits its parent's.
    reached.push(...receivers({ ...child, receiver: child.receiver ?? route.receiver ?? '' }, labels));
    if (!child.continue) return reached;
  }
  return reached.length > 0 ? reached : [route.receiver ?? ''];
}

describe('Alertmanager’s routes', () => {
  const cases: [string, Record<string, string>, string[]][] = [
    ['a page', { alertname: 'SecurityEvent', level: 'page', kind: 'passkey-enrolled' }, ['page']],
    [
      'a notification',
      { alertname: 'HoldWaits', level: 'notify', cause: 'merge', work_item: '1304', pull_request: '57' },
      ['notify'],
    ],
    ['a low-priority alert', { alertname: 'SecurityEvent', level: 'inform', kind: 'sign-in' }, ['inform']],
    [
      'an objective alert',
      { alertname: 'RouteLatencyAboveObjective', objective: 'latency', route: '/', symptom: 'slow-response' },
      ['intake'],
    ],
    ['an alert with no level, for the dashboards', { alertname: 'Other' }, ['dashboard']],
    ['an alert with a level not known', { alertname: 'Other', level: 'urgent' }, ['dashboard']],
    // A level makes it an alert to Martin, never a signal for the senses.
    ['an objective alert with a level', { alertname: 'X', objective: 'latency', level: 'page' }, ['page']],
  ];

  it.each(cases)('send %s to the right receiver', async (_, labels, wanted) => {
    expect(receivers((await values()).alertmanager.config.route, labels)).toEqual(wanted);
  });

  it('send nothing from the dashboards’ receiver', async () => {
    const dashboard = (await values()).alertmanager.config.receivers.find((r) => r.name === 'dashboard');
    expect(dashboard).toEqual({ name: 'dashboard' });
  });

  it('send nothing with a level to the intake', async () => {
    const intake = (await values()).alertmanager.config.route.routes?.find((r) => r.receiver === 'intake');
    expect(intake?.matchers).toContain('level=""');
    expect(intake?.continue).toBeFalsy();
  });

  it('send each alert to Martin on its own', async () => {
    for (const receiver of ['page', 'notify', 'inform']) {
      const route = (await values()).alertmanager.config.route.routes?.find((r) => r.receiver === receiver);
      expect(route?.group_by, receiver).toEqual(['...']);
    }
  });
});

describe('Alertmanager’s Pushover receivers', () => {
  const pushover = async (name: string) =>
    (await values()).alertmanager.config.receivers.find((r) => r.name === name)?.pushover_configs ?? [];

  it('page at high priority, notify at normal and inform at low', async () => {
    expect((await pushover('page')).map((p) => p.priority)).toEqual(['1']);
    expect((await pushover('notify')).map((p) => p.priority)).toEqual(['0']);
    expect((await pushover('inform')).map((p) => p.priority)).toEqual(['-1']);
  });

  it('route every level the rules set to a receiver of its own name', async () => {
    const routes = (await values()).alertmanager.config.route.routes ?? [];
    for (const level of Object.values(LEVELS)) {
      expect(routes.find((r) => r.receiver === level)?.matchers, level).toEqual([`level="${level}"`]);
    }
  });

  it('read the keys from the mounted Secret’s files, never from the configuration', async () => {
    const { alertmanager } = await values();
    for (const config of [...(await pushover('page')), ...(await pushover('notify')), ...(await pushover('inform'))]) {
      expect(config.token).toBeUndefined();
      expect(config.user_key).toBeUndefined();
      expect(config.token_file).toBe('/etc/pushover/app-token');
      expect(config.user_key_file).toBe('/etc/pushover/user-key');
      // The rule's summary or alert's name for a title, and the one message, in HTML for its links.
      expect(config.title).toBe('{{ or .CommonAnnotations.summary .CommonLabels.alertname }}');
      expect(config.message).toBe('{{ template "martin.message" . }}');
      expect(config.html).toBe(true);
      // Not Alertmanager's own address, which the phone cannot reach: no link below the message at all.
      expect(config.url).toBe('');
      expect(config.url_title).toBeUndefined();
      expect(config.send_resolved).toBe(false);
    }
    // Optional, so a cluster with no Pushover account still comes up, and still routes to the intake.
    expect(alertmanager.extraSecretMounts).toEqual([
      {
        name: 'pushover',
        mountPath: '/etc/pushover',
        subPath: '',
        secretName: 'pushover',
        readOnly: true,
        optional: true,
      },
    ]);
  });

  it('are the only receivers that leave the cluster, beside the intake', async () => {
    const { receivers: all } = (await values()).alertmanager.config;
    expect(all.map((r) => r.name).sort()).toEqual(['dashboard', 'inform', 'intake', 'notify', 'page']);
    for (const receiver of all) {
      const kinds = Object.keys(receiver).filter((key) => key.endsWith('_configs'));
      expect(kinds, receiver.name).toEqual(
        receiver.name === 'intake' ? ['webhook_configs'] : receiver.name === 'dashboard' ? [] : ['pushover_configs'],
      );
    }
    expect(all.find((r) => r.name === 'intake')?.webhook_configs?.map((w) => w.url)).toEqual([
      'http://intake.factory.svc:8080/v1/alerts',
    ]);
  });

  it('send a hold once: its alert fires for less time than a message is repeated after', async () => {
    const { route } = (await values()).alertmanager.config;
    const notify = route.routes?.find((r) => r.receiver === 'notify');
    const hours = (notify?.repeat_interval ?? route.repeat_interval ?? '').match(/^(\d+)h$/)?.[1];
    expect(Number(hours) * 60).toBeGreaterThan(HOLD_ALERT_MINUTES);
  });

  it('listens on no gossip port, as one replica has no peers', async () => {
    expect((await values()).alertmanager.extraArgs).toEqual({ 'cluster.listen-address': '' });
  });
});

describe('the message to Martin', () => {
  const template = async () => (await values()).alertmanager.templates?.['martin.tmpl'] ?? '';

  it('is a template the chart mounts beside the configuration, where Alertmanager reads its templates', async () => {
    const { alertmanager } = await values();
    expect(Object.keys(alertmanager.templates ?? {})).toEqual(['martin.tmpl']);
    expect(alertmanager.config.templates).toEqual(['/etc/alertmanager/*.tmpl']);
    expect(await template()).toMatch(/^\{\{ define "martin\.message" \}\}.*\{\{ end \}\}$/s);
  });

  it('says what each alert’s rule says and when it began, and of the labels only its name, and a hold’s numbers and cause', async () => {
    const text = await template();
    expect(text).toContain(
      '{{ range .Alerts.Firing }}{{ or .Annotations.description .Annotations.summary .Labels.alertname }}',
    );
    expect(text).toContain('Firing since {{ .StartsAt.UTC.Format "15:04 UTC, 2 January" }}.');
    const labels = [...text.matchAll(/\.(?:Common)?Labels\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(labels)].sort()).toEqual(['alertname', 'cause', 'pull_request', 'work_item']);
  });

  it('links a hold’s sheet at the profile’s console, and its pull request in the app’s repository, by number alone', async () => {
    const text = await template();
    expect(text).toContain(
      '{{ with .Labels.work_item }}{{ if match "^[1-9][0-9]*$" . }}\n<a href="{{ template "console.origin" }}/?item={{ . }}&sheet">#{{ . }} in the console</a>{{ end }}{{ end }}',
    );
    expect(text).toContain(
      `{{ $deploy := eq .Labels.cause "deploy" }}{{ with .Labels.pull_request }}{{ if match "^[1-9][0-9]*$" . }} · <a href="https://github.com/${APP_REPOSITORY}/pull/{{ . }}">{{ if $deploy }}Deploy{{ else }}Pull request{{ end }} #{{ . }}</a>{{ end }}{{ end }}`,
    );
    // Every value lands after a fixed scheme and host, so html/template escapes it as a query or a path: none can
    // make a link of its own, or leave the attribute.
    for (const [, before] of text.matchAll(/href="([^"]*?)\{\{ \. \}\}/g)) {
      expect(before).toMatch(/^(\{\{ template "console\.origin" \}\}|https:\/\/github\.com\/)/);
    }
  });

  it.each(PROFILES)('has the %s profile’s console origin, the one its passkeys are bound to', async (profile) => {
    const overlay = await values(`overlays/${profile}/values/prometheus.yaml`);
    const defined = overlay.alertmanager.templates?.['profile.tmpl'];
    const origin = defined?.match(
      /^\{\{ define "console\.origin" \}\}(https:\/\/[a-z0-9.-]+(?::\d+)?)\{\{ end \}\}$/,
    )?.[1];
    expect(origin, profile).toBeDefined();
    const admin = (await manifests<{ kind?: string; metadata?: { name?: string }; spec?: unknown }>()).find(
      ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === 'admin',
    );
    expect(JSON.stringify(admin?.manifest.spec)).toContain(`{"name":"ADMIN_ORIGIN","value":"${origin}"}`);
  });

  it('is defined for every profile, without which no message to Martin would render', async () => {
    expect(await readdir(join(DEPLOY, 'overlays'))).toEqual(PROFILES);
  });
});

interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: { matchLabels?: Record<string, string> };
  ipBlock?: { cidr: string; except?: string[] };
}
interface Policy {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    podSelector?: { matchLabels?: Record<string, string> };
    policyTypes?: string[];
    ingress?: { from?: Peer[]; ports?: { protocol: string; port: number }[] }[];
    egress?: { to?: Peer[]; ports?: { protocol: string; port: number }[] }[];
  };
}

describe('Alertmanager’s fence', () => {
  const fence = async () => {
    const policies = (await manifests<Policy>()).filter(
      ({ manifest, namespace }) =>
        manifest.kind === 'NetworkPolicy' &&
        namespace === 'telemetry' &&
        manifest.spec?.podSelector?.matchLabels?.['app.kubernetes.io/name'] === 'alertmanager',
    );
    expect(policies.map(({ manifest }) => manifest.metadata?.name)).toEqual(['alertmanager']);
    return policies[0]?.manifest.spec;
  };

  it('selects Alertmanager’s pods, in and out', async () => {
    const spec = await fence();
    expect(spec?.podSelector).toEqual({ matchLabels: { 'app.kubernetes.io/name': 'alertmanager' } });
    expect(spec?.policyTypes).toEqual(['Ingress', 'Egress']);
  });

  it('lets in only Prometheus’s server and Grafana, on its HTTP port', async () => {
    expect((await fence())?.ingress).toEqual([
      {
        from: [
          {
            podSelector: {
              matchLabels: { 'app.kubernetes.io/name': 'prometheus', 'app.kubernetes.io/component': 'server' },
            },
          },
          { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'grafana' } } },
        ],
        ports: [{ protocol: 'TCP', port: 9093 }],
      },
    ]);
  });

  it('reaches DNS, the intake, and the internet on 443 outside the cluster’s, the network’s and the host’s addresses', async () => {
    expect((await fence())?.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          },
        ],
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 },
        ],
      },
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'factory' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'intake' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
      {
        to: [
          {
            ipBlock: {
              cidr: '0.0.0.0/0',
              except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8'],
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: 443 }],
      },
    ]);
  });

  it('is the same as Kyverno’s admission controller’s way out, until egress by host name (#176)', async () => {
    const kyverno = (await manifests<Policy>()).find(
      ({ manifest, namespace }) =>
        manifest.kind === 'NetworkPolicy' &&
        namespace === 'kyverno' &&
        manifest.metadata?.name === 'admission-controller',
    );
    const internet = (await fence())?.egress?.find((rule) => rule.to?.some((peer) => peer.ipBlock));
    expect(internet).toEqual(kyverno?.manifest.spec?.egress?.[0]);
  });

  it('matches the intake’s, which lets Alertmanager in by the same label', async () => {
    const intake = (await manifests<Policy>()).find(
      ({ manifest, namespace }) =>
        manifest.kind === 'NetworkPolicy' && namespace === 'factory' && manifest.metadata?.name === 'intake',
    );
    expect(intake?.manifest.spec?.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'telemetry' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'alertmanager' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ]);
  });
});

describe('Prometheus’s way to Alertmanager', () => {
  it('names Alertmanager by its Service, and sends it no service account’s token', async () => {
    const { server } = await values();
    expect(server.alertmanagers).toEqual([
      { static_configs: [{ targets: ['prometheus-alertmanager.telemetry.svc:9093'] }] },
    ]);
    expect(JSON.stringify(server.alertmanagers)).not.toMatch(/token|kubernetes_sd|authorization/);
  });
});

/**
 * Whether Alertmanager mutes an alert while the others fire, by its inhibition rules: a rule mutes an alert its target
 * matches while another that its source matches fires, with the same values of the labels in `equal`, a label not
 * there being the empty string; and an alert that matches both sides is never muted by another that does too.
 */
function muted(rules: Inhibition[], alert: Record<string, string>, firing: Record<string, string>[]): boolean {
  const all = (list: string[], labels: Record<string, string>) => list.every((m) => matches(m, labels));
  return rules.some((rule) => {
    if (!all(rule.target_matchers, alert)) return false;
    const both = all(rule.source_matchers, alert);
    return firing.some(
      (source) =>
        source !== alert &&
        all(rule.source_matchers, source) &&
        (rule.equal ?? []).every((label) => (source[label] ?? '') === (alert[label] ?? '')) &&
        !(both && all(rule.target_matchers, source)),
    );
  });
}

describe('Alertmanager’s inhibitions: a cause pages, and what follows from it does not', () => {
  const rules = async () => (await values()).alertmanager.config.inhibit_rules ?? [];
  /** An alert as a rule raises it: its name, its rule's labels, and those its series give it. */
  const alert = (name: string, labels: Record<string, string> = {}) => {
    const rule = [...factoryRules(), ...martinRules(), ...flagRules()].find((r) => r.alert === name);
    if (!rule) throw new Error(`No rule ${name}`);
    return { alertname: name, ...rule.labels, ...labels };
  };
  const crashLooping = (worker: string) => alert('WorkerCrashLooping', { pod: `${worker}-7d9f8b6c4-x2b7q`, worker });

  it('name only alerts the rules raise', async () => {
    const names = new Set([...factoryRules(), ...martinRules(), ...flagRules()].map((r) => r.alert));
    for (const rule of await rules()) {
      for (const matcher of [...rule.source_matchers, ...rule.target_matchers]) {
        const [, op, value] = /^alertname(=~|=|!=)"(.*)"$/.exec(matcher) ?? [];
        if (!op || !value) continue;
        for (const name of value.split('|')) expect(names, matcher).toContain(name);
      }
    }
  });

  it('mute what the store down leaves the line, the workers and Argo CD unable to do', async () => {
    const store = alert('StoreDown');
    for (const name of ['LineStuck', 'LeaseOverrun', 'SecurityEventsUncounted']) {
      expect(muted(await rules(), alert(name, { stage: 'gates' }), [store]), name).toBe(true);
    }
    expect(muted(await rules(), crashLooping('triage'), [store])).toBe(true);
    expect(muted(await rules(), alert('ArgoCDDegraded', { name: 'root' }), [store])).toBe(true);
    for (const name of ['ConsoleDown', 'AppDown', 'ProbesDown', 'SpendCapReached', 'AlertmanagerSilenced']) {
      expect(muted(await rules(), alert(name), [store]), name).toBe(false);
    }
    expect(muted(await rules(), alert('ArgoCDDegraded', { name: 'website' }), [store])).toBe(false);
  });

  it('mute the line stuck while a spend cap is reached, and nothing else', async () => {
    const cap = alert('SpendCapReached', { cap: 'day' });
    expect(muted(await rules(), alert('LineStuck', { stage: 'build' }), [cap])).toBe(true);
    for (const name of ['LeaseOverrun', 'StoreDown', 'ConsoleDown']) {
      expect(muted(await rules(), alert(name), [cap]), name).toBe(false);
    }
  });

  it('mute what is said of a worker while it crash-loops, and only of that worker', async () => {
    const line = crashLooping('line');
    for (const name of ['LineStuck', 'LeaseOverrun', 'SecurityEventsUncounted']) {
      expect(muted(await rules(), alert(name), [line]), name).toBe(true);
    }
    expect(muted(await rules(), alert('ConsoleDown', { address: 'http://console' }), [line])).toBe(false);
    expect(muted(await rules(), alert('ConsoleDown'), [crashLooping('console')])).toBe(true);
    expect(muted(await rules(), alert('ProbesDown'), [crashLooping('probes')])).toBe(true);
    expect(muted(await rules(), alert('FlagsUnchecked'), [crashLooping('admin')])).toBe(true);
    expect(muted(await rules(), alert('AppDown'), [crashLooping('probes')])).toBe(false);
    // One crash loop never mutes another.
    expect(muted(await rules(), crashLooping('triage'), [line])).toBe(false);
    expect(muted(await rules(), line, [crashLooping('line')])).toBe(false);
  });

  it('mute nothing for the probes down, as what they watch cannot fire without them', async () => {
    const probes = alert('ProbesDown');
    for (const rule of [...factoryRules(), ...martinRules(), ...flagRules()]) {
      expect(muted(await rules(), alert(rule.alert), [probes]), rule.alert).toBe(false);
    }
  });

  it('never mute a security event, a silence, or a hold', async () => {
    const everything = [...factoryRules(), ...flagRules()].map((r) => alert(r.alert, { worker: 'line' }));
    const crash = [crashLooping('line'), crashLooping('console')];
    for (const name of ['SecurityEvent', 'AlertmanagerSilenced', 'HoldWaits', 'HoldStarted']) {
      expect(muted(await rules(), alert(name), [...everything, ...crash]), name).toBe(false);
    }
  });
});
