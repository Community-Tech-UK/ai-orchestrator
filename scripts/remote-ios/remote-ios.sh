#!/usr/bin/env bash
# Runs on the test Mac. scripts/remote-ios/aio-ios.js sends this file with every command, so nothing needs deploying.
#
#   bases                            list commits the app's store already has          (AIO_IOS_APP set)
#   receive <commit> <base|none>     take a git pack on stdin and name the snapshot     (AIO_IOS_APP set)
#   put <id>                         take the request on stdin, a gzipped tar: recipe.sh, and args, flows or inputs
#   job <id> <session> <action>      build, run, test, sim or logs, streaming output; the last line is the result
#   fetch <id>                       send what the job made, as a gzipped tar, then tidy up
#   status <session>                 say what this session holds, and who holds the simulators
#   stop <session>                   end this session's jobs and free its simulator
#
# A session owns a simulator slot from its first job until `stop`, or until it has run nothing for IDLE_SECONDS. Each
# slot has one simulator, named aio-ios-slot-<n>, which stays booted between jobs: a freshly booted or erased simulator
# leaves Capacitor apps blank for a minute or two. A new owner starts by uninstalling what the last one installed.
#
# A job leads its own process group, as remote-run.sh's runs do on a Mac. It is stopped when the connection closes, at
# the time limit, or by `stop`, and anything left whose working folder is inside the app's checkout goes too.
# Simulators belong to CoreSimulator, not to the job, so they stay up.
#
# Written for the bash 3.2 that macOS ships.
set -u

SELF="$(readlink -f "$0")"
BASE="$(dirname "$SELF")"
APP="${AIO_IOS_APP:-}"
SLOT_COUNT=1
# Shorter only in tests.
IDLE_SECONDS="${AIO_IOS_IDLE_SECONDS:-1800}"
SLOT_WAIT_SECONDS="${AIO_IOS_SLOT_WAIT_SECONDS:-2700}"
JOB_LIMIT_SECONDS=5400
SNAPSHOT_MAX_AGE_SECONDS=86400
BASE_LIMIT=200
BUSY=75
RESULT_PREFIX='AIO_IOS_RESULT '
SIM_PREFIX='aio-ios-slot-'

# An ssh command reads no login profile. Homebrew's node, pnpm and Java come after the system's own tools.
PATH="$PATH:/opt/homebrew/bin"
[ -d /opt/homebrew/opt/openjdk@21 ] && export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
MAESTRO="${AIO_IOS_MAESTRO:-$HOME/.maestro/bin/maestro}"
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0

say() { echo "[aio-ios] $*"; }

valid_name() {
  case "$1" in '' | *[!A-Za-z0-9._-]* | .*) return 1 ;; esac
}

valid_commit() {
  case "$1" in '' | *[!0-9a-f]*) return 1 ;; esac
}

# Runs the rest of the arguments holding an exclusive lock on the first. With `wait`, it waits for the lock, printing
# AIO_WAIT_NOTE once a minute if that is set; otherwise it exits BUSY at once.
lock_and_run() {
  local mode="$1" lock="$2"
  shift 2
  AIO_BUSY="$BUSY" AIO_WAIT="$mode" perl -MFcntl=:flock -e '
    $^F = 255;  # keep the lock open across exec
    $| = 1;
    open(my $held, ">>", shift) or exit 1;
    if (!flock($held, LOCK_EX | LOCK_NB)) {
      exit $ENV{AIO_BUSY} unless $ENV{AIO_WAIT} eq "wait";
      my $waited = 0;
      until (flock($held, LOCK_EX | LOCK_NB)) {
        print "[aio-ios] $ENV{AIO_WAIT_NOTE} (" . $waited / 60 . " min so far)\n" if $ENV{AIO_WAIT_NOTE} && $waited % 60 == 0 && $waited;
        sleep 1;
        $waited++;
      }
    }
    exec @ARGV or exit 127;
  ' "$lock" "$@"
}

app_home() { echo "$BASE/apps/$APP"; }

