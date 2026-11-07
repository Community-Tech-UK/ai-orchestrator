#!/usr/bin/env bash
# Runs on the test machine. scripts/remote-checks/run-remote.js sends this file with
# every run, so nothing needs deploying.
#
#   bases                                    list commits the machine already has
#   receive <commit> <base|none>             take a git pack on stdin and name the snapshot
#   related <id>                             take a JSON list of source files on stdin; the run tests only what relates to them
#   checks <id>                              take check commands on stdin, one a line; the run does those instead of tests
#   run <id> <commit> <ci> <no-cache>        run the suite, streaming output; last line is the result
#   fetch <id>                               send the JSON report, gzipped, then tidy up
#
# With AIO_PROJECT and AIO_SUITE set, each of those works on that repository instead, in its own
# store and checkouts, using a recipe at the bottom of this file. It shares the same slots.
#
# A run lives in its own systemd scope, so stopping it kills everything it started,
# including detached children, which closing SSH alone would leave running. The caller
# holds stdin open for the whole run: when that closes, the connection has gone.
set -u

SELF="$(readlink -f "$0")"
BASE="$(dirname "$SELF")"
PROJECT="${AIO_PROJECT:-}"
SUITE="${AIO_SUITE:-}"
HOME_OF_PROJECT="$BASE${PROJECT:+/projects/$PROJECT}"
REPO="$HOME_OF_PROJECT/repo.git"
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
  [ -d "$REPO" ] || { mkdir -p "$HOME_OF_PROJECT" && git init -q --bare "$REPO"; }
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
  if [ -z "$(find "$HOME_OF_PROJECT/last-gc" -mmin -1440 2>/dev/null)" ]; then
    touch "$HOME_OF_PROJECT/last-gc"
    flock -n -o "$HOME_OF_PROJECT/gc.lock" git -C "$REPO" gc --quiet --prune=2.days.ago
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
  local dir="$1" status="$2" reason="$3" exit_code="$4" tree="$5" node="$6" lock="$7" root="$8" waited="${9:-0}" tests="${10:-0}"
  printf '{"status":"%s","reason":"%s","exit":%s,"tree":"%s","node":"%s","lock":"%s","root":"%s","waited":%s,"tests":%s}\n' \
    "$status" "$reason" "$exit_code" "$tree" "$node" "$lock" "$root" "$waited" "$tests" > "$dir/result.tmp"
  mv "$dir/result.tmp" "$dir/result"
}

setup_failed() {
  echo "[remote checks] $2"
  write_result "$1" setup-failed "$2" 1 '' '' '' ''
  exit 0
}

# A project may name only a major version. Any we already have will do; the newest otherwise.
full_node_version() {
  case "$1" in
    v*.*.*) echo "$1" ;;
    *.*.*) echo "v$1" ;;
    *)
      local major="${1#v}" have
      have="$(ls -d "$BASE/node/v$major".* 2>/dev/null | sort -V | tail -n 1)"
      if [ -n "$have" ]; then basename "$have"
      else curl -fsSL "https://nodejs.org/dist/latest-v$major.x/" | grep -o "node-v$major\.[0-9.]*-linux-x64" | head -n 1 | sed -e 's/^node-//' -e 's/-linux-x64$//'
      fi
      ;;
  esac
}

