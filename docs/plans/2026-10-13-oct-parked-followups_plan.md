# October parked work and remaining follow-ups

**Status:** parked, untracked working document prepared on 13 October 2026. No item below is implemented, dropped, or newly authorized by this document. Each keeps its existing trigger and decision boundary.

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

