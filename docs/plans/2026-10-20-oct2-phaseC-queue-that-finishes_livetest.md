# Phase C: live validation after integration

Status: pending. This document does not close the implementation plan or defer agent-runnable work.

Prerequisites: AIO integrates and independently verifies Phase A's required guards and Phase B's A15 work,
then integrates Phase C's implemented independent work, rebuilds and restarts Harness through the normal pipeline.
Any remote hard-stop check also requires the matching worker-agent bundle rebuilt and restarted through that pipeline;
legacy ordinary acknowledgements do not prove confirmed termination. No worker upgrade or installed-worker check ran here.
Interactive checks use an isolated fixture profile on `windows-pc`, never James's real queue, settings or databases.
No Mac browser/desktop access is authorised. Preflight the Windows worker and Browser Gateway channel explicitly.

Plan: [queue that finishes](2026-10-20-oct2-phaseC-queue-that-finishes_plan.md).
Evidence: [implementation history](2026-10-20-oct2-phaseC-queue-that-finishes_history.md).

**Remediation flow:** read [the campaign runbook](livetest-campaign-runbook.md). A reproduced defect receives an index
row and detail section in [the standing register](livetest-remediation-register.md). Obtain the next index ID with
`rtk node scripts/next-lt-id.mjs /Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/livetest-remediation-register.md`,
coordinate with its current owner, and re-check immediately before writing. The index row is the defect's status;
implementation notes belong in the plan or livetest document that fixes it. Keep per-check evidence here. Do not
append to a closed remediation plan or rename this document until every check below has current evidence.

## 1. Second-opinion usage after K2 restart

- [ ] Confirm the installed build contains Phase A K2 attribution and record the app restart/build identity.
- [ ] In the isolated Windows fixture profile, request one second opinion from Copilot on a changed fixture file.
  Capture the review ID, native Copilot session ID and account profile from the test instance's diagnostics.
- [ ] Read that fixture session's `events.jsonl` once with `CopilotEventsTail.poll()` from the installed compiled module
  (or the matching source under `npx tsx`). Print only the numeric `premiumRequests` projection. Record the measured
  units, number of dispatched reviewer sends (including any repair) and review ID in this plan's history. Do not
  infer units from estimated dollar cost or copy message text.
- [ ] Submit a newer text turn and an attachment-only turn while a review is running. The matching review stops,
  the badge settles, earlier history survives, and unrelated instance reviews continue. Pause/resume must also
  settle the badge and permit a subsequent review.

Expected: premium units are measured rather than guessed; cancellation produces one terminal outcome and no
reviewer retirement penalty. Why pending: Phase A is not integrated/installed and no restart was performed in this
queue checkout. Unit and real renderer-subscription regressions have run; installed attribution evidence has not.

## 2. Scheduled-job controls in the rebuilt app

- [ ] Create a fixture check job in the human Automations form. Confirm Sonnet/low defaults, 90-minute time limit,
  editable processed-token cap and opt-in unchanged-output backoff. Saving/reopening preserves values.
- [ ] Set its time limit to 1 minute. Run a fixture agent task that remains busy beyond that limit with a child.
  Expected: parent and child stop; run is failed with `Stopped after 1 minutes`; partial output remains; no retry.
- [ ] Create a one-time fixture prompt job, start it, then restart the isolated fixture app once while it is running.
  Expected: interrupted row remains visible, one continuation is scheduled, one-time next fire is restored, failure
  streak does not increase, and another restart never schedules a second continuation for the same interrupted job.
- [ ] Exercise an opt-in recurring fixture monitor with repeated output differing only in date/time/duration/id.
  Expected: intervals double to at most 4× nominal and the next-check explanation changes; substantive output change
  returns to nominal. Ten unchanged successful outputs offer a dismissible Sonnet/low suggestion without changing
  the job. Explicit quiet-result handling remains unimplemented under Step 9.4 and is not verified by this check.