ensure_node() {
  local version dir
  version="$(full_node_version "$1")"
  [ -n "$version" ] || return 1
  dir="$BASE/node/$version"
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
  local work="$HOME_OF_PROJECT/slots/$slot/repo"
  echo "[remote checks] slot $slot on $(hostname)"

  mkdir -p "$work" || setup_failed "$dir" 'could not make the checkout folder'
  cd "$work" || setup_failed "$dir" 'could not open the checkout folder'
  [ -d .git ] || git init -q || setup_failed "$dir" 'could not make the checkout'
  git fetch -q "$REPO" "refs/snapshots/$commit" || setup_failed "$dir" 'could not read the snapshot'
  git checkout -q --force --detach FETCH_HEAD || setup_failed "$dir" 'could not check out the snapshot'
  git clean -ffdxq -e node_modules || setup_failed "$dir" 'could not clean the checkout'

  local tree version lock
  tree="$(git rev-parse 'HEAD^{tree}')"
  [ -z "$PROJECT" ] || load_recipe || setup_failed "$dir" 'this repository has no recipe here'
  version="$(cat "${NODE_FILE:-.nvmrc}" 2>/dev/null)"
  [ -n "$version" ] || setup_failed "$dir" 'the snapshot has no Node version file'
  ensure_node "$version" || setup_failed "$dir" 'could not fetch the Node version'
  lock="$(sha256sum "${LOCK_FILE:-package-lock.json}" 2>/dev/null | cut -d' ' -f1)"

  if [ -n "$PROJECT" ]; then
    project_job "$slot" "$dir" "$tree" "$lock" "$work" "$waited"
    return
  fi

  local stamp_file="$BASE/slots/$slot/install-stamp" stamp
  stamp="$(install_stamp)"
  if [ "$stamp" != "$(cat "$stamp_file" 2>/dev/null)" ]; then
    echo "[remote checks] installing packages"
    rm -f "$stamp_file"
    bash scripts/ci-npm-ci.sh || setup_failed "$dir" 'npm ci failed'
    printf '%s\n' "$stamp" > "$stamp_file"
  fi

  if [ -f "$dir/checks.list" ]; then
    [ "$ci" = 1 ] && export CI=1
    checks_job "$dir" "$tree" "$lock" "$work" "$waited"
    return
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

# Runs each listed check in turn, every one whatever fails, as the Mac would. Each one's output
# streams back and is kept, and results.json holds every check's exit code, time and output.
checks_job() {
  local dir="$1" tree="$2" lock="$3" work="$4" waited="$5"
  local check index=0 first_failure=0 code started
  while IFS= read -r check; do
    index=$((index + 1))
    echo "[remote checks] check $index: $check"
    started="$(date +%s%3N)"
    LANG=C.UTF-8 bash -c "$check" < /dev/null 2>&1 | tee "$dir/check-$index.log"
    code="${PIPESTATUS[0]}"
    printf '%s %s\n' "$code" "$(($(date +%s%3N) - started))" > "$dir/check-$index.status"
    [ "$first_failure" -ne 0 ] || [ "$code" -eq 0 ] || first_failure="$code"
  done < "$dir/checks.list"
  # Up to 256 KB of each check's output: what the Mac keeps from a check run there.
  node -e '
    const fs = require("fs");
    const dir = process.argv[1];
    const checks = fs.readFileSync(dir + "/checks.list", "utf8").split("\n").filter(Boolean);
    process.stdout.write(JSON.stringify(checks.map((command, at) => {
      const [exitCode, durationMs] = fs.readFileSync(`${dir}/check-${at + 1}.status`, "utf8").trim().split(" ").map(Number);
      const output = fs.readFileSync(`${dir}/check-${at + 1}.log`).subarray(-256000).toString("utf8");
      return { command, exitCode, durationMs, output };
    })));
  ' "$dir" > "$dir/results.json" || setup_failed "$dir" 'could not write the check results'
  write_result "$dir" ok '' "$first_failure" "$tree" "$(node -v)" "$lock" "$work" "$waited" "$index"
}

# Installs once per lockfile, then runs the project's own quiet runner, which prints what a person
# would read. It's the run's exit code that counts, and a test count proves tests really ran.
project_job() {
  local slot="$1" dir="$2" tree="$3" lock="$4" work="$5" waited="$6"
  local stamp_file="$HOME_OF_PROJECT/slots/$slot/install-stamp-$SUITE" stamp
  # The recipe counts too: changing how a project installs has to take effect.
  stamp="$( (cat $INSTALL_INPUTS 2>/dev/null; declare -f recipe_install) | sha256sum | cut -d' ' -f1)-$(node -v)"
  if [ "$stamp" != "$(cat "$stamp_file" 2>/dev/null)" ]; then
    echo "[remote checks] installing packages"
    rm -f "$stamp_file"
    recipe_install > "$dir/install.log" 2>&1 || { tail -n 30 "$dir/install.log"; setup_failed "$dir" 'the install failed'; }
    printf '%s\n' "$stamp" > "$stamp_file"
  fi
  echo "[remote checks] running tests"
  recipe_test
  local code=$?
  # A failure's detail is in the project's own log, which is gone once the next run cleans up.
  if [ "$code" -ne 0 ]; then
    echo '[remote checks] full log follows'
    cat "$RECIPE_LOG" 2>/dev/null
  fi
  write_result "$dir" ok '' "$code" "$tree" "$(node -v)" "$lock" "$work" "$waited" "$(recipe_test_count)"
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

# The only commands `checks` will run, exactly as written. scripts/remote-checks/checks.js has the same list.
known_check() {
  case "$1" in
    'npx tsc --noEmit' | 'npm run typecheck' | 'npm run typecheck:spec' | 'npm run lint' | 'npm run check:ts-max-loc' | \
    'npm run check:ui-hints' | 'npm run build:main' | 'npm run build:worker-agent' | 'npm run build:renderer') return 0 ;;
    *) return 1 ;;
  esac
}

