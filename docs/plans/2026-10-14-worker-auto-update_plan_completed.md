# Worker auto-update that moves every part together — Plan

Status: **implemented and verified in-loop** (2026-10-14); live rollout checks deferred to
[2026-10-14-worker-auto-update_livetest.md](2026-10-14-worker-auto-update_livetest.md). James chose this ("option 1") on 2026-10-14 after the diagnosis
below. It reverses the 2026-09-24 decision to make worker updates a manual step; see
`docs/plans/2026-09-22-worker-offline-resilience_livetest.md` (Check 1 there is superseded).

## Problem (verified on windows-pc, 2026-10-14)

1. The deployed launcher `%USERPROFILE%\.orchestrator\start-worker-autoupdate.bat` is the
   2026-09-06 copy. It runs `git pull --ff-only` on every 5-minute keep-alive fire. The repo
   template dropped the pull on 2026-09-24 but was never installed there.
2. Nothing rebuilds after a pull. `start-worker.bat` leaves a live worker alone, so
   `dist\worker-agent\.source-commit` was 4d175e55 (11 Oct) while HEAD was 941f349c (13 Oct).
   Restarting the worker child only respawns the same stale bundle.
3. Chrome loads the Harness extension **unpacked from the repo checkout**
   (`Secure Preferences` → `...\ai-orchestrator\resources\browser-extension`). A Chrome
   restart, or the extension's own self-heal `chrome.runtime.reload()`, loads the newest pulled
   extension code against the old worker build and native host. The Mac runs newer code still.

Result: after an update the three parts run different versions until James restarts the worker
and Chrome by hand.

## Goal

When new code lands on the PC's upstream branch, the PC applies it **as one unit**, without a
human: pull, rebuild, restart the worker when it is idle, then have the extension reload onto
the matching version. Never take the node down because of an update.

## Design

### A. Worker self-update (`src/worker-agent/worker-self-update.ts`, new)

Runs inside the worker child. Pure logic with injected git/build/clock/exit dependencies.

- **Enabled only when** the worker runs from a git checkout (`<repo>/.git`, `<repo>/build-worker-agent.ts`
  next to `dist/worker-agent/index.js`), is supervised (`AIO_WORKER_SUPERVISED=1`, set by the
  supervisor), and `autoUpdate.enabled` is not `false` in worker config. Default on.
- **Idle gate.** A 30 s sampler records the last time the worker was busy: any local instance,
  local-model session, terminal, CDP tunnel, in-flight coordinator request, or a browser
  command delivered/answered by the extension relay. An update may start only after 3 minutes
  continuously idle, and is re-checked immediately before the restart.
  Coordinator housekeeping (`node.ping` every 10 s, health checks, service status, the
  auxiliary inventory probe) is ignored, and short one-off requests (`fs.*`, `sync.*`,
  `auxiliaryModel.generate`, `audio.transcribe`, `config.update`) only block while in flight
  (`src/worker-agent/worker-activity.ts`). Found by the first completion review: counting pings
  meant a connected worker was never idle.
- **Check cadence.** Every 5 minutes (first check 2 minutes after start):
  1. `git fetch --quiet` (prompts disabled, 60 s timeout). Read `HEAD`, `@{u}`.
  2. Target = `@{u}` if HEAD is an ancestor of it and differs, else HEAD. Nothing to do when the
     target equals the commit the running bundle was built from (`.source-commit` read at
     startup) and HEAD == target.
  3. Skip a target that already failed (remembered in memory, and in
     `dist/worker-agent/.auto-update-failed` so a restart does not retry it in a loop).
  4. `git merge --ff-only <target>` when HEAD moved.
  5. Build into a temporary bundle (`AIO_WORKER_BUILD_OUTFILE=dist/worker-agent/index.next.js`)
     with `node node_modules/tsx/dist/cli.mjs build-worker-agent.ts` (no npx/cmd shims).
  6. Smoke test: `node index.next.js --self-check [--config <path>]` must exit 0 (loads the full
     module graph and checks the config file still parses; read-only, so it is not the full
     config loader, which writes the file back).
  7. On any failure in 4–6, or in the file swap of step 8: `git reset --keep <pre-update HEAD>`
     if the checkout moved, delete the temp bundle, put the previous bundle back if the rename
     had happened, record the failed target, report `blocked` with the reason. The running worker
     is never touched. The record carries `retryAfter` (2 hours) because these failures can be
     transient; a startup crash recorded by the supervisor has none and waits for upstream to
     move. Deleting `.auto-update-failed` and restarting the worker retries at once (the file is read
     at startup). `returnCheckoutToRunningBuild` never
     rewinds a commit upstream does not hold.
  - The restart allows 30 s for a clean shutdown, then exits 75 regardless (second review).
  - git runs with `GIT_TERMINAL_PROMPT=0`; `GIT_SSH_COMMAND=ssh -o BatchMode=yes` is added only
    when neither the environment nor `core.sshCommand` chose an ssh command.
  - Known, accepted: the candidate build also rebuilds `dist/worker-tools/axe-audit.mjs` in place
    (a separate agent tool, not the worker), and it is not rolled back on a failed self-check.
  8. Success: keep the old bundle as `index.prev.js`, rename the new one into place, write
     `.source-commit`, then (if still idle) disconnect cleanly and exit with code 75. If work
     arrived during the build, report `restart_pending` and restart at the next idle check.
