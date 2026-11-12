#!/bin/sh
# aio-ios redirect. scripts/remote-ios/setup.js in ai-orchestrator copies this into ~/.local/bin as xcodebuild, xcrun
# and maestro. Outside a Harness agent session it runs the real tool straight away, unchanged. Inside one, iPhone
# simulator work in an app on the test Mac's list is pointed at aio-ios instead (see redirect.js); anything else, or
# anything while the test Mac is away, runs the real tool here.
# Read first, before any command changes it. A shell sets it to the path of the command it runs; a program that starts
# this itself (Node, Ruby, Python) passes its own path.
started_by="${_:-}"
tool="${0##*/}"

# The real tool: the first on PATH that isn't this file or another copy of it. The system's folders hold no copy.
real=''
set -f
old_ifs="$IFS"
IFS=:
for dir in $PATH; do
  candidate="${dir:-.}/$tool"
  [ -x "$candidate" ] && [ ! -d "$candidate" ] || continue
  [ "$candidate" -ef "$0" ] && continue
  case "$candidate" in
    /usr/bin/* | /bin/* | /Applications/*) ;;
    *) /usr/bin/grep -q '^# aio-ios redirect\.' "$candidate" 2>/dev/null && continue ;;
  esac
  real="$candidate"
  break
done
IFS="$old_ifs"
set +f
[ -n "$real" ] || { echo "$tool: command not found" >&2; exit 127; }

# Not an agent session, or a tool started by one that was already allowed to run here.
if [ -z "${AI_ORCHESTRATOR_INSTANCE_ID:-}" ] || [ -n "${AIO_IOS_DECIDED:-}" ]; then exec "$real" "$@"; fi
# Only what a shell ran by name is redirected, whoever started the shell. A program that starts Xcode itself, without
# a shell, keeps working (Capacitor's CLI, MCP servers, Node scripts using execFile or spawn), as do Fastlane lanes
# and Xcode's own build steps. A wrapper such as `timeout` or `nice` also starts it without a shell, so it runs here.
if [ "$started_by" != "$0" ] || [ -n "${FASTLANE_LANE_NAME:-}" ] || [ -n "${XCODE_VERSION_ACTUAL:-}" ]; then
  exec "$real" "$@"
fi
# Most xcrun calls find compilers and SDKs; only simctl is simulator work.
if [ "$tool" = xcrun ]; then
  case " $* " in *' simctl '*) ;; *) exec "$real" "$@" ;; esac
fi

helper="$HOME/.ai-orchestrator/remote-ios/redirect.js"
node="$(command -v node 2>/dev/null)"
if [ -f "$helper" ] && [ -n "$node" ]; then
  "$node" "$helper" "$tool" "$@"
  [ $? -eq 64 ] && exit 64
fi
AIO_IOS_DECIDED=1
export AIO_IOS_DECIDED
exec "$real" "$@"
