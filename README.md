# codetiller

CI/CD for work done by AI coding agents. codetiller sits between your issue tracker and an existing coding
agent, and treats the agent as an untrusted, sandboxed worker:

```text
issue → preflight → queue → ephemeral container + persistent workspace → agent
→ verification in a fresh container → draft PR → human review → agent resumes on feedback → merge (human)
```

- A task is not a run: a task survives many runs, questions and review rounds.
- The factory owns every credential. The agent container reaches one thing, a model gateway that adds the
  API key, counts the spend and enforces the budget.
- "Done" is decided by plain code: the repository's tests and checks, run in a container the agent never
  touched.
- Every run is eval data, and a change to a skill or a config ships only with a measured comparison.

Documentation: [`site/content/docs/en`](site/content/docs/en) (published at https://codetiller.ai/docs).
Start with [quickstart](site/content/docs/en/quickstart.mdx) and [concepts](site/content/docs/en/concepts.mdx).

## Status

Young. The core path is tested end to end; the second list is what a team should know before adopting it.

Works today:

- A task from issue to draft pull request, with Claude Code
- GitHub: issue intake, review comments, following the repository's CI
- JS/TS, Go and Python repositories, onboarded with one command
- Docker on Linux, and Kubernetes on one node
- Benchmarks, paired comparison and the eval gate
- Dashboard: tasks, timelines, transcripts, diffs, metrics

Not built yet:

- Sign-in and roles: access is by one API token
- A GitHub App identity: a personal access token today
- Other agents: Codex, OpenCode, local models
- Published images and a Helm chart
- Runs spread over several cluster nodes
- Services for tests (databases), private registries, JVM
- Skills shared across an organization

## Install

One Linux machine with docker and `docker compose` v2:

```bash
git clone https://github.com/TT-Labs/codetiller && cd codetiller
deploy/install.sh        # TILLER_HOME=/var/lib/tiller TILLER_PORT=4317 TILLER_URL=https://tiller.example.com
# put ANTHROPIC_API_KEY and TILLER_GITHUB_TOKEN into $TILLER_HOME/.env, then:
docker compose -f deploy/compose.yaml restart
docker compose -f deploy/compose.yaml exec tiller tiller doctor
docker compose -f deploy/compose.yaml exec tiller tiller repo add <owner/name>
```

The factory's container holds the docker socket, which is root on that host: give it a machine of its own.
Details: [Docker](site/content/docs/en/install-docker.mdx),
[Kubernetes](site/content/docs/en/install-kubernetes.mdx),
[trust boundary](site/content/docs/en/trust-boundary.mdx).

## Layout

```text
packages/core     engine: factory (tasks, runs, pull requests), sandbox, verification, store, evals
packages/cli      the `tiller` CLI
packages/server   HTTP API (Hono) over the store and run artifacts
packages/web      dashboard (React + Vite)
images/base       sandbox image: agent CLI, Node, Go, Python
images/gateway    model gateway and registry proxy (plain Node, no dependencies)
images/factory    the factory itself as an image
deploy/           compose file and install script; deploy/kubernetes = manifests
defaults/         what an installation starts with: agent configs, prompt templates, skills,
                  and tiller.example.yaml to copy into a working dir
site/             codetiller.ai: landing page and docs (Next.js, its own pnpm root)
```

Benchmark datasets and the evidence of past comparisons live in a separate repository,
`codetiller-benchmarks`.

## Development

Node ≥ 22, pnpm, Docker.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm tiller --help       # the CLI from source
```

Agent runs need `ANTHROPIC_API_KEY`: use a dedicated key with a spend limit. See
[CONTRIBUTING.md](CONTRIBUTING.md); security reports go through [SECURITY.md](SECURITY.md).

## License

Apache-2.0. Third-party material: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
