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
