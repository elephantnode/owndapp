# owndapp development instructions

Read README.md and CONTRIBUTING.md before making changes. Follow docs/dependency-policy.md for dependency changes. User-facing documentation belongs in README.md and docs/usage.md; implementation details, limitations and verification belong under docs/.

- Keep install lifecycle scripts disabled. Do not use npm audit fix --force.
- Use generated fixtures and a separate catalog for testing. Never inspect or send a contributor's real project data without explicit authorization.
- Preserve the loopback-only API, source-read boundaries and confirmation before external vulnerability queries.
- Do not add automatic package updates, project scripts, source deletion or cloud changes.
- For UI work, read .ui-craft/brief.md and .ui-craft/tokens.md, and preserve the existing components and tokens. Use ui-craft if it is installed in your environment.
- Distinguish macOS verification, simulated Windows coverage and actual Windows runner/manual results.
- Do not push, publish a release or change GitHub settings without authorization.
