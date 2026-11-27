# The factory itself: CLI, API, UI and the worker that runs queued tasks. It starts the sandbox
# containers on its host's docker daemon through the mounted socket (deploy/compose.yaml);
# agents never get that socket. Build from the repository root:
#   docker build -t codetiller/factory:dev -f images/factory/Dockerfile .
# Released as ghcr.io/tt-labs/codetiller-factory (.github/workflows/release.yml).

# compiled where the build runs: the output is the same for every platform
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
ARG PNPM_VERSION=12.16.1
RUN npm install -g pnpm@${PNPM_VERSION}
ENV CI=true
WORKDIR /opt/tiller
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm build && rm -rf node_modules packages/*/node_modules packages/*/src

# what runs needs no compiler, bundler or test runner; installed on the platform it runs on
# (better-sqlite3 is a native module)
FROM node:24-bookworm-slim AS prod
ARG PNPM_VERSION=12.16.1
RUN npm install -g pnpm@${PNPM_VERSION}
ENV CI=true
WORKDIR /opt/tiller
COPY --from=build /opt/tiller /opt/tiller
RUN pnpm install --frozen-lockfile --prod --filter "@codetiller/cli..."

# the docker CLI and its build plugin (static binaries); the daemon is the host's
FROM docker:29-cli AS docker

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=prod /opt/tiller /opt/tiller
# what the CLI finds next to itself: the gateway and proxy scripts, the Dockerfile of the sandbox
# base image (`tiller setup` builds it), the default agent configs, prompts and skills
COPY images/gateway /opt/tiller/images/gateway
COPY images/base /opt/tiller/images/base
COPY defaults /opt/tiller/defaults
RUN chmod +x /opt/tiller/packages/cli/dist/cli.js \
  && ln -s /opt/tiller/packages/cli/dist/cli.js /usr/local/bin/tiller
# set by a release: `tiller --version`, and the tag of the sandbox base image published with it
ARG TILLER_VERSION=
ENV NODE_ENV=production \
    TILLER_VERSION=${TILLER_VERSION}
# uid 1000, the user of every sandbox container: a workspace one of them writes, the other reads
USER node
ENTRYPOINT ["tiller"]
CMD ["ui", "--host", "0.0.0.0"]
