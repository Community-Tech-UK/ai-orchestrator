# October Phase 4 part 2: migrating the main screens — live checks

**Status:** pending live validation. No live result is implied by worker unit tests.
**Plan:** [Migrating the main screens](2026-10-10-oct-phase4b-tooltips-migration_plan.md).
**Prerequisites:** coordinator-integrated build containing this queue worktree's changes; rebuild main and renderer (`npm run build:main`, `npm run build:renderer`) and restart the designated Harness application on `windows-pc`. Record the build commit, app instance and date before testing. Use a disposable project folder and test session for the queue/loop checks. Required settings are named in each check.

**Routing:** browser and desktop work run on `windows-pc` through the approved gateway after worker/channel health checks. No local Mac browser or desktop use without James's task-specific permission. If Windows is unavailable, report health evidence and leave these checks pending.

**Remediation flow:** read [the live-test campaign runbook](livetest-campaign-runbook.md) before the campaign. A reproduced defect becomes a new LT-NNN entry in [the remediation register](livetest-remediation-register.md) plus the matching implementation-status section in `2026-07-19-livetest-failure-remediation-followup_plan.md`. Keep per-check evidence here. Rename this document `_livetest_completed.md` only after every applicable check passes.

**Why deferred:** these checks need the rebuilt Electron app, Chromium hover/keyboard behaviour, a real rebind through Settings, a waiting session, a live plan-queue run and visual judgement. Agent-runnable DOM, source-analysis and focus tests are covered by the targeted specs and are not deferred. The queue verifier owns the full suite and the completion verdict.

For each numbered check record PASS/FAIL, the exact action/settings, the observed result and an evidence reference. Hover timing throughout: the first tooltip appears within 200 ms, the next immediately (the skip window). Tab through each area and expect every icon control to open its tooltip on keyboard focus and Escape to close it. Compare each hover against the saved old strings (`_scratch/phase4b-2/old-hover/` in the worktree, and `git show` of the base branch): the same or better text, never a lost warning.

## 1a. The Settings menu when squeezed to icons

1. Collapse the Settings menu. Hover three icons (one with a badge, such as Provider Quota when usage is high): each shows its name (and status) to the RIGHT of the icon.
2. Tab through the same icons: each hint opens on focus; Escape closes it.
3. Expand the menu: no bubbles on any item, including badged ones.
4. Narrow the window to the compact layout and repeat 1–2 (the overlay menu is icon-only there).

## 1b. The left icon bar (also runs part 1's 5c shortcut-chip checks)

1. Hover each of the eight rail buttons: hints appear to the right, with a live key chip where the action has a binding (History, Sidechats, Settings). Windows shows "Ctrl", never "Win".
2. Rebind History to another key in Settings → Keyboard: the chip follows the new binding with no restart.
3. Open the Tools & Views panel and the Side chat panel: their toggles keep their hints while the panel is open.
4. Tab through the rail: every icon control opens its hint on focus; Escape closes it.

## 1c. The top bar of the window

1. Hover each chip in the title bar — startup status, Local AI, CLI update, pause, remote terminal, quota, computer-use, notifications — including chips inside the draggable part of the bar. Each shows Harness's styled hint (or nothing where the hint is an overflow restatement of a fully visible label). If any chip shows a grey native bubble or nothing at all where it used to hint, record it; the bridge from part 1 covers the rest.
2. Hover the "Sending N" chip while queued paused traffic resumes: "Queued paused traffic is resuming" appears (and is reachable by Tab).
3. Hover the startup banner's dismiss ×: "Dismiss" appears.

## 1d. The message box and its queue (also runs part 1's 5d disabled-reason checks)

1. Tab to the message box: screen readers announce "Message".
2. Hover/Tab the wake-up button ("Schedule thread wakeup") and the voice button ("Start voice conversation"/"Stop voice conversation").
3. With the composer unavailable (new-session draft or a starting session), Tab to the voice button: the reason appears ("Start a session before using voice" / "Voice is available after the session starts" / "Voice is unavailable right now") and Enter does nothing. The button stays focusable.
4. The Send button's hover shows the live Enter chip (no "(Enter)" text in the name); the Stop button shows the Esc chip.
5. Queue: with a queued message that is not saved yet, the visible line "Not saved yet. If Harness crashes now, the marked message could be lost." shows under the queue header (the spec proves the trigger; do not force a crash live). Hover the "not saved" chip: the old sentence appears.
6. Banner buttons (Resume now, Cancel, Switch provider, Switch account…, Sign in, Retry now, Dismiss, Allow path & retry, Just retry): Tab opens their hints. The allow-path bar shows the visible sentence "Allowing a path gives this session write access to it."

## 1e. The session list

1. Hover/Tab the filter, sort, history, activity and project buttons (drag handle, new conversation, project options, pin, tree toggle, archive, confirm).
2. With a filter active the filter button's name and hint say "Filter and sort, filters on".
3. Click Archive on a thread: the row shows "Hides this thread from the list. The messages are kept." next to Confirm.
4. Rebind New session in Settings → Keyboard and watch the sidebar header's chip follow. The sidebar toggle shows "Show sidebar" with its live chip.
5. On an automation history row, Tab to the clock chip: "Started by a scheduled automation" appears (round-2 fix: the chip is keyboard reachable).

## 1f. The session header

1. Hover/Tab every header control (Interrupt, Open, Terminal, file browser, source control, badges, mode, YOLO, FAST, pending model).
2. Put a session into a waiting state (for example a provider backoff) and read the reason in the header WITHOUT hovering — the detail ("Attempt N, retry at …") is visible next to the label.
3. Hover the session name when it is truncated: the full name appears as an overflow hint.

## 1g. The Loop switch, the setup panel and past runs

1. With no working folder picked, Tab to the Loop switch: "Pick a working folder to enable Loop Mode" appears and Space does nothing. The switch stays focusable.
2. Pick a folder: the switch works; hovering "Loop" or the switch shows the same sentence as before. Hover the switch TRACK itself (the rounded pill, not just the word): the hint appears there too (round-2 fix — the decorative track must not swallow hover).
3. In the setup panel: the close × hints "Close"; with a plan file set, Tab to the "Require plan rename" box: the reason ("This run has a plan file, so the plan rename is always required.") appears and clicks are swallowed; the selected recipe's description is visible text under the recipe list.
4. Past runs: hover the relative time (absolute time appears; reachable by Tab), Show/Hide, Copy and Reattempt. With a blocked reattempt, Tab to Reattempt shows the reason.

## 1h. The plan queue

1. With a run active, hover Pause: "Stops anything new from starting and pauses work already running. Paused work is saved and carries on when you resume." (round-2 correction — the earlier "carries on until it finishes" text described behaviour the coordinator never had.) While an item is working, press Pause: its session stops and the item reads as waiting to resume (visible status), not as still working. Hover Resume: "Lets new documents and checks start again."
2. With no parent session chosen, Tab to Start run: "Choose a parent session first." appears and the click is swallowed.
3. With no answer picked, Tab to Submit answer: "Pick an answer first." appears.
4. Hover the document paths in the item, parked, question and run lists: full paths appear when the name is truncated.
