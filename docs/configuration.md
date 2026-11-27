---
title: Configuration
description: The settings file of an installation, the environment variables the factory reads, and the agent configs tasks run with.
---

An installation is configured in three places:

- **`tiller.yaml`** in the working directory: how the factory behaves.
- **Environment variables**: secrets and where things run.
- **Agent configs** in `configs/`: which agent, model, skills and limits a task runs with.

What concerns one repository — its sandbox profile, its preflight limits, its skills — lives in that repository under `.factory/`. See [Add a repository](repositories.md).

A file in the working directory replaces the one of the same name that ships with the factory. This holds for `configs/<name>.yaml`, for the prompt templates under `prompts/` and for `skills/<name>/v<N>.md`. An installation without any of them runs on the shipped defaults, which are in the repository under `defaults/`; `tiller.example.yaml` there is a `tiller.yaml` to start from.

## tiller.yaml

Every key is optional. A complete example with the defaults:

```yaml
factory:
  # read-only assessment before a task's first run
  preflight: { enabled: true, max_files: 10, max_concepts: 3, tolerance: 0.2 }

  # factory skills every task gets, as name@N. Empty until one has passed the eval gate.
  skills: []

  # second reader of every verified change. Off unless enabled here.
  review: { enabled: false }

  # the repository's CI on a task's pull request: ask | auto | off
  ci: { fix: ask, max_attempts: 2 }

  # models a human may choose in the UI or with `tiller task model`
  models: [claude-sonnet-5-5, claude-opus-5-5, claude-haiku-5-5]

  # repositories whose sandbox profile lives in this working directory
  projects:
    - repo: acme/shop
      profile: shop          # datasets/shop/profile.yaml
      config: default     # configs/default.yaml
      label: tiller          # issues with this label are imported
      preflight: { max_files: 20 }

# USD per 1M tokens, per model id
prices: {}
```

### factory.preflight

