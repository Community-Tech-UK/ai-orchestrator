#!/usr/bin/env bash
# Runs on the test machine. scripts/remote-checks/run-remote.js sends this file with
# every run, so nothing needs deploying.
#
#   bases                                    list commits the machine already has
#   receive <commit> <base|none>             take a git pack on stdin and name the snapshot
#   related <id>                             take a JSON list of source files on stdin; the run tests only what relates to them
#   checks <id>                              take check commands on stdin, one a line; the run does those instead of tests
#   argv <id>                                take a JSON list of the runner's own arguments on stdin; the run passes them on
#   run <id> <commit> <ci> <no-cache>        run the suite, streaming output; last line is the result
#   fetch <id>                               send the JSON report, gzipped, then tidy up
#
# With AIO_PROJECT and AIO_SUITE set, each of those works on that repository instead, in its own
# store and checkouts, using a recipe at the bottom of this file. It shares the same slots.
#
# With AIO_SMALL_RUN=1 a run takes one of the small-run slots instead (small-1 to small-N, N from AIO_SMALL_SLOT_COUNT,
# 4 by default), so named lists sent while the Mac is switched off don't queue behind full runs. Each has its own checkout.
#
# On Linux a run lives in its own systemd scope, so stopping it kills everything it started,
# including detached children, which closing SSH alone would leave running. A Mac has no systemd,
# so there a run leads its own process group instead, which catches everything except a child that
# starts a session of its own. The caller holds stdin open for the whole run: when that closes, the
# connection has gone.
set -u

SELF="$(readlink -f "$0")"
BASE="$(dirname "$SELF")"
PROJECT="${AIO_PROJECT:-}"
SUITE="${AIO_SUITE:-}"
HOME_OF_PROJECT="$BASE${PROJECT:+/projects/$PROJECT}"
REPO="$HOME_OF_PROJECT/repo.git"
RUNS="$BASE/runs"
SLOT_COUNT=3
# Harness's Computers page can choose another number, which run-remote.js passes on.
case "${AIO_SLOT_COUNT:-}" in [1-8]) SLOT_COUNT="$AIO_SLOT_COUNT" ;; esac
SLOT_NAMES="$(seq 1 "$SLOT_COUNT")"
if [ "${AIO_SMALL_RUN:-}" = 1 ]; then
  SMALL_SLOT_COUNT=4
  case "${AIO_SMALL_SLOT_COUNT:-}" in [1-8]) SMALL_SLOT_COUNT="$AIO_SMALL_SLOT_COUNT" ;; esac
  SLOT_NAMES="$(seq 1 "$SMALL_SLOT_COUNT" | sed 's/^/small-/')"
fi
SLOT_WAIT_SECONDS=180
# A machine tried before another in the list doesn't wait for a slot: the next one might have one free. run-remote.js
# sends AIO_SLOT_WAIT=0 for those; any other value waits as usual.
[ "${AIO_SLOT_WAIT:-}" = 0 ] && SLOT_WAIT_SECONDS=0
RUN_LIMIT_SECONDS=3600
SNAPSHOT_MAX_AGE_SECONDS=86400
BASE_LIMIT=500
BUSY=75
RESULT_PREFIX='AIO_REMOTE_RESULT '

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# macOS has neither systemd nor flock, and its date, sha256sum, tail and mv lack the GNU options used
# here. These stand in on a Mac; on Linux each is the command it always was.
if [ "$(uname -s)" = Darwin ]; then MAC=1; NODE_PLATFORM=darwin-arm64; else MAC=0; NODE_PLATFORM=linux-x64; fi
# An ssh command on a Mac reads no login profile, so it sees only the system's folders. Tests need rg and flock, from
# Homebrew there; after the system's own, so bash, perl and tar stay the ones above.
[ "$MAC" = 1 ] && [ -d /opt/homebrew/bin ] && PATH="$PATH:/opt/homebrew/bin"

sha256() {
  if [ "$MAC" = 1 ]; then shasum -a 256 "$@"; else sha256sum "$@"; fi
}

now_ms() {
  if [ "$MAC" = 1 ]; then perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; else date +%s%3N; fi
}

