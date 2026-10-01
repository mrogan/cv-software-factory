# Security

## Reporting a vulnerability

Please report it privately through GitHub: [open a private report](https://github.com/mrogan/cv-software-factory/security/advisories/new), or use the repository's **Security** tab, then **Report a vulnerability**. Don't open a public issue.

I'll acknowledge a report within five working days and keep you updated until it is resolved. This is a one-person project, so please allow reasonable time for a fix before disclosing publicly. I'm glad to credit you in the advisory.

## What counts

- Anything in this repository: the factory, its console, its workflows and its infrastructure code.
- **A way round a guardrail.** The factory's guardrails ([specification, section 6](docs/SPECIFICATION.md#6-guardrails)) are meant to hold by mechanism. If you can make an agent change the rules, ship an image the pipeline didn't build, reach production, or spend beyond a cap, that is a vulnerability, and the one I most want to hear about.

## What doesn't

- The defects in The World's Worst Website, the app the factory looks after. They are put there on purpose, for the factory to find. Report them through the site's own "Report a problem" widget and watch it fix them.
- Findings that need a compromised GitHub account or laptop belonging to the maintainer.

## Supported versions

Only the latest commit on `main` is supported.