The limits of the [preflight](tasks.md#preflight). `tolerance` is the share of a limit an estimate may exceed and still pass: with `0.2`, a limit of 10 files tolerates 12. A repository can override the limits in its own `.factory/factory.yaml`, which wins over everything here.

### factory.skills

Factory [skills](skills.md) every task receives, before the repository's own and the config's. Each entry is `<name>@<N>` for the file `skills/<name>/v<N>.md` in the working directory.

### factory.review

Turns on the [second reader](verification.md#second-reader): after a change passes verification, a read-only agent reads it against the task and reports what tests cannot say. It is advisory and costs one more agent call per verified change, on the task's model.

### factory.ci

What happens when the repository's CI fails on a task's pull request. `ask`: a human sends the failure to the agent. `auto`: the factory does, at most `max_attempts` times per task. `off`: CI is not read. See [Pull requests](pull-requests.md#the-repositorys-ci).

### factory.models

The models a human may choose as the default or for one task. Without this list no model is on offer and each task runs on the model of its agent config. A model must have a price, built in or under `prices`, to run.

### factory.projects

Repositories whose sandbox profile is kept in the factory's working directory (`datasets/<profile>/profile.yaml`) instead of in the repository. Most installations do not need this: `tiller repo add` onboards a repository without an entry here. An entry also sets the issue label and may carry preflight limits for that repository.

### prices

The model gateway counts what a run spends from the model API's answers, at these prices, and stops the run at its budget. The factory ships a list for the current Claude models. An entry here replaces one or adds a model:

```yaml
prices:
  claude-sonnet-5-5: { input: 2, output: 10, cache_read: 0.1, cache_write_5m: 2.5, cache_write_1h: 4 }
```

> [!NOTE]
> A model without a price cannot run behind the gateway. That is deliberate: a budget that cannot be counted cannot be enforced.

## Environment variables

On a Docker installation these go into `.env` in the working directory. On Kubernetes they come from the Secret `tiller-secrets` and the manifests. When both a real environment variable and `.env` set a name, the environment wins.

### Secrets

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | The model key. On Docker the factory passes it to the model gateway and to nothing else. On Kubernetes only the gateway's pod has it. |
| `TILLER_GITHUB_TOKEN` | The GitHub token: clone private repositories, push task branches, open pull requests, read issues and CI. Never given to a sandbox. Optional; without it nothing is pushed. |
| `TILLER_GATEWAY_ADMIN_TOKEN` | Kubernetes only. The secret the factory and the gateway share, at least 32 characters. |

Permissions the GitHub token needs, as a fine-grained personal access token limited to the repositories the factory works on:

| Permission | For |
| --- | --- |
| `Contents: read and write` | Cloning, pushing task branches. |
| `Pull requests: read and write` | Opening draft pull requests, reading and answering comments. |
| `Issues: read` | Importing labelled issues. |
| `Checks: read`, `Commit statuses: read` | Following the repository's CI. |
| `Actions: read` | The logs of failing CI jobs. |

### Where things run

| Variable | Default | Meaning |
| --- | --- | --- |
| `TILLER_SANDBOX` | unset (Docker) | `kubernetes`: sandboxes are pods of the cluster the factory runs in. Set by the manifests. |
| `TILLER_BASE_IMAGE` | `codetiller/base:dev` | The sandbox image for repositories that name none. |
| `TILLER_CLAIM` | `tiller-home` | Kubernetes: the PersistentVolumeClaim of the working directory. |
| `TILLER_GATEWAY_URL` | `http://tiller-gateway:8080` | Kubernetes: where the model gateway is. |
| `TILLER_REGISTRY_URL` | `http://tiller-registry:8081` | Kubernetes: where the registry proxy is. |

The Docker install script has its own settings (`TILLER_HOME`, `TILLER_PORT`, `TILLER_URL`, `TILLER_BIND`), described in [Install on a Linux server](install-docker.md#install).

### Debugging only

| Variable | Meaning |
| --- | --- |
| `TILLER_EGRESS=direct` | Turns the model gateway and the registry proxy off: the agent gets the model key in its environment, and agents and installs get an open network. |

> [!WARNING]
> **TILLER_EGRESS=direct removes the trust boundary**
>
> With it an agent holds your model key and can reach the internet. Never set it on an installation that works on real repositories.

## Agent configs

An agent config is a YAML file in `configs/`. A task runs with one; `default` is the default and ships with the factory.

```yaml
name: default
harness: claude-code
model: claude-sonnet-5-5
skills: []
prompt_template: prompts/default.md
limits: { max_turns: 60, timeout_s: 1200, budget_usd: 5 }
```

| Key | Meaning |
| --- | --- |
| `name` | The name tasks and commands refer to. |
| `harness` | The agent. `claude-code` is the one that runs. |
| `model` | The model, unless the task or the factory default says otherwise. |
| `skills` | Factory skills as `name@N`, rendered after the factory's and the repository's. |
| `prompt_template` | The prompt file. |
| `limits.max_turns` | The most turns the agent may take in one run. |
| `limits.timeout_s` | The longest a run may take. |
| `limits.budget_usd` | The most a run may spend. Enforced by the model gateway. |

A config can build on another with `extends`. Only what differs is written; limits merge key by key:

```yaml
name: opus
extends: default
model: claude-opus-5-5
```

### The config hash

Every config has a content hash over the fully resolved config (after `extends`) and the text of its prompt template. The name is not part of it. Runs record the hash, so two runs are comparable when their hashes match, whatever the files were called at the time.

```bash
tiller config add configs/shop-onboarding.yaml     # resolve it, print its hash
```

### Which config a task uses

A task created with `tiller task create` uses the config named with `--config`, `default` by default. A task imported from an issue uses the config set for its repository at onboarding (`tiller repo add --config`).

## Limits

- Settings are files and environment variables. The UI's settings page covers the default model; the rest is edited on disk and read at start.
- One model provider: the Anthropic API.
- The `codex` harness is accepted by the config schema and not implemented.
