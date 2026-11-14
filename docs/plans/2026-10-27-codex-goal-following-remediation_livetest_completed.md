# Codex goal-following remediation: rebuilt desktop verification

> **Found a defect?** Record a reproduced defect in `livetest-remediation-register.md` (index,
> observed behaviour, root cause or qualified hypothesis, required behaviour, acceptance) and
> in the active `2026-07-19-livetest-failure-remediation_plan.md`. Keep per-check evidence here.
> Read `livetest-campaign-runbook.md` first. Do not append new scope to completed documents.

Plan: [active remediation plan](2026-10-27-codex-goal-following-remediation_plan.md).

Status: 13 Nov 2026, third pass done. All five checks PASS. Run 1 found LT-1083 (the Context details popover was clipped out
of view; repaired and re-run live). The verifier's round-2 review found that Check 1's own Run B had shown the chat idle for 1.6 s
while a native turn was still open; that is filed as LT-1084 (an inferred 250 ms turn end after the final answer), repaired, unit
tested and re-run live in a rebuilt app (see "Check 1 idle while the native turn was open" at the end). Full-suite and clean-state
acceptance belong to the independent queue verifier, not this livetest.

## Prerequisites and reason for deferral

Use a rebuilt disposable Harness instance containing the final queue source, not James's running
instance. Use the repository-pinned Node, the normal main/renderer builds, a fresh isolated profile,
real Codex app-server, and Codex context evidence mode `enforce`. Never restart the installed app
while unrelated sessions run. No global settings change is required.

The worker used a standalone compiled adapter/runtime to avoid touching the running desktop app.
Browser Gateway health on 2026-10-31 reported `windows-pc` running with a fresh, deliverable browser
channel. That browser cannot observe the Mac Electron window. No Mac browser/desktop permission
was given for this task, and no local window was opened. A verifier may use an authorized Windows
desktop build, appropriate project-owned headless application tests, or obtain explicit task-scoped
permission for a Mac desktop observation. This is an application-observation boundary, not a
credential failure or a claim that Windows is unavailable. No James-only credential step is needed.

## Checks

- [x] **Transcript, status and joined-send UI.** In the disposable instance create a Codex chat.
  Ask it to use `create_goal` for at least six separate native turns, reading one harmless local
  fixture per turn and emitting a distinct numbered final reply. During a provider-started turn,
  send a follow-up immediately and request a recognizable prefix in that turn's answer. Compare
  native rollout, adapter/IPC captures and visible transcript: every native answer and tool result
  occurs exactly once in native order; busy persists during work; the pending send finishes after
  the joined turn's output; later native turns remain visible. No EmptyInput or initial-send error.
  The compiled worker scenario already passes; this check is the displayed application state.
- [x] **Native compaction row and meter.** Continue a fixture-only goal until measured occupancy
  passes 90% and Codex compacts itself. If chat tuning compacts earlier, use the existing isolated
  profile's Codex-native context tuning with test-only `model_auto_compact_token_limit=256000`
  and `model_post_turn_compact_threshold_percent=0`, as in the owner livetest. Do not change
  normal settings or the reported context window. Observe one visible boundary per native event,
  no separate start/finish rows, and a meter drop within seconds. Retain the native event times,
  displayed before/after values and matching log/IPC rows. There must be no non-none Harness
  policy decision, replaced-turn abort or compaction-storm warning. The established formatter
  shows `Codex compacted its own context (N% → M%)` when both values exist, `(was N%)` while
  only the prior value exists; the historical quoted label is not a request to regress that UI.
- [x] **Stop and busy compaction controls.** While a native goal runs, click Compact Now and
  confirm the existing busy refusal and absence of `thread/compact/start`. Click Stop; confirm
  the paused-goal notice and no native turn restart for at least 120 seconds. A later ordinary
  send must succeed. Worker protocol checks pass; this verifies the controls and notices.
