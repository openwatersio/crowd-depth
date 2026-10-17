#!/bin/sh
# Usage: ./docker.sh [command...]   Runs a command in the grid's image; default: the tests.
# The image is built on first use, tagged by the Dockerfile and lockfile it came from.
set -eu
cd "$(dirname "$0")"
tag="crowd-depth-grid:$(cat Dockerfile uv.lock | shasum | cut -c1-12)"
docker image inspect "$tag" >/dev/null 2>&1 || docker build -q -t "$tag" . >/dev/null
[ $# -gt 0 ] || set -- uv run --locked pytest
# Downloads persist in a volume; S3_*, UV_PYTHON and GRID_MEMORY_LIMIT pass through when set.
exec docker run --rm -v "$PWD:/app" -v crowd-depth-grid-cache:/cache \
  -e S3_ENDPOINT -e S3_ACCESS_KEY_ID -e S3_SECRET_ACCESS_KEY -e S3_REGION -e UV_PYTHON \
  -e GRID_MEMORY_LIMIT \
  "$tag" "$@"
