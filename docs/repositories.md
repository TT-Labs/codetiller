---
title: Add a repository
description: Onboarding proposes how a repository is installed and tested, proves it by running it, and leaves you a file to commit.
---

Before the factory can work on a repository it needs to know three things: which image to run in, how dependencies are installed, and how the tests run and report. That knowledge is the repository's **sandbox profile**. Onboarding works it out for you.

## Onboard

```bash
tiller repo add acme/shop
```

The command:

1. **Looks at the repository** at its default branch. If it already has a `.factory/factory.yaml` with a `sandbox:` section, that is used as is.
2. **Otherwise proposes a profile** from what is in the repository: lockfiles, package manifests, test runners, checking scripts.
3. **Checks the profile by running it.** Dependencies are installed through the registry proxy, and every test suite runs once at the default branch. This is the baseline check.
4. **Prints the result** and, when the profile was proposed, the file to commit.

```text
acme/shop at 4be7c1d2
  · JS: pnpm (pnpm-lock.yaml), workspace with 1 packages
  · Go: module at apps/api
  · checks: typecheck (apps/web), go vet (apps/api)

baseline check
  default          103 tests, 0 failing at the base  (41 s)
  apps-api         32 tests, 0 failing at the base  (9 s)
  check typecheck (apps/web)   passes  (12 s)

proposed .factory/factory.yaml (commit it to the repository; until then the factory uses this copy):
```

The command exits with code 2 when the profile does not run: the install failed, or a suite wrote no report. The output shows the end of the failing command's log.

| Option | Meaning |
| --- | --- |
| `--config <name>` | The agent config tasks of this repository run with. Default `default`. |
| `--label <label>` | Open issues carrying this label are imported as tasks. Default `tiller`; `none` turns intake off. |
| `--no-check` | Do not install and run the tests. |

`tiller repo list` shows the onboarded repositories and how their last baseline check went. `tiller repo remove <owner/name>` forgets a repository; its tasks stay.

## What is recognised

| Stack | Package managers | Test runners |
| --- | --- | --- |
| JavaScript, TypeScript | npm, pnpm, yarn, bun | vitest, jest, `node --test` |
| Go | Go modules | `go test` |
| Python | uv (`uv.lock`), pip (`requirements.txt`), a `pyproject.toml` alone | pytest |

Several of them in one repository work: a web app next to a Go service becomes one profile with two suites. Checking scripts are picked up by name — the package scripts `typecheck`, `type-check`, `tsc` and `lint`, and `go vet` for Go modules.

Detection says what it could not work out instead of guessing. A JavaScript package without a lockfile, or one whose test runner is not recognised, is named in the notes, and you complete the file by hand.

## Commit the profile

The proposed file belongs in the repository, at `.factory/factory.yaml`. Until it is merged the factory uses its own copy, so tasks can start right away.

Keeping it in the repository matters for two reasons. The people who know the repository maintain it, in review, like any other file. And the factory reads it **from git at the commit a task started from**, never from the workspace the agent writes to: an agent cannot change the sandbox it runs in. A change to anything under `.factory/` is flagged in verification like any change to how a task is checked.

## The profile

```yaml
sandbox:
  toolchains:
    - lockfile: pnpm-lock.yaml
      setup: pnpm install --frozen-lockfile
      deps: [node_modules, apps/web/node_modules]
      test: cd apps/web && PATH="$PWD/node_modules/.bin:/workspace/node_modules/.bin:$PATH" vitest run --reporter=json --outputFile={{out}} {{files}}
      cache: { volume: tiller-pnpm-store, path: /home/node/.pnpm-store }
  parser: vitest-json
  suites:
    - name: apps-api
      lockfile: apps/api/go.mod
      setup: (cd apps/api && go mod download)
      deps: [/home/node/go/pkg/mod]
      test: cd apps/api && go test -json ./... > {{out}}
      parser: go-test-json
  checks:
    - name: typecheck (apps/web)
      run: cd apps/web && npm run --silent typecheck
    - name: go vet (apps/api)
      run: cd apps/api && go vet ./...

preflight:
  max_files: 20
```

| Key | Meaning |
| --- | --- |
| `image` | The image every sandbox of this repository runs in. |
| `toolchains` | Ways to install and test. The first one whose `lockfile` exists at the checked-out commit is used. |
| `toolchains[].lockfile` | Its content keys the dependency volumes: a changed lockfile is a new install. |
| `toolchains[].setup` | The install command. It runs in its own container, with access to the package registries through the proxy and to nothing else. |
| `toolchains[].deps` | Where installed dependencies live: paths in the workspace (`node_modules`, `.venv`) or absolute ones (Go's module cache). Each is a volume filled once by `setup` and mounted read-only into agent and test containers. Default `node_modules`. |
| `toolchains[].test` | The test command. `{{out}}` is the path the report must be written to; `{{files}}` is replaced by test files when only some are run. |
| `toolchains[].cache` | A volume for the package manager's cache, so a reinstall downloads little. |
| `parser` | The format of the report: `vitest-json`, `jest-json`, `go-test-json` or `junit-xml`. |
| `suites` | Further test commands, each with its own `parser`, and its own install when it has a `lockfile` and a `setup`. |
| `checks` | Commands that must exit 0 for a change to pass verification, beyond the tests: a type check, a linter, a build. |
| `sensitive_paths` | Regular expressions over changed paths: files of this repository that decide how a change is checked, on top of the built-in list. A change to one is flagged for review. |

The same file carries the repository's [preflight limits](tasks.md#limits-per-repository) under `preflight:`, and the directory `.factory/skills/` holds the repository's [skills](skills.md).

A report in JUnit XML is what most test runners can write, so a runner the detection does not know can usually be added by hand with `parser: junit-xml`.

## A repository's own image

`image` is optional. Without it the repository runs in the sandbox image of the factory, which has Node (npm, pnpm, yarn, bun), Go, Python (venv, pip, uv) and common tools. A repository that needs more — a system library, another runtime — can name its own image. Two conditions:

- The image must already be on the host (or pullable by the cluster on Kubernetes). The factory does not build it.
- It must contain the agent's command line tool. Derive it from `codetiller/base`.

`tiller tools` shows which commands agents tried and did not find, which tells you what an image is missing.

## Issue intake

With a GitHub token that can read issues, the factory imports open issues that carry the repository's label (`tiller` unless you chose another) as tasks, once each. Import never queues a run: the task appears as `IMPORTED` and waits for a human. See [Tasks](tasks.md#from-github-issues).

## Limits

- **Services for tests.** A suite that needs a database or another service next to it cannot run yet.
- **Private registries.** Installs read the public npm registry, the Go module proxy and PyPI through the proxy, without credentials.
- **JVM** projects (Maven, Gradle) are not recognised.
- **Building a repository's image** from a Dockerfile in the repository is not built; the image must exist.
- Only GitHub repositories.
