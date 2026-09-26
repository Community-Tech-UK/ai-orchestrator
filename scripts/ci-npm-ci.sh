#!/usr/bin/env bash
# Resilient `npm ci` for CI runners.
#
# The Electron postinstall download is a known flake point: the primary mirror
# (ELECTRON_MIRROR, npmmirror) intermittently answers 504/timeout, which used to
# redden whole jobs before any code ran (run 36228688728 — every failed job died
# in Install dependencies). Strategy:
#   1. `npm ci` with the configured mirror, up to 3 attempts with backoff.
#   2. Last resort: retry once with ELECTRON_MIRROR unset so @electron/get falls
#      back to Electron's official GitHub releases URL.
# Combined with the .electron-cache restore step in ci.yml (electron's installer
# reads `electron_config_cache` and skips the network when the artifact is
# already cached), this removes the mirror from the critical path of most runs.
#
# A non-network npm ci failure (e.g. lockfile out of sync) retries the same way
# and then fails with npm's original error — bounded waste, no hidden masking.

set -u

max_attempts=3
attempt=1

while true; do
  if npm ci; then
    exit 0
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    break
  fi
  sleep_seconds=$((attempt * 10))
  echo "ci-npm-ci: npm ci failed (attempt ${attempt}/${max_attempts}); retrying in ${sleep_seconds}s" >&2
  sleep "$sleep_seconds"
  attempt=$((attempt + 1))
done

echo "ci-npm-ci: npm ci failed ${max_attempts} times with ELECTRON_MIRROR=${ELECTRON_MIRROR:-<unset>}; retrying once with the official Electron releases URL" >&2
env -u ELECTRON_MIRROR npm ci
