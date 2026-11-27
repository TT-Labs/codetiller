---
title: Quickstart
description: Run the factory from a clone on your machine, onboard a repository and take one task to a draft pull request.
---

This page runs codetiller from its source on your own machine, with Docker for the sandboxes. It is the fastest way to see a task go through the factory. For a team, install it [on a server](install-docker.md) or [on Kubernetes](install-kubernetes.md).

## Before you start

- Node.js 22 or newer, pnpm and git.
- Docker, running. On macOS a Docker VM such as Docker Desktop or Colima works.
- An Anthropic API key. Use a dedicated key with a spend limit: agent runs cost money.
- A GitHub token for the repositories you want the factory to work on: a fine-grained personal access token limited to those repositories with `Contents: read and write`, `Pull requests: read and write` and `Issues: read`. Add `Checks: read`, `Commit statuses: read` and `Actions: read` if the factory should follow the repository's CI.

> [!WARNING]
> **Use a repository you can experiment on**
>
> The factory pushes branches and opens draft pull requests. Start with a test repository, not one where a stray pull request is a problem.

## 1. Clone and build

```bash
git clone https://github.com/TT-Labs/codetiller && cd codetiller
pnpm install
pnpm build
```

`pnpm build` compiles the packages, including the web UI. The clone is also the working directory: the database, run transcripts, repositories and task workspaces live in it, ignored by git.

## 2. Add the credentials

Create a file named `.env` in the clone, readable by you only. It is ignored by git.

```bash
ANTHROPIC_API_KEY=...
TILLER_GITHUB_TOKEN=...
```

```bash
chmod 600 .env
```

These stay with the factory. The agent never receives either of them: see [Trust boundary](trust-boundary.md).

## 3. Prepare the sandbox image and check the machine

```bash
pnpm tiller setup
```

`setup` builds the sandbox image `codetiller/base:dev` from `images/base` when it is missing. The image holds Node (npm, pnpm, yarn, bun), Go, Python (venv, pip, uv) and the agent's command line tool, and is a few gigabytes. It then runs `tiller doctor`, which measures what a task needs: Docker answers, the image is there, a container sees a workspace where the factory put it, the credentials are set.

```text
ok   docker         daemon 29.1.3 linux/amd64
ok   git            git version 2.51.0
ok   sandbox image  codetiller/base:dev (3f9a1c2b7d10)
ok   workspaces     /home/you/codetiller: the same files for tiller and a container, written by both
ok   database       schema version 1
ok   disk           212.4 GB free in /home/you/codetiller
ok   model key      ANTHROPIC_API_KEY is set
ok   forge token    TILLER_GITHUB_TOKEN is set

ready
```

A check that fails says what to do about it. On macOS the usual one is `workspaces`: the Docker VM has to share the working directory with your machine, which Docker Desktop and Colima do for directories under your home.

## 4. Onboard a repository

```bash
pnpm tiller repo add acme/shop
```

Onboarding looks at the repository, proposes how to install its dependencies and run its tests, and then proves the proposal by running it: one install and every test suite once, at the default branch. It prints a `.factory/factory.yaml` for you to commit to the repository. Until that file is merged the factory uses its own copy, so you can go on right away. Details: [Add a repository](repositories.md).

The command exits with code 2 when the proposed profile does not run.

## 5. Start the factory

```bash
pnpm tiller ui
```

This starts the API, the web UI and the worker that executes queued runs, and prints a link:

```text
tiller ui → http://127.0.0.1:4317/?token=…
```

Open the link. It carries the API token once; the page keeps it and removes it from the address. Leave the command running.

## 6. Create a task and queue a run

In a second terminal, in the clone:

```bash
pnpm tiller task create --repo acme/shop \
  --title "Reject empty product names" \
  --body "POST /products accepts an empty name. Return 400 and add a test."
pnpm tiller task enqueue T-1
```

Creating a task starts nothing. `enqueue` is the human decision to spend money on a run. You can do both from the UI as well.

What happens next, visible on the task's page:

1. **Preflight.** A read-only agent estimates the files and concepts the work touches. Too large or unclear: the task stops at `WAITING_FOR_HUMAN` with the report.
2. **Run.** The agent works in a container on the task's workspace and ends with a summary or with questions.
3. **Verification.** The factory runs the tests and checks on a clean copy of the commit.
4. **Draft pull request.** A verified branch is pushed and a draft pull request is opened. The task is now `PR_OPEN`.

## 7. Review

Review the pull request as you would any other. To send the agent back to work, write a comment that starts with `/tiller`:

```text
/tiller the 400 response should use the shared error format in src/errors.ts
```

The factory queues a run with that text, the agent continues its session, the factory verifies again and pushes to the same pull request. Merging the pull request completes the task. More: [Pull requests](pull-requests.md).

## How commands are written in these docs

The rest of the docs write `tiller …`. How that is typed depends on the installation:

| Installation | Command |
| --- | --- |
| From a clone | `pnpm tiller …` |
| Docker on a server | `docker compose -f deploy/compose.yaml exec tiller tiller …` |
| Kubernetes | `kubectl -n tiller exec deploy/tiller -- tiller …` |
