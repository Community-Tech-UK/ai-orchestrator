# Stranded worktree rescue: historical decisions and outcomes

**Status reconciliation — 2026-09-24:** this preserves the September 18 decisions and subsequent
September 19 implementation notes. The numbered recommendations and checkout/runtime inventory
below describe those inspections, not today's branch, folder or installed-app state. Recorded
choices are retained as history, not new permission to delete, merge, commit or restart anything.
The [completed remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md) and
[remediation register](livetest-remediation-register.md) carry LT-536–538 and later status;
the [rescue livetest](2026-09-18-stranded-worktree-rescue_livetest_completed.md) owns rebuilt-app validation.
Plan Queue's later [completed record](2026-09-18-plan-queue_plan_completed.md) supersedes the
concurrent-uncommitted-work premise below. No worktree or live-app inventory was rerun for this
documentation correction. The linked prompt is now explicitly historical; `.aio-review/` contains
local review artifacts, not canonical source documentation.

Date: 2026-09-18. Prompt: [2026-09-18-stranded-worktree-rescue_prompt.md](2026-09-18-stranded-worktree-rescue_prompt.md).
Recorded status: answers received 2026-09-18 (review decisions in `.aio-review/`). James then asked
for every remaining item to be carried out. The original report said the changes were uncommitted
and had not been pushed; that was the session's state, not a claim about the present checkout.

- Item 12: removed the `harness-auto-update-v0.1.0` folder and deleted the local
  `fix/loop-control-atomic-write` branch. The remote branch and PR #3 are untouched.
- Item 13: pruned the three missing `/private/tmp` worktree records.
- Items 1 and 3 to 8: the novel fixes are re-implemented on current `main`, each bug fix with a
  regression test shown to fail without it. Landed: the two provider-exclusion bypasses, the
  composer write-then-drop order, `gh` SIGKILL escalation, the conflict-marker false positive, the
  loop plan parser, Claude MCP `transport` normalisation, the terminal and CI test-timing fixes
  (item 1); the cancel-during-preflight guard and the LT-168 test (item 3); the secret-card format
  warning (item 4); the LT-137 interrupt guard (item 5); the `cancelled` and `environment` preflight schema
  values and the cancelled-check wording (item 6); the SEA build check and the frame-restore guard (item 7); the auto-title
  exclusion fix and away-recap tests (item 8).
  Also landed on a later completeness pass: item 8's spend-meter basis, so the loop spend meter
  says "provider-reported" when the provider gave a real cost instead of always saying
  "estimated".
  Built on 2026-09-19 after James asked for everything to be finished:
  - Item 5's Settings redesign: all of `2026-08-28-settings-ux-remediation_plan_completed.md`
    Tasks 1–8. Its two live-window checks are in `2026-08-28-settings-ux-remediation_livetest.md`.
  - Item 1's orchestrator-tools hardening: a per-spawn capability token that every tools RPC call
    over the socket must present, and cancellation of long-running tool calls when the client
    disconnects. Sessions started before the rebuild are refused, not grandfathered; they get a
    token when respawned.
  - Item 1's agent secret requests: agents could already raise the secret card. What was missing
    was the Settings switch that is supposed to stop them. `workspaceSecretsAllowAgentRequests` was
    never read, so turning it off did nothing. Fixed and recorded as LT-537.
  - Item 8's timeline recovery actions: the timeline showed recovery buttons that did nothing when
    clicked. Those are now plain text unless something real handles them. A proposed "Turn on
    auto-resume" button was dropped at review, because loops already resume on their own and that
    setting only affects regular sessions. The review also found an older loop hint telling you a
    parked run "is simply dead until morning", which was false; removed and recorded as LT-538.
