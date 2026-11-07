#!/usr/bin/env bash
# Runs on the test machine. scripts/remote-checks/run-remote.js sends this file with
# every run, so nothing needs deploying.
#
#   bases                                    list commits the machine already has
#   receive <commit> <base|none>             take a git pack on stdin and name the snapshot
#   related <id>                             take a JSON list of source files on stdin; the run tests only what relates to them
#   run <id> <commit> <ci> <no-cache>        run the suite, streaming output; last line is the result
#   fetch <id>                               send the JSON report, gzipped, then tidy up
#
# A run lives in its own systemd scope, so stopping it kills everything it started,
# including detached children, which closing SSH alone would leave running. The caller
# holds stdin open for the whole run: when that closes, the connection has gone.
set -u

SELF="$(readlink -f "$0")"
BASE="$(dirname "$SELF")"
REPO="$BASE/repo.git"
RUNS="$BASE/runs"
SLOT_COUNT=3
SLOT_WAIT_SECONDS=180
RUN_LIMIT_SECONDS=3600
SNAPSHOT_MAX_AGE_SECONDS=86400
BASE_LIMIT=500
BUSY=75
RESULT_PREFIX='AIO_REMOTE_RESULT '

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

ensure_repo() {
  [ -d "$REPO" ] || git init -q --bare "$REPO"
}

cmd_bases() {
  ensure_repo
  git -C "$REPO" for-each-ref --sort=-committerdate "--count=$BASE_LIMIT" --format='%(objectname)' refs/bases/
}

# Snapshots are temporary. Real commits only matter as a starting point for the next send, so the
# newest few hundred are enough, however old a quiet project's commits are.
tidy() {
  local now name stamp
  now="$(date +%s)"
  git -C "$REPO" for-each-ref --format='%(refname) %(committerdate:unix)' refs/snapshots/ |
    while read -r name stamp; do
      if [ $((now - stamp)) -gt "$SNAPSHOT_MAX_AGE_SECONDS" ]; then git -C "$REPO" update-ref -d "$name"; fi
    done
  git -C "$REPO" for-each-ref --sort=-committerdate --format='%(refname)' refs/bases/ | tail -n "+$((BASE_LIMIT + 1))" |
    while read -r name; do git -C "$REPO" update-ref -d "$name"; done
  find "$RUNS" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf {} + 2>/dev/null
  # Every run rewrites its own version, so only retired versions get this old.
  find "$BASE" -maxdepth 1 -name 'remote-run-*' -mtime +7 -delete 2>/dev/null
  if [ -z "$(find "$BASE/last-gc" -mmin -1440 2>/dev/null)" ]; then
    touch "$BASE/last-gc"
    flock -n -o "$BASE/gc.lock" git -C "$REPO" gc --quiet --prune=2.days.ago
  fi
}

cmd_receive() {
  local commit="$1" base="$2"
  ensure_repo
  mkdir -p "$RUNS"
  git -C "$REPO" index-pack --stdin --fix-thin >/dev/null || exit 1
  git -C "$REPO" update-ref "refs/snapshots/$commit" "$commit" || exit 1
  if [ "$base" != none ]; then git -C "$REPO" update-ref "refs/bases/$base" "$base" || exit 1; fi
  # The snapshot is safely stored by now, so housekeeping can't fail the send.
  tidy || true
}

# The run's outcome, as one line of JSON. Every value here is hex, a number, or a fixed word.
write_result() {
  local dir="$1" status="$2" reason="$3" exit_code="$4" tree="$5" node="$6" lock="$7" root="$8" waited="${9:-0}"
  printf '{"status":"%s","reason":"%s","exit":%s,"tree":"%s","node":"%s","lock":"%s","root":"%s","waited":%s}\n' \
    "$status" "$reason" "$exit_code" "$tree" "$node" "$lock" "$root" "$waited" > "$dir/result.tmp"
  mv "$dir/result.tmp" "$dir/result"
}

setup_failed() {
  echo "[remote checks] $2"
  write_result "$1" setup-failed "$2" 1 '' '' '' ''
  exit 0
}

ensure_node() {
  local version="$1" dir="$BASE/node/$1"
  if [ ! -x "$dir/bin/node" ]; then
    mkdir -p "$BASE/node"
    local staging
    staging="$(mktemp -d "$BASE/node/.fetch-XXXXXX")"
    curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" |
      tar -xJ --strip-components=1 -C "$staging" || { rm -rf "$staging"; return 1; }
    mv -T "$staging" "$dir" 2>/dev/null || rm -rf "$staging"
  fi
  PATH="$dir/bin:$PATH"
}

install_stamp() {
  cat package-lock.json package.json .npmrc 2>/dev/null | sha256sum | cut -d' ' -f1
  node -v
}

