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
#   devapp-start <port> <commit>             start a live test's Harness copy (data folder on stdin); see below
#   devapp-hold|devapp-stop <port>           the tunnel's far end; stop a copy
#   devapp-shell <port>                      run a script from stdin beside a copy
#   devapp-status                            list the copies here
#   devapp-load <port>                       how busy this machine is, and whether that port's copy is here
#   devapp-providers                         which AI tools are installed here
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
  # Let vitest.pool.ts size workers from this machine's spare capacity, including other occupied slots.
  if [ -f "$dir/related.json" ]; then
    LANG=C.UTF-8 node scripts/run-related-tests.mjs "$dir/results.json" < "$dir/related.json"
    code=$?
  elif [ -f "$dir/argv.json" ]; then
    # The arguments stay a list from end to end: no shell here ever reads them.
    LANG=C.UTF-8 node -e '
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
    LANG=C.UTF-8 node node_modules/vitest/vitest.mjs "${args[@]}" \
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

# ---- Harness copies for live tests (scripts/remote-checks/dev-app.js) ------------------------------------------------
# A live-test job's Harness copy runs here instead of on James's Mac: on the test Mac, or on the PC's Linux space with a
# screen of its own that nobody sees (a signed package needs a Mac). Each copy is named by its debugging port, which is
# unique per job, and lives in devapps/apps/<port>: a checkout of its own that shares one install per lock file with
# every other copy (devapps/installs/<stamp>), so Electron's native modules are built once. The copy's job leads its own
# process group, so stopping it stops its screens' server too, and it stops itself after DEVAPP_LIFETIME_SECONDS. Every
# start first removes copies whose job has ended, folder and all, so nothing is kept for long.
DEVAPPS="$BASE/devapps"
DEVAPP_LIMIT=3
DEVAPP_LIFETIME_SECONDS=14400
DEVAPP_INSTALL_WAIT_SECONDS=1200
DEVAPP_READY_SECONDS=120
DEVAPP_SHELL_SECONDS=600
DEVAPP_DIR=

devapp_port_ok() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

devapp_dir() { printf '%s/apps/%s' "$DEVAPPS" "$1"; }

devapp_state() { cat "$1/state" 2>/dev/null || echo none; }

# The job lives as long as the copy. Its id is checked against its command line, since after a restart of this Mac the
# same id may belong to something else. -ww: with no terminal, macOS's ps cuts the line at 79 columns.
devapp_alive() {
  local pid
  pid="$(cat "$1/pid" 2>/dev/null)"
  [ -n "$pid" ] && ps -ww -p "$pid" -o command= 2>/dev/null | grep -qE -- "devapp-job ${1##*/}\$"
}

# Every reason passed here is a fixed phrase from this file, so it never needs escaping.
devapp_result() {
  printf '%s{"status":"%s","reason":"%s"}\n' "$RESULT_PREFIX" "$1" "$2"
}

# On a Mac Harness is opened through the app launcher (see devapp-job), so it isn't in the job's group, and it may start
# itself again under another id (a permission repair does). Every Harness opened for a copy, and nothing else, has the
# copy's checkout folder and its debugging port on its command line, in either order: on Linux, Chromium puts its own
# switches first and the folder last.
devapp_app_pids() {
  local mode executable
  mode="$(cat "$1/mode" 2>/dev/null || echo dev)"
  executable="$(cat "$1/executable" 2>/dev/null)"
  if [ "$mode" = packaged ]; then
    case "$executable" in "$1/repo/"*) ;; *) return 0 ;; esac
  fi
  ps -axo pid=,command= | awk -v mode="$mode" -v exe="$executable" -v work="$1/repo" -v port="--remote-debugging-port=${1##*/}" '
    { pid=$1; $1=""; sub(/^[[:space:]]+/, ""); command=$0;
      if (index(" " command " ", " " port " ") == 0) next;
      if (mode == "packaged" && index(command, exe " ") == 1) print pid;
      else if (mode == "dev" && index(" " command " ", " " work " ") > 0) print pid;
    }'
}

devapp_stop_app() {
  local pids waited=0
  pids="$(devapp_app_pids "$1")"
  [ -n "$pids" ] || return 0
  kill -TERM $pids 2>/dev/null
  while [ -n "$(devapp_app_pids "$1")" ] && [ "$waited" -lt 10 ]; do sleep 1; waited=$((waited + 1)); done
  pids="$(devapp_app_pids "$1")"
  [ -z "$pids" ] || kill -KILL $pids 2>/dev/null
}

