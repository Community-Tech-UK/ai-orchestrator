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
#
# --supervise runs the worker under its own restart parent so a single process
# exit does not leave the node silently dead (see docs/WORKER_AGENT_SETUP.md).
# A clean Ctrl-C / SIGTERM still stops the supervisor too.
#
# The flag goes LAST: index.ts dispatches positional subcommands off argv[0]
# ("native-host", "pair", "install-extension-relay"), so putting it first would
# shadow them. Supervision is selected with argv.includes(), not by position.
node dist/worker-agent/index.js "$@" --supervise