ensure_repo() {
  local repo
  repo="$(app_home)/repo.git"
  [ -d "$repo" ] || { mkdir -p "$(app_home)" && git init -q --bare "$repo"; }
}

cmd_bases() {
  ensure_repo
  git -C "$(app_home)/repo.git" for-each-ref --sort=-committerdate "--count=$BASE_LIMIT" --format='%(objectname)' refs/bases/
}

tidy() {
  local repo now name stamp
  repo="$(app_home)/repo.git"
  now="$(date +%s)"
  git -C "$repo" for-each-ref --format='%(refname) %(committerdate:unix)' refs/snapshots/ |
    while read -r name stamp; do
      if [ $((now - stamp)) -gt "$SNAPSHOT_MAX_AGE_SECONDS" ]; then git -C "$repo" update-ref -d "$name"; fi
    done
  git -C "$repo" for-each-ref --sort=-committerdate --format='%(refname)' refs/bases/ | tail -n "+$((BASE_LIMIT + 1))" |
    while read -r name; do git -C "$repo" update-ref -d "$name"; done
  find "$BASE/jobs" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf {} + 2>/dev/null
  find "$BASE" -maxdepth 1 -name 'remote-ios-*' -mtime +7 -delete 2>/dev/null
  if [ -z "$(find "$(app_home)/last-gc" -mmin -1440 2>/dev/null)" ]; then
    touch "$(app_home)/last-gc"
    lock_and_run now "$(app_home)/gc.lock" git -C "$repo" gc --quiet --prune=2.days.ago
  fi
}

cmd_receive() {
  local commit="$1" base="$2" repo
  valid_commit "$commit" || exit 2
  ensure_repo
  repo="$(app_home)/repo.git"
  git -C "$repo" index-pack --stdin --fix-thin >/dev/null || exit 1
  git -C "$repo" update-ref "refs/snapshots/$commit" "$commit" || exit 1
  if [ "$base" != none ]; then git -C "$repo" update-ref "refs/bases/$base" "$base" || exit 1; fi
  tidy || true
}

cmd_put() {
  local id="$1"
  valid_name "$id" || exit 2
  mkdir -p "$BASE/jobs/$id/in" || exit 1
  tar -xzf - -C "$BASE/jobs/$id/in" || exit 1
}

# --- Slots -----------------------------------------------------------------------------------------------------------

