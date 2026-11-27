# Common sandbox base: the agent CLI, the general-purpose tools agents reach for, and the
# toolchains a repository can be onboarded with without an image of its own: Node (npm, pnpm,
# yarn, bun), Go and Python (venv, pip, uv). A repository that needs more extends it
# (`.factory/Dockerfile`, or images/<repo> here).
#   docker build -t codetiller/base:dev images/base
# Released as ghcr.io/tt-labs/codetiller-base (.github/workflows/release.yml).
FROM golang:1.27-bookworm AS go

FROM node:24-bookworm-slim

ARG PNPM_VERSION=12.16.1
# pinned: a rebuild must not silently change the agent
ARG CLAUDE_CODE_VERSION=2.1.325

# Toolbox chosen from run transcripts (`tiller tools`): python3 was missing in 70% of 510 runs and
# agents lost turns falling back to sed; procps (pgrep, uptime) showed up too. The rest is what
# agents use for searching, patching and scripting.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates python3 python3-venv python3-pip ripgrep jq curl procps patch make unzip less file \
  && rm -rf /var/lib/apt/lists/*
# yarn (classic) ships with the node image; a repository on yarn berry carries its own release
RUN npm install -g pnpm@${PNPM_VERSION} bun @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && pip install --no-cache-dir --break-system-packages uv
COPY --from=go /usr/local/go /usr/local/go

# non-root (uid 1000 = node). Store dir pre-created so the named volume inherits ownership.
RUN git config --system --add safe.directory "*"
USER node
# cache and dependency dirs pre-created: named volumes mounted there inherit the ownership
RUN mkdir -p /home/node/.pnpm-store /home/node/.cache/uv /home/node/.cache/pip /home/node/go/pkg/mod \
    /home/node/.bun/install/cache
# Go: build cache in /tmp (the workspace and the dependency volumes stay free of build output);
# GOTOOLCHAIN=local: never download another toolchain (agents and verification are offline).
ENV npm_config_store_dir=/home/node/.pnpm-store \
    npm_config_package_import_method=copy \
    npm_config_verify_deps_before_run=false \
    PATH=/usr/local/go/bin:$PATH \
    GOTOOLCHAIN=local \
    GOCACHE=/tmp/go-build \
    GOMODCACHE=/home/node/go/pkg/mod \
    GOFLAGS=-buildvcs=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_NO_PROGRESS=1 \
    CI=true
WORKDIR /workspace