# Runs the rest of the arguments holding an exclusive lock on the first, or exits BUSY at once if
# another run holds it. On a Mac the lock also reaches the command's children, which `flock -o`
# keeps from them on Linux, so there a stray child can hold a slot until it ends.
with_lock() {
  local lock="$1"
  shift
  if [ "$MAC" = 1 ]; then
    AIO_BUSY="$BUSY" perl -MFcntl=:flock -e '
      $^F = 255;  # keep the lock open across exec
      open(my $held, ">>", shift) or exit 1;
      flock($held, LOCK_EX | LOCK_NB) or exit $ENV{AIO_BUSY};
      exec @ARGV or exit 127;
    ' "$lock" "$@"
  else
    flock -n -o -E "$BUSY" "$lock" "$@"
  fi
}

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
    with_lock "$HOME_OF_PROJECT/gc.lock" git -C "$REPO" gc --quiet --prune=2.days.ago
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
      else curl -fsSL "https://nodejs.org/dist/latest-v$major.x/" | grep -o "node-v$major\.[0-9.]*-$NODE_PLATFORM" | head -n 1 | sed -e 's/^node-//' -e "s/-$NODE_PLATFORM\$//"
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
    curl -fsSL "https://nodejs.org/dist/$version/node-$version-$NODE_PLATFORM.tar.xz" |
      tar -xJ --strip-components=1 -C "$staging" || { rm -rf "$staging"; return 1; }
    # Another run may have fetched the same version meanwhile: keep the first.
    if [ "$MAC" = 1 ]; then
      if [ -e "$dir" ]; then rm -rf "$staging"; else mv "$staging" "$dir"; fi
    else
      mv -T "$staging" "$dir" 2>/dev/null || rm -rf "$staging"
    fi
  fi
  PATH="$dir/bin:$PATH"
}

install_stamp() {
  cat package-lock.json package.json .npmrc 2>/dev/null | sha256 | cut -d' ' -f1
  node -v
}

