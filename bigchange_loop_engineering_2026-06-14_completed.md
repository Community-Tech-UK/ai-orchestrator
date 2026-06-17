# Loop Engineering for AIO — Design / Plan

**Date:** 2026-06-14
**Status:** COMPLETED — implemented and verified on 2026-06-16.
**Completion note:** Phase 1 reactions, Phase 2 campaign mode, and Phase 3
model-generated next objectives are implemented. Fresh review on 2026-06-16
fixed the remaining campaign `completed-needs-review` halt-policy bug, then
targeted regression coverage and the full test suite passed.
**Decisions locked (2026-06-14, James):** (1) Reactions master switch defaults **ON**.
(2) Campaign mode ships with a **full DAG editor** in v1 (not spec-import-only).
(3) Phase 3 (model-generated next objective) is **in scope now**. (4) Auto-merge reactions
are **wanted and kept**, with explicit guardrails (see §3.7).
**Origin:** "Anthropic's coding chief doesn't write prompts anymore — he writes loops"
(Boris Cherny). Thesis: stop being the human in `human → AI → read → human`; write a
loop that prompts the model, **evaluates the output against evidence**, and decides the
next action autonomously. The engineer's job shifts from conversationalist to architect
of the feedback loop. The load-bearing part is the **evaluation / stopping logic**, not
the `while`.

---

## 0. Framing: we already built the hard part

AIO is already a loop-engineering platform. The article validates the architecture; it is
not a new idea to bolt on. Before adding anything, the inventory of what exists and is
**wired and live**:

| Capability | Where | Status |
|---|---|---|
| Self-iterating agent loop (rebuilds own prompt each turn) | `src/main/orchestration/loop-coordinator.ts` | Live |
| 7-signal completion detector | `src/main/orchestration/loop-completion-detector.ts` | Live |
| Pure evidence-precedence ladder (only Tier-2 ground-truth auto-stops) | `src/main/orchestration/evidence-resolver.ts` | Live |
| Belt-and-braces rename gate + fresh-eyes cross-model review | `src/main/orchestration/loop-coordinator-completion-gates.ts` | Live |
| Provider rate-limit park + auto-resume | `src/main/orchestration/loop-provider-limit-handler.ts` | Live |
| No-progress / stall kill-switch | progress detector in `loop-coordinator.ts` | Live |
| Scheduled autonomous runs + catch-up on resume | `src/main/automations/` | Live |
| Observation → loop memory (prior learnings into prompts) | `src/main/observation/` | Live (heuristic) |
| Event→reaction re-prompting (CI fail → re-prompt) | `src/main/reactions/` | **Wired but DISABLED by default** |
| Multi-verify / debate / consensus / parallel-worktree | `src/main/orchestration/` lazy coordinators | Built, opt-in by design |

Conclusion: the gap is **not** "add loops." The gap is **connecting and surfacing loop
machinery we already shipped**, plus one genuinely net-new capability (multi-loop
choreography). This plan is deliberately "turn on what exists" first, "build new" last.

---

## 1. Goals & non-goals

