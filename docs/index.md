---
title: Introduction
description: codetiller runs coding agents the way CI runs builds — in sandboxes, with every change verified before a human sees a pull request.
---

codetiller is an open-source, self-hosted software factory for work done by AI coding agents: CI/CD for the code an agent writes. It sits between your issue tracker and the agent, and treats the agent as an untrusted worker: the agent gets a sandbox, a task and a model, and nothing else. The factory holds the credentials, checks the result and opens the pull request.

```text
issue → preflight → queue → sandbox + workspace → agent
      → verification → draft PR → human review → agent resumes on feedback → merge (human)
```

## What it does

- **Takes tasks from GitHub issues** (a label marks an issue for the factory) or from the command line.
- **Assesses a task before any code is written.** A read-only agent estimates the size of the work and lists blocking questions. Work that is too large or unclear stops and asks a human.
- **Runs the agent in a container with no credentials and no route to the internet.** Its only way out is a gateway that forwards calls to the model API and enforces the model and the budget of the run.
- **Verifies the result itself.** The full test suite and the repository's checks run on a clean copy of the commit, in a fresh container without network. A test that passed before the change and no longer runs fails verification.
- **Opens a draft pull request** for a verified change and continues the same agent session when a reviewer answers with a `/tiller` comment.
- **Records what every run was made of**: commits, model, prompt, skills, image, cost. Runs are data you can compare.
- **Measures changes to the factory itself.** A new skill or agent configuration is compared against the current one on a benchmark, with rerun noise taken into account, before it is enabled.

## What stays with humans

Only a human queues a run. Only a human merges. Importing an issue never starts work, and a comment on a pull request reaches the agent only when it comes from the repository's owner, a member of its organization or a collaborator.

## What you need

| | |
| --- | --- |
| Where it runs | One Linux machine with Docker, or a Kubernetes cluster. A laptop with Docker for trying it. |
| Agent | Claude Code, with an Anthropic API key. |
| Code host | GitHub. |
| Repositories | JavaScript and TypeScript (npm, pnpm, yarn, bun; vitest, jest, `node --test`), Go modules, Python (uv, pip; pytest). Several of them in one repository work. |
| License | Apache-2.0. The source is at [github.com/TT-Labs/codetiller](https://github.com/TT-Labs/codetiller). |

## Status

codetiller is early. The path from a task to a verified draft pull request works end to end on Docker and on Kubernetes, and each page of these docs ends with what is not built yet. The larger gaps today:

- Access to the UI is by one API token. Sign-in through GitHub and roles do not exist yet.
- The factory talks to GitHub with a personal access token. A GitHub App is planned.
- Tests that need a service (a database), private package registries and JVM projects are not covered.
- Claude Code is the only agent that runs. A Codex adapter exists as a stub.

## Where to start

- [Quickstart](quickstart.md): run the factory from a clone on your machine and take one task to a pull request.
- [Concepts](concepts.md): tasks, runs, states and who decides what.
- [Install on a Linux server](install-docker.md) or [on Kubernetes](install-kubernetes.md) for a team.
- [Trust boundary](trust-boundary.md): what an agent can and cannot reach, and how to measure it on your own host.
