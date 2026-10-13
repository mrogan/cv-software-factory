# The app

The World's Worst Website (spec 3). Part of the [runtime plane](README.md#runtime-plane).

- **v1:** TypeScript on Node, pages rendered on the server, no framework.
- **Catalogue:** SQLite (`node:sqlite`), built into the image and read-only.
- **Versions:** one between releases; during one, its canary beside it, each with the catalogue its own image holds ([progressive delivery](PROGRESSIVE-DELIVERY.md)).
