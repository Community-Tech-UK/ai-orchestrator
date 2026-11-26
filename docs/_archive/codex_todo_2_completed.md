> **DISPOSED 2026-07-31.** Every retained gap in this audit was dispositioned by
> `docs/plans/2026-07-30-sibling-audit-round2_plan_completed.md`: the P0s and most P1s
> implemented (all gated + fresh-eyes reviewed), P2s recorded in the plan's §7 deferred
> backlog, no-retained-gap sections carried into §8. This document's AIO comparisons were
> verified accurate and served as the plan's backbone. Live validation:
> `docs/plans/2026-07-30-sibling-audit-round2_livetest.md`.

# Comparative Audit: Ideas for AI Orchestrator

Status: complete — all 24 in-scope sibling projects examined on 2026-07-26. The original 23-project inventory omitted the separate `codex-plugin-cc` Git repository; it is included below. This is a product-discovery backlog, not an approved implementation plan. AIO comparisons use `docs/architecture.md` and current source; a finding is retained only where the source offers a materially clearer user journey, guardrail, or delivery mechanism than the existing subsystem.

## How to read this backlog

- **Priority** is discovery priority: P0 means validate and plan next; P1 means useful, bounded follow-up; P2 means keep as a reference rather than build now.
- **Source evidence** is an exact local path so the later planning pass can re-check the original implementation.
- **Gap / first step** deliberately avoids asserting a missing feature until the named AIO surface has been inspected in a planning pass.
- Do not copy source code or source licensing. Reimplement behaviour only after an AIO-specific design and security review.

## Highest-value shortlist

1. **P0 — User-reviewable memory promotion queue.** AIO already prevents agent-derived memory entering instruction tier, but OB1 makes the trust decision legible with a review inbox, explicit actions, source references, lifecycle state, and an audit trail. AIO should expose the existing provenance gate as an operator workflow instead of leaving it primarily implicit in storage and diagnostics.
2. **P1 — Explainable pre-run readiness checklist.** CodePilot aggregates actionable run blockers/warnings in one checkpoint banner. AIO’s Doctor and loop preflight are strong but are separate from the point at which a user presses Run. A small, ordered readiness panel could prevent expensive failed starts without making every warning blocking.
3. **P1 — Keyboard shortcut discoverability and conflict checking.** Actual Claude treats bindings as context-aware, platform-aware configuration rather than a static help overlay. AIO’s command/overlay shell is the right base; a searchable shortcut registry, conflict validator, and in-context hint surface would make the dense desktop UX faster to learn.
4. **P2 — Cursor-based transcript backfill.** Actual Claude’s session history requests newest-first then fetches older pages with a stable `before_id` cursor and bounded page size. This is a useful performance/reliability reference for AIO’s long-session transcript/history views; validate current pagination before planning.
5. **P1 — Explain the orchestration decision, not just the resulting status.** Claw Code produces typed policy-decision events that preserve the matched rule, priority, action, and explanation. AIO has detailed state and reason strings, but Workboard cards do not yet give operators a single causal timeline for why retries, escalations, provider waits, or completion gates occurred.
6. **P1 — Make manual compaction previewable and boundary-aware.** Hermes lets users preview what will be summarised and preserve the latest N exchanges verbatim. AIO’s one-click compact control is safe and well-instrumented, but it cannot show the affected range or give the user a focused, reversible choice before changing context.
7. **P1 — Add an opt-in contained execution profile for autonomous work.** NanoClaw uses an OS-level container boundary, per-agent mounts, isolated session IPC, and host-side credential brokering. AIO already has approvals and provider sandbox settings, but high-autonomy loops still benefit from a provider-neutral containment choice that users can understand and inspect.
8. **P0 — Wire result-aware tool-loop protection into ordinary sessions.** AIO's `DoomLoopDetector` has no production `recordToolCall()` caller. OpenClaw shows how to distinguish unchanged polling/results and A/B ping-pong from legitimate repeated work, including a stricter post-compaction canary.
9. **P0 — Require evidence anchors before a review finding can block completion.** Storybloq verifies exact quotes against the exact redacted review artifact and records realignment/integrity outcomes. AIO currently lets severity-bearing prose findings veto completion without an equivalent anchor check.
10. **P0 — Admit queued prompts durably in the main process.** OpenCode assigns input IDs and persists admission before promoting a prompt atomically at a safe model boundary. AIO's renderer-owned, debounced queue persistence can drop attachments and is conditional on settings.
11. **P1 — Make Council progressive and synthesizable.** Return provider cards independently and let the user synthesize completed answers through AIO consensus, debate, or a chosen provider without waiting for the slowest call.
12. **P1 — Add structured inline review comments and a collaborative preview.** T3 Code turns selected diff lines and browser elements/regions into typed, re-anchorable agent feedback. This is a much tighter human-agent correction loop than copy/pasting code or screenshots.
13. **P1 — Make privileged session context inspectable as a manifest/epoch.** OpenCode records exactly which instruction/context sources and hashes were admitted. AIO assembles richer context, but cannot yet show the exact version of every AIO-owned source a running session received.
14. **P1 — Let settled sessions propose skill improvements.** OpenClaw's Skill Workshop converts repeated workflows and corrections into provenance-bearing, reviewable proposals rather than auto-writing trusted instructions.

## Loop and orchestration recommendations

### P0 — Promote governed memory through a visible review workflow

**What to borrow:** A separate operational flow for agent-authored memory: write it as evidence, retain source/artifact references, let the user confirm/edit/reject/supersede/dispute it, and only then permit instruction-grade use. Every recall result carries a snapshot of its use policy; use and ignore outcomes are tracked.

**Why AIO needs it:** `docs/architecture.md` says the AIO memory instruction gate defaults on and retains agent-derived material in advisory blocks. That is the correct safety boundary, but a user needs a straightforward way to inspect and promote the useful items. Without it, durable learning risks remaining opaque or accumulating uncurated evidence.

**Source evidence:** `OB1/schemas/agent-memory/schema.sql` (provenance, review, recall item, audit tables); `OB1/integrations/agent-memory-api/index.ts` (write validation, policy snapshot, review actions, and used/ignored trace handling); `OB1/recipes/openclaw-agent-memory/README.md` (runtime-neutral workflow and safety rules).

**AIO discovery before a plan:** Trace `src/main/memory/` and the current renderer/Doctor memory surfaces. Design a local-only review queue that shows provenance, scope, originating session/tool evidence, use policy, expiry, and a reversible promotion action. Keep generated memory advisory by default and never store raw reasoning or secrets.

### P1 — Put run readiness at the action point, with reasons and fixes

**What to borrow:** CodePilot derives one `checkpointReasons` list before a send and renders it as a dedicated run checkpoint; individual reasons can be non-blocking, confirmation-gated, or point to a corrective action.

**Why AIO needs it:** AIO has Doctor, provider diagnostics, context analytics, and Loop preflight, but users launching a normal session or a loop may not connect those findings to the action they are about to take. A compact readiness summary makes safety and cost signals timely rather than merely available.

**Source evidence:** `CodePilot/src/app/chat/page.tsx` (checkpoint reason aggregation and action routing around lines 286–322, rendered around line 1374); `CodePilot/src/instrumentation.ts` (scheduler startup restores persisted tasks).

**AIO discovery before a plan:** Map the create/run/loop-start UI, then inventory existing preflight, provider, workspace, permission, and context signals. Define a single typed reason contract with severity, blocking/confirmable state, remediation command, and deduplication. Reuse existing services; do not create a second health system.

### P1 — Treat keyboard navigation as a first-class configurable contract

**What to borrow:** A context-scoped keybinding registry with platform capability fallbacks, user overrides, reserved-shortcut validation, explicit modal/list/navigation contexts, and shortcut display lookup.

**Why AIO needs it:** AIO’s overlay/picker architecture concentrates keyboard-driven interaction. A context model plus a discoverable registry would prevent accidental collisions as new HUD, session, picker, and review controls grow, while helping power users learn the navigation model.

**Source evidence:** `Actual Claude/keybindings/defaultBindings.ts` (contexts, platform-aware fallbacks, action names); `Actual Claude/keybindings/validate.ts`, `Actual Claude/keybindings/resolver.ts`, and `Actual Claude/keybindings/useShortcutDisplay.ts` (validation, resolution, and presentation entry points).

**AIO discovery before a plan:** Audit renderer key handlers and command registry. Establish one action namespace and a conflict matrix before allowing customization; ensure screen-reader-labelled controls continue to expose the same commands.

### P2 — Use stable cursor pagination for transcript backfill

**What to borrow:** Load a bounded newest page; request older history using the oldest returned event ID as `before_id`; preserve chronology within each response; treat network failures as a recoverable empty result rather than corrupting the active transcript.

**Why AIO needs it:** AIO supports long-running, recoverable sessions. A bounded and cursor-stable history protocol protects renderer responsiveness and makes retry semantics simpler when users open a very long conversation.

**Source evidence:** `Actual Claude/assistant/sessionHistory.ts` (`HISTORY_PAGE_SIZE`, `fetchLatestEvents`, `fetchOlderEvents`, bounded timeout/error handling).

**AIO discovery before a plan:** Inspect conversation ledger queries, history IPC, and virtualized renderer views. Only adopt this if AIO lacks an equivalent stable cursor and its tests cover duplicate/missing/out-of-order page boundaries.

### P2 — Preserve upstream compatibility at packaging boundaries, not in product logic