# A session is busy while one of its jobs is still running, however long ago it started.
session_busy() {
  local session="$1" job
  for job in "$BASE"/jobs/*/; do
    [ -f "$job/session" ] && [ "$(cat "$job/session")" = "$session" ] || continue
    [ -e "$job/finished" ] && continue
    kill -0 -- "-$(cat "$job/pgid" 2>/dev/null)" 2>/dev/null && return 0
  done
  return 1
}

# Under slots.lock. Prints "<slot> <fresh>": fresh is 1 when the slot has just changed hands. Exits BUSY when every
# slot is someone else's.
cmd_claim() {
  local session="$1" now n owner stamp
  now="$(date +%s)"
  for n in $(seq 1 "$SLOT_COUNT"); do
    read -r owner stamp 2>/dev/null < "$BASE/slots/$n/lease" || continue
    if [ "$owner" = "$session" ]; then
      echo "$session $now" > "$BASE/slots/$n/lease"
      echo "$n 0"
      return 0
    fi
  done
  for n in $(seq 1 "$SLOT_COUNT"); do
    mkdir -p "$BASE/slots/$n"
    if read -r owner stamp 2>/dev/null < "$BASE/slots/$n/lease"; then
      [ $((now - stamp)) -gt "$IDLE_SECONDS" ] || continue
      session_busy "$owner" && continue
    fi
    echo "$session $now" > "$BASE/slots/$n/lease"
    echo "$n 1"
    return 0
  done
  exit "$BUSY"
}

# Under slots.lock. Marks the session's slot as used now, at the end of a job.
cmd_touch() {
  local session="$1" n owner stamp
  for n in $(seq 1 "$SLOT_COUNT"); do
    read -r owner stamp 2>/dev/null < "$BASE/slots/$n/lease" || continue
    [ "$owner" = "$session" ] && echo "$session $(date +%s)" > "$BASE/slots/$n/lease"
  done
  return 0
}

# Under slots.lock. Prints the slot the session held, if any, and lets it go.
cmd_release() {
  local session="$1" n owner stamp
  for n in $(seq 1 "$SLOT_COUNT"); do
    read -r owner stamp 2>/dev/null < "$BASE/slots/$n/lease" || continue
    if [ "$owner" = "$session" ]; then
      rm -f "$BASE/slots/$n/lease"
      echo "$n"
    fi
  done
  return 0
}

# Prints the slot the session holds now, or nothing.
held_slot() {
  local session="$1" n owner stamp
  for n in $(seq 1 "$SLOT_COUNT"); do
    read -r owner stamp 2>/dev/null < "$BASE/slots/$n/lease" || continue
    [ "$owner" = "$session" ] && { echo "$n"; return 0; }
  done
  return 1
}

under_slots_lock() {
  mkdir -p "$BASE/slots"
  lock_and_run wait "$BASE/slots.lock" bash "$SELF" "$@"
}

# Waits for a slot, saying so once a minute. Sets SLOT and FRESH.
take_slot() {
  local session="$1" started claimed announced=0
  started="$(date +%s)"
  while :; do
    claimed="$(under_slots_lock claim "$session")" && break
    local waited=$(($(date +%s) - started))
    if [ "$waited" -ge "$SLOT_WAIT_SECONDS" ]; then return 1; fi
    if [ $((waited / 60)) -ge "$announced" ]; then
      say "waiting for the iPhone simulator: another session is using it ($((waited / 60)) min so far)"
      announced=$((waited / 60 + 1))
    fi
    sleep 5
  done
  SLOT="${claimed% *}"
  FRESH="${claimed#* }"
}

sim_udid() {
  xcrun simctl list devices | sed -n "s/^ *$SIM_PREFIX$1 (\([0-9A-Fa-f-]*\)) .*/\1/p" | head -n 1
}

# The slot's simulator, made if it doesn't exist yet, and booted. Prints its id.
ensure_sim() {
  local slot="$1" udid type runtime
  udid="$(sim_udid "$slot")"
  if [ -z "$udid" ]; then
    type="${AIO_IOS_DEVICE_TYPE:-$(xcrun simctl list devicetypes | sed -n 's/^iPhone \([0-9][0-9]*\) Pro (\(com[^)]*\))$/\1 \2/p' | sort -n | tail -n 1 | cut -d' ' -f2)}"
    runtime="$(xcrun simctl list runtimes | sed -n 's/.*\(com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]*\)$/\1/p' | sort -V | tail -n 1)"
    [ -n "$type" ] && [ -n "$runtime" ] || return 1
    udid="$(xcrun simctl create "$SIM_PREFIX$slot" "$type" "$runtime")" || return 1
  fi
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || return 1
  echo "$udid"
}

# Uninstalls what aio-ios installed in the slot, apart from `keep`: for a new owner, so a session starts clean without
# erasing the simulator, and before each install, so only the app under test is there.
clear_slot_apps() {
  local slot="$1" udid="$2" keep="${3:-}" bundle kept=0
  while read -r bundle; do
    [ -n "$bundle" ] || continue
    [ "$bundle" = "$keep" ] && { kept=1; continue; }
    xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1
    xcrun simctl uninstall "$udid" "$bundle" >/dev/null 2>&1
  done 2>/dev/null < "$BASE/slots/$slot/apps"
  if [ "$kept" = 1 ]; then echo "$keep" > "$BASE/slots/$slot/apps"; else : > "$BASE/slots/$slot/apps"; fi
}

# --- The work --------------------------------------------------------------------------------------------------------

