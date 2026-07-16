# Seamless provider/model swap for existing sessions — implementation plan (reconciler-first)

**Date:** 2026-07-16 (reshaped same day after architecture discussion)
**Status:** IMPLEMENTED & VERIFIED (all agent-runnable gates) — live checks deferred to
[2026-07-16-session-provider-model-swap-plan_livetest.md](./2026-07-16-session-provider-model-swap-plan_livetest.md)
**Requested by:** James — "I would like the ability to seamlessly swap between providers/models for existing sessions, this doesn't currently work."
**Follow-up spec:** `docs/superpowers/specs/2026-07-16-runtime-reconciler-migration_spec.md` (long-term migrations that build on this plan)

---

## As-built summary (2026-07-16, same session)

> Timing note: implementation began against the original (pre-reshape) plan and was
> refactored into the reconciler-first target shape the same session, once the reshape
> landed. End state conforms to this plan; deviations are listed per phase.

- **Phase 1 (contracts/transport)** — as planned. `InstanceChangeModelPayloadSchema` gained
  a concrete `provider` enum (no `auto`); `model` became optional with a refine requiring
  `model || provider`. `InstanceStateUpdatePayload` gained `provider` and
  `desiredRuntime: DesiredRuntime | null` (null = clear). Shared types: `DesiredRuntime`
  (provider required; model/effort optional-means-keep; fastMode carried, not yet a
  trigger), `RuntimeChangeRequest` (provider optional over IPC), and
  `Instance.desiredRuntime` (`src/shared/types/instance.types.ts`).
  **Deviation:** `queueUpdate` kept its positional signature and gained a trailing
  `extras?: { provider, desiredRuntime }` options bag instead of converting the whole tail
  — same effect, far smaller blast radius across the manager/communication wirings.
