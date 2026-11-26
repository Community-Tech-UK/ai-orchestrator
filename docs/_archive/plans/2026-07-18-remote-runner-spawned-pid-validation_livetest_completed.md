# Live test: remote runner `spawned` pid=-1 fix (Android on windows-pc)

**Prerequisites:** a **rebuilt and restarted** coordinator Harness app (the fix is
coordinator-side only — Fix A/B/C touch `src/main/` and `packages/contracts/`; no
worker-agent runtime file changed, so **windows-pc's worker binary does not need a
redeploy**). windows-pc must be a connected worker node with the Android SDK at
`C:\Users\shutu\AppData\Local\Android\Sdk` and the `sbe_test` AVD available.

Back to the plan: [2026-07-18-remote-runner-spawned-pid-validation_plan_completed.md](2026-07-18-remote-runner-spawned-pid-validation_plan_completed.md)

Why deferred: every item below requires the rebuilt/restarted coordinator app,
a live remote worker (windows-pc), and/or a real Android emulator — none of which
can be exercised by unit/integration tests or the CLI in-loop. All agent-runnable
gates (targeted specs, `tsc`, spec `tsc`, lint, `check:ts-max-loc`, full
`test:quiet`) already passed in-loop before the plan was renamed `_completed`.

Rename this file to `_livetest_completed.md` only after every step below passes
with recorded evidence.

---

## Step 0 — Orphan cleanup first (record baseline)

windows-pc entered this work at `activeInstances` ~9/10 from pre-fix failed spawns
(orphaned CLI child processes the coordinator forgot). Clean these up **after** the
rebuilt app is running, so the pre-fix leak count is preserved as evidence first.

- List stray CLI processes on windows-pc. Prefer a worker restart if worker
  shutdown terminates child instances — first verify the supervise/shutdown path in
  `src/worker-agent/index.ts` actually kills children; otherwise fall back to a
  remote PowerShell sweep of orphaned `claude`/`codex`/`node` CLI processes.
- **Expected:** `activeInstances` on windows-pc returns to 0 (or its true idle
  baseline). Record the before/after counts.

## Step 1 — Spawn a remote Android instance

- `run_on_node` on `windows-pc` with `requiresAndroid: true`, a trivial prompt
  (e.g. "reply PONG").
- **Expected:** `{ instanceId, status: "initializing" }`, and the instance is NOT
  destroyed a few seconds later.

## Step 2 — read_node_output survives past background init (the regression probe)

- `read_node_output` during `initializing`, then again with `waitMs: 45000`.
- **Expected:** both succeed. Pre-fix, the `+45s` call failed with
  `MCP error -32000: Instance not found`. This is the direct regression probe.

## Step 3 — Agent boots `sbe_test` via injected tools

- **Expected:** emulator launches with no `-wipe-data` flag (sbe_test data safe).

## Step 4 — `adb devices` lists the emulator
## Step 5 — `sys.boot_completed` = 1
## Step 6 — Report device model, API level, emulator serial
## Step 7 — Injected Android tools: screenshot + UI hierarchy

## Step 8 — 12steps app (if installed)

- Launch it, report package/version. **Do not** touch its meeting-feed issue.

## Step 9 — Terminate the instance normally

- **Expected:** in the fresh coordinator log, `Remote instance terminated` appears.

## Step 10 — `activeInstances` returns to its pre-run value

## Step 11 — `allIdle` removes a completed idle instance

- Spawn a trivial second remote instance, let it finish (idle, not terminated),
  then `terminate_node_instance { allIdle: true }`.
- **Expected:** the idle instance is swept (`terminated` non-empty).

## Step 12 — Mac regression smoke

- One local Android run on the Mac (boot an AVD or use a connected device,
  screenshot via mobile-mcp) — proves no regression.
- One **local** provider spawn confirming `spawned` events with a real
  non-negative pid still flow (schema `min(-1)` is a superset — trivially green).

## Log assertions (throughout)

- In the fresh coordinator log: **no** `ZodError` for `event.pid`.
- `Remote instance terminated` appears when Step 9 runs.

