#!/usr/bin/env bash
#
# wt-new.sh - create a worktree in the ONE canonical, gitignored location.
#
# Every worktree lives under <repo>/.worktrees/<task-id>. No more scatter
# across ~/.config/superpowers/worktrees, sibling dirs, or wherever a tool
# happened to drop one. This is the only sanctioned way to make a worktree;
# the orchestrator (and you) should call this instead of raw `git worktree add`.
#
# Usage:
#   scripts/worktrees/wt-new.sh <task-id> [--branch <name>] [--from <ref>] [--prefix <p>]
#
#   <task-id>        slug for the work, e.g. "remote-worker-repair"
#   --branch <name>  full branch name (default: <prefix>/<task-id>)
#   --from <ref>     base the branch on this ref (default: the integration branch)
#   --prefix <p>     branch prefix when --branch is not given (default: $WT_PREFIX or "session")
#   --base <branch>  integration branch (default: origin/HEAD or main)
#   -h, --help       show this help
#
# Examples:
#   scripts/worktrees/wt-new.sh remote-worker-repair
#       -> .worktrees/remote-worker-repair on branch session/remote-worker-repair
#   scripts/worktrees/wt-new.sh repair --branch codex/repair --from main
#
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; }

TASK=""; BRANCH=""; FROM=""; BASE=""
PREFIX="${WT_PREFIX:-session}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift ;;
    --from)   FROM="${2:-}"; shift ;;
    --prefix) PREFIX="${2:-}"; shift ;;
    --base)   BASE="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)       die "unknown argument: $1 (try --help)" ;;
    *)        [[ -n "$TASK" ]] && die "unexpected extra argument: $1"; TASK="$1" ;;
  esac
  shift
done

[[ -n "$TASK" ]] || { usage; exit 2; }

REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
cd "$REPO"

if [[ -z "$BASE" ]]; then
  BASE="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
  BASE="${BASE:-main}"
fi

BRANCH="${BRANCH:-$PREFIX/$TASK}"
FROM="${FROM:-$BASE}"

[[ "$BRANCH" == "$BASE" ]] && die "refusing to create a worktree on the integration branch '$BASE'"

# Sanitise the directory name (slashes -> dashes) but keep the branch name intact.
DIRNAME="$(printf '%s' "$TASK" | tr '/ ' '--')"
ROOT="$REPO/.worktrees"
DIR="$ROOT/$DIRNAME"

mkdir -p "$ROOT"
[[ -e "$DIR" ]] && die "worktree dir already exists: $DIR"

if git rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null 2>&1; then
  # Branch already exists - attach a worktree to it (cannot be checked out elsewhere).
  git worktree add "$DIR" "$BRANCH"
else
  git worktree add -b "$BRANCH" "$DIR" "$FROM"
fi

printf 'created worktree: %s\n' "$DIR"
printf '          branch: %s (from %s)\n' "$BRANCH" "$FROM"
printf '\ncd %q\n' "$DIR"