**What to borrow:** CodexDesktop-Rebuild keeps rebuilding/patching and platform packaging isolated in scripts and Electron configuration rather than embedding cross-platform shims in the core UI.

**Why AIO needs it:** This is not a feature proposal; it is a release-engineering reference for AIO’s evolving Electron packaging. It reinforces the existing separation in `docs/packaging-native-modules.md` and is worth consulting if platform-specific CLI/runtime adaptation expands.

**Source evidence:** `CodexDesktop-Rebuild/package.json` (platform-specific build scripts); `CodexDesktop-Rebuild/scripts/build-from-upstream.js`; `CodexDesktop-Rebuild/forge.config.js`.

**AIO discovery before a plan:** Compare AIO’s native-module runbook and release scripts only when a concrete cross-platform packaging defect or upstream binary integration is being planned. Do not import its patching approach by default.

### P1 — Add an operator-readable policy-decision timeline to the Workboard

**What to borrow:** Evaluate lifecycle policy into two outputs: the action to take and a durable, typed explanation of the exact matched rule, priority, lane/task, and any approval token. Render that explanation as a chronological decision trail instead of leaving it only in logs or scattered status text.

**Why AIO needs it:** AIO’s Workboard correctly correlates instances, loops, automations, and repo jobs into attention lanes. Its loop, provider-limit, context, and review systems also retain meaningful reasons. What is missing is a common operator view that answers “why did this enter Waiting / Needs you, and what policy will move it next?” This becomes especially important when one item has related sources and automated recovery has already acted.

**Source evidence:** `claw-code/rust/crates/runtime/src/policy_engine.rs` (`evaluate_with_events`, `PolicyDecisionEvent`, rule/action explanations); `claw-code/rust/crates/runtime/src/task_packet.rs` (task contract fields for recovery, verification, and reporting); `claw-code/rust/crates/runtime/src/task_registry.rs` (`LaneBoard`, heartbeat freshness, structured board JSON); `claw-code/docs/g006-task-policy-board-verification-map.md` (the intended contract and focused verification).

**AIO comparison evidence:** `src/renderer/app/features/workboard/workboard.types.ts` and `workboard-projection.ts` (correlated attention projection); `src/main/orchestration/loop-provider-limit-handler.ts`, `loop-runtime-status.ts`, and `loop-store.ts` (reasoned state transitions and persistence); `src/main/context/compaction-coordinator.ts` (emitted context-policy events).

**AIO discovery before a plan:** Define a small, cross-domain `OperationalDecision` schema that references—not copies—source-specific events. Start with provider-limit, loop terminal/review-gate, compaction, and automation recovery decisions; include timestamp, cause/rule, resulting status, retry/resume time, and a safe operator action. Avoid a second policy engine or a renderer-only event log.

### P1 — Let a user preview and bound a manual context compaction

**What to borrow:** Before a manual compaction, show a dry-run with the number of affected messages/tokens and the boundary that will remain verbatim. Offer an explicit “summarise up to here” / “keep latest N exchanges” control; preserve conversation role ordering at the rejoin seam and fall back safely when the boundary is degenerate.

**Why AIO needs it:** AIO already supports automatic and manual compaction, records the result in the transcript, and guards large contexts. Its current warning offers only **Compact Now**, so the user cannot inspect scope or protect a recent decision-heavy exchange before the context changes. A preview is especially useful during code work where the latest tools, errors, and operator requests must remain exact.

**Source evidence:** `hermes-agent/hermes_cli/partial_compress.py` (`parse_partial_compress_args`, `summarize_compress_preview`, role-safe split and rejoin); `hermes-agent/apps/desktop/DESIGN.md` (immediate feedback, no focus theft, and cancellation contract); `hermes-agent/apps/desktop/src/app/session/hooks/use-prompt-actions/submit.ts` (foreground-session guard for queued/background work).

**AIO comparison evidence:** `src/renderer/app/features/instance-detail/context-warning.component.ts` (single-click compact action); `src/renderer/app/features/instance-detail/instance-detail.component.ts` (`onCompactNow`); `src/main/context/compaction-coordinator.ts` (`compactInstance`); `src/main/context/context-compactor.ts` (existing compaction mechanics).

**AIO discovery before a plan:** Add a read-only preview endpoint first; it must state the source of token estimates, the exact transcript range, protected pending user asks/tool evidence, and whether the adapter self-manages compaction. Apply only after explicit confirmation, persist a before/after checkpoint, and preserve the current automatic path unchanged.

### P1 — Offer an explicit contained execution profile for autonomous or untrusted runs

**What to borrow:** NanoClaw treats application permissions and OS containment as complementary. Each agent group gets an isolated container, only explicitly configured mounts, session-local inbound/outbound durable queues with one writer per database, per-session startup deduplication, health/heartbeat recovery, and host-side credential brokering rather than raw secrets in the agent runtime.

**Why AIO needs it:** AIO has mature approval policy, path validation, provider-level sandbox mappings, worktree isolation, and process supervision. Those controls do not necessarily provide one provider-neutral, operator-visible choice for a long-running loop or automation that should be unable to reach the user profile, unrelated repositories, or durable credentials. This is a meaningful safety boundary for unattended runs, not a request to replace normal local development sessions with containers.

**Source evidence:** `nanoclaw/README.md` (isolation model and two-DB architecture); `nanoclaw/src/container-runner.ts` (per-session spawn deduplication, explicit mounts, health lifecycle); `nanoclaw/src/host-sweep.ts` (single-writer queue recovery, heartbeat/claim SLA, bounded retries); `nanoclaw/docs/isolation-model.md` (agent/channel/session isolation contract).

**AIO comparison evidence:** `src/main/security/permission-manager.ts` and `path-validator.ts` (policy and renderer boundary); `src/main/cli/adapters/codex/app-server-initializer.ts` (provider-native sandbox/approval setup); `src/main/workspace/git/worktree-manager.ts` (workspace isolation); `src/main/process/` (supervision); `src/main/automations/thread-wakeup-runner.ts` (durable scheduled delivery).

**AIO discovery before a plan:** First inventory each provider’s actual sandbox guarantees and AIO’s remote-node runtime. Design an optional `contained` execution profile for loops/automations with an explicit workspace allowlist, read-only inputs by default, network and credential-broker policy, unsupported-provider fallback, retention/teardown behaviour, and a visible “what this run can access” card. Never claim that permission prompts alone are OS isolation; never silently downgrade a selected contained run to host execution.

### P0 — Wire result-aware tool-loop protection into ordinary interactive sessions

**What to borrow:** Observe normalized tool start and result events at the canonical provider ingress. Detect identical calls with identical no-progress results, repeated unknown-tool failures, unchanged polling, A/B ping-pong, and a global runaway count. Warn first; block only when the result evidence demonstrates no progress. Arm a short, stricter `(tool, arguments, result)` canary immediately after automatic compaction.

**Why AIO needs it:** AIO already has a three-identical-call `DoomLoopDetector` and forwards its event to the renderer, but repository-wide inspection found no production caller of `recordToolCall()`. Loop Mode has separate semantic progress controls; ordinary interactive sessions do not receive the intended protection.

**Source evidence:** `openclaw/src/agents/tool-loop-detection.ts` (run-scoped result hashing, repeat/poll/ping-pong/circuit-breaker detectors); `openclaw/src/agents/agent-tools.before-tool-call.ts` (production wiring); `openclaw/src/agents/embedded-agent-runner/post-compaction-loop-guard.ts`; `openclaw/docs/tools/loop-detection.md`.

**AIO comparison evidence:** `src/main/orchestration/doom-loop-detector.ts` (definition only); `src/main/bootstrap/orchestration-bootstrap.ts` and `src/main/app/instance-event-forwarding.ts` (event/UI path); `src/main/orchestration/loop-progress-detector.ts`; `src/main/context/context-compactor.ts`.

**AIO discovery before a plan:** Define the provider-normalized call/result seam and volatile-field normalization first. Fail open when arguments/results are incomplete, never block polling whose state changed, scope history to one run, reset on lifecycle boundaries, and test approval-pending/tool-result pairing.

### P0 — Evidence-anchor every completion-blocking review finding

**What to borrow:** Require a blocking finding to carry reviewer provenance, file, side/range, an exact quote or quote hash, and the exact redacted review-artifact/work hash. Verify that anchor before the finding can veto completion; uniquely realign moved lines and otherwise classify it `evidence_unverified`. Keep explicit, runtime-owned exceptions for deterministic non-localized gates such as secret detection.

**Why AIO needs it:** AIO redacts review egress, aggregates findings, and binds verification runs to work hashes, but `FreshEyesFinding` can block on severity with only title/body/file/confidence. A hallucinated, stale, or mislocated review comment can therefore force another loop cycle without proof that the cited code exists in the reviewed artifact.

**Source evidence:** `storybloq/src/autonomous/lens-harness/prepare.ts` (persisted redacted anchoring artifact); `storybloq/src/autonomous/lens-harness/synthesize.ts` (quote verification, realignment, and integrity telemetry); `storybloq/src/autonomous/lens-harness/verification-log.ts` (unverified deferrals and quote hashes); `storybloq/src/autonomous/lens-harness/secrets-gate.ts` (trusted non-localized meta-finding).

**AIO comparison evidence:** `src/main/orchestration/loop-fresh-eyes-reviewer.ts`; `src/main/orchestration/headless-review-findings.ts`; `src/main/orchestration/headless-review-runner.ts`; `src/main/orchestration/review-finding-aggregation.ts`; `src/main/orchestration/loop-coordinator-completion-gates.ts`.

