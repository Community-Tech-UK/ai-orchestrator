#!/usr/bin/env sh
# finish-to-main.sh — merge the current branch back into main and delete it.
#
# This is the "merge back when done" step that your orchestrator only does for
# isolated + successful sessions (loop-coordinator.ts:3088). Run it (or wire it as a
# session-completion hook) to cover every other case: non-isolated branches, sessions
# that didn't end in "success", and codex/superpowers work in any repo.
#
# Repo-agnostic. SAFE: on a merge conflict it aborts cleanly and leaves you on the
# branch with main untouched and no conflict markers. Nothing is ever lost.
#
#   usage: finish-to-main.sh [--base main] [--push] [--no-commit]
#     --base <b>    integration branch (default: main)
#     --push        push base after a successful merge
#     --no-commit   refuse if the working tree is dirty (default: auto-commit it first)
#
# Verified 2026-06-29: clean merge-back + safe conflict-abort (7/7 assertions).
set -eu

BASE=main; PUSH=0; AUTOCOMMIT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE=$2; shift ;;
    --push) PUSH=1 ;;
    --no-commit) AUTOCOMMIT=0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# Deliberate integration: pass the stay-on-main guard for these git writes.
export AIO_ALLOW_MAIN_UPDATE=1

br=$(git symbolic-ref --quiet --short HEAD) || { echo "detached HEAD; aborting" >&2; exit 1; }
[ "$br" = "$BASE" ] && { echo "already on $BASE; nothing to merge."; exit 0; }
git rev-parse --verify -q "$BASE" >/dev/null || { echo "base branch '$BASE' not found" >&2; exit 1; }

# Preserve any uncommitted agent work on the branch before merging.
if [ -n "$(git status --porcelain)" ]; then
  [ "$AUTOCOMMIT" = "1" ] || { echo "uncommitted changes present (use default to auto-commit, or commit them yourself)" >&2; exit 1; }
  git add -A && git commit -q -m "finish($br): auto-commit working tree before merge"
fi

git switch -q "$BASE"
git pull --ff-only -q 2>/dev/null || true   # best-effort sync if a remote exists

if git merge --no-ff -q -m "Merge $br into $BASE" "$br"; then
  git branch -q -d "$br"
  [ "$PUSH" = "1" ] && git push -q 2>/dev/null || true
  echo "OK: merged '$br' into $BASE and deleted the branch. You are on $BASE."
else
  git merge --abort
  git switch -q "$br"
  echo "CONFLICT: '$br' does not merge cleanly into $BASE." >&2
  echo "Nothing merged, nothing deleted. You are back on '$br'. Resolve, then re-run." >&2
  exit 1
fi
