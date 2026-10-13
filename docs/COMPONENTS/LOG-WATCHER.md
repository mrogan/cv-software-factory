# Log watcher

The app's logs, read for what a query cannot say (`factory logs`). Part of the [runtime plane](README.md#runtime-plane).

- **v1:** three checks, each with its own cursor, reading Loki. Signals count as `factory_signals_total{sense}`.

## New error patterns

Error records are reduced to a pattern:

- numbers, identifiers, hashes, quoted values and the request's own path taken out;
- the exception the record attaches kept.

A pattern is signalled by route when the previous day has not shown it, with the lines and trace ids, and the spans when Tempo already has the trace. The evidence names the route that served the error, or the root when none did, never the request's own path.

## Reports

Each record of the widget becomes a `report` signal. The text goes to the inbox, and to no log line, metric label or error message.

## Agreement

Per route, it compares the requests counted in metrics, logged and traced, over two windows that ended minutes ago (Tempo answers late). The odd one out is `missing-log` or `wrong-metric`.