devapp_stop_dir() {
  local dir="$1" pid member waited=0
  [ -d "$dir" ] || return 0
  if devapp_alive "$dir"; then
    pid="$(cat "$dir/pid")"
    kill -TERM -- "-$pid" 2>/dev/null
    while devapp_alive "$dir" && [ "$waited" -lt 15 ]; do sleep 1; waited=$((waited + 1)); done
    devapp_alive "$dir" && kill -KILL -- "-$pid" 2>/dev/null
  fi
  # A job killed outright leaves the rest of its group (its time limit, say). While any of them lives the group's id
  # can't be reused, and each is checked as this copy's before it goes.
  pid="$(cat "$dir/pid" 2>/dev/null)"
  if [ -n "$pid" ]; then
    for member in $(pgrep -g "$pid" 2>/dev/null); do
      ps -ww -p "$member" -o command= 2>/dev/null | grep -qE -- "devapp-job ${dir##*/}\$|$dir/|^sleep $DEVAPP_LIFETIME_SECONDS\$" && kill -KILL "$member" 2>/dev/null
    done
  fi
  devapp_stop_app "$dir"
  sweep_orphans "$dir/repo"
  rm -rf "$dir"
}

# Starts take turns, so the count of copies, the joining and the clean-up below see a settled set of folders. The lock
# names the start holding it; one whose holder has gone was left by a start that died, and only its holder unlocks it.
devapp_lock() {
  local tries=0 owner
  mkdir -p "$DEVAPPS" || return 1
  until mkdir "$DEVAPPS/start.lock" 2>/dev/null; do
    owner="$(cat "$DEVAPPS/start.lock/owner" 2>/dev/null)"
    # A lock with no owner yet is being taken: only one older than a minute was left half-made.
    if { [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; } ||
      { [ -z "$owner" ] && [ -n "$(find "$DEVAPPS/start.lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; }; then
      rm -rf "$DEVAPPS/start.lock"
    fi
    [ "$tries" -lt 600 ] || return 1
    sleep 0.2
    tries=$((tries + 1))
  done
  echo "$$" > "$DEVAPPS/start.lock/owner"
}

devapp_unlock() {
  [ "$(cat "$DEVAPPS/start.lock/owner" 2>/dev/null)" = "$$" ] && rm -rf "$DEVAPPS/start.lock"
  return 0
}

# Under the start lock: copies whose job has ended go, then any install that no live copy links to and that nothing
# has used for two days, and any install that failed part-way a day ago and that nobody is retrying.
devapp_tidy() {
  local dir install used
  for dir in "$DEVAPPS"/apps/*; do
    [ -d "$dir" ] && ! devapp_alive "$dir" && devapp_stop_dir "$dir"
  done
  for install in "$DEVAPPS"/installs/*/; do
    install="${install%/}"
    if [ ! -f "$install/done" ]; then
      [ -n "$(find "$install" -maxdepth 0 -mmin +1440 2>/dev/null)" ] && with_lock "$install.lock" true && rm -rf "$install" "$install.lock"
      continue
    fi
    [ -z "$(find "$install/used" -mmin -2880 2>/dev/null)" ] || continue
    used=0
    for dir in "$DEVAPPS"/apps/*; do
      [ "$(readlink "$dir/repo/node_modules" 2>/dev/null)" = "$install/repo/node_modules" ] && used=1
    done
    [ "$used" = 1 ] || rm -rf "$install" "$install.lock"
  done
}

devapp_ends_at() {
  local at
  at=$(($(cat "$1/started" 2>/dev/null || date +%s) + DEVAPP_LIFETIME_SECONDS))
  if [ "$MAC" = 1 ]; then date -r "$at" +%H:%M; else date -d "@$at" +%H:%M; fi
}

# devapp-start <port> <commit>, with the copy's data folder on stdin. Starts the copy, or joins one already starting or
# running from the same files for the same data folder, and streams its progress until it is ready or has failed. A
# live copy for another data folder belongs to another live test, so it is left alone. The last line is the result.
cmd_devapp_start() {
  local port="$1" commit="$2" mode="${3:-dev}" unlock_signing="${4:-0}" data dir other running=0 tail_pid tree joining=0
  devapp_port_ok "$port" || { echo 'remote-run.sh: the debugging port must be a number from 1024 to 65535' >&2; exit 4; }
  case "$commit" in '' | *[!0-9a-f]*) echo 'remote-run.sh: not a commit' >&2; exit 4 ;; esac
  case "$mode" in dev | packaged) ;; *) echo 'remote-run.sh: invalid copy mode' >&2; exit 4 ;; esac
  case "$unlock_signing:$mode" in 0:* | 1:packaged) ;; *) echo 'remote-run.sh: signing unlock requires an owned packaged build' >&2; exit 4 ;; esac
  if [ "$unlock_signing" = 1 ]; then IFS= read -r data; else data="$(cat)"; fi
  # A folder of its own under /tmp, as the runbook gives each job: nothing else here is ever a copy's data.
  case "$data" in /tmp/aio-lt-?*) ;; *) echo 'remote-run.sh: the data folder must start /tmp/aio-lt-' >&2; exit 4 ;; esac
  case "$data" in *..* | *[!A-Za-z0-9._/-]*) echo 'remote-run.sh: the data folder name has characters it cannot have' >&2; exit 4 ;; esac
  # Every send makes a new commit, even of the same files, so the files' tree is what says it is the same copy.
  tree="$(git -C "$REPO" rev-parse --verify --quiet "$commit^{tree}")" || { devapp_result failed 'the snapshot was not received'; return 0; }

  dir="$(devapp_dir "$port")"
  devapp_lock || { devapp_result busy 'another start here is taking too long'; return 0; }
  devapp_tidy
  if devapp_alive "$dir"; then
    if [ "$(cat "$dir/data" 2>/dev/null)" != "$data" ]; then
      devapp_unlock
      devapp_result taken 'another live test already has a Harness copy on that debugging port'
      return 0
    fi
    if [ "$(cat "$dir/mode" 2>/dev/null || echo dev)" != "$mode" ]; then
      devapp_unlock
      devapp_result taken 'the existing copy uses a different package mode'
      return 0
    fi
    if [ "$(cat "$dir/tree" 2>/dev/null)" = "$tree" ]; then
      joining=1
      echo "[dev app] joining the copy already on port $port; it stops by itself at $(devapp_ends_at "$dir")"
    else
      devapp_stop_dir "$dir"
    fi
  fi
  if [ "$joining" = 0 ]; then
    # A data folder belongs to one live test, and Harness runs once per data folder: a live copy of it on another port
    # is that test's earlier copy (a resumed job gets a new port), so it goes rather than block this one.
    for other in "$DEVAPPS"/apps/*; do
      if [ "$other" != "$dir" ] && devapp_alive "$other" && [ "$(cat "$other/data" 2>/dev/null)" = "$data" ]; then
        if [ "$(cat "$other/mode" 2>/dev/null || echo dev)" != "$mode" ]; then
          devapp_unlock
          devapp_result taken 'the profile is already running in a different package mode'
          return 0
        fi
        echo "[dev app] stopping this data folder's earlier copy on port ${other##*/}"
        devapp_stop_dir "$other"
      fi
    done
    for other in "$DEVAPPS"/apps/*; do
      [ -d "$other" ] && devapp_alive "$other" && running=$((running + 1))
    done
    if [ "$running" -ge "$DEVAPP_LIMIT" ]; then
      devapp_unlock
      devapp_result busy 'it already runs as many Harness copies as it takes'
      return 0
    fi
    if [ "$MAC" != 1 ] && [ "$mode" = packaged ]; then devapp_unlock; devapp_result failed 'a signed package needs a Mac'; return 0; fi
    mkdir -p "$dir" "$DEVAPPS/installs" || { devapp_unlock; exit 1; }
    chmod 700 "$dir"
    printf '%s\n' "$data" > "$dir/data"
    printf '%s\n' "$commit" > "$dir/commit"
    printf '%s\n' "$tree" > "$dir/tree"
    printf '%s\n' "$mode" > "$dir/mode"
    printf '%s\n' "$unlock_signing" > "$dir/unlock-signing"
    date +%s > "$dir/started"
    echo building > "$dir/state"
    : > "$dir/log"
    # An explicitly supplied signing password remains only in this pipe. The owned job consumes it before building.
    if [ "$unlock_signing" = 1 ]; then exec 3<&0; else exec 3</dev/null; fi
    perl -e 'setpgrp(0, 0); exec @ARGV or exit 127' bash "$SELF" devapp-job "$port" >> "$dir/log" 2>&1 <&3 &
    exec 3<&-
    echo $! > "$dir/pid"
    echo "[dev app] it stops by itself at $(devapp_ends_at "$dir") unless stopped sooner"
  fi
  devapp_unlock

  tail -n +1 -f "$dir/log" &
  tail_pid=$!
  while [ "$(devapp_state "$dir")" = building ] && devapp_alive "$dir"; do sleep 1; done
  sleep 1
  kill "$tail_pid" 2>/dev/null
  wait "$tail_pid" 2>/dev/null
  if [ "$(devapp_state "$dir")" = ready ] && devapp_alive "$dir"; then
    devapp_result ready ''
  else
    devapp_result failed "$(cat "$dir/reason" 2>/dev/null || echo 'the copy stopped while starting')"
  fi
}

devapp_fail() {
  printf '%s\n' "$1" > "$DEVAPP_DIR/reason"
  echo "[dev app] $1"
  echo failed > "$DEVAPP_DIR/state"
  exit 1
}

# Leaving for any reason stops Harness, then the whole group: the screens' server and the time limit.
devapp_job_end() {
  trap - TERM
  devapp_stop_app "$DEVAPP_DIR"
  [ "$(devapp_state "$DEVAPP_DIR")" = failed ] || echo stopped > "$DEVAPP_DIR/state"
  kill -TERM -- "-$$" 2>/dev/null
}

# devapp-install <install folder> <commit>: run under the install's lock. The install is a checkout of its own, so the
# project's postinstall (Electron's native modules) runs exactly as on any checkout.
cmd_devapp_install() {
  local install="$1" commit="$2"
  [ -f "$install/done" ] && return 0
  rm -rf "$install"
  mkdir -p "$install/repo" && cd "$install/repo" || return 1
  git init -q && git fetch -q "$REPO" "refs/snapshots/$commit" && git checkout -q --force --detach FETCH_HEAD || return 1
  echo '[dev app] installing packages (once for each lock file)'
  bash scripts/ci-npm-ci.sh > "$install/install.log" 2>&1 || { tail -n 30 "$install/install.log"; return 1; }
  touch "$install/done"
}

# devapp-job <port>: the copy itself, leading its own process group.
cmd_devapp_job() {
  local port="$1" data commit work stamp install started code renderer_port mode bundle executable waited=0
  DEVAPP_DIR="$(devapp_dir "$port")"
  data="$(cat "$DEVAPP_DIR/data")"
  commit="$(cat "$DEVAPP_DIR/commit")"
  mode="$(cat "$DEVAPP_DIR/mode")"
  trap devapp_job_end EXIT
  # A stop or the time limit signals the group; leaving through `exit` runs the clean-up above.
  trap 'exit 0' TERM
  # The time limit acts only while this job is still the copy's: if the job was killed outright, the group's id may by
  # then be someone else's.
  local began
  began="$(cat "$DEVAPP_DIR/started" 2>/dev/null)"
  ( sleep "$DEVAPP_LIFETIME_SECONDS"
    # A job killed outright leaves Harness and the screens' server running; they still go, if the folder is still this
    # copy's. The folder itself goes at the next start. (This shell carries the job's name, so it can't use
    # devapp_stop_dir, which would stop it part-way.)
    if ! devapp_alive "$DEVAPP_DIR"; then
      if [ "$(cat "$DEVAPP_DIR/started" 2>/dev/null)" = "$began" ]; then
        devapp_stop_app "$DEVAPP_DIR"
        for member in $(pgrep -g "$$" 2>/dev/null); do
          ps -ww -p "$member" -o command= 2>/dev/null | grep -qF -- "$DEVAPP_DIR/" && kill -KILL "$member" 2>/dev/null
        done
      fi
      exit 0
    fi
    echo '[dev app] stopping: the time limit was reached'
    kill -TERM -- "-$$" ) &

  echo "[dev app] checking out on $(hostname)"
  work="$DEVAPP_DIR/repo"
  mkdir -p "$work" && cd "$work" || devapp_fail 'could not make the checkout folder'
  git init -q || devapp_fail 'could not make the checkout'
  git fetch -q "$REPO" "refs/snapshots/$commit" || devapp_fail 'could not read the snapshot'
  git checkout -q --force --detach FETCH_HEAD || devapp_fail 'could not check out the snapshot'
  ensure_node "$(cat .nvmrc 2>/dev/null)" || devapp_fail 'could not fetch the Node version'

  if [ "$(cat "$DEVAPP_DIR/unlock-signing")" = 1 ]; then
    [ "$mode" = packaged ] || devapp_fail 'signing unlock is only available for an owned packaged build'
    /usr/bin/xcrun swiftc scripts/remote-checks/unlock-signing-keychain.swift -o "$DEVAPP_DIR/unlock-signing-keychain" \
      < /dev/null > "$DEVAPP_DIR/unlock-build.log" 2>&1 || devapp_fail 'could not build the noninteractive signing helper'
    # The parent and this job share one SSH security session. No ACL/partition/trust change or key export occurs.
    perl -e 'alarm 15; exec @ARGV or exit 127' "$DEVAPP_DIR/unlock-signing-keychain" || devapp_fail 'noninteractive signing keychain unlock failed'
  fi

  stamp="$(install_stamp | sha256 | cut -c1-16)"
  install="$DEVAPPS/installs/$stamp"
  started="$(date +%s)"
  while [ ! -f "$install/done" ]; do
    with_lock "$install.lock" bash "$SELF" devapp-install "$install" "$commit"
    code=$?
    [ "$code" -eq 0 ] && break
    [ "$code" -eq "$BUSY" ] || devapp_fail 'the package install failed'
    [ $(($(date +%s) - started)) -lt "$DEVAPP_INSTALL_WAIT_SECONDS" ] || devapp_fail 'another copy took too long to install packages'
    sleep 3
  done
  touch "$install/used"
  ln -sfn "$install/repo/node_modules" node_modules || devapp_fail 'could not link the packages'

  if [ "$mode" = packaged ]; then
    echo '[dev app] building a signed directory package; no install or publication'
    node scripts/remote-checks/live-test-copy.js package "$DEVAPP_DIR" > "$DEVAPP_DIR/package.log" 2>&1 ||
      { tail -n 40 "$DEVAPP_DIR/package.log"; devapp_fail 'the signed live-test package did not build'; }
    bundle="$(cat "$DEVAPP_DIR/bundle")"
    executable="$bundle/Contents/MacOS/Harness"
  else
  echo '[dev app] building the main process'
  npm run build:main > "$DEVAPP_DIR/build.log" 2>&1 || { tail -n 40 "$DEVAPP_DIR/build.log"; devapp_fail 'npm run build:main failed'; }
  # After build:main, which clears dist/. Without this binary the copy's sessions get no orchestrator tools (LT-1103).
  echo '[dev app] building the orchestrator tools helper'
  npm run build:aio-mcp-dist > "$DEVAPP_DIR/aio-mcp.log" 2>&1 ||
    { tail -n 40 "$DEVAPP_DIR/aio-mcp.log"; devapp_fail 'npm run build:aio-mcp-dist failed'; }
  echo '[dev app] building the screens'
  NG_CLI_ANALYTICS=false node node_modules/@angular/cli/bin/ng.js build --configuration development \
    --output-path "$DEVAPP_DIR/renderer" > "$DEVAPP_DIR/renderer.log" 2>&1 ||
    { tail -n 40 "$DEVAPP_DIR/renderer.log"; devapp_fail 'the screens did not build'; }

  bash "$SELF" devapp-serve "$DEVAPP_DIR/renderer/browser" "$DEVAPP_DIR/renderer-port" > "$DEVAPP_DIR/serve.log" 2>&1 &
  while [ ! -s "$DEVAPP_DIR/renderer-port" ]; do
    [ "$waited" -lt 30 ] || devapp_fail 'the screens server did not start'
    sleep 1
    waited=$((waited + 1))
  done
  renderer_port="$(cat "$DEVAPP_DIR/renderer-port")"
  if [ "$MAC" = 1 ]; then executable="$work/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"; else executable="$work/node_modules/electron/dist/electron"; fi
  fi

  node scripts/remote-checks/live-test-copy.js prepare "$DEVAPP_DIR" "$data" "$executable" "$mode" "$(cat "$DEVAPP_DIR/tree")" "$port" ||
    devapp_fail 'the live-test profile or executable could not be owned safely'

  if curl -fsS "http://127.0.0.1:$port/json/version" > /dev/null 2>&1; then
    devapp_fail 'something else already answers on that debugging port here'
  fi
  echo "[dev app] starting Harness with its data in $data"
  # Opened through the app launcher, not started from this shell: a program started over SSH can't read the login
  # keychain, where the AI tools keep their sign-ins. The app gets the logged-in session's environment plus these two.
  # Without the heap flag Harness would start itself again under another process id (src/main/main-process-bootstrap.ts).
  if [ "$mode" = packaged ]; then
  open -n -g -a "$bundle" \
    --stdout "$DEVAPP_DIR/app.out" --stderr "$DEVAPP_DIR/app.err" \
    --env AIO_LIVETEST=1 --env "AIO_LIVETEST_USER_DATA_PATH=$data" --env "AIO_LIVETEST_OWNER_FILE=$DEVAPP_DIR/livetest-owner.json" \
    --args --js-flags=--max-old-space-size=8192 "--remote-debugging-port=$port" ||
    devapp_fail 'the Mac would not open the packaged test copy'
  else
  if [ "$MAC" = 1 ]; then
  open -n -g -a "$work/node_modules/electron/dist/Electron.app" \
    --stdout "$DEVAPP_DIR/app.out" --stderr "$DEVAPP_DIR/app.err" \
    --env "AIO_DEV_USER_DATA_PATH=$data" --env "PORT=$renderer_port" \
    --env AIO_LIVETEST=1 --env "AIO_LIVETEST_USER_DATA_PATH=$data" --env "AIO_LIVETEST_OWNER_FILE=$DEVAPP_DIR/livetest-owner.json" \
    --args --js-flags=--max-old-space-size=8192 "$work" "--remote-debugging-port=$port" ||
    devapp_fail 'the Mac would not open Harness'
  else
    # Linux has no keychain to reach, so Harness starts from this job, on a screen of its own in the job's group. The
    # screen is started apart from Harness rather than through xvfb-run, which would close it if Harness started itself
    # again (LT-731). A copy's packages have no setuid sandbox helper, so Chromium's sandbox is off, as in CI.
    # -fbdir puts the copy's folder on the screen's command line, so a clean-up after the job was killed outright finds it.
    # Only Linux's abstract socket: WSL mounts /tmp/.X11-unix for its own display, and nobody else can make sockets in it.
    Xvfb -displayfd 4 -screen 0 1920x1200x24 -nolisten tcp -nolisten unix -fbdir "$DEVAPP_DIR/" 4> "$DEVAPP_DIR/display" > "$DEVAPP_DIR/xvfb.log" 2>&1 &
    waited=0
    until [ -s "$DEVAPP_DIR/display" ]; do
      [ "$waited" -lt 30 ] || devapp_fail 'the screen for Harness did not start'
      sleep 1
      waited=$((waited + 1))
    done
    DISPLAY=":$(tr -dc 0-9 < "$DEVAPP_DIR/display")" AIO_DEV_USER_DATA_PATH="$data" PORT="$renderer_port" AIO_LIVETEST=1 \
      AIO_LIVETEST_USER_DATA_PATH="$data" AIO_LIVETEST_OWNER_FILE="$DEVAPP_DIR/livetest-owner.json" \
      "$executable" --js-flags=--max-old-space-size=8192 "$work" "--remote-debugging-port=$port" --no-sandbox \
      < /dev/null > "$DEVAPP_DIR/app.out" 2> "$DEVAPP_DIR/app.err" &
  fi
  fi
  waited=0
  # Ready once Harness's window exists, which its debugging port lists as a page; the port itself answers sooner.
  until { curl -fsS "http://127.0.0.1:$port/json/list" 2> /dev/null | grep -q '"type": *"page"'; } &&
    node scripts/remote-checks/live-test-copy.js ready "$DEVAPP_DIR" > /dev/null; do
    if [ "$waited" -ge 60 ] && [ -z "$(devapp_app_pids "$DEVAPP_DIR")" ]; then
      tail -n 40 "$DEVAPP_DIR/app.err"
      devapp_fail 'Harness stopped while starting'
    fi
    [ "$waited" -lt "$DEVAPP_READY_SECONDS" ] || { tail -n 40 "$DEVAPP_DIR/app.err"; devapp_fail 'Harness did not open its debugging port'; }
    sleep 1
    waited=$((waited + 1))
  done
  [ -n "$(devapp_app_pids "$DEVAPP_DIR")" ] || devapp_fail 'Harness stopped while starting'
  local runtime_pid
  runtime_pid="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pid))' "$DEVAPP_DIR/runtime.json")"
  devapp_app_pids "$DEVAPP_DIR" | grep -qx "$runtime_pid" || devapp_fail 'the runtime receipt does not name this owned process'
  echo ready > "$DEVAPP_DIR/state"
  echo "[dev app] ready on port $port"
  while [ -n "$(devapp_app_pids "$DEVAPP_DIR")" ]; do sleep 5; done
  echo '[dev app] Harness has exited'
}

# The screens' server for a copy, in place of `ng serve`: serves the built screens, sending index.html for any path that
# names no file, as the screens' own routes expect. It listens on a free port on 127.0.0.1 and writes the port to the
# file given. It lives here, not in the snapshot, so a worktree made before it existed still gets it.
DEVAPP_SERVE_JS='
const fs = require("fs");
const http = require("http");
const path = require("path");
const [root, portFile] = process.argv.slice(1).map(given => path.resolve(given));
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".wasm": "application/wasm",
};
function fileFor(url) {
  let name;
  try { name = decodeURIComponent(new URL(url, "http://localhost").pathname); } catch { return path.join(root, "index.html"); }
  const file = path.resolve(root, "." + name);
  const found = file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
  return found ? file : path.join(root, "index.html");
}
const server = http.createServer((request, response) => {
  const file = fileFor(request.url || "/");
  fs.readFile(file, (err, body) => {
    if (err) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": types[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile + ".tmp", server.address().port + "\n");
  fs.renameSync(portFile + ".tmp", portFile);
});
'

# devapp-serve <folder> <port file>
cmd_devapp_serve() {
  exec node -e "$DEVAPP_SERVE_JS" "$1" "$2"
}

# devapp-hold <port>: the far end of the Mac's tunnel. Says so once, then lasts as long as the copy, so the tunnel
# closes when the copy stops for any reason.
cmd_devapp_hold() {
  local dir
  devapp_port_ok "$1" || exit 4
  dir="$(devapp_dir "$1")"
  echo held
  while devapp_alive "$dir" && [ "$(devapp_state "$dir")" = ready ]; do sleep 5; done
}

# devapp-shell <port>, with a script on stdin: runs it in the copy's checkout with the copy's data folder named in
# AIO_DEV_USER_DATA_PATH, for reading its logs and database.
cmd_devapp_shell() {
  local dir
  devapp_port_ok "$1" || exit 4
  dir="$(devapp_dir "$1")"
  [ -d "$dir/repo" ] || { echo "remote-run.sh: there is no Harness copy on port $1 here" >&2; exit 3; }
  cd "$dir/repo" || exit 1
  ensure_node "$(cat .nvmrc 2>/dev/null)" || true
  export AIO_DEV_USER_DATA_PATH
  AIO_DEV_USER_DATA_PATH="$(cat "$dir/data")"
  # Nothing over SSH stops a command whose connection has gone (a `tail -f`, say), so it runs in a group of its own
  # for at most the time the Mac waits for it. Bash gives a background job /dev/null as stdin, hence the copy on 3.
  local script_pid watchdog code
  exec 3<&0
  perl -e 'setpgrp(0, 0); exec @ARGV or exit 127' bash -s <&3 &
  script_pid=$!
  exec 3<&-
  ( trap 'kill "$timer" 2>/dev/null; exit 0' TERM; sleep "$DEVAPP_SHELL_SECONDS" & timer=$!; wait "$timer"
    kill -TERM -- "-$script_pid" 2>/dev/null; sleep 5; kill -KILL -- "-$script_pid" 2>/dev/null ) &
  watchdog=$!
  wait "$script_pid"
  code=$?
  kill "$watchdog" 2>/dev/null
  # Anything the script left running in the background (a `tail -f &`) would hold the connection open.
  kill -KILL -- "-$script_pid" 2>/dev/null
  return "$code"
}

cmd_devapp_stop() {
  devapp_port_ok "$1" || exit 4
  devapp_stop_dir "$(devapp_dir "$1")"
  echo "stopped the Harness copy on port $1"
}

# devapp-load <port>: one result line with the 5-minute load average, the processors, the live copies and, when the
# copy on that port is one of them, its files' tree, data folder and mode, so dev-app.js can pass a busy machine by and
# go back to the one with its copy. `kept` says that port's folder is still here, live or not, so `shell` can read a
# stopped copy's logs. Every value is a number or a fixed-form name, so none needs escaping.
cmd_devapp_load() {
  local load cores dir copies=0 copy=null kept=false
  devapp_port_ok "${1:-}" || exit 4
  dir="$(devapp_dir "$1")"
  [ -d "$dir" ] && kept=true
  if devapp_alive "$dir"; then
    copy="$(printf '{"tree":"%s","data":"%s","mode":"%s"}' "$(cat "$dir/tree" 2>/dev/null)" "$(cat "$dir/data" 2>/dev/null)" "$(cat "$dir/mode" 2>/dev/null || echo dev)")"
  fi
  if [ "$MAC" = 1 ]; then
    # C locale: in some others the decimal point is a comma, which is not JSON.
    load="$(LC_ALL=C sysctl -n vm.loadavg | awk '{print $3}')"
    cores="$(sysctl -n hw.ncpu)"
  else
    load="$(awk '{print $2}' /proc/loadavg)"
    cores="$(nproc)"
  fi
  for dir in "$DEVAPPS"/apps/*; do
    [ -d "$dir" ] && devapp_alive "$dir" && copies=$((copies + 1))
  done
  printf '%s{"load":%s,"cores":%s,"copies":%s,"limit":%s,"copy":%s,"kept":%s}\n' "$RESULT_PREFIX" "$load" "$cores" "$copies" "$DEVAPP_LIMIT" "$copy" "$kept"
}

# devapp-providers: one result line naming which AI tools are installed here, so `dev-app.js start --needs` can pick a
# computer before building anything. The names are this fixed list (never input). They are looked for on the account's
# login-shell PATH, which is what the copy's own tool detection reads, plus the folders tools usually install into that a
# profile may only add for interactive shells. Installed only: whether one is signed in is the copy's own business (a Mac
# login keychain can't be read over SSH).
DEVAPP_PROVIDERS='claude codex copilot gemini agy opencode cursor-agent grok'
cmd_devapp_providers() {
  local login_shell="${SHELL:-/bin/sh}" extra="" dir found name listed="" probe
  [ -x "$login_shell" ] || login_shell=/bin/sh
  for dir in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.npm-global/bin" "$HOME/.bun/bin" "$HOME/.volta/bin" "$HOME"/.nvm/versions/node/*/bin; do
    # The folder is written into the script below, so one with a quote, a dollar sign or a space is left out.
    case "$dir" in *[!A-Za-z0-9._/-]*) continue ;; esac
    [ -d "$dir" ] && extra="$extra:$dir"
  done
  # The login shell hands its PATH to a plain sh, which does the looking, so no shell's own syntax matters.
  probe='PATH="$PATH'"$extra"'"; for name in '"$DEVAPP_PROVIDERS"'; do command -v "$name" > /dev/null 2>&1 && echo "provider:$name"; done'
  found="$("$login_shell" -l -c 'exec /bin/sh -c "$0"' "$probe" < /dev/null 2> /dev/null)"
  for name in $DEVAPP_PROVIDERS; do
    printf '%s\n' "$found" | grep -qx "provider:$name" && listed="$listed${listed:+,}\"$name\""
  done
  printf '%s{"installed":[%s]}\n' "$RESULT_PREFIX" "$listed"
}

