# Remote runner fix: `spawned` pid=-1 Zod validation kills every remote instance (blocks Android on windows-pc)

**Status:** COMPLETED 2026-07-18 — Fix A/B/C implemented and all agent-runnable
gates green (targeted specs, `tsc`, spec `tsc`, lint, `check:ts-max-loc`, full
`test:quiet`). Live acceptance (§7 Live) deferred to
`2026-07-18-remote-runner-spawned-pid-validation_livetest.md` — needs a rebuilt/
restarted coordinator app + live windows-pc worker + real Android emulator.
As-built notes are inline below (see "As built").
**Date:** 2026-07-18
**Investigated by:** Claude (Fable), live-reproduced against windows-pc
**Implementer:** Opus session (this document is the work order)

---

## 1. TL;DR — reproduced root cause

Every `run_on_node` instance (any provider, any remote node) is destroyed by the
**coordinator**, not the worker. The worker spawns the CLI successfully; the
coordinator then kills its own record of the instance because of a Zod
validation throw, and — due to a second bug — never tells the worker to
terminate the now-orphaned CLI process.

Confirmed causal chain (every step verified by reading the executing code path
and/or live logs — citations below):

1. `RemoteCliAdapter.spawn()` succeeds over RPC, then emits
   `this.emit('spawned', -1)` — remote instances have no local pid, `-1` is the
   documented sentinel. `src/main/cli/adapters/remote-cli-adapter.ts:201`
   (comment at :158 "Returns -1 as PID since the process runs on a remote machine").
2. Since **WS1 (commit `e1d92c90`, 2026-07-13)**, the new file
   `src/main/instance/instance-communication-provider-events.ts:22-27` forwards
   the adapter's `spawned` event into the normalized provider-runtime event bus
   as `{ kind: 'spawned', pid: -1 }`. Before WS1 this event never reached the
   validated bus — that is why remote runs used to work and this is a
   regression, not a long-standing Windows problem.
3. The event bus delivers synchronously
   (`ProviderRuntimeEventBus.enqueue → emitNow`,
   `src/main/providers/provider-runtime-event-bus.ts`), reaching the forwarding
   listener `src/main/app/instance-event-forwarding.ts:192-194`:
   ```ts
   if (process.env['NODE_ENV'] !== 'production') {
     ProviderRuntimeEventEnvelopeSchema.parse(enrichedEnvelope);
   }
   ```
   The packaged app does **not** set `NODE_ENV=production` (no code in
   `src/main` sets it; verified by grep), so this "dev-only" strict parse runs
   in production too.
4. The schema requires a non-negative pid:
   `packages/contracts/src/schemas/provider-runtime-events.schemas.ts:135-138`
   ```ts
   const ProviderSpawnedEventSchema = z.object({
     kind: z.literal('spawned'),
     pid: z.number().int().nonnegative(),
   });
   ```
   → `ZodError: event.pid Too small: expected number to be >=0`.
5. Because the whole emit chain is synchronous, the ZodError propagates back
   **into** `RemoteCliAdapter.spawn()`'s own `catch` (remote-cli-adapter.ts:203-208),
   which sets `this.remoteInstanceId = null`, detaches registry listeners, and
   rethrows.
6. Background init catches it → `spawnTransaction.rollback()`
   (`src/main/instance/instance-lifecycle.ts:1966-1971`, log line
   "Instance background init failed"). The `instance-state` rollback deletes
   the instance from coordinator state (instance-lifecycle.ts:1249-1251) → all
   later `read_node_output` calls fail with **"Instance not found"**
   (lookup in `orchestrator-tools-step.ts` / throw in `orchestrator-tools.ts:673-676`).
7. The `adapter-registration` rollback (instance-lifecycle.ts:770-777) does call
   `adapter.terminate(false)` — but `RemoteCliAdapter.terminate()` early-returns
   when `remoteInstanceId` is null (remote-cli-adapter.ts:307-311), and step 5
   already nulled it. **The worker is never told to kill the child.** The CLI
   process stays alive on windows-pc, the worker's `instances` map keeps it, and
   the worker heartbeat (`worker-agent.ts:510`,
   `activeInstances = instanceManager.getInstanceCount()`) reports the leak.
   `terminate_node_instance { allIdle: true }` sweeps **coordinator** state,
   where the instance no longer exists → `{"terminated":[],"skipped":[]}`.

