# Feature flags

Ship improvements switched off; a kill switch without a rollback. Part of the [runtime plane](README.md#runtime-plane).

- **v1:** OpenFeature with flagd.

## Where it runs

- **flagd 0.17, alone in `flagd`,** not in the app's pod or beside it in `website` (`deploy/base/flagd`). The app's pods hold no token and no route to the Kubernetes API, and nothing the app's repository may write in `website` can touch flagd, its service account or its state.
- **The state of every flag is one `FeatureFlag`, `flags` in `flagd`,** which flagd watches through the Kubernetes API. Only the kind's definition is installed, vendored from OpenFeature's operator at the API version flagd builds against, not the operator itself. In Git it has no flags. Argo CD makes it before flagd starts, and leaves its flags alone ([GitOps](GITOPS.md#syncing)).
- **flagd reads, and writes nothing.** Its watch lists the whole namespace, so its Role may get, list and watch `featureflags` in `flagd`, with no names. Admission keeps `flags` the only one there and refuses its deletion, since flagd keeps serving the last flags it read when its resource goes ([admission control](ADMISSION-CONTROL.md#flags)). Nothing of ours may write `flags` yet.
- **The app's pods reach flagd's sync port (8015) and its health port (8014), and nothing else of it** ([network policies](NETWORK-POLICIES.md#flagd)). flagd reaches the Kubernetes API, DNS and the collector, where its traces and metrics go; its logs are its container's.
- **Its image is admitted by digest** in a copy of admission control of its own, `flagd-images`, so `website-images` still admits no third-party image.

## Readiness

flagd reads `flags` before it serves anything, and exits if it cannot: with the resource missing, its Role or binding missing, or the API out of reach, it restarts until it can, and is never ready. A first flag set it refuses leaves it unready. Once ready it stays ready: at 0.17 its readiness follows its first read, not its watch, which it retries for ever when broken, while it serves the last flags it took. A watch broken after start is caught from outside instead: the admin service compares the revision in `flags` with the one the app reports, every 60 seconds, and Martin is alerted when they have differed for more than 5 minutes (milestone 7, task 16, not built yet).

## The preview cookie

A flag's opt-in stage is on for browsers that ask to preview it, with `?preview=<flag>` on any page of the app, and the app remembers the ask in its preview cookie. The app keeps nothing else on a visitor's device, and has no cookie banner: the cookie is set only for someone who asks for the preview, to give them what they asked for, so it is strictly necessary (PECR regulation 6, as the Data (Use and Access) Act 2025 amends it, and the ICO's guidance on storage and access). It is the one thing flags keep on a device. No id for a share of visitors is kept, and none is worked out from an address or a user agent.

The [probes' `/device` check](PROBES-AND-CRAWLER.md#the-probes) allows it only for a browser that asked (`apps/factory/src/senses/device.ts`), and the console's [privacy page](CONSOLE.md#what-it-draws) names it, as the app's own `/privacy` does.

### Its contract

The app sets the cookie exactly as this says, and the `/device` check holds every attribute to it, not the name alone, as the browser kept them: a cookie set with no `SameSite` reads as `Lax`, as Chromium treats it, and one set with `Expires` as one set with the same `Max-Age`, so the lifetime is checked, from the answer to the latest ask, rather than which of the two set it. The check bounds what is kept: a cookie that lasts less than a day, or names fewer flags than were asked for, keeps less, and passes it. That the app sets exactly a day, and that a name is one flagd knows, are the app's own tests' to check:

| | |
|---|---|
| When | Only on a request whose `?preview=` names a flag flagd knows. One that names any other changes nothing, and the app never echoes the parameter. |
| Name | `preview` |
| Value | The flags asked for, each once, in the order asked, joined by `.`: `dark-mode.big-buttons`. Each ask adds its flag to those the cookie already names that flagd still knows. A flag's name is lower-case letters and digits, in words joined by hyphens; a flag named otherwise cannot be previewed. |
| `Path` | `/` |
| `Domain` | None, so it is the app's host's alone |
| `Max-Age` | `86400`: a day from the latest ask. No ask, no renewal. |
| `HttpOnly` | Always: only the app's server reads it |
| `SameSite` | `Lax`, so following a link to the app, as from the console, carries it |
| `Secure` | Exactly when the request reached the app over HTTPS: its own scheme, or `X-Forwarded-Proto: https` from Traefik. The app is served over plain HTTP on every profile today (`website.localhost:8080` through Traefik, `http://website.website` for the probes), so it sets none. A browser drops a `Secure` cookie set over plain HTTP but on a `localhost` name, so one set always would reach a browser through Traefik and never the probes' Chromium, which could not then see it. |

The cookie names flags and decides nothing: flagd does, so a flag turned off is off for a browser whose cookie names it. Nothing removes it but its `Max-Age` or the browser's own settings.

### How a probe asks

A check asks for a preview with its context's `preview(flag)`, which opens `?preview=<flag>` on a path of the app, on its page (`senses/browser.ts`). It is the one way to ask, so the pass knows, and it counts once the app has answered. A pass's checks share a browser context, so from the ask on, every check's `/device` check in that pass allows a `preview` cookie that keeps to the contract and names only flags the pass asked for, in the order asked, and lists it as `allowed`. Anything beside it still fails the check. Without an ask, the cookie fails it like any other; with one, a cookie that breaks the contract fails it with what is wrong (`readable by a script`, `naming big-buttons, which was not asked for`). No probe asks yet: the opt-in stage's check adds the one that does (milestone 7, task 17).

## The share's signed ids

A flag's share stage is on for a share of the [traffic generator](TRAFFIC-GENERATOR.md#its-ids)'s requests, chosen by flagd's `fractional` rule over the id each one carries. The id is signed, so that nobody else can walk into the share by sending one.

- **The key.** `make share-key` (and so `make up`) makes an Ed25519 key pair once. The private key is the Secret `share-signing-key` in `factory`, which only the generator mounts. The public key is the ConfigMap `share-key` in `website`, under `public-key`, as SPKI in PEM, written again from the Secret each time the target runs. Only `make share-key`'s user may make, change or delete `share-key` ([admission control](ADMISSION-CONTROL.md#share-key)), so nothing from the app's repository can replace it.
- **The app holds only the public key,** and treats an id as signed only when its signature checks out for that request, is less than a minute old, and is not from the future. It ignores an id without one. With no public key, or one it cannot read, nothing is signed.
- **A signature is a bearer credential,** for its page and its minute, so what keeps visitors out is that none ever sees one. The generator's requests go from its pod to Traefik's Service inside the cluster ([network policies](NETWORK-POLICIES.md#factory)), and Traefik keeps no access log; a test fails if its access log is turned on without dropping the three headers below, or if its tracing captures any of them. The generator puts neither the signature nor its headers in a log, a span or a metric. The ids alone are harmless, since an unsigned id is ignored, so they are a label of the generator's metrics. Anything that read a signature could replay it, for that page and that minute, and the worst it does is show a feature at the share stage and add a request to the figures.
- **Which side an id is on is Verify's to work out,** with flagd's own `fractional` rule, from the flag's stage and share in the admin service's events. The generator never reads `flags` or asks flagd.

### The contract

The app's flag context checks what the generator sends exactly as this says.

Each signed request carries three headers:

| Header | Value |
|---|---|
| `x-share-id` | The id, ASCII: the generator's are `traffic-000` to `traffic-100` |
| `x-share-time` | When it was signed, in whole seconds since the Unix epoch, in decimal with no sign, point or leading zero |
| `x-share-signature` | The Ed25519 signature (RFC 8032, pure Ed25519 with no prehash) of the message below, in base64url with no padding: 86 characters |

The message is six fields, in this order, each its UTF-8 bytes after its length in bytes as an unsigned 32-bit big-endian integer, and nothing between or after them:

1. the context string, `software-factory share-id v1`;
2. the id, as in `x-share-id`;
3. the time, as in `x-share-time`, as its decimal digits;
4. the host: the request's `Host` header, in lower case, with its port when it names one (`website.localhost` on the local profile);
5. the method, in upper case: `GET`, the only one the generator sends;
6. the path: the request target as sent on the request line, the path and its query, percent-encoding and all (`/search?q=glove`), and no fragment.

The app accepts a signature when every one of the three headers is there, once; the time is all digits; with `now` its own clock in whole seconds, `0 <= now - time < 60`; and the signature verifies, with the public key in `share-key`, over the message it builds from those headers and its own view of the request: its `Host`, method and request target, not anything the request says about itself elsewhere. Anything else and the request is not signed, and the id is not its targeting key.

### Test vector

The private key is RFC 8032's first test key, so its public key is the RFC's too. `apps/factory/test/share.test.ts` holds the generator's code to this block, and the app's tests check their verification against it.

```json
{
  "privateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n-----END PRIVATE KEY-----\n",
  "publicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n",
  "request": { "id": "traffic-007", "time": 1793001600, "host": "website.localhost", "method": "GET", "path": "/search?q=glove" },
  "message": "0000001c736f6674776172652d666163746f72792073686172652d69642076310000000b747261666669632d3030370000000a3137393330303136303000000011776562736974652e6c6f63616c686f7374000000034745540000000f2f7365617263683f713d676c6f7665",
  "headers": {
    "x-share-id": "traffic-007",
    "x-share-time": "1793001600",
    "x-share-signature": "so1eBQuRv1KfCSVYqZIIvAw24N-DIIFbE1IZxbAQiilqhAAZbk5RqiUTthh7gDkK39T_VHLj6I9Q95SArrAeAw"
  }
}
```

The message is in hex. The time is 2026-10-26T08:00:00Z: an app checking this vector against its own clock refuses it, as it should, so its test sets the clock to within the minute after.