Why pending: these checks validate installed app/UI/restart integration. Focused runtime, migration, schema,
privilege-ceiling and renderer tests cover the implemented behavior in-loop; no production job was created.

## 3. Copilot presentation and local loop recycling

- [ ] In the rebuilt fixture app, open a Copilot chat/account model choice and find Opus 5.5.
  Expected: `Opus 5.5 · 15 premium requests each`; wire model ID remains unchanged.
- [ ] Run a local fixture Copilot turn. Expected: header shows measured `Premium requests used: N`, or unavailable
  when no evidence exists; no invented estimated dollar total. A remote fixture must explicitly say unavailable
  because remote usage/recycling is still an implementation gap, not a completed feature.
- [ ] Exercise a local fixture loop whose successful compaction leaves measured occupancy above 90% of the reported
  token limit. Expected: existing recycle/handoff path starts a fresh session while retaining loop/chat identity and
  task context. Queue recycling is still an implementation gap: Phase A guards must land before Phase C adds its reset seam.
- [ ] With a fixture CLI diagnosis below 1.0.100, open CLI health and loop preflight, including a selected preset.
  Expected: `Copilot below 1.0.100 may stall for minutes on a hung tool server.`

Why pending: requires the integrated rebuilt app and native provider behavior. Fixture tail, ACP/native integration,
loop reuse/handoff and headless renderer tests already ran; no browser was opened in this worker turn.

## 4. Unrestricted OS process-tree confirmation

- [ ] Use an isolated, unrestricted controller/worker checkout of the integrated verified build. Run the normal
  `npm run build:main` pipeline first so `dist/main/cli/adapters/owned-process-tree.js` is current. No production
  source, profile or settings changes are needed. James must run this outside the restricted agent command channel,
  or use an approved test runtime that can execute OS process inventory. Harness UI must not be driven through
  Computer Use; these are plain CLI checks.
- [ ] On POSIX, preflight `ps -A -o pid=,ppid=,pgid=,stat=,lstart=`. On Windows, preflight
  `powershell.exe -NoProfile -NonInteractive -Command 'Get-CimInstance Win32_Process | ForEach-Object { "{0}|{1}|{2}" -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().Ticks }'`.
  Expected: exit0 and populated identity rows. Record exit/count only, not the host inventory.
- [ ] From that verified checkout root, run the following JavaScript using Node. POSIX: enclose it in
  `node <<'NODE'` / `NODE`; PowerShell: enclose it in `@'` / `'@ | node`. It creates two harmless fixture processes
  with at most25-second lifetimes, uses the actual compiled ownership/stop implementation, and creates no files.

```javascript
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { resolve } = require('node:path');
const { OwnedProcessTree } = require(resolve('dist/main/cli/adapters/owned-process-tree.js'));
const { captureProcessBaseline } = require(resolve('dist/main/cli/adapters/owned-process-inventory.js'));
(async () => {
  function fixtureWrapper() {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 20000)'], { stdio: 'ignore' });
    process.stdout.write(String(child.pid));
    child.once('exit', () => process.exit(0));
    setTimeout(() => process.exit(2), 25000);
  }
  const baseline = captureProcessBaseline();
  if (!baseline) throw new Error('Pre-spawn process inventory is unavailable');
  const wrapper = spawn(process.execPath, ['-e', `(${fixtureWrapper.toString()})()`], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = once(wrapper.stdout, 'data');
  let confirmed = false;
  try {
    await once(wrapper, 'spawn');
    const [output] = await ready;
    const descendantPid = Number(output.toString().trim());
    if (!Number.isSafeInteger(descendantPid) || descendantPid <= 0) throw new Error('Invalid fixture child PID');
    const owner = new OwnedProcessTree(wrapper, process.platform !== 'win32', baseline);
    owner.capture();
    await owner.stopConfirmed(false);
    const absent = pid => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if (error.code !== 'ESRCH') throw error; return true; }
    };
    if (!owner.isAbsent() || !absent(wrapper.pid) || !absent(descendantPid)) throw new Error('Fixture tree remains unconfirmed');
    confirmed = true;
    console.log(JSON.stringify({ strictConfirmed: true, wrapperAbsent: true, descendantAbsent: true }));
  } finally {
    // Both fixture processes self-exit. On failure allow their full lifetime;
    // do not leave a live child merely because inventory/signalling was denied.
    if (!confirmed) await new Promise(done => setTimeout(done, 26000));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
```

