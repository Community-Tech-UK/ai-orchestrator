# stay-on-main guard

A `reference-transaction` hook (`.githooks/reference-transaction`) that protects `main`
from the exact behaviour that was wrecking your history: something force-moving `main`
with `git branch -f main HEAD` from a `codex/*` branch, under the leaked
`Test <test@example.com>` identity.

It fires on **every** ref update regardless of which tool runs git (orchestrator, codex
CLI, superpowers, your shell) and is **not** skipped by `--no-verify`.

## What it does

Blocks (in enforce mode):

- moving / force-moving `main` while you are checked out on another branch
- deleting `main`

Always allows:

- normal commits and merges made while you are on `main`
- commits on any side branch (they never touch `main`)

## Rollout (it ships warn-only, so installing it changes nothing yet)

```sh
# 1. Observe for a bit. It logs to stderr when something force-moves main, never blocks.
#    Watch your orchestrator/codex output for:  stay-on-main guard [WARN ...]

# 2. Turn on blocking when you're satisfied it only catches the bad pattern:
touch "$(git rev-parse --git-dir)/stay-on-main-enforce"

# 3. Back to warn-only:
rm "$(git rev-parse --git-dir)/stay-on-main-enforce"
```

A deliberate integration onto `main` (e.g. the orchestrator's `worktree-integration`
path) opts in per command:

```sh
AIO_ALLOW_MAIN_UPDATE=1 git <...>
```

## Also fix the leaked identity (separate, one line)

Your repo currently commits as `Test <test@example.com>` because that's set in
`.git/config`. Set your real identity:

```sh
git config user.name  "James Lawrence"
git config user.email "james@shutupandshave.com"
```

## Honest limits

- It keeps `main` from being moved out from under you. It does **not** force your working
  checkout to sit on `main`; a ref hook can't do that.
- It does **not** stop `codex/*` branches from being created. That's the external tooling
  making branches; this guard only protects `main`. Stopping branch sprawl is a separate
  policy decision.
- The `AIO_ALLOW_MAIN_UPDATE=1` escape hatch is intentional. Codex/superpowers don't set
  it, so they can't bypass by accident, but it is a bypass.
- Requires git >= 2.28 (your Mac is fine).
