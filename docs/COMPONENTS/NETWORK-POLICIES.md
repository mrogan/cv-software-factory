# Network policies

Each pod reaches only what it needs. Of the factory's workers, only the gateway and the GitHub worker may leave the cluster. Part of the [factory plane](README.md#factory-plane).

- **v1:** Kubernetes NetworkPolicies, which k3s enforces.
- **Later:** egress by host name (#176).

A NetworkPolicy cannot name a host, so internet egress is by address and port (#176). Where a pod may reach the internet, it is on port 443, outside the cluster's own and the local network's addresses: the nearest a NetworkPolicy gets to naming a host.

```mermaid
flowchart LR
  subgraph factory
    gateway[Gateway]
    worker[GitHub worker]
    line[Line]
    triage[Triage]
    probes[Probes and crawler]
  end
  subgraph kyverno
    admission[Admission controller]
  end
  subgraph website
    app[The app]
  end
  internet((Internet, 443))
  gateway --> internet
  worker --> internet
  admission --> internet
  triage --> gateway
  line --> worker
  line -- verify port --> probes
  triage -- page reader --> probes
  probes --> app
```

## `factory`

Everything is denied in and out, then each pod is allowed what it needs.

| Pod | Reaches | Reached by |
|---|---|---|
| Every pod | DNS | |
| Every worker but the GitHub worker and the traffic generator | Postgres and the collector | |
| Gateway | The internet | Triage, and the runners' agent pods |
| GitHub worker | The collector and the internet | The line, only |
| Triage | The gateway; the probes' page reader; Prometheus, Loki and Tempo, through the read-only proxy | |
| Intake | Prometheus and Loki, through the read-only proxy | Alertmanager |
| Log watcher | Prometheus, Loki and Tempo, through the read-only proxy | |
| Probes | The app, the canary's pods included | The line, on their verify port; triage, on their page reader |
| Crawler | The app, the canary's pods included | Nothing |
| Line | The GitHub worker, the Kubernetes API, the probes' verify port, and Prometheus, Loki and Tempo through the read-only proxy | The runners' agent pods, with their handbacks |
| Traffic generator | Traefik and the collector, and nothing else but DNS | |

- Only the line may call the probes' verify port, as only triage may call their page reader.
- Each pod that reads telemetry reaches the [read-only proxy](TELEMETRY.md#reading-it) on the ports of the backends it reads, and none of the backends: a policy allows a port, not a path, and on those ports the backends take writes too.
- The runners' pods are fenced as [their page](AGENT-RUNNERS.md) says.

## `kyverno`

Everything is denied, then:

- both controllers may reach DNS and the Kubernetes API;
- the API server may call the admission webhook;
- the admission controller alone may reach the internet, for GHCR and Sigstore's trust root ([admission control](ADMISSION-CONTROL.md));
- Prometheus may scrape both controllers' metrics, on 8000 alone ([telemetry](TELEMETRY.md#the-platforms-own-metrics)).

## `argo-rollouts`

The controller reaches DNS, the Kubernetes API and Prometheus, and only Prometheus calls it, to scrape its metrics on 8090 ([telemetry](TELEMETRY.md#the-platforms-own-metrics)).

## `website`

The policy comes from this repository, since the app's AppProject cannot make one ([GitOps](GITOPS.md)).

| Pod | Reaches | Reached by |
|---|---|---|
| The app's pods, whose code agents write | DNS and the collector's OTLP port | Traefik, the probes, the crawler and the canary's journeys Job, on 8080 only |
| The journeys Job | DNS and the app's pods, and nothing else | |

The scoreboard's own policy is on [its page](SCOREBOARD.md#where-it-runs).

## `make egress`

It starts a pod labelled like each fenced part, and shows what each reaches and what it does not:

- a worker;
- a runner's agent and prepare pods;
- the analysis Job;
- the app;
- the Rollouts controller;
- Kyverno's two controllers;
- a pod in `telemetry` that is none of its backends, answering on their ports, which no reader of telemetry reaches.

The workers' own checks (the gateway, the GitHub worker, triage, the intake, the log watcher, the line, the traffic generator, the probes, the crawler and the scoreboard) run from a short-lived probe pod made from each worker's live Deployment, never inside the worker, whose memory a second Node beside its own could exhaust. The probe pod keeps everything a network policy selects on or that decides where the pod can reach (namespace, labels, DNS, hosts, image, security contexts) and idles in place of the worker's code, with its own small memory limit and no service account token. It is never ready, so the worker's Service sends it nothing. So the checks prove the worker's fences, and not that the worker's own code keeps to them.

Each reader of telemetry queries the backends it reads through the proxy, and through it cannot push metrics or logs, have Prometheus reload or flush Tempo; Prometheus, asked directly, will not reload either.

It has controls, which must reach what they reach:

- the gateway reaches TypeSafe;
- the GitHub worker reaches GitHub and GHCR;
- Kyverno's admission controller reaches GHCR and Sigstore;
- the traffic generator reaches the app only through Traefik;
- the line reaches Loki, Tempo and the probes' verify port, but not their page reader;
- the probes reach the canary;
- Traefik, the probes and the crawler still reach the app.
