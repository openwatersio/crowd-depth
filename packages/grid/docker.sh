#!/bin/sh
# Usage: ./docker.sh [command...]   Runs a command in the grid's image; default: the tests.
# The image is built on first use, tagged by the Dockerfile, lockfiles and helper it came from.
set -eu
cd "$(dirname "$0")"
tag="crowd-depth-grid:$(cat Dockerfile uv.lock slackwater/package.json slackwater/package-lock.json slackwater/predict.mjs | shasum | cut -c1-12)"
docker image inspect "$tag" >/dev/null 2>&1 || docker build -q -t "$tag" . >/dev/null
[ $# -gt 0 ] || set -- uv run --locked pytest
# uv's downloads persist in a volume. The grid's download cache is the host's, so runs in
# and out of the container share it. S3_*, UV_PYTHON, GRID_MEMORY_LIMIT and
# GRID_CACHE_FILES_GB pass through when set.
cache="${GRID_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/crowd-depth-grid}"
mkdir -p "$cache"
exec docker run --rm -v "$PWD:/app" -v crowd-depth-grid-cache:/cache -v "$cache:/cache/grid" \
  -e S3_ENDPOINT -e S3_ACCESS_KEY_ID -e S3_SECRET_ACCESS_KEY -e S3_REGION -e UV_PYTHON \
  -e GRID_MEMORY_LIMIT -e GRID_CACHE_FILES_GB \
  "$tag" "$@"
