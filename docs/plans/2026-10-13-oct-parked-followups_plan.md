# October parked work and remaining follow-ups

**Verifier round-3 finding (23 Oct, high) — fixed:** `src/main/cli/adapters/opencode-native-model-limits.ts` cached
session-overlaid limits as native defaults (the factory mutates `OPENCODE_CONFIG_CONTENT` with its early ceiling and the
reader queried/cached through that overlay, keyed only by major/command/model). Remediated same day — see **Round-4
verifier findings remediation** in the as-built notes. Nothing is waiting to be fixed.


On main: no.

**Status:** parked inventory, **reconciled 23 October 2026** and **carried over 24 October 2026** (see [As-built notes](#as-built-notes)); the independent verifier's round-1 findings (four), round-2 finding (one) and round-3 finding (one) are remediated the same day in the same worktree (see **Round-2/3/4 verifier findings remediation** below), and the 24 October verification round's three findings — one verification-environment blocker, one missing successor document, one tally error — are fixed the same day (see **Round-5 verifier findings remediation** below). Four items are implemented in queue worktree `queue/2026-10-13-oct-parked-followup-4a5986` (A#39, A#158, A#185, A#61), one part is closed as a no-op (8d item 1), and the remote-worker group's design pass is written. Everything else keeps its existing trigger and decision boundary exactly as written below; no trigger or James-only boundary was treated as met without evidence, and no item was dropped. Every still-wanted line is now carried in the active successor [2026-10-24-oct-remaining-followups_plan.md](2026-10-24-oct-remaining-followups_plan.md) (see **Carry-over for the rename**), so the Finishing-item-2 handoff is complete and the coordinator can rename this document `_completed` whenever it decides. The document keeps its active filename and stays active until the coordinator closes it (it is tracked in the root checkout since checkpoint `3be08c73a`; the earlier "untracked" wording is historical).

**Source:** [October follow-ups](2026-10-11-oct-followups_plan.md), Finishing item 2. That plan remains active. This document preserves all five Step 8 parts and all 76 rest-of-list entries before eventual coordinator closure; until then the source remains the acceptance record. Required open parts in Steps 1–7 remain in the source plan and are not transferred here.

**Execution:** re-check the current code and original acceptance criteria when a trigger fires. Use the AIO-supplied checkout, preserve other work, and run browser/desktop steps on `windows-pc` through the gateway. Do not infer permission for deletion, changes to global provider settings, commits, releases, or external writes.

## Parked Step 8 parts


None of these is started until its trigger fires or James says yes, and none blocks closing this plan. Each part keeps the facts the checkers found so the next person does not start from zero. "Tests, risks, done when and
live checks" are written when the design pass is done.

### 8a. FU-B15: A "Needs you" number on the phone app and the thin client (M; design pass first; James's call)

**For James:** The desktop gets one "Needs you" number (Phase 3). Your phone and the thin client show nothing like it. After this they show the same number. The phone already pushes a notice for each prompt, so this is
optional; the recommendation is to wait until Phase 3 has been in use.

**Origin:** Phase 3 "Not in this plan" (Needs you, "later"); B#6. A related piece, the phone's other Needs-you screens, stays in the rest of the list.

**Verified (11 Oct):**
- Phase 3 builds the count in a renderer-side root store (Phase 3 step 6c); main has no equivalent. The phone gets a push per prompt (`src/main/mobile-gateway/mobile-gateway-push.ts:54-87`, title `"<tool> needs approval"`)
  and a lock-screen status word (`liveActivityStatusLabel`, `:90-103`), and no total.
- Phase 0 step 3 only covers closing sessions on phone and thin client. The phone app is in this repo (`apps/mobile`). The phone's session list and DTOs were not read.

**Change (design pass first):**
1. A pure main-side `needs-you-summary.ts` shared with 6d's `live-waiting-approvals.ts` (waiting sessions), plus loop questions (Phase 2 step 13 data) and failed runs, using the same rules module as Phase 3
   (`question-need.ts`, `attentionLevelForLoopQuestion`).
2. Add `needsYouCount` to the mobile gateway's session-list DTO (and the thin-client snapshot); IPC steps from the ground rules if a new channel is needed.
3. Phone app TypeScript (`apps/mobile/src`): a badge on the sessions tab; no nagging while the app is in front.
4. Needs a phone rebuild and reinstall.

**Tests / Risks / Done when / Live checks:** after the design pass. A summary spec should reuse the renderer's cases so the two counters cannot drift; the phone and the desktop must show the same number for the same
state; James's iPhone and a rebuilt app are needed.

**Size and order:** M. After 6d, Phase 3 step 6 and Phase 2 step 13. Choice 14(b).

### 8b. FU-B17: Follow-ups to Phase 3's "Allow once for every tool" (design pass first, after its live checks)

**For James:** Phase 3 step 16 ships switched off. Once it has been seen working, these finish the job: fewer process restarts on shell commands, asks that Auto-approve cannot skip, and answering Claude's questions
inside the turn.

**Origin:** Phase 3 "Not in this plan" (menus) and "Found on the way" 5; B#23 (and its duplicate B#50), B#24, B#25, B#26, B#28 and B#29.

**Verified (11 Oct)** (these rest on Phase 3's own findings, which were not re-read in code): the shell hook defers every Bash command and its safe-tool list is dead code (`defer-permission-hook.mjs:22-27,66-70`);
`AskUserQuestion` is denied at once with no card in step 16 (Phase 3 tests); only the ACP adapter emits `input_required_resolved` (`acp-cli-adapter.ts:1963`, checked by Phase 3). Nothing else in the nine plans builds
any of them.

**Change** (each a separate small change, only after step 16's live checks 1 to 4 pass and its default is on):
1. Retire the shell defer hook so shell asks use the live channel (M; changes what asks, because Claude's own allow rules then apply first; needs a side-by-side run).
2. Live asks for auto-approve sessions' "bypass-immune" asks, such as edits to Claude's own settings files (S-M).
3. Answer `AskUserQuestion` natively: allow with the answers in `updatedInput` (S).
4. Apply Claude's `permission_suggestions` to its settings files, only if James says yes to Phase 3 choice 13's alternative (S). **Recommended: no** (it writes into his global Claude settings; choice 14(c)).
5. Resolved-event receipts ("request ended") from Codex, Gemini, Copilot and Cursor, and on the phone view via `request-outcome.ts` (S each).

**Tests / Risks / Done when / Live checks:** per change, written when each is designed; all need a real Claude session and the rebuilt app.

**Size and order:** M in total. After Phase 3 step 16 and its default flip.

### 8c. FU-B18: An "Everyday / Full" view switch, and tabbed pages instead of 52 menu entries (L; design pass first)

**For James:** Phase 3 shortens the menu and keeps everything. This is the bigger idea: one switch that hides the instrumentation for a calmer screen, and related pages merged into tabbed pages.

**Origin:** Phase 3 "Not in this plan" (menus; session screen; Needs you); B#21, B#22, B#5 and B#33.

**Verified (11 Oct):**
- Backlog C10: "Better still, an 'Everyday / Full' view switch ... AIO must never hide the auto-approve indicator in the simple view" (`claude_oct-todo.md:770-771`). Phase 3 choice 6 defers it "because the switch hides parts
  of the session screen that steps 2 and 5 are still reshaping" and names a Phase 5 item or a follow-up plan; Phase 5 has no such step (searched `interfaceMode|Everyday / Full` over all nine: only Phase 3).
- Phase 3 step 9 item 7 is the optional page-visit recording (`NavigationEnd`); nothing counts visits today.

**Change (design pass first):**
1. Collect two to four weeks of page-visit data with Phase 3 step 9 item 7 switched on, to decide which pages are everyday.
2. A setting `interfaceMode: 'everyday' | 'full'` in the five places, default `full`; it never overwrites user settings (a shadow layer), and the palette is always the way back.
3. A guard spec: approvals, "Needs you", errors and the Auto-approve indicator are never hidden in any mode.
4. Tabbed pages: Compare & verify (Verification, Debate, Council, Split Compare), Memory, Search, Health, Remote computers; drop the four "Workspace layout" presets in Tools & Views (UX-7).

**Tests / Risks / Done when / Live checks:** after the design pass. Main risk: hiding something that matters (the guard); second: broken links (keep every route).

**Size and order:** L. After Phase 3 steps 5 and 9. **Decision for James:** whether he still wants it once the Phase 3 menu is in use (choice 14(d)).

### 8d. FU-B19: Small tidy-ups that wait for a trigger (XS-S each)

**For James:** Nothing to notice; these finish earlier work once their condition is met.

**Origin:** B#1, B#17 (and its duplicate B#68), B#18, B#19 (and B#69), B#59 (and B#90), B#60, B#64, B#65, B#85, B#89 and B#93 (also A#84, the same picker hover card).

**Verified (11 Oct):** each is stated in the plan that defers it; none has a step elsewhere (searched all nine). B#85 was checked against Phase 3 steps 10a to 10d: a page badge but no dot in the icon-only state.

**Change** (each with its trigger):
1. Delete Phase 4 step 1's hover bridge (B#59, B#90). Trigger: native-title counts are zero everywhere and the seven transcript HTML strings (`markdown.service.ts:145,276,460,464,470,473`,
   `codex-followup-markdown.ts:69`) read a data attribute the bridge also reads.
2. Promote the "disabled needs a reason" and "tooltip begins with the name" reports to the guard (B#60). Trigger: Phase 4 step 5's adoption has settled.
3. Switch `scripts/ui-text/extract-ui-text.ts` to Phase 4 step 2's template reader (B#17, B#68). Trigger: step 2 exists.
4. Take the phone's "instance"/"thread" count for `apps/mobile/src` and add Rule B there (B#18). Trigger: any time after Phase 3 step 8a.
5. Rewrite the remaining `*.help.ts` articles, merge Settings' own Help drawer into the shared panel, and add "Which one do I want?" boxes to five empty states (B#19, B#69, B#64, B#65). Trigger: after Phase 4 steps 6 and 7
   are in use. (The Harness help pages that backlog A12 proposed are not part of this; James dropped them.)
6. A visible status dot on the icon-only Settings menu (B#85). Trigger: Phase 3 step 10d and Phase 4 part 2 step 1a both landed.
7. A hover card in the model picker using `appTooltipTpl` (B#93, A#84). Trigger: after Phase 4 part 3 folder `models` (1f).
8. A recycle hint without the number "about 1,200 characters" (B#89). Trigger: James prefers it (one line; the cap is a main constant, `loop-recycle-handoff.ts:18-23`).
9. Fold the orchestration HUD into the status strip (B#1). Trigger: after Phase 3 step 5.

**Tests / Risks / Done when / Live checks:** each as it is built.

**Size and order:** XS-S each. See the triggers.

### 8e. FU-B20: Copilot's context-window counter and its native context tools (M; design pass first; parked)

**For James:** The Copilot context ring says only "Tokens used" because Copilot does not report how full its window is. This would show a real figure and use Copilot's own context tools in long runs. It only matters
once Copilot loops are used again.

**Origin:** Phase 2 "Not in this plan" (B2/B3, "unowned") and Phase 5 "Not in this plan" ("it needs an owner"); B#128 and A#131 (the same piece).

**Verified (11 Oct):**
- Today's Copilot ring text: "Tokens used this session: N (this provider does not report context-window occupancy)" (`composer-toolbar.component.ts:392-445`, from audit `ref-copilot-sdk-plans.md:51`; not re-read).
- The CLI setting is `contextManagementTools: true` after a trial (`ref-copilot-sdk-plans.md:139,343`).
- Loops have not run since 23 Sep (Phase 5 choice 1).

**Change (design pass first):** (a) a measured occupancy figure from Copilot's cumulative usage ledger (Phase 0 step 7c) for the ring and the warning; (b) trial `contextManagementTools: true` in the spawn settings for loop
sessions, with a live check that `session_memory_v2` appears in the system message.

**Tests / Risks / Done when / Live checks:** after the design pass; the trial needs the installed Copilot CLI.

**Size and order:** M. Trigger: Copilot loops are used. After Phase 0 step 7c.


## Remaining list (76 entries)

These pieces have no home in any plan and no step above. Each line gives the piece, the plan it came from, the trigger that would wake it (if the plan gives one), and the standing rule: **re-check the code before
building**, because none of them was traced to code (the checkers ran out of budget, or the piece waits on something). They do not block closing this plan. Before this plan is renamed `_completed`, any line that is still
wanted moves into a new dated follow-up doc (see [Finishing](#finishing)). `A#n` and `B#n` are row numbers in the two inventory tables; rows are merged on one line when they are the same piece. A script confirmed that every
"no home" row of both tables is either in a step above or on a line below.

**Helper agents, context ceilings and prompts (Phase 1 hand-offs)**
- **Codex `thread/revert` and `thread/fork` experiments to drop a failed loop attempt (CXC-06).** Phase 1, Not in this plan (A16). Trigger: none given ("their own later item"). Re-check the code before building. (A#46)
- **A per-chat switch for Codex helper agents** (a new control and a restart of that Codex session, size M). Phase 1 choice 3's alternative. Trigger: James says yes to that alternative. Re-check the code before building. (A#49)
- **A lower context ceiling just for subagents (`autoCompactWindow`).** Phase 1, Not in this plan (A16): it means redefining a built-in agent, and Phase 1 step 5 already makes helpers inherit the main ceiling. Trigger: none;
  low value. Re-check the code before building. (A#51)
- **"Prefer Explore for read-only research" guidance (TR-2(b)).** Phase 1, Not in this plan (A16). Trigger: none; wording only. Re-check the code before building. (A#53)
- **A5b leftovers: block the two unused built-in tools; move memory text from the system prompt into the first user message (AT-8); a per-session menu (OCX-3) and `/doctor prompt-audit`.** Phase 1, Not in this plan
  (A5b): "no step takes it". Trigger: none given. Re-check the code before building. (A#57, A#58, A#60)
- **OpenCode's context ceiling (`limit.context` defaults to 1,000,000).** Phase 1, Not in this plan (A4): "unplaced; a follow-up to step 11 after the MiMo commit". Trigger: the MiMo work is committed. Re-check the code
  before building. (A#61)
- **Copilot's own compaction lever and discarded context fill-up (CPS-1, CPS-2).** Phase 1, Not in this plan (A5): "unconfirmed over ACP; Phase 3's Copilot work or later"; Phase 3 has neither. Trigger: none given. Re-check
  the code before building. (A#62)
- **Switch the security plugin per turn inside a borrowed live chat.** Phase 1 step 4 risk: it needs `reload_plugins` (`apply_flag_settings` now exists through step 14d). A rare path. Trigger: none given. Re-check the code
  before building. (A#63)
- **Copilot's output cap (CPS-12).** Phase 1, Not in this plan (A19). Trigger: Phase 3 step 12a gives a Copilot measurement. Re-check the code before building. (A#69)
- **A per-spawn `notify` parameter and compact JSON (17.1).** Phase 1, Not in this plan (A17). Nice-to-have. Trigger: none given. Re-check the code before building. (A#71)
- **Tag turns a machine causes inside a person's session (helper results, automation wake-ups).** Phase 1, Not in this plan (A0-S, A0-H). Trigger: Phase 1 steps 8a and 13c have landed and the admission-service delivery
  point has been traced. Re-check the code before building. (A#76)
- **OpenCode: a stream-timeout setting (A6.6) and a cheaper `explore` model (A6.7).** Phase 1 step 11c. Triggers: a live check shows a timeout retry; "with the other cheaper-helper-model work" (Phase 1 step 2 is Claude
  only). Re-check the code before building. (A#79, A#80)
- **"Compact first" for Chats (A9.3).** Phase 1 step 12c covers the session composer only. Trigger: none given. Re-check the code before building. (A#82)
- **Copilot roster facts in the model picker (window, multiplier, token prices).** Phase 1, Not in this plan (A9), which names "Phase 3's Copilot AI credits item"; Phase 3 step 12a is the bill only. Trigger: none given.
  Re-check the code before building. (A#83)
- **Quick ask as the first turn of a side chat; save a quick-ask answer into the transcript; a `/btw` command.** Phase 1, Not in this plan (A8). Feature ideas. Trigger: none given. Re-check the code before building.
  (A#87, A#88)
- **A proper `end_session` request for a graceful Claude teardown.** Phase 1 (A8), where the dead method is deleted instead, and Housekeeping. Trigger: a transcript-flush problem is seen. Re-check the code before building.
  (A#89, A#186)
- **Phone and thin-client quick ask, and phone and thin-client "build in a new session".** Phase 1, Not in this plan (A8, A21); Phase 2 says "no phase owns the phone app". Trigger: none given. Re-check the code before
  building. (A#91)
- **A "Model for building" setting.** Phase 1 choice 20's alternative (step 15 is deferred). Trigger: James says yes to that alternative. Re-check the code before building. (A#92)
- **Per-stage models for loops (JN-2 item 3), and asking the plan agent to list the files it read.** Phase 1, Not in this plan (A21). Feature ideas. Trigger: none given. Re-check the code before building. (A#93)
- **Other pages that ask for a typed session id (Snapshots, Checkpoints, Communication).** Phase 1, Not in this plan (A21): "the same fix pattern, a separate item"; step 15a fixes only the Plan Mode page. (The Communication
  page goes if part 5h is done.) Trigger: none given. Re-check the code before building. (A#94)
- **Loop verify-failure text through `rtk pipe --filter` (RTK-8).** Phase 1, Not in this plan (A13), which names "Phase 2's verify-excerpt work"; Phase 2 never mentions RTK. It helps only James's other stacks. Trigger: none
  given. Re-check the code before building. (A#95)
- **An RTK status chip on the session header and loop summary (RTK-12).** Phase 1, Not in this plan (A13). Trigger: the RTK hook decision log exists. Re-check the code before building. (A#96)
- **An Antigravity plugin hook for RTK (RTK-5) and a per-loop RTK recall store (RTK-9).** Phase 1, Not in this plan (A13). Feature ideas. Trigger: none given. Re-check the code before building. (A#98)

**Remote worker machines (one design pass first)**
- **Carry `sessionKind` across the remote worker spawn call; give worker-node Claude sessions the new options; gate the output cap on the worker's CLI version; switch model live on a worker (needs an RPC); RTK on workers
  (RTK-6); keep a worker PC awake; Windows and remote-session sampling for stuck warnings.** Phase 1, Not in this plan (A16, A5, A19, A8, A13) and Phase 2, Not in this plan (B14, B10). Trigger: `remote-node/rpc-schemas.ts`
  is committed; a design pass comes first. Re-check the code before building. (A#50, A#64, A#70, A#90, A#97, A#119, A#142)

**Loops (Phase 0 and Phase 2 hand-offs)**
- **A setting to review child sessions automatically.** Phase 0, Not in this plan (A14). Trigger: none given. Re-check the code before building. (A#17)
- **A loop that borrows a chat's Claude adapter may start a second Claude process on that chat's session.** Phase 0 "Found on the way" 2; Phase 0 step 11 item 7 only adds a test. Trigger: that test fails (the fix then needs
  its own part). Re-check the code before building. (A#28)
- **"Add more" at a loop cost cap, with amounts from past runs (CPS-9).** Phase 2, Not in this plan. Trigger: James sets a loop cost cap. Re-check the code before building. (A#113)
- **An end card with a "Run it now" button for each skipped check, and finish-budget controls.** Phase 2, Not in this plan (step 15 shows the list under Details and offers no button). Trigger: none given. Re-check the
  code before building. (A#115)
- **An `origin` field on review findings, and earlier-rounds memory for the fresh-eyes reviewer (SBT-1, SBT-4).** Phase 2, Not in this plan (step 14 covers the ping-pong reviewer only). Trigger: none given. Re-check the
  code before building. (A#116)
- **Battery-aware behaviour (do not hold the Mac awake on battery).** Phase 2, Not in this plan (B14). Nice-to-have. Trigger: none given. Re-check the code before building. (A#118)
- **Copilot `continueOnAutoMode` (CPS-4), and fixtures from real logs for Copilot's new usage-limit wording.** Phase 2, Not in this plan (B15). Triggers: none given ("not in the backlog"); the new wording shows up in a log.
  Re-check the code before building. (A#121, A#123)
- **A hook that counts calls and warns at 80 to 90 percent of the step limit (HR-4 step 2).** Phase 2, Not in this plan (B6). Trigger: the scorecard (Phase 2 step 7e) shows the note is not enough. Re-check the code before
  building. (A#124)
- **Act on other stop reasons (`prompt_too_long`, `budget_exhausted`, `hook_stopped`); store `num_turns`; a Codex stop-reason view.** Phase 2, Not in this plan (B6); `num_turns` needs room in `default-invokers.ts`.
  Trigger: none given. Re-check the code before building. (A#125)
- **Attribute helper model calls to a loop run.** Phase 2, Not in this plan (B6): they carry no run id. Low value. Trigger: none given. Re-check the code before building. (A#127)
- **An app-wide default check time limit (a five-places setting).** Phase 2, Not in this plan (B2/B3). Trigger: James wants `/goal` and automations to differ from 20 minutes. Re-check the code before building. (A#132)
- **More failure formats for the checks (oxlint, pytest, Maven, Go).** Phase 2, Not in this plan (B2/B3). Trigger: a loop meets one ("added with fixtures as needed"). Re-check the code before building. (A#133)
- **Mobile screens beyond widening the item kind (B5).** Phase 2, Not in this plan: "no phase owns the phone app" (see also part 8a). Trigger: none given. Re-check the code before building. (A#136)
- **A per-loop switch to turn "Decisions applied" off.** Phase 2, Not in this plan (B5). Trigger: none given. Re-check the code before building. (A#138)
- **A persistent reviewer session, and a user-pinned review depth.** Phase 2, Not in this plan (B7). Feature ideas. Trigger: none given. Re-check the code before building. (A#140)
- **Remove the unused review fields `lowOnlyChurnRounds` and `freshReviewerEachRound`.** Phase 2, Not in this plan (B7) and "Found on the way" 17: dead code; `freshReviewerEachRound` is read nowhere in `src/main`. Trigger:
  none given. Re-check the code before building. (A#141)
- **A "Stop just the child" button.** Phase 2, Not in this plan (B10): it needs IPC and a safety call. Trigger: none given. Re-check the code before building. (A#143)
- **More process facts on Codex's 15-minute stall error and on iteration-timeout failures; a calm interim notice during long Codex silences; soften the hard stop for other providers; Claude partial-message liveness.**
  Phase 2, Not in this plan (B10). Trigger: none given (data says Claude warnings are rare: 3 in 3 days). Re-check the code before building. (A#144)
- **Loop start-panel presets with an "Advanced" fold (LP-16), the seven status renderings merged (U4), and the duplicate end message in the transcript collapsed.** Phase 2, Not in this plan (B8/B9), which says Phase 3's C6
  absorbs them through `describeLoopEnd`; Phase 3 never mentions `describeLoopEnd`, LP-16 or those parts. Trigger: none given. Re-check the code before building. (A#146, A#147)
- **A "pick a side" control for `needs-human-arbitration`.** Phase 2, Not in this plan (B8/B9). Trigger: that state ever occurs (none of 141 runs has reached it). Re-check the code before building. (A#149)
- **A paused loop leaves its campaign step "running" (the campaign half of part 4a's problem).** Phase 2 "Found on the way" 2: "extend 8d's rule to them if James wants". Trigger: James wants 4a's rule extended to
  campaigns. Re-check the code before building. (A#156, campaign half)
- **`recordCompletionCost` returns early for a turn with no billable usage.** Phase 2 "Found on the way" 4 ("Phase 0 7b may cure it"). Trigger: Phase 0 step 7b has landed and a zero-cost turn still books nothing. Re-check
  the code before building. (A#158)
- **Dead code in the loop area: `loop-resource-view.ts` types never migrated; ten private copies of a closing-tag escaper plus three more; `process:interactive-prompt` emitted and nobody listens
  (`stuck-process-detector.ts:485-507`).** Phase 2 "Found on the way" 5, 10 and 13. Trigger: none given. Re-check the code before building. (A#159, A#164, A#167)
- **Small wording and blocking-call fixes in the loop area: `NotebookEdit`'s `notebook_path` missing from the capture's read-lock keys; a stale doc for `maxLedgerStallIterations` (`loop.types.ts:206-213`,
  `loop.schemas.ts:236-238`); `execFileSync('pgrep')` blocks the main process up to 1 s on the verify-timeout path (`loop-wait-on-pid.ts:179`, "minor").** Phase 2 "Found on the way" 9, 12 and 15. Trigger: none given.
  Re-check the code before building. (A#163, A#166, A#169)
- **The renderer `loop.store.ts` is at its limit and needs a refactor.** Phase 2 "Found on the way" 6 (second half; the plan-queue half is Phase 2 step 4a). Trigger: before more work lands in that file. Re-check the code
  before building. (A#160, second half)
- **Lost parent messages leave no trace; "a lost run summary is still invisible to James".** Phase 2 "Found on the way" 22; step 4c narrows the cases and adds a debug line. Trigger: none given. Re-check the code before
  building. (A#176)

**The phone app's words**
- **The phone's three loop screens print raw loop status words ("attempt-failed", "completed-needs-review"); `apps/mobile/.../loop-detail.component.ts` prints `item.kind · item.status` raw.** Phase 0 step 1 ("record as a
  follow-up for Phase 3's wording pass"); Phase 3 steps 8f and 17a cover instance statuses and push titles only. Trigger: Phase 0 step 1 has landed (it adds the new word). Re-check the code before building. (A#39)

**Housekeeping and the debug record**
- **An opt-in weekly tidy for activity logs, saved records and backups.** Housekeeping, Not in this plan. Trigger: a month of use of the disk space card. Re-check the code before building. (A#182)
- **Branches with no work folder (18 `queue/*`, `release/harness-auto-update-v0.1.0`, one unmerged `task-*`, six merged).** Housekeeping, Not in this plan: "a second list on the leftover card or the plan queue's own landing
  tidy-up". Needs James's ask-first rule for branches. Trigger: James asks. Re-check the code before building. (A#184)
- **A lasting counter for self wake-ups, and a turn-origin tag (an `origin` column in Phase 0 step 7b's per-turn record).** Housekeeping, Not in this plan and choice 14. Trigger: Phase 0 step 7b has landed. Re-check the
  code before building. (A#185)
- **Quota cooldowns for Codex, Copilot, Gemini and the rest.** Housekeeping, Not in this plan. Trigger: Housekeeping step 10's log line shows which endpoints refuse. Re-check the code before building. (A#191)
- **Claude tool results never carry a failure flag in the debug record** (all 227,226 rows say `success: true`). Housekeeping "Found on the way" 4; it matters little with the record off by default. Trigger: none given.
  Re-check the code before building. (A#197)
- **The context bar's "about $x" is the latest request's cost, and its legacy pricing branch is dead.** Housekeeping "Found on the way" 5: Phase 3's C2 decides, and deleting the dead branch belongs with that decision.
  Trigger: Phase 3 step 2's decision. Re-check the code before building. (A#198)
- **The memory-database warning banner appears only at 10 GB and says "RLM"** (`rlm-maintenance.types.ts:1`). Housekeeping "Found on the way" 7. Wording. Trigger: none given. Re-check the code before building. (A#200)

**Session screen, Needs you and menus (Phase 3 hand-offs)**
- **A read-only main-process lookup of the real permission policy for custom modes** (`side-chat-authority.ts:96-111`). Phase 3 step 3 risks. Trigger: custom modes turn out to be common. Re-check the code before building. (B#3)
- **Digits in the Windows taskbar icon.** Phase 3 choice 8's alternative. Trigger: James wants a number there. Re-check the code before building. (B#8)
- **An on/off switch for the new permission alerts.** Phase 3 choice 4. Trigger: the alerts prove noisy. Re-check the code before building. (B#9)
- **`requiresRestart` badges.** Phase 3 step 10b ships the plumbing with `dependsOn` only. Trigger: a setting is proven to need a restart. Re-check the code before building. (B#14)
- **Copilot AI credits for sessions on another machine** (the worker keeps its own `events.jsonl`). Phase 3, Not in this plan (costs): "later, on request". Trigger: James asks. Re-check the code before building. (B#37)
- **JN-1's optional "this subagent has used 400K tokens" notice.** Phase 3, Not in this plan (costs): "later"; off by default. Trigger: none given. Re-check the code before building. (B#41)

**Chat, search, confirm boxes and tips (Phase 5 hand-offs)**
- **B11b live steering of a loop (Codex `turn/steer` first).** Phase 5 choice 1: "goes in its own plan if loops come back". Trigger: loops come back into use. Re-check the code before building. (B#97)
- **B12 "provider goal mode" (`/goal` hands the goal to Codex).** Phase 5, Not in this plan (backlog T3-02(c)): "a separate decision"; it was not offered to James as a numbered choice. Trigger: needs a yes or no if loops
  come back. Re-check the code before building. (B#100)
- **Restore the Codex goal bar after a renderer reload.** Phase 5, Not in this plan. Trigger: `instance-list.store.ts` shrinks (868 of 868 lines) and parked Phase 5 step 18 is built. Re-check the code before building.
  (B#101)
- **`read_session` for Gemini and Antigravity** (they have no orchestrator tools bridge). Phase 5, Not in this plan: "a separate item". Trigger: none given. Re-check the code before building. (B#102)
- **C13.1 full-text search over every message (size L), retire Chat Search, merge the History sidebar.** Phase 5, Not in this plan: "a later 'search' item". Trigger: none given. Re-check the code before building. (B#104)
- **C12 follow-ups: re-queue a cancelled queued message at its old position (needs a position-aware queue API); Undo on the phone and thin client; move the other hand-built confirm boxes onto the new confirm service
  (`history-sidebar.component.ts:102-123`, `plan-queue-parked-list.component.html:18`, `snapshot-page.component.html:322-327`, `shared/terminate-confirm/*`).** Phase 5, Not in this plan ("not planned"). Trigger: none
  given. Re-check the code before building. (B#105, B#107, B#108)
- **Saved (history) child threads in the child-session strip.** Phase 5 step 12 item 3 ("not covered here"). Trigger: none given. Re-check the code before building. (B#114)
- **Read `TaskCreate` and `TaskUpdate` in `todo-tool-parser.ts`.** Phase 5, Not in this plan (C13.7). Trigger: Phase 5 step 9's live check shows Claude uses them instead of `TodoWrite`. Re-check the code before building.
  (B#115)
- **"Used in N of the last 20 sessions" for tool servers** (needs a per-session tool-use query). Phase 5, Not in this plan (C13.8). Trigger: none given. Re-check the code before building. (B#117)
- **A "Memory in this session" block** (which starting notes a session was given). Phase 5, Not in this plan (C13.10); Phase 3 step 15 adds only a count line. Trigger: none given. Re-check the code before building. (B#119)
- **Jean's third piece: a stable-prompt line asking agents to write findings as a `#`-column table.** Phase 5, Not in this plan (C13.11); it touches the cache-stable prefix (`prompt-injection-contract.ts`). Trigger: none
  given. Re-check the code before building. (B#121)
- **Idle-time tips (Hermes HU-8), and tips on the phone.** Phase 5, Not in this plan (D11): "later" and "not planned". Trigger: none given. Re-check the code before building. (B#122, B#123)

## As-built notes

### Reconciliation round — 23 October 2026 (queue worker, worktree `queue/2026-10-13-oct-parked-followup-4a5986`)

**The recorded readiness decision for this job:** verify fixes already present and reconcile the inventory; preserve unmet
triggers and permission boundaries. Everything below was re-checked against the code in the queue worktree (branch
`queue/2026-10-13-oct-parked-followup-4a5986`, cut from the base branch) and against the plans that landed after 13 October.
Trigger sources re-checked on 23 Oct: **Phase 0 is `_completed`** (its steps 1, 7b and 7c landed — honest loop end states,
the per-turn cost ledger, Copilot per-turn usage), **Phase 2, Phase 4 and Housekeeping are `_completed`**, the 18–19 October
phase0 and remote-worker plans are `_completed`, and the 20 October **oct2 programme** exists (`claude_oct-2-todo.md`;
decisions answered 20 Oct, "go with your recommendations") but its own status blocks report phases B–F not integrated.
**Phase 3's 17 steps are implemented only on `queue/2026-10-10-oct-phase3-calm-scr-5d08d9`** (that plan's 23 Oct status block)
and are absent from this base — `project-group-computation.service.ts`, `needs-you-summary.ts` and the typed status strip do
not exist here — so every trigger worded "Phase 3 step N landed / in use" is unmet. Nothing below invents a James answer, a
deletion, a global-settings change, a commit or an external write.

#### Implemented this round (4 items)

| Item | What landed | Evidence |
|---|---|---|
| **A#39** — the phone's raw loop status words | `apps/mobile/src/app/core/status.ts` gains `loopStatusLabel` (phrases copied verbatim from the desktop `loopStatusLabel` (`src/renderer/app/features/loop/loop-formatters.util.ts`) so phone and desktop cannot drift), `loopQuestionKindLabel` (covers the previously unmapped `open-question`) and `loopQuestionStatusLabel`. The three loop screens (`loops.component.ts`, `loop-card.component.ts`, `loop-detail.component.ts`) and the question line now show these instead of raw codes like `attempt-failed` and `item.kind · item.status`. Recorded deviation: the wording guide's "one shared source" rule awaits Phase 3's unified status presenter, which has not shipped; the phone follows the app's existing `core/status.ts` mirror pattern ("mirroring the desktop … so phone and desktop agree") and the spec pins every desktop phrase verbatim so the two cannot drift silently. | `status.spec.ts` (9 tests, every phrase pinned); full mobile suite **59 files / 515 tests** green (deps installed in the worktree first — `apps/mobile/node_modules` had been empty); mobile `tsc -p tsconfig.app.json --noEmit` and eslint clean. |
| **A#158** — a turn with no billable usage booked nothing | `recordCompletionCost` (`src/main/instance/communication-completion-cost.ts`) no longer early-returns on zero usage: the turn books a zero-cost `cost_entries` row and one `instance-turn` attribution row (reported-zero usage; `costKnown: false` / `costSource: 'unknown'` when the cost is absent, `true` / `'provider'` for a provider-reported $0), so turn counts and plan-queue spend stop under-reporting resident sessions (Phase 2 "Found on the way" 4's 14-turn session with zero cost entries). Nothing is invented: cost is zero and cache analytics is not fed (there is no measurement to record). Trigger conditions confirmed before building: Phase 0 step 7b has landed and the zero-cost early return was still present. | New `src/main/instance/communication-completion-cost.spec.ts` (5 cases: no-usage turn, all-zero turn, provider-reported $0, measured-turn regression, origin tagging). `cli-worker-resident-cost.spec.ts`'s authentication-failure case updated from "books nothing" to "books exactly one zero-cost record and never prices the failure text as paid" — the test's own intent unchanged, the old zero-entry expectation is exactly the behaviour A#158 retires. That file plus `claude-direct-failed-usage.spec.ts`: **38 tests** green (after `npm run build:main` supplied the worker fixtures). |
| **A#185** — lasting self wake-up counter and a turn-origin tag | Migration **`079_cost_entry_origin`** adds a nullable `origin` column to `cost_entries`; `CostEntry`, `recordUsage`, `CostAttributionRecord` and `recordInstanceTurnAttribution` all carry `origin` (canonical `user` / `machine`, open tag so later values such as `self-wakeup` pass through), and `recordCompletionCost` populates it from `machineSessionReasonOf`. `SelfWakeupTracker`'s per-day tally is now durable: new `src/main/instance/self-wakeup-tally-store.ts` writes `<userData>/self-wakeup-tally.json` (fail-soft when no directory resolves) and the tracker reloads it at start-up — the lasting counter Housekeeping step 11 deliberately left in memory (its choice 14). Recorded choice: `cost_entries_a0_backup` does **not** grow the column; the A0 repair's backup INSERT now names its twelve columns, so the fixed-shape backup table cannot break when `cost_entries` grows (the class of break that hit the Phase 3 round-1 verifier). Scope boundary kept: finer tagging of machine-caused turns inside a person's session remains **A#76** (its admission-service trigger is unmet); the column is ready for it. | Tracker spec gains a lasting-counter block (persist → reload → increment → reload; no-directory no-op; corrupt-file recovery): `self-wakeup-tracker.spec.ts`, `communication-completion-cost.spec.ts`, `cost-attribution.spec.ts`, `cost-tracker.spec.ts`, `rlm-migrations-076-080.spec.ts`, `cost-entries-a0-repair.spec.ts` — **80 tests** green. |
| **A#61** — OpenCode's context ceiling (`limit.context` defaults to 1,000,000) | Trigger re-checked and met: the MiMo work is committed (`opencode-generation-budget.ts` now scopes MiMo deliberately with its documented 1M window; the `mimo-*` provider-quota modules are in the base). The gap re-checked too: `contextCeilingTokens` (settings `machineContextCeilingTokens` / `ownChatContextCeilingTokens`, default 0 = provider window) reached Claude via `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and did nothing for OpenCode. New `applyOpenCodeContextCeiling` in `src/main/cli/adapters/context-ceiling.ts` clamps the session model's `limit.context` **down** to the ceiling (never up; a model with no recorded limit gets the ceiling as its working window), wired at both config-assembly points in `opencode-adapter-factory.ts`, after the generation budget each time. Because the ceiling settings default to 0, behaviour is unchanged until James configures a ceiling — then Claude and OpenCode share one policy. | `context-ceiling.spec.ts` (clamp-down, no-clamp-up, missing-limit, no-op cases) plus `opencode-generation-budget.spec.ts`, `opencode-account-provider-config.spec.ts` (**69 tests**) and `adapter-factory-opencode.spec.ts` (**14 tests**) green. |

#### Closed as a no-op (1 part item)

- **8d item 1** (delete Phase 4 step 1's hover bridge; B#59, B#90): closed, as the source plan's round-8 ledger already
  records — the bridge was never built (`hover-bridge` / `titleBridge` match nothing in `src`), so there is nothing to
  delete and the item cannot become work unless that bridge first exists.

#### Design pass written; build not started (1 group, the item's own first stage)

The remote-worker group (**A#50, A#64, A#70, A#90, A#97, A#119, A#142**) woke on its trigger: `src/main/remote-node/rpc-schemas.ts`
is committed (tracked in git). Its own instruction is "a design pass comes first", so this round delivers the design pass only.
Re-checked baseline: `RemoteClaudeSpawnPolicySchema` (`src/main/remote-node/claude-spawn-policy-schema.ts`) already carries
`machineSession`, `contextCeilingTokens`, `readOnlyReview`, `maxTurns` and `maxBudgetUsd` to workers advertising
`claudeSpawnPolicy: 1` (strict schema; older workers strip it), and the 19 October remote-worker plan enforces it fail-closed —
so "give worker-node Claude sessions the new options" is largely already present. Per feature (Change / Tests / Risks /
Done when / Live checks):

1. **Carry `sessionKind` across the remote worker spawn call.** Change: add optional `sessionKind` (same enum as
   `UnifiedSpawnOptions.sessionKind`) to the remote spawn policy and gate sending it on a `claudeSpawnPolicy: 2` capability,
   so older strict-parsing workers fail closed rather than silently strip it; the worker passes it into its own
   `createClaudeAdapter`. Tests: schema round-trip, capability-gated send, `adapter-factory-claude-remote-policy.spec.ts`
   parity. Risks: old workers reject unknown strict fields by design — the capability gate is the fix. Done when: a worker
   session's spawn carries and applies `sessionKind` and a pre-2 worker still spawns without it. Live check: spawn on
   `windows-pc` and read the worker's spawn log.
2. **Give worker-node Claude sessions the new options (parity guard).** Change: keep `RemoteClaudeSpawnPolicySchema` the
   single carrier and add a parity test listing local spawn options vs remote policy fields, so a future option cannot ship
   local-only silently. Done when the parity test exists and every option either travels or is listed local-only with a reason.
3. **Gate the output cap on the worker's CLI version.** Change: the worker advertises its CLI version in
   `NodeRegisterParamsSchema`; the coordinator sends the output cap only to workers whose CLI supports it and logs the
   fallback otherwise. Tests: capability parse + policy units. Risks: silently-ignored caps on old CLIs — the gate makes the
   absence explicit. Done when: capable workers are capped and incapable ones spawn honestly uncapped and say so.
4. **Switch model live on a worker (needs an RPC).** Change: an `instance.changeModel` RPC in `rpc-schemas.ts` dispatched in
   `worker-rpc-dispatcher.ts` to the worker's existing local change-model path (reusing `instance-manager.change-model`
   semantics including the mid-turn guard). Tests: schema/dispatcher round-trip reusing the local cases. Risks: partial-turn
   switches — keep the local guard. Done when remote behaves like local; live check on `windows-pc`.
5. **RTK on workers (RTK-6).** Change: carry `rtk` spawn options over `instance.spawn` and apply `extendEnvWithRtk` on the
   worker; worker installs fetch the pinned RTK binaries (`scripts/fetch-rtk-binaries.js`). Tests: env-composition parity.
   Risks: a worker without binaries must fall back to no-RTK (existing `ORCHESTRATOR_RTK_ENABLED` gating). Done when a worker
   session runs with the RTK hook when the flag is on.
6. **Keep a worker PC awake.** Change: a `node.keepAwake` RPC plus a worker-side power assertion (Windows
   `SetThreadExecutionState` equivalent), released on job end and on heartbeat loss (TTL). Tests: dispatcher units; the power
   call is live-tested. Risks: an unreleased assertion — tie release to the heartbeat TTL. Done when the PC stays awake while
   work runs and may sleep afterwards.
7. **Windows and remote-session sampling for stuck warnings.** Change: run `stuck-process-detector` sampling for Windows
   adapters on the worker and relay its findings (today `process:interactive-prompt` is emitted and nobody listens — see
   A#159); thresholds unchanged. Tests: detector fixtures incl. the LF true/false split plus relay plumbing. Risks: false
   positives on slow Windows spawns. Done when a stuck remote session raises the same warning as a local one.

Order: 1 → 2 → 3 → 5 → 4 → 7 → 6. Building 1–7 is a later round's work.

#### Reconciled as already present or premise changed (verified, not built)

- **A#28** (a borrowed chat adapter may start a second Claude process): trigger is "that test fails" —
  `src/main/orchestration/loop-adapter-borrow.spec.ts` passes (21 tests with `loop-end-wording.spec.ts`, run 23 Oct).
  Trigger unmet; parked.
- **A#89 / A#186** (`end_session`): the dead method is already deleted (no `end_session` at word boundaries in `src/main`
  or `src/shared`), matching the source plan's chosen disposition. The "proper `end_session` request" half keeps its
  trigger ("a transcript-flush problem is seen").
- **A#141** (remove unused review fields): the line's premise is half wrong as written. `lowOnlyChurnRounds` is live code
  (`loop-pingpong-completion.ts:569-607`, `loop-pingpong-completion.js:490-539`) and Phase 2's own as-built says to keep it;
  `freshReviewerEachRound` is still read nowhere in `src/main` (only type/default/schema/preload plumbing). Scope corrected
  to `freshReviewerEachRound` alone; trigger is still "none given", so it stays parked.
- **A#146 / A#147** (LP-16 presets, seven status renderings U4, duplicate end message): premise stale — `describeLoopEnd`
  exists (`src/shared/loop/loop-end-wording.ts`) and is used by `loop-control`, `loop-past-runs-panel` and
  `loop-chat-summary`. The U4 merge is owned by oct2-phaseE step 5 ("one status presenter"), not landed; LP-16 presets and
  the duplicate end message are unchanged. Trigger "none given" → parked.
- **A#159 / A#164 / A#167** (dead code): re-checked — `process:interactive-prompt` is still emitted with no listener
  (`stuck-process-detector.ts:501`); `loop-resource-view.ts` is still consumed only by `loop-convergence-benchmark.ts`
  (its `LoopSpendPurpose` type). Trigger none → parked.
- **A#163 / A#166 / A#169** (small wording and blocking-call fixes): re-checked — `execFileSync('pgrep')` remains at
  `loop-wait-on-pid.ts:179`; `maxLedgerStallIterations`'s doc still says "open-item count may fail to reach a new low"
  (Phase 2 FOW 12's staleness claim stands: WS3 counts task transitions in `loop-ledger-progress.ts`); the `notebook_path`
  read-lock claim is unchanged. Trigger none → parked.
- **A#79 / A#80** (OpenCode stream-timeout setting, cheaper `explore` model): A#79's trigger ("a live check shows a timeout
  retry") never fired; oct2-later step 5 item 5 records A6.6 as closed upstream (OpenCode 2.0.28+ no longer cuts silent
  streams at five minutes) — verify on the installed CLI before building anything. A#80 keeps its trigger. Both parked.
- **A#160** (renderer `loop.store.ts` refactor): 800 lines today (was 801 at its ratchet limit). Its trigger is prospective
  ("before more work lands in that file"), not an event that fired; parked as a standing gate on that file.

#### Parked — triggers unmet or James-only boundaries preserved

The five Step 8 parts keep their boundaries:

| Part | State (23 Oct) | Why it stays parked |
|---|---|---|
| **8a** Needs-you number on phone/thin client | parked | James's call (the plan itself recommends waiting until Phase 3 is in use); Phase 3's needs-you count sits on its queue branch, not in base (`needs-you-summary.ts` absent). Boundary preserved. |
| **8b** Follow-ups to "Allow once for every tool" | parked | Needs "step 16's live checks 1 to 4 pass and its default is on" — `claudeLivePermissionPrompts` still ships **false** (Phase 3's own 23 Oct status) and step 16 is not in base. Unmet. |
| **8c** Everyday / Full view switch | parked | Decision 14(d) is James's (whether he still wants it once the Phase 3 menu is in use) and the menu is not in use; `interfaceMode` is absent from `src`; the page-visit data collection (change 1) has not run. Boundary preserved. |
| **8d** Small tidy-ups | 1 closed no-op (item 1); 8 parked | Item 2 (B#60): `scripts/ui-hints/types.ts` keeps H1c/H7/H8 in `REPORT_ONLY`; promotion belongs with phase4c step 2's "switch the lint rules on as the counts reach zero" and the migration is still rolling (phase4c 1f is partial — `features/models` still carries a native title), so "Phase 4 step 5's adoption has settled" is not yet true. Item 3: `scripts/ui-text/extract-ui-text.ts` does not exist (Phase 3 step 8 never landed) — nothing to switch. Item 4: Phase 3 step 8a not in base. Item 5: "after Phase 4 steps 6 and 7 are in use" needs observed use (unverifiable in-repo), and Phase 3's pending C7 wording pass would collide with a help-article rewrite now. Item 6 (B#85): Phase 3 step 10d not in base (phase4b step 1a IS done — one of its two conditions). Item 7 (B#93): `features/models` is not fully migrated in phase4c's 1f (one raw `title=` remains in `model-selection-panel.component.ts`; `appTooltipTpl` still has no production use) — trigger unmet. Item 8: "Trigger: James prefers it" — preserved. Item 9 (B#1): Phase 3 step 5's status strip not in base. |
| **8e** Copilot context-window counter | parked | Trigger "Copilot loops are used" (none since 23 Sep); `contextManagementTools` appears in no source file. |

The 76 rest-of-list rows, by id. Every row whose trigger is "none given", a James decision, or an observed-use/live-evidence
condition remains parked exactly as written (re-checked this round and unchanged):

- **Trigger "none given" — parked as written:** A#17, A#46, A#51, A#53, A#57/A#58/A#60, A#62, A#63, A#71, A#82, A#83,
  A#87/A#88, A#91, A#93, A#94, A#95, A#98, A#115, A#116, A#118, A#125, A#127, A#136, A#138, A#140, A#143, A#144,
  A#146/A#147, A#159/A#164/A#167, A#160, A#163/A#166/A#169, A#176, A#197, A#200, B#41, B#102, B#104, B#105/B#107/B#108,
  B#114, B#117, B#119, B#121, B#122/B#123.
- **James-only boundary — preserved:** A#49, A#92, A#113, A#132, A#156, A#184, B#8, B#37, B#100.
- **Trigger on evidence not yet observed — unmet:** A#69 (Phase 3 step 12a's Copilot measurement), A#76 (Phase 1 steps
  8a/13c landed and the admission-service delivery point traced — the `origin` column from A#185 is ready for it),
  A#124 (the scorecard shows the note is not enough), A#133 (a loop meets a new failure format), A#149 (the arbitration
  state ever occurs), A#182 (a month of disk-space-card use), A#191 (Housekeeping step 10's log line shows refusals),
  A#198 (Phase 3 step 2's decision), B#3 (custom modes turn out to be common), B#9 (the alerts prove noisy), B#14 (a
  setting proven to need a restart), B#97 (loops come back into use), B#115 (Phase 5 step 9's live check).
- **Half-met or notes:** B#101 (`instance-list.store.ts` is now 843 lines — its first condition has happened; the second,
  "parked Phase 5 step 18 is built", is unmet), A#28/A#79/A#80/A#141/A#146/A#159/A#160/A#163/A#166/A#169/A#89/A#186
  (see "Reconciled" above).

Inventory tally as of this round (corrected 24 Oct: the first version counted the remote-worker group's seven features as
seven of the 76 rows, but the remaining list carries them in one grouped row): of the 76 rows — **4 implemented** (A#39, A#158,
A#185, A#61), **1 grouped row covered by one design pass** (the remote-worker group's seven features), **71 parked** with
triggers/boundaries intact. Of the five parts — **8d item 1 closed as a no-op**, the remaining part items parked as tabled.
Nothing was dropped.

#### Verification run (23 Oct, this worktree)

Targeted tests: mobile suite (59 files / 515 tests) and the mobile Angular build; `self-wakeup-tracker`, `communication-completion-cost`,
`cost-attribution`, `cost-tracker`, `rlm-migrations-076-080`, `cost-entries-a0-repair` (80 tests),
`cli-worker-resident-cost` + `claude-direct-failed-usage` (38 tests), `context-ceiling` + `opencode-generation-budget` +
`opencode-account-provider-config` (69 tests), `adapter-factory-opencode` (14 tests), `loop-adapter-borrow` +
`loop-end-wording` (21 tests) — all green. One transient note: `apps/mobile`'s
`history.behavior.spec.ts` ("windows a long archived transcript…") timed out once at its 5 s limit during a
back-to-back full-suite run under build load, then passed in isolation twice and in two further full-suite runs —
a pre-existing timing flake in a file this change never touches (history paging), recorded here so the verifier is
not surprised by it. Fast static gates: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
`npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer` — all exit 0 (the
renderer's usual initial-bundle budget warning is unchanged). Committed generators made current: the Codex protocol snapshot
regenerated through `build:main` (0.163.0 → 0.164.0) and `npm run generate:architecture` rewrote the inventory. The full
suite stays with the verifier per the queue rules; no browser, desktop app, or external service was used.

#### Carry-over for the rename (coordinator-owned)

Per the source plan's Finishing item 2, when this document is renamed to `_completed` every still-wanted line must move into
a new dated follow-up doc. **Done on 24 October 2026:**
[2026-10-24-oct-remaining-followups_plan.md](2026-10-24-oct-remaining-followups_plan.md) is the active successor and
carries the still-wanted set — the **71 parked rows**, the remote-worker group's remaining build (items 1–7 of its design
pass; the group is one row of the 76) and the tabled Step 8 parts (8a, 8b, 8c, 8d items 2–9, 8e) — together with the
premise re-checks above. The rename itself is the coordinator's and was not performed here.

### Round-2 verifier findings remediation (23 Oct 2026)

**Scope and starting state:** the independent verifier's round 1 returned four findings (2 high, 2 medium) against the round-1
checkpoint — three code defects in the four items this round implemented (A#158, A#185, A#61) and one verification-environment
blocker. All four are fixed or resolved in this worktree (`queue/2026-10-13-oct-parked-followup-4a5986`); no commit, branch,
rename or external action was taken, and this root plan keeps its active filename. Every code fix was reproduced with a red
run before the fix where the fix is behavioural (findings 2 and 3; finding 1 is the verifier's own failing run plus its
recorded evidence, and the assertions were updated to the contract the shipped A#158/A#185 code and its new spec already
pin). There is no linked spec.

- **Finding 1 (four cost tests still assert the pre-A#158 booking and pre-A#185 origin contract) — fixed.**
  `src/main/instance/instance-communication.spec.ts`'s two "does not record when the turn carried no token usage / usage is
  absent entirely" tests now pin the intended behaviour instead of the retired one: a no-usage turn books **exactly one
  zero-cost record** with `origin: 'user'` (A#158's own contract, already pinned by `communication-completion-cost.spec.ts`
  and the updated `cli-worker-resident-cost.spec.ts` case). The LT-046 handoff test keeps its handoff assertion and its
  comment explaining the historical starvation, and its cost line now pins the same one zero-cost record. The stale-event
  and lifecycle checks in `instance-communication.partial-usage.spec.ts` are unchanged; its exact `recordUsage` options
  assertion now includes the new `origin: 'user'` tag (A#185). Nothing in production changed: these are the callers'
  regression assertions catching up to the round-1 behaviour change, as the verifier directed.
  Evidence: `instance-communication.spec.ts` 155 tests + `partial-usage` 1 test green
  (`_scratch/test-run.pid-60011.log`), with the wider A#158/A#185 set green in the same worktree
  (`communication-completion-cost`, `cost-attribution`, `cost-tracker`, `instance-session-cost.integration`,
  `cli-worker-resident-cost`, `cli-worker-failed-usage`, `claude-direct-failed-usage`, `cost-entries-a0-repair`,
  `rlm-migrations-076-080`, `instance-communication.status-recovery`, `cost-handlers` — logs
  `_scratch/test-run.pid-{60011,65344,76807,84409,42806}.log`).
- **Finding 2 (the OpenCode context ceiling could raise native context windows and delete native output caps) — fixed
  (A#61 hardening).** Root cause, matching the verifier's two probes: `applyOpenCodeContextCeiling` read only the overlay's
  OpenCode 1 `provider` tree, so (a) a model whose window exists only in the native registry (or the probe's effective
  config) was treated as "no recorded limit" and given the ceiling as its window — raising a 120,000-token native model to a
  250,000 ceiling — and (b) on an OpenCode 2 `providers`-shaped config it found no limit, created a divergent `provider`
  entry carrying only `context`, and `serializeOpenCodeConfigForV2`'s shallow per-model merge then replaced the 2.x model's
  `limit` wholesale, deleting `output`. Fixes: `context-ceiling.ts` now takes the probe's `effectiveConfig` and resolves the
  model's window before clamping, across the native effective config **and** both overlay shapes (`provider` and
  `providers`); the clamp uses the **narrowest known window** and the ceiling (never up — a native or 2.x limit can no
  longer be raised), writes only where the model entry already lives (creating in every present shape, or `provider` when
  neither exists), and retains every other limit field (projected `undefined`s compacted). `opencode-adapter-factory.ts`
  names the model in the native probe whenever the ceiling applies — previously only the MiMo generation budget got the
  model, so `projectOpenCodeConfig` never resolved model limits for anyone else — and passes `effectiveConfig` to the
  ceiling in `prepareSpawn`. `opencode-v2-config-writer.ts` merges per-model `limit` fields field-wise (the same shape
  `mergeProvider` already uses), so a partial overlay limit can never delete `output` through the serializer.
  Tests ("both paths", as required): `context-ceiling.spec.ts` gains the native-effective cases (native 120,000 + ceiling
  250,000 → stays 120,000 with `output` retained; ceiling 100,000 → clamps down; a wider overlay never widens the native
  window) and the 2.x `providers` cases run through the real `serializeOpenCodeConfigForV2` (no-raise no-op keeps
  `{context: 120_000, output: 4096}`; clamping keeps `output`); `opencode-budget-spawn.spec.ts` drives the compiled factory
  with a mocked native 120,000-token model and pins that both probes name the model and the emitted `limit.context` is
  120,000 (or the lower ceiling), never 250,000; `opencode-v2-config.spec.ts` pins the field-wise limit merge. Red first:
  reverting only the resolution (ignore `effectiveConfig` and the 2.x shape) fails exactly the four new cases — the two new
  `context-ceiling` cases and the two factory cases (`_scratch/test-run.pid-51070.log`). Green after: `context-ceiling` +
  `opencode-v2-config` + `opencode-budget-spawn` 56 tests (`_scratch/test-run.pid-51993.log`), plus the full OpenCode adapter
  set —
  `adapter-factory-opencode`, `opencode-generation-budget`, `opencode-effective-budget-config`, `opencode-account-spawn`,
  `opencode-account-startup`, `opencode-required-major`, `opencode-account-provider-config` — 268 tests
  (`_scratch/test-run.pid-60111.log`) and `opencode-cli-launch` 27 tests (`_scratch/test-run.pid-52628.log`, the other
  `serializeOpenCodeConfigForV2` caller).
- **Finding 3 (a partial tally-file write destroyed all previously saved self-wakeup counts) — fixed (A#185 hardening).**
  `self-wakeup-tally-store.ts`'s `save` wrote the sole JSON file in place and swallowed the error, so a truncated write
  followed by ENOSPC replaced valid history with a file that `load` (fail-soft on malformed JSON) read as `{}`. `save` now
  writes a pid-suffixed temporary file and renames it over the tally (atomic replacement), cleaning the temp up on failure,
  so the last valid tally survives any failed or partial save; the fail-soft contract is unchanged. New
  `src/main/instance/self-wakeup-tally-store.spec.ts` (3 tests: round-trip; the verifier's exact fault — a partial write
  then ENOSPC — leaves `{'2026-10-20': 8, '2026-10-21': 3}` intact with no temp file left behind; a failed rename also
  preserves history and the next save recovers). The fs mock is a partial mock whose `default` is the merged mock itself,
  because transitive importers resolve named bindings through `default` — without that the spies never reach the store
  (recorded so the next person does not re-debug it). Red first: against the old write-in-place `save` exactly the two
  fault-injection tests fail (red run `_scratch/test-run.pid-23974.log`: 2 of 3 failed); green after: 3 tests + the existing 9
  tracker tests
  (`_scratch/test-run.pid-22020.log`, `_scratch/test-run.pid-27082.log`).
- **Finding 4 (the linked dependency installation did not match this worktree's manifests) — resolved as a
  verification-environment fix; no code change.** The worktree's `node_modules` was the per-entry link farm into the root
  checkout's install (`.worktreeinclude`), and the root checkout carries **uncommitted** engines-only edits to `package.json`
  and `package-lock.json` (`engines.node` bump), so the dependency-compatibility check's fail-closed manifest-drift rule
  correctly refused the linked tree. This is not a dependency change in this diff (the branch's manifests are byte-identical
  to committed `main`). Remediation, matching the phase4 round-1 precedent: a real install from **this branch's** lockfile —
  `npm ci --ignore-scripts --no-audit --no-fund` (1,434 packages, exit 0,
  `_scratch/queue-4a5986-round2/npm-ci.log`), `npm rebuild esbuild electron better-sqlite3 node-pty @parcel/watcher lmdb
  msgpackr-extract electron-winstaller` (exit 0), `npm run rebuild:native` (exit 0),
  `node scripts/verify-native-abi.js` (exit 0: better-sqlite3 `NODE_MODULE_VERSION 146` matches Electron 42.11.15).
  `scripts/__tests__/dependency-compatibility.spec.ts` then passes 5 of 5 (`_scratch/test-run.pid-59224.log`). The root
  checkout and its dirty manifests were **not** modified. The local install is deliberately kept in the worktree for the
  verifier's full-suite acceptance — swapping the linked install back would reintroduce the failure; the instruction to
  delete created dependency installs covers throwaway/scratch installs, and this install is the remediation itself (the same
  disposition the completed phase4 plan recorded: "Preserve this local install for re-verification").

**Round-2 verification (this worktree, real lockfile install):** all targeted batches above are green (findings 1–4:
155+1 cost tests, 56+268+27 OpenCode tests, 3+9 tally tests, 5 dependency tests, plus the wider cost suites listed under
finding 1). Fast gates all exit 0 with logs in `_scratch/queue-4a5986-round2/`: `npx tsc --noEmit` (`tsc.log`),
`npm run typecheck:spec` (`typecheck-spec.log`), `npm run lint` (`lint.log`), `npm run check:ts-max-loc` (`loc.log`),
`npm run check:ui-hints` (`ui-hints.log` — exact round-1 counts: H1a 24, H1b 91, H2a 210, H2b 138, H2c 32, H3 20, H4 135,
H5 12, H11 8, 10 markers, 202 wording entries), `npm run build:main` (`build-main.log`) and `npm run build:renderer`
(`build-renderer.log`). The renderer's usual initial-bundle warning is unchanged in kind (1.47 MB against the 1.00 MB
budget, 471.89 kB over) and `check:ts-max-loc`'s `settings.types.ts` note is the pre-existing ratchet tolerance, not this
diff. Per the queue rules this worker did not run the full suite — it stays with the verifier, who should now find the four
previously failing tests green (in their updated, intended form) and the dependency check green. No browser, desktop app,
provider login or
external service was used; no live check is deferred (all four findings are covered in-loop by tests). Report, source seal
and command receipts: `_scratch/queue-4a5986-round2/{report.md,seal.json,receipts.json}`. Build output created by the gate
runs is removed after evidence retention; the dependency install and test caches remain for the verifier.

### Round-3 verifier findings remediation (23 Oct 2026)

**Scope and starting state:** the independent verifier's round 2 returned one finding (high, confidence 100) against the
round-2 checkpoint — the A#61 OpenCode context ceiling itself. Fixed in this worktree
(`queue/2026-10-13-oct-parked-followup-4a5986`); no commit, branch, rename or external action was taken, and this root plan
keeps its active filename. Red-first where behavioural (below). There is no linked spec.

- **Finding (enabling a context ceiling prevents OpenCode sessions from starting when the selected built-in model has no
  explicit limit override) — fixed.** Root cause, matching the verifier's native repro and extended here: the probe used by
  `opencode-adapter-factory.ts` returns **configuration overrides**, not the built-in model registry, so for a normal
  built-in model (`openai/gpt-4o`) `projectOpenCodeConfig` projects `limit: {context: undefined, output: undefined}` even
  though `models openai --verbose` reports context 128000 and output 16384. `applyOpenCodeContextCeiling` then treated "no
  recorded limit" as "give the model the ceiling as its window" and emitted `limit: {context: <ceiling>}` **without
  `output`**. OpenCode's configuration schema requires both `limit.context` and `limit.output` whenever a `limit` exists
  (verified again this round on OpenCode 1.19.4: `limit.context` alone and `limit.output` alone both exit 1 with
  "Missing key …"; both keys exit 0), so the prepared `OPENCODE_CONFIG_CONTENT` was schema-invalid. That broke the spawn
  twice over: the factory's **first** application point writes the same partial limit into `env` before
  `selectOpenCodeLaunch`, whose readability probe (`debug config` must exit 0 and print JSON) then reports every install
  unusable ("could not read its settings in this folder"), and the factory's **verification** probe
  (`readOpenCodeEffectiveBudgetConfig`) rejects the prepared content with its safe-probe error before ACP startup. Fixes:
  (1) new `src/main/cli/adapters/opencode-native-model-limits.ts` resolves the model's real limits from the native model
  catalog — v1 `models <provider> --verbose`, v2 `api --standalone GET /api/model`, the same source of truth
  `opencode-region-model-metadata` documents — through the existing parsers (`parseOpenCodeModelMetadataBlocks` /
  `parseOpenCodeV2ModelMetadata`), sanitised to positive numbers only (the catalog reports `limit: {context: 0, output: 0}`
  for some models, which `openCodePositive` would reject), fail-soft and cached per install on success only, gate-free
  because `prepareSpawn` holds the OpenCode startup gate. (2) `applyOpenCodeContextCeiling` takes those `nativeLimits` as
  the lowest-precedence window/output source (the narrowest-known-window clamp is unchanged: catalog, probe-effective
  config and both overlay shapes, never up) and now **only emits a `limit` when both `context` and `output` resolve to
  positive numbers**, retaining every other limit field; when it cannot, it leaves the config untouched and reports
  `skipped` (the return type is now `'unchanged' | 'applied' | 'skipped'`; the boolean contract is retired). (3) The
  factory reads the catalog in `prepareSpawn` whenever the ceiling applies and names the model, passes the limits to the
  ceiling, and warns once when the ceiling is genuinely unexpressable; the early best-effort application point stays but
  can now only emit complete limits (it has no catalog). Contract correction to the round-1 A#61 note ("a model with no
  recorded limit anywhere gets the ceiling as its working window"): such a model now gets `min(catalog window, ceiling)`
  when the catalog resolves, and gets **no override** (native defaults, ceiling unapplied, warn) when even the output cap
  cannot be resolved — a partial `limit` is never emitted, because it refuses the whole session.
  Tests: `context-ceiling.spec.ts` gains the verifier's exact path (base `{model: 'openai/gpt-4o'}` with an empty override
  projection, catalog `{context: 128000, output: 16384}`: ceiling 100000 → `{context: 100000, output: 16384}`; ceiling
  250000 → `{context: 128000, output: 16384}`; a wider overlay never widens the catalog window and its output cap is kept)
  and the validity gate (`skipped`, config untouched, when no output cap resolves anywhere — no catalog, catalog without
  output, or a projection carrying `output: undefined`); the older cases re-pin the new outcome strings.
  `opencode-budget-spawn.spec.ts` drives the compiled factory with the real `projectOpenCodeConfig` empty-override
  projection plus a mocked catalog reader — the normal built-in-model path the round-2 tests missed because they mocked
  the probe with limits already present — and pins both the complete emitted `limit` (both keys, clamp never above the
  catalog window) and the fail-soft path (no `limit` at all, spawn still prepares) when the catalog is unresolved. New
  `opencode-native-model-limits.spec.ts` (7 tests) covers the extraction (positive/zero/absent/slash-in-id), the v1 and v2
  reads, caching and the fail-soft retry. Red first: against the pre-fix ceiling and factory the two new ceiling tests,
  the four rewritten outcome cases and the three new factory cases fail — 9 of 26
  (`_scratch/queue-4a5986-round3/red-run.log`); green after: 33 tests in the three files (`green-run.log`). Native
  evidence against the real OpenCode 1.19.4 CLI, mirroring the verifier's repro with the fixed compiled modules
  (`_scratch/queue-4a5986-round3/repro-opencode-ceiling-fixed.cjs`, output `opencode-ceiling-fixed-native.json`): the
  catalog read reports `{context: 128000, output: 16384}` while the projected override limit is empty; the fixed path
  emits `{context: 100000, output: 16384}` (ceiling 100000) and `{context: 128000, output: 16384}` (ceiling 250000) and
  native `debug config` exits **0** at both; without catalog limits the ceiling leaves the config untouched and
  `debug config` also exits 0 (the session starts, degraded without the ceiling); and the pre-fix partial `limit` is
  reproduced as a red control with exit 1 `Missing key provider.openai.models.gpt-4o.limit.output`. The verifier's own
  `repro-opencode-ceiling.py` now records `afterExit: 0` at both ceilings (`verifier-repro-after.json`).

**Round-3 verification (this worktree):** targeted tests green — `context-ceiling` + `opencode-native-model-limits` +
`opencode-budget-spawn` (33), the full OpenCode adapter set (`adapter-factory-opencode`, `opencode-generation-budget`,
`opencode-v2-config`, `opencode-effective-budget-config`, `opencode-account-provider-config`, `opencode-account-spawn`,
`opencode-account-startup`, `opencode-cli-launch`, `opencode-required-major`, `opencode-permission-policy`,
`opencode-startup-preflight`, `adapter-factory-account-route` — 330), `opencode-region-model-metadata` +
`opencode-cli-discovery-service` + `acp-cli-adapter.opencode-v2` (62) and the factory-adjacent set (`provider-parity`,
`opencode-cli-provider`, `opencode-child-progress-source`, `opencode-content-filter-recovery`, `opencode-process-gate`,
`adapter-factory-resolve` — 104). Fast gates all exit 0 with logs in `_scratch/queue-4a5986-round3/`:
`npm run typecheck:spec`, `npm run lint`, `npx tsc --noEmit`, `npm run check:ts-max-loc`, `npm run check:ui-hints`
(exact round-1/2 counts), `npm run build:main` and `npm run build:renderer` (the usual initial-bundle warning,
1.47 MB against the 1.00 MB budget, 471.89 kB over). Committed generator made current:
`npm run generate:architecture` updated `docs/generated/architecture-inventory.json` for the new module. Per the queue
rules this worker did not run the full suite — it stays with the verifier, who should find the A#61 ceiling working on the
normal built-in-model path (both `limit` keys, clamped to the real window) and the session start unblocked either way. No
browser, desktop app, provider login or external service was used; the native checks ran against a throwaway XDG sandbox
(removed afterwards) with an obvious placeholder key value, and no live check is deferred (the finding is covered in-loop
by unit tests plus the native evidence above). Report, source seal and command receipts:
`_scratch/queue-4a5986-round3/{report.md,seal.json,receipts.json}`.

### Round-4 verifier findings remediation (23 Oct 2026)

**Scope and starting state:** the independent verifier's round 3 returned one finding (high) against the round-3
checkpoint — the A#61 catalog reader caching session-overlaid limits as native defaults. Fixed in this worktree
(`queue/2026-10-13-oct-parked-followup-4a5986`); no commit, branch, rename or external action was taken, and this root
plan keeps its active filename. Red-first where behavioural (below). There is no linked spec. Per the recorded readiness
decision ("verify fixes already present and reconcile the inventory; preserve unmet triggers and permission boundaries"),
the four previously implemented items were re-verified this round and the parked inventory was re-checked (see
"Inventory re-check" below).

- **Finding (one session's context ceiling leaked into later sessions as the model's native window) — fixed.** Root
  cause, matching the verifier and reproduced natively here on OpenCode 1.19.4: `models <provider> --verbose` merges
  `OPENCODE_CONFIG_CONTENT` model `limit` overrides into the listing (sandbox proof: the same built-in
  `openai/gpt-4o` reports registry `{context: 128000, output: 16384}` with a limit-free overlay and
  `{context: 250000, output: 16384}` when the overlay carries `limit.context: 250000` — `_scratch/queue-4a5986-round4/`
  `no-limit.txt` / `overlay.txt`). The factory writes its early best-effort ceiling into `OPENCODE_CONFIG_CONTENT`
  before `prepareSpawn`, so `readOpenCodeNativeModelLimits` queried through that mutation and cached the result —
  keyed only by major/command/model. Two leaks followed: within a session, the early pass writes
  `limit.context = <ceiling>` when the overlay knows only `limit.output`, the read then reports the ceiling as the
  native window, and the clamp's "narrowest known window" can no longer see the real one (a 250,000 ceiling raised a
  128,000-token built-in window to 250,000 — the never-widen contract broken); and across sessions, the cached entry
  outlived the session and served the first session's window to every later spawn on the same install and model. Fix:
  `configContentWithoutModelLimits` (new, pure) rewrites the read overlay without any model-level `limit` in either
  config shape (`provider` and `providers`), keeping providers and models present — the CLI refuses to list a provider
  that is not enabled, and a limit-free model entry still reports the registry's window (sandbox proof: `prov-empty` /
  `model-empty` runs report `{context: 128000, output: 16384}`) — and `readOpenCodeNativeModelLimits` now runs every
  catalog read through that rewrite. The cache key is now `major|command|workingDirectory|model|digest(stripped
  overlay)`: ceilings are stripped before the digest, so overlays differing only in `limit` **share** one catalog read
  (and one answer), while a different folder (on-disk project config) or provider set is a different answer. Contract
  kept: the clamp still only moves a window down (the never-widen tests from rounds 2–3 are untouched and green).
  Recorded choice: option (a) of the finding's two ("read native limits without the session overlay") in its precise
  form — strip the `limit` overrides rather than delete `OPENCODE_CONFIG_CONTENT` outright — because a strict
  overlay-free read cannot list providers the overlay alone enables (sandbox proof: `models openai --verbose` exits 1
  "Provider not found: openai" with no overlay at all on a config-less machine; account providers are only ever
  enabled through the overlay), which would silently drop the round-3 built-in-model fix on exactly those machines.
  The finding's "key/evict the cache per overlay" alternative is covered as well by the digest key. No factory code
  changed: the reader owns the "native" invariant at one place.
  Tests ("factory specs that use the real catalog reader", as required): new
  `src/main/cli/adapters/opencode-budget-spawn-native-catalog.spec.ts` drives the compiled factory through the **real**
  `readOpenCodeNativeModelLimits` (only the CLI boundary faked: `runOpenCodeCapture` simulates the proven 1.19.4
  listing merge — overlay `limit` fields win over the registry — so a reader that asks through the overlay still sees
  the ceiling where the real CLI would report it). It pins: never-widen on both CLI majors (the early pass writes
  `limit.context: 250000` over an overlay that knows only `output`; the emitted `limit` must be
  `{context: 128000, output: 16384}` on OpenCode 1 `models --verbose` and OpenCode 2 `GET /api/model`), one session's
  ceiling staying out of a later session's native window, and the clamp-down case (ceiling 100,000 → 100,000).
  `opencode-native-model-limits.spec.ts` gains the pure rewrite cases (both shapes, malformed content returned
  unchanged), the read-env case (the capture must see the overlay with `limit` stripped but providers/models present)
  and the cache-key case (limit-only overlay differences share a read; a different folder or provider set does not).
  Red first: against the pre-fix reader and factory the two never-widen cases, the cross-session case, the read-env
  case and the cache-key case fail — 5 of 14 (`_scratch/queue-4a5986-round4/red-run.log`); green after: 14 tests in the
  two files. The pre-existing `opencode-budget-spawn.spec.ts` keeps its `nativeLimits` mock (its cases pin the factory's
  wiring contract, not the reader) and is green unchanged.

**Round-4 verification (this worktree):** targeted tests green — `context-ceiling` + `opencode-native-model-limits` +
`opencode-budget-spawn` + `opencode-budget-spawn-native-catalog` + `opencode-v2-config` + `opencode-generation-budget` +
`opencode-effective-budget-config` + `opencode-account-provider-config` (154), the wider OpenCode set
(`adapter-factory-opencode`, `opencode-account-spawn`, `opencode-account-startup`, `opencode-cli-launch`,
`opencode-required-major`, `opencode-permission-policy`, `opencode-startup-preflight`, `adapter-factory-account-route`,
`opencode-region-model-metadata`, `opencode-cli-discovery-service`, `acp-cli-adapter.opencode-v2`,
`opencode-cli-provider`, `opencode-child-progress-source`, `opencode-content-filter-recovery`, `opencode-process-gate`,
`adapter-factory-resolve` — 301). Previously implemented items re-verified in the same worktree: the A#158/A#185 cost
set (`communication-completion-cost`, `self-wakeup-tracker`, `self-wakeup-tally-store`, `cost-attribution`,
`cost-tracker`, `rlm-migrations-076-080`, `cost-entries-a0-repair`, `instance-communication`,
`instance-communication.partial-usage` — 239) plus `cli-worker-resident-cost` + `claude-direct-failed-usage` (after
`build:main` supplied the worker fixtures, as in round 1) and the A#39 phone wording (`status.spec.ts` 9/9, every
desktop phrase pinned). Fast gates all exit 0 with logs in `_scratch/queue-4a5986-round4/`: `npx tsc --noEmit`,
`npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints` (exact round-1/2/3
counts), `npm run build:main` (one real TypeScript error in the first draft of the rewrite was found and fixed by this
gate) and `npm run build:renderer` (the usual initial-bundle warning, 1.47 MB against the 1.00 MB budget, 471.89 kB
over). Committed generator made current: `npm run generate:architecture` leaves
`docs/generated/architecture-inventory.json` unchanged (no new production module). The worktree's `node_modules` was
again a real install against this branch's lockfile (round-2's remediation state survived), and
`apps/mobile/node_modules` was installed fresh for the A#39 re-verification (442 packages; kept in the worktree with
the same disposition as round 1/2's installs, since the verifier's mobile acceptance needs it).
Mobile-suite note (extends round 1's flake record): `apps/mobile`'s full suite reports 513–514 of 515 in five
back-to-back runs on this machine (load averages 25–55 during the runs; runs 4–5 at `maxForks=2`/`1`); the only
failures are declared-timeout misses in two files this change never touches — `history.behavior.spec.ts`'s "windows a
long archived transcript…" (5 s limit; the exact case round 1 recorded; it passed in runs 3–5) and
`transcript-view.component.spec.ts`'s "parses each of 1000 messages once…" (its own 60 s limit; 55–80 s wall under
load). The three-file isolation retry (with `status.spec.ts`) is 34/34 green with the transcript-view file at 113 s
(its heavy test just under the limit); two later single-file attempts of that file missed the 60 s limit (8/9 each).
These are load-sensitive timing flakes, not regressions; `status.spec.ts` (the A#39 fix) is green in every run. Mobile
`typecheck` and `lint` exit 0.
Per the queue rules this worker did not run the root full suite — it stays with the verifier. No browser, desktop app,
provider login or external service was used; the native checks ran against a throwaway XDG sandbox (removed after
evidence retention) and no live check is deferred (the finding is covered in-loop by unit tests plus the native
evidence above). Report, source seal and command receipts:
`_scratch/queue-4a5986-round4/{report.md,seal.json,receipts.json}`.

**Inventory re-check (23 Oct, round 4):** the 76-row inventory and the five Step 8 parts are **unchanged** from the
23 Oct reconciliation — re-checked this round against the code and nothing's trigger fired since: `NeedsYouStore` and
`needs-you-summary.ts` (Phase 3's needs-you work) are still absent from `src`, `claudeLivePermissionPrompts` is still
absent (8b's "step 16's default is on" stays unmet), `interfaceMode`, `contextManagementTools` and
`scripts/ui-text/extract-ui-text.ts` are still absent (8c/8d/8e premises stand), and `freshReviewerEachRound` is still
read nowhere in `src/main` (A#141's scope correction stands). One wording correction to round 1's marker list:
`src/renderer/app/features/instance-list/project-group-computation.service.ts` does exist in this base (it predates
this queue work; Phase 3's plan *extends* it with `NeedsYouStore` and `needsYouCount`, per its step-2 text) — the
Phase 3 markers that are genuinely absent are `NeedsYouStore` and `needs-you-summary.ts`, and the parked conclusions
are unchanged by the correction. The remote-worker group's build (items 1–7 of the design pass) remains a later
round's work — now carried in the successor doc named under **Carry-over for the rename** (see **Round-5** below); the
carry-over-for-the-rename note above stands as written.

### Round-5 verifier findings remediation (24 Oct 2026)

**Scope and starting state:** the independent verification round of 24 October returned three findings (1 high, 1 medium,
1 low) against the round-4 checkpoint — one verification-environment blocker, one missing successor document and one
inventory-tally error. All three are fixed (the environment one in the worktree, the documentation ones in this root
document and the new successor doc); no commit, branch, rename or external action was taken, and this plan keeps its
active filename. No production code changed this round (an environment repair plus documentation), so no red-first run
applies — the environment fix is verified by the previously failing check turning green. There is no linked spec.

- **Finding 1 (the required full-suite gate fails because dependency validation rejects two extraneous installed
  packages) — fixed as a verification-environment repair; no code change.** `scripts/__tests__/dependency-compatibility.spec.ts`'s
  "keeps the installed production tree valid" assertion (`:202`) rejected `extraneous: toml-eslint-parser@1.0.3` and its
  nested `extraneous: eslint-visitor-keys@5.0.1` — both on disk in the worktree's `node_modules`, both absent from this
  branch's `package-lock.json`. Reproduced here first: `npm ls --omit=dev --all --json` reported exactly those two
  extraneous problems (plus `invalid: @types/node`, which the check's classifier already treats as benign). Provenance:
  the **root checkout** carries **uncommitted, unrelated** edits adding `toml-eslint-parser` to its own `package.json` and
  `package-lock.json` (someone's live work — preserved untouched); the worktree's real install picked the package up
  outside its lockfile (the two directories are timestamped 23 Oct 17:42–17:43 — after the install's hidden lockfile was
  last written at 16:55, and beside a `.worktreeinclude` sync — so they were added to the tree after the lock-exact
  install, not by it). The branch's manifests are byte-identical to
  committed `main`, so this is not a dependency change in this diff. Remediation: `npm prune --ignore-scripts --no-audit
  --no-fund` in the worktree — npm removed exactly those 2 packages ("removed 2 packages in 3s", exit 0), leaving the
  installed tree exactly on this branch's lockfile. Evidence: `npm ls --omit=dev --all --json` now reports **0 problems**
  and the previously failing check passes **5 of 5** (`_scratch/queue-4a5986-round5/dep-compat.log`). Disposition: the
  worktree's `node_modules` (real install on this branch's lockfile) and `apps/mobile/node_modules` stay in the worktree
  on the established rounds-1–4 disposition — the verifier's full-suite run needs them, and the tree is now lockfile-exact;
  if another session's install ever re-pollutes it, the same `npm prune` restores the check.
- **Finding 2 (the required active successor document for unfinished follow-ups was not created) — fixed.** Created
  [2026-10-24-oct-remaining-followups_plan.md](2026-10-24-oct-remaining-followups_plan.md) (root checkout, active
  `*_plan.md`, uncommitted while its work is open, per the queue's planning-document rule) and linked it from this
  document's status line and **Carry-over for the rename** section. It preserves, verbatim and with triggers intact: the
  still-wanted remaining-list rows (**71 parked** plus the remote-worker group's one grouped row = 72 of the 76), the
  remote-worker group's written design pass and its **build items 1–7** (the "later round's work" this plan left
  outstanding), all five **Step 8 parts** (8a–8e; 8d item 1 recorded as closed no-op, so only its items 2–9 are open),
  the five-parts boundaries table and the premise-re-check notes; it also records the corrected tally and what is
  deliberately not carried (the four implemented rows). The source rule (October follow-ups, Finishing item 2: "carry
  every still-wanted line … into a new dated follow-up doc, because nothing may be added to a `_completed` file") is
  therefore satisfied **before** the coordinator's rename, which `src/main/plan-queue/plan-queue-doc-close.ts:110-118`
  cannot do automatically (it only copies plan/spec to their completed filenames).
- **Finding 3 (the reconciliation tally understates the parked inventory by six entries) — fixed.** The remaining list
  has exactly 76 bullet rows; four are implemented (A#39, A#61, A#158, A#185) and the seven remote-worker features occupy
  **one grouped row**, leaving **71 parked** rows. The old tally counted that grouped row as seven and reported 65.
  Corrected at the inventory tally above ("1 grouped row covered by one design pass … 71 parked") and at the carry-over
  note (which now names the 71 parked rows plus the remote-worker group's build and the tabled Step 8 parts), and the
  successor carries the corrected numbers.

**Round-5 verification (this worktree):** the failing dependency check is green (**5 of 5**) and
`npm ls --omit=dev --all` is clean (0 problems); the successor's carried list was counted after assembly — **72 open
rows** (the 76 rows minus the 4 implemented ones; A#39's now-empty "The phone app's words" group heading dropped with
its row), zero implemented rows left in the carried list, and every deletion seam checked (A#61 between A#57/58/60 and
A#62; A#158 between A#156 and the dead-code row; A#39 with its now-empty group heading between A#176 and Housekeeping;
A#185 between A#184 and A#191). Fast gates re-run:
`npx tsc --noEmit`, `npm run typecheck:spec` and `npm run lint` — all exit 0 (logs in
`_scratch/queue-4a5986-round5/`). No source file changed this round, so no committed generator needed re-running and the
earlier rounds' test evidence for the four implemented items stands unchanged. Per the queue rules this worker did not
run the full suite — it stays with the verifier, who should now find `dependency-compatibility` green and an active
successor present and linked. No browser, desktop app, provider login or external service was used; no live check is
deferred. Report, source seal and command receipts:
`_scratch/queue-4a5986-round5/{report.md,seal.json,receipts.json}`.

> Plan Queue parked work: `queue/2026-10-13-oct-parked-followup-4a5986` — 3 commit(s), reason: round-limit.
