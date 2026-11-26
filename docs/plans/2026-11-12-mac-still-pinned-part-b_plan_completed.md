# Unattended sessions on the test Mac (Part B of "keep this Mac as a backup")

## Status

On main: yes (this landing commit)
- **Scope (narrowed 26 November):** B1 (automations) and B2 (queue jobs), the switch rule only. Loops elsewhere, repository automations,
  mid-job faults and the PC's Linux side moved to [Part C](2026-11-26-mac-still-pinned-part-c_plan.md), not built.
- **Built (rounds 1 to 4):** with "Use this Mac" off, a queue job waits (queued, "Waiting for a computer: ...") while a computer that
  could take it is busy, paused or away, including when that happens after the scheduler chose it or while it runs there. An unpinned
  automation goes only to the connected test Mac and waits for it (a late "full" is refused with `ComputerBusyError` and retried); one in a
  Git repository stays here with the reason. Jobs no computer could ever take (none set to take jobs, wrong tool, no sign-in, project not
  checked), even a paused or away one, run here saying why. Evidence: [history](2026-11-12-mac-still-pinned-part-b_plan_history_82446009129cec775be4bc1f7e63346bb59bf6817d245d5ee041869665c30335_completed.md).
- **Live checks:** [livetest](2026-11-12-mac-still-pinned-part-b_livetest.md), after a rebuild and restart.
- **Decision:** the PC is excluded from automations until Part C; queue jobs use each computer's own "Plan Queue jobs" switch and the Computers order.

## The switch

Built in Part A: `useThisMac` in `~/.ai-orchestrator/remote-checks/config.json`, set from the Computers page, missing means on.
Read it through `readUseThisMac()` in `src/main/computers/test-machine-file.ts`.

## Step B1 — Automations

- **Change:** automations can already be pinned to a computer (`automation.types.ts:131`, passed through at
  `automation-runner.ts:404-425`). Before this step, with no computer chosen the session ran here (`execution-location-resolver.ts:86-118`
  fell back to local). With the switch off, an unpinned automation goes to the connected test Mac only, never another connected computer such
  as Noah's, and waits when it is busy, paused or away. The choice (`selectNode`) is limited to that machine and requires the working folder.
- **Left here, with the reason:** an automation in a Git repository stays on this Mac, because its checkout can't move yet (Part C, C1).
  The PC is excluded until Part C, C4.
- **How to prove it:** resolver and admission specs for "switch off, no computer free: waits, doesn't run here" (done), and one real
  scheduled automation on the test Mac (livetest LT-B1a to LT-B1c).

## Step B2 — Queue jobs: the switch rule

- **Already built (landed earlier):** queue jobs run on another computer: the checkout is sent there, the session works in that copy and its
  commits come back ([plan](2026-11-08-plan-queue-jobs-on-other-computers_plan_completed.md)). Landing, the queue's records and the final
  checks stay here.
- **Change:** with the switch off, a job that a computer set to take jobs could take later (busy, paused, away, at its limit) waits instead of
  running here, and keeps waiting if its computer drops. The queue stops judging by this Mac's load for jobs held for another computer
  (`plan-queue-pump.ts`); the limit is the far computer's free job slots. Jobs nothing could take (no computer set to take jobs, tool not
  signed in, tool other than Claude or Codex) still run here, with the reason on the timeline.
- **How to prove it:** placement, pump and away-timeout specs (done); livetest LT-B2a to LT-B2c on the real app.

## What must stay true

Everything in the parent plan's "What must stay true", in particular: James's own chats, the Harness app, databases and dev servers
stay on this Mac; browser work never falls back here; no branch is pushed and no job lands from the far machine.
