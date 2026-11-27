---
title: Concepts
description: The few terms the rest of the docs rely on — task, run, states, workspace, sandbox, verification, manifest.
---

## Task and run

A **task** is a piece of work: a title, a description, a repository. It comes from a GitHub issue or from `tiller task create`, and it is identified as `T-1`, `T-2`, and so on.

A **run** is one execution of the agent on a task. A task usually has several: the first attempt, then one for each answer or review comment a human sends back. A task survives its runs. It keeps its workspace, its branch, its pull request and the agent's session, so a follow-up run continues where the last one stopped instead of starting over.

This split is the main idea of the factory. Questions, answers and review are part of the task, not failures of a run.

## Who decides what

- **A human queues every run.** Importing an issue creates a task and stops. `tiller task enqueue`, the button in the UI, or a `/tiller` comment on the task's pull request is the human saying "work on this now".
- **The factory decides whether a change is verified.** The agent saying it is done is the start of verification, not the result.
- **A human merges.** The factory opens draft pull requests and never merges one.

One exception to the first rule is opt-in: with `factory.ci.fix: auto` the factory may send a failing CI result back to the agent by itself, a limited number of times. See [Pull requests](pull-requests.md#the-repositorys-ci).

## States of a task

| State | Meaning |
| --- | --- |
| `IMPORTED` | Created, nothing queued. |
| `QUEUED` | A human asked for a run; the worker will pick it up. |
| `PREFLIGHT` | The read-only assessment before the first run is in progress. |
| `RUNNING` | The agent is working. |
| `WAITING_FOR_HUMAN` | The preflight stopped the task, or the agent asked a question. |
| `REVIEW` | The agent is done but nothing was pushed: there is no GitHub token, or verification failed. A human looks at it locally. |
| `PR_OPEN` | The verified commit is on the pull request. Review happens there. |
| `COMPLETED` | The pull request was merged, or a human completed the task. |
| `FAILED` | The last run ended in an error or a timeout. It can be queued again. |
| `CANCELLED` | The pull request was closed, or a human cancelled the task. |

A run can be queued from `IMPORTED`, `WAITING_FOR_HUMAN`, `REVIEW`, `PR_OPEN` and `FAILED`.

## Preflight

Before a task's first run, a read-only agent looks at the repository and estimates how many files and how many domain concepts the work touches, lists questions that block the work and, for a large task, proposes a split into parts. The factory compares the estimate with its limits and either lets the run start or stops at `WAITING_FOR_HUMAN`. A task is assessed once. See [Tasks](tasks.md#preflight).

## Sandbox

A **sandbox** is a container the factory starts for one job and removes afterwards: an agent run, a dependency install, a test run. On Kubernetes it is a pod. Sandboxes run as a non-root user, without capabilities, and on a network with no route out.

What a sandbox needs to know about a repository is its **profile**: which image to use, how dependencies are installed and where they live, how tests run and report. The profile lives in the repository as `.factory/factory.yaml`. See [Add a repository](repositories.md).

## Workspace

Each task has a persistent **workspace**: a checkout of the repository on the task's branch `tiller/<id>`, mounted into the agent's container. The factory commits after each run from a git directory the agent cannot reach, and never runs git inside a directory the agent could write to. The agent's own session state is kept next to the workspace, which is how a follow-up run resumes the conversation.

## Gateway and registry proxy

The agent's container can reach exactly one thing: the **model gateway**. The gateway forwards calls to the model API, adds the API key itself, allows only the model the run was started with and stops the run when its budget is spent.

A dependency install runs code the repository chose, so it gets a different single exit: the **registry proxy**, which lets it read from the configured package registries and nothing else.

Both are described in [Trust boundary](trust-boundary.md).

## Verification and baseline

After the agent says it is done, the factory **verifies** the commit: it exports a clean copy, installs nothing new, and runs the full test suite and the profile's checks in a fresh container without network.

The **baseline** is the same suite run at the commit the task started from. Only tests that passed at the baseline count, so a test that was already broken is not held against the change — and a test that passed at the baseline and no longer runs is a failure. See [Verification](verification.md).

## Skills and configs

A **skill** is a markdown document with instructions that is put into the agent's context: how this repository is built, what conventions it has. Skills come from the factory, from the repository and from the agent config. See [Skills](skills.md).

An **agent config** names the agent, the model, the skills, the prompt and the limits of a run (turns, time, budget). A task runs with one config; `default` ships as the default. See [Configuration](configuration.md#agent-configs).

## Manifest

Every run and every preflight writes a `manifest.json`: the repository commits, the factory's own commit, the config hash, the model, the limits, the image id, the hash of the prompt, each skill with its source and content hash, the human messages the run carried, and the result. `tiller task manifest <runId> --check` tells you whether a run could still be rebuilt from the same inputs.

## Worker

The **worker** is the part of the factory that executes queued runs, imports labelled issues and follows pull requests. One worker runs at a time: inside `tiller ui`, inside `tiller daemon` (the same without the UI), or in the foreground with `tiller task run`.
