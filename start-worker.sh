#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "Building worker agent..."
npx tsx build-worker-agent.ts

echo "Starting worker agent..."
# Prefer passing the auth token via AIO_WORKER_TOKEN environment variable so
# it does not appear in the OS process table (visible to all local users via
# `ps aux`). Example:
#
#   AIO_WORKER_TOKEN=<token> ./start-worker.sh --coordinator http://host:3000
#
# The legacy --token CLI flag still works but is deprecated.
node dist/worker-agent/index.js "$@"
