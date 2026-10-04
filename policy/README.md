# Policy

The numbers that decide what the factory does, kept apart from the code that applies them: triage's routing
thresholds and the table from symptom class to category and severity, the app's objectives, which model each agent
uses, and the model spend caps. Each is a typed TypeScript file that the factory imports, so a value of the wrong
kind fails `make check`.

These are rules of the line (spec section 6, guardrail 1). `.github/CODEOWNERS` gives this folder to Martin, and
agents' credentials cannot change it.