**AIO discovery before a plan:** Specify localized, unlocalized-advisory, and deterministic-gate finding classes. Re-anchor only on a unique match, treat redacted/generated/binary artifacts explicitly, and never silently discard an unverified finding—show why it did not block.

### P1 — Make required reviewer coverage exact and cache each review angle independently

**What to borrow:** Record every intended reviewer/angle as `used`, `cached`, `skipped`, `failed`, or `parse_failed`, with activation reason, model, and contributed finding count. Do not call a review clean when required coverage is partial. Cache successful angles independently using review schema/prompt version, reviewer/model/angle, task and project rules, and the redacted artifact work hash.

**Why AIO needs it:** AIO records reviewer statuses and strict parse failures, but its Loop result mainly exposes `reviewersUsed`; it does not expose required-versus-achieved coverage to the completion decision or reuse unchanged successful reviewer angles independently across fix/review cycles.

**Source evidence:** `storybloq/src/autonomous/lens-harness/prepare.ts` (activation reasons/cache); `storybloq/src/autonomous/lens-harness/synthesize.ts` (exact-set coverage including parse failures); `storybloq/src/autonomous/lens-harness/judge.ts` (approval cap on partial coverage); `storybloq/src/autonomous/lens-harness/cache.ts` (schema-versioned, artifact-bound cache).

**AIO comparison evidence:** `src/main/orchestration/headless-review-runner.ts`; `src/main/orchestration/loop-fresh-eyes-reviewer.ts`; `src/main/orchestration/loop-review-backedge.ts`; `src/main/orchestration/verification-cache.ts`.

**AIO discovery before a plan:** Define which angles are required versus advisory, include every prompt/policy/model input in invalidation, and re-anchor cached findings to the current artifact. Optional local reviewers must not make required remote coverage appear incomplete.

### P0 — Move queued-prompt admission into a durable main-process inbox

**What to borrow:** Assign a stable ID and durable receipt before acknowledging a queued or steered input. Promote it atomically into model-visible history only at a safe boundary, retaining attachment content references and an idempotent admitted/promoted state.

**Why AIO needs it:** AIO's queue is feature-rich, but persistence is renderer-driven, debounced, conditional on pause/session-content settings, and explicitly restores messages without attachments. A renderer crash or promotion race can lose or ambiguously duplicate work that looked accepted.

**Source evidence:** `opencode/specs/v2/session.md` (`session_input`, `PromptAdmitted`, replayable pending state, atomic promotion, steer/FIFO semantics); `opencode/packages/core/src/session/input.ts`; `opencode/packages/core/src/session/runner/llm.ts`.

**AIO comparison evidence:** `src/renderer/app/core/state/instance/queue-persistence.service.ts`; `src/renderer/app/core/state/instance/instance-messaging.store.ts`; `src/renderer/app/core/state/instance/instance-messaging-queue-utils.ts`; `src/main/ipc/handlers/instance-handlers.ts`.

**AIO discovery before a plan:** Design a main-process inbox table/event log with idempotent admission and projection events, bounded retention, attachment references, and privacy controls. Preserve provider-specific steering behavior while making the admission receipt provider-neutral.

### P1 — Persist a per-session privileged-context manifest and epoch

**What to borrow:** Record the exact AIO-owned context admitted to a session: source kind, provenance, ordering, content hash/version, missing/unavailable status, and later changes or revocations. Reconcile changes only at safe turn boundaries and advance a context epoch.

**Why AIO needs it:** AIO assembles instructions, observation memory, project briefs, lessons, repo maps, wake context, and MCP context through separate asynchronous paths. It has strong attribution estimates, but cannot precisely answer which version of each privileged source a running opaque CLI session actually received; resume code acknowledges that old system prompts can persist.

**Source evidence:** `opencode/specs/v2/session.md` (immutable cache baseline and structured snapshot); `opencode/packages/core/src/session/context-epoch.ts`; `opencode/packages/core/src/session/runner/llm.ts`.

**AIO comparison evidence:** `src/main/instance/instance-lifecycle.ts` (instruction/context assembly and resume compensation); `src/main/context/context-attribution-service.ts`; `src/renderer/app/features/instance-detail/context-attribution-panel.component.ts`.

**AIO discovery before a plan:** Start observability-only and authoritative only for AIO-owned inputs. Redact sensitive paths/content, distinguish “requested”, “supplied”, and “provider confirmed”, and do not pretend opaque provider caches can be proven.

### P1 — Stream Council results progressively and add a synthesis action

**What to borrow:** Give each provider card its own queued/running/succeeded/failed lifecycle, reveal answers immediately, persist unfinished runs, and let the user synthesize completed answers through a chosen provider, AIO consensus, or debate. The synthesis input should preserve attribution, disagreements, and unique insights.

**Why AIO needs it:** AIO's safer compare service waits on `Promise.all`, so no result becomes usable until the slowest provider finishes. Its completed view compares answers but does not convert them into a decision or next action.

**Source evidence:** `online-orchestrator/multi-ai-query/sidepanel/sidepanel.js` and `online-orchestrator/multi-ai-query/sidepanel/sidepanel.html` (per-service status, partial response restoration, merge action); `online-orchestrator/multi-ai-query/background/service-worker.js` (`formatMergePrompt`).

**AIO comparison evidence:** `src/main/compare/multi-provider-compare-service.ts`; `src/renderer/app/features/compare/ask-council-page.component.ts`; `src/main/orchestration/consensus-coordinator.ts`; `src/main/orchestration/debate-coordinator.ts`.

**AIO discovery before a plan:** Keep AIO provider adapters; do not copy browser DOM injection. Add per-cell progress events, bounded attributed synthesis input, clear missing/failed states, cancellation, and durable recovery of partially complete runs.

### P1 — Create a provenance-first Skill Workshop from settled session history

**What to borrow:** Scan bounded, settled sessions for repeated workflows, corrections, and missing instructions; produce proposals to create/update/reject/quarantine a skill; show source sessions and support files; let the user edit the proposed `SKILL.md`; validate before applying. Make scans checkpointed, resumable, workspace-scoped, and manual by default.

**Why AIO needs it:** AIO measures skill attribution, token use, error correlation, and health, but does not close the feedback loop by turning recurring evidence into reviewable skill improvements.

**Source evidence:** `openclaw/src/skills/workshop/history-scan.ts`; `openclaw/src/skills/workshop/history-scan-state.ts`; `openclaw/src/gateway/server-methods/skills-proposal-history.ts`; `openclaw/ui/src/pages/skill-workshop/history-scan.ts`; `openclaw/ui/src/pages/skill-workshop/proposals.ts`.

**AIO comparison evidence:** `src/main/skills/skill-attribution-service.ts`; `src/main/diagnostics/skill-diagnostics-service.ts`; `src/renderer/app/features/skills/skills-page.component.ts`; `src/renderer/app/features/skills/skill-health-panel.component.ts`.

**AIO discovery before a plan:** Require explicit scope, secret redaction, proposal provenance, bounded transcript budgets, pending/applied/rejected/quarantined lifecycle state, and full skill validation. Never auto-promote generated content into trusted instructions.

### P1 — Give automations an explicit operating-authority contract

**What to borrow:** Model unattended authority as structured scope, triggers, approval gates, escalation/stop conditions, explicit prohibitions, verification, and reporting—not only a prompt plus a broad autonomy toggle. Offer templates such as read-only monitor, prepare-but-do-not-publish, and implementation within one repository.

**Why AIO needs it:** AIO automation has isolation, verifier commands, budgets, retries, webhooks, loop actions, and failure disabling, but the form does not provide one legible contract showing what the job may touch and when it must stop or ask.

**Source evidence:** `openclaw/docs/automation/standing-orders.md` (Scope, Triggers, Approval gates, Escalation, prohibitions, Execute-Verify-Report).

**AIO comparison evidence:** `src/shared/types/automation.types.ts`; `src/renderer/app/features/automations/automation-form-model.ts`; `src/renderer/app/features/automations/automations-page.component.html`; `src/main/automations/`.

**AIO discovery before a plan:** Separate technically enforced limits from prompt-level policy in the UI. Compile the contract into existing permission/preflight machinery where possible; never imply a prose gate is a sandbox.

### P1 — Use one editable, bounded progress draft on external channels

**What to borrow:** On adapters that support edits, delay creation briefly, then update a single working message with typed/redacted status, plan steps, and tool activity. On completion, replace/collapse it and send the final answer cleanly; retain fresh-message fallback where editing is unsupported.

**Why AIO needs it:** AIO caps channel heartbeats and assistant chunks, but long work can still create several messages. A single evolving receipt is calmer and easier to follow on chat platforms.

**Source evidence:** `openclaw/docs/concepts/progress-drafts.md`; `openclaw/src/channels/progress-draft-compositor.ts`; `openclaw/src/channels/progress-draft-lines.ts`; `openclaw/src/channels/streaming.ts`; channel implementations under `openclaw/extensions/slack`, `openclaw/extensions/discord`, and `openclaw/extensions/telegram`.

**AIO comparison evidence:** `src/main/channels/channel-message-router.ts`; `src/main/channels/channel-adapter.ts`; `src/main/channels/adapters/discord-adapter.ts` (`editMessage`).

**AIO discovery before a plan:** Rate-limit edits, skip drafts for short tasks, redact commands/secrets, and cover edit/delete/finalization races. Preserve the current message path as capability fallback.

### P1 — Add prompt-cache structural contracts, not only post-hoc analytics

