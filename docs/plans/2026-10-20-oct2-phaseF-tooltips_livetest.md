# Phase F: queue-copy checks on Windows

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation-followup_plan.md` (or its current
> completed successor if the register points there). Keep per-check evidence in this file.
>
> Before running a campaign, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [Phase F](2026-10-20-oct2-phaseF-tooltips_plan.md).

## Status and prerequisites

Not run. On main: no. This file covers only the independently implemented H9 copy slice. Steps 1–6 are blocked on
Phase B's actual code integration and remain open in the plan; they are not live-test deferrals. In particular, this
file does not certify disabled reasons, message-box naming or rebound shortcuts.

- The coordinator must integrate the reviewed copy slice, rebuild main and renderer, and identify the build under test.
  James chooses when to restart an installed app. Do not restart Harness from a queue worker.
- All browser inspection runs on `windows-pc` via Browser Gateway. Preflight the worker and its browser channel first.
  If unavailable, report the actual health result and leave checks blocked; never silently use the Mac.
- Use an existing test session with an active turn and queued messages, and a plan-queue run in each of Running and Paused.
  Hover/focus inspection needs no new actions sent to agents. Never pause or cancel James's real work for a tooltip check.
- No feature flags are required. Test keyboard focus with real Tab/Shift+Tab/Escape keystrokes. A human with the Windows
  screen reader checks actual announcements; jsdom cannot establish assistive-technology behaviour.

## H9 checks

- [ ] **Typed steering:** focus the composer in a working test session. The hint distinguishes Enter (after the current
  turn) from Steer (send next). Hover and keyboard-focus Steer. Its tooltip explains requesting a stop and waiting during
  provider compaction, without promising delivery after the next tool call. Escape dismisses the tooltip. Do not press Steer.
- [ ] **Startup and recovery:** inspect a starting session. Its hint says Enter queues until the session is ready and
  does not offer Steer. Inspect an interrupt/recovery state: the hint must not offer a Steer button that is absent.
- [ ] **Queued steering:** hover/focus a queued message's Steer button. The tooltip says it goes to the front of the queue
  and requests a stop. A pending `steer` badge is reachable by Tab and explains that it waits ahead of ordinary messages.
  Edit and cancel/restore controls keep their accessible names and their hover explanations. Do not activate them on real work.
- [ ] **Plan controls:** hover/focus Pause, Resume and Cancel in suitable test runs. Pause says sessions stop now and work
  is saved on branches; Resume waits for pausing to finish, then starts as slots free up; Cancel says it asks first, skips
  unstarted work and parks work in progress. Pause all/Resume all describe all applicable queues. The visible inline Cancel
  consequence remains present at confirmation. Only open confirmation on an expendable test run; dismiss with Never mind.
- [ ] **Screen reader:** with a Windows screen reader enabled, focus the new tooltip hosts and the pending-steer badge.
  Confirm their names/explanations are announced and Escape restores normal navigation without trapping focus.
- [ ] **Layout:** inspect the composer and queue tooltips at normal width, a narrow window, and 200% zoom. Record width
  and screenshots. Confirm that Enter/Steer timing remains discoverable and tooltips fit within the window without
  covering the next focused control. This checks actual layout and text clipping, which the DOM overlay tests do not prove.

Why deferred: Windows browser and screen-reader inspection is required by this plan's routing rule. The worker has run
headless component/overlay checks and the Angular production build; those are automated evidence, not an eyes-on or
screen-reader claim. The remaining six implementation steps must be resumed after their code dependencies arrive.
