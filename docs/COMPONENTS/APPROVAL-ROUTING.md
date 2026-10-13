# Approval routing

Sends risky changes to a human. Part of the [GitHub plane](README.md#github-plane).

- **v1:** risk tags on the spec.
- **Later:** routing the other tags by autonomy level.

| Tag | Routing in v1 |
|---|---|
| `out-of-scope` (the fix changes behaviour beyond its ticket) | Holds the spec for Martin's approval before the coder starts, in every autonomy mode (`ALWAYS_HELD`, `line/machine.ts`; [holds](ORCHESTRATOR.md#holds-and-martins-answers)) |
| Test loosening | To route by autonomy level (spec 4.3), not built yet |
| Dependency change | As above |
| Security headers | As above |

The line runs Supervised, and every change waits for Martin's merge.
