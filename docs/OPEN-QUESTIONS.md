# Open questions

Questions not yet settled. When one is answered, update the spec (and write an ADR only for a major decision), then delete it from this list.

1. Monthly budget for hosting and models, which sets the caps.
2. How injector PRs appear in public history: under a clearly labelled bot identity (recommended, with sensing that never reads git) or under a normal developer identity.
3. How an injected defect is made visible within 5 minutes, given it goes through the full pipeline.
4. Whether TypeSafe shares one spend cap with the other providers or has its own (depends on question 1).
5. Whether the `aws` profile keeps using TypeSafe for triage or needs an alternative that stays inside AWS.
6. The console's frontend framework (needed by milestone 3). The station stays a custom element whichever is chosen; see `design/system/README.md`.