**What to borrow:** Give AIO-owned prompt injection one stable-prefix API: deterministic additions at stable positions, volatile additions confined to a tagged tail, and strip/reappend ownership for dynamic blocks. Add CI checks for byte-prefix stability, volatile-tail isolation, time/random determinism, pipeline drift, and reviewed volatility exceptions.

**Why AIO needs it:** AIO can detect a prompt-cache collapse and already tests provider cache markers, but analytics discovers cost after a regression. It does not prove that transforms preserve the reusable prefix before release.

**Source evidence:** `oh-my-opencode-slim/src/hooks/cache-safe-injection.ts`; `oh-my-opencode-slim/src/hooks/cache-safety.property.test.ts`; `oh-my-opencode-slim/src/cache-safety-tripwire.test.ts`; `oh-my-opencode-slim/src/hooks/cache-monitor/index.ts`; `oh-my-opencode-slim/docs/cache-verification.md`.

**AIO comparison evidence:** `src/main/context/cache-analytics-service.ts`; `src/main/memory/prompt-cache.ts`; `src/main/memory/prompt-cache.spec.ts`; `src/main/api/prompt-cache.integration.spec.ts`.

**AIO discovery before a plan:** Scope exact-prefix assertions to payloads AIO controls, particularly direct API and AIO-owned context construction. Do not write brittle golden tests around opaque provider CLI payloads.

### P2 — Offer explicit inbox policies: steer, follow up, collect, interrupt

**What to borrow:** Let a user choose per session whether new input steers the active turn, runs FIFO afterward, coalesces a burst after a quiet window, or aborts and replaces the active turn. Show bounded queue capacity and overflow behavior, and preserve per-item cancellation identity.

**Why AIO needs it:** AIO already has a feature-rich renderer composer queue, conditional persistence, and explicit steering, but users cannot express “I am jotting several follow-ups” or “replace the current work now” as a simple policy. The P0 main-process admission item above must land before this UX can promise durability.

**Source evidence:** `openclaw/docs/concepts/queue.md`; `openclaw/docs/concepts/queue-steering.md` (safe model boundaries, batching, compatibility checks, debounce, caps, owner-aware cancellation).

**AIO comparison evidence:** `src/renderer/app/core/state/instance/instance-messaging.store.ts`; `src/renderer/app/core/state/instance/instance-messaging-queue-utils.ts`; `src/renderer/app/core/state/instance/queue-persistence.service.ts`; `src/main/ipc/handlers/instance-handlers.ts`.

**AIO discovery before a plan:** Land only after main-process durable admission. Never inject between tool use and result; make coalescing visible; preserve attachments/channel routing; never silently summarize overflow instructions.

### P2 — Add a persistent guided requirements interview

**What to borrow:** A native interview mode that asks one or two focused questions per round, marks a recommended answer, supports keyboard/freeform responses, shows the spec delta after each answer, keeps append-only Q&A history, and resumes from persisted metadata.

**Why AIO needs it:** AIO renders provider clarification cards and document review artifacts, but lacks a dedicated workflow that converts a rough idea into a durable, resumable specification.

**Source evidence:** `oh-my-opencode-slim/docs/interview.md`; `oh-my-opencode-slim/src/interview/codemap.md`; `oh-my-opencode-slim/src/interview/`.

**AIO comparison evidence:** `src/shared/types/ask-user-question.types.ts`; `src/main/cli/adapters/ask-user-question-prompt.ts`; `src/renderer/app/features/instance-detail/user-action-request.component.ts`; `src/renderer/app/features/doc-review/`.

**AIO discovery before a plan:** Reuse native Angular and current review controls, not the reference localhost server. Resolve documentation paths through project policy and keep this distinct from execution Plan Mode.

### P1 — Experiment with a confined, provider-neutral batch/step tool

**What to borrow:** Expose one AIO-owned tool that accepts a small bounded step graph over currently authorized AIO/MCP tools. Independent known-input reads may run in parallel; mutations serialize; verification waits for edits. Every child retains its own permission, hook, cancellation, progress, audit, and output-limit record.

**Why AIO needs it:** AIO parallelizes agents internally, but its provider-facing tool path still spends a model round trip per call when several inputs are already known. OpenCode demonstrates a confined program with no ambient host authority; Tura demonstrates typed step groups and streaming child results. Neither is sufficient alone, so this should begin as a read-only experiment with an ablation benchmark.

**Source evidence:** `opencode/packages/codemode/README.md`; `opencode/packages/opencode/src/tool/code-mode.ts`; `tura/docs/core/command-run.md`; `tura/crates/tools/src/command_run/schema.json`; `tura/crates/tools/src/command_run/handler.rs`; `tura/crates/runtime/src/provider_flow/command_run_streaming.rs`.

**AIO comparison evidence:** `src/main/commands/`; `src/main/tools/`; AIO MCP surfaces; earlier related discovery in `docs/fable_todo_completed.md`.

**AIO discovery before a plan:** De-duplicate against the older Fable note. Ban arbitrary JavaScript and ambient filesystem/process/network access; cap calls, depth, bytes, and time; stop dependent steps on failure; preserve individual approvals for destructive actions; prove success/token/time gains before expanding beyond reads.

### P1 — Make long transcripts truly virtualized and benchmark continuity

**What to borrow:** Dynamic-height virtualization with cached per-session measurements and semantic visible anchors across prepend, streaming, collapse/expand, nested scroll, focus changes, and session switches. Measure layout shifts, long tasks, animation-frame gaps, geometry settlement, and visible intersections.

**Why AIO needs it:** AIO limits the initial render window, but “show earlier” grows that window and renders every included item. Very long sessions can still expand indefinitely, and manual scroll compensation is difficult to validate with unit tests alone.

**Source evidence:** `opencode/packages/app/src/pages/session/timeline/message-timeline.tsx`; `opencode/packages/app/e2e/performance/timeline-stability/README.md`; `opencode/packages/app/e2e/performance/README.md`.

**AIO comparison evidence:** `src/renderer/app/features/instance-detail/output-stream.component.ts` and `src/renderer/app/features/instance-detail/output-stream.component.html`; `docs/plans/2026-07-10-transcript-jump-rail-plan_completed.md` (records the non-virtualized design).

**AIO discovery before a plan:** Preserve stable message IDs, jump rail, find, context menus, screen-reader order, and focused controls. Prototype behind a flag with real-browser continuity benchmarks.

### P1 — Add a navigable conversation-branch tree

**What to borrow:** Project existing edits/forks into an append-only conversation DAG with branch labels/bookmarks, folding, user-only/no-tools filters, branch summaries, and a clear path switcher.

**Why AIO needs it:** AIO can fork from any message and preserves branch summaries, but alternate paths appear as separate sessions; users must remember why each fork exists and cannot visually navigate the relationship.

**Source evidence:** `pi/packages/coding-agent/src/core/session-manager.ts` (entry IDs/parents, tree construction, labels and branch summaries); `pi/packages/coding-agent/src/modes/interactive/components/tree-selector.ts` (filters, folds, labels).

**AIO comparison evidence:** `src/shared/types/instance.types.ts` (`forkAfterMessageId`); `src/main/instance/instance-persistence.ts`; `src/renderer/app/features/instance-detail/output-stream.component.ts` (“Fork from here”); `src/main/context/branch-summarizer.ts`.

**AIO discovery before a plan:** Start with a projection over existing lineage, not a transcript-storage rewrite. Keep conversation branches visually and semantically distinct from orchestration parent/child agents.

### P2 — Add safe declarative plugin UI contribution points

**What to borrow:** Let trusted worker-isolated plugins contribute schema-constrained status chips, composer widgets, transcript result cards, side-inspector panels, and commands. The worker emits validated view models and action IDs; Angular renders a fixed accessible component palette.

**Why AIO needs it:** AIO has mature provider/channel/MCP/skill/hook/tracker/notifier/telemetry plugin slots, but plugins cannot deliver first-class UI without core renderer changes.

**Source evidence:** `pi/packages/coding-agent/docs/extensions.md` (commands, widgets, footer/editor components, concrete plan-mode examples).

**AIO comparison evidence:** `src/shared/types/plugin.types.ts`; `src/main/plugins/plugin-manager.ts`; `src/main/plugins/plugin-worker-host.ts`; `src/main/plugins/project-plugin-trust.ts`.

**AIO discovery before a plan:** Never load plugin JavaScript or arbitrary HTML into Angular. Apply trust/quarantine, sanitization, component capability checks, accessibility requirements, payload/rate limits, and renderer crash containment.

### P2 — Turn RTK savings into an adoption and quality Doctor

**What to borrow:** Report missed eligible commands, unsupported commands, unnecessary `RTK_DISABLED` bypasses, parse-failure/fallback rate, per-project/provider adoption, recent history, and actionable rewrite guidance—not only successful savings totals.

**Why AIO needs it:** AIO proves RTK availability and shows compressed-command totals, but cannot distinguish healthy adoption from “enabled but bypassed” or “filter repeatedly failed and fell back.”

**Source evidence:** `rtk/src/discover/report.rs` (existing/passthrough/unsupported classification, missed savings and adoption); `rtk/src/core/tracking.rs` (parse failures/recovery); `rtk/src/analytics/gain.rs` (bypass diagnosis).

**AIO comparison evidence:** `src/renderer/app/features/settings/rtk-savings-tab.component.ts`; `src/main/cli/rtk/rtk-tracking-reader.ts` (already exposes richer recent per-project history).

