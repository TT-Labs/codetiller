---
title: Trust boundary
description: Agents are treated as untrusted. What an agent can reach, what it cannot, and how to measure both on your own host.
---

An agent reads text you do not control — issues, code, dependency sources, web pages quoted in either — and then runs commands. The factory therefore assumes that an agent may at any moment act against you, and is built so that this stays contained: no credential to steal, no way out for data, no way to pass its own checks by changing them.

This page describes what keeps that true. `tiller audit` measures it: see [Measure it](#measure-it).

## What an agent's container has

| | |
| --- | --- |
| The task's workspace | Writable. That is its job. |
| The prompt and skills | Read-only. |
| Installed dependencies | Read-only volumes. |
| Network | One address: the model gateway. |
| Credentials | None. Its "API key" is the name of its run, worth nothing outside the gateway. |
| User | Non-root, no capabilities, cannot gain privileges. |

It does not have: the model key, the GitHub token, the Docker socket or the cluster API, a route to the internet, outside DNS, or the factory's API.

## No credential, one way out

The agent's container joins a network with no route out and reaches only the **model gateway**.

The gateway forwards three things to the model API — creating messages, counting tokens, listing models — and adds the API key itself. It refuses everything else:

- other hosts and `CONNECT` tunnels,
- other endpoints of the model API (batches, files, admin),
- tools the model API would run on its own servers: web fetch, web search, remote MCP. Each would be a way out through the model API.

The key the agent holds is a random name for its run. The gateway serves no key that is not an open run, so a leaked one is useless once the run ends.

## Model and budget

The model and the budget of a run are enforced in the gateway, not by the agent process.

The factory opens a run on the gateway with one model and the `budget_usd` of the task's config. The gateway forwards only that model, counts the spend from the model API's answers at the [configured prices](configuration.md#prices), and refuses further calls once the budget is spent. The run then ends as `budget`.

One request may cross the budget, by its own cost at most; requests beside it wait. The cost stored for a run is the gateway's count. The agent's own figure is kept in the manifest for comparison.

Runs are opened and closed by the factory only. An agent cannot open a run or raise a budget.

## Dependency installs

Installing dependencies runs code the agent may have chosen: install scripts, a lockfile it edited. An install therefore runs in its own container, on a second closed network, and sees only the **registry proxy**.

The proxy allows `GET` and `HEAD` to the configured registries — the npm registry, the Go module proxy, PyPI — and nothing else:

- no credentials are passed on,
- no writes: publishing a package would be a way out,
- no other host. Tarball addresses in package metadata are pointed back at the proxy.

The agent's own container has no access to the registries. It works with the dependencies the install produced, mounted read-only.

## Verification runs offline

Tests run the agent's code. The verification container has no network at all and no model key. See [Verification](verification.md).

## Git and GitHub

- **The host never runs git inside a directory the agent wrote.** A repository's git configuration and hooks can execute commands; the factory commits the agent's work from a git directory the agent cannot reach.
- **The GitHub token stays with the factory.** Git talks to GitHub with a header that is sent to `github.com` only.
- **Instructions come from git, not from the workspace.** Repository skills and `.factory/factory.yaml` are read at the commit the task started from. An agent cannot edit the sandbox it runs in or the instructions it was given.
- **Only maintainers reach the agent.** A `/tiller` comment queues a run only when its author is the repository's owner, an organization member or a collaborator.

## Text the agent writes

Data can leave without a network connection from the sandbox: through text that makes somebody else's software fetch a URL.

- Before agent text is posted to GitHub, images, raw HTML, mentions and issue references are neutralized.
- The factory's UI does not fetch images named in agent text.

## The factory's own API

The API needs a token for every call, reads included: transcripts and diffs are your repository's code. The server answers only to the hosts it was told about. The token is in a file only the factory's user can read and is never mounted into a container. See [Operations](operations.md#the-ui-link-and-its-token).

## On Kubernetes

The same boundary, built from cluster objects: NetworkPolicies in place of Docker networks, a Role limited to pods of one namespace, the `restricted` Pod Security Standard, and the model key in the gateway's pod alone. One difference matters: a new pod can have the open network for a moment before its policy applies, so every sandbox pod proves it is isolated before it runs anything. See [Install on Kubernetes](install-kubernetes.md#how-it-is-locked-down).

## Measure it

```bash
tiller audit
```

The audit starts an agent container, a dependency-install container and a verification container exactly as the factory configures them, and runs probes inside each. It makes no model call. It exits with code 1 on a failed probe.

Some of what it checks, per container:

| Probe | Expected |
| --- | --- |
| `egress_https`, `egress_ip` | No route to the internet, by name or by IP. |
| `dns` | No outside DNS, which would be a channel for data. |
| `host_api` | The factory's API on the host cannot be reached. |
| `docker_socket` | Absent. |
| `kube_token`, `kube_api` | No service account token; the cluster API cannot be reached. |
| `secret_env` | No token or secret in the environment. |
| `uid`, `caps`, `no_new_privs` | Not root, no capabilities, cannot gain privileges. |
| `model_key` | The agent holds no model key. |
| `gateway_proxy`, `gateway_tunnel`, `gateway_path` | The gateway serves the model API only. |
| `gateway_server_tool` | The gateway refuses server-side web tools. |
| `gateway_model`, `gateway_admin`, `gateway_no_run` | Only the run's model; no opening of runs or raising of budgets; no key that is not an open run. |
| `registry_read`, `registry_write`, `registry_other` | The install container can read the registries, cannot write, and reaches no other registry. |
| `write_prompt`, `write_workspace` | The prompt is read-only; the workspace is writable. |

Run it on every host. Container networking differs between hosts, and a boundary that held on one machine is not evidence for another.

## Known open

The boundary is described here as it is, including where it is not closed.

- **Verification still runs the agent's code** and reads a test report from a place that code can write. What is closed is each way found so far — removed tests, changed configuration, a rewritten report — not the whole class. Read the verdict's list of changed check files when it is not empty.
- **A restarted gateway forgets its open runs.** They are refused from then on and end as failed.
- **The factory is trusted.** On a Docker host it holds the Docker socket, which is root on that host. Give it a machine of its own.
- **On Kubernetes there is no limit on processes per pod**, and the network check costs each pod about two seconds.
- **`TILLER_EGRESS=direct`** turns the gateway and the registry proxy off. It exists for debugging and must not be set on a real installation.
- **The model provider sees what the agent sends.** The task, the code the agent reads and its conversation go to the model API. The boundary is about where else they can go.