- Items 2, 9, 10 and 11: nothing novel to land (item 2's change is covered by item 3). Their
  branches and folders are kept, because only a Discard answer allows deletion.
- Item 14: no answer, so the folder is left alone.
- Item 15: done. Loop promotion now stops only when your uncommitted root files overlap what the
  loop would land.
- Item 16: done. A blocked run's row in "Past loop prompts" has a "Mark resolved" button. It refuses
  a worktree folder with uncommitted changes and deletes nothing.

**Historical inventory warning:** the September 18/19 working copy of
`docs/generated/architecture-inventory.json` included a concurrent Plan Queue session's then-uncommitted
channels. The report therefore requested regeneration before that proposed commit. This is not a
current instruction to regenerate or stage the inventory: assess any future commit's actual diff
and source state, rather than assuming that old mixed-working-tree condition still exists.

Live checks that need the rebuilt app are listed with steps in
[2026-09-18-stranded-worktree-rescue_livetest_completed.md](2026-09-18-stranded-worktree-rescue_livetest_completed.md).

## Original rescue inventory and restart warning — September 18

Eleven worktrees held work that had not been committed. At the recorded inspection, each had
received a safety commit on its own branch and the folders were still in place and clean.
The table is historical; it does not establish that any present cleanup would be safe.

| Worktree | Branch | Safety commit | Files | Behind main |
| --- | --- | --- | --- | --- |
| task-can-you-work-through-all-the-p-mt76ztv1 | same name | `1f230732cc` | 185 | 56 |
| task-i-said-keep-going-uintil-it-s-mtovfbpg | same name | `33fe2d5dcc` | 117 | 28 |
| task-please-look-at-all-the-untrack-mtkdez2p | same name | `f965e960ed` | 101 | 35 |
| task-so-finish-the-work-please-mtklsatd | same name | `07403ee118` | 52 | 33 |
| task-please-work-through-all-the-li-mtkqr41h | same name | `d24a421b94` | 19 | 33 |
| task-please-investigate-all-the-pla-mtl9icld | same name | `b332edf734` | 10 | 32 |
| task-please-look-at-all-the-untrack-mtjeyorh | same name | `bb5ad1f268` | 7 | 37 |
| task-please-look-at-all-the-untrack-mtjvhjeh | same name | `ae88a599a1` | 7 | 36 |
| composer-resize-verification | `rescue/composer-resize-verification` (new) | `e4a99cbb5e` | 2 | 87 |
| .claude/worktrees/agent-a1d7bb162fd56b4c6 | worktree-agent-a1d7bb162fd56b4c6 | `460a2ef855` | 4 | 97 |
| .claude/worktrees/agent-a4d6deb10e35abdd8 | worktree-agent-a4d6deb10e35abdd8 | `8b3db8bb66` | 8 | 97 |

Before committing, I checked each worktree's gitignored files (`git status --ignored`). They were
test logs under `_scratch/`, `node_modules`, `dist/`, build caches, `.DS_Store`, `.env.local`,
`.mise.local.toml`, `.ao/activity.jsonl` and one throwaway `_scratch/count-closure.mjs`. None of it
looks like work that was lost.

The live run `task-please-work-through-all-the-li-mu4ui30h` (parked on a provider limit, clean)
was not touched.

**Historical warning for the installed build inspected then, not a current restart instruction.**
That build retried every blocked loop run on startup. The safety commits made eight of them clean,
and it treated a clean blocked run as ready to land. The report warned that its next start would:

- for the five runs that finished "needs review" (items 1, 4, 5, 6 and 7): merge each branch into
  a new `integration/main` branch and try to promote it to `main`. Promotion stops because the root
  checkout always has untracked plan files, so `main` itself would not move. But `integration/main`
  would then hold weeks-old work that a later promotion could land. Whether the merge fails or the
  promotion stops, the app then deletes that run's worktree folder and keeps the branch.
- for the three runs that hit a cap (items 2, 3 and 8): delete the worktree folder and keep the
  branch.

That build would therefore have deleted all eight worktree folders before a decision, while
retaining the branches. The reported fix instead kept a blocked run whose branch gained commits
AIO did not make blocked, with its folder and branch untouched. Whether the installed app now
contains that fix is a live-validation question, not established by this historical warning.

Why the work was stranded: when a loop finished, AIO tried to commit the output to the session
branch and the repository's pre-commit hook refused. The app log shows two reasons:
`node: command not found`, because the packaged app has no `node` on its PATH (five runs), and the
plan-document guard refusing active plans (two runs). The eighth run is older than the logs. This
is fixed and recorded as LT-536.

How to read the counts: `already on main` means main has the same change. `superseded` means main
later changed the same thing differently. `novel` means main does not have it. `old doc copy` means
a plan, spec or livetest file where the live version is the one in your root checkout. Novel
findings marked "agent-reported" were found by read-only review agents; I checked the code
locations exist but did not reproduce the bugs.

## 1. "Can you work through all the plans that are untracked" (24 August)

Branch `task-can-you-work-through-all-the-p-mt76ztv1`. Stopped for review after 48 iterations
because it kept repeating the same work. Most of it is a first version of the Workspace Secret
Card. Main rebuilt that feature a week later with a different design, which is why most of this
branch is superseded.

Counts: 26 already on main, 123 superseded, 31 novel (4 of them trivial), 5 old doc copies.

Novel, each small and applying cleanly to main:
- Two ways round your "exclude from automatic use" provider list. When no CLI is detected, AIO
  falls back to Claude even if Claude is excluded. And excluding Antigravity does not stop a magic
  prompt that reaches it through the old `gemini` name.
- The composer can lose a message: it deletes the old recovery copy before saving the new one, so
  if that save fails, the text is gone and no recovery banner appears.
- A hung `gh` command during PR creation is only sent a polite stop signal. It never gets a
  forced stop.
- The loop's final check flags a comment line of `=======` as a leftover merge conflict.
- Loop plan files with a single `#` heading or a numbered list read as empty.
- Claude drops remote MCP servers written with `transport` instead of `type`, without saying so.
- A terminal test can type before the shell is ready. Plus three minor test-timing fixes.

Novel but not landable as-is, because each depends on this branch's own version of the secret
store:
- A per-session capability token for the orchestrator tools socket, plus cancelling long-running
  tool calls when the client disconnects. Needs re-deriving against main.
- Agents asking for a workspace secret themselves. Main has a setting for this,
  `workspaceSecretsAllowAgentRequests`, but nothing reads it.

Old doc copies: your root Workspace Secret Card plan is newer. It records on 26 August that this
branch's "completed" claims were false. Nothing is missing from the root copies.

Recommendation: land the seven small fixes. Treat the capability token and agent secret requests
as future work.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 2. "Look at all the untracked and outstanding md files", first attempt (2 September)

Branch `task-please-look-at-all-the-untrack-mtjeyorh`. Hit its cost cap after 6 iterations
without finishing. It started the cancel-during-preflight fix that item 3 finished.

Counts: 2 already on main, 4 superseded, 1 novel, 0 old doc copies.

Novel: half of a fix for a cancelled loop coming back as "paused". Item 3 has the complete
version, so nothing here needs landing.

Recommendation: discard.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 3. "Look at all the untracked and outstanding md files", second attempt (2 September)

Branch `task-please-look-at-all-the-untrack-mtjvhjeh`. Hit its cost cap after 9 iterations.

Counts: 0 already on main, 4 superseded, 3 novel, 0 old doc copies.

Novel:
- Cancelling a loop while its first verification check is still running can bring the loop back
  as "paused" instead of cancelled. The pause path overwrites the status without checking whether
  the loop has already ended (`loop-coordinator.ts:1853-1866` and `:3695-3709`). The fix is one
  guard line after the check returns. Agent-reported; code confirmed, not reproduced.
- A missing regression test for LT-168 (in-session auth repair). The behaviour on main is already
  right; only the test is missing.

Recommendation: land the guard and the test.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 4. "Look at all the untracked and outstanding md files", third attempt (2 September)

Branch `task-please-look-at-all-the-untrack-mtkdez2p`. Paused for review after its first
iteration errored. Mostly copied your untracked plan and livetest files in and edited them.

Counts: 5 already on main, 3 superseded, 18 novel, 75 old doc copies.

Novel:
- The secret card warns as you type when a pasted value does not look like the credential asked
  for, for example a GitHub token that does not start with `github_pat_`. Main built its own
  secret card separately and does not have this. It needs porting into main's version, not a
  straight copy.
- 15 old backlog status reports (19 July to 31 August) that never existed in the root checkout.
  Your current livetest files and the remediation register already cover them.

Old doc copies: your root versions are newer everywhere. Nothing is missing from them.

Recommendation: land only the secret-card format warning.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 5. "SO FINISH THE WORK PLEASE" (2 September)

Branch `task-so-finish-the-work-please-mtklsatd`. Paused for review after 7 iterations. This is
most of the Settings redesign plan.

Counts: 2 already on main, 2 superseded, 37 novel, 11 old doc copies.

Novel:
- Most of the Settings redesign in the draft now recorded as
  [2026-08-28-settings-ux-remediation_plan_completed.md](2026-08-28-settings-ux-remediation_plan_completed.md): compact, expanded
  and embedded layouts, a shared section-tabs component, a Help drawer, Remote Nodes split into a
  Connected Computers list and detail view, and Permissions split into Requests, Rules, Audit and
  Insights. Main still has the old layout. The new component files apply cleanly. Most edited files
  clash with 33 later commits and would need redoing against current main.
- A guard that stops an interrupt arriving mid-permission-request from breaking the request
  (LT-137). Main's LT-137 fix covers a different part of the same race. It applies cleanly.
- One old status report.

Old doc copies at that inspection: the root Settings plan (linked above under its completed name)
had every step unticked.
The branch copy ticks about 40 steps with dated notes, for example "Step 6: Implement
SettingsSectionTabsComponent … Verified 2026-09-02: 3 files · 33 tests passed". Those ticks
describe this branch, not main. Separately, your root
`2026-08-29-provider-async-work-hibernation_plan_completed.md` was the later filename of a draft
that looked unfinished even though the feature had shipped under different file names. The
original recommendation was to close that draft; its completed record is not a new closure task.

Recommendation: land the LT-137 guard now. Treat the Settings redesign as a planned piece of
work: rebuild it against current main using this branch as the reference, rather than copying
files across.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 6. "Work through all the livetest files" (2 to 3 September)

Branch `task-please-work-through-all-the-li-mtkqr41h`. Stopped for review after 15 iterations
stuck on implementation.

Counts: 5 already on main, 9 superseded, 5 novel, 0 old doc copies.

Novel:
- The same cancel-during-verification guard as item 3, done a different way. Item 3's version is
  smaller.
- The loop preflight result's validation schema rejects the value `cancelled`
  (`loop-audit.schemas.ts:79`), although main's own code can produce it. Main's TypeScript type
  already allows it, so only the schema needs the one-word fix.
- The loop evidence view says "Verify ran and failed" for a cancelled check, when nothing actually
  failed. A two-line fix.

Caution: this branch edited the remediation register to say LT-208 and LT-523 to LT-526 were
"confirmed" live on 3 September. The run never finished, so treat that claim as unverified. It
would not be landed.

Recommendation: land the type fix and the wording fix.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 7. "Investigate all the plan files that are untracked" (3 September)

Branch `task-please-investigate-all-the-pla-mtl9icld`. Stopped for review after 16 iterations.

Counts: 0 already on main, 2 superseded, 8 novel, 0 old doc copies.

Novel:
- A build check that stops early with a clear error when the Node used for the single-file
  worker binaries cannot produce one, instead of failing late inside the packaging tool. It
  applies cleanly.
- A small fix so the frame-restore helper cannot throw if `cancelAnimationFrame` disappears
  between scheduling and cancelling, which can happen in test teardown. It applies cleanly.

Recommendation: land both.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 8. "I said keep going until it's all built!" (5 to 6 September)

Branch `task-i-said-keep-going-uintil-it-s-mtovfbpg`. Hit its 50-iteration cap. Later sessions
rebuilt almost all of it on main.

Counts: 63 already on main, 46 superseded, 8 novel, 0 old doc copies.

Novel:
- Background chat-title generation ignores your list of providers excluded from automatic use,
  so an excluded provider can still be used to name chats (`auto-title-service.ts:516`). A
  one-line fix. Agent-reported; code confirmed, not reproduced.
- The loop spend meter always says "estimated", even when the provider reported the real cost,
  because the caller never passes that fact through. Landed: `costKnown` already existed in the
  main process and the database, so only the validation schema and the timeline caller needed it.
- The loop timeline's recovery buttons only offer Resume. The branch also offered turning on
  provider-limit auto-resume from the banner. Needs a fresh change.
- Three missing tests for the "while you were away" recap. The code on main is already right.

Recommendation: land the title-provider fix and the tests, and fold the two timeline items into
the next loop UI piece of work.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 9. composer-resize-verification (detached checkout, July)

New branch `rescue/composer-resize-verification`. Two edited files for composer resizing, both
already on main in the same form.

Counts: 2 already on main, 0 superseded, 0 novel, 0 old doc copies.

Recommendation: discard.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 10. Claude Code agent worktree agent-a1d7bb162fd56b4c6 (July)

A Codex app-server fix for how CLI exits are classified (LT-004). Main has it word for word.

Counts: 4 already on main, 0 superseded, 0 novel, 0 old doc copies.

Recommendation: discard.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 11. Claude Code agent worktree agent-a4d6deb10e35abdd8 (July)

A local memory-retrieval test suite (WS16). Main has a larger version of it.

Counts: 5 already on main, 3 superseded, 0 novel, 0 old doc copies.

Recommendation: discard.

- (x) Land the novel changes
- ( ) Keep the branch, remove the worktree folder
- ( ) Discard branch and folder
- ( ) Leave exactly as it is

## 12. harness-auto-update-v0.1.0 folder and its one commit

The folder has branch `fix/loop-control-atomic-write` checked out, with one commit not on main:
`48029fbf` "make atomic control writes collision-safe". Main has the same one-line change as
`808c8063` (29 July), whose message says it is the same fix. The code line is identical. The
separate `release/harness-auto-update-v0.1.0` branch is not affected.

Recommendation: discard the folder and the `fix/loop-control-atomic-write` branch.

- (x) Discard branch and folder
- ( ) Remove the folder, keep the branch
- ( ) Leave exactly as it is

## 13. Three worktree records whose folders are gone

`/private/tmp/aio-observer-xss-gate.HXd5Cu`, `/private/tmp/aio-retirement-gate-eca0b78d` and
`/private/tmp/head-check` no longer exist on disk. `git worktree prune --dry-run` would remove
exactly those three records and nothing else.

- (x) Prune the three records
- ( ) Leave them

## 14. The worker-mode-pair-both folder

`.worktrees/worker-mode-pair-both` is not a worktree. It is a plain folder from 11 July that holds
only a `node_modules` directory.

- ( ) Delete the folder
- ( ) Leave it

## 15. Should finished loops be able to land while your root has untracked files?

At the initial inspection, fixing harvest alone would still leave promotion blocked by any dirty
root file; roughly 120 untracked plans were present. The then-uncommitted Plan Queue work offered
an overlap-only rule. This was the question put to James then; the outcome section above records
that overlap-only loop promotion was subsequently implemented.

- (x) Yes: loops land unless their changes overlap your uncommitted files
- ( ) No: keep stopping on any uncommitted file for now, and land loop work by hand
- ( ) Decide later, after Plan Queue is committed

## 16. Leftover "blocked" entries in the loop history

Before the later "Mark resolved" implementation, the report predicted that most rescued runs
would retain "workspace blocked" in their history. It described automatic cleanup for a cap-hit
run whose branch and folder were both discarded, but no operator resolution action for the rest.
The options below preserve the original decision; the outcome section above records the action
subsequently built. They are not current instructions to edit the database or rebuild that control.

- (x) Build a "mark resolved" action for blocked loop runs
- ( ) Leave them showing as blocked
- ( ) Decide later