# Refuses the whole list if one line isn't a known check, so nothing runs that the Mac didn't mean.
cmd_checks() {
  local dir="$RUNS/$1" list check count=0
  list="$(cat)" || exit 1
  while IFS= read -r check; do
    [ -n "$check" ] || continue
    known_check "$check" || { echo "remote-run.sh: not a known check: $check" >&2; exit 4; }
    count=$((count + 1))
  done <<< "$list"
  [ "$count" -gt 0 ] || { echo 'remote-run.sh: no checks given' >&2; exit 4; }
  mkdir -p "$dir" || exit 1
  printf '%s\n' "$list" | grep -v '^$' > "$dir/checks.list" || exit 1
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
  # A project's report stays with its own runner, so nothing will come to fetch this.
  [ -z "$PROJECT" ] || rm -rf "$dir"
}

# Every repository that may run here, by the names in scripts/remote-checks/projects.js. Anything
# else is refused. Each one sets NODE_FILE, LOCK_FILE, INSTALL_INPUTS and RECIPE_LOG, and defines
# recipe_install, recipe_test and recipe_test_count. AIO_REMOTE_CHECKS=off stops a project's runner sending itself here.
load_recipe() {
  case "$PROJECT/$SUITE" in
    work-finding/desk)
      NODE_FILE=apps/desk/.nvmrc
      LOCK_FILE=apps/desk/package-lock.json
      INSTALL_INPUTS='apps/desk/package-lock.json apps/desk/package.json apps/radar/package-lock.json'
      # Desk's tests load Radar's native addon.
      recipe_install() { npm --prefix apps/radar ci && npm --prefix apps/desk ci && (cd apps/desk && npx playwright install chromium chromium-headless-shell); }
      # panelLayoutCss measures pixels with the system font, and the Mac's isn't here, so it stays
      # on the Mac. Its runner holds to 4 files at a time for the Mac's sake. This machine has room.
      # The usual umask here lets a group write, which the installer tests rightly refuse.
      recipe_test() {
        (umask 022 && cd apps/desk && AIO_REMOTE_CHECKS=off npm run test:quiet -- --test-concurrency=8 \
          $(ls test/unit/*.test.ts test/unit/*.test.mjs work-finder/*.test.mjs | grep -v '/panelLayoutCss\.test\.ts$'))
      }
      RECIPE_LOG=apps/desk/_scratch/test-run.log
      recipe_test_count() { sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' "$RECIPE_LOG" 2>/dev/null | tail -n 1 | grep . || echo 0; }
      ;;
    *) return 1 ;;
  esac
}

cmd_fetch() {
  local dir="$RUNS/$1"
  gzip -c "$dir/results.json" || exit 1
  rm -rf "$dir"
}

# Refused before anything is stored: a name the recipes don't know never gets a folder here.
if [ -n "$PROJECT" ] && ! load_recipe; then
  echo "remote-run.sh: $PROJECT/$SUITE is not a known repository" >&2
  exit 3
fi

command_name="${1:-}"
[ $# -gt 0 ] && shift
case "$command_name" in
  bases) cmd_bases ;;
  receive) cmd_receive "$@" ;;
  related) cmd_related "$@" ;;
  checks) cmd_checks "$@" ;;
  run) cmd_run "$@" ;;
  job) cmd_job "$@" ;;
  slot-job) cmd_slot_job "$@" ;;
  fetch) cmd_fetch "$@" ;;
  *) echo "usage: remote-run.sh bases|receive|related|checks|run|fetch" >&2; exit 2 ;;
esac
