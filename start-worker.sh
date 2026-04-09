#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "Building worker agent..."
npx tsx build-worker-agent.ts

echo "Starting worker agent..."
node dist/worker-agent/index.js "$@"