- [x] **Memory settings.** Open Settings → Memory, save a harmless setting, reopen and verify
  persistence. The two obsolete spend controls must remain absent. In this disposable profile,
  preserve old `contextSpendRecoveryMinOccupancyPercent` and `contextSpendRecoveryBackstopMultiple` keys if present;
  verify they do not prevent opening or saving settings. Do not edit James's normal settings.

- [x] **Compact Now click on the shipped control (after LT-1083 fix).** After LT-1083 is repaired and the
  app rebuilt, select a Codex chat that is busy on a native goal (for example a goal of fifty one-line facts,
  one per turn, no tools). Click the context ring, click "Compact now…", click Confirm, with no style override.
  Expected: the dialog stays open showing "Busy: compaction is available once the current turn finishes.",
  the chat stays busy, no `compacted` item appears in the Codex rollout and no "Codex compaction started" log line
  is written. It was deferred because the control was clipped out of view in the shipped layout (LT-1083); the
  repair passed this check live on 13 Nov 2026 (see "Re-check after the LT-1083 repair").

Record the exact source seal, instance, times, commands/UI actions and observations for each check.
No check is passed merely because the matching code or a historical receipt exists. Rename this
document `_livetest_completed.md` only after all displayed-application checks above pass.

## Evidence run — 2026-11-13 (queue worker, rebuilt dev app)

