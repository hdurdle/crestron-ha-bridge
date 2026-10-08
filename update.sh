#!/usr/bin/env bash
#
# crestronproxy - update script
#
# Pulls the latest changes, rebuilds the image and restarts the container,
# then waits for the /status healthcheck to pass. Run on the docker host from
# anywhere; it operates on the repo it lives in.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

COMPOSE_FILE="crestronproxy-compose.yaml"
CONTAINER="crestronproxy"

# Prefer the compose plugin, fall back to the standalone binary
if docker compose version >/dev/null 2>&1; then
  DC="docker compose -f ${COMPOSE_FILE}"
else
  DC="docker-compose -f ${COMPOSE_FILE}"
fi

# The key is bind-mounted, not baked in. If it's missing, Docker creates an
# empty directory in its place and the SSH connection fails at startup.
if [ ! -f id_rsa ]; then
  echo "ERROR: id_rsa not found next to ${COMPOSE_FILE} (or it is a directory)." >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "WARNING: no .env file; the container will start with defaults only." >&2
fi

echo "== Pulling latest changes =="
# --ff-only: never create a merge commit; fails loudly if local commits
# have diverged from the remote instead of silently merging
git pull --ff-only

GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo "")"
if ! git diff --quiet HEAD 2>/dev/null; then
  GIT_COMMIT="${GIT_COMMIT}-dirty"
fi

echo "== Building and starting commit: ${GIT_COMMIT:-unknown} =="
$DC up -d --build

echo "== Waiting for container health =="
for i in $(seq 1 24); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "${CONTAINER}" 2>/dev/null || echo unknown)"
  if [ "$status" = "healthy" ]; then
    echo "Container healthy (commit ${GIT_COMMIT:-unknown})."
    exit 0
  fi
  sleep 5
done

echo "WARNING: container did not report healthy within 2 minutes." >&2
echo "Check logs with: $DC logs -f ${CONTAINER}" >&2
exit 1
