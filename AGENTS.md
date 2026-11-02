# owndapp development instructions

Read README.md and CONTRIBUTING.md before making changes. Follow docs/reference/dependency-policy.md for dependency changes.

Documentation has three audiences; keep them apart:
- docs/manual/ and README.md are for people using owndapp. Task-based steps, about one screen per page, words that match the UI. Change them only when what a user does or sees changes, and never add conditions, limits or edge cases there; link to the reference instead. The in-app guide (src/UsageGuide.tsx) is a summary of the manual.
- docs/reference/ is for developers and AI agents: current behavior, detection and check rules, limits, data model, operations and verification. Update it whenever behavior changes.
- docs/design/ keeps past plans and release records as written. Do not rewrite history there; record new decisions in the reference instead.

- Keep install lifecycle scripts disabled. Do not use npm audit fix --force.
- Use generated fixtures and a separate catalog for testing. Never inspect or send a contributor's real project data without explicit authorization.
- Preserve the loopback-only API, source-read boundaries and confirmation before external vulnerability queries.
- Do not add automatic package updates, project scripts, source deletion or cloud changes.
- For UI work, read .ui-craft/brief.md and .ui-craft/tokens.md, and preserve the existing components and tokens. Use ui-craft if it is installed in your environment.
- Distinguish macOS verification, simulated Windows coverage and actual Windows runner/manual results.
- Do not push, publish a release or change GitHub settings without authorization.
