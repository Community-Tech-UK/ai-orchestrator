# October Phase 5: live validation of the implemented subset

**Status:** pending. Created 12 October 2026. No live check below has been claimed as verified.

**Implementation plan:** [2026-10-10-oct-phase5-later_plan.md](2026-10-10-oct-phase5-later_plan.md).

**Prerequisites:** coordinator integration of the queue worktree, rebuilt main/preload/renderer and bundled `aio-mcp`, then restart the validation app. Use a disposable validation profile and disposable provider sessions; use the rebuilt Windows instance for screen checks. Restore every changed setting afterwards. Provider checks require the relevant installed/authenticated CLI; use documented credential discovery and secure credential-fill routes if authentication is needed. No secret values belong in evidence.

**Routing:** preflight the AIO Browser Gateway and explicitly target `windows-pc`. Do not launch or drive a Mac browser/desktop window. If Windows preflight fails, record the result and stop that screen check; James must choose Mac, wait or skip. The final Cmd+Z check is Mac-only and remains pending until James explicitly authorises Mac use for that check. No current Mac authorisation exists.

**Remediation flow:** read [the campaign runbook](livetest-campaign-runbook.md) before execution. A reproduced product defect requires a new `LT-NNN` index row and full section in [the remediation register](livetest-remediation-register.md), with a matching implementation-status section in `2026-07-19-livetest-failure-remediation-followup_plan.md` (use the actual current lifecycle filename). Keep dated per-check evidence here. Current browser routing and `npm run typecheck:spec` instructions override older fallback/bare-tsc guidance in that runbook.

**Why these checks remain:** this worker changed and compiled an isolated Mac queue checkout. The existing Windows app has not received this worktree's compiled main/preload/renderer. Browser health preflight was successful, but is not evidence of the changed UI or provider tool behaviour. Agent-runnable logic and component/DOM assertions were exercised in focused tests; this document covers the specified rebuilt-app/provider/real-keyboard observations only. It does not defer missing implementation.

**Implementation still open outside this document:** Step 16's status-strip registry/overflow cannot be built until
Phase 3's C2b status strip exists (Phase 5 forbids a second strip; the two rules are handed to the C2b implementer in
that plan's step 5). Its acceptance remains in the active implementation plan. Step 10's snooze-state relocation into
Phase 3's root needs-you store is Phase 3 step 6c's own work, already specified there; Phase 5's step 10 acceptance is
otherwise complete. The compact-preview tip is deliberately inactive until its Phase 0 control exists. No livetest can
substitute for those code changes. Step 1b (the Compact-now recovery pointer) is now implemented and its live check is
below.

For each numbered check, record the app build/revision, instance/provider, settings before/after, actions, observed result and redacted evidence path. A failed expectation stays unchecked. Do not rename this document `_livetest_completed.md` until every applicable check passes.

## 1a. The `read_session` tool (M)

- [ ] Live check 1.

**Live checks:**
- Rebuilt app, with "Cross-session messaging" switched on: in a Claude session and a Codex session in the same folder as
  a third session, ask "what did the session called <its exact title> decide about X?" and confirm each finds
  `read_session` through tool search and reads by title, without a paste. Switch it off and repeat: the reply is refused
  and names the switch. Afterwards read the audit rows (a read-only query, `?mode=ro`) and confirm one per call.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## 1b. After "Compact now", the recovery pointer (XS)

- [ ] Live check 1b.

**Live checks:**
- Rebuilt app: run "Compact now" on a real **Copilot** session (not Gemini, which has no tool), then ask for an exact
  detail that the summary dropped, for example an error string from early on. Confirm the agent calls `read_session`
  with `{"session": "self", "from": "before-last-compaction"}` and quotes the dropped detail. Also confirm a Gemini or
  Antigravity session's Compact-now package carries no `<context_recovery>` block and no look-up sentence.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## 1c. The `@session` chip (S-M; renderer only, after 1a)

- [ ] Live check 2.

**Live checks:**
- Rebuilt app: type `@session:` in the composer, pick a session from another project, send, and confirm the agent can
  now read it.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 3. C13.4: Hide the two scaffolding pages (XS)

- [ ] Live check 3.

**Live checks:**
- A quick look at the menu on the Windows PC.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 4. C13.1: Honest search wording, then one "Find session" finder (XS for wording; S-M for the finder)

- [ ] Live check 4.

**Live checks (Windows PC):**
- Press Ctrl+O, type a word from an old thread's first message, press Enter, and confirm it opens. Click the rail Search
  button and confirm the same finder appears.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 5. C13.9: A placeholder when the model thinks quietly (S)

- [ ] Live check 5.