**AIO discovery before a plan:** Default to aggregate local tracking data. Make session-log discovery explicit, local-only, redacted, date-bounded, and honest about provider coverage; do not add telemetry.

### No retained gap — Oh My OpenCode Slim’s orchestration, Council, and loop shell

**What was examined:** Specialist routing and presets, background-task graph/ownership, reusable session aliases, job-board injection, Council/failover, loop continuation/history, multiplexer companion, interview mode, cache safety/monitoring, Doctor, configuration, and update paths.

**Why most of it is not a new AIO recommendation:** AIO's instance tree, Workboard, provider catalog/failover, session continuity, supervision, multi-verify/debate/consensus, Loop evidence ledger, preflight/audit/fresh-eyes review, Doctor, and native desktop shell are broader. Retained gaps are limited to cache-prefix contracts and the guided interview; the progressive Council UX is sourced from the smaller online prototype because its partial-result flow is clearer.

**Source evidence:** `oh-my-opencode-slim/docs/background-orchestration.md`, `oh-my-opencode-slim/docs/council.md`, `oh-my-opencode-slim/docs/interview.md`, `oh-my-opencode-slim/docs/cache-verification.md`, `oh-my-opencode-slim/src/agents/orchestrator.ts`, and `oh-my-opencode-slim/src/hooks/cache-safe-injection.ts`.

**Keep as a design check:** Preserve explicit task ownership, task-fit rejection, and a direct-work boundary when AIO evolves background orchestration. Do not recreate multiplexer panes or a prompt-only shadow loop inside the native application.

### No retained gap — Online Orchestrator’s browser DOM automation

**What was examined:** Every source file: Manifest V3 permissions, service worker state, side panel and popup UI/state, shared utilities, and the ChatGPT, Gemini, and Claude content scripts.

**Why it should not be copied:** It requests `<all_urls>`, uses vendor-specific fallback selectors, injects text/clicks into logged-in tabs, and infers completion from DOM stability polling. AIO's typed provider adapters, browser gateway, attachment handling, capture stream, and consensus/debate services are materially safer. Only its progressive per-provider status and synthesis button are retained as Council UX.

**Source evidence:** `online-orchestrator/multi-ai-query/manifest.json`; `online-orchestrator/multi-ai-query/background/service-worker.js`; `online-orchestrator/multi-ai-query/content-scripts/chatgpt.js`, `online-orchestrator/multi-ai-query/content-scripts/gemini.js`, and `online-orchestrator/multi-ai-query/content-scripts/claude.js`; `online-orchestrator/multi-ai-query/sidepanel/sidepanel.js`.

**Keep as a design check:** Never make fragile website automation the normal provider integration path. Browser-tab use, if explicitly requested, must remain approval-scoped and capability-reported.

### No retained gap — OpenClaw’s core queue, compaction, gateway, and plugin runtime

**What was examined:** Agent loop and runner, steering/queues, progress drafts, loop detection, compaction/pruning, standing orders/task flows, channel routing, TUI/control UI, session search, gateway/plugins, and Skill Workshop.

**Why most of it is not a new AIO recommendation:** AIO already has stronger context evidence and compaction, a feature-rich renderer queue with conditional persistence, Loop progress detection, command/model/session pickers, remote nodes/mobile gateway, channel approvals, project trust, worker-isolated plugins, skill discovery/health, and Workboard hierarchy. Retained gaps are durable main-process admission, ordinary-session tool-loop wiring, editable channel progress drafts, queue-policy UX, automation authority, and the Skill Workshop proposal loop.

**Source evidence:** `openclaw/src/agents/`, `openclaw/src/channels/`, `openclaw/src/plugins/`, `openclaw/src/skills/workshop/`, `openclaw/docs/concepts/`, and `openclaw/docs/automation/`.

**Keep as a design check:** Continue separating authoritative lifecycle state from UI projections, and keep capability fallback explicit across channels rather than pretending all adapters support edits, streaming, or interruption equally.

### No retained gap — OpenCode’s file/review panels, lazy MCP, and replay machinery

**What was examined:** Session V2, durable inputs/context epochs, compaction, tool registry/code mode, MCP discovery, desktop boundaries, transcript renderer and performance tests, file/diff/review surfaces, and tests.

**Why most of it is not a new AIO recommendation:** AIO already has instance-scoped File Explorer and Source Control/diff/review panels, lazy ranked MCP selection, oversized-output persistence, replay/resync, mobile sequence recovery, command frecency, and scoped permissions. Retained gaps are durable main-process input admission, context epochs, true transcript virtualization, and the merged code-mode/batch-tool experiment.

**Source evidence:** `opencode/specs/v2/session.md`; `opencode/packages/core/src/session/`; `opencode/packages/codemode/`; `opencode/packages/app/src/pages/session/timeline/`.

**AIO comparison evidence:** `src/renderer/app/features/source-control/`; `src/main/mcp/tool-search-ranker.ts`; `src/main/mcp/mcp-runtime-tool-context.ts`; `src/main/context/output-persistence.ts`; `src/main/remote-node/`.

### No retained gap — Pi’s provider loop, trust, external editor, and terminal renderer

**What was examined:** Provider abstraction/faux providers, agent event loop, steering/follow-up, session/compaction tree, editor, extensions/RPC/TUI, project trust, external editor, and differential rendering.

**Why most of it is not a new AIO recommendation:** AIO's multi-CLI adapter/capture-parity architecture, steering/queue/Loop inputs, instruction and plugin trust, external-editor support, awaited plugin hooks, and Electron renderer already cover the transferable capability. Retained gaps are a conversation-branch navigator, declarative plugin UI slots, and large-paste tokens.

**Source evidence:** `pi/packages/agent/`; `pi/packages/coding-agent/src/core/session-manager.ts`; `pi/packages/coding-agent/docs/extensions.md`; `pi/packages/tui/src/components/editor.ts`.

**Keep as a design check:** Pi's in-process parallel tool loop and terminal-specific IME/differential-rendering solutions should not be transplanted across AIO's opaque CLI and Angular boundaries without a concrete problem.

### No retained gap — RTK’s filtering engine and telemetry

**What was examined:** Command dispatch/filter modules, never-worse guard, tee recovery, tracking database, parse-failure reporting, custom-filter trust, discovery, gain/session analytics, hooks, integrity checks, and tests.

**Why most of it is not a new AIO recommendation:** AIO already detects/configures RTK and reads its tracking database. Never-worse filtering, full-output recovery, typed filters, rotation, and trust belong in the RTK binary that AIO invokes; reimplementing them would fork behavior. Remote telemetry should not be added. The retained gap is a local adoption/quality Doctor over existing evidence.

**Source evidence:** `rtk/src/core/`, `rtk/src/discover/`, `rtk/src/analytics/gain.rs`, and `rtk/src/hooks/`.

**AIO comparison evidence:** `src/main/cli/rtk/rtk-awareness.ts`, `src/main/cli/rtk/rtk-runtime.ts`, `src/main/cli/rtk/rtk-tracking-reader.ts`, and `src/renderer/app/features/settings/rtk-savings-tab.component.ts`.

### No retained gap — Storybloq’s autonomous state machine, health model, and federation

**What was examined:** Product/session priming, PLAN→REVIEW→IMPLEMENT→TEST→REVIEW→FINALIZE state machine, context pressure, health/zombie detection, Bus/federation/dispatch, usage-limit recovery, lessons, and the full multi-lens review harness.

**Why most of it is not a new AIO recommendation:** AIO Loop has richer durable task/verification ledgers, audit/preflight, semantic progress, review back-edge, work-hash authority, process/session health, campaigns/repo jobs, remote nodes, quota wakeups, and governed memory. Storybloq's retained contribution is the stronger proof standard and coverage/cache accounting around review findings.

**Source evidence:** `storybloq/src/autonomous/state-machine.ts`, `storybloq/src/autonomous/context-pressure.ts`, `storybloq/src/autonomous/health-model.ts`, `storybloq/src/core/dispatch-plan.ts`, and `storybloq/src/autonomous/lens-harness/`.

**Keep as a design check:** Clean-boundary compaction and structured handovers validate AIO's current direction; they do not justify a parallel `.story` authority inside AIO.

### No retained gap — T3 Code’s worker/runtime, plan card, and remote shell

**What was examined:** Connection/provider/remote/runtime-mode architecture, web and mobile diff annotations, live preview annotations, ordered push and drainable workers, retry ownership, offline sync, plan card, composer follow-ups, remote pairing, worktrees, and checkpoints.

**Why most of it is not a new AIO recommendation:** AIO already has drainable orchestration queues and durable receipts, settled tracking, remote-node recovery, first-class Plan Mode, contextual keyboard backlog, SSH/pairing, worktrees, checkpoints, and offline drafts. Retained gaps are structured inline review comments and a collaborative live preview/annotation surface.

**Source evidence:** `t3code/docs/architecture/`; `t3code/apps/web/src/components/diffs/`; `t3code/apps/web/src/components/preview/`; `t3code/apps/mobile/src/features/review/`; `t3code/packages/client-runtime/`.

**Keep as a design check:** Reuse AIO-managed remote browser infrastructure only; the preview recommendation never authorizes control of James's local browser.

### No retained gap — Tura’s compaction manuals, backward-reasoning claims, and rich output protocol

**What was examined:** Runtime/tools/router/gateway/GUI/TUI architecture, command-run schema/execution/streaming, context/task status/runtime prompts, process ownership, personas, tests, and published benchmark caveats.