Expected: exit0 and exactly `{"strictConfirmed":true,"wrapperAbsent":true,"descendantAbsent":true}`.
Unrelated processes started after the baseline can conservatively block confirmation; they must never be signalled.
Run this fixture on a quiet isolated runtime and record that limitation alongside the result.
After a failure, wait for the fixture self-exit interval and record the error; do not report confirmation.
Then repeat the installed scheduled-job limit check in section2 using the matching main/worker builds and record
that both the session and its controlled fixture child are gone.

Why pending: both the implementing child and parent command channel received OS `EPERM` launching `ps`;
parent preflight receipt is `_scratch/phasec-parent-process-inventory-preflight.json`. Current tests exercise
production handlers in real worker threads with synthetic OS primitives, plus platform parsing/refusal and
retained-ownership cases. They do not prove unrestricted live OS inventory or full live tree shutdown.
The inline probe was syntax-checked only here; it must run after integration in the runtime described above.

21 October resume: the read-only `ps` preflight again failed at process creation with
`PermissionError: [Errno 1] Operation not permitted`. No live process-tree fixture was started.
Current receipt: `2026-10-20-oct2-phaseC-queue-that-finishes_evidence/resume-20261021/os-preflight.json`.


## 5. Older fixture cleanup uncertainty

- [ ] In an unrestricted plain CLI on the host where these tests ran, use the OS inventory preflight from section4.
  The two failed fixture suites ran on 20 October 2026 at 23:18:58 UTC and 23:20:30 UTC. They spawned Node with the
  exact harmless argument `-e 'setInterval(() => {}, 1000)'`, detached, with ignored stdio. Their finally blocks
  received `kill EPERM`. Exact PIDs were not recorded. Evidence: `phasec-older-fixture-cleanup-uncertainty.json`
  in the retained evidence bundle; this is not evidence that a process is still alive or already gone.
- [ ] Include the reviewer8 lifecycle probe from 21 October 2026, 00:47:00–00:47:01 UTC. Its incomplete named-only
  process mock missed a default import; ACP was configured with the current Node executable and no explicit fixture
  arguments, so a bare Node child may have launched. Strict cleanup hit real `spawnSync ps EPERM`; no exact PID
  receipt exists. The final corrected probe is wholly synthetic. EOF or worker exit is not absence proof. Evidence:
  the retained `lifecycle-probe-receipt.json.attempt3`, raw log/results and the cleanup-uncertainty JSON.
- [ ] Inspect process birth time, executable and ancestry privately to identify any process belonging to those fixture
  runs. Retain only numeric identity/absence receipts, never unrelated command lines or environment values. A matching
  command string or numeric PID alone is insufficient authority to signal it. If ownership cannot be established,
  leave the candidate unsignalled and record that owner investigation remains required.
- [ ] For a candidate independently established as task-owned, stop it through the authorised host cleanup route and
  confirm the matching birth identity/group is absent. If none remains, record the inventory time and zero owned
  candidates. Do not label cleanup complete without current OS evidence.

Expected: no task-owned older fixture remains, with identity-safe absence evidence. Why pending: this agent channel
cannot execute OS inventory, and earlier fixture cleanup was refused. New fixture self-expiry does not establish
older fixture absence. This is an open runtime-cleanup item, not a code-completion claim or an instruction to alter
OS permissions, drive Terminal through Computer Use, or kill processes selected by command-name guesses.