- **Dependencies.** No automatic `npm install`: on Windows it can fail on native modules the
  running worker holds open and leave `node_modules` broken. If the build fails because a
  dependency is missing, step 7 rolls back and the status says so.
- **Status** is added to the heartbeat as `workerAgent.buildCommit` and `workerAgent.autoUpdate`
  (`state`, `reason`, `targetCommit`, `lastCheckedAt`), so `list_remote_nodes` shows it.

### B. Supervisor (`src/worker-agent/worker-supervisor.ts`)

- Sets `AIO_WORKER_SUPERVISED=1` for each child.
- Exit code 75 = "restart for update": respawn after a short fixed delay, not counted as a rapid
  failure. Older supervisors already respawn any non-zero exit after about a second.
- If the first child after an update exits before it was stable, put `index.prev.js` and the
  previous `.source-commit` back (`restorePreviousWorkerBundle`), record the new commit in
  `.auto-update-failed`, and respawn. A bad update can no longer burn the rapid-failure budget
  and leave the node offline. The restored worker then returns the checkout to its own commit
  once (so the extension files Chrome reads match again).
- The same restore applies when a child dies rapidly on a bundle other than the last one that
  ran stably (size + mtime fingerprint at spawn): the updater can swap a new bundle in while the
  worker is busy, and an unrelated crash then respawns onto it with no exit-75 restart (fourth
  review). Rollback also refuses to rewind a HEAD someone moved by hand during the update, and
  an existing `GIT_SSH` is respected like `GIT_SSH_COMMAND`.
- Restore only happens while the bundle on disk is still the one an update swapped in
  (`.source-commit.swapped` equals `.source-commit`), so a later manual rebuild with an old
  `index.prev.js` lying around is never replaced (fifth review).
- Restore steps are fenced individually with the failure recorded first (seventh review), and
  the supervisor keeps retrying a refused restore on each rapid failure until one succeeds or a
  child runs stably (eighth review).

### C. Build and entrypoint

- `build-worker-agent.ts`: honour `AIO_WORKER_BUILD_OUTFILE`; define
  `process.env.AIO_WORKER_EXTENSION_VERSION` from `resources/browser-extension/manifest.json`.
- `src/worker-agent/index.ts`: `--self-check` loads config and exits 0 before any side effects.

### D. Extension follows the worker

- The worker relay adds `expectedExtensionVersion` (its build-time extension version) as a
  top-level field of its JSON-RPC reply to `browser.extension_poll_command`. Old native hosts
  ignore it.
- The native host copies that field onto the `browser_command` message it sends to the extension.
  On the Mac (Electron build) the define is absent, so nothing is sent and nothing changes.
- `background.js`: on an idle poll reply (`command: null`) that carries a valid
  `expectedExtensionVersion` different from `chrome.runtime.getManifest().version`, with no
  command executing and secret recovery not running, and the extension installed unpacked
  (`chrome.management.getSelf().installType === 'development'`): record `{target, at}` in
  `chrome.storage.local` and call `chrome.runtime.reload()`. At most one reload per target
  version per 6 hours, so a folder that does not hold that version cannot loop.