# A version a project names only by major, like 22, becomes the newest we already have, or the newest there is.
full_node_version() {
  case "$1" in
    v*.*.*) echo "$1" ;;
    *.*.*) echo "v$1" ;;
    *)
      local major="${1#v}" have
      have="$(ls -d "$BASE/node/v$major".* 2>/dev/null | sort -V | tail -n 1)"
      if [ -n "$have" ]; then basename "$have"
      else curl -fsSL "https://nodejs.org/dist/latest-v$major.x/" | grep -o "node-v$major\.[0-9.]*-darwin-arm64" | head -n 1 | sed -e 's/^node-//' -e 's/-darwin-arm64$//'
      fi
      ;;
  esac
}

ensure_node() {
  local version dir staging
  version="$(full_node_version "$1")"
  [ -n "$version" ] || return 1
  dir="$BASE/node/$version"
  if [ ! -x "$dir/bin/node" ]; then
    mkdir -p "$BASE/node"
    staging="$(mktemp -d "$BASE/node/.fetch-XXXXXX")"
    curl -fsSL "https://nodejs.org/dist/$version/node-$version-darwin-arm64.tar.xz" |
      tar -xJ --strip-components=1 -C "$staging" || { rm -rf "$staging"; return 1; }
    if [ -e "$dir" ]; then rm -rf "$staging"; else mv "$staging" "$dir"; fi
  fi
  PATH="$dir/bin:$PATH"
}

# The job's outcome, as one line of JSON. Every value is a fixed word, hex, a number or a simulator id.
write_result() {
  local status="$1" stage="$2" exit_code="$3"
  printf '{"status":"%s","stage":"%s","exit":%s,"tree":"%s","slot":"%s","udid":"%s"}\n' \
    "$status" "$stage" "$exit_code" "$(cat "$JOB/tree" 2>/dev/null)" "${SLOT:-}" "${UDID:-}" > "$JOB/result.tmp"
  mv "$JOB/result.tmp" "$JOB/result"
}

# A fault of the test Mac's, not of the app: the caller says the job couldn't run.
machine_fault() {
  say "$2"
  echo "$2" > "$JOB/reason"
  write_result setup-failed "$1" 1
  exit 0
}

# A step of the app's own failed: its log's last lines, and the step's exit code.
step_failed() {
  local stage="$1" code="$2" log="$3"
  say "$stage failed (exit $code). The last lines of $(basename "$log"):"
  tail -n 30 "$log"
  write_result ok "$stage" "$code"
  exit 0
}

load_request() {
  JOB="$BASE/jobs/$1"
  [ -f "$JOB/in/recipe.sh" ] || { echo "remote-ios.sh: no request for $1" >&2; exit 2; }
  # shellcheck source=/dev/null
  . "$JOB/in/recipe.sh"
  # `sim` needs no app.
  [ -z "$APP" ] || valid_name "$APP" || { echo "remote-ios.sh: bad app name" >&2; exit 2; }
  mkdir -p "$JOB/out"
}

