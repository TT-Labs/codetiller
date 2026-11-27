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

The documentation is the Markdown in `docs/`; codetiller.ai renders it from there.

## Rules of the codebase

- TypeScript, ESM (NodeNext): imports carry the `.js` suffix.
- Everything around the agent is deterministic, plain code: checkout, verification, scoring. A model
  never decides whether work is done.
- The agent is untrusted. It never sees credentials or hidden tests, and verification runs in a fresh
  container. A change that moves this boundary needs a probe in `tiller audit`.
- `packages/core/src/index.ts` is the package's public surface: named exports only, added when another
  package needs one.
- `packages/core/src/store/schema.ts` is generated from `schema.sql`; a test fails when they differ.
- The docs describe the product: a changed command, flag or limit changes its page in
  `docs/` in the same pull request. A new page is also listed in `docs/nav.json`.
- A change to a skill, a prompt or an agent config comes with a measured comparison (`tiller compare`,
  `tiller gate`).

## Pull requests

- One change per pull request, with tests for the behaviour it changes.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
- Your first pull request asks you to sign the [contributor licence agreement](CLA.md): a bot comments
  with the sentence to post, once, and it covers your later pull requests. You keep the copyright; the
  agreement lets the maintainer distribute your contribution, including under other licence terms.

## Releases

A tag `vX.Y.Z` on `main` is a release: `.github/workflows/release.yml` publishes the images
`ghcr.io/tt-labs/codetiller-factory` and `codetiller-base` (amd64 and arm64; tags `X.Y.Z`, `X.Y`, `latest`)
and a GitHub release with `install.sh` and `compose.yaml`. Started by hand, the workflow only builds.

## Security

Do not open a public issue for a vulnerability: see [SECURITY.md](SECURITY.md).