- **Stale native host.** Chrome keeps each native host process alive across a worker restart,
  so after an update it still runs the old bundle. `build-worker-agent.ts` defines a unique
  `AIO_WORKER_BUILD_ID` per build; the relay sends it as `workerBuildId`; a native host whose
  own id differs adds `nativeHostStale: true`; the extension then reconnects just that bridge
  (Chrome starts a fresh host from disk), at most once per build id per 10 minutes. A full
  extension reload, when also due, takes precedence. Found in review: 1 of 5 native-host
  changes since July shipped without an extension change, so version-follow alone missed it.
- Manifest version bump and a new `BACKGROUND_BUNDLE_HISTORY` row.

### E. Windows scripts and docs

- `start-worker.bat`: end the long-lived `node` line with `& exit /b`. cmd re-reads a batch file
  by byte offset after each command, and the updater now rewrites this file underneath the
  running cmd; without this, cmd resumes at a stale offset when the supervisor ever exits.
- `docs/WORKER_AGENT_SETUP.md`: replace "Updating a running worker deliberately" with the
  automatic flow, the status fields, how to turn it off (`"autoUpdate": { "enabled": false }`),
  and rollback (`index.prev.js`).
- Mark Check 1 of the 2026-09-22 livetest superseded.

## Tests

- `worker-self-update.spec.ts`: disabled when not a checkout/not supervised/config off; waits
  for 3 min quiet; busy at restart time → `restart_pending`; fast-forward + build + smoke +
  swap + exit 75 order; build failure / smoke failure / merge failure → rollback, no swap, no
  exit, target remembered; launcher-pulled checkout (HEAD ahead of build, upstream == HEAD)
  rebuilds; up-to-date → no build; diverged upstream → blocked.
- `worker-supervisor.spec.ts`: exit 75 respawns without counting a rapid failure; env var set.
- Relay spec: poll reply carries `expectedExtensionVersion` when defined.
- Native host spec: `browser_command` carries the field when the relay sent it, omits it
  otherwise.
- `browser-extension-assets.spec.ts`: reload on mismatch when idle; no reload when equal, when a
  command is running, when not unpacked, or inside the per-target 6 h window; hash row.

## Rollout

Deferred: see [2026-10-14-worker-auto-update_livetest.md](2026-10-14-worker-auto-update_livetest.md)
(needs a push, the live worker and Chrome on windows-pc, and James).

## Windows harness evidence (windows-pc, 2026-10-14 11:43-11:44 local)

Isolated run in `%USERPROFILE%\.orchestrator\_scratch\aio-update-harness`: a shared clone of the
live checkout at 941f349c plus this change, a private bare "upstream", `node_modules` junctioned
read-only (junction removed afterwards; live `node_modules` confirmed intact). Real git, node,
esbuild and file renames on Windows; output in `_scratch/worker-update-diag/harness/result2.txt`.

| Step | Result |
| --- | --- |
| Up to date | `idle`, no build |
| Upstream C2 | ff-merge, build into `index.next.js`, `--self-check` exit 0, swap; stamp C2, `.prev` C1, restart requested (1.1 s) |
| Broken C3 (syntax error) | build failed; checkout back at C2; live bundle still C2; `.auto-update-failed` C3 with `retryAfter` |
| Next check | `blocked`, "retrying after ..." , no rebuild |
| Supervisor restore | bundle back to C1, stamp C1, C2 recorded as startup failure, `index.prev.js` removed |
| Batch, CRLF | stale cmd resumed into the rewritten file ran ` exit /b`: no stray lines, caller saw errorlevel 7 |
| Batch, LF | stale cmd stopped at `& exit /b` (exit 255, caller aborted too): no stray lines |
| Batch fresh run | `& exit /b` keeps node's exit code (errorlevel 7) |

Built bundle carried `BUILD_EXTENSION_VERSION = "0.2.40"` and one `BUILD_ID` shared by relay and
native host. This ran before the seventh-review change that fences each restore step
individually; that change is covered by unit tests only.

## Status

- [x] A–E implemented, plus the review-driven hardening recorded above
- [x] Targeted tests; `tsc --noEmit`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `build:main`,
      `build:renderer`; full suite 2427 files / 31448 tests passing (2026-10-14)
- [x] Isolated Windows harness on windows-pc (section above)
- [x] Fresh-eyes completion gate: ten independent rounds; round 10 `VERDICT: PASS` with no
      actionable findings
- [x] Live test doc written for the rollout checks