# Runs inside a held slot. Output goes to the run's log, which `run` streams back.
cmd_slot_job() {
  local slot="$1" dir="$2" commit="$3" ci="$4" no_cache="$5" waited="$6"
  local work="$HOME_OF_PROJECT/slots/$slot/repo"
  echo "[remote checks] slot $slot on $(hostname)"

  mkdir -p "$work" || setup_failed "$dir" 'could not make the checkout folder'
  cd "$work" || setup_failed "$dir" 'could not open the checkout folder'
  # For the Mac's clean-up after the run: which checkout it worked in.
  pwd -P > "$dir/work"
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
  lock="$(sha256 "${LOCK_FILE:-package-lock.json}" 2>/dev/null | cut -d' ' -f1)"

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
  elif [ -f "$dir/argv.json" ]; then
    # The arguments stay a list from end to end: no shell here ever reads them.
    AIO_TEST_MAX_FORKS=8 LANG=C.UTF-8 node -e '
      const { spawnSync } = require("child_process");
      const [file, noCache, results] = process.argv.slice(1);
      const list = readArgv(file);
      const args = ["node_modules/vitest/vitest.mjs", "run", ...list, ...(noCache === "1" ? ["--no-cache"] : []),
        "--reporter=default", "--reporter=json", `--outputFile.json=${results}`];
      const run = spawnSync(process.execPath, args, { stdio: "inherit" });
      process.exit(run.status ?? 1);
      '"$READ_ARGV_JS" "$dir/argv.json" "$no_cache" "$dir/results.json"
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
    started="$(now_ms)"
    LANG=C.UTF-8 bash -c "$check" < /dev/null 2>&1 | tee "$dir/check-$index.log"
    code="${PIPESTATUS[0]}"
    printf '%s %s\n' "$code" "$(($(now_ms) - started))" > "$dir/check-$index.status"
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

# Shared by both ways of passing arguments on: reads the run's JSON list, refusing anything but strings.
READ_ARGV_JS='
function readArgv(file) {
  let list;
  try { list = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch { list = null; }
  if (!Array.isArray(list) || !list.every(arg => typeof arg === "string")) {
    console.error("[remote checks] the run arguments are not a list of strings");
    process.exit(2);
  }
  return list;
}
'

# For a recipe: runs the command given, then the run's arguments from ARGV_FILE, as one list with no shell between.
run_with_argv() {
  node -e '
    const { spawnSync } = require("child_process");
    const [file, command, ...rest] = process.argv.slice(1);
    const run = spawnSync(command, [...rest, ...readArgv(file)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
    '"$READ_ARGV_JS" "$ARGV_FILE" "$@"
}

# For a recipe with files that stay on the Mac: like run_with_argv, but a folder or pattern the Mac named becomes the test
# files in it, and a run naming no files gets the recipe's own list, all without the files matching the pattern given.
# What names a file follows the runners' own rule: anything shaped like a path or a pattern, or a path that exists.
# Usage: run_with_argv_leaving_out <pattern> <own list, one a line> <command...>
run_with_argv_leaving_out() {
  node -e '
    const { spawnSync } = require("child_process");
    const fs = require("fs");
    const path = require("path");
    const [file, leaveOut, ownList, command, ...rest] = process.argv.slice(1);
    const left = new RegExp(leaveOut);
    const kept = found => !left.test(found);
    const testFile = /\.test\.[cm]?[jt]s$/;
    const filesIn = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : filesIn(at);
      return testFile.test(entry.name) ? [at] : [];
    });
    const namesFiles = arg => !arg.startsWith("-") && (/[*?[{/]|\.[cm]?[jt]s$/.test(arg) || fs.existsSync(arg));
    const argv = readArgv(file);
    const named = argv.some(namesFiles);
    const expanded = argv.flatMap((arg) => {
      if (!namesFiles(arg)) return [arg];
      if (/[*?[{]/.test(arg)) return fs.globSync(arg).filter(kept).sort();
      if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) return filesIn(arg).filter(kept).sort();
      return kept(arg) ? [arg] : [];
    });
    const list = named ? expanded : [...expanded, ...ownList.split("\n").filter(Boolean).filter(kept)];
    if (!list.some(namesFiles)) {
      console.log("[remote checks] nothing to run here: the files named only run on the Mac");
      process.exit(0);
    }
    const run = spawnSync(command, [...rest, ...list], { stdio: "inherit" });
    process.exit(run.status ?? 1);
    '"$READ_ARGV_JS" "$ARGV_FILE" "$@"
}

# Installs once per lockfile, then runs the project's own quiet runner, which prints what a person
# would read. It's the run's exit code that counts, and a test count proves tests really ran.
project_job() {
  local slot="$1" dir="$2" tree="$3" lock="$4" work="$5" waited="$6"
  local stamp_file="$HOME_OF_PROJECT/slots/$slot/install-stamp-$SUITE" stamp
  # The recipe counts too: changing how a project installs has to take effect.
  stamp="$( (cat $INSTALL_INPUTS 2>/dev/null; declare -f recipe_install) | sha256 | cut -d' ' -f1)-$(node -v)"
  if [ "$stamp" != "$(cat "$stamp_file" 2>/dev/null)" ]; then
    echo "[remote checks] installing packages"
    rm -f "$stamp_file"
    recipe_install > "$dir/install.log" 2>&1 || { tail -n 30 "$dir/install.log"; setup_failed "$dir" 'the install failed'; }
    printf '%s\n' "$stamp" > "$stamp_file"
  fi
  echo "[remote checks] running tests"
  ARGV_FILE=
  [ -f "$dir/argv.json" ] && ARGV_FILE="$dir/argv.json"
  recipe_test
  local code=$?
  # A failure's detail is in the project's own log, which is gone once the next run cleans up.
  if [ "$code" -ne 0 ]; then
    echo '[remote checks] full log follows'
    cat "$RECIPE_LOG" 2>/dev/null
  fi
  write_result "$dir" ok '' "$code" "$tree" "$(node -v)" "$lock" "$work" "$waited" "$(recipe_test_count)"
}

# The run's main program: waits for a free slot, holding nothing while it waits.
cmd_job() {
  local dir="$1" commit="$2" ci="$3" no_cache="$4"
  local started deadline slot code announced=0
  started="$(date +%s)"
  deadline=$((started + SLOT_WAIT_SECONDS))
  mkdir -p "$BASE/slots"
  while :; do
    for slot in $SLOT_NAMES; do
      with_lock "$BASE/slots/$slot.lock" \
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

cmd_argv() {
  mkdir -p "$RUNS/$1" || exit 1
  cat > "$RUNS/$1/argv.json" || exit 1
}

# A child that starts a session of its own leaves the run's group. Once the run ends, any of ours
# that nothing owns any more (its parent is launchd) and that works inside the run's checkout goes too:
# tests that detach children do it from there.
# One lsof call for every process's folder: asking per process took 84 s on a Mac with 849 of them,
# since every app counts (launchd is every app's parent).
sweep_orphans() {
  local work="$1" orphans pid
  [ -n "$work" ] || return 0
  orphans=" $(pgrep -U "$(id -u)" -P 1 2>/dev/null | tr '\n' ' ') "
  lsof -a -u "$(id -u)" -d cwd -Fpn 2>/dev/null |
    awk -v work="$work" '/^p/ { pid = substr($0, 2) } /^n/ { path = substr($0, 2); if (path == work || index(path, work "/") == 1) print pid }' |
    while read -r pid; do
      case "$orphans" in *" $pid "*) kill -KILL "$pid" 2>/dev/null ;; esac
    done
}

# The run leads a new process group, so one signal to the group stops everything it started. It is
# stopped when the connection closes, or at the time limit, and anything left once it ends goes too.
# The group id is the run's own process id, which the system could hand out again once the group is
# gone; the `finished` marker stops a late watcher signalling a stranger.
run_on_mac() {
  local dir="$1" commit="$2" ci="$3" no_cache="$4"
  perl -e 'setpgrp(0, 0); exec @ARGV or exit 127' \
    bash "$SELF" job "$dir" "$commit" "$ci" "$no_cache" >> "$dir/out.log" 2>&1 < /dev/null &
  local run_pid=$!
  stop_group() {
    [ -e "$dir/finished" ] && return
    kill -TERM -- "-$run_pid" 2>/dev/null
    sleep 10
    [ -e "$dir/finished" ] || kill -KILL -- "-$run_pid" 2>/dev/null
  }

  exec 3<&0
  ( cat <&3 >/dev/null; stop_group ) >/dev/null 2>&1 &
  exec 3<&-
  # Stopped when the run ends, taking its sleep with it.
  ( trap 'kill "$timer" 2>/dev/null; exit 0' TERM; sleep "$RUN_LIMIT_SECONDS" & timer=$!; wait "$timer"; stop_group ) >/dev/null 2>&1 &
  local limit_pid=$!

  tail -n +1 -f "$dir/out.log" &
  local tail_pid=$!
  wait "$run_pid"
  # Leftovers in the group go, then tail gets a moment to pass on the last lines.
  kill -KILL -- "-$run_pid" 2>/dev/null
  sweep_orphans "$(cat "$dir/work" 2>/dev/null)"
  touch "$dir/finished"
  kill "$limit_pid" 2>/dev/null
  sleep 1
  kill "$tail_pid" 2>/dev/null
  wait "$tail_pid" 2>/dev/null
}

cmd_run() {
  local id="$1" commit="$2" ci="$3" no_cache="$4"
  local dir="$RUNS/$id" unit="harness-run-$id"
  mkdir -p "$dir"
  : > "$dir/out.log"

  if [ "$MAC" = 1 ]; then
    run_on_mac "$dir" "$commit" "$ci" "$no_cache"
  else
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
  fi

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
# When the Mac named files or other arguments, ARGV_FILE holds them and recipe_test passes them on in place of its own
# list, through run_with_argv, never through a shell.
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
        if [ -n "$ARGV_FILE" ]; then
          (umask 022 && cd apps/desk && AIO_REMOTE_CHECKS=off run_with_argv_leaving_out '/panelLayoutCss\.test\.ts$' \
            "$(ls test/unit/*.test.ts test/unit/*.test.mjs work-finder/*.test.mjs)" npm run test:quiet -- --test-concurrency=8)
          return
        fi
        (umask 022 && cd apps/desk && AIO_REMOTE_CHECKS=off npm run test:quiet -- --test-concurrency=8 \
          $(ls test/unit/*.test.ts test/unit/*.test.mjs work-finder/*.test.mjs | grep -v '/panelLayoutCss\.test\.ts$'))
      }
      RECIPE_LOG=apps/desk/_scratch/test-run.log
      recipe_test_count() { sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' "$RECIPE_LOG" 2>/dev/null | tail -n 1 | grep . || echo 0; }
      ;;
    work-finding/desk-web)
      # Desk's web front end, tested with Jest. It has no Node file of its own and runs on Desk's Node. Its shared
      # contracts package resolves zod from Desk's packages, so Desk installs first.
      NODE_FILE=apps/desk/.nvmrc
      LOCK_FILE=apps/desk/web/package-lock.json
      INSTALL_INPUTS='apps/desk/package-lock.json apps/desk/package.json apps/desk/web/package-lock.json apps/desk/web/package.json'
      recipe_install() { npm --prefix apps/desk ci && npm --prefix apps/desk/web ci; }
      recipe_test() {
        rm -f apps/desk/web/_scratch/jest-results.json
        if [ -n "$ARGV_FILE" ]; then
          (umask 022 && cd apps/desk/web && AIO_REMOTE_CHECKS=off run_with_argv npm run test:quiet --)
        else
          (umask 022 && cd apps/desk/web && AIO_REMOTE_CHECKS=off npm run test:quiet)
        fi
      }
      RECIPE_LOG=apps/desk/web/_scratch/jest-run.log
      recipe_test_count() { node -p 'require(process.argv[1]).numTotalTests' "$PWD/apps/desk/web/_scratch/jest-results.json" 2>/dev/null | grep . || echo 0; }
      ;;
    work-finding/radar)
      NODE_FILE=apps/radar/.nvmrc
      LOCK_FILE=apps/radar/package-lock.json
      INSTALL_INPUTS='apps/radar/package-lock.json apps/radar/package.json'
      recipe_install() { npm --prefix apps/radar ci; }
      recipe_test() {
        rm -f apps/radar/_scratch/test-results.json
        if [ -n "$ARGV_FILE" ]; then
          (umask 022 && cd apps/radar && AIO_REMOTE_CHECKS=off run_with_argv npm run test:quiet --)
        else
          (umask 022 && cd apps/radar && AIO_REMOTE_CHECKS=off npm run test:quiet)
        fi
      }
      RECIPE_LOG=apps/radar/_scratch/test-run.log
      recipe_test_count() { node -p 'require(process.argv[1]).numTotalTests' "$PWD/apps/radar/_scratch/test-results.json" 2>/dev/null | grep . || echo 0; }
      ;;
    work-finding/runner)
      # No Node file of its own (its package asks for 24.x), so it runs on Desk's.
      NODE_FILE=apps/desk/.nvmrc
      LOCK_FILE=apps/runner/package-lock.json
      INSTALL_INPUTS='apps/runner/package-lock.json apps/runner/package.json'
      recipe_install() { npm --prefix apps/runner ci; }
      recipe_test() {
        rm -f apps/runner/_scratch/test-run.log
        if [ -n "$ARGV_FILE" ]; then
          (umask 022 && cd apps/runner && AIO_REMOTE_CHECKS=off run_with_argv npm run test:quiet --)
        else
          (umask 022 && cd apps/runner && AIO_REMOTE_CHECKS=off npm run test:quiet)
        fi
      }
      RECIPE_LOG=apps/runner/_scratch/test-run.log
      recipe_test_count() { sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' "$RECIPE_LOG" 2>/dev/null | tail -n 1 | grep . || echo 0; }
      ;;
    undistilled/all)
      # Its backend tests are built for macOS, so it is unknown anywhere else.
      [ "$MAC" = 1 ] || return 1
      NODE_FILE=.nvmrc
      LOCK_FILE=package-lock.json
      INSTALL_INPUTS='package-lock.json package.json'
      recipe_install() { npm ci --no-audit --no-fund; }
      # Its runner names each run's log by time and ends by printing the path; its own tests start nested runs that
      # leave more, so the printed one is this run's. Its report sits beside it.
      recipe_test() {
        rm -f _scratch/vitest-* _scratch/test-machine-run.*
        mkdir -p _scratch
        AIO_REMOTE_CHECKS=off npm run test:quiet 2>&1 | tee _scratch/test-machine-run.out
        local code=${PIPESTATUS[0]} log
        log="$(sed -n 's/.*Full log: \(.*\.log\)$/\1/p' _scratch/test-machine-run.out | tail -n 1)"
        if [ -n "$log" ]; then
          cp "$log" "$RECIPE_LOG" 2>/dev/null
          cp "${log%.log}.json" _scratch/test-machine-run.json 2>/dev/null
        fi
        return "$code"
      }
      RECIPE_LOG=_scratch/test-machine-run.log
      recipe_test_count() { node -p 'require(process.argv[1]).numTotalTests' "$PWD/_scratch/test-machine-run.json" 2>/dev/null | grep . || echo 0; }
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
  argv) cmd_argv "$@" ;;
  checks) cmd_checks "$@" ;;
  run) cmd_run "$@" ;;
  job) cmd_job "$@" ;;
  slot-job) cmd_slot_job "$@" ;;
  fetch) cmd_fetch "$@" ;;
  *) echo "usage: remote-run.sh bases|receive|related|argv|checks|run|fetch" >&2; exit 2 ;;
esac