# Runs inside a held slot. Output goes to the run's log, which `run` streams back.
cmd_slot_job() {
  local slot="$1" dir="$2" commit="$3" ci="$4" no_cache="$5" waited="$6"
  local work="$BASE/slots/$slot/repo"
  echo "[remote checks] slot $slot on $(hostname)"

  mkdir -p "$work" || setup_failed "$dir" 'could not make the checkout folder'
  cd "$work" || setup_failed "$dir" 'could not open the checkout folder'
  [ -d .git ] || git init -q || setup_failed "$dir" 'could not make the checkout'
  git fetch -q "$REPO" "refs/snapshots/$commit" || setup_failed "$dir" 'could not read the snapshot'
  git checkout -q --force --detach FETCH_HEAD || setup_failed "$dir" 'could not check out the snapshot'
  git clean -ffdxq -e node_modules || setup_failed "$dir" 'could not clean the checkout'

  local tree version lock
  tree="$(git rev-parse 'HEAD^{tree}')"
  version="$(cat .nvmrc 2>/dev/null)"
  [ -n "$version" ] || setup_failed "$dir" 'the snapshot has no .nvmrc'
  ensure_node "$version" || setup_failed "$dir" 'could not fetch the Node version'
  lock="$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1)"

  local stamp_file="$BASE/slots/$slot/install-stamp" stamp
  stamp="$(install_stamp)"
  if [ "$stamp" != "$(cat "$stamp_file" 2>/dev/null)" ]; then
    echo "[remote checks] installing packages"
    rm -f "$stamp_file"
    bash scripts/ci-npm-ci.sh || setup_failed "$dir" 'npm ci failed'
    printf '%s\n' "$stamp" > "$stamp_file"
  fi

  # Five specs start a real worker from dist, and an old dist must never meet new code.
  # A type error is the job's own fault, not the machine's: tsc still writes its output,
  # so sync-dist runs regardless and the tests show the truth.
  echo "[remote checks] building dist"
  node node_modules/typescript/bin/tsc -p tsconfig.electron.json
  node scripts/sync-dist.js

  echo "[remote checks] running tests"
  # scripts/run-tests-quiet.js makes this on the Mac, and specs create temporary folders in it.
  mkdir -p _scratch
  local args=(run)
  [ "$no_cache" = 1 ] && { args+=(--no-cache); export AIO_TEST_NO_CACHE=1; }
  [ "$ci" = 1 ] && export CI=1
  local code
  if [ -f "$dir/related.json" ]; then
    AIO_TEST_MAX_FORKS=8 LANG=C.UTF-8 node scripts/run-related-tests.mjs "$dir/results.json" < "$dir/related.json"
    code=$?
  else
    # Same arguments as runVitest() in scripts/run-tests-quiet.js.
    AIO_TEST_MAX_FORKS=8 LANG=C.UTF-8 node node_modules/vitest/vitest.mjs "${args[@]}" \
      --reporter=default --reporter=json "--outputFile.json=$dir/results.json"
    code=$?
  fi
  write_result "$dir" ok '' "$code" "$tree" "$(node -v)" "$lock" "$work" "$waited"
}

# The scope's main program: waits for a free slot, holding nothing while it waits.
# `flock -o` keeps the lock away from the run's children, so a stray one can't hold a slot.
cmd_job() {
  local dir="$1" commit="$2" ci="$3" no_cache="$4"
  local started deadline slot code announced=0
  started="$(date +%s)"
  deadline=$((started + SLOT_WAIT_SECONDS))
  mkdir -p "$BASE/slots"
  while :; do
    for slot in $(seq 1 "$SLOT_COUNT"); do
      flock -n -o -E "$BUSY" "$BASE/slots/$slot.lock" \
        bash "$SELF" slot-job "$slot" "$dir" "$commit" "$ci" "$no_cache" "$(($(date +%s) - started))"
      code=$?
      [ "$code" -eq "$BUSY" ] || return 0
    done
    if [ "$(date +%s)" -ge "$deadline" ]; then
      write_result "$dir" no-slot '' 1 '' '' '' ''
      return 0
    fi
    [ "$announced" = 1 ] || { echo "[remote checks] waiting for a free slot"; announced=1; }
    sleep 2
  done
}

cmd_related() {
  mkdir -p "$RUNS/$1" || exit 1
  cat > "$RUNS/$1/related.json" || exit 1
}

cmd_run() {
  local id="$1" commit="$2" ci="$3" no_cache="$4"
  local dir="$RUNS/$id" unit="harness-run-$id"
  mkdir -p "$dir"
  : > "$dir/out.log"

  # A scope, not a service: a service's manager adopts orphans, whereas tests expect what a
  # normal login gives them, which is process 1. leftover-process-sweeper.real.spec.ts needs this.
  systemd-run --user --scope --quiet --collect --unit="$unit" \
    -p KillMode=control-group -p TimeoutStopSec=10 -p "RuntimeMaxSec=$RUN_LIMIT_SECONDS" \
    bash "$SELF" job "$dir" "$commit" "$ci" "$no_cache" >> "$dir/out.log" 2>&1 < /dev/null &
  local run_pid=$!

  # Bash gives background jobs /dev/null as stdin, so the watcher needs its own copy of the real one.
  exec 3<&0
  ( cat <&3 >/dev/null; systemctl --user stop "$unit.scope" ) >/dev/null 2>&1 &
  exec 3<&-

  tail -n +1 -f --pid="$run_pid" "$dir/out.log"
  wait "$run_pid"
  # A finished run can still leave detached children behind.
  systemctl --user stop "$unit.scope" 2>/dev/null

  if [ -f "$dir/result" ]; then
    printf '%s%s\n' "$RESULT_PREFIX" "$(cat "$dir/result")"
  else
    printf '%s{"status":"setup-failed","reason":"the run stopped before it finished","exit":1}\n' "$RESULT_PREFIX"
  fi
}

cmd_fetch() {
  local dir="$RUNS/$1"
  gzip -c "$dir/results.json" || exit 1
  rm -rf "$dir"
}

command_name="${1:-}"
[ $# -gt 0 ] && shift
case "$command_name" in
  bases) cmd_bases ;;
  receive) cmd_receive "$@" ;;
  related) cmd_related "$@" ;;
  run) cmd_run "$@" ;;
  job) cmd_job "$@" ;;
  slot-job) cmd_slot_job "$@" ;;
  fetch) cmd_fetch "$@" ;;
  *) echo "usage: remote-run.sh bases|receive|related|run|fetch" >&2; exit 2 ;;
esac
