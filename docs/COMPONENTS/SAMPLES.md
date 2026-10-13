# Samples

What the console shows in development and in its tests, where there is no real work. Part of the [factory plane](README.md#factory-plane).

- **v1:** nineteen hand-written work items (`packages/samples`), typed against the events.

## What they cover

The last seven are fixes as the line makes them:

- rounds of review;
- a wait for Martin's merge;
- each kind of hold;
- a merge waiting for a release;
- a run on the local model.

Their screenshots are real: the app, with each sample's change made in a scratch copy.

## How they are kept

- Exported as an event log that `make check` keeps current.
- Checked against the answer key in the private repository.

The cluster's store holds real events (`make real-store`).