---

## Evidence

Steps 0–9 were driven 2026-07-23; steps 7 and 10–12 plus the log assertions were completed
2026-07-24 against the running production app (build packaged 00:56 2026-07-24) and the live
`windows-pc` worker.

### Steps 0–6, 9 (2026-07-23)

- **Step 0.** Baseline recorded; `activeInstances` on windows-pc cleaned back to its idle value.
- **Step 1.** `run_on_node` (requiresAndroid) → instance `ias7uow5t`, `initializing` → `idle`, NOT
  destroyed.
- **Step 2 — the regression probe.** `read_node_output` at **+40 s, +45 s and +60 s** all
  succeeded; no `MCP error -32000: Instance not found`. The pre-fix failure mode does not
  reproduce.
- **Steps 3–6.** `sbe_test` booted with no `-wipe-data`; node telemetry went from
  `emulatorRunning: false, connectedDevices: []` to `emulator-5554`, `state: device`,
  model `sdk gphone64 x86 64`, `apiLevel 36`.
- **Step 9.** Terminate acked (`terminated: [ias7uow5t]`).

### Step 7 — injected Android tools: screenshot + UI hierarchy — PASS (2026-07-24)

Because `read_node_output` surfaces no assistant text for remote Android agents (see the finding
below), this was evidenced from the **artefacts themselves**. The remote agent was asked to write
its output into the `scratch` transfer root; all three files appeared with fresh mtimes and were
pulled back over the file-transfer channel with SHA-256 verification:

- `aio-lt-step7-screenshot.png` — **1,371,434 bytes**, verified locally as
  `PNG image data, 1080 x 2400, 8-bit/color RGBA, non-interlaced`
  (sha256 `4dc70edc…0277`).
- `aio-lt-step7-ui.txt` — 13,201 bytes, uiautomator XML hierarchy.
- `aio-lt-step7-report.txt` (sha256 `a2305e4b…b996`):
  `emulator-5554` · `sdk_gphone64_x86_64` · API 36 (Android 16) · screenshot 1080×2400 ·
  **32 `<node>` elements** · Pixel launcher home screen
  (`com.google.android.apps.nexuslauncher`) · captured via `adb exec-out screencap -p` and
  `adb shell uiautomator dump`.

Local copies kept at `_scratch/aio-lt-step7-{report.txt,screenshot.png}`.

### Step 8 — 12steps app — PASS (installed)

`com.twelvesteps.app versionName=1.0`. Launched via
`adb shell monkey -p com.twelvesteps.app -c android.intent.category.LAUNCHER 1`, confirmed
foreground —
`topResumedActivity=ActivityRecord{27896670 u0 com.twelvesteps.app/.MainActivity t93}` — then
`KEYCODE_HOME`. No sign-in, no taps, no app data touched; the meeting-feed issue was left alone.

### Step 10 — `activeInstances` returns to its pre-run value — PASS

`list_remote_nodes` at the start of the 2026-07-24 session reported windows-pc
`activeInstances: 0` — the counter had converged to its true idle baseline, resolving the
2026-07-23 open question ("still 1 on immediate re-poll; recheck").

### Step 11 — `allIdle` sweep — PASS

Spawned a trivial second remote instance (`iedx2dhq4`, one-line reply, no tools); it reached
`status: idle, done: true`. `terminate_node_instance { allIdle: true, node: "windows-pc" }` →
`{"terminated":[{"instanceId":"iedx2dhq4"}],"skipped":[]}` — non-empty, as required.

**Counter behaviour characterised:** `activeInstances` read `0` → (spawn) `1` → (sweep ack) **still
`1`** → **`0` after ~60 s**. So the 2026-07-23 observation is **lag, not a leak** — the counter
converges on the next heartbeat cycle rather than updating synchronously with the terminate ack.

### Step 12 — Mac regression smoke — PASS (both halves)

