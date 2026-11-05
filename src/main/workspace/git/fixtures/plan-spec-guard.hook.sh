#!/usr/bin/env sh
# Shared guard: refuse to commit an ACTIVE plan / spec / livetest / history / decisions doc.
#
# James's lifecycle: these docs stay untracked so they show up as `??` in the
# source-control panel — that visibility IS the review queue. Only a closed-state
# doc (`_completed`, `_archived`) may be committed. This was previously a
# discipline applied at commit time; it failed at least once (a bulk commit swept
# a `_spec_planned.md` into history), so it is now a constraint.
#
# Deliberate exception: a file may be tracked on purpose if it declares itself a
# standing register on its first few lines (see MARKER below) — for rolling
# indexes that never reach `_completed`.
#
# Escape hatch: `git commit --no-verify`.

BLOCKED=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '(_spec|_spec_planned|_plan|_livetest|_history|-decisions-for-james)\.md$' || true)
[ -z "$BLOCKED" ] && exit 0

MARKER='Type: standing register'
REAL_BLOCKED=''
for f in $BLOCKED; do
  if git show ":$f" 2>/dev/null | head -8 | grep -qF "$MARKER"; then continue; fi
  REAL_BLOCKED="$REAL_BLOCKED  $f
"
done

[ -z "$REAL_BLOCKED" ] && exit 0

cat >&2 <<EOF

✋ Commit blocked — active plan/spec/livetest/history/decisions docs must stay untracked.

$REAL_BLOCKED
These stay untracked so they appear as '??' for review. To proceed, either:

  • finish the work and rename to a closed state, e.g.
      <name>_plan.md      -> <name>_plan_completed.md
      <name>_spec.md      -> <name>_spec_completed.md
      <name>_spec_planned.md -> <name>_spec_completed.md
      <name>_livetest.md  -> <name>_livetest_completed.md
    (a livetest doc is only '_completed' when EVERY check passes with evidence)

  • unstage it and leave it in the working tree:
      git restore --staged <path>

  • or, if it is genuinely a standing register that will never reach
    '_completed', add a line 'Type: standing register' near the top of the file.

Override for this commit only:  git commit --no-verify

EOF
exit 1
