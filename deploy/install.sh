#!/bin/sh
# Install or upgrade tiller on a Linux docker host: build the factory image, prepare its working
# dir, start it, build the sandbox image, check the installation. Safe to run again.
#   TILLER_HOME   working dir on the host (default /var/lib/tiller)
#   TILLER_PORT   port on the host (default 4317)
#   TILLER_URL    address people open the UI at (default http://127.0.0.1:$TILLER_PORT)
#   TILLER_BIND   address the port is published on (default 127.0.0.1)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
home=${TILLER_HOME:-/var/lib/tiller}
port=${TILLER_PORT:-4317}
url=${TILLER_URL:-http://127.0.0.1:$port}
bind=${TILLER_BIND:-127.0.0.1}
image=${TILLER_IMAGE:-codetiller/factory:dev}

case "$home" in /*) ;; *) echo "TILLER_HOME must be an absolute path: $home" >&2; exit 1 ;; esac
docker version >/dev/null || { echo "docker does not answer" >&2; exit 1; }
docker compose version >/dev/null || { echo "docker compose (v2) is needed" >&2; exit 1; }

echo "== factory image ($image)"
docker build -t "$image" -f "$here/../images/factory/Dockerfile" "$here/.."

# Everything on the docker host is done through the daemon, so this also works against a remote
# one. The working dir belongs to uid 1000, the user of tiller and of every sandbox container.
as_root() { docker run --rm --user 0 --entrypoint sh "$@"; }
echo "== working dir ($home)"
as_root -v "$(dirname "$home"):/parent" "$image" -c '
  set -e
  dir="/parent/$1"
  mkdir -p "$dir"
  chown 1000:1000 "$dir"
  chmod 750 "$dir"
  if [ ! -e "$dir/.env" ]; then
    printf "%s\n" "# secrets of the factory; never given to an agent" "ANTHROPIC_API_KEY=" "TILLER_GITHUB_TOKEN=" > "$dir/.env"
    chown 1000:1000 "$dir/.env"
    chmod 600 "$dir/.env"
    echo "created $1/.env: put the model key and the GitHub token into it"
  fi' sh "$(basename "$home")"
gid=$(as_root -v /var/run/docker.sock:/docker.sock "$image" -c 'stat -c %g /docker.sock')

cat > "$here/.env" <<VARS
TILLER_HOME=$home
TILLER_PORT=$port
TILLER_URL=$url
TILLER_BIND=$bind
TILLER_IMAGE=$image
DOCKER_GID=$gid
VARS

echo "== start"
docker compose -f "$here/compose.yaml" up -d --no-build
echo "== sandbox image and checks"
docker compose -f "$here/compose.yaml" exec -T tiller tiller setup || true
echo
echo "secrets:  $home/.env on the docker host (then: docker compose -f $here/compose.yaml restart)"
echo "the link: docker compose -f $here/compose.yaml logs tiller | grep 'tiller ui'"
