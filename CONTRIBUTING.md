# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an issue first so the
approach can be agreed before the work.

## Setup

Node ≥ 22, pnpm, Docker.

```bash
pnpm install
pnpm test          # Vitest, tests sit next to the source (*.test.ts)
pnpm typecheck
pnpm lint          # Biome; `pnpm format` fixes what it can
```

The site (`site/`) is its own pnpm root: `cd site && pnpm install && pnpm dev`.

## Rules of the codebase

- TypeScript, ESM (NodeNext): imports carry the `.js` suffix.
- Everything around the agent is deterministic, plain code: checkout, verification, scoring. A model
  never decides whether work is done.
- The agent is untrusted. It never sees credentials or hidden tests, and verification runs in a fresh
  container. A change that moves this boundary needs a probe in `tiller audit`.
- `packages/core/src/store/schema.ts` is generated from `schema.sql`; a test fails when they differ.
- The docs describe the product: a changed command, flag or limit changes its page in
  `site/content/docs` in the same pull request.
- A change to a skill, a prompt or an agent config comes with a measured comparison (`tiller compare`,
  `tiller gate`).

## Pull requests

- One change per pull request, with tests for the behaviour it changes.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
- Contributions are accepted under the project's licence, Apache-2.0.

## Security

Do not open a public issue for a vulnerability: see [SECURITY.md](SECURITY.md).
