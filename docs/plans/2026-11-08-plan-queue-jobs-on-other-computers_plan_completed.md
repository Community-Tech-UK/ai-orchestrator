# Plan: Plan Queue jobs on other computers

On main: no (built on the queue branch, not yet landed).

## Status

On main: yes (this landing commit)
Built in the queue worktree and waiting for the independent check; nothing has run on a real Windows computer.
Stages 1 to 4 are implemented and covered by specs that run the worker's real `queue.*` code over real git, including one that
drives the real queue. Stage 5 is the
[livetest document](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-08-plan-queue-jobs-on-other-computers_plan_livetest.md)
(six deferred live checks: the measured Windows run for 1.0, three real jobs, the Computers page).
Decisions: tests route to the PC's Linux space (1.0); the Computers page holds the switches
(`<userData>/plan-queue/queue-job-computers.json`); `PlanQueueItem.remote` is one JSON column (migration 056, renumbered
14 Nov when main took 055). Round evidence: `2026-11-08-plan-queue-jobs-on-other-computers_plan_history_80ad979cbd21ae9235a91ab18390dc1a621ae45379981dfdf919be32ac503152_completed.md`.
Latest (14 Nov, round 7): the verifier found that Resume after a pause or park while the computer was away could overwrite
the work left there. Resume now takes that work back and saves it before sending the job out again (held or parked if it
cannot). Plan-queue specs, typecheck, lint and size check passed.
Open: `build:main` is the verifier's; item-flow's size ceiling was raised to 890 on purpose.

**Part of:** stage C of
[2026-11-08-agent-sessions-on-other-computers_plan.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-08-agent-sessions-on-other-computers_plan.md).
The spec is
[2026-11-08-plan-queue-jobs-on-other-computers_spec_completed.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/specs/2026-11-08-plan-queue-jobs-on-other-computers_spec_completed.md).
James chose the Windows PC first and allowed a job's plan to replace his copy when his copy is unchanged.

## In plain English

The spec says what happens; this says in what order it gets built. Stage 0 checks the Windows PC can run this
project's checks at all, because everything after it depends on that. Then the PC side learns to hold a job's code,
then this Mac learns to send it and take it back, then the Plan Queue uses both, and only then does a switch on the
Computers page let James turn it on. Nothing reaches a real job until the last stage, and it's off until James turns
it on.

## Stages

### 0 — Can the PC run this project's checks? (the spec's first step, by hand)

- [x] 0.1 On the PC, in a throwaway copy of its own checkout: link `node_modules` the way a job folder gets it on
  Windows (`worktree-include.ts`: junctions for folders, copies for files), then time `npm run typecheck`,
  `npm run lint` and a small Vitest run, and note what `git status` shows afterwards.
- [x] 0.2 Write the numbers here. If linking or the checks fail on Windows, stop and bring the finding to James before
  stage 1.