### Live reproduction evidence (2026-07-18, this session)

- `run_on_node` (node `windows-pc`, `requiresAndroid: true`, prompt "reply PONG")
  → `{"instanceId":"ini5qpxmn","status":"initializing"}`.
- Immediate `read_node_output` → **succeeded**: `status: "initializing"`, 0
  messages. (The instance is readable for the ~3s before background init dies —
  James's "immediately not found" is the same bug observed slightly later.)
- `read_node_output` with `waitMs: 45000` → `MCP error -32000: Instance not found: ini5qpxmn`.
- `terminate_node_instance allIdle` → `{"terminated":[],"skipped":[]}`.
- windows-pc `activeInstances` went **8 → 9** (leak; now 9/10 of capacity).
- Coordinator log `~/Library/Application Support/Harness/logs/app.log` lines
  10453-10476 for `ini5qpxmn`: registration, then
  `"Instance background init failed"` with the full ZodError
  (`path: ["event","pid"], "Too small: expected number to be >=0"`, stack through
  `instance-event-forwarding.js` → `provider-runtime-event-bus.js` →
  `RemoteCliAdapter.emit`), then — proof the worker-side CLI was healthy —
  `AutoTitle "Auto-titled instance (AI)" title:"PONG"` arriving *after* the
  rollback, from the still-streaming remote instance.

### Why "Windows failed while macOS worked"

Nothing Windows-specific. The distinction is **remote vs local**: local spawns
(Mac Android runs are local) emit a real non-negative pid; only
`RemoteCliAdapter` emits `-1`. Any remote node — Mac, Linux or Windows — fails
identically since WS1. windows-pc is simply the only connected worker. The
worker's Android/Windows code was audited during this investigation and is
already platform-correct (details §6).

---

## 2. Current live state on windows-pc (operational debt to clean up)

- `activeInstances` is 9/10; ~9 orphaned CLI processes (Claude/Codex/etc.) are
  running unattended on windows-pc, each spawned by a failed attempt. One is
  today's repro (`ini5qpxmn`, a Claude instance that answered PONG).
- These hold worker capacity slots. At 10/10 the node refuses further spawns
  ("Worker at capacity", `local-instance-manager.ts:227-229`).
- Cleanup is part of this plan's live verification phase (§7 step 0). Do **not**
  clean them up before implementing the fix — they are also the evidence that
  post-fix accounting returns to normal.

---

## 3. Fix design (smallest root-cause fix + two defense layers)

Three coordinator-side changes. **No worker-agent changes are required**, so no
redeploy of windows-pc's worker binary — only a coordinator app rebuild/restart.

### Fix A (root cause) — contracts: allow the remote pid sentinel

`packages/contracts/src/schemas/provider-runtime-events.schemas.ts:135-138`

```ts
const ProviderSpawnedEventSchema = z.object({
  kind: z.literal('spawned'),
  // -1 is the documented sentinel for remote instances (no local pid) —
  // see RemoteCliAdapter.spawn().
  pid: z.number().int().min(-1),
});
```

Check `packages/contracts/src/types/` for a mirrored TS type that documents pid
semantics and update its comment if present. Grep renderer/main consumers of
`kind === 'spawned'` for anything that treats pid as a real OS pid (e.g. passing
it to `process.kill`) — none is expected, but verify before relying on it.

### Fix B (defense) — validation must never kill the event path

Strict `.parse()` on a hot event path turns a schema mismatch into instance
death. Convert both throw sites to non-fatal `safeParse` + `logger.error`:

1. `src/main/app/instance-event-forwarding.ts:192-194`
2. `src/main/providers/provider-interface.ts:81-83` (same NODE_ENV-gated parse
   in `pushEvent`)

Keep the env gate if desired (it is effectively always-on anyway, see §1 step 3),
but on failure: log `eventId`, `instanceId`, `event.kind` and the Zod issues,
then **continue processing the event**. Do not add a new throw path. The
renderer-side validator already uses `safeParse`
(`src/main/event-bus/renderer-event-validation.ts:306`) — mirror its shape.

Optional micro-item, implementer's judgement: gate on `app.isPackaged` instead
of `NODE_ENV` so packaged builds skip the parse cost entirely. Behaviour, not
performance, is the point of this plan; skip if it drags in electron imports
awkwardly.

### Fix C (defense) — post-RPC failures must not orphan the remote child

`src/main/cli/adapters/remote-cli-adapter.ts:160-209`: the `catch` treats every
error as "spawn RPC failed" and nulls `remoteInstanceId`, which turns the later
rollback `terminate()` into a no-op. Narrow the failure window so only an RPC
failure resets the adapter:

```ts
let rpcSucceeded = false;
try {
  const response = await this.nodeConnection.sendRpc<SpawnResponse>(/* … */);
  rpcSucceeded = true;
  this.remoteInstanceId = response.instanceId;
  /* logger.info, markActivity */
} catch (err) {
  this.remoteInstanceId = null;
  this.detachRegistryListeners();
  throw err;
}
this.emit('spawned', -1);   // outside the try: a throwing listener no longer
return -1;                  // resets remoteInstanceId, so rollback's
                            // adapter.terminate() can still reach the worker
```

(Equivalent restructuring is fine; the invariant to preserve is: **once the
worker has acknowledged the spawn, `remoteInstanceId` stays set until
`terminate()` clears it**, so cleanup RPCs can always be sent.)

Note the rollback ordering in `addAdapterRollback`
(`instance-lifecycle.ts:770-777`) calls `removeAllListeners()` before
`adapter.terminate(false)` — with Fix C that terminate now actually sends the
`instance.terminate` RPC. Verify no listener removed there is needed by
`terminate()` itself (it isn't today — terminate only detaches registry
listeners and sends RPC).

---

## 4. Tests to add

Follow `docs/testing.md`; run singles with `npm run test:quiet -- <file>`.

1. **Contracts schema** — `packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts`:
   - accepts `{ kind: 'spawned', pid: -1 }` (remote sentinel) and `pid: 0`;
   - still rejects `pid: -2` and non-integers.
2. **Forwarding non-fatality** — `src/main/app/instance-event-forwarding.spec.ts`:
   - an envelope that fails schema validation is logged and still forwarded to
     renderer/trace/observer (assert `sendToRenderer` was called);
   - a listener registered on `provider:normalized-event` never receives a
     synchronous throw from validation.
3. **Provider interface non-fatality** — adjacent spec for
   `provider-interface.ts` `pushEvent`: invalid envelope does not throw, event
   still reaches `_events$` subscribers.
4. **RemoteCliAdapter** — spec beside `remote-cli-adapter.ts`:
   - RPC success + a **throwing `spawned` listener**: `remoteInstanceId` stays
     set; subsequent `terminate()` sends the `instance.terminate` RPC (assert on
     mocked `nodeConnection.sendRpc`);
   - RPC failure: `remoteInstanceId` nulled, listeners detached, error rethrown,
     `terminate()` after that is a no-op (current behaviour, keep it);
   - regression shape of the original bug: spawn → listener throws → rollback
     path calls `terminate(false)` → RPC **is** sent.
5. **Worker-side accounting** (tests only — no runtime change, no redeploy) —
   `src/worker-agent/__tests__/local-instance-manager.spec.ts` gaps found in
   this investigation:
   - adapter creation throws mid-spawn (after `pendingSpawns.add`, before
     `instances.set`): instance absent from map, `pendingSpawns` cleared,
     `getInstanceCount()` back to baseline, android lease released
     (`local-instance-manager.ts:396`);
   - `adapter.spawn()` rejection: same invariants;
   - `getInstance()` during the pending window returns undefined without
     corrupting accounting.
6. **Windows path coverage** (James asked for it explicitly; the code already
   exists and is believed correct — pin it): extend
   `src/worker-agent/android/android-detect.spec.ts` and/or
   `worker-emulator-manager.spec.ts` with win32-mocked cases:
   - SDK default root `%LOCALAPPDATA%\Android\Sdk` (`android-detect.ts:140-142`);
   - `adb.exe` / `emulator.exe` suffixing (`executableName()`,
     `android-detect.ts:161-163`; `worker-emulator-manager.ts:287,293`);
   - emulator args never include `-wipe-data`; cold-boot retry adds only
     `-no-snapshot-load` (`worker-emulator-manager.ts:192-199, 206-215`).

---

## 5. Out of scope (deliberately — record, don't do)

- **Worker orphan reconciliation on reconnect** (coordinator forgetting
  instances the worker still runs, and vice versa). Real gap, surfaced again by
  this bug, but a design piece of its own. If James wants it, new spec.
- **`allIdle` sweeping worker-side instances unknown to the coordinator.** Same
  reconciliation design space.
- **`run_on_node` returning before background init settles.** By design
  (async spawn); the failure-reporting gap is tolerable once init stops failing
  spuriously. Note: a failed init currently surfaces only in logs.
- The 12steps app's meeting-feed issue — explicitly untouched per instructions.

---

## 6. Android on windows-pc — no code fix expected

Full read of the Android path found it platform-aware and non-fatal
(`src/worker-agent/android/android-detect.ts`, `worker-emulator-manager.ts`,
`worker-android-manager.ts`, `local-instance-manager.ts:110-150,241-276`,
`src/main/browser-gateway/mobile-mcp-config.ts`):

- SDK default `%LOCALAPPDATA%\Android\Sdk` matches the node's reported
  `C:\Users\shutu\AppData\Local\Android\Sdk`; `.exe` suffixing, `windowsHide`,
  PATH separator, and PowerShell-based orphan checks are all in place.
- Emulator launch: `-avd <name> -port <even> -no-audio -no-boot-anim`
  (+`-no-window` when headless, +`-no-snapshot-load` only on cold-boot retry).
  **No `-wipe-data` anywhere** — sbe_test's data is safe.
- Boot: `adb wait-for-device` + 1s polling of `sys.boot_completed` until
  `bootTimeoutMs` (worker reports 180000).
- Android lease failure degrades (instance spawns without mobile-mcp tools,
  `local-instance-manager.ts:127-131`) — it cannot cause "Instance not found".
- mobile-mcp injection: `npx -y @mobilenext/mobile-mcp@<ver>` with
  `ANDROID_HOME/ANDROID_SDK_ROOT/ANDROID_SERIAL` env; Maestro/Appium disabled on
  this node by config, which only means those extra MCP servers aren't added.

The runner fix should therefore unblock the whole Android flow. If live testing
still finds an emulator problem (e.g. WHPX/graphics on the RTX 5090 box under
`-no-window`), that is a **new finding** → follow-up spec, not scope creep here.

---

## 7. Verification

### In-loop (before renaming this plan `_completed`)

1. Targeted new/changed specs, then the canonical gates:
   `npx tsc --noEmit` · `npx tsc --noEmit -p tsconfig.spec.json` ·
   `npm run lint` · `npm run check:ts-max-loc` · `npm run test:quiet`.
2. Confirm no worker-agent runtime source changed (`git diff --stat` touches
   only `src/main/`, `packages/contracts/`, and spec files) — this is what
   makes "no worker redeploy" true. If any worker runtime file changed, the
   claim is void: rebuild (`npm run build:worker-sea`) and redeploy windows-pc,
   and say so in the summary.

### Live (deferred)

The 12 live acceptance items plus orphan cleanup — all requiring the rebuilt,
restarted coordinator app, the live windows-pc worker, and a real Android
emulator — were moved to
[2026-07-18-remote-runner-spawned-pid-validation_livetest.md](2026-07-18-remote-runner-spawned-pid-validation_livetest.md).
Run that doc against the rebuilt app and rename it `_livetest_completed.md` when
every step passes with evidence.

---

## 8. Completion checklist for the implementer

- [x] Fix A/B/C implemented exactly or with documented equivalent
- [x] Tests of §4 added and green; full gate list of §7 green
- [x] Livetest doc created, deferred items moved there, plan renamed
      `_completed` **last**
- [x] Completion summary reports: root cause (§1), files changed, test results,
      Windows runtime evidence (deferred — livetest), Mac evidence (deferred —
      livetest), "worker redeploy: none" (§7.2 confirmed — only `.spec.ts` files
      changed under `src/worker-agent/`), remaining limitations (§5)
- [x] Plan and livetest doc remained uncommitted until `_completed`

## As built (2026-07-18)

**Fix A** — `packages/contracts/src/schemas/provider-runtime-events.schemas.ts`:
`ProviderSpawnedEventSchema.pid` relaxed from `nonnegative()` to `int().min(-1)`
so the remote `-1` sentinel validates. Mirrored the pid-semantics comment in
`packages/contracts/src/types/provider-runtime-events.ts`. Consumer grep found no
code that dereferences the spawned pid as a killable OS pid: the only renderer
consumer is `instance-events.service.ts` `spawnedEvents$` (a filter), and every
`process.kill` site uses a locally-owned pid, never a provider `spawned` event.

**Fix B** — non-fatal validation at both strict-parse sites:
`src/main/app/instance-event-forwarding.ts` and
`src/main/providers/provider-interface.ts` `pushEvent`. Both now `safeParse` and,
on failure, `logger.error(msg, undefined, { eventId, instanceId, kind, issues })`
then continue processing/emitting (mirrors `renderer-event-validation.ts`). Added
a `getLogger('BaseProvider')` to `provider-interface.ts` (it had none). The
`NODE_ENV` gate is retained.

**Fix C** — `src/main/cli/adapters/remote-cli-adapter.ts` `spawn()`: the
`emit('spawned', -1)` and `return -1` now sit **outside** the try/catch. Once the
worker acknowledges the spawn RPC, `remoteInstanceId` stays set even if a
`spawned` listener throws, so a rollback `terminate()` still sends the
`instance.terminate` RPC instead of no-opping and orphaning the remote child. The
catch still nulls `remoteInstanceId` only for a genuine RPC failure. Verified the
`addAdapterRollback` ordering (`instance-lifecycle.ts:770-777`,
`removeAllListeners()` then `terminate(false)`) is safe: `terminate()` uses
`detachRegistryListeners()` + `remoteInstanceId`, neither of which
`removeAllListeners()` clears.

**Tests (§4):** contracts schema (pid -1/0 accepted, -2/non-int rejected);
forwarding + base-provider non-fatality (schema-invalid envelope logged & still
forwarded/emitted); RemoteCliAdapter cleanup invariants (throwing `spawned`
listener keeps `remoteInstanceId` set → terminate sends RPC; RPC failure nulls &
no-ops; rollback shape); worker-side accounting (factory throw / spawn reject /
pending-window lookup all leave clean accounting + release the android lease);
Windows path coverage (`%LOCALAPPDATA%` SDK root + `adb.exe`/`emulator.exe`
suffixing; emulator args never include `-wipe-data`; cold-boot adds only
`-no-snapshot-load`).

**Worker redeploy: none.** `git diff --stat` shows the only `src/worker-agent/`
changes are `.spec.ts` files; all runtime changes are in `src/main/` and
`packages/contracts/`, satisfying §7.2.

## 9. Risks

- Fix B changes error visibility: schema violations now log instead of crash.
  Watch the log during livetest for unexpected new validation errors surfaced
  by formerly-fatal paths.
- Fix C reorders emit relative to the try/catch — keep the
  `attachRegistryListeners`-before-RPC invariant (comment at
  remote-cli-adapter.ts:168-170) intact.
- Relaxing pid to `min(-1)`: renderer consumers were not exhaustively audited —
  do the grep in Fix A before assuming no consumer dereferences pid as an OS pid.