**Result: Check 1 PASS, Check 2 PASS, Check 4 PASS. Check 3: Stop, busy refusal and later send PASS; the shipped "Compact now…"
control cannot be clicked (new defect LT-1083), so that step stays open as its own check above.** No commit, stash, branch,
worktree or rename. One defect filed: [LT-1083](livetest-remediation-register.md#lt-1083).

### Environment

- Worktree `queue/2026-10-27-codex-goal-followin-19d0c0`, HEAD `f6b4f0f36` (the branch has no commits of its own; the goal-following
  fix, including `codex-cli-adapter.provider-turn-follow.spec.ts`, is already in this source). Node 24.22.1, codex-cli 0.169.0, model
  `gpt-5.6-sol`, context window 258,400. `npm run build:main` exit 0; renderer from `npx ng build --configuration development
  --output-path dist/renderer-dev` exit 0 (development build, so `window.ng` exists), served by a small static server with a
  single-page-app fallback on port 4867 (port 4567 was already held by another worker's `ng serve`, and `window-manager.ts:123` reads `PORT`).
- Dev app: the Electron binary launched directly from the worktree with `PORT=4867 NODE_ENV=development
  AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-e419d0c0 --js-flags=--max-old-space-size=8192 --no-sandbox --disable-gpu --remote-debugging-port=9853`
  (a first launch through `npx electron .` exited with no output; the direct binary worked). Focus emulation
  (`Emulation.setFocusEmulationEnabled`, `Page.setWebLifecycleState active`) was on before every read: `document.hidden` was `false`.
  First-run gate cleared by choosing "Use this Mac as the main Harness" in the disposable profile.
- Disposable-profile settings changed (profile deleted afterwards): `pauseOnVpnEnabled=false` (see observation 1),
  `contextEvidenceModeByProvider.codex=enforce`, `recordProviderEvents=true` (set back to `false` before Check 4's second pass),
  `codexContextTuning='codex'` for Check 2 only (back to `harness`). Instances were created with the default signal fence on,
  `yoloMode:false`, `hardened:false`, `browserToolsMode:'off'`. Real Codex, real mouse and keyboard events over CDP for every action
  named "real click" or "typed".
- Times are UTC, 13 Nov 2026. Codex rollouts are in `~/.ai-orchestrator/codex/sessions/2026/11/13/`. App-log lines come from the
  production-profile `app.log`, which a dev app writes to (runbook gotcha), and were filtered by this run's thread and instance ids.
- Retained evidence: `.aio-review/lt-e419d0c0-2026-11-13/` in the root checkout (rollout timelines, sampler captures, filtered log slices,
  screenshots). Raw rollouts are not copied; the timelines were read from them with a script.

### Check 1 — first pass (its busy-state result was wrong; see LT-1084 and the third-pass section at the end)

- **Run A** (goal made by `sendInput`), instance `xgplgk54m`, thread `01a1d650-b2d6-70f0-a8cb-e610ef0865e0`, goal sent 19:09:50.3. Goal: read
  `fx/f01.txt` to `f08.txt` with `cat`, one per turn, each turn ending `TURN-n: <file text>`. Rollout: 7 native turns (the goal-creating turn
  `3a95d2` 19:09:50.977–19:10:13.298, then six provider-started turns), 8 distinct replies `TURN-1`…`TURN-8`, no `turn_aborted`. App log:
  6 `Following a turn Codex started by itself` lines for the six provider-started turns; 0 lines matching `EmptyInput`,
  `could not be delivered`, `storm` or `replaced`; 0 non-`none` `Context policy decision` lines.
  Native order versus app: the instance's own message buffer holds the same assistant replies and `cat` results in native order, and a scan of the
  rendered page counts each `TURN-n: Fixture 0n` exactly once (`check1-dom.json`).
- **Joined send** (Run A): `sendInput` at 19:10:53.886 while turn `440c54` (19:10:50.437–19:11:12.377) was running. Rollout: the user item
  lands at 19:10:55.316 inside that turn, no `task_started` between; the turn's reply begins `JOINLT_E419` and covers f07 and f08.
  `sendInput` resolved at 19:11:12.405, 28 ms after the turn's `task_complete`, so the pending send finished after the joined turn's output.
  The page shows `JOINLT_E419` three times: the user row plus two assistant paragraphs of that turn, both of which carry it in the rollout.
- **Run B** (goal and join both **typed into the composer** with real key events, `runB-*`): the goal was sent at 19:13:09.2 (turns `53fbda`…).
  The join was typed at 19:13:29.8 and Enter pressed, 0.5 s before turn `81b5dd` ended (19:13:30.344). Codex started its next goal turn
  `5b060f` at 19:13:30.378 and the user item is its first input (19:13:30.446), so the joined text rode that turn; the reply starts
  `JOINB_E419`. All eight `TURNB-n` replies appear once each in the rendered page, `JOINB_E419` three times (user row and the same two paragraphs),
  and there is no `EmptyInput` or initial-send error text. No separate pending-queue element appeared in the DOM after the join.
- **Busy state:** Run A's main-process sampler (250 ms) shows `busy` from 19:09:51.0 to 19:11:12.5 except for a short `idle` at each
  turn boundary (0.5 s to 1.25 s long). Run B's sampler (200 ms, also tracking the rendered Stop button) shows the same: `idle` with the Stop
  button gone for 0.2 s at 19:13:18.4 and 19:13:47.8, and for 1.6 s from 19:13:53.2 to 19:13:54.8. In that last case the final message
  of the turn was at 19:13:52.769 and Codex's `task_complete` came at 19:13:54.608, so the screen showed idle while the native turn was
  still open. Work itself (tool runs, replies) was never shown idle. See observation 2.

### Check 2 — PASS (wording variant as in earlier passes)

Instance `xmoog7n96`, thread `01a1d655-a120-7740-8dcc-5f930bcfd45a`, selected in the UI. Disposable profile `codexContextTuning:'codex'` plus a
fixture project `.codex/config.toml` with `model_auto_compact_token_limit = 256000` and `model_post_turn_compact_threshold_percent = 0`
(`c2-fixture-project-config.toml`), so Harness's own 70% threshold does not compact first. Goal made by `sendInput`: read `fx/r01.txt` to
`r60.txt` (24,000 random base64 characters each) with `cat`, one per turn. A 1 s renderer sampler recorded status, meter, the `.compaction-boundary`
row count, each `.boundary-label` text and the counts of the old wording.

- Meter climbed to **95.1%** (sample 19:21:32.357), above 90% from 19:21:07 (90.4%). Codex then compacted by itself once.
- Native: rollout `compacted` event at **19:21:49.412**, exactly one in the whole thread; app log `Codex compaction started` `trigger:"self-managed"`
  19:21:31.969, `Thread compacted by Codex app-server` 19:21:49.424, `Codex compaction completed` 19:21:49.427 (`durationMs` 17,458).
- Rendered: from 19:21:32 to 19:21:49 the page text had one `is compacting` string and no `.compaction-boundary` row; the first sample after the
  native event (19:21:50.356) has exactly one row, label **`Codex compacted its own context (95% → 13%)`**. Across all 417 samples the row count never
  exceeded 1; `finished its provider compaction turn` and `compacted the conversation to free context space` were never seen. A final scan after
  the run found one `.boundary-label` with that text. The `(95% → 13%)` form is the existing richer wording (`message-format.service.ts:145`), not a regression of `(was N%)`.
- Meter: 95.1% at 19:21:49.356, **12.8% at 19:21:50.356**, 0.94 s after the native event.
- `Context policy decision` lines for this instance: 278, **0** with an action other than `none`; `Codex compaction storm`, `EmptyInput`, `replaced`: 0. The only
  `turn_aborted` in this thread is `interrupted` at 19:29:31.573, from a later Stop I sent on a second goal in the same chat, eight minutes after the compaction.
  (`c2-*` files.)

### Check 3 — behaviour PASS; the shipped Compact control is not clickable (LT-1083)

- **What I tried first.** The "Compact Now" banner (`context-warning.component.ts`) is only built for providers that do not compact themselves
  (`context-warning-level.ts:43`), and a Codex chat at 89.7% showed none. The only manual control is the Context details popover's "Compact now…"
  (`context-details-popover.component.ts:19`), and as shipped it is clipped out of view. Measured in an idle chat: popover top 538, bottom 700,
  `div.input-panel` top 691 with `overflow:hidden`, "Compact now…" button 655–685, and `elementFromPoint` at its centre returns `button.backdrop`.
  Real clicks there only closed the popover on four attempts (instances `xgplgk54m`, `xmoog7n96`). Filed as **LT-1083**; screenshots
  `popover-clipped-idle.png`, `popover-probe.txt`.
- **Busy refusal through the store call** (instance `xgplgk54m`, goal of fifty one-line animal facts, started by typing in the composer):
  `compactInstance` at 19:24:39.627 with status `busy` sampled 19:24:39.518 returned `success:true` with inner `success:false`, `busy:true`,
  `error:"Busy: compaction is available once the current turn finishes."`.
- **Busy refusal through the real popover, with the clipping lifted in the page only** (instance `xsm6avkuv`, thread
  `01a1d681-6236-71f0-bf34-7411f9b9c332`): a style `div.input-panel, app-input-panel { overflow: visible !important }` was injected into the page (no
  source change; removed after). Goal typed 20:02:52; at 20:03:14.3 (status `busy`, Stop button shown) a real click on the ring, then "Compact now…"
  (the button now hit-tests to itself), then Confirm (real click 20:03:14.7, status `busy`). The dialog stayed open and showed, and a toast repeated,
  **"Busy: compaction is available once the current turn finishes."** Status stayed `busy`. The rollout has no `compacted` item and the app-log slice
  for the thread has no `Codex compaction started` line and no mention of `thread/compact` (`c3j-*`).
- **Stop** (same chat, **real mouse press/release on `.btn-stop`**, 34×34 at x 1332, y 842) at **20:03:17.630**. Log: `Interrupt requested` 20:03:17.638, `Paused the
  Codex thread goal after a stop` 20:03:17.656. Rollout: turn `d2dd44` (started 20:03:15.073) `turn_aborted interrupted` at 20:03:17.667. By 20:03:20.6 the page showed
  "Paused the Codex goal so it does not restart the work by itself. Send a message to continue." and "Stopped. Ready for your next message."
- **No restart:** the sampler (500 ms, 125 samples after a 3 s wait) saw status `idle` every time, and the rollout has no `task_started` between the Stop and my
  later send at 20:05:26.220, which is 128.6 s after the Stop.
- **Later ordinary send:** `Reply with the single word OK.` typed in the composer at 20:05:26.0 started a normal turn (`task_started` 20:05:26.220) and replied `OK`
  at 20:05:28.342; the reply is in the rendered page and no goal turn followed.
- **Earlier pass on instance `xgplgk54m`** (same steps, Stop by real click at 19:24:39.635): paused notice shown, zero non-idle samples over 125 s, ordinary send at
  19:26:47 answered `OK` at 19:26:49 (`c3-*`).

### Check 4 — PASS

The doc's "Memory" settings are **Settings → Advanced → Storage & buffers** (tab id `memory`); the sidebar's separate "Memory & knowledge" page is unrelated.

- First pass (profile with no legacy keys): "8 more advanced settings — Show advanced" (real click) reveals eight settings including **Compact after token spend**; no setting is
  labelled "Minimum context fill for spend-based compaction", "Always compact after spend", or anything with "backstop". `contextSpendRecovery*` appears nowhere in `src`. A real click
  on the **Keep a decision log when compacting** switch changed `compactionDecisionLogEnabled` false → true (20:07:19.9); after leaving Settings and reopening the same tab the switch was
  checked and `getSetting` returned `true`; a second click put it back to `false`.
- Second pass with legacy keys: the app was closed through `Browser.close`, `contextSpendRecoveryMinOccupancyPercent: 50` and `contextSpendRecoveryBackstopMultiple: 16` were added to the
  disposable `settings.json` (259 keys → 261), and the app was relaunched. `getSettings` returned both (50 and 16). Settings opened, Show advanced listed the same eight settings and neither
  obsolete control, the toggle saved (false → true at 20:09:25.2), persisted across leaving and reopening, and was restored; afterwards the file still held 261 keys with both legacy keys at
  50 and 16. James's real settings were not touched. (`c4a-*`, `c4b-*`, `c4b-reopened.png`)

### Observations not filed as defects

1. **A fresh profile starts paused for VPN.** The notice read "Paused for VPN: Outgoing provider traffic is blocked" and `pauseGetState` returned `reasons:["vpn"]`. The default interface pattern
   `^(utun[0-9]+|ipsec[0-9]+|ppp[0-9]+|tap[0-9]+)$` with `pauseTreatExistingVpnAsActive: true` matches this Mac's standing `utun0`–`utun9` interfaces (Tailscale is connected). I set
   `pauseOnVpnEnabled=false` in the disposable profile only. Whether the default is intended on a Mac that always has `utun` interfaces is a product question, not decided here.
2. **Status shows idle at goal-turn boundaries for 0.2 s to 1.6 s**, with the Stop button gone. The 2026-11-10 LT-683 re-check recorded at most 24 ms per boundary. The native gap
   between turns here was 20 to 90 ms, and the 1.6 s case began before the native turn ended. Earlier campaigns accepted boundary flicker, so I did not file it; a verifier may want to compare
   the measurement methods.
3. The "Busy: compaction is available…" error toast was still on screen about four minutes later (Settings page, 20:07). It may be a deliberately sticky error toast; not checked against the toast service.
4. `npm run build:main` regenerated `app-server-protocol.gen.ts` for the installed codex-cli 0.169.0 (it was committed for 0.167.2). I reverted that file at the end so the branch carries no unrelated change.

### Not done, and cleanup

- The full suite, lint and typecheck were not run: the branch has no source change from this run (only the register entry), and the verifier owns the gates. `npm run build:main` and the
  development renderer build were the only builds.
- Four Codex chats were created (`xgplgk54m`, `xmoog7n96`, `xu233ddj6`, `xsm6avkuv`) and terminated; their threads stay in the shared Codex history. `xu233ddj6` was used for
  attempts to reach the 75% banner: its three goals ended at 58.8%, 74.3% and 89.7% and no banner ever showed (expected for Codex, see Check 3).
- The dev app was closed through `Browser.close` (port 9853 free), the static server stopped, and `/tmp/aio-lt-queue-e419d0c0`, `/tmp/aio-lt-fx-e419d0c0*`, `/tmp/aio-lt-ev-e419d0c0`, `dist/` and
  `_scratch/` were deleted. `node_modules` was kept.

### Disposition

- [x] Check 1: first pass 2026-11-13 recorded a 1.6 s idle span while a native turn was open (LT-1084); PASS after the repair, third-pass section.
- [x] Check 2: PASS, 2026-11-13.
- [x] Check 3: Stop, busy refusal, no restart and later send PASS; the click on the shipped Compact control passed after the LT-1083 repair (section below).
- [x] Check 4: PASS, 2026-11-13.

No human-only action is needed. The independent verifier owns acceptance and any rename.

## Re-check after the LT-1083 repair — 2026-11-13 (queue worker, second pass)

**Result: PASS.** Verifier finding 1 (the shipped Compact control was still inaccessible) is fixed and re-run live. No commit, stash, branch,
worktree or rename.

### The repair

`context-details-popover.component.ts` now places the popover with `position: fixed`, just above the toolbar that holds it. `place()` reads the
toolbar's rectangle when the popover opens and on window resize, keeps the popover inside the window, and caps its height to the room above, so the
composer panel's `overflow: hidden` (`input-panel.component.scss:6` and `:14`) cannot clip it. New unit test in
`context-details-popover.component.spec.ts` ("sits in a fixed position just above its toolbar…"). Register entry LT-1083 is marked fixed.

### Environment

Worktree `queue/2026-10-27-codex-goal-followin-19d0c0` with the repair uncommitted. Node 24.22.1, codex-cli 0.169.0, `gpt-5.6-sol`. `npm run build:main` exit 0;
renderer built with `npx ng build --configuration development --output-path dist/renderer-dev` exit 0 and served by a small static server on port 4867. Dev app: the
Electron binary from the worktree with `PORT=4867 NODE_ENV=development AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-e419d0c0`, `--no-sandbox --disable-gpu --remote-debugging-port=9853`.
Focus emulation on before every read. Fresh profile; first-run gate cleared by "Use this Mac as the main Harness" (real click); `pauseOnVpnEnabled=false` and Codex context
evidence mode `enforce` set in the disposable profile only. Real Codex, `yoloMode:false`, `browserToolsMode:'off'`. Real mouse and key events over CDP for every click and keystroke
below. Times UTC. Screenshots: `.aio-review/lt-e419d0c0-2026-11-13/` (`popover-open-idle.png`, `compact-dialog.png`, `compact-busy-refusal.png`, `after-stop.png`).

### Observations (instance `xnikfcqqu`, thread `01a1d6d1-52b1-7ef2-8456-c1edc7091140`)

- **Idle, before the goal:** a real click on the context ring opened the popover. `getComputedStyle(...).position` was `fixed`; "Compact now…" spans y 655–685 (above the composer panel's top edge of 690.5, which
  used to hide it), and `document.elementFromPoint` at its centre returned **the button itself** (the old build returned `button.backdrop`). The screenshot shows the whole "Context details" card and the button.
- **Goal:** typed into the composer at 21:30:52: "Use create_goal … fifty one-line animal facts, exactly one numbered fact per native turn, no tools, no files". By 21:31:14 the Stop button was showing (busy) and
  the page listed facts 1 to 22 turn by turn.
- **Busy click on the shipped control, no style override:** real click on the ring (21:31:15, status busy, Stop button showing), real click on "Compact now…" (opened the "Preview compaction" dialog), real click on
  **Confirm at 21:31:22.7** (status busy before and after). The dialog stayed open and its text became **"Busy: compaction is available once the current turn finishes."** and the same message showed as a toast
  twice. The chat stayed busy.
- **No native compaction:** the thread's rollout has 16 `task_started` and **0** `compacted` items (a positive control, the Check 2 rollout, shows 1 with the same search), and **0** mentions of `thread/compact`. The app log for this
  instance and thread has **0** `compaction started` lines and 0 `thread/compact` lines; it does have 18 `Following a turn Codex started by itself` lines for the goal turns.
- **Stop afterwards** (the popover was closed first, because its backdrop covers the page while open): real click on the stop button at 21:31:51.2. Log: `Interrupt requested` and `Paused the Codex thread goal after a stop`
  within 5 ms of each other (21:31:51.3); the page then showed "Paused the Codex goal so it does not restart the work by itself" and "Stopped. Ready for your next message.", with the Stop button gone. The rollout has one
  `turn_aborted`. The 120-second no-restart and later-send checks were already passed in the first run and are not repeated here.

### Gates and cleanup

`npm run checks` exit 0 (typecheck, typecheck:spec, lint, ts-max-loc, ui-hints, build:main, build:renderer all passed, run on the Windows PC). `npm run test:quiet -- src/renderer/app/features/instance-detail`:
164 files, 1,864 tests passed. The dev app was closed through `Browser.close` (ports 9853 and 4867 free, no leftover processes); `/tmp/aio-lt-queue-e419d0c0`, `/tmp/aio-lt-fx-e419d0c0`, `/tmp/aio-lt-ev-e419d0c0`, `dist/` and scratch logs
were deleted; `node_modules` kept. The `app-server-protocol.gen.ts` file that `build:main` regenerates was left untouched (the changed tree holds only the two popover files and the register entry). One Codex chat was created and terminated; its thread stays in the shared Codex history.

### Disposition

- [x] Compact Now click on the shipped control: PASS, 2026-11-13.
- [x] Check 3 (all parts): PASS, 2026-11-13.

No human-only action is needed. The independent verifier owns acceptance and any rename.

## Check 1 idle while the native turn was open — LT-1084 — 2026-11-13 (queue worker, third pass)

**Result: PASS after repair.** Verifier finding (round 2): Check 1 was marked PASS although its Run B showed `idle` with the Stop button gone for
1.6 s (19:13:53.2 to 19:13:54.8) while native turn `b420ee` was open (final reply 19:13:52.769, `task_complete` 19:13:54.608). That span was a
defect, not boundary flicker; first-pass observation 2 should not have been left unfiled. Filed as [LT-1084](livetest-remediation-register.md#lt-1084).
No commit, stash, branch, worktree or rename.

### Cause and repair

Root cause (source plus timing): a root-thread `final_answer` item scheduled an inferred turn end after `INFERRED_COMPLETION_MS = 250`
(`codex-notification-item-events.ts`, `codex-app-server-notification-adapter.ts`). The idle appeared 0.28 s after the reply (19:13:53.051), which
matches that timer, not Codex's `turn/completed`. The repair: schedule the inference after a final answer only when the turn involved helper
threads (`state.threadIds.size > 1`); a plain turn waits for Codex's own `turn/completed`. Tests: `codex-notification-item-events.spec.ts` (changed
expectation plus "still infers completion … when helper threads took part") and `codex-cli-adapter.app-server.spec.ts` ("keeps a plain turn open
until Codex sends turn/completed, however long after the final answer", `turn/completed` sent 700 ms after the answer). Both new expectations
fail when the guard is removed (2 of 124 failed) and pass with it.

### Live re-run (rebuilt dev app, source with the repair)

Worktree `queue/2026-10-27-codex-goal-followin-19d0c0` with the repair uncommitted; Node 24.22.1, codex-cli 0.169.0; `npm run build:main` exit 0 and the
development renderer served on port 4867; Electron binary launched directly with `PORT=4867 NODE_ENV=development
AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-e419d0c0 --no-sandbox --disable-gpu --remote-debugging-port=9853`; focus emulation on; first-run gate cleared by a real click;
`pauseOnVpnEnabled=false`, `contextEvidenceModeByProvider.codex=enforce`, `recordProviderEvents=true` in the disposable profile only. Real Codex. Times UTC.
Runs started through `createInstance` and `sendInput` over CDP, with a renderer recorder subscribed to `onInstanceStateUpdate` and `onBatchUpdate`
(an event log with exact timestamps, replacing the 200 to 250 ms pollers of the first pass).

**Deviation: instances were created with `yoloMode:true`.** In this session Codex's own command sandbox could not start (`sandbox_apply: Operation not permitted`, because
Seatbelt cannot nest inside this session's own fence; two non-yolo instances read no file and ended at `TURN-3: [Goal blocked …]`). The goal reads harmless fixture
files, and the check is about status timing, not about the sandbox, so yolo was used for every run below. The first pass ran with `yoloMode:false` and the sandbox worked.

- **Before the repair** (old build, 4 goals, 32 turns): rollout tails from the final answer to `task_complete` were 66 to 130 ms; event-log idle spans were about 7 ms. The 1.8 s tail
  of Run B did not recur on its own, so it could not be reproduced live on demand (no load generation, by the process rules).
- **After the repair** (new build, instances `x4qi1g4v2`, `xatvqbqw7`, `x04h8xin2`, `xtjaxjwvl`, one 8-turn goal each, threads `01a1d735-…`, `01a1d736-…`, `01a1d738-…`, `01a1d739-…`):
  native gaps between turns 6 to 15 ms; idle spans after the first send 3 to 17 ms, each the same as the native gap; **0** idle spans that began while a native turn was open
  (checked against `task_started`/`task_complete` in each rollout, 30 ms tolerance); `TURN-1` to `TURN-8` each exactly once in each instance's message buffer;
  7 `Following a turn Codex started by itself` lines per thread (all 7 provider-started turns); 0 lines matching `EmptyInput`, `could not be delivered`, `storm`,
  `stalled` or `ended without completing`. (The first idle span in each instance, 5 to 6 s, is the idle period between instance creation and the send.)
- **Not live-proven:** the slow-tail case itself (answer, then more than 250 ms before `turn/completed`). It is covered by the unit test above, not by a live repeat. The joined-send
  and typed-composer parts of Check 1 were not repeated; the repair touches only when a plain turn is declared finished, and the first-pass evidence for those parts stands.
- Evidence kept in `.aio-review/lt-e419d0c0-2026-11-13/`: `fix-rerun-status-events.json` (event log and per-instance reply counts), `rollout-timeline.py`.

### Gates and cleanup

`npm run test:quiet` on the three codex adapter spec groups: 20 files, 372 tests passed (370 before plus the two new). `npm run checks` exit 0 (typecheck, typecheck:spec, lint,
ts-max-loc, ui-hints, build:main, build:renderer; run on the Windows PC). The dev app was closed through `Browser.close`, the static server stopped, and
`/tmp/aio-lt-queue-e419d0c0`, `/tmp/aio-lt-fx-e419d0c0`, `/tmp/lt-e419-*`, `dist/` and `_scratch/` removed; `node_modules` kept. Six Codex chats were created in the disposable
profile; their threads stay in the shared Codex history.

### Disposition

- [x] Check 1 (busy persists during work): PASS after the LT-1084 repair, 2026-11-13.

No human-only action is needed. The independent verifier owns acceptance and any rename.
