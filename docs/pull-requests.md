---
title: Pull requests
description: What the factory pushes, how review comments reach the agent, and what happens when the default branch or CI moves under a pull request.
---

A verified change becomes a draft pull request. From then on, review happens on GitHub, the way your team already reviews. This page describes what the factory does around that pull request.

All of it needs `TILLER_GITHUB_TOKEN`. The token stays with the factory and is never given to an agent's container. Without a token nothing is pushed: finished tasks stop at `REVIEW`.

## The draft pull request

After a run passes [verification](verification.md), the factory pushes the task branch `tiller/<id>` and opens a draft pull request. Later runs of the same task push to the same pull request.

The pull request carries:

- the agent's summary of what it did,
- the verification verdict: how many tests ran, what failed or was removed, which changed files decide how the change is checked,
- the findings of the [second reader](verification.md#second-reader), when it is enabled,
- `Closes #N` when the task came from an issue.

Text written by the agent is neutralized before it is posted: images, raw HTML, mentions and issue references are removed, because each of them could carry data out or notify people.

The task's state tells you where the verified work is:

| State | Meaning |
| --- | --- |
| `PR_OPEN` | The verified head is on the pull request. |
| `REVIEW` | The agent is done but nothing was pushed: no token, or verification failed. |

## Sending work back with a comment

Write a comment on the pull request that starts with `/tiller`:

```text
/tiller keep the old endpoint working; add the new one next to it
```

That comment is you queuing a run with that text. It works in the conversation and inline on a line of the diff; an inline comment tells the agent which file and line it is about. A bare `/tiller` means "continue where you left off".

What happens:

1. The factory marks the comment with 👀. Each comment is used once.
2. The agent resumes its session with your text.
3. The factory verifies the result and pushes to the same pull request.
4. The factory replies on the pull request with the outcome — also when the agent has questions or the run failed.

The worker polls pull requests; `tiller task sync` does it now.

### Who may command the agent

Only a comment from the repository's **owner, a member of its organization or a collaborator** queues a run. Comments from anyone else never reach the agent, and neither does a `/tiller` that appears later in a comment instead of at its start.

> [!WARNING]
> **On public repositories**
>
> Anyone can comment on a public pull request. The rule above is what keeps a stranger's text out of the agent's context. Do not grant collaborator access to accounts you would not let queue paid runs.

## Merging and closing

Merging stays with you. The factory never merges.

- A merged pull request sets its task to `COMPLETED`.
- A closed pull request sets its task to `CANCELLED`.

## When the default branch moves

While a pull request is open, the default branch moves on. The sync marks the task as `behind` (the default branch has new commits) or `conflict` (they collide with the task's changes).

A human asks for the update — the button on the task, `tiller task update T-1`, or `/tiller update` on the pull request. The factory then merges the default branch into the task branch with its own git:

- **No collision:** the merged result is verified and pushed. No agent run, no model cost.
- **Conflicts, or tests that fail after a clean merge:** the agent resolves it in its next run, which is verified like any other.

From then on the task is measured against the new base.

## The repository's CI

The factory's verification runs before anything is pushed. Your repository's own CI runs after, on the pull request, and may check things the factory's profile does not. The factory follows it.

The sync reads what CI says about the commit on the task's pull request — check runs and commit statuses — and shows it on the task.

```bash
tiller task ci T-1          # what CI says
tiller task ci T-1 --fix    # send the failing checks and the end of their logs to the agent
```

A failure can go back to the agent in three ways: `tiller task ci <id> --fix`, the button on the task, or `/tiller ci` on the pull request. The agent gets the names of the failing checks and the end of the failing jobs' logs.

What the factory does on its own is a setting, `factory.ci` in `tiller.yaml`:

| `fix` | Behaviour |
| --- | --- |
| `ask` (default) | A failure is shown. A human sends it to the agent. |
| `auto` | The factory sends it itself, at most `max_attempts` times per task (default 2). |
| `off` | CI is not read. |

A failure is never sent twice for the same commit.

The token needs `Checks: read` and `Commit statuses: read`, and `Actions: read` for the job logs. Without them CI is not followed and the rest of the sync goes on. `tiller doctor` tells you per repository whether CI is readable.

## Limits

- GitHub only.
- The factory authenticates with a personal access token, so pull requests and comments appear under that token's account. A GitHub App with its own identity is planned.
- Pull requests are opened as drafts; marking one ready for review is up to you.
- Review comments reach the agent only through `/tiller`. A regular review without the command is for humans.
