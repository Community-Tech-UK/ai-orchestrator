# Session-linked sidechats — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-02-session-sidechats_plan_completed.md](2026-10-02-session-sidechats_plan_completed.md)

**Prerequisites:**

- Rebuild and restart Harness from the branch carrying this work
  (`npm run build:main && npm run build:renderer`, then restart). The sidechat service, its IPC
  channels, the `latest_assistant_sequence` column upgrade and the new panel only load after that
  restart. Do not restart Harness while James has live sessions (build first, let James restart).
- Every check below needs **real provider turns** (paid model calls on James's accounts) or the
  **`windows-pc` worker**, which is why they could not run in-loop. Everything verifiable without
  them is already covered: main-process behaviour by `src/main/chats/side-chat-service.spec.ts`,
  `side-chat-runtime.spec.ts` (provider matrix) and siblings; renderer by
  `side-chat-panel.component.spec.ts`, `side-chat.store.spec.ts`, rail and session-row specs; and
  a no-model dev-app run on 2026-10-06 (see the plan's as-built notes).
- Use a disposable working directory (for example `/tmp/sidechat-live`) for any session that might
  edit files.

## Checks

### LT-SC-1 — Screenshot scenario with a real answer

1. Start a Codex session in `/tmp/sidechat-live` with a task such as "Write a three-step plan in
   PLAN.md, then implement step 1". Let it finish at least one step.
2. Open the sidechat panel (⌥⌘S). Confirm the header reads "Sidechats · <session name>".
3. Leave Claude selected in the picker and ask "How far through this are you? What's left to do?"

**Expected:** Claude's answer names the task from step 1 and the progress actually made, without
the Codex session receiving any message or interruption (its transcript is unchanged).

### LT-SC-2 — Hidden answer, badge, and exact reopen

1. Ask a sidechat a question that takes a while (for example "Write a 600-word summary of this
   session's work").
2. Close the panel immediately and select a different session.

**Expected:** while it runs, the rail sidechat button shows the pulsing dot and the parent's session
row shows a running badge. When it finishes, both show an unread count of 1. Clicking the session
row badge (or the rail's right-click list entry naming the session) opens that session with the
panel on that exact conversation, and the answer is present. The count clears only after scrolling
to the end of the answer with the window focused; while scrolled up, a "New answer ↓" button shows.

### LT-SC-3 — Unread survives an app restart

1. Repeat LT-SC-2 but do not open the answer.
2. Quit and restart Harness.

**Expected:** the unread badge is still shown on the session row and rail. No sidechat question is
re-sent on start-up (the provider receives nothing new).

### LT-SC-4 — Permission request answered in the panel

1. Start a Claude session with YOLO off in `/tmp/sidechat-live`.
2. In its sidechat (Claude), ask "Create a file called hello.txt containing hi".

**Expected:** the session row badge and rail show "needs action". The panel shows the permission
prompt for the sidechat's own runtime; approving it there creates the file. The parent session is
not asked anything.

### LT-SC-5 — Restricted parent stays restricted

1. Start a session using the built-in **Plan** agent (writes blocked).
2. Open its sidechat panel and expand "Permissions: same as parent".

**Expected:** the inspector lists "Editing files: blocked"; the picker offers only Claude and Local
Models, and the "Not available for this session" list explains why Codex, Copilot and the others are
missing. Asking the Claude sidechat to edit a file is refused by the tool layer (the model reports
the edit tool is unavailable), and no file changes.

### LT-SC-6 — Busy provider switch is blocked; idle switch keeps history

1. Ask a sidechat a long question; while it is answering, open the provider picker.
2. After it finishes, switch it from Claude to Codex and ask "What did you tell me last time?"

**Expected:** during the answer the picker is disabled with "Stop the current answer before changing
provider or model". After switching, Codex answers using the earlier Claude reply (history rebuilt),
and the sidechat stays under the same parent.

### LT-SC-7 — Remote workspace routing

1. Start a session on the `windows-pc` worker (Browser Gateway / worker preflight first, per
   AGENTS.md routing rules).
2. Open its sidechat panel and ask a Claude sidechat "Which directory are you in?"

**Expected:** the sidechat runs on `windows-pc` in the parent's Windows path. With the worker
offline, sending shows an explicit "Forced worker node … is unavailable" error rather than running
locally.

### LT-SC-8 — Parent permission change between turns

1. Start a Claude session with YOLO on; ask its Claude sidechat one question.
2. Turn YOLO off on the parent session, then ask the sidechat to create a file.

**Expected:** the second question runs in a fresh sidechat runtime that asks for permission before
writing (the policy change took effect before dispatch).
