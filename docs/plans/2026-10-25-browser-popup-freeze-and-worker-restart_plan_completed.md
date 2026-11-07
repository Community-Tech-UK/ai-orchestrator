# A page pop-up must not freeze the browser link; a force-killed worker child must come back — Plan

Status: **implemented and verified in-loop** (2026-10-26); live checks deferred to
[2026-10-25-browser-popup-freeze-and-worker-restart_livetest.md](2026-10-25-browser-popup-freeze-and-worker-restart_livetest.md).

## What James reported

"When the worker on windows-pc downloads a new version of AIO, it always seems to die, or the browser
dies." Then, the same evening: the browser link was not working, and a screenshot of the windows-pc
Chrome showed a "Leave site?" pop-up open on the Meta Business Suite post editor.

## What the evidence says (collected 2026-10-25, read-only)

Evidence files: `_scratch/worker-update-1025/out/` (supervisor log, git state, task, launcher and
process listings from windows-pc; the full worker logs stay on the PC in
`%USERPROFILE%\.orchestrator\logs`) and the Mac `app.log*`.

1. **Updates restart the worker cleanly.** `worker-supervisor.log` has 8 update restarts since
   2026-10-14 (exit 75, back in ~0.5 s, extension first contact ~10 s later). None of the browser
   failures in the Mac log line up with an update restart.
2. **Tonight's browser failure was a pop-up.** From 22:32Z every command to windows-pc timed out while
   the extension kept polling ("polling without executing"). Restarting the worker relay
   (`browser.recover_extension`) did not help. At ~23:34Z James answered the "Leave site?" pop-up and
   the next live tab refresh worked at once, with the Meta tab moved off the editor. Cause proven.
3. **Why one pop-up stopped everything** (`resources/browser-extension/background.js`):
   - A Chrome "Leave site?"/alert pop-up blocks that page, so `chrome.scripting.executeScript` into it
     never settles.
   - `capturePageText` (tab inventory, tab reports, snapshot) calls `executeScript` with no time
     limit, inside `buildTabPayloadLocked`, which holds the shared `secretObservationBoundary`.
   - Every command calls `targetSecretTaintOrigin` (which waits on that same boundary) before its
     watchdog starts, so it waits for ever, never reports a result, and the serial `commandChain`
     stops. Polls keep flowing because reconnects reset `pollInFlight`, so the self-heal ladder
     (which only watches for missing poll acks) never fires.
4. **Separate restart gap, still open since 2026-10-14** (memory note, logs in `worker-agent.log.1`):
   a worker child force-killed at 16:25:49 left its single-instance lock behind; the supervisor's
   respawn 1 s later read the dead child's PID as alive (PID reuse/EPERM), printed "Another worker is
   already running", exited 0, and the supervisor took exit 0 as a deliberate stop. The node stayed
   down 37 minutes until a reboot.

## Changes (as built)

### A. A frozen page cannot hold the shared lock (extension)

- `capturePageText` races `executeScript` against a time limit and, on timeout, returns
  `textUnavailableReason: 'page_not_responding'` (same soft-fail shape as a refused injection).
  `buildTabPayloadLocked` treats it as unreadable (`inspection_unavailable`, real URL and title
  kept). Every other holder of `secretObservationBoundary` was already bounded (storage calls, the
  1.5 s frame probe, CDP deadlines).
