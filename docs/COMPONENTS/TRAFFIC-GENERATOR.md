# Traffic generator

Gives canary analysis enough samples within minutes. Part of the [runtime plane](README.md#runtime-plane).

- **v1:** `factory traffic` (`apps/factory/src/traffic`), one replica in `factory`.

## What it walks

- It finds the app's public pages from its front door, breadth first, and adds a search for the first word of each product's address.
- It walks them in the same order every round, at the rate `policy/release.ts` sets (five requests a second).
- It finds them again every ten minutes.

## How it goes in

- **Through Traefik,** with the app's host name, so the canary's split applies to it as to any visitor ([progressive delivery](PROGRESSIVE-DELIVERY.md)).
- **GET only.** It never sends a report or the contact form.
- **In proportion.** A round's length shares no factor with 100, so Traefik's weighted round robin deals every page to both versions in proportion.
- **All the time,** so the objectives have traffic too. With the visitors', its requests are the only ones they judge: the senses' are not counted ([probes and crawler](PROBES-AND-CRAWLER.md#not-counted)).
- **By name.** Its user agent is `software-factory-traffic`, so the collector marks its requests `traffic="factory"` and counts them apart from the visitors' ([browsers, counted](TELEMETRY.md#browsers-counted)).
- **Inside the cluster.** From its pod to Traefik's Service, `http://traefik.kube-system`, naming the app's host; its network policy lets it reach Traefik's pods, the collector and DNS, and nothing else ([network policies](NETWORK-POLICIES.md#factory)).

## Its ids

For a flag's share stage ([feature flags](FEATURE-FLAGS.md#the-shares-signed-ids)), each request carries one of its ids, signed with its own key.

- **101 fixed ids,** `traffic-000` to `traffic-100`, the same across restarts, so the same ids are on the same side of a share from one window to the next.
- **One a request, in turn.** 101 is a prime, and a round's length is made to share no factor with it as well as with 100, so over every stretch of a round's length times 101 requests, each page meets each id once: each side of a share gets the same mix of pages. And as 101 shares no factor with 100, the ids turn independently of the canary's split, so a flag left at the share stage gives a canary's two sides the same mix of on and off.
- **Signed, with a key only it holds:** the Secret `share-signing-key`, mounted read-only at `/var/run/share-key` (`SHARE_KEY_FILE`). It reads it when it starts. With no key there, as on a cluster made before it, or one it cannot use, it says so once, sends no id, and walks as before.
- **Never recorded.** Neither the signature nor its headers is in its logs, spans or metrics; its requests make no span at all ([telemetry](TELEMETRY.md#routine-polling)).

## Its own figures

The code being judged must not label its own figures, so the generator measures each request itself, as metrics sent to the collector, and on to Prometheus:

| Metric | Labels |
|---|---|
| `factory_traffic_requests_total` | `status`: the status that answered, or `none` |
| `factory_traffic_request_duration_seconds` | `share_id`: the id it carried, or `none` without the key; `status_class`: `2xx` to `5xx`, or `none` when no answer came. From sending to the end of the answer, or to giving up after ten seconds, in buckets from 25 ms to 10 s, finest around the tenth of a second by which a canary's slower tail fails |

It does not work out sides. Verify, which knows from the admin service's events which flag is at the share stage and its share, maps each id to its side with flagd's own `fractional` rule (milestone 7, task 17). With 101 ids, five status classes and twelve buckets, the histogram is at most about 7,000 series.