**Why most of it is not a new AIO recommendation:** AIO already preserves tool pairs, recent verbatim evidence, file operations and authenticated compaction previews; progressively loads skills and deferred MCP tools; operates goal/plan/verification loops; renders typed sanitized display items; supervises sessions; and has SWE-bench plus retrieval/UI/load benchmarks. The isolated causal value of Tura's backward-reasoning prompt is not proven. Only the bounded batch-tool experiment is retained.

**Source evidence:** `tura/ARCHITECTURE.md`; `tura/docs/core/`; `tura/crates/runtime/`; `tura/crates/tools/`; `tura/docs/KNOWN_ISSUES.md`.

**Keep as a design check:** Maintain the separation between capability and presentation, and require an AIO-specific ablation before attributing benchmark gains to one borrowed mechanism.

### No retained gap — Codex Plugin for Claude Code’s review, rescue, and transfer workflow

**What was examined:** Normal/adversarial review commands and schemas, background rescue/status/result/cancel state, stop review gate, app-server broker lifecycle, session-scoped cleanup, Claude transcript transfer, prompt skills, rendering, and tests.

**Why this is not a new AIO recommendation:** AIO already has multi-provider review angles including Adversarial Review, structured/tiered output, confidence filtering, fresh-eyes completion gates, durable jobs/Workboard, cancellation and supervision, native Claude transcript import, cross-provider handoff state, provider switching, and Codex app-server integration. A second plugin-shaped broker or stop hook would fragment the native control plane.

**Source evidence:** `codex-plugin-cc/plugins/codex/commands/`; `codex-plugin-cc/plugins/codex/prompts/adversarial-review.md`; `codex-plugin-cc/plugins/codex/scripts/stop-review-gate-hook.mjs`; `codex-plugin-cc/plugins/codex/scripts/lib/job-control.mjs`; `codex-plugin-cc/plugins/codex/scripts/lib/claude-session-transfer.mjs`.

**AIO comparison evidence:** `src/main/orchestration/review-prompts.ts`; `src/renderer/app/features/verification/config/verification-preferences.component.ts`; `src/main/orchestration/loop-review-backedge.ts`; `src/main/history/native-claude-importer.ts`; `src/main/session/handoff-state-service.ts`; `src/main/cli/adapters/codex/`.

**Keep as a design check:** Preserve the plugin's useful distinction between a normal defect review and an explicit challenge-to-the-approach review, but keep both inside AIO's existing review engine and evidence gates.

### No retained gap — Jean’s delayed wakeups, project polling, and desktop control surface

**What was examined:** Jean’s multi-project desktop workflow, delayed `ScheduleWakeup` tool integration, persisted wakeups, background git/PR polling, provider session recovery, command palette, configurable keybindings, and remote desktop/server presentation.

**Why this is not a new AIO recommendation:** AIO already has durable loop terminal wakeup intents, scheduled thread wakeups with session revival and terminal run state, automation scheduling/retry/catch-up, managed worktrees, a command/overlay system, provider recovery, and remote/remote-node domains. Jean’s wakeup implementation is a useful correctness reference—especially its persisted, last-wins scheduling and restart hydration—but duplicating it would overlap AIO’s wider automation scheduler. The keyboard item is already retained from Actual Claude.

**Source evidence:** `jean/README.md` (desktop/product scope); `jean/jean-core/src/chat/wakeup.rs` (persist, cancel, restart hydrate, and due-fire contract); `jean/jean-core/src/background_tasks/commands.rs` (bounded background worktree/PR polling); `jean/docs/headless-server.md` (remote/server deployment).

**AIO comparison evidence:** `src/main/orchestration/loop-terminal-intent-importer.ts` (recorded wakeup intents); `src/main/automations/thread-wakeup-runner.ts` and `automation-scheduler.ts` (revival, delivery, durable retry/catch-up); `src/main/workspace/`, `src/main/remote/`, `src/main/remote-node/`, and `src/renderer/app/features/overlay/`.

**Keep as a design check:** Any future wakeup or scheduled-send change must preserve AIO’s no-lost-wakeup property across restart, cancellation, target revival failure, and a newer schedule superseding an older one.

### No retained gap — MemPalace’s routing and recall protocol

**What was examined:** MemPalace’s source/room model, recall protocol, explicit write-routing policies (`direct`, `prefer`, `require`), retrieval evaluation materials, and recovery documentation.

**Why this is not a new AIO recommendation:** Its explicit routing decision is a sound operational pattern, but AIO already has a richer memory governance surface: retrieval evaluation, query sanitization, bounded recall traces, use reinforcement, and the provenance instruction gate. A separate memory daemon/room model would duplicate storage and create a second authority for recall. The existing P0 memory-review recommendation remains the user-facing gap; MemPalace adds no discrete feature beyond a planning check for fail-open/fail-closed policy wording.

**Source evidence:** `mempalace-reference/docs/write-routing-policy.md` and `mempalace-reference/mempalace/write_routing.py` (typed direct/prefer/require outcomes and reasons); `mempalace-reference/integrations/shared/recall-protocol.md` (bounded recall contract); `mempalace-reference/docs/CLOSETS.md` (separate source storage and recovery implications).

**AIO comparison evidence:** `docs/architecture.md` (retrieval eval, sanitizer, traces, reinforcement, and provenance gate); `src/main/memory/`; `src/main/context-evidence/context-safety-policy.ts` (typed policy decisions).

**Keep as a design check:** When AIO adds the memory review queue, label availability/consistency decisions explicitly and preserve the difference between an advisory fallback and a policy-required failure.

### No retained gap — Oh My Codex’s durable-goal and notification lifecycle

**What was examined:** Oh My Codex’s file-backed Ultragoal ledger, explicit steering mutations, completion/review gates, autopilot state machine, notification deduplication/cooldowns, and tmux HUD reconciliation.

**Why this is not a new AIO recommendation:** AIO’s loop system already owns a more integrated plan packet, task ledger, persisted verification runs, work hashes, fresh-eyes review, final-audit/preflight modes, terminal-intent handling, review back-edge, and renderer Workboard/HUD surfaces. OMX’s distinction between immutable objective and evidence-backed plan mutations validates AIO’s design but does not establish a missing subsystem. A separate shell/TUI ledger would fracture completion authority.

**Source evidence:** `oh-my-codex/docs/ultragoal.md` (durable goal/ledger, explicit steering, and completion invariants); `oh-my-codex/src/autopilot/fsm.ts` and `completion-gate.ts` (state/gate contract); `oh-my-codex/src/notifications/lifecycle-dedupe.ts` and `idle-cooldown.ts` (notification suppression); `oh-my-codex/src/hud/reconcile.ts` (derived presentation reconciliation).

**AIO comparison evidence:** `docs/architecture.md` (loop planning/audit envelope and evidence ledger); `src/main/orchestration/loop-coordinator.ts`, `src/main/orchestration/loop-plan-packet.ts`, `src/main/orchestration/loop-verification-run-ledger.ts`, `src/main/orchestration/loop-final-audit.ts`, `src/main/orchestration/loop-review-backedge.ts`, and `src/main/orchestration/loop-terminal-intent-importer.ts`; `src/renderer/app/features/loop/` and `src/renderer/app/features/workboard/`.

**Keep as a design check:** Keep objective constraints and completion evidence immutable under steering; presentation/notification projections must remain derived from authoritative lifecycle records, with dedupe never hiding an operator action request.

### No retained gap — Copilot SDK’s steering, queueing, persistence, and fleet mode

**What was examined:** Copilot offers immediate steering with a fallback to FIFO queueing, durable sessions with resumable checkpoints/artifacts, stream events that distinguish persisted from ephemeral data, session limits, and a fleet model coordinated through dependency-aware todos.

**Why this is not a new AIO recommendation:** AIO already has an approval-aware steer-or-queue fallback, editable queues with conditional per-instance persistence and parked-state recovery, persistent session continuity, cost/context controls, orchestration task contracts, and a Workboard that is broader than a session-local fleet view. Its conversation ledger and provider adapters are the right place to preserve stream semantics; duplicating Copilot SDK abstractions would create an overlapping control plane. OpenCode's stronger durable-admission semantics remain the P0 gap above.

**Source evidence:** `copilot-sdk/docs/features/steering-and-queueing.md`, `copilot-sdk/docs/features/session-persistence.md`, `copilot-sdk/docs/features/streaming-events.md`, `copilot-sdk/docs/features/session-limits.md`, and `copilot-sdk/docs/features/fleet-mode.md`.

**AIO comparison evidence:** `src/renderer/app/core/state/instance/instance-messaging.store.ts` and `src/renderer/app/core/state/instance/queue-persistence.service.ts` (queue, conditional persistence, steer promotion and parking); `src/renderer/app/features/instance-detail/composer-queue.component.ts` (edit/cancel/steer UI); `src/main/session/` (continuity); `src/main/orchestration/` and `src/renderer/app/features/workboard/` (orchestration and fleet-wide view).

**Keep as a design check:** Preserve the distinction between transient stream deltas and durable conversation evidence, and never let a best-effort steer disappear silently—downgrade it to a visible queued message as AIO currently does.

### No retained gap — Codex CLI’s configuration and execution-policy boundary

**What was examined:** The Codex repository’s configuration, sandbox, approval, skill, and app-server documentation plus its typed SDK/client boundaries.

**Why this is not a new AIO recommendation:** AIO already has provider-specific Codex app-server initialization, typed approval-policy mapping, a shared rule-based permission layer, project/session rule loading, and an operator security surface. The examined local `execpolicy.md` delegates to the public product documentation rather than exposing a reusable in-repository product workflow, so it does not justify a new backlog item on this evidence.

