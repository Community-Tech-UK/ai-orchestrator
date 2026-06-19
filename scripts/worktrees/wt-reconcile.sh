#!/usr/bin/env bash
#
# wt-reconcile.sh - report and safely reap merged git worktrees.
#
# This is the antidote to "I never know if a worktree has been merged".
# It treats `git worktree list` as the source of truth, classifies every
# worktree against the integration branch, and only ever removes ones that
# are provably merged with no uncommitted work.
#
# DRY-RUN BY DEFAULT. Nothing is removed unless you pass --apply.
# Run this on the machine where the worktrees actually live (your Mac), not
# inside a sandbox - it needs to see the worktree directories to check them
# for uncommitted changes.
#
# Usage:
#   scripts/worktrees/wt-reconcile.sh                 # dry-run report
#   scripts/worktrees/wt-reconcile.sh --apply         # remove merged-clean worktrees
#   scripts/worktrees/wt-reconcile.sh --apply --reap-branch   # also delete the merged branch
#   scripts/worktrees/wt-reconcile.sh --base main     # set integration branch explicitly
#
# Flags:
#   --apply         actually remove worktrees (default: dry-run)
#   --reap-branch   after removing a merged worktree, delete its local branch (git branch -d, safe)
#   --force-dirty   also reap worktrees whose branch is merged but that have uncommitted changes
#                   (this DISCARDS those uncommitted changes - off by default)
#   --base <branch> integration branch to measure "merged" against (default: origin/HEAD or main)
#   --repo <path>   operate on this repo (default: the repo containing the cwd)
#   -h, --help      show this help
#
set -euo pipefail

APPLY=0
REAP_BRANCH=0
FORCE_DIRTY=0
BASE=""
REPO=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)        APPLY=1 ;;
    --reap-branch)  REAP_BRANCH=1 ;;
    --force-dirty)  FORCE_DIRTY=1 ;;
    --base)         BASE="${2:-}"; shift ;;
    --repo)         REPO="${2:-}"; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# Locate the repo.
if [[ -n "$REPO" ]]; then
  cd "$REPO" || die "cannot cd to --repo $REPO"
fi
REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
cd "$REPO"

# Determine the integration branch.
if [[ -z "$BASE" ]]; then
  BASE="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
  BASE="${BASE:-main}"
fi
git rev-parse --verify -q "refs/heads/$BASE" >/dev/null 2>&1 || die "integration branch '$BASE' not found"

# Refresh remote tracking so the [gone] secondary signal is accurate. Read-mostly.
git fetch --prune --quiet 2>/dev/null || true

printf '== worktree reconcile ==\n'
printf 'repo:   %s\n' "$REPO"
printf 'base:   %s\n' "$BASE"
if [[ "$APPLY" -eq 1 ]]; then printf 'mode:   APPLY (will remove)\n'; else printf 'mode:   DRY-RUN (use --apply to execute)\n'; fi
printf '\n'
printf '%-14s %-46s %s\n' "STATE" "BRANCH" "NOTE"
printf '%-14s %-46s %s\n' "-----" "------" "----"

declare -a REAP_PATHS=() REAP_BRANCHES=() REAP_FORCE=()
declare -i n_reap=0 n_keep=0 n_review=0 n_missing=0

# Parse `git worktree list --porcelain` block by block.
wt_path=""; wt_branch=""; wt_detached=0; wt_prunable=0; wt_locked=0; wt_bare=0