*Local Android:* AVD `Medium_Phone_API_36.1` booted headless on the Mac
(`-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`) and reached
`sys.boot_completed=1` in **15 s**; `adb devices` → `emulator-5554  device`; model
`sdk_gphone64_arm64`, API 36. `adb exec-out screencap -p` produced a valid
`PNG image data, 1080 x 2400` (1,380,146 bytes) and `uiautomator dump` returned a well-formed
hierarchy rooted at `com.google.android.apps.nexuslauncher`. Emulator shut down afterwards
(`adb emu kill`, 0 emulator processes remaining).

*Local provider spawn:* local `CLI spawned successfully` events carry real non-negative pids —
e.g. `{"pid":71731,"instanceId":"cashdazsd"}`, `{"pid":72261,…}`, `{"pid":81231,…}`,
`{"pid":8434,…}`, `{"pid":44022,…}`. A further ~8 local instances were spawned during this
session's other livetests with no pid failures.

### Log assertions — PASS

- **No `ZodError` for `event.pid`.** Zero `ZodError` lines of any kind across the entire
  `~/Library/Application Support/harness/logs/app.log` (5.7 MB, multi-day) and the dev-app stdout
  log. Note that this `app.log` is written by **both** the packaged and the dev app (see finding 5),
  so the negative covers both — it is not a prod-only sample.
- **`Remote instance terminated` appears for Step 9.** Six occurrences from `RemoteCliAdapter`,
  including this session's sweep:
  `{"timestamp":1784857619410,…,"message":"Remote instance terminated","data":{"nodeId":"bb62e3ee-…","instanceId":"1819ed41-…"}}`.

### Findings (not step failures — raised for follow-up)

1. **`read_node_output` surfaces no assistant output for remote agents.** Now demonstrated
   conclusively: during Step 7 the agent worked for ~70 s and produced 1.4 MB of artefacts, while
   `read_node_output` returned `status: idle, done: true, messageCount: 2` containing only the
   echoed user prompt and a provider rate-limit notice — no assistant text and no tool calls. This
   happened on all four remote instances spawned today. A working remote agent is
   indistinguishable from a stuck one without inspecting the node's filesystem.
2. **`activeInstances` lags a terminate ack by roughly one heartbeat** (see Step 11). Benign, but
   it makes an immediate post-terminate poll misleading.
3. **A terminated agent leaves its emulator running.** `emulator-5554` was still up on windows-pc
   from the 2026-07-23 run at the start of this session (`emulatorRunning: true`). Nothing tears
   down resources an agent spawned.
4. **`list_node_files` does not accept a root id as `path`.** `path: "scratch"` fails with
   `path_outside_allowed_roots`, despite `scratch` being the advertised `rootId` and the tool
   description naming those roots; the absolute path works. Same family as the confirmed
   `sync_to_node`/`sync_from_node` root bug in the worker-file-movement livetest.
5. **The dev app writes its `app.log` into the *production* profile.** `harness-dev/logs/` contains
   `lifecycle.ndjson`, `shutdown.ndjson` and `traces.ndjson` but **no `app.log`**, while
   `harness/logs/app.log` contains dev-only fixture strings from this session
   (`aio-lt-ws5-does-not-exist` ×85, `AIO-LT WS5` ×18, `aio-lt-wb2` ×14, `aio-lt-ws12-enf` ×4).
   Cause: `Logger` resolves `baseDir` from `app.getPath('userData')` at construction
   (`src/main/logging/logger.ts:337-346`), and the singleton is built during module import — the
   `app.setPath('userData', …)` that selects `harness-dev` runs later, at `src/main/index.ts:57`.
   So anyone reading the packaged app's `app.log` to diagnose production is reading a file both
   apps append to.

### Cleanup

All remote instances terminated (`allIdle` sweeps returned `iedx2dhq4`, `i6p0pm9m0`,
`itawfksl2`, `ip6zr0jp3`); `activeInstances` back to 0. The local Mac emulator was shut down.
Left on windows-pc: the `aio-lt-step7-*` / `aio-lt-step8-*` artefacts in the `scratch` transfer
root (kept deliberately as evidence — safe to delete), and `emulator-5554`, which was already
running before this session per finding 3.