# Inside the app's build lock: the snapshot into the app's own checkout, packages, the web build, `cap sync`, and
# xcodebuild for the slot's simulator. The built app is cloned into the job, so a later build can't change it.
cmd_build_locked() {
  load_request "$1"
  UDID="$2"
  SLOT="$3"
  local home checkout version stamp code product
  home="$(app_home)"
  checkout="$home/checkout"
  mkdir -p "$checkout" && cd "$checkout" || machine_fault checkout 'could not open the checkout folder'
  pwd -P > "$JOB/work"
  [ -d .git ] || git init -q || machine_fault checkout 'could not make the checkout'
  git fetch -q "$home/repo.git" "refs/snapshots/$COMMIT" || machine_fault checkout 'could not read the snapshot'
  git checkout -q --force --detach FETCH_HEAD || machine_fault checkout 'could not check out the snapshot'
  git clean -ffdxq -e node_modules -e Pods || machine_fault checkout 'could not clean the checkout'
  git rev-parse 'HEAD^{tree}' > "$JOB/tree"

  version="${NODE_VERSION:-}"
  [ -n "${NODE_FILE:-}" ] && version="$(tr -d ' \n' < "$NODE_FILE" 2>/dev/null)"
  if [ -n "$version" ]; then
    ensure_node "$version" || machine_fault node "could not fetch Node $version"
  fi
  command -v node >/dev/null || machine_fault node 'there is no Node here'
  # A repository's scripts call pnpm by name. Corepack's pnpm, first on PATH, is the version its packageManager names,
  # where Homebrew's would be whatever Homebrew has.
  if command -v corepack >/dev/null; then
    mkdir -p "$BASE/corepack/$(node -v)"
    corepack enable --install-directory "$BASE/corepack/$(node -v)" pnpm >/dev/null 2>&1 && PATH="$BASE/corepack/$(node -v):$PATH"
  fi

  stamp="$( (cat $INSTALL_INPUTS 2>/dev/null; declare -f recipe_install; node -v) | shasum -a 256 | cut -d' ' -f1)"
  if [ "$stamp" != "$(cat "$home/install-stamp" 2>/dev/null)" ]; then
    say 'installing packages'
    rm -f "$home/install-stamp"
    (recipe_install) > "$JOB/out/install.log" 2>&1
    code=$?
    [ "$code" -eq 0 ] || step_failed install "$code" "$JOB/out/install.log"
    echo "$stamp" > "$home/install-stamp"
  fi

  say 'building the web app'
  (cd "$APP_DIR" && recipe_web) > "$JOB/out/web-build.log" 2>&1
  code=$?
  [ "$code" -eq 0 ] || step_failed 'web build' "$code" "$JOB/out/web-build.log"

  say 'copying it into the iPhone project'
  (cd "$APP_DIR" && recipe_sync) > "$JOB/out/cap-sync.log" 2>&1
  code=$?
  [ "$code" -eq 0 ] || step_failed 'cap sync' "$code" "$JOB/out/cap-sync.log"

  say "building for the simulator (Xcode $(xcodebuild -version | sed -n 's/^Xcode //p'))"
  xcodebuild "-$XCODE_KIND" "$APP_DIR/$XCODE_PATH" -scheme "$SCHEME" -configuration Debug \
    -destination "id=$UDID" -derivedDataPath "$home/DerivedData" CODE_SIGNING_ALLOWED=NO build \
    > "$JOB/out/xcodebuild.log" 2>&1
  code=$?
  if [ "$code" -ne 0 ]; then
    grep -E ': error: |^error: ' "$JOB/out/xcodebuild.log" | sort -u | head -n 20
    step_failed xcodebuild "$code" "$JOB/out/xcodebuild.log"
  fi

  for product in "$home"/DerivedData/Build/Products/Debug-iphonesimulator/*.app; do
    [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$product/Info.plist" 2>/dev/null)" = "$BUNDLE_ID" ] || continue
    rm -rf "$JOB/App.app"
    cp -Rc "$product" "$JOB/App.app" 2>/dev/null || cp -R "$product" "$JOB/App.app" || machine_fault xcodebuild 'could not copy the built app'
    /usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$product/Info.plist" > "$home/executable"
    say "built $BUNDLE_ID"
    return 0
  done
  say "xcodebuild finished, but no app with the bundle id $BUNDLE_ID was built"
  write_result ok xcodebuild 1
  exit 0
}

# One app at a time on the simulator: another left from the session's earlier work can answer this one's links or
# show over it.
install_app() {
  clear_slot_apps "$SLOT" "$UDID" "$BUNDLE_ID"
  [ "${FRESH_INSTALL:-0}" = 1 ] && xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1
  xcrun simctl install "$UDID" "$JOB/App.app" > "$JOB/out/install-app.log" 2>&1 || step_failed 'installing the app' $? "$JOB/out/install-app.log"
  echo "$BUNDLE_ID" > "$BASE/slots/$SLOT/apps"
}

# Launches the app and waits for the screen to settle: two screenshots a moment apart that match, or the time limit.
launch_and_shoot() {
  local shot="$JOB/out/.shot.png" previous='' current waited=0
  xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE_ID" > "$JOB/out/launch.log" 2>&1 ||
    step_failed launch $? "$JOB/out/launch.log"
  say "launched $BUNDLE_ID; waiting up to ${SETTLE_SECONDS}s for the screen to settle"
  sleep 3
  while :; do
    xcrun simctl io "$UDID" screenshot "$shot" >/dev/null 2>&1 || machine_fault screenshot 'could not take a screenshot'
    current="$(shasum -a 256 "$shot" | cut -d' ' -f1)"
    [ "$current" = "$previous" ] && break
    [ "$waited" -ge "$SETTLE_SECONDS" ] && { say 'the screen was still changing; this is the latest'; break; }
    previous="$current"
    sleep 2
    waited=$((waited + 2))
  done
  mv "$shot" "$JOB/out/screenshot.png"
  say 'screenshot taken'
}

run_maestro() {
  local flow flows=() value values=() code
  while IFS= read -r -d '' value; do
    case "$value" in [A-Za-z_]*=*) values+=(-e "$value") ;; *) step_failed maestro 2 /dev/null ;; esac
  done < "$JOB/in/flow-env"
  while IFS= read -r -d '' flow; do
    case "/$flow/" in */../* | //*) step_failed maestro 2 /dev/null ;; esac
    flows+=("$flow")
  done < "$JOB/in/flows"
  [ "${#flows[@]}" -gt 0 ] || step_failed maestro 2 /dev/null
  [ -x "$MAESTRO" ] || machine_fault maestro 'Maestro is not installed here'
  say "running ${#flows[@]} Maestro flow(s)"
  (cd "$(cat "$JOB/work")" && "$MAESTRO" --udid "$UDID" test -e "APP_ID=$BUNDLE_ID" ${values[@]+"${values[@]}"} --format JUNIT --output "$JOB/out/maestro-report.xml" \
    --test-output-dir "$JOB/out/maestro" "${flows[@]}") 2>&1 | tee "$JOB/out/maestro.log"
  code="${PIPESTATUS[0]}"
  write_result ok maestro "$code"
}

# simctl with the agent's arguments: @DEVICE@ is the slot's simulator, @IN@ and @OUT@ the job's folders. aio-ios.js
# only sends subcommands on its list, and this checks the first word again.
run_simctl() {
  local arg args=() code video_pid guard
  while IFS= read -r -d '' arg; do
    case "$arg" in
      @DEVICE@) arg="$UDID" ;;
      @IN@/*) arg="$JOB/in/files/${arg#@IN@/}" ;;
      @OUT@/*) arg="$JOB/out/${arg#@OUT@/}" ;;
    esac
    args+=("$arg")
  done < "$JOB/in/args"
  case "${args[0]:-}" in
    list | io | openurl | push | privacy | launch | terminate | uninstall | get_app_container | addmedia | status_bar | ui | location) ;;
    *) echo "remote-ios.sh: simctl ${args[0]:-} is not on the list" >&2; write_result refused sim 2; exit 0 ;;
  esac
  if [ "${args[0]}" = io ] && [ "${args[2]:-}" = recordVideo ]; then
    xcrun simctl "${args[@]}" 2>&1 &
    video_pid=$!
    sleep "${VIDEO_SECONDS:-10}"
    # simctl finishes the file when it gets SIGINT, which it catches itself: a background job here starts with SIGINT
    # ignored. Should it ever not stop, it is ended rather than holding the job for its whole time limit.
    kill -INT "$video_pid" 2>/dev/null
    ( trap '[ -n "${timer:-}" ] && kill "$timer" 2>/dev/null; exit 0' TERM; sleep 15 & timer=$!; wait "$timer"; kill -TERM "$video_pid" 2>/dev/null ) &
    guard=$!
    wait "$video_pid"
    code=$?
    kill "$guard" 2>/dev/null
    # simctl ends a recording it was asked to stop with SIGINT's code.
    [ "$code" -eq 130 ] && code=0
  else
    xcrun simctl "${args[@]}" 2>&1
    code=$?
  fi
  write_result ok sim "$code"
}

run_logs() {
  local exe log_pid
  exe="$(cat "$(app_home)/executable" 2>/dev/null)"
  [ -n "$exe" ] || exe=App
  say "app log for $LOG_SECONDS seconds (process $exe)"
  xcrun simctl spawn "$UDID" log stream --style compact --level debug --predicate "process == \"$exe\"" > "$JOB/out/logs.txt" 2>&1 &
  log_pid=$!
  sleep "$LOG_SECONDS"
  kill "$log_pid" 2>/dev/null
  wait "$log_pid" 2>/dev/null
  cat "$JOB/out/logs.txt"
  write_result ok logs 0
}

# The job's main program, leading its own process group.
cmd_work() {
  local id="$1" session="$2" action="$3" code
  load_request "$id"
  if [ "$action" = sim ] || [ "$action" = logs ]; then
    SLOT="$(held_slot "$session")" || {
      say "this session has no iPhone simulator on the test Mac. Start with: aio-ios run"
      write_result no-job "$action" 1
      exit 0
    }
    under_slots_lock touch "$session" >/dev/null
  else
    take_slot "$session" || { write_result no-slot slot 1; exit 0; }
  fi
  say "simulator slot $SLOT on $(hostname -s)"
  UDID="$(ensure_sim "$SLOT")" || machine_fault simulator 'could not start the simulator'
  [ "${FRESH:-0}" = 1 ] && clear_slot_apps "$SLOT" "$UDID"

  case "$action" in
    build | run | test)
      valid_commit "${COMMIT:-}" || machine_fault checkout 'no snapshot was named'
      AIO_WAIT_NOTE='waiting for another build of this app to finish' lock_and_run wait "$(app_home)/build.lock" bash "$SELF" build-locked "$id" "$UDID" "$SLOT"
      code=$?
      [ "$code" -eq 0 ] || machine_fault build "the build stopped unexpectedly (exit $code)"
      [ -f "$JOB/result" ] && return 0
      case "$action" in
        build) write_result ok build 0 ;;
        run) install_app; launch_and_shoot; write_result ok run 0 ;;
        test) install_app; run_maestro ;;
      esac
      ;;
    sim) run_simctl ;;
    logs) run_logs ;;
    *) echo "remote-ios.sh: unknown action $action" >&2; write_result refused "$action" 2 ;;
  esac
}

# Anything of ours that nothing owns any more (its parent is launchd) and that works inside the job's checkout.
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

stop_group() {
  local job="$1" pgid
  pgid="$(cat "$job/pgid" 2>/dev/null)"
  [ -n "$pgid" ] && [ ! -e "$job/finished" ] || return 0
  kill -TERM -- "-$pgid" 2>/dev/null
  sleep 5
  [ -e "$job/finished" ] || kill -KILL -- "-$pgid" 2>/dev/null
}

cmd_job() {
  local id="$1" session="$2" action="$3" run_pid limit_pid tail_pid
  valid_name "$id" && valid_name "$session" || { echo 'remote-ios.sh: bad job or session name' >&2; exit 2; }
  JOB="$BASE/jobs/$id"
  [ -d "$JOB/in" ] || { echo "remote-ios.sh: no request for $id" >&2; exit 2; }
  echo "$session" > "$JOB/session"
  : > "$JOB/out.log"
  perl -e 'setpgrp(0, 0); exec @ARGV or exit 127' bash "$SELF" work "$id" "$session" "$action" >> "$JOB/out.log" 2>&1 < /dev/null &
  run_pid=$!
  echo "$run_pid" > "$JOB/pgid"

  # The caller holds stdin open for the whole job: when it closes, the connection has gone.
  exec 3<&0
  ( cat <&3 >/dev/null; stop_group "$JOB" ) >/dev/null 2>&1 &
  exec 3<&-
  ( trap '[ -n "${timer:-}" ] && kill "$timer" 2>/dev/null; exit 0' TERM; sleep "$JOB_LIMIT_SECONDS" & timer=$!; wait "$timer"; stop_group "$JOB" ) >/dev/null 2>&1 &
  limit_pid=$!

  tail -n +1 -f "$JOB/out.log" &
  tail_pid=$!
  wait "$run_pid"
  kill -KILL -- "-$run_pid" 2>/dev/null
  sweep_orphans "$(cat "$JOB/work" 2>/dev/null)"
  touch "$JOB/finished"
  kill "$limit_pid" 2>/dev/null
  sleep 1
  kill "$tail_pid" 2>/dev/null
  wait "$tail_pid" 2>/dev/null
  under_slots_lock touch "$session" >/dev/null 2>&1

  mkdir -p "$JOB/out"
  cp "$JOB/out.log" "$JOB/out/job.log" 2>/dev/null
  if [ -f "$JOB/result" ]; then
    printf '%s%s\n' "$RESULT_PREFIX" "$(cat "$JOB/result")"
  elif [ -e "$JOB/stopped" ]; then
    printf '%s{"status":"stopped","stage":"stopped","exit":1}\n' "$RESULT_PREFIX"
  else
    printf '%s{"status":"setup-failed","stage":"stopped","exit":1}\n' "$RESULT_PREFIX"
  fi
}

cmd_fetch() {
  local id="$1"
  valid_name "$id" || exit 2
  [ -d "$BASE/jobs/$id/out" ] || exit 1
  tar -czf - -C "$BASE/jobs/$id" out || exit 1
  rm -rf "$BASE/jobs/$id"
}

cmd_status() {
  local session="$1" n owner stamp now udid state
  valid_name "$session" || exit 2
  now="$(date +%s)"
  for n in $(seq 1 "$SLOT_COUNT"); do
    udid="$(sim_udid "$n")"
    state="$( [ -n "$udid" ] && xcrun simctl list devices | sed -n "s/.*($udid) (\([A-Za-z]*\)).*/\1/p" | head -n 1)"
    if read -r owner stamp 2>/dev/null < "$BASE/slots/$n/lease"; then
      local whose='another session'
      [ "$owner" = "$session" ] && whose='this session'
      echo "slot $n: held by $whose, last used $(((now - stamp) / 60)) min ago; simulator ${state:-not made yet}"
    else
      echo "slot $n: free; simulator ${state:-not made yet}"
    fi
  done
  session_busy "$session" && echo 'this session has a job running'
  return 0
}