flush() {
  [[ -z "$wt_path" ]] && return 0

  # Never touch the base-branch checkout or a bare/locked worktree.
  if [[ "$wt_bare" -eq 1 ]]; then
    printf '%-14s %-46s %s\n' "SKIP" "(bare)" "$wt_path"
    return 0
  fi
  if [[ "$wt_branch" == "$BASE" ]]; then
    printf '%-14s %-46s %s\n' "SKIP-BASE" "$wt_branch" "integration checkout, never reaped"
    return 0
  fi
  if [[ "$wt_locked" -eq 1 ]]; then
    printf '%-14s %-46s %s\n' "LOCKED" "${wt_branch:-(detached)}" "locked, left alone"
    ((n_keep++)) || true
    return 0
  fi

  # Directory gone (manually deleted, or registered but missing): metadata-only cleanup.
  if [[ "$wt_prunable" -eq 1 || ! -e "$wt_path" ]]; then
    printf '%-14s %-46s %s\n' "MISSING-DIR" "${wt_branch:-(detached)}" "dir gone; 'git worktree prune' clears it"
    ((n_missing++)) || true
    return 0
  fi

  # What ref do we test for "merged"? branch tip, or HEAD if detached.
  local testref
  if [[ "$wt_detached" -eq 1 ]]; then
    testref="$(git -C "$wt_path" rev-parse HEAD 2>/dev/null || echo '')"
  else
    testref="refs/heads/$wt_branch"
  fi

  local merged=0
  if [[ -n "$testref" ]] && git merge-base --is-ancestor "$testref" "$BASE" 2>/dev/null; then
    merged=1
  fi

  # Uncommitted changes in the worktree?
  local dirty=0
  if [[ -n "$(git -C "$wt_path" status --porcelain 2>/dev/null)" ]]; then
    dirty=1
  fi

  if [[ "$merged" -eq 0 ]]; then
    local ahead
    ahead="$(git rev-list --count "$BASE..$testref" 2>/dev/null || echo '?')"
    printf '%-14s %-46s %s\n' "KEEP" "${wt_branch:-(detached)}" "$ahead commit(s) not in $BASE - real work, kept"
    ((n_keep++)) || true
    return 0
  fi

  # merged == 1 below
  if [[ "$dirty" -eq 1 && "$FORCE_DIRTY" -eq 0 ]]; then
    printf '%-14s %-46s %s\n' "REVIEW" "${wt_branch:-(detached)}" "merged, but has uncommitted changes - kept (use --force-dirty)"
    ((n_review++)) || true
    return 0
  fi

  # Reap candidate: merged, and clean (or dirty+force).
  local note="merged into $BASE, clean"
  [[ "$dirty" -eq 1 ]] && note="merged but DIRTY - changes will be discarded"
  printf '%-14s %-46s %s\n' "REAP" "${wt_branch:-(detached)}" "$note"
  REAP_PATHS+=("$wt_path")
  REAP_BRANCHES+=("${wt_branch:-}")
  REAP_FORCE+=("$dirty")
  ((n_reap++)) || true
}

while IFS= read -r line; do
  if [[ -z "$line" ]]; then
    flush
    wt_path=""; wt_branch=""; wt_detached=0; wt_prunable=0; wt_locked=0; wt_bare=0
    continue
  fi
  case "$line" in
    "worktree "*)  wt_path="${line#worktree }" ;;
    "branch "*)    wt_branch="${line#branch refs/heads/}" ;;
    "detached")    wt_detached=1 ;;
    "bare")        wt_bare=1 ;;
    "locked"*)     wt_locked=1 ;;
    "prunable"*)   wt_prunable=1 ;;
  esac
done < <(git worktree list --porcelain)
flush  # final block (input may not end with a blank line)

printf '\nsummary: %d reap, %d keep, %d review, %d missing-dir\n' "$n_reap" "$n_keep" "$n_review" "$n_missing"

if [[ "$APPLY" -eq 0 ]]; then
  printf '\nDry-run only. Re-run with --apply to remove the REAP rows and prune missing-dir metadata.\n'
  git worktree prune --dry-run 2>/dev/null || true
  exit 0
fi

# --- apply ---
printf '\napplying...\n'
i=0
for path in "${REAP_PATHS[@]:-}"; do
  [[ -z "$path" ]] && continue
  branch="${REAP_BRANCHES[$i]}"
  force="${REAP_FORCE[$i]}"
  i=$((i+1))
  if [[ "$force" -eq 1 ]]; then
    git worktree remove --force "$path" && printf 'removed (forced): %s\n' "$path"
  else
    git worktree remove "$path" && printf 'removed: %s\n' "$path"
  fi
  if [[ "$REAP_BRANCH" -eq 1 && -n "$branch" && "$branch" != "$BASE" ]]; then
    # -d is the safe delete: it refuses if the branch is somehow not merged.
    git branch -d "$branch" 2>/dev/null && printf 'deleted branch: %s\n' "$branch" \
      || printf 'kept branch (not safely deletable): %s\n' "$branch"
  fi
done

git worktree prune
printf 'done.\n'