**Live checks (Windows PC):**
- Ask Claude 5 a question that needs long thought and no tools; confirm the wording switches after about ten seconds
  even while status updates keep arriving, and check the hover.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 6. C13.8: Tool-server cost hint in the MCP settings (S)

- [ ] Live check 6.

**Live checks (Windows PC):**
- Open Settings, MCP servers; confirm the chip on two connected servers and the hover text.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 7. C12B: One Harness confirm box for the 23 grey pop-ups (M)

- [ ] Live check 7.

**Live checks (Windows PC; Mac items need James's OK first):**
- Open each of the three batches of boxes once. Confirm Esc cancels, Enter works as designed, Tab stays inside the box,
  and focus returns to the button that opened it. Include the YOLO box and "Reset all settings" (cancel only; do not
  confirm destructive steps).

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 8. C13.2: "Ask other models about this reply" (S)

- [ ] Live check 8.

**Live checks (Windows PC):**
- Right-click a reply, choose the item, confirm the box content, edit it and send to one provider.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 9. C13.7: Claude's task list in chats, as a setting (S)

- [ ] Live check 9.

**Live checks (Windows PC):**
- Turn the setting on; start a Claude 5 chat; ask "Plan three small steps, then do them"; confirm `TodoWrite` calls in the
  transcript and the Progress panel filling.
- In a plan-queue worker session, run `echo $CLAUDE_CODE_ENABLE_TODO_TOOLS` through the session's shell tool and confirm
  it is empty. Then start a loop from a chat that was started with the setting on, and confirm the loop's turns can call
  the task tool (expected).

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 10. C12A: Undo instead of "Are you sure?" for things you can take back (M)

- [ ] Live check 10.

**Live checks (Windows PC; Mac items need James's OK first):**
1. Archive a thread from the row button, press Ctrl+Z with the cursor on the thread list, and confirm it returns in place.
   Repeat from the context menu. Remove a project and Undo.
2. Type in the message box, press Ctrl+Z, and confirm only the typing is undone and no toast appears.
3. Snooze a Workboard card, click "Show", and confirm it returns; snooze again and press Undo within 5 s.
4. Discard a new-session draft that has files and a folder, Undo, and confirm all return.
5. Check Ctrl+Z in the terminal drawer: it must still undo typing there.
6. Mac only (ask James first, as for every Mac check): Cmd+Z with nothing focused reaches the app despite the Edit menu;
   Cmd+Z in the message box still undoes typing.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 11. C13.3: Names and cents; raw values behind "Details" (M)

- [ ] Live check 11.

**Live checks (Windows PC):**
- Open a session with a recent reply, the Local AI page and the Browser page. Confirm names and cents, and that Details
  opens with a working Copy.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 12. C13.5: Child sessions say where you are (S-M)

- [ ] Live check 12.

**Live checks (Windows PC):**
- Start a session that spawns helpers, open the third helper, use Previous and Next, then Parent.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## 13a. One "New session" button (S)

- [ ] Live check 13.

**Live checks (Windows PC):**
- Open the New session menu and start a Quick chat.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## 13b. Show the task list once (S)

- [ ] Live check 14.

**Live checks (Windows PC):**
- Start a task list in a Codex session and confirm it appears once. Make it longer than five tasks and confirm the
  running task is visible and "N more" opens the full list.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## 13c. One hint line under the message box (S)

- [ ] Live check 15.

**Live checks (Windows PC):**
- Trigger busy, compacting and idle states and read the hint line.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 14. C13.10: The memory page in plain words (S-M)

- [ ] Live check 16.

**Live checks (Windows PC):**
- Open the memory page, read every label, hover three controls, remove a note and press Undo.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 15. C13.11: Answer a findings table by ticking rows (M)

- [ ] Live check 17.

**Live checks (Windows PC):**
- Ask an agent for findings as a table with a `#` column; tick two rows; add; confirm the text; send it and check the
  agent understands.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

## Step 17. D11: One quiet tip while you wait (M)

- [ ] Live check 18.

**Live checks (Windows PC):**
1. Start a session on a task that takes more than a minute. At 30 s confirm a single muted tip, and that its shortcut
   matches Settings, Keyboard.
2. Type a letter in the message box: the tip disappears and does not come back during that turn.
3. Open a side chat using its shortcut, then run another long task: the side-chat tip is not shown.
4. Run three long tasks in a row: at most two tips in total, never the same one twice running.
5. Turn the Settings switch off and confirm no tip appears.

**Expected observable result:** every confirmation, wording, state transition and provider action explicitly described above occurs in the rebuilt app. A source file, component unit test or Browser Gateway health result alone does not close this check.

**Flags/settings and deferral:** use the settings stated in this check, retain originals and restore them. The rebuilt app/restarted provider and Windows screen or real-keyboard boundary are prerequisites; no action below has been run against that rebuilt app in this worker.

