# Worktree lifecycle scripts

The fix for "scattered worktrees everywhere and I never know if they've merged."
Two rules, enforced by two scripts:

1. **One location.** Every worktree lives under `<repo>/.worktrees/<task-id>`
   (already gitignored). Nothing scatters into `~/.config/...` or sibling dirs.
2. **One source of truth for merge state.** `git worktree list` plus
   `git merge-base --is-ancestor <branch> main` tells us, definitively, whether
   a worktree's work is already in main. We never guess.

## `wt-new.sh` — create

The only sanctioned way to make a worktree. Agents and the orchestrator call this
instead of raw `git worktree add`, so location and naming stay consistent.

```bash
scripts/worktrees/wt-new.sh remote-worker-repair
# -> .worktrees/remote-worker-repair on branch session/remote-worker-repair
```

## `wt-reconcile.sh` — reap

Reports every worktree's state and removes the ones that are provably safe.
**Dry-run by default.** Run it on the machine where the worktrees live.

```bash
scripts/worktrees/wt-reconcile.sh                # report only
scripts/worktrees/wt-reconcile.sh --apply        # remove merged + clean worktrees
scripts/worktrees/wt-reconcile.sh --apply --reap-branch   # also delete the merged branch
```

States it reports:

| State         | Meaning                                                        | Action on `--apply`        |
|---------------|----------------------------------------------------------------|----------------------------|
| `REAP`        | Branch merged into base, working tree clean                    | removed                    |
| `REVIEW`      | Branch merged but has uncommitted changes                      | kept (unless `--force-dirty`) |
| `KEEP`        | Has commits not in base — real, unmerged work                  | kept                       |
| `MISSING-DIR` | Registered but the directory is gone                           | metadata pruned            |
| `SKIP-BASE`   | The integration checkout itself                                | never touched              |
| `LOCKED`      | Locked worktree                                                | never touched              |

### Why merged-into-`main`, not the `[gone]`-remote trick

A common cleanup heuristic keys on "the remote branch was deleted, so it's safe."
That misses this repo's reality: most branches here merge locally and either track
`origin/main` or have no remote of their own, so they never go `[gone]`. We test the
real question instead — *is this branch's tip already an ancestor of the integration
branch* — which is correct regardless of how the merge happened.

### Safety

- Never removes the integration (`main`) checkout, a bare worktree, or a locked one.
- Never removes a worktree with uncommitted changes unless you pass `--force-dirty`.
- Branch deletion uses `git branch -d` (the safe variant that refuses unmerged branches).
- `--apply` is required for any destructive action.

## Suggested cadence

Run the reconcile sweep on a timer so buildup never happens:

```bash
# crontab: dry-run report every morning, e-mail yourself the output
0 8 * * *  cd /path/to/ai-orchestrator && scripts/worktrees/wt-reconcile.sh
```

Keep the actual `--apply` manual (or wire it into a `just` recipe) until you trust it.