- **Phase 2 (RuntimeReconciler)** — `src/main/instance/lifecycle/runtime-reconciler.ts`
  (execution, extracted not rewritten from `changeModel`: fresh-fallback ordering,
  `writeThroughIdentityLocked`, `waitForResumeHealth` all preserved),
  `runtime-reconciler-plan.ts` (pure `computeRuntimeDiff` + `planContinuity`, kept
  import-light for the queue and tests), `runtime-reconciler.types.ts` (DesiredRuntime,
  RuntimeDiff, ContinuityPlan, deps interface). `changeModel()` is now a thin shim
  building a `DesiredRuntime`; existing changeModel unit tests pass unchanged against it.
  Mutex label is `'runtime-change'`. Provider-swap specifics live in
  `model-change-provider-swap.ts`: fail-loud CLI availability (local via `resolveCliType`,
  remote via worker-node `supportedClis` — decision 6 resolved as "supported when the node
  advertises the CLI"), remembered-model fallback (decision 4), reasoning-effort mapping
  (Codex max/workflow→xhigh; providers without reasoning drop it, logged), fastMode dropped
  with a log when the target is not claude/codex. Two extra behaviors beyond the plan:
  (a) the tracked session snapshot's provider/modelId are updated via
  `SessionContinuity.updateState` before the identity write-through — `saveStateLocked`
  persists the tracked snapshot, not the live instance, so without this a restore would
  respawn the old provider; (b) on swap-spawn failure the instance reverts to its previous
  provider/model/effort so a manual restart relaunches the CLI that was actually running.
- **Phase 3 (renderer)** — as planned. Header dropdown replaced with `CompactModelPicker`
  (pending-create mode, `DEFAULT_INSTANCE_PROVIDERS`); the composer-toolbar picker (which
  already had provider tabs but silently degraded because it never sent the provider) now
  passes it. Model-degradation and failed-queued-apply system messages also raise error
  toasts. Legacy dropdown helper `instance-model-list.ts` deleted. Store merge paths
  (`applyUpdate`/`applyBatchUpdates`/`deserializeInstance`) apply `provider`/`desiredRuntime`.
- **Phase 4 (desired-state queueing)** — `lifecycle/desired-runtime-queue.ts`:
  park in `instance.desiredRuntime`, auto-apply via `transitionState → onSettled` on
  idle/ready/waiting_for_input, `setImmediate` defer (mutex re-entrancy), cancel by
  re-selecting the live config (diff-empty ⇒ cancel), no-double-apply (cleared before
  apply). The IPC handler routes through queue-aware `requestModelChange`. Both picker
  surfaces stay enabled while busy and show a dashed ⏳ pending chip (click = cancel).
  **Deviation:** a failed deferred apply is dropped with a transcript system message +
  toast instead of retried — swap failures are usually permanent (missing CLI) and silent
  retry loops would respawn repeatedly.
- **Phase 5 (history/ledger/edges)** — covered by unit tests: A→B→A always `resume: false`
  with cursor cleared; unavailable-CLI rejection leaves the running adapter untouched;
  tracked-snapshot provider update asserted (restore-with-new-provider); ledger untouched
  by design (decision 7). Live restore/loop checks are in the livetest doc.
- **Phase 6 (gates)** — pure-fn specs (`desired-runtime-queue.spec.ts` covers
  computeRuntimeDiff/planContinuity/queue), `model-change-provider-swap.spec.ts`,
  extended `instance-manager.change-model.spec.ts` (swap flow, remembered-default,
  A→B→A, effort mapping, queue park/apply/cancel through the real lifecycle), schema,
  handler, and renderer store/composer specs — all green. `tsc` (both configs), `ng lint`,
  `check:ts-max-loc` (instance-lifecycle ceiling TIGHTENED 3528→3405 after the extraction;
  transport.types raised 1788→1803), full `npm run test:quiet`. Concurrent loop-engine
  work by another agent had its own failing gates in `loop-*` files during this session;
  those are not part of this change.

---

## 0. Architectural direction (agreed 2026-07-16)

Long term, the conversation is the durable first-class entity owned by the orchestrator, and a
provider/model is a **replaceable runtime attachment** — not part of the instance's identity.
Provider-native sessions (resume cursors, JSONL threads) are a cache/optimization, never the
authority. All runtime changes (model, provider, effort, fast mode, yolo, recovery respawns)
should eventually flow through **one RuntimeReconciler** instead of today's five near-duplicate
terminate-respawn paths.

Agreed sequencing: **write the new code in the target shape now** (the reconciler module is
created by this plan and provider/model swap are its first clients), but **defer migrating the
existing respawn paths** (`toggleYoloMode`, interrupt-respawn, unexpected-exit respawn,
history-restore fallback) to one-per-change follow-ups with their own livetest gates — that
family of code is the most incident-prone in the app (SessionMutex self-deadlock, 22-minute
respawn wedge, init-rollback instance deletion, respawn-promise race) and each migration needs
its own reproduce/verify cycle. The maintained handoff state (rolling per-turn summary
replacing the swap-time replay preamble) is likewise a follow-up: the existing preamble works;
it's an upgrade, not a blocker. Both are specified in the follow-up spec above.

---

## 1. Investigation findings (current state)

Claims below marked **[verified]** were confirmed by reading the executing code path in this
session; **[agent-reported]** came from exploration subagents and were spot-checked but not
line-by-line re-read.

### Model swap (same provider) — EXISTS in backend + UI, but gated and fragile

- **[verified]** Full backend path exists: `INSTANCE_CHANGE_MODEL` IPC →
  `instance-handlers.ts:513` → `InstanceLifecycle.changeModel()`
  (`src/main/instance/instance-lifecycle.ts:3112-3366`). It acquires the session mutex,
  validates the model against `getKnownModelsForCli()` + unified catalog (silently degrading
  to the provider default with an emitted degradation event, `:3211-3220`), terminates the
  old adapter, respawns, and preserves context.
- **[verified]** Continuity strategy (`:3186-3191`): non-Claude providers with resume support
  get **native resume + session fork**; Claude and local-model targets always get a **fresh
  session + replay-continuity preamble** (`buildReplayContinuityMessage(instance,
  'model-change')`, `:3331`), because Claude's native resume reconnects to a session bound to
  the old model. Resume failures fall back to fresh + `buildFallbackHistory` (`:3289-3314`)
  with `writeThroughIdentityLocked` to persist the new identity.
- **[verified]** Hard status gate: `getModelSwitchUnavailableReason()`
  (`src/shared/types/instance-status-policy.ts:20`) rejects any change unless the instance is
  waiting for user input. The renderer additionally disables the picker whenever
  `isRuntimeLocked()` (busy / initializing / respawning / interrupting…)
  (`instance-header.component.ts:158-161`). **This is the main reason model swapping feels
  like it "doesn't work": for a busy or looping instance there is no affordance at all — no
  queueing, no pending state, just a disabled control or a thrown error.**
- **[verified]** The header dropdown only ever lists the *current provider's* models:
  `instance-detail.component.ts:365-372` feeds
  `unifiedCatalog.displayModelsForProvider(inst.provider)` into the header.
- **[verified]** The picker is hidden entirely for local-model runtimes
  (`isLocalModelRuntime()`, `instance-header.component.ts:300`).

### Provider swap (e.g. Claude → Codex on an existing session) — DOES NOT EXIST

- **[agent-reported, corroborated]** `instance.provider` is set once during `createInstance()`
  (`instance-lifecycle.ts:1435`) and restored from persisted session state; searches for
  `switchProvider` / `changeProvider` / migrate found no mutation path, no IPC channel, no
  command. `changeModel()` **[verified]** derives the CLI type from the instance's existing
  provider (`resolveCliTypeForInstance`, `:3181`) — it can never cross providers.
- **[verified]** `InstanceStateUpdatePayload`
  (`packages/contracts/src/types/transport.types.ts:73-122`) has **no `provider` field**, so
  even if the backend changed the provider, the renderer store would never learn about it.
- **[agent-reported]** `chat:set-provider` / `chat:set-model` exist for the lighter *chats*
  surface (`packages/contracts/src/channels/chat.channels.ts:12-14`) — precedent that
  per-turn provider choice is already an accepted product concept; instances are the gap.

### Why provider swap is feasible (context portability)

- **[agent-reported]** The conversation ledger stores provider-neutral messages
  (`conversation_messages`: role/content/tokens) separately from provider-specific raw events
  (`provider_event_captures`) and thread identity (`conversation_threads.provider`,
  `native_thread_id`) — `src/main/conversation-ledger/conversation-ledger-schema.ts`.
- **[agent-reported]** The renderer transcript is app-owned (`instance.outputBuffer`), not
  provider-owned — the visible conversation survives an adapter replacement. Already proven
  by the model-change and history-restore flows.
- **[agent-reported]** A production-tested cross-session context handoff already exists:
  `buildReplayContinuityMessage()` (`src/main/session/replay-continuity.ts:53-110`) serializes
  the recent transcript + unresolved items into a preamble; the history-restore coordinator
  (`src/main/history/history-restore-coordinator.ts:102-206`) uses it whenever native resume
  is impossible — which is exactly the provider-swap situation.
- **[agent-reported]** Native session IDs / resume cursors are provider-specific and
  fingerprinted (`computeResumeConfigFingerprint` includes provider+model+cwd,
  `src/main/instance/lifecycle/session-recovery.ts:32-44`), so a provider swap must clear the
  resume cursor and never attempt native resume. The fingerprint mechanism already guards
  against accidental cross-config resume.

### Related prior work

- `docs/plans/2026-07-03-dynamic-model-catalog-plan_completed.md` — unified model catalog +
  per-provider model enumeration (reused here, not changed).
- `docs/plans/mobile-timestamps-model-picker-plan.md` — notes the mobile gateway does not
  expose `changeModel`; out of scope here, but Phase 1's payload change should keep the
  gateway serializers in mind.

---

## 2. Goal & non-goals

### Goal
From an existing session's header picker, choose **any provider + model combination** and have
the session continue seamlessly: same transcript, same working directory, same yolo/agent
config, context carried over, clear system notice of what changed. Swaps requested while the
instance is busy are **queued as desired state and applied at the next idle** instead of being
rejected. The change lands as the first client of the new RuntimeReconciler, not as a sixth
ad-hoc respawn path.

### Non-goals (this plan)
- No mid-*turn* swapping (a running turn finishes or is interrupted first).
- No native cross-provider session resume (impossible; replay continuity is the mechanism).
- No migration of `toggleYoloMode`, interrupt-respawn, unexpected-exit respawn, or
  history-restore onto the reconciler (follow-up spec, one path per change).
- No maintained rolling handoff state (follow-up spec; swap-time preamble is v1).
- No changes to the chats surface, mobile gateway, orchestration coordinators, or model
  catalog/discovery infrastructure.

---

## 3. Design decisions (chosen; flag if you disagree)

1. **Extend the existing channel rather than adding a new one.**
   `InstanceChangeModelPayloadSchema` gains an optional `provider` field; the handler routes
   into the reconciler. Rationale: one mutex path, one status gate, one renderer event.
2. **New module `src/main/instance/lifecycle/runtime-reconciler.ts`** owns diff → continuity
   decision → execution (see Phase 2). `changeModel()` becomes a thin shim that builds a
   `DesiredRuntime` and delegates; the existing external API and IPC surface stay stable.
3. **Provider swap always uses replay continuity** (never native resume), reason string
   `'provider-change'`. The old provider's session is terminated; `providerSessionId` and the
   resume cursor are cleared via `writeThroughIdentityLocked`.
4. **Model resolution on provider swap:** explicit model from the picker is validated against
   the target provider (existing `resolveAvailableModelSelection` path); otherwise fall back
   to remembered `defaultModelByProvider[target]`, then the provider default — mirroring
   `resolve-initial-model.ts` precedence.
5. **Busy instances queue desired state** (`instance.desiredRuntime`), applied by the
   reconciler at the next input-waiting transition. This is the generalized replacement for
   the `pendingYoloMode` pattern — but yolo itself migrates later (follow-up spec), we only
   build the general field + apply hook now.
6. **Remote/worker instances are in scope only if the existing `changeModel` already works
   remotely** (it passes `executionLocation` through to `createRuntimeAdapter`). Verify in
   Phase 2; if worker-side CLI availability can't be validated cheaply, reject provider swaps
   on remote instances with a clear error and record it in the follow-up spec.
7. **Ledger threads:** do not mutate the old thread. The new provider session creates its own
   thread records naturally; the instance remains the join key for the UI transcript. Verify
   in Phase 5 that history restore of a swapped instance restores the *latest* provider.

---

## 4. Implementation phases

### Phase 1 — Contracts & transport
- Add `provider?: InstanceProvider` to `InstanceChangeModelPayloadSchema`
  (`packages/contracts/src/schemas/instance.schemas.ts:248-255`) and its transport type.
- Add `provider?: InstanceProvider` and `desiredRuntime?: DesiredRuntimeSummary | null` to
  `InstanceStateUpdatePayload` (`packages/contracts/src/types/transport.types.ts:73`); thread
  through `state.queueUpdate` (note: `queueUpdate` has a long positional signature —
  `instance-manager.ts:298` — convert the tail to an options object while there).
- Preload passthrough + Zod schema in `src/shared/validation/ipc-schemas.ts` if mirrored there.
- Renderer store merge: `instance-list.store.ts:449-495` (change-model response) and the
  state-update merge path must apply `provider` and `desiredRuntime`.

### Phase 2 — RuntimeReconciler (new module) + provider-aware execution
New file `src/main/instance/lifecycle/runtime-reconciler.ts` (respecting `check:ts-max-loc`;
split types into `runtime-reconciler.types.ts`). Shape:

```ts
interface DesiredRuntime {
  provider: InstanceProvider;
  model?: string;
  reasoningEffort?: ReasoningEffort | null;
  fastMode?: boolean;                    // carried, not yet a change trigger (follow-up)
  modelRuntimeTarget?: ModelRuntimeTarget;
}

computeRuntimeDiff(instance, desired): RuntimeDiff        // pure, unit-testable
planContinuity(diff, adapterCapabilities): ContinuityPlan // 'native-resume-fork' | 'native-resume' | 'replay'
applyRuntimeChange(instanceId, desired, deps): Promise<Instance>
```

`applyRuntimeChange` owns what `changeModel` does today — session mutex, status gate
(`getModelSwitchUnavailableReason`), adapter terminate, spawn-option build, fresh-fallback
with `writeThroughIdentityLocked`, replay preamble injection, system notice, `queueUpdate`,
`model-changed`/`runtime-changed` event — extracted from `instance-lifecycle.ts:3112-3366`,
not rewritten. Provider-change specifics added on top:

- Validate target CLI installed/available (same detection as create time).
- Set `instance.provider` before `resolveCliTypeForInstance`; force `ContinuityPlan = 'replay'`;
  clear `providerSessionId`; persist new identity + null resume cursor.
- Model resolution per decision 4; recompute context window
  (`getProviderModelContextWindow`) — already generic at `:3238`.
- MCP config, browser-gateway MCP, and permission-hook spawn options already key off
  `cliType` (`:3263-3271`) — confirm each for the new provider.
- Map `reasoningEffort` across providers (unified effort → provider-specific); drop with a
  logged notice if the target has no equivalent. Same for `fastMode` (Claude settings key vs
  Codex serviceTier).
- System notice names both provider and model change (today `:3335` names only models).
- Behavior-preservation gate: existing `changeModel` unit tests must pass unchanged against
  the shim before any provider-swap logic is added (extract first, then extend).
- Session persistence already writes `instance.provider` (`session-continuity.ts:1234`); add
  a test proving a swapped instance restores with the new provider.
- Mutex label: `'runtime-change'` (new), keeping `'model-change'` as an alias in logs if
  useful for diagnosability.

### Phase 3 — Renderer: cross-provider picker on the instance header
- Replace the per-provider model dropdown in
  `instance-header.component.html:168-208` / `instance-detail.component.ts:363-372` with the
  existing `CompactModelPicker` (`features/models/compact-model-picker.component.ts`), which
  already does provider tabs + model rows + reasoning choices. Preselect the current
  provider/model.
- Emit `{ provider, modelId, reasoningEffort }`; extend `InstanceStore.changeModel`
  (`instance.store.ts:651`) and the IPC facade accordingly.
- Provider name/colour in the header are already `computed` from `instance.provider`
  (`instance-header.component.ts:302-308`), so they update automatically once Phase 1's store
  merge lands.
- Surface the existing model-degradation event as a toast (today it's emitted but easy to
  miss — part of the "doesn't work" perception when a chosen model silently falls back).
- Keep the picker hidden for local-model runtimes (unchanged v1 scope).

### Phase 4 — Seamlessness: desired-state queueing while busy
- Add `instance.desiredRuntime?: DesiredRuntime` (generalized pending-change field; pattern
  precedent: `pendingYoloMode`).
- When a swap arrives and the status gate rejects: store `desiredRuntime`, broadcast it in
  the state update, and let the reconciler apply it at the next transition into an
  input-waiting status. Renderer shows a pending badge on the picker and allows cancelling
  (clearing `desiredRuntime`).
- Single apply-point inside the reconciler; interrupt/respawn/park-resume flows must not
  clobber or double-apply it (tests around `interrupt-respawn-handler` transitions).
- Verify loop iteration boundaries count as an input-waiting status so swaps queued during a
  loop actually apply between iterations.

### Phase 5 — History, ledger, and edge verification
- Test: swap provider mid-conversation → ledger gains a new thread for the new provider; UI
  transcript continuous; `getConversation` path unaffected.
- Test: history restore of a swapped instance uses the new provider and its resume cursor
  (or replay fallback) — not the stale pre-swap cursor.
- Test: swap → swap back (A→B→A) — no stale fingerprint/native-resume attempt against the
  old session.
- Decide remote-instance behaviour per decision 6 and implement the guard or the support.

### Phase 6 — Tests & gates
- Unit tests: `computeRuntimeDiff` / `planContinuity` (pure), `applyRuntimeChange` with mock
  adapters (resume forced off on provider change, identity cleared, model fallback per
  provider, effort mapping), payload schemas, store merges, desired-state
  apply/cancel/no-double-apply.
- Canonical checklist: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`,
  `npm run lint`, `npm run check:ts-max-loc`, `npm run test:quiet` (full suite — multi-file
  change).
- Live checks that need a rebuilt app go to
  `2026-07-16-session-provider-model-swap-plan_livetest.md`: real UI swap Claude↔Codex with
  context question ("what did we discuss earlier?"), busy-queue swap applying on idle,
  swap queued during a loop applying between iterations.

---

## 5. Follow-up work (separate spec — do NOT bundle here)

Specified in `docs/superpowers/specs/2026-07-16-runtime-reconciler-migration_spec.md`:

1. Migrate `toggleYoloMode` onto the reconciler (first migration; simplest path).
2. Migrate interrupt-respawn and unexpected-exit respawn (one change each, livetest-gated).
3. Migrate history-restore fallback.
4. Maintained rolling handoff state (per-turn summary + recent verbatim turns + open items)
   replacing the swap-time replay preamble; shared by swaps, compaction recovery, and restore.
5. Remote/worker provider-swap support if excluded by decision 6.

---

## 6. Risks / open items

- **Extraction risk**: `changeModel` encodes incident-driven fixes (fresh-fallback ordering,
  `writeThroughIdentityLocked`, `waitForResumeHealth`); the extract-then-extend gate in
  Phase 2 exists to keep behavior identical before adding provider logic.
- **Replay preamble quality** bounds how seamless a cross-provider swap feels (24 truncated
  turns + unresolved items). If context loss is noticeable in live testing, pull follow-up
  item 4 forward.
- **Token/cost accounting**: context-usage percentage is recomputed, but historical token
  counters carry across providers; acceptable, note in as-built.
- **Loop engine**: loops hold instances busy for long stretches; Phase 4 is what makes
  swapping usable there.