cmd_stop() {
  local session="$1" job slot udid
  valid_name "$session" || exit 2
  for job in "$BASE"/jobs/*/; do
    [ -f "$job/session" ] && [ "$(cat "$job/session")" = "$session" ] || continue
    [ -e "$job/finished" ] && continue
    touch "$job/stopped"
    stop_group "${job%/}"
    sweep_orphans "$(cat "$job/work" 2>/dev/null)"
    echo "stopped job $(basename "$job")"
  done
  slot="$(under_slots_lock release "$session")"
  if [ -n "$slot" ]; then
    udid="$(sim_udid "$slot")"
    [ -n "$udid" ] && clear_slot_apps "$slot" "$udid"
    echo "freed simulator slot $slot"
  else
    echo 'this session held no simulator'
  fi
}

if [ -n "$APP" ] && ! valid_name "$APP"; then
  echo "remote-ios.sh: $APP is not an app name" >&2
  exit 3
fi

command_name="${1:-}"
[ $# -gt 0 ] && shift
case "$command_name" in
  bases) [ -n "$APP" ] || exit 3; cmd_bases ;;
  receive) [ -n "$APP" ] || exit 3; cmd_receive "$@" ;;
  put) cmd_put "$@" ;;
  job) cmd_job "$@" ;;
  work) cmd_work "$@" ;;
  build-locked) cmd_build_locked "$@" ;;
  claim) cmd_claim "$@" ;;
  touch) cmd_touch "$@" ;;
  release) cmd_release "$@" ;;
  fetch) cmd_fetch "$@" ;;
  status) cmd_status "$@" ;;
  stop) cmd_stop "$@" ;;
  *) echo 'usage: remote-ios.sh bases|receive|put|job|fetch|status|stop' >&2; exit 2 ;;
esac
