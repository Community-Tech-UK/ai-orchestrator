# Set aside merge: live checks for hand-merged fixes that had no plan of their own

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour and acceptance). Run `node scripts/next-lt-id.mjs` for the id and
> recheck before adding the row; the command does not reserve it. The register's index row owns the defect's
> status; implementation notes go in the plan or live-test document that fixes it. Keep per-check evidence in
> this file. Never add work to a closed plan.
>
> Before running a campaign, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [Set aside merge ledger](2026-11-05-set-aside-merge_plan.md). Checks for job-owned work live in each job's own
`_livetest.md`; this file holds only fixes the merge session made itself.

**Prerequisites:** a Harness rebuilt from main at or after 7f394ad1e (9 Nov 2026) and restarted by James when no live
session would be lost. Confirm the running build in Settings > Health > About. The installed app (app.asar dated
8 Nov 20:50) does not contain this fix. Signed-in Codex, Copilot and OpenCode CLIs, and a disposable session and folder. No flags.
Do not restart or control James's running Harness from an agent.

## 1. Cancelling a loop straight after starting it leaves no CLI child running

Code: `src/main/orchestration/tracked-adapter-terminator.ts`, `src/main/orchestration/loop-end-tracker.ts`, wired in
`default-invokers.ts` for every provider (commits 41a4f8c5f to 7f394ad1e, 7 commits). Before the fix, a Codex
app-server or ACP loop (Copilot, OpenCode, Cursor) cancelled before its child spawned left that child running until
Harness quit. Copilot and OpenCode stand in for the other ACP providers. In hardened mode Codex runs `codex exec`
instead of app-server; note which mode was used.

How to see the child: call the orchestrator `list_host_processes` tool with `nameFilter` set to `codex`, `copilot` or
`opencode` and `limit: 100`. Rows show only the program's first word and cannot be tied to a loop, and James's own
sessions also appear, so compare process ids (PIDs): record the list before starting, at the moment of cancelling,
and ten seconds later (the teardown wait is bounded at five seconds).

For each of Codex, Copilot and OpenCode, in a disposable folder:

- [x] Start a loop with the default "Same session" setting and cancel it within about two seconds, before the first
  reply appears. Expected: any PID that appeared after the start is gone ten seconds after cancelling. Record whether
  a new child PID already existed when you cancelled; if none did, the cancel landed before spawn, which is the case
  the fix targets, and the check still passes only if no new PID appears afterwards.
- [x] Repeat with the loop's "Fresh child" setting, cancelling during the first round's start-up.
- [x] Within a minute of the third cancel for a provider, start a fourth loop with the same provider. Expected: its
  first round starts normally, with no "Circuit breaker ... is OPEN" refusal (the loop breaker opens after three
  counted failures for 60 seconds, and ended-loop stops must not count). The app log shows no "Stopping a child
  spawned after its loop ended failed" warning.
- [x] Control: cancel a loop normally mid-round. It stops, its child PID exits, and the loop shows as cancelled.

Why live: the fix was reproduced and verified only with fake adapters in unit tests. Real CLI start-up timing and
process trees need real signed-in CLIs on the installed build.

## Evidence run — 12 Nov 2026 (dev app from the queue worktree)

