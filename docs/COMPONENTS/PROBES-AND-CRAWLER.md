# Probes and crawler

Synthetic journeys and site checks, with screenshots for the event store, the checked elements' positions, and each page compared with the version before. Part of the [runtime plane](README.md#runtime-plane).

- **v1:** Playwright on a schedule, on the `factory-browser` image ([workers and images](WORKERS-AND-IMAGES.md)).

`factory probes run` serves three things on the probes worker:

| What | Where | Who may call it |
|---|---|---|
| [The probes](#the-probes) | Its own schedule | |
| [Pictures](#pictures) | While the stable and canary versions differ | |
| [The page reader](#the-page-reader) | `POST /v1/pages` | Triage, only |
| [Verify](#verify) | `POST /v1/verify`, on `VERIFY_PORT` (8081) | The line, only |

## The probes

`apps/factory/src/probes`. The journeys a shopper takes:

- browse;
- open a product;
- search;
- page through the catalogue;
- send the contact form.

Each is made of generic checks, compared with the app's own API where it has one, and written from its public pages without the answer key.

They look at the stable Service, `website`, so a canary is judged by its analysis, not by the senses ([progressive delivery](PROGRESSIVE-DELIVERY.md)).

### Not counted

Every request the probes, the crawler and the page reader make sends `x-unmeasured`, from the browser and without it. The app keeps no record of them in its metrics, request log or traces ([whose requests are judged](PROGRESSIVE-DELIVERY.md#whose-requests-are-judged)):

- **During a canary,** the baseline's figures hold none of their requests, nor anything their checks provoke, as the canary's hold none.
- **The objectives** judge the visitors' requests and the [traffic generator](TRAFFIC-GENERATOR.md)'s alone. The senses look for what goes wrong on their own requests themselves.
- **An error** one of their requests causes is still logged, so the [log watcher](LOG-WATCHER.md) sees it, with no trace.
- **Only on the Service.** The shop's public route removes the header, so a sense run on the host through Traefik (`APP_URL=http://website.localhost:8080`) is counted like a visitor.

### The sense runner

`apps/factory/src/senses` runs the probes:

- every few minutes, and at once when `/version` changes;
- sending a signal only for a check that has failed twice in a row, with a screenshot and the evidence.

A check that costs something, such as sending a contact message, may run at most so often (the contact checks, once an hour).

## The page reader

For triage: `POST /v1/pages` with a path returns a screenshot in the artifact store, and the page's text in passages.

## Verify

For the line's [Verify](RELEASE-AND-VERIFY.md#verify): `POST /v1/verify` with a ticket's sense, check and route (`probes/verify.ts`).

- It runs that probe, or the crawl, against the stable Service until the check passes or fails twice in a row, at most four times.
- It calls it unsure when it cannot finish, or the version moves between runs.
- A crawl run four times outlasts an HTTP request, so the first call starts it and answers 202, and a later one gets the answer. One runs at a time.

## Pictures

With `CANARY_URL` set to the canary's Service, the probes worker watches both Services' `/version`. While they differ, it pictures the shop on each.

```mermaid
flowchart TD
  differ["The stable and canary /version differ"] --> shoot[Screenshot each page on both]
  shoot --> compare[Compare each pair, pixel by pixel]
  compare --> record[Record each page once both versions are seen unmoved]
  record --> promoted{Canary promoted?}
  promoted -- yes --> after[Take each page with a box again on the stable Service: the page after rollout]
```

### Taking them

- **Which pages:** every page of the shop on each Service (the pages the traffic generator finds from the front door, at most sixty, full page to 1600 pixels).
- **Boxed pages first:** the pages where a sense boxed a finding come first, with those elements boxed on both versions: every one, however many checks boxed the page, since the line keeps only a ticket's own ([Verify](RELEASE-AND-VERIFY.md#pictures)). Each box is indexed with the element it was drawn round.
- **Compared** pixel by pixel (`pictures/`, pixelmatch).
- **Not judged:** its requests send `x-unmeasured` too, so they are not judged with the canary's visitors.
- **Recorded** once both versions are seen unmoved. A promotion or rollback while a page is taken drops it and ends the pass, and a page missed is tried again, three passes in all.
- **After rollout:** once the canary is promoted, each page with a box is taken again on the stable Service.

### Where they are kept

The images go to the artifact store, and the index to Postgres:

| Table | Holds | The writer may |
|---|---|---|
| `pictures` | Each page's before, after, share changed, diff and after-rollout shot, by canary and stable version | Add rows, set only the after-rollout shot, and delete them |
| `looks` | Where each sense's finding was boxed, kept 30 days, which the senses write as they signal | |

### Forgetting them

Between releases, once the pages after the rollout are taken, the probes worker forgets the pictures of every release but:

- the last five (`policy/release.ts`'s `pictures`);
- the one the stable version was pictured as a canary in;
- those a work item waits at Verify for (promoted, with no verification, return or close since).

It deletes each of their images that:

- no picture kept,
- no event and no signal triage has still to take names, and
- was not stored again in the ten minutes before;

then the rows whose images are all gone.

- A verification's pages stay as long as its event does.
- A diff, which no event names, goes with its release.
- A release's pictures take about 12 MB, and at most about 26.

## The crawler

`apps/factory/src/crawler`, `factory crawler run`. It follows every link, image, script and stylesheet from the home page on the same origin, up to a cap, and checks each page and asset for:

- broken links and images;
- redirect loops;
- server errors;
- console errors;
- accessibility with axe, only the rules that name a class: missing alt text, contrast, unlabelled fields;
- the usual security headers;
- caching of static assets;
- response time;
- whether the error pages, for a missing page and a malformed request, give away stack traces, paths or software versions.

It uses the same sense runner, so a check signals after failing twice in a row.

### Routes

- **Templates.** A finding is on the route template worked out from the URLs it saw (`/products/:slug`).
- **Everywhere.** A class found on every page crawled is one finding, for `*`.
- **Redirects.** A page is opened only at its own address. A link that redirects is judged on the route asked for, for what is about the request (a redirect loop, a server error, a slow answer). Where it lands is crawled as a page of its own, so what is wrong with that page is on its route.
- **Unopened pages.** What only an opened page can show (its headers, console, accessibility, and the links and images it holds) is checked where a page was opened. It is trouble, not a pass, on a route whose link led to no page (a loop, an error status, a page that would not open).

## Tests

Each probe is tested against a small shop made in the test, with and without its fault. Those tests run in the pinned Playwright image.