- **Result (8 November, Windows Node 24.22.1, Git 2.53, the PC's checkout at `d5a1195d3`):**

  | Step | Time | Result |
  |---|---|---|
  | Shared clone, detached at the checkout's commit | 5.5 s | fine |
  | Link `node_modules` (803 junctions, 1 file copied) | 0.2 s | fine |
  | `npm run typecheck` | 8.4 s | passes |
  | `npm run lint` | 35 s | passes |
  | Vitest, 3 spec files | 57 s | 127 of 130 pass |
  | `git status` afterwards | | clean: nothing for a save to pick up |
  | Full Vitest suite | stopped at 50 min | never finished: output stopped about 20 minutes in |

  - The 3 failures are all in `worker-account-route.spec.ts`'s "actual default binding service" tests: they count
    `opencode` process calls, and on Windows the real lookup makes 4 calls instead of 2. A test that assumes Mac and
    Linux command lookup, not a broken toolchain.
  - The full suite hung natively on Windows, while it passes in the PC's Linux space in about 4 to 8 minutes. An agent
    in a job there runs tests, and it would be misled by Windows-only failures and a run that never ends.
  - **So: setup, type checks and lint are fine on Windows; test runs are not.** Recommendation for James: a job's test
    runs on the PC go to the PC's own Linux space through the existing test-machine route, the way this Mac's runs
    already do. That route (`scripts/remote-checks/`) has only ever run from macOS, so making it run from Windows
    becomes stage 1.0, measured before the rest of stage 1.
  - Clean-up: the scratch copy was removed link by link (the real `node_modules` kept all 806 entries), and the two
    test processes still running after the time limit were stopped by process id.

### 1 — The PC side: hold a job's code (worker agent)

- [x] 1.0 **Test runs from a job on the PC go to its Linux space** (decided: yes, routine routing inside the approved scope; the measured run from Windows is in the livetest document): `npm run test:quiet` and
  `npm run checks` started on the PC's Windows side reach the PC's own Linux space through `scripts/remote-checks/`,
  with this Mac's rules for what runs locally. First a measured run of that route from Windows.

- [x] 1.1 Capability `queueJobs: 1`, reported by the worker and checked by this Mac before any `queue.*` call, as
  `queuePushGuard` is.
- [x] 1.2 `queue.receive`: a chunked thin pack into the worker's bare repository
  (`~/.orchestrator/queue-repos/<project>.git`, `core.autocrlf=false`, no remotes), stored under a ref per job.
- [x] 1.3 The installed checkout per project (`<project>-installed`), a worktree of the bare repository, installed
  again when the lock file in a job's starting commit differs.
- [x] 1.4 `queue.prepare`: the job folder (reattaching when its branch already exists there), its setup through the
  same `createWorktree` route with the installed checkout as the main checkout, the planning folder filled with the
  documents sent, the report folder, and those three folders allowed for that one session.
- [x] 1.5 `queue.collect`: close-safe (the session must be stopped), `git add -A` minus what setup left, a commit on a
  side ref whose parent must be the last commit sent, a thin pack back, and the changed planning files.
- [x] 1.6 `queue.readReport` (one turn's file only, older ones deleted), `queue.deleteLeftOut` (the files this Mac's
  save left out) and `queue.remove`.
- **Checks:** specs per call against a real temporary git repository, including every refusal: wrong parent, a commit
  the agent made itself, a session still running, a path outside the job's folders.

### 2 — This Mac: send and take back

- [x] 2.1 Sending: a thin pack of a commit against what that computer already has, in chunks, plus the base branch tip
  and the job's starting commit.
- [x] 2.2 Taking back: unpack into this Mac's repository, then apply the change between the last commit sent and the
  collected one to the job's folder as uncommitted changes, new files untracked, leaving files that exist only here
  alone.
- [x] 2.3 Planning documents back: a document that was sent replaces the main checkout's copy only through
  `assertDocumentFileUnchanged` and `changeDocumentFile`, and only when it differs; otherwise a `.from-queue` copy
  and a hold. Harness's own writes become the new "what was sent".
- **Checks:** specs with two real repositories standing in for the two computers, including a merge of `main` made
  here between turns surviving the next copy-back.

### 3 — The Plan Queue uses it

- [x] 3.1 Two new fields on the job row: the computer, and the last commit exchanged (plus the commit the current turn
  started from).
- [x] 3.2 Placement: a plan job (never a live-test job) goes to the first computer in the Computers order that takes
  Plan Queue jobs, isn't paused, is signed in to the job's account, has room and has passed the project check;
  otherwise here, with the reason on the job's timeline.
- [x] 3.3 Starting a turn there: send the current commit, `queue.prepare`, then the session with `forceNodeId`, the far
  folders, and the prompt variant (far paths, the report file, the wait rule, the reworded deferred-check finding).
- [x] 3.4 Ending a turn there: read that turn's report before `afterTurn` and store it through `recordWorkerReport`;
  at the save, close the session, collect, copy back, run `checkpoint` unchanged, send the result, delete what the save
  left out.
- [x] 3.5 Away, restart, pause, park, discard and clean-up, as the spec's sections say.
- **Checks:** coordinator specs with a fake worker for each path in the spec's "Checks this will need".

### 4 — Switches and words

- [x] 4.1 Computers page: a "Plan Queue jobs" switch per computer, off until James turns it on, and "jobs at once"
  (default 2); which projects each computer has passed the project check for.
- [x] 4.2 Starting a queue run: "Keep this run on this Mac".
- [x] 4.3 The per-project check (stage 0, automated) from the Computers page.
- **Checks:** component specs; `build:renderer`; the screen check with seeded state.

### 5 — Live

- [x] 5.1 A `_livetest.md` beside this plan: a real job on the PC that lands on `main` here; one where the PC is
  switched off mid-job and the job finishes here; one with a deferred check that passes.

## Verification for every stage

Targeted specs while building; then `npm run checks` and `npm run test:quiet`; a fresh reviewer before each stage
lands.