### Goals
1. **G1 — Reactions on demand.** Make event-driven re-prompting (the purest "loop prompts
   Claude" primitive) a first-class, per-instance, opt-in capability with a safe default
   config and UI surface. Engine already exists; it is off and unsurfaced.
2. **G2 — Campaign mode.** Add a thin orchestrator over the existing loop coordinator that
   runs a **sequence/graph of loops** (loop A → B, or fan-out B+C), reusing every existing
   completion gate. This is the only net-new evaluation surface.
3. **G3 — Optional model-generated next objective.** Behind a flag, let a planner generate
   the loop's next objective from the last output, while the **existing evidence ladder
   still owns the stop decision** (no weakening of safety).

### Non-goals
- **NG1.** Do **not** auto-wire debate/consensus/parallel-worktree into every loop. Per the
  standing design note ("orphan primitives are design decisions"), wiring them is a risky
  refactor. We surface them as an explicit "escalate verification to a panel" action, not a
  default.
- **NG2.** Do **not** weaken `evidence-resolver.ts`. Self-declared completion stays
  corroboration-only. Any new autonomy feeds *into* the ladder; it never bypasses it.
- **NG3.** No new npm packages without confirming with the user.
- **NG4.** Do not touch the loop coordinator's core `runLoop` control flow except at the
  documented extension points (iteration hooks, invokers, intervention queue).

---

## 2. Background: how the existing loop decides "done"

(Load-bearing context for why the new features are safe.)

- `loop-completion-detector.ts` raises up to 7 signals (declared-complete, `*_Completed.md`
  rename, `DONE.txt`, plan-checklist, `LOOP_TASKS.md` ledger, done-promise, self-declared),
  each ranked by tier.
- `evidence-resolver.ts::resolveCompletion()` is a **pure function** mapping evidence →
  `{continue | stop | stop-needs-review | pause-operator-review}`. Authority tiers:
  - **Tier 2 (only auto-stop authority):** external verify passed **+** `*_Completed.md`
    rename **+** fresh-eyes review clean.
  - **Tier 3:** structured in-band `declared-complete` — raises precedence, still needs
    Tier-2 authority to stop.
  - **Tier 4:** forensic markers — corroboration only, never sufficient alone.
- Investigation loops additionally require a substantive, file:line-cited `REPORT.md`.

Everything below preserves this ladder as the single arbiter of "stop."

---

## Phase 1 — IMPLEMENTATION STATUS (2026-06-14)

**Phase 1 is implemented and verified.** Investigation found that most of Phase 1
was already built but unwired ("built-but-unsurfaced"): the engine already had
per-instance arming (`setArmed`/`isArmed`), a daily reaction budget backstop, the
arming gate on `send-to-agent`, full IPC handlers, contracts channels, preload
exposure, a renderer IPC service, the per-instance arming toggle in the loop
inspector, AND the global master-switch settings descriptor. So Phase 1 reduced to:

1. **Default-ON (decision #1):** flipped `DEFAULT_SETTINGS.reactionsEnabled` to `true`,
   init step reads `!== false`, and refreshed the settings-metadata + JSDoc copy to
   describe the arming gate. Added main-side live-apply subscriptions
   (`setting:reactionsEnabled` / `setting:reactionsPollIntervalMs` → `engine.updateConfig`)
   so the settings toggle starts/stops the engine without a restart (latent bug fixed),
   plus a poll-interval timer restart in `updateConfig`.
2. **Auto-merge guardrails (decision #4):** extracted the destructive path into
   `src/main/reactions/reaction-auto-merge.ts` (keeps `reaction-engine.ts` under the
   700-line ratchet). Guardrails: distinct per-instance auto-merge opt-in
   (`setAutoMergeAllowed`, requires arming first, revoked on disarm/untrack/removal);
   permission gate in `triggerReaction` (enabled + armed + opt-in, else downgrade to
   notify); **live PR re-fetch + hard precondition re-check at fire time**
   (open/CI-passing/approved/mergeable/no-conflicts) before any merge; full audit
   (`reaction:auto-merge-audit`, outcome merged/skipped/failed) every decision. The
   merge side-effect is injectable (`MergeFn`) for testability. New IPC channel
   `REACTION_SET_AUTO_MERGE` (contracts → generated → zod → handler → preload → service)
   and a nested "Allow auto-merge" toggle in the loop inspector (shown only when armed).
   Because there is no per-reaction action editor yet, the per-instance opt-in itself
   turns a `merge.ready` event into an auto-merge for that instance.

Verification: 3× tsc clean, lint clean, ts-max-loc passes, 29 reaction tests + 588
contracts/ipc/preload tests pass. New tests: `reaction-auto-merge.spec.ts` (precondition
matrix + merge/skip/abort/fail flows) and engine opt-in/disarm/cleanup cases.

**Deferred from Phase 1 (note, not a gap):** a per-reaction action-map editor UI
(action/retries/escalateAfter per reaction key). The defaults + per-instance arming +
the auto-merge opt-in cover the core flows; the editor is a follow-up.

---

## 3. Phase 1 — Reactions as a first-class opt-in (G1)

**Why first:** highest leverage, smallest blast radius. The engine is already initialized at
`initialization-steps.ts` (`{ name: 'Reaction engine', fn: () => getReactionEngine().initialize(instanceManager) }`)
and the default config (`DEFAULT_REACTION_ENGINE_CONFIG` in `reaction.types.ts`) already has
sensible per-event rules — it's just `enabled: false` and has no UI.

### 3.1 What exists (verified)
- `ReactionEngineConfig { pollIntervalMs, enabled, reactions, notificationRouting }`.
- `ReactionConfigMap` keyed by reaction key (`ci-failed`, `changes-requested`,
  `merge-conflicts`, `agent-stuck`, …), each `{ auto, action, message?, priority?, retries?, escalateAfter? }`.
- `eventToReactionKey()` maps `ReactionEventType` → reaction key.
- Action `send-to-agent` is the re-prompt path; `notify` / `auto-merge` / `ignore` are the
  others. Defaults already set `ci-failed` and `changes-requested` to
  `{ auto: true, action: 'send-to-agent', retries: 2, escalateAfter: '30m' }`.

### 3.2 What's missing
1. **Global enable + per-instance opt-in.** Today `enabled` is one global boolean. We want:
   - a global "Reactions" master switch (default off, persisted in settings), and
   - a per-instance toggle so a user arms reactions only on the instances driving a PR.
2. **Config surface.** No UI to view/edit the reaction map, retries, escalation, or routing.
3. **Auditability.** Reaction firings should be visible (what fired, what was sent, retry
   count, escalation) — reuse the existing notification/observation surfaces.

### 3.3 Design
- **Settings:** add `reactions` settings group (master `enabled`, `pollIntervalMs`, optional
  per-reaction overrides) via the existing settings/control-surface mechanism (see
  `bigchange_settings-control-surface_completed.md` for the pattern). Engine reads merged
  config = defaults ⊕ settings overrides.
- **Master switch default = ON** (locked decision #1). NB: `DEFAULT_REACTION_ENGINE_CONFIG.enabled`
  in `reaction.types.ts` is currently `false`; flip the *effective* default to on **but keep
  per-instance arming required** (see below) so turning the master on does not silently start
  re-prompting every existing instance. The combination = "the system is willing to react,
  but only acts on instances the user has explicitly armed." This makes default-on safe.
- **Per-instance arming:** add `reactionsArmed: boolean` to instance state (renderer
  `instance.types.ts` + main instance model). Engine's polling loop skips instances where
  `reactionsArmed !== true`, regardless of global enable being on. Gate: an instance only
  fires `send-to-agent` reactions when **both** global-enabled **and** instance-armed.
- **Tracking already exists:** `InstanceReactionState` + `ReactionTracker` already track
  attempts/escalation; no schema change needed there.
- **UI:**
  - A toggle on the instance card / loop inspector: "Auto-react to CI & review events."
  - A settings pane listing each reaction key with action dropdown
    (`send-to-agent | notify | auto-merge | ignore`), retries, and escalateAfter.
  - Surface firings in the existing notification feed + observation timeline.

### 3.4 Files (anticipated)
- `src/main/reactions/reaction-engine.ts` — honor global+per-instance gate; read settings overrides.
- `src/shared/types` + renderer `instance.types.ts` — add `reactionsArmed`.
- `src/main/ipc/handlers/` — `setReactionsArmed(instanceId, armed)`, `getReactionConfig`, `setReactionConfig`.
- `packages/contracts` channels + `src/preload/preload.ts` — expose the new IPC (remember the
  3-place `@contracts` alias sync if any new subpath is added).
- `src/shared/validation/ipc-schemas.ts` — Zod payloads.
- Renderer: instance-card toggle + reactions settings component + store wiring.

### 3.5 Risks
- **Runaway re-prompting.** Mitigation: existing `retries` + `escalateAfter` caps; plus the
  loop's own no-progress kill-switch if the instance is a loop. Add a per-instance daily
  reaction budget as a backstop.
- **Default-on surprise.** Because the master switch now defaults on (decision #1), the
  per-instance arming gate is what prevents surprise: an unarmed instance never receives a
  `send-to-agent` reaction. The arming toggle defaults **off** per instance; only the master
  is on. Document this clearly in the settings copy.

### 3.6 Acceptance
- Master on (default) + instance **unarmed** + CI fails → **no** prompt sent (arming gate holds).
- Master on + instance armed + CI fails → agent receives the fix prompt; firing visible in
  feed; retry/escalation honored.
- Master off → no reactions anywhere.
- Toggling an instance off mid-run stops further `send-to-agent` reactions for it.

### 3.7 Auto-merge reaction (decision #4 — kept, with guardrails)
Auto-merge is wanted. It stays a selectable `action` on merge-related reaction keys
(`approved-and-green`, `merge-ready`). Because it is destructive (writes to a shared branch),
it is gated harder than `send-to-agent`:

- **Per-instance arming required** (same gate as everything else) **plus** a distinct,
  explicit "allow auto-merge for this instance" confirmation — arming reactions does not by
  itself arm auto-merge.
- **Preconditions checked at fire time** (re-read live PR state, do not trust stale poll):
  CI `passing` on all required checks, `reviewDecision === 'approved'`, `mergeable === true`,
  `hasConflicts === false`. Any miss → downgrade to `notify`, never merge.
- **Audit every auto-merge** to the notification feed + observation timeline with the PR
  URL, the merge SHA, and the precondition snapshot that justified it.
- **Default action stays `notify`** for these keys (`approved-and-green` is `auto:false notify`
  in current defaults); a user opts an instance up to `auto-merge` deliberately. Master-on
  does not imply auto-merge-on.

---

## 4. Phase 2 — Campaign mode (G2)

**The only genuinely net-new evaluation surface.** Single-loop autonomy is solid; there is
no "loop A finishes → spawn loop B, or fan out B+C in parallel" today.

### 4.1 Concept
A **campaign** is a directed acyclic graph of loop specs. Each node is a standard loop run
(reusing the full completion/evidence machinery). Edges define ordering and gating:
- **sequential:** B starts only after A reaches a terminal status.
- **fan-out:** B and C start in parallel after A.
- **gate:** an edge fires only if the upstream node's terminal status matches a predicate
  (e.g., `completed` but not `completed-needs-review`).

The campaign orchestrator owns **only** choreography. It does **not** re-implement stop
logic — each node delegates to `loop-coordinator` and reads back its terminal status.

### 4.2 Data model
```
CampaignSpec {
  id: string
  title: string
  nodes: CampaignNode[]
  edges: CampaignEdge[]          // DAG; validated acyclic at create time
  policy: {
    onNodeNeedsReview: 'pause-campaign' | 'continue' | 'halt'
    maxParallel: number          // cap concurrent loop nodes
    isolation?: 'worktree'       // optional per-node git worktree
  }
}
CampaignNode {
  id: string
  loopConfig: LoopConfig         // same shape startLoop already takes
  dependsOn: string[]            // resolved from edges
}
CampaignEdge { from: string; to: string; when?: TerminalStatusPredicate }
```

### 4.3 Orchestration
- New `CampaignCoordinator` singleton (`src/main/orchestration/campaign-coordinator.ts`)
  following the lazy `getInstance()` + `getCampaignCoordinator()` + `_resetForTesting()`
  pattern.
- It walks the DAG: a node becomes runnable when all `dependsOn` nodes are terminal and any
  edge predicates pass. Runnable nodes start via the existing loop start path; concurrency
  capped at `policy.maxParallel`.
- Subscribes to loop terminal events (the coordinator already emits loop lifecycle events)
  to advance the graph — no polling.
- **Persistence:** campaign + node statuses persisted (reuse loop store DB; add a
  `campaigns` + `campaign_nodes` table) so a campaign survives restart, mirroring how loops
  are marked interrupted-on-boot in `initialization-steps.ts`.
- **Worktree isolation:** when `isolation: 'worktree'`, parallel nodes run in isolated git
  worktrees to avoid mutating the same tree concurrently — reuse `ParallelWorktreeCoordinator`
  rather than re-inventing.

### 4.4 Failure & review semantics
- Node terminal `completed-needs-review` → respect `policy.onNodeNeedsReview`. Default
  `pause-campaign`: the campaign halts and surfaces an operator banner; downstream nodes do
  not start until the operator accepts.
- Node terminal `failed` / `provider-limit` → campaign pauses; provider-limit nodes inherit
  the loop's own auto-resume, then the campaign resumes.
- No silent truncation: if a node is skipped because an edge predicate failed, log/surface it.

### 4.5 UI — full DAG editor (decision #2)
v1 ships an **interactive editor**, not spec-import-only:
- **Canvas:** drag-to-create loop nodes; draw edges between them. Each node opens the standard
  loop config form (same fields `startLoop` takes — goal, stage mode, verify command, gates).
- **Edge editing:** set edge type (sequential / fan-out is implicit from multiple out-edges)
  and optional gate predicate (`when` = terminal-status match, e.g. "only if `completed` and
  not `completed-needs-review`").
- **Live validation:** reject cycles **as the user draws** (a candidate edge that would create
  a cycle is refused with a reason) so the saved spec is always a valid DAG. Reuse the same
  acyclic check the coordinator enforces server-side — client validates for UX, server is the
  source of truth.
- **Run + monitor:** the same view switches to a live mode showing per-node loop status
  (pending / running / completed / needs-review / failed), each node expandable into the
  existing loop inspector. Reuse `loop.store.ts` per-chat loop state; add `campaign.store.ts`.
- **Persistence:** editor saves a `CampaignSpec`; specs are listable, editable, re-runnable.
- Suggested lib check before building edge-routing from scratch: confirm with James before
  adding any graph/diagram npm dependency (NG3). Prefer a small hand-rolled SVG canvas if a
  dependency would be heavy.

### 4.6 Files (anticipated)
- `src/main/orchestration/campaign-coordinator.ts` (+ `.types.ts`).
- `src/main/orchestration/index.ts` — add `getCampaignCoordinator` lazy getter.
- `src/main/persistence` / loop store — `campaigns`, `campaign_nodes` tables + migration.
- IPC handlers + contracts channel + preload + Zod schemas.
- Renderer `features/campaign/` (component + store + routes).
- `initialization-steps.ts` — mark running campaigns interrupted-on-boot.

### 4.7 Risks
- **DAG correctness:** validate acyclic at create; reject self/cyclic edges. Unit-test the
  walker hard (diamond, fan-out, gated skip, mid-run failure).
- **Resource blow-up:** parallel loops multiply token/CPU usage. `maxParallel` + the existing
  `LongRunResourceGovernor` (already injected into the loop coordinator) must gate spawning.
- **Scope creep:** keep v1 to DAG + sequential/fan-out/gate. No loops-in-loops, no dynamic
  node generation in v1.

### 4.8 Acceptance
- Sequential A→B: B starts only after A terminal `completed`.
- Fan-out A→{B,C}: B and C run concurrently (respecting `maxParallel`), campaign terminal
  only when both terminal.
- Gated edge with failing predicate: downstream skipped and surfaced.
- Restart mid-campaign: campaign resumes from persisted node statuses.

---

## 5. Phase 3 — Optional model-generated next objective (G3)

**Behind a flag. Evidence ladder still owns "stop."**

### 5.1 Today
`loop-stage-machine.ts::buildPrompt()` builds the next iteration prompt from a stage template
+ pending interventions + workspace state. The next *objective* is template-driven, not
reasoned from the last output.

### 5.2 Design
- Add an optional `nextObjectivePlanner` injectable on the loop config (default `undefined`
  → today's template behavior, zero change).
- When set, after an iteration completes **and the evidence ladder says `continue`**, the
  planner (a cheap model call, ideally a different provider for diversity) reads the last
  output + workspace diff and proposes the next objective text, which is injected as the next
  iteration's focus (same slot interventions use).
- **Hard invariant:** the planner runs **only on the `continue` branch**. It can never
  produce a `stop`. Stop remains exclusively `resolveCompletion()`'s decision. This keeps the
  safety property intact — a hallucinated "we're done" from the planner cannot end the loop.
- Reuse the consensus/auxiliary-LLM slot infra rather than a raw new client.

### 5.3 Risks
- **Objective drift:** planner steers the loop off-task. Mitigation: planner prompt is
  constrained to "next concrete step toward the *original* goal"; original goal stays pinned
  in the stage state; no-progress detector still fires on stalls.
- **Cost:** extra model call per iteration. Mitigation: flag-gated, cheap model, optional
  cadence (every N iterations).

### 5.4 Acceptance
- Flag off → byte-identical prompt-building behavior to today.
- Flag on → next objective reflects last output; loop still stops only via evidence ladder;
  off-task drift caught by no-progress.

---

## 6. Explicitly deferred (surface, don't auto-wire)

- **Panel verification (debate/consensus/multi-verify).** Add a single operator/loop action
  "escalate this completion to a verification panel" that invokes the existing coordinators
  for one decision, feeding the verdict back into the evidence ladder as a fresh-eyes-equivalent
  signal. Do **not** make it the default. (NG1.)
- **LLM-based observation reflection.** Replacing heuristic compression in
  `observation/observer-agent.ts` with a model call is a separate, isolated change; out of
  scope here.

---

## 7. Sequencing & estimate

1. **Phase 1 (Reactions opt-in)** — small, isolated, high value. Ship first.
2. **Phase 2 (Campaign mode)** — largest; the real new surface. Ship after Phase 1 proves the
   per-instance arming UX.
3. **Phase 3 (Next-objective planner)** — in scope now (decision #3). Smallest code but
   riskiest behaviorally; still ship **last** and flag-gated. "In scope now" means it's part
   of this plan's delivery, not that it ships before Phases 1–2 are verified — the
   `continue`-branch-only invariant is easier to prove once campaign mode exercises the loop
   coordinator harder.

Each phase is independently shippable and independently reversible (flags / opt-ins).

---

## 8. Cross-cutting verification checklist (per phase)

- [ ] `npx tsc --noEmit` clean
- [ ] `npx tsc --noEmit -p tsconfig.spec.json` clean
- [ ] `npm run lint` clean
- [ ] `npm run check:ts-max-loc` clean
- [ ] New singletons: lazy `getInstance()` + getter + `_resetForTesting()`; initialized in
      `initialization-steps.ts`
- [ ] New IPC: handler registered + contracts channel + preload export + Zod schema (+ the
      3-place `@contracts` alias sync if a new subpath is added; + `vitest.config.ts` if
      imported from tests)
- [ ] Unit tests for pure logic (DAG walker, gate predicates, arming gate)
- [ ] Integration trace: arm an instance / run a 2-node campaign end-to-end and observe real
      behavior (not just typecheck) — per the "trace user flows, don't trust typecheck" rule
- [ ] Evidence ladder untouched / proven unchanged on the `stop` path (Phase 3)

---

## 9. Decisions (resolved 2026-06-14, James)

1. **Reactions default = ON.** Master switch on by default; per-instance arming gate
   (default off) is the safety mechanism so default-on never surprise-prompts unarmed
   instances. See §3.3 / §3.6.
2. **Campaign authoring = full DAG editor in v1.** Interactive drag/draw editor with
   live cycle rejection, not spec-import-only. See §4.5.
3. **Phase 3 = in scope now.** Model-generated next objective is part of this plan,
   flag-gated, shipped last. `continue`-branch-only invariant preserved. See §5.
4. **Auto-merge = kept, guarded.** Selectable action on merge keys, hard preconditions
   re-checked at fire time, distinct per-instance opt-in beyond reaction arming, fully
   audited. See §3.7.

### Remaining low-stakes items to confirm during implementation
- Whether the DAG editor warrants a graph/diagram npm dependency or a hand-rolled SVG canvas
  (NG3 — confirm before adding any package).
- Per-instance daily reaction budget number (backstop cap in §3.5).
