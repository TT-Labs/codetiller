---
title: Verification
description: How the factory decides that a change is verified, and why removing or rewriting a check does not pass it.
---

When an agent says it is done, the factory does not take its word. It checks the commit itself, in conditions the agent did not control, and only a change that passes is pushed. This page describes what is checked and what the verdict means.

## What verification does

1. **A clean export.** The factory exports the commit from its own git directory. Nothing the agent left in its workspace outside the commit comes along.
2. **A fresh container, without network.** No model key, no route anywhere.
3. **The full test suite.** Every suite of the repository's [profile](repositories.md#the-profile), not only the tests the agent ran.
4. **The checks.** The profile's `checks`: a type check, a linter, a build.
5. **A comparison with the baseline.**

The result is `pass`, `fail` or `error`, with the reasons spelled out on the task and in the pull request.

## The baseline

The **baseline** is the same suite run at the commit the task started from. It is computed once per task and cached. It answers the question "what was true before this change", and it changes what counts:

- **Only tests that passed at the baseline count.** A test that already failed before the change is listed as known and not held against it.
- **A test that passed at the baseline must still run and pass.** This is the rule the next section is about.

When a task is [updated](pull-requests.md#when-the-default-branch-moves) to a newer default branch, the baseline is taken again at the new base.

## Removed tests fail verification

The simplest way to make a failing test pass is to delete it. So a test that passed at the baseline and no longer runs — deleted, skipped, or in a suite that stopped collecting — **fails verification like a failing test**. The verdict names the tests:

```text
verification failed

No longer run (passed before this change):
- src/cart.test.ts > applies a percentage discount
- src/cart.test.ts > rejects a negative quantity
```

Renames are told apart. A file that kept its number of tests lost none: its renamed tests are listed, not failed.

Sometimes removing a test is right — the behaviour it checked is gone on purpose. Only a human can say so:

```bash
tiller task verify T-1 --accept-removed
```

The button on the task does the same. The tests the last verification found removed may then go, and verification runs again.

## Changed files that decide the checks

A change can also alter how it is checked: a test configuration that excludes a directory, a package script that no longer runs the linter, a CI workflow, a custom reporter.

The factory keeps a list of such files and reports every changed one in the verdict, in the pull request and on the task:

- test runner configuration (vitest, jest, playwright, pytest, tox and others),
- `Makefile`, `justfile`, `Taskfile`,
- CI definitions (`.github/workflows`, `.github/actions`, GitLab, CircleCI, Jenkins),
- lint and type-check configuration (Biome, ESLint, golangci-lint, `tsconfig`),
- `package.json` files whose scripts changed,
- everything under `.factory/`,
- and the profile's own `sensitive_paths`.

```text
This change modifies how it is checked:
- vitest.config.ts
- package.json (scripts)
```

Listing is not enough when the suite itself reads the changed file. In that case **the suite runs a second time with those files as they were at the base commit**, and the change has to pass that run too. A reporter the change wrote cannot vouch for the change.

If the change to the checks is intended, a human accepts it:

```bash
tiller task verify T-1 --accept-checks
```

## A report is not the exit code

Tests run the agent's code, and that code can reach the file the test report is written to. It cannot set the exit code of the test runner. So a report that shows no failing test while the test command itself failed is an **error**, not a pass.

## Checks beyond the tests

The profile's `checks` run on the same clean export, offline.

- A check that fails now and passed at the base commit fails verification. The verdict shows the end of its output.
- A check that already fails at the base commit is not held against the change.

This is what your CI would otherwise be the first to say, said before anything is pushed. Checks that run only in your CI are followed [on the pull request](pull-requests.md#the-repositorys-ci).

## What the agent is told

When a human sends a task back after a failed verification, the agent is told what failed — the failing and removed tests, the failed checks — whatever the human wrote in the message. The human does not have to paste the verdict.

## Verify again without a run

```bash
tiller task verify T-1
```

Verifies the task branch as it is, without an agent run, and pushes when it passes. Useful after accepting removed tests or changed checks, or after an environment problem was fixed.

## Second reader

Tests cannot say everything. Code can satisfy a test without implementing the behaviour, and a change can pass every check and still be something a maintainer would not merge.

When enabled, a **second reader** runs after a change passes verification: a read-only agent, on a clean export of the commit, without editing tools, on the task's model. It reads the diff against the task and reports findings of two kinds:

- code that works on the checks instead of on the behaviour,
- what a maintainer would ask to change although the tests pass.

Each finding is either a `change` — the reader would not approve without it — or a `note`.

The second reader is **advisory**. Its findings are shown on the task and in the pull request and never block anything, because it is an agent reading text an agent wrote. Treat it as a reviewer's first pass, not as a gate.

```yaml
# tiller.yaml
factory:
  review: { enabled: true }
```

```bash
tiller task review T-1                          # run it on its own; nothing is recorded on the task
tiller task review T-1 --base <sha> --head <sha>
```

## Known open

Verification runs the agent's code and reads a report from where that code can write. What is closed is each way around it found so far — removed tests, a changed configuration, a rewritten report — not the class as a whole. Two habits cover the rest:

- Read the list of changed check files when a verdict has one.
- Review the pull request. Verification says the change did not break what was tested; it does not say the change is right.

## Limits

- Suites that need a service, such as a database, cannot run in verification yet.
- Verification is as good as the repository's tests. A repository with few tests gets weak verification, and the factory does not hide that: the verdict states how many tests ran.