**Build under test.** Dev app built from the worktree of branch `queue/2026-11-05-set-aside-merge-37d690` (HEAD 36611bb65;
commit 7f394ad1e is an ancestor, and `dist/main/orchestration/tracked-adapter-terminator.js` contains the loop-stop
guard). `npm run build:main` exit 0, development renderer build exit 0. Launched with
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-1737d690`, `--remote-debugging-port=9628`, `--no-sandbox --disable-gpu`
(signal-fence launch), focus emulation on, `pauseOnVpnEnabled` off. Not hardened, so Codex used app-server mode
(log: "Codex adapter using app-server mode"). Loops were started with `window.electronAPI.loopStart` and cancelled
with `loopCancel` over CDP, in a disposable folder (`/tmp/aio-lt-queue-1737d690-work`, with a `test` script so the loop
gets a verification authority). Process ids came from `list_host_processes` (filter `codex` / `copilot` / `opencode`);
the dev app was pid 68581 for the Codex runs and 1375 after a relaunch for Copilot and OpenCode, so "ours" means
`parentPid` equal to that pid. Other rows (parents 22426, 10454) are James's own sessions or other agents.
Baselines before the first loop: Codex rows all parented to other apps; Copilot and OpenCode: none.

**Setup note (not a defect).** A fresh dev profile has no Copilot sign-in of its own: the first Copilot loops errored
with "Copilot account ... is not signed in on this device" (`copilot_account_binding_checked ... unauthenticated`)
because Harness keeps Copilot's sign-in in its own folder under the profile, not in `~/.copilot`. Those runs are
discarded. I relaunched the dev app with `AI_ORCHESTRATOR_COPILOT_HOME` pointing at a private 0600 copy of the
existing sign-in file in `/tmp` (deleted afterwards; contents never printed). Binding then logged `authenticated`.
Codex and OpenCode bindings were `authenticated` with no extra setup.

**Results.** All times UTC on 12 Nov. "Cancel" is `loopCancel` returning status `cancelled`.

| Provider | Run | Start to cancel | Process ids after the cancel |
| --- | --- | --- | --- |
| Codex | Same session | 1.5 s (09:17:59, child already up: "App-server thread started" 1.1 s before cancel) | none of ours, 2 s later; loop failed with `instance-interrupted` |
| Codex | Same session | 0.25 s (09:18:16, cancel landed during start-up, before the child existed: `CODEX_HOME` created, cancel, then app-server init failed and exec fallback was retried, then "zombie turn - hard adapter cleanup") | none of ours at about 2 s and at about 15 s (09:18:18 and 09:18:34 lists) |
| Codex | Same session 0.25 s, Fresh child 0.25 s, Same session 0.7 s (09:18:37 to 09:18:42, third cancel at 09:18:42) | each `cancelled` | no extra Codex rows besides the fourth loop's own child (below) |
| Codex | Fourth loop, started 09:18:42, first round started normally | child PID 87071 (parent 68581) visible 10 s later, then the control cancel at 09:18:56 | PID 87071 gone at 09:18:58; no other Codex row from our app |
| Copilot | Same session 1.5 s, Fresh child 1.0 s, Same session 0.25 s (09:20:37 to 09:20:42) | each `cancelled`, 1 s teardown each | list at 09:20:46 showed only the fourth loop's child (pids 16043 and 16044) |
| Copilot | Fourth loop (09:20:43), control cancel at 09:20:49 | child existed before the cancel | none at 09:20:52, which is also 10 s or more after the three earlier cancels |
| Copilot | Extra: start, wait 6 s, child present (pids 24858 and 24859), cancel at 09:21:51 | | none at 09:21:55 |
| OpenCode | Same session 1.5 s, Fresh child 1.0 s, Same session 0.25 s (09:21:03 to 09:21:10) | each `cancelled` | only short-lived install probes plus the fourth loop's own child |
| OpenCode | Fourth loop (09:21:11), control cancel at 09:21:21 | long-lived child PID 20965 (542 MB, parent 1375) present | none at 09:21:24 |

Per-check outcome:

- **Same session, cancel within about two seconds, each provider: pass.** Cancels at 0.25 s to 1.5 s, in both
  orders. No Codex, Copilot or OpenCode process of ours remained after any cancel. For Codex both sides were seen:
  cancel after the child existed (run 1) and cancel before it existed (run 2). For Copilot and OpenCode I could not
  tell from the log whether a child had spawned at each of the three quick cancels; I list only that nothing was
  left. I could not capture a process list at the exact cancel moment (each list call takes a few seconds), so the
  "was a new PID present at cancel" question is answered for Codex from the log and, for Copilot and OpenCode, only by
  the late-cancel and control runs where the child was proven present beforehand.
- **Fresh child, cancel during first-round start-up, each provider: pass.** Same result, no leftover process.
- **Fourth loop within a minute of the third cancel, each provider: pass.** All three fourth loops reported status
  `running` and started a real child; none was refused. Searching the app log (which a dev app shares with the
  production profile) for `is OPEN` or `Circuit breaker` found 0 matching lines, and `Stopping a child spawned after
  its loop ended failed` appears 0 times. Every cancelled iteration logged `instance-interrupted` (the translated
  stop error), which is what keeps ended-loop stops out of the breaker.
- **Control, normal mid-round cancel, each provider: pass.** Codex PID 87071, Copilot 16043/16044 (and 24858/24859),
  OpenCode 20965 were present while running, loop status `cancelled` with reason "user cancelled", and the child was
  gone at the next list.

**Defects reproduced:** none. No register entry added.

**Not covered.** The installed `/Applications/Harness.app` was not driven (James's running app must not be controlled
from an agent). Its `app.asar` is dated 11 Nov 08:39 and contains the string `createLoopStopGuard`, so it likely has this
fix, but which build is running was not confirmed (Settings > Health > About needs a person at that app). Hardened-mode
Codex (`codex exec`) was not run. Cursor, the other ACP provider named in the code note, was not run; Copilot and
OpenCode stand in for it as the document states.

**Evidence files** (worktree `_scratch/lt-set-aside/`, ignored by git): `evidence-my-loops.log` (app-log lines for
the 14 loop runs), build logs, and the CDP scripts used.