**Source evidence:** `codex/README.md`, `codex/docs/config.md`, `codex/docs/execpolicy.md`, `codex/docs/sandbox.md`, `codex/docs/skills.md`, and `codex/sdk/typescript/src/`.

**AIO comparison evidence:** `src/main/cli/adapters/codex/app-server-initializer.ts`, `src/main/cli/adapters/codex/app-server-types.ts`, `src/main/security/permission-manager.ts`, `src/main/instance/instance-manager.ts`, and `src/renderer/app/features/settings/settings-navigation.ts`.

**Keep as a design check:** When updating the Codex adapter, retain a visible mapping from AIO’s effective permission decision to the provider’s approval/sandbox settings; do not import global policy files or weaken AIO’s scoped approval boundary.

### No retained gap — Hermes’s durable queue and notification mechanics

**What was examined:** Hermes’s persistent per-session composer queue, foreground/background protection, native-notification routing, status-stack presentation, and desktop design-system rules.

**Why this is not a new AIO recommendation:** AIO already has the useful queue interaction mechanics—edit/cancel/steer actions, conditional per-instance persistence, quota parking, restart restoration when persistence is enabled, attachment-drop warning, and visible counts. Its Workboard and action-request surfaces also cover the broader notification/attention workflow. Hermes does not remove the P0 need for unconditional main-process admission with attachment references; its discrete retained contribution remains compaction preview.

**Source evidence:** `hermes-agent/apps/desktop/src/store/composer-queue.ts`, `hermes-agent/apps/desktop/src/app/session/hooks/use-prompt-actions/submit.ts`, `hermes-agent/apps/desktop/src/store/native-notifications.ts`, `hermes-agent/apps/desktop/src/components/chat/status-section.tsx`, and `hermes-agent/apps/desktop/DESIGN.md`.

**AIO comparison evidence:** `src/renderer/app/core/state/instance/instance-messaging.store.ts`, `src/renderer/app/core/state/instance/queue-persistence.service.ts`, `src/renderer/app/features/instance-detail/composer-queue.component.ts`, `src/renderer/app/features/workboard/`, and `src/renderer/app/features/instance-detail/user-action-request.component.ts`.

**Keep as a design check:** Keep background queue drains isolated from foreground transcript selection, and only send completion notifications when the recipient actually benefits; attention requests may be surfaced more aggressively than routine completion notices.

### No retained gap — Agent Orchestrator’s attention board and guarded feedback delivery

**What was examined:** Agent Orchestrator groups live sessions into an explicit attention model (working, needs-you, in-review, ready-to-merge), maintains a durable notification inbox, and centralises last-moment checks before unsolicited messages are injected into a terminal. Its PR/review reaction pipeline independently queues CI, review, and conflict nudges so one condition cannot hide another.

**Why this is not a new AIO recommendation:** These are sound patterns, but AIO already has a broader Workboard (“what needs you” across instances, loops, automations, and jobs), approval-aware input/steering with queue downgrade, a permission/action request surface, and a confidence-aware review/loop back-edge. Adding a second session-only board or a parallel notification/nudge system would fragment the existing control plane.

**Source evidence:** `agent-orchestrator/frontend/src/renderer/lib/session-presentation.ts` and `agent-orchestrator/frontend/src/renderer/components/SessionsBoard.tsx` (attention zones); `agent-orchestrator/frontend/src/renderer/components/NotificationCenter.tsx` (durable, paginated notification UX); `agent-orchestrator/backend/internal/sessionguard/guard.go` and `agent-orchestrator/backend/internal/lifecycle/reactions.go` (fail-closed delivery and independent PR/review reactions).

**AIO comparison evidence:** `docs/architecture.md` (Workboard, loop evidence gates, and instance state); `src/renderer/app/core/state/instance/instance-messaging.store.ts` (steer/queue fallback); `src/renderer/app/features/instance-detail/user-action-request.component.ts` (operator approval flow); `src/main/orchestration/loop-review-backedge.ts` (review confidence gate).

**Keep as a design check:** When evolving Workboard or automated follow-ups, ensure each item states the exact required human action, and ensure a suppressed delivery remains visibly pending rather than being marked delivered. Do not create another implementation merely to mirror AO.

### No retained gap — Claude Code’s Hookify and review plugin

**What was examined:** Claude Code’s Hookify plugin turns a natural-language correction or recurring conversation failure into a hot-reloaded, user-owned rule with a simple enable/disable flow. Its review plugin uses independent reviewers plus confidence filtering and skips inapplicable PRs before spending model time.

**Why this is not a new AIO recommendation:** AIO already exposes first-class custom hook rules with conditions, enablement, previews/tests, built-in safety patterns, lifecycle execution, and approval handling. Its orchestration review path already has confidence filtering, deduplication/ranking, and evidence-gated loop completion. A markdown-only shadow rule engine or a second review coordinator would reduce clarity and create inconsistent enforcement.

**Source evidence:** `claude-code/plugins/hookify/README.md` and `claude-code/plugins/hookify/skills/writing-rules/SKILL.md` (conversation-to-rule, hot reload, declarative rule format); `claude-code/plugins/code-review/README.md` and `claude-code/plugins/code-review/commands/code-review.md` (parallel reviews, validation, confidence threshold, applicability skips); `claude-code/.claude-plugin/marketplace.json` (plugin distribution model).

**AIO comparison evidence:** `src/main/hooks/hook-manager.ts`, `src/main/hooks/hook-engine.ts`, and `src/renderer/app/features/hooks/hooks-config.component.ts` (custom-rule lifecycle, matching, UI editing/testing); `src/main/orchestration/confidence-filter.ts`, `src/main/orchestration/review-thread-fingerprint.ts`, and `src/main/orchestration/loop-review-backedge.ts` (review signal filtering and completion gate).

**Keep as a design check:** In the Hooks UI, continue to prefer guided rule creation from an observed failure over exposing raw regex first; retain the existing typed-rule store and validation rather than copying Hookify’s filesystem format.

## UX recommendations

### P0 — Make memory trust visible, reviewable, and reversible

This is both a safety feature and a UX feature. Present generated memory as a concise card: proposed memory, source links, confidence/provenance, where it can be used, expiry, and buttons for **Keep as evidence**, **Promote after editing**, **Reject**, and **Supersede**. Show a “used by this session” badge from recall traces. The user should never need to infer why an old fact influenced an agent.

**Reference:** `OB1/integrations/agent-memory-api/index.ts` review endpoints and recall trace endpoint; `OB1/schemas/agent-memory/schema.sql` lifecycle/review/audit design.

### P1 — Consolidate start-time warnings into an actionable, progressive disclosure panel

Use a single low-noise panel near Run/Send that says what is ready, what is risky, what blocks execution, and what one action fixes each item. Keep non-blocking cost/context warnings dismissible but recorded. This avoids forcing people through a Doctor page for normal recovery.

**Reference:** `CodePilot/src/app/chat/page.tsx` run checkpoint flow.

### P1 — Publish a keyboard map that changes with context

Display only shortcuts valid in the current overlay, picker, transcript, or confirmation UI; provide a searchable command palette for the whole registry and allow users to export/reset their personal bindings. Make conflicts and platform-reserved keys explicit before saving.

**Reference:** `Actual Claude/keybindings/defaultBindings.ts`, `Actual Claude/keybindings/resolver.ts`, `Actual Claude/keybindings/validate.ts`.

### P1 — Preview manual compaction before it changes the working context

At the point where AIO currently shows **Compact Now**, offer a compact preview that says how much context will be summarised, what the latest protected exchanges are, and whether the percentage is measured or estimated. Let the user keep the latest N exchanges or choose a transcript boundary, then require a second explicit confirmation to apply. The resulting transcript event should link to the pre-compaction checkpoint and explain the preservation boundary.

**Reference:** `hermes-agent/hermes_cli/partial_compress.py`; AIO’s current action is `src/renderer/app/features/instance-detail/context-warning.component.ts`.

### P1 — Show why automation made an operational decision

Add a small decision timeline to Workboard detail rather than making people reconstruct recovery, throttling, review, and escalation reasoning from status labels and logs. Each entry should use plain language, name the source policy/rule, state the resulting action, and expose only the next relevant operator control. This should be a projection of existing authoritative events, not an independently editable audit feed.

**Reference:** `claw-code/rust/crates/runtime/src/policy_engine.rs`; AIO’s current correlated view is `src/renderer/app/features/workboard/workboard-projection.ts`.

### P2 — Keep long-history loading calm and predictable

When scrolling backwards, show a lightweight “Loading earlier messages” boundary and retry action rather than jumping the transcript or displaying a generic failure. Cursor pagination enables this interaction without fetching an entire session at once.

**Reference:** `Actual Claude/assistant/sessionHistory.ts`.

### P1 — Let users annotate diff lines and send one structured review packet

Allow selection of one or more old/new-side ranges, attach local comments, keep a review draft, and send the bundle to the active instance or Loop. Each annotation should carry path, side, range, exact excerpt, comment, checkpoint/work hash, and stale/re-anchored state; render the same objects in the diff and transcript.

**Reference:** `t3code/apps/web/src/components/diffs/AnnotatableCodeView.tsx`, `t3code/apps/web/src/components/files/fileCommentAnnotations.ts`, `t3code/apps/web/src/reviewCommentContext.ts`, and mobile parity under `t3code/apps/mobile/src/features/review/`. AIO targets are `src/renderer/app/shared/components/diff-viewer/`, `src/renderer/app/features/source-control/`, and `src/renderer/app/features/instance-detail/instance-review-panel.component.ts`.

