---
title: How codetiller compares
description: What codetiller adds to a coding agent in a terminal, to hosted coding agents and to plain CI, and when one of those is the better choice.
---

codetiller does not replace a coding agent, and it does not replace CI. It is the layer between a task and a pull request that decides where an agent runs, what it can reach and whether its result counts as done.

## At a glance

| | Agent in a terminal | Hosted coding agent | Plain CI | codetiller |
| --- | --- | --- | --- | --- |
| Where the agent runs | Your machine | The vendor's cloud | Not at all | Your server or cluster |
| What the agent can reach | Your credentials and network | What the vendor's sandbox allows | Nothing to reach | One model gateway, nothing else |
| Who says the work is done | The agent | The agent, then your CI | Your tests | The factory: your tests on a clean copy, against the base commit |
| Result | Changes in your checkout | A pull request | A status on a commit | A draft pull request with the verification verdict |
| Record of a run | The terminal scrollback | The vendor's log | Build logs | A manifest: commits, model, prompt, skills, image, cost |
| Changing how the agent works | Edit a prompt and hope | Vendor settings | Not applicable | A skill or config change measured on a benchmark first |

## Compared with a coding agent in your terminal

An interactive agent is the right tool when you are in the loop: you watch, steer and decide when to stop. It works with your credentials on your network, and nothing checks its claim that it is finished.

codetiller is for work you hand off. The agent runs in a container with no credentials and no route to the internet, a task survives several runs and review rounds, and "done" is decided by the repository's tests in a fresh container. Use the terminal for work you want to steer and codetiller for the queue of well-described issues.

## Compared with hosted coding agents

A hosted agent runs in the vendor's cloud with access the vendor's integration was granted, and it is ready without any setup. That is the faster start.

codetiller runs on your infrastructure. Code leaves it only for the model API, the factory holds every credential, and you can probe the boundary yourself with `tiller audit`. You operate it: one machine or one namespace, an upgrade now and then. Choose it when where code runs and what the agent can reach must be yours to decide and to verify.

## Compared with plain CI

CI checks a commit somebody pushed. It does not produce the commit, and it runs whatever the commit says: a change that deletes a failing test turns CI green.

codetiller produces the commit and then verifies it against the state before the change. A test that passed at the base commit and no longer runs fails verification, and a change to the files that decide how checks run is flagged for a human. The repository's own CI still runs on the pull request; the factory reads its result and can hand a failure back to the agent. See [Verification](verification.md).

## When codetiller is not the right choice

- You want an assistant while you write code. Use an interactive agent.
- You cannot run a Linux machine with Docker or a Kubernetes cluster.
- Your tests need services such as a database, a private package registry, or a JVM toolchain. These are not covered yet.
- You need sign-in and roles today. Access is by one API token.
- Your code host is not GitHub.
