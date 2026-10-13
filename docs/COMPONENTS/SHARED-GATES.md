# Shared gates

One rule for both public repositories, out of the app repository's reach. Part of the [GitHub plane](README.md#github-plane).

- **v1:** reusable workflows in this repository, called from the app's repository at a pinned commit:
  - the title check;
  - CodeQL;
  - Scorecard;
  - the app's gates (`app-gates.yml`).

The app's gates take their scripts from this repository at that commit (`apps/factory/src/gates`, Node with no dependencies, from a sparse checkout), and the probes and crawler from the `factory-browser` image the local profile pins. What they check is in the [CI pipeline](CI-PIPELINE.md), [test integrity](TEST-INTEGRITY.md) and [security scanning](SECURITY-SCANNING.md).
