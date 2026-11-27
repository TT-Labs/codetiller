---
title: FAQ
description: Short answers about what codetiller is, what it needs, what it costs, how it keeps agents away from your credentials, and what it does not do yet.
faq: true
---

## What is codetiller?

codetiller is an open-source, self-hosted software factory: CI/CD for work done by AI coding agents. It takes a task from a GitHub issue, runs a coding agent on it in a sandbox that holds none of your credentials, verifies the result in a fresh container and opens a draft pull request. A human decides what runs and what merges.

## How is it different from running a coding agent myself?

An agent in your terminal works with your credentials, on your network, and decides by itself when it is done. In codetiller the agent is an untrusted worker: it gets a container without credentials and without a route to the internet, and the factory decides whether the change is verified by running the repository's tests on a clean copy of the commit. See [How codetiller compares](comparison.md).

## Which coding agents does it run?

Claude Code, with an Anthropic API key. The agent sits behind an adapter and transcripts are stored in a harness-neutral form. Codex and OpenCode are planned and not built.

## Which languages and repositories work?

JavaScript and TypeScript (npm, pnpm, yarn, bun; vitest, jest, `node --test`), Go modules and Python (uv, pip; pytest), also several of them in one repository. Tests that need a service such as a database, private package registries and JVM projects are not covered yet. See [Add a repository](repositories.md).

## Where does it run?

On one Linux machine with Docker, or in one namespace of a Kubernetes cluster. A laptop with Docker is enough to try it. Nothing is hosted for you: the factory, its database and the code stay on your infrastructure. See [Install on a Linux server](install-docker.md) and [Install on Kubernetes](install-kubernetes.md).

## Where does my code go?

Nowhere new. Code reaches the model API through the gateway, as it does when an engineer uses the agent, and no other host. The agent's container has no other route out.

## Can the agent read my API key or GitHub token?

No. The model API key lives only in the model gateway, which adds it to the calls it forwards. The GitHub token stays in the factory, which pushes branches and opens pull requests itself. `tiller audit` probes this from inside the containers on your own host. See [Trust boundary](trust-boundary.md).

## How does it know a change is correct?

It does not claim that; it verifies what can be measured. The full test suite and the repository's checks run on a clean export of the commit, in a fresh container without network, and are compared with the same suite at the task's base commit. A test that passed before and no longer runs fails verification, so deleting a test does not pass. The diff is still what a human reviews. See [Verification](verification.md).

## Does it merge pull requests?

No. It opens draft pull requests. Queuing a run and merging are human actions.

## How do I give the agent feedback?

Comment on the task's pull request with a line that starts with `/tiller`, followed by the instructions. The same agent session continues with your message. Only comments from the repository's owner, members of its organization and collaborators reach the agent. See [Pull requests](pull-requests.md).

## What does a run cost?

What the model API charges for it, capped by the budget of the run (`budget_usd` in the agent config, 5 USD by default). The gateway counts the spend from the API's answers and stops the run at the budget. codetiller itself is free. See [Configuration](configuration.md#agent-configs).

## What happens when a task is too large or unclear?

Before the first run, a read-only agent estimates how many files and concepts the work touches and lists blocking questions. Over the limits, the task stops and waits for a human, who can answer, split it into the proposed parts, or run it anyway. See [Tasks](tasks.md#preflight).

## What does it need from GitHub?

A fine-grained personal access token limited to the repositories you add: `Contents` read and write, `Pull requests` read and write, `Issues` read, and read access to checks if the factory should follow the repository's CI. `tiller doctor` says what is missing, per repository. A GitHub App is planned.

## How do I improve how the agent works?

With skills: instructions the agent reads before it works, from the factory, the repository (`.factory/skills/`) or the agent config. A change to a skill or a config is compared against the current one on a benchmark of real past changes, with rerun noise taken into account, before it is enabled. See [Skills](skills.md) and [Evals](evals.md).

## Is it production-ready?

It is early. The path from a task to a verified draft pull request works end to end on Docker and on Kubernetes. Sign-in and roles, a GitHub App, published images and other agents are not built yet; every page of these docs ends with what is missing.

## How is it licensed?

Apache-2.0. The source is at [github.com/TT-Labs/codetiller](https://github.com/TT-Labs/codetiller); you run it yourself and pay only your model provider.
