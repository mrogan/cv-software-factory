# Reviewing

Rules for reviewing a change to this repository, beyond what the gates check. Builders should not
be concerned with this as it applies to later in the SDLC. Review the diff, not the code around it.

1. **Deep modules.** A module hides a decision behind a small interface. Prefer fewer, deeper
   modules to layers that only pass calls through or rename them. (`gateway/gateway.ts`)
2. **Check at the boundary, trust inside.** What comes from outside (HTTP, a provider, the store,
   the environment) is parsed with Zod once, where it enters. Past that, the types are believed.
3. **Failures are typed.** An error a caller handles is a class with a kind, never matched on its
   message, and nothing is swallowed silently. (`gateway/errors.ts`)
4. **Collaborators come in.** A module is given its store, log, clock and HTTP client, so a test can
   pass fakes; only the entry points wire real ones. (`gateway/service.ts`)
5. **Test at the seams.** A seam is the public boundary you test at: the interface where you observe
   behavior without reaching inside. Tests live at seams, never against internals.