### P1 — Add a session-linked live preview with human/agent co-annotation

Show an AIO-managed remote browser viewport beside the session, including the agent's current pointer/activity. Let the user select a DOM element, draw a region/stroke, attach a style/change request, capture a redacted crop, and send a typed annotation to the exact instance. This makes visual verification and correction part of the work loop instead of a screenshot detour.

**Reference:** `t3code/apps/web/src/components/preview/PreviewView.tsx`, `t3code/apps/web/src/components/preview/PreviewPanel.tsx`, `t3code/apps/web/src/components/preview/AgentBrowserCursor.tsx`, `t3code/apps/web/src/lib/previewAnnotation.ts`, and the browser device/resize/recording helpers in `t3code/apps/web/src/browser/`. AIO's current Browser page explicitly remains a control surface rather than a viewport at `src/renderer/app/features/browser/browser-page.component.html`.

**Guardrail:** Remote/AIO-managed browser only. Never infer permission to control James's local Mac browser; retain browser grants, approvals, credential isolation, screenshot redaction, keyboard accessibility, and target/tab/session identity.

### P2 — Collapse very large pastes into inspectable composer tokens

When a paste crosses a line/character threshold, replace it visually with a token such as **Pasted text · 143 lines** while preserving exact content. Let the user inspect, edit, remove, undo, copy, and see the token estimate before sending. The token must remain screen-reader labelled and visibly distinguish secret-scan warnings.

**Reference:** `pi/packages/tui/src/components/editor.ts` (atomic paste markers, paste registry, exact expansion, thresholding, and undo). AIO currently uses a normal textarea in `src/renderer/app/features/instance-detail/input-panel.component.html` and `src/renderer/app/features/instance-detail/input-panel.component.ts`.

### P1 — Make Council useful before every member finishes

Render provider cards immediately with independent progress, preserve completed cards across navigation/reload, and keep synthesis enabled once enough answers exist. Let the user synthesize with AIO consensus, debate, or one chosen provider; name missing/failed members and retain citations to each source answer.

**Reference:** `online-orchestrator/multi-ai-query/sidepanel/sidepanel.js` for the interaction pattern; implement through AIO's `src/main/compare/multi-provider-compare-service.ts` and `src/renderer/app/features/compare/ask-council-page.component.ts`, never its DOM injection.

### P1 — Give conversation forks a visible map

Add a compact branch rail/tree showing where each fork began, its label/summary, the current path, and folded alternate paths. Include filters for user turns and hidden tool noise, and keep orchestration child agents visually distinct from alternate versions of one conversation.

**Reference:** `pi/packages/coding-agent/src/core/session-manager.ts` and `pi/packages/coding-agent/src/modes/interactive/components/tree-selector.ts`; AIO already exposes fork actions in `src/renderer/app/features/instance-detail/output-stream.component.ts` and preserves summaries in `src/main/context/branch-summarizer.ts`.

### P1 — Keep the transcript stable under prepend, streaming, and expansion

Replace indefinitely growing DOM windows with measured dynamic-height virtualization. Preserve the semantic visible message rather than only pixel `scrollTop`, cache measurements per session, and benchmark prepend, stream growth, disclosure expansion, nested scrolling, focus, find/jump, and session switching.

**Reference:** `opencode/packages/app/src/pages/session/timeline/message-timeline.tsx` and `opencode/packages/app/e2e/performance/timeline-stability/README.md`; AIO's current growing render window is `src/renderer/app/features/instance-detail/output-stream.component.ts`.

### P1 — Use one calm progress receipt in Discord and other editable channels

For work lasting more than a short delay, update one bounded **Working…** message with safe status/plan/tool summaries, then collapse or replace it at completion. Avoid sending the draft for quick turns, and fall back to existing fresh messages where channel edits are unavailable.

**Reference:** `openclaw/src/channels/progress-draft-compositor.ts`, `openclaw/src/channels/progress-draft-lines.ts`, and channel integrations under `openclaw/extensions/`; AIO already has the required capability seam in `src/main/channels/channel-adapter.ts` and Discord `editMessage` support.

### P1 — Make automation authority readable at a glance

In the automation form and preflight, show separate cards for **May access**, **May publish/change**, **Must ask before**, **Stops when**, **Verification**, and **Report destination**. Mark each statement as technically enforced or instruction-only. Templates should make the safe common cases one click without hiding the resulting contract.

**Reference:** `openclaw/docs/automation/standing-orders.md`; AIO targets are `src/renderer/app/features/automations/automation-form-model.ts` and `src/renderer/app/features/automations/automations-page.component.html`.

### P2 — Turn RTK statistics into actionable local health cards

Show **eligible commands bypassed**, **parser failures with safe fallback**, **top unsupported commands**, **recent project adoption**, and **estimated missed savings**, each with one next action. Keep session-log discovery an explicit, date-bounded local scan with paths/arguments redacted.

**Reference:** `rtk/src/discover/report.rs`, `rtk/src/core/tracking.rs`, and `rtk/src/analytics/gain.rs`; extend AIO's `src/renderer/app/features/settings/rtk-savings-tab.component.ts` rather than adding a separate page.

## Coverage table

| Project | Status | Retained themes | Notes |
| --- | --- | --- | --- |
| Actual Claude | Reviewed | Contextual keyboard system; cursor history | Source snapshot appears compiled/transformed in places; recommendations rely on readable source paths only. |
| CodePilot | Reviewed | Start-time checkpoint UX; persisted scheduler reference | AIO already covers many adjacent areas; no recommendation to duplicate providers/remote bridge. |
| CodexDesktop-Rebuild | Reviewed | Packaging isolation only | No substantive loop or UX feature found; use only as a release-engineering reference. |
| OB1 | Reviewed | Governed memory review and recall trace UX | Strong complement to AIO’s existing provenance gate. |
| agent-orchestrator | Reviewed | No retained gap: attention board / guarded nudges | AIO’s Workboard, approval-aware messaging, and loop review gates already subsume the useful pattern. |
| claude-code | Reviewed | No retained gap: Hookify / review workflow | AIO’s typed hook UI/engine and confidence-filtered orchestration review already provide the stronger integrated form. |
| claw-code | Reviewed | Typed policy-decision timeline | Retained a causal Workboard detail; task/lane board itself is already covered by AIO. |
| codex | Reviewed | No retained gap: provider policy boundary | Local docs defer execution-policy detail; AIO already wraps Codex policy in its scoped approval layer. |
| codex-plugin-cc | Reviewed | No retained gap: review/rescue/transfer broker | AIO already has native adversarial review, durable jobs, evidence gates, Claude import, provider handoff, and Codex app-server integration. |
| copilot-sdk | Reviewed | No retained gap: steering, durable session, fleet | AIO already supplies the integrated control plane; retain transient-versus-durable event distinction as a design check. |
| hermes-agent | Reviewed | Bounded manual-compaction preview | Queue, notification, and status mechanics are already present; compaction preview is the discrete retained UX gap. |
| jean | Reviewed | No retained gap: wakeup/scheduler/control surface | AIO already has broader durable wakeups, automation recovery, remote-node, and overlay systems; retain wakeup supersession/restart correctness as a design check. |
| mempalace-reference | Reviewed | No retained gap: recall/write routing | AIO’s retrieval governance is broader; keep explicit fallback-versus-required policy reason wording when adding memory UX. |
| nanoclaw | Reviewed | Opt-in contained execution profile | A distinct OS-level boundary for unattended runs; plan only after a provider/runtime capability inventory. |
| oh-my-codex | Reviewed | No retained gap: durable goal/notification lifecycle | AIO already owns a stronger integrated loop/evidence/workboard system; retain immutable-objective and derived-notification checks. |
| oh-my-opencode-slim | Reviewed | Prompt-cache structural contracts; guided interview | Core background orchestration/Council/loop shell is already subsumed by AIO; keep only the prevention and requirements-workflow gaps. |
| online-orchestrator | Reviewed | Progressive Council results and synthesis UX | Do not copy DOM injection or broad browser permissions; implement through AIO's provider adapters and synthesis engines. |
| openclaw | Reviewed | Tool-loop guard; Skill Workshop; authority contracts; progress drafts; queue policies | AIO already covers the core queue, compaction, gateway, plugin, picker, and workboard systems. |
| opencode | Reviewed | Durable prompt inbox; context epochs; transcript virtualization; confined batch-tool reference | File/review panels, lazy MCP, output externalization, replay, and scoped permissions already exist in AIO. |
| pi | Reviewed | Conversation branch tree; declarative plugin UI; large-paste tokens | Provider loop, project trust, external editor, awaited hooks, and TUI renderer are no-gap or platform-specific. |
| rtk | Reviewed | RTK adoption and quality Doctor | Keep filtering, recovery, trust, and tracking in the RTK binary; expose existing local evidence more usefully. |
| storybloq | Reviewed | Evidence-anchored findings; exact review coverage and angle cache | AIO's Loop/health/federation/memory systems are stronger; Storybloq's review proof standard is the discrete gap. |
| t3code | Reviewed | Inline diff comments; live browser co-annotation | Worker/runtime, Plan Mode, remote, worktree, checkpoint, and offline patterns are already covered. |
| tura | Reviewed | Governed batch/step-tool experiment | Compaction, manuals, backward reasoning, rich output, process lifecycle, and benchmarking add no separate gap. |