- Rule: page work done while holding the lock is brief, and ends by the deadline of any command
  waiting on it. (Not counted: the existing protection probes before and after the read, up to
  1.5 s each and only on a profile with secret-protected sites, so a hold there can reach about
  3.5 s.) `buildTabPayloadLocked` gives the text read and the screenshot only the time left
  before the earlier of `pageWorkDeadlineAt` (an absolute deadline) and `maxPageWorkMs` counted from
  the moment it holds the lock (text read at most `PAGE_TEXT_CAPTURE_TIMEOUT_MS`, 15 s). Out of
  time, the screenshot is left out; it is also skipped when the text read got no answer, so the
  debugger never attaches to a frozen page. Callers:
  - commands that read the page (`snapshot`, `open_tab`, `navigate`, `http_auth_navigate`): the
    command's own watchdog deadline, passed from `runCommandWithWatchdog` into
    `executeBrowserCommand(command, deadlineAt)`;
  - the reload command's post-reload observation: the end of its own 5 s observation window;
  - work no command is waiting on (tab inventory and tab reports on their own 30 s schedule, the
    popup's Share): `maxPageWorkMs: BRIEF_PAGE_WORK_MS` (2 s). Counted from lock acquisition, so a
    read queued behind a frozen tab still gets its full 2 s.
- Why the rule (three completion review rounds): the gateway counts commands that time out three in
  a row as unanswered (`POST_DELIVERY_UNANSWERED_MIN`), classes the node `commands_unanswered`, and
  `ensureChannelReachable` then refuses every tab command for it until something answers. Round 1:
  a 15 s background read made short-budget commands to other tabs (`report_inventory` refresh 10 s,
  cached-fallback snapshot 1 s, probes 6 s) time out in a row. Round 2: the everyday `snapshot` is
  a 1 s probe; its watchdog gave up at 1 s but its abandoned read still held the lock for 15 s.
  Round 3: the popup's Share held the lock with no limit, and a background limit counted from
  queueing gave healthy tabs queued behind a frozen one 0 ms, reporting them `page_not_responding`.
  With the rule, an abandoned command's locked page work gets the 0 ms left. A 1 s probe that
  arrives during a 2 s background hold can still miss once (the gateway then serves its cached
  copy); a streak needs several frozen tabs read back to back.
- A tab whose last page-text read Chrome has not answered gets no new one (`unansweredPageReads`):
  its payload build still takes the lock but reports `page_not_responding` without sending a read
  or waiting, until the page answers the read it holds. A read with no time left (a command past
  its deadline) is not sent at all. Found by the fourth review: otherwise each 30 s inventory pass
  queued another read into the frozen page (about 120 an hour, all run back to back once the pop-up
  is answered) and held the lock for 2 s again. So after the first pass a frozen tab costs other
  commands almost nothing; on a profile with secret-protected sites each pass still spends up to
  1.5 s per frozen tab on the existing protection probe.
- If the protection recheck after a read cannot reach the page (on a profile with secret-protected
  sites, a pop-up that blocks the page mid-read makes that probe time out too), the payload is
  treated like a failed first check (`inspection_unavailable`, nothing from the page used) instead
  of rejecting. Found by the fifth review: the rejection aborted the whole inventory pass, healthy
  tabs included.
- The best-effort page extras a command does before and after its work (control glow install and
  removal, console/network capture install) now give up after `BEST_EFFORT_PAGE_SCRIPT_TIMEOUT_MS`
  (3 s, `runBestEffortPageScript`). Without this a snapshot of the frozen tab itself still spent its
  whole 30 s budget on the glow and ended as a bare timeout; now it answers `page_not_responding`
  within about 21 s, or in about 6 s (the glow install and removal waits) when an earlier read of
  that tab is still unanswered.
- Accepted: a healthy page that takes longer than 2 s to answer a background read (for example one
  still loading, since a script waits for the document) shows `inspection_unavailable` until that
  read settles, and a command reading it in that window gets `page_not_responding` at once; the
  next read after it settles goes ahead. Share's text and screenshot share one 2 s allowance, so a
  slow debugger attach can drop the screenshot.
- On a Chrome profile where a saved-login fill has marked any site as secret-protected (and
  protection is on), a read command on the frozen tab is refused earlier, after about 3 s, with
  `browser_secret_inspection_unavailable: command not run` (the existing 1.5 s frame probe in
  `assertSecretObservationAllowed` cannot reach the page). Also bounded; accepted.

### B. (dropped) Time limits on the pre-dispatch lock waits

Not needed once A bounds every lock holder; C covers anything unforeseen. Dropped to keep the change
small.

### C. Last-resort self-heal for a stuck queue (extension)

- The command chain records when the running command started and its own time limit.
  `selfHealIfWedged` (30 s alarm) reloads the extension when a command has run more than
  `STUCK_COMMAND_GRACE_MS` (2 min) past that limit, through `reloadExtensionRateLimited`, which the
  existing reload rung now shares (same storage key, at most once per 30 minutes).

### D. Say what is wrong (coordinator)

- `page_not_responding` joins `PAGE_TEXT_UNREADABLE_REASONS` (`browser-target-inspection.ts`), so
  the coordinator, relogin checks and target inspection treat it like the other unreadable reasons.
  Agents see the code in the snapshot result data.
- The `commands_unanswered` channel description now tells the reader to check that computer for a
  browser pop-up such as "Leave site?", which blocks the tab it is on (and every tab before extension
  0.2.44) until someone answers it. (A summary-text helper was tried and removed: result summaries
  go only to the audit log, never to the agent.)
- Accepted: commands aimed at the frozen tab itself (click, type, query_elements) still time out at
  their own watchdog, and three in a row still read as `commands_unanswered` until the next answered
  command (a `list_targets` refresh is not gated and answers in about 2 s per frozen tab).

### E. A force-killed worker child comes back (worker)

- `worker-supervisor.ts` passes the pid of the child it just saw exit to the next child
  (`AIO_WORKER_PREVIOUS_CHILD_PID`, `workerChildEnv`, `previousChildPidFromEnv`). `index.ts` hands it
  to `acquireSingleInstanceLock` as `exitedHolderPid`; a lock naming that pid is taken over even if
  the pid now looks alive.
- Takes effect only once the supervisor process itself runs the new code: an update restarts the
  child, not the supervisor, so windows-pc needs one logon, reboot or `restart-worker.bat` first.
- Not covered: a stale lock whose pid was reused after a reboot or a supervisor restart. The first
  child of a new supervisor has no previous pid, so that case still exits as a duplicate.

### F. Version

- Extension 0.2.43 → 0.2.44 and a new `BACKGROUND_BUNDLE_HISTORY` row.

## Tests

- `browser-extension-assets.spec.ts`: a page whose injection never settles no longer blocks inventory
  or a snapshot of another tab, and the inventory gives it 2 s (reproduced first: before the fix no
  result ever arrived); a snapshot of the frozen tab answers `page_not_responding` without its 30 s
  watchdog firing; a 1 s probe of the frozen tab that times out leaves its abandoned read 0 ms, so a
  probe of another tab is answered (fails if the snapshot's deadline is not passed through);
  `snapshot`, `navigate`, `open_tab` and `http_auth_navigate` each give their read the command's
  5 s, not 15 s; the reload's post-observation read gets its 5 s window; a screenshot that cannot
  finish in time is left out; no debugger attach to a page that did not answer the text read or
  when no time is left; Share and a tab report of the frozen tab get 2 s, not 15 s; no second read
  goes to a tab that has not answered the first, and the next read after it answers goes ahead; a
  background read queued behind a frozen tab still gets its full 2 s and reports the healthy tab
  readable; on a profile with a secret-protected site, a recheck that cannot reach the frozen page
  leaves that tab `inspection_unavailable` and the rest of the inventory intact, and a read whose
  recheck fails is not used at all (no text, title or URL from it); a text read that answers just
  after its allowance leaves no time for a screenshot; a finished command never counts as stuck.
  Each of these was checked to fail with its piece of the fix removed; the stuck-queue reload fires past limit + grace, respects the 30-minute rate
  limit, and does not fire inside a long command's own limit. Two existing timer assertions were
  scoped to the timers they are about: the absent-relay test ignores the startup inventory's 2 s
  limit, and the accessibility page-work floor test only looks at timers armed by its own call.
- `browser-target-inspection.spec.ts`, `browser-session-relogin.spec.ts`: new reason classified as
  unreadable.
- `single-instance-lock.spec.ts`, `worker-supervisor.spec.ts`: a lock naming the exited child is
  taken over even when that pid looks alive; any other live holder is still refused; each respawn is
  told the previous child's pid, through the real spawner's environment too; the env var is never
  inherited by accident.
- `worker-stale-lock.e2e.spec.ts` (slow tier, `npm run test:slow`): the real worker entrypoint,
  behind a lock naming a live non-worker process, takes it over and connects when the supervisor's
  variable names that pid, and still exits as a duplicate when it does not. Fails if `index.ts` does
  not pass the variable to the lock.
- `browser-extension-node-contact.spec.ts`: the new pop-up and refresh wording.

## Not in scope (reported to James instead)

- The deployed launcher on windows-pc is still the 2026-09-06 copy (with `git pull`); re-installing it
  needs an elevated PowerShell at the PC (Check 2 of `2026-10-14-worker-auto-update_livetest.md`).
- Updates wait until the worker is idle; open-but-idle sessions on the node count as busy.

## Status

- [x] A, C, D, E, F implemented (B dropped, see above)
- [x] Targeted tests; `tsc --noEmit`, `typecheck:spec`, `lint`, `lint:fast`, `check:ts-max-loc`,
      `check:ui-hints`, `build:main`, `build:renderer` all pass (2026-10-25)
- [x] Full suite (2026-10-26: 2791 files, 35 351 tests, all passing; the slow e2e spec passes on its
      own)
- [x] Fresh-eyes completion gate: round 7 `VERDICT: PASS`, no actionable findings (round 1: FAIL, background read limit too long; round 2: FAIL,
      abandoned command reads held the lock past their deadline, and the `commands_unanswered`
      wording; round 3: FAIL, Share unbounded, background limit counted from queueing, an
      overstated comment, and untested deadline paths; round 4: FAIL, three limits untested and a
      live-check outcome that depends on the profile; its note on reads piling up in a frozen page
      also fixed; round 5: FAIL, a failed after-read recheck aborted the inventory on protected
      profiles, untested worker wiring and wording, three overstated doc lines; round 6: FAIL, three
      tests that did not prove their rule, two doc lines — all fixed above)
- Live checks (need a push, windows-pc and James): see the
  [livetest](2026-10-25-browser-popup-freeze-and-worker-restart_livetest.md).