cmd_devapp_status() {
  local dir port found=0
  for dir in "$DEVAPPS"/apps/*; do
    [ -d "$dir" ] || continue
    found=1
    port="${dir##*/}"
    if devapp_alive "$dir"; then
      echo "port $port: $(devapp_state "$dir"), data in $(cat "$dir/data" 2>/dev/null), stops by itself at $(devapp_ends_at "$dir")"
    else
      echo "port $port: $(devapp_state "$dir") ($(cat "$dir/reason" 2>/dev/null || echo 'not running'))"
    fi
  done
  [ "$found" = 1 ] || echo 'no Harness copies here'
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
  devapp-start) cmd_devapp_start "$@" ;;
  devapp-job) cmd_devapp_job "$@" ;;
  devapp-install) cmd_devapp_install "$@" ;;
  devapp-serve) cmd_devapp_serve "$@" ;;
  devapp-hold) cmd_devapp_hold "$@" ;;
  devapp-shell) cmd_devapp_shell "$@" ;;
  devapp-stop) cmd_devapp_stop "$@" ;;
  devapp-status) cmd_devapp_status ;;
  devapp-load) cmd_devapp_load "$@" ;;
  devapp-providers) cmd_devapp_providers ;;
  *) echo "usage: remote-run.sh bases|receive|related|argv|checks|run|fetch|devapp-start|devapp-shell|devapp-stop|devapp-status|devapp-load|devapp-providers" >&2; exit 2 ;;
esac
