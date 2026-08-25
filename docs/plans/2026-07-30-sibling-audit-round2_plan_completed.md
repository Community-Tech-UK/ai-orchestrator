# Sibling-Audit Round 2 — Consolidated Implementation Plan

**Date:** 2026-07-30
**Status:** COMPLETED 2026-07-31 (code-complete; live validation deferred per
`2026-07-30-sibling-audit-round2_livetest.md`). Approved by James in chat ("resolve all
these issues yourself, best architecture, unlimited time/resources"). Amended 2026-07-30
with Codex (gpt-5.5) adversarial review findings.

**Completion summary:** all 26 workstreams closed (25 implemented + WS-B5 closed as
investigated-no-change). Every workstream passed the full gate suite and an independent
fresh-eyes review; five workstreams required FAIL→fix→PASS cycles that caught real
defects (queue durability ordering, adjudicator breaker reset, renderer settings
self-grant bypass, dishonest stale review packets, schema-rejects-own-default). Two
genuine live bugs found and fixed along the way (process-group kill leaks; overlay Escape
reaching interruptInstance). Final campaign gate: 1,718 files / 17,857 tests green, all
three tsc configs, lint, LOC ratchet, build:main, both IPC verifiers. B1 phases 2–4 and
the §7 deferred backlog are the designated next-campaign material. Nothing committed —
working tree only, per standing rules.
**Sources:** `codex_todo.md` (root, Codex audit, 2026-07-26) and `fable_todo.md` (root, Fable 14-agent audit, 2026-07-30), both covering the same ~24 sibling projects under `/Users/suas/work/orchestrat0r/`.
**Predecessor:** `docs/fable_todo_completed.md` → the 2026-07-13 fable plan (16 workstreams, closed). This is round two over a newer, larger corpus.

---

## 1. How this plan was built (read this first)

The two source backlogs are **not equally reliable about AIO's current state**, and the plan
is structured around that fact:

- `codex_todo.md` verified every claim against AIO source with `file:line`-level comparison
  evidence and explicitly triaged 24 projects into retained gaps vs "no retained gap". Its
  AIO comparisons spot-checked accurate. **It is the authoritative backbone of this plan.**
- `fable_todo.md` is the richer catalogue of *source-project* mechanisms (≈140 items), but
  several of its load-bearing "AIO lacks X" claims are wrong or stale. Verified 2026-07-30:

| fable_todo claim | Reality (verified in source) |
| --- | --- |
| "AIO has no compaction at all (verified by grep)" | `src/main/context/compaction-coordinator.ts`, `context-compactor.ts` exist and are wired to UI (`context-warning.component.ts`) |
| "AIO has four CLIs and zero handoff paths" | `src/main/session/handoff-state-service.ts` exists |
| "AIO has diffs but no turn-level undo" | `src/main/session/checkpoint-manager.ts`, `git-checkpoint-store.ts`, `src/renderer/app/features/checkpoints/` exist |
| "AIO shows none of this [context visibility]" | `src/main/context/context-attribution-service.ts` + `context-attribution-panel.component.ts` exist |
| "treats [providers] as alternatives, not an ensemble" | `consensus-coordinator.ts`, `debate-coordinator.ts`, `multi-verify-coordinator.ts`, `src/main/compare/multi-provider-compare-service.ts` exist |
| "AIO's MCP surface is the pathological case" (no deferral) | `src/main/mcp/mcp-tool-search.ts`, `mcp-runtime-tool-context.ts` exist (lazy ranked selection) |

- fable claims that **did** verify as real gaps: **no PR-creation path anywhere in
  `src/main`** (grep for `createPullRequest|gh pr create|octokit` returns nothing), session
  import is **Claude-only** (`src/main/history/native-claude-importer.ts` is the only
  importer), and `DoomLoopDetector.recordToolCall()` has no production caller (matches
  codex P0).

**Consequence:** every fable-sourced workstream below carries a mandatory **Discovery gate**
that re-verifies the gap against current source before any code is written. Where the two
audits disagree, codex_todo wins unless fresh verification says otherwise. Where they agree
(governed memory, tool-loop wiring, evidence-anchored reviews, durable prompt admission),
confidence is highest — those are Tier A.

## 2. Ground rules (apply to every workstream)

1. **Never copy source code or licensing** from sibling projects. Reimplement behaviour
   after an AIO-specific design pass. Source paths are references only.
2. **Discovery gate before implementation.** Each WS starts by reading the named AIO
   surfaces and confirming the gap still exists. If the gap is already covered, record that
   in this plan and close the WS without code.
3. **One workstream per run** (same convention as the 2026-07-13 fable plan). Implement from
   this plan, not from the todos.
4. Full canonical verification checklist per WS (`tsc` both configs, lint, ts-max-loc,
   `build:main`, `test:quiet`), plus the fresh-eyes completion gate before closing.
5. Existing architecture idioms: main-process singletons with `_resetForTesting()`, Zod IPC
   schemas, signal stores, standalone OnPush components. No second health system, no second
   policy engine, no shadow authority next to an existing one — both audits repeatedly
   flagged this as the failure mode to avoid.
6. Renderer-facing additions preserve accessibility (labelled controls, keyboard paths).
7. Checks needing a rebuilt/restarted app go into a `_livetest.md` per the deferral rules.

## 2a. Codex adversarial-review amendments (2026-07-30)

A Codex (gpt-5.5) review of this plan produced these accepted amendments, folded into the
workstreams below:

1. **One admission authority, not two** (was a BLOCKER): WS-A1 and WS-A5 are implemented as
   a single main-process `SessionAdmissionService` adjacent to `SessionTurnSupervisor`
   (`src/main/session/session-turn-supervisor.ts` already anticipates routing `sendInput`
   admission through it). WS-A5 is that same service extended to automated writers.
2. **WS-B4 is a hard gate**: no workstream that adds or changes prompt/context injection
   (A1 promotion, A2 canary, A4 injection, B8 proposals, B9 review prompts) starts before
   the stable-prefix contract exists. Sequenced as "Phase 0.6".
3. **WS-A2 wires at canonical ingress** (`adapter-runtime-event-bridge.ts` /
   `instance-communication-provider-events.ts`), never per-adapter — one detector, all
   providers, including plugin providers.
4. **WS-A3 anchor artifact is produced before reviewer prompting** (in
   `headless-review-runner.ts`), and anchor status is preserved through
   `review-finding-aggregation.ts`; parsing-time anchoring alone is insufficient.
5. **WS-A4 stores a generic `GovernedProposal`** (`kind: memory | skill | hook | rule`);
   the Tier A UI renders only `memory`, but WS-B8 reuses the same store — one review inbox.
6. **WS-B1 depends on an external-publish authority**: PR creation lands only after the
   never-delegable `external_publish` category (WS-B3) or a minimal equivalent guard exists
   in the permission layer.
7. **New WS-B10 — provider runtime event taxonomy hardening** (fable shortlist #12,
   wrongly dropped): richer closed event classes, explicit unknown-item handling, and
   persisted-vs-ephemeral semantics in
   `packages/contracts/src/types/provider-runtime-events.ts`, scheduled before WS-A2 grows
   bespoke normalization.
8. **Numeric acceptance for near-covered gaps** (WS-B5, WS-C2, P0.5): each must state the
   measured current state before any UI/behaviour change is justified.

## 3. Phase 0 — cheap verifications and small wins (single run, do first)

Small, independent items; each is minutes-to-hours, not days. Verify → fix or record.

> **As-built status (2026-07-30):** all five items done. P0.1 fixed at seven sites (the
> four adapter turn-timeout handlers, plus `cli-status-probe.ts`, cursor and copilot model
> discovery — the latter three with a group-kill-first / plain-kill-fallback pattern since
> their spawn detachment varies). P0.2 done at two boundaries (`output-persistence`,
> `context-local-summary`) via new `src/main/context/never-worse.ts`; the microcompact
> guard already existed (commit c7e0ebab) and got a lock-in test. P0.3 done via
> `src/main/memory/format-age.ts` at three render sites (day-granularity for cache
> friendliness). P0.4 done: `src/main/security/shadowed-rule-detector.ts` + read-only
> "Rule analysis" section in permissions settings, IPC channel
> `permission:analyze-shadowed-rules`. P0.5 closed as recorded — no code change (see item
> note). Gates: tsc ×2, lint, ts-max-loc (after moving `ALL_PERMISSION_SCOPES` into the
> detector module), build:main all green; fresh-eyes completion gate returned
> **VERDICT: PASS** with no findings. Side fix: `scripts/run-tests-quiet.js` gained
> `AIO_TEST_OUT_SUFFIX` so concurrent sessions stop clobbering each other's report files.

- **P0.1 Process-group kill bug** (jean A7): **verified real, scoped.** Main terminate
  paths correctly use `killProcessGroup()` (`base-cli-process-utils.ts`), but per-call
  timeout handlers in four adapters kill only the wrapper PID:
  `copilot-cli-adapter.ts:563`, `cursor-cli-adapter.ts:414`, `gemini-cli-adapter.ts:409`,
  `antigravity-cli-adapter.ts:221` use `this.process.kill('SIGTERM')` instead of
  `killProcessGroup(pid, 'SIGTERM')`. Fix all four.
- **P0.2 `never_worse` output guard** (rtk A6): one guard at the boundary of AIO's
  summarizers/compaction/evidence formatting — return the filtered form only when its
  estimated tokens are lower than raw, else raw. ~20 lines + tests.
- **P0.3 Memory staleness caveats** (Actual Claude A15): Codemem/memory recall renders ages
  human-readably ("47 days ago") and appends a verify-before-asserting caveat to memories
  older than a threshold; keep gotchas, suppress stale usage-reference notes. Small change
  in recall formatting.
- **P0.4 Shadowed permission-rule lint** (Actual Claude A19): static pass over AIO's layered
  permission rules reporting rules that can never fire (shadowed by a broader ask/deny),
  surfaced in the settings GUI. Discovery: confirm `permission-registry.ts` layering makes
  this feasible cheaply.
- **P0.5 `no_signal` grace concept check** (agent-orchestrator A3): **investigated
  2026-07-30 — largely already handled.** Remote instances have a 120s heartbeat-stale
  waitReason (`idle-monitor.ts:129–159`); `ActivityStateDetector` (activity-state-detector.ts:41–56)
  runs a four-level cascade (activity JSONL → native CLI signal → age decay → process
  check) so `activityState` carries blocked/exited truth independent of `lastActivity`.
  Remaining caveat: a **local** instance between turns with a dead event pipeline decays to
  'ready'/'idle' by age rather than being flagged. Recorded here as a known limitation; no
  Phase 0 code change. Revisit only if livetest evidence shows real wedges being missed.

## 4. Tier A — P0 workstreams (both audits agree; gaps verified)

> **WS-A1+A5 Phase A as-built (2026-07-30):** DONE (Phase B — renderer queue as
> projection — in progress). `session-admission-store.ts` (RLM db, mirrors
> durable-approval-store; 14d retention, 50-pending cap) + `session-admission-service.ts`
> (suppression-default outcome union; decide() reads live state only, persistence
> fail-soft). Six unsafe writers gated: channel router (was sending through
> `waiting_for_permission`), automation wakeups, reactions, consensus completion
> write-backs, LSP feedback, browser-gateway nudges — each with reasoned
> suppress/refire/drop semantics; event-driven refire re-decides before delivery.
> Observe-only receipts on user sends. IPC `session:admissions-list`. Fresh-eyes PASS;
> full suite 16,952 green. LOC growth refactored into `channel-admission-delivery.ts`,
> `session-admission-handlers.ts`, `consensus-result-injection.ts`,
> `reaction-feedback-delivery.ts`, `session-admission.schemas.ts`.

### WS-A1 Durable main-process prompt admission inbox
- **Sources:** codex P0 (opencode `session_input`/`PromptAdmitted`); fable jean A8/B5/B6 for
  later queue UX.
- **Verified gap:** queue persistence is renderer-driven, debounced, conditional on
  settings, and restores without attachments (`queue-persistence.service.ts`).
- **Scope:** one main-process `SessionAdmissionService` (adjacent to
  `SessionTurnSupervisor`, which already anticipates owning `sendInput` admission) with
  stable IDs and durable SQLite-backed admission receipts before a queued/steered input is
  acknowledged; typed origins (`user`, `renderer-queue`, `mobile`, `doc-review`, `channel`,
  `automation`, `loop`, `remote-node`, `mcp`); atomic promotion into model-visible history
  at a safe boundary; attachment content references preserved; idempotent
  admitted/promoted states; bounded retention and privacy controls. Renderer store becomes
  a projection/compat shim. This service is also WS-A5's chokepoint — one authority.
- **Out of scope (deferred):** queue-policy UX (steer/follow-up/collect/interrupt modes) —
  explicitly blocked on this WS landing first (codex P2).
- **Acceptance:** kill the renderer mid-queue → nothing lost, attachments intact; duplicate
  admission impossible under promotion races; provider-specific steering unchanged.

> **WS-A2 as-built (2026-07-30):** DONE. `doom-loop-detector.ts` rewritten for normalized
> observations, fed from the true canonical funnel `InstanceManager.emitProviderRuntimeEvent`
> (wiring extracted to `instance-tool-loop-wiring.ts`). Detectors: repeat-no-progress
> (resets on changed result — changing polling never flagged), ping-pong, runaway cap,
> post-compaction canary; warn-once/critical-at-2× per turn; fail-open; turn resets via
> supervisor hooks. Warnings always on (`instance:doom-loop` strict-schema renderer event +
> toast); auto-interrupt gated by new `toolLoopAutoInterrupt` setting (default OFF,
> $AIO_MCP-settable), once per turn. NOTE: AIO observes CLI tool calls and cannot veto
> them — protection is warn + optional interrupt, never in-CLI blocking. Fresh-eyes PASS.
>
> **WS-A1 Phase B as-built (2026-07-30):** DONE after one fresh-eyes FAIL→fix→PASS cycle.
> Renderer queue is now a projection of the durable admission inbox: `queued`/`promoting`
> states + CAS promotion (double-promote = no-op), attachments staged in the existing
> content-addressed ContentStore and restored as real File objects, one-time legacy
> ElectronStore migration, in-service recordUserSend dedupe. Review findings fixed:
> synchronous `notDurable` marker before the IPC round-trip with toast-once + backoff
> retries, promote-then-remove ordering, per-message attachmentsDropped flag on partial
> blob loss. Tier A closure gate: full suite 17,070 tests green.

### WS-A2 Wire result-aware tool-loop protection into ordinary sessions
- **Sources:** codex P0 (openclaw detectors, post-compaction canary); fable hermes A5,
  jean A5 (terminal-vs-transient error classifier).
- **Verified gap:** `doom-loop-detector.ts` has no production `recordToolCall()` caller.
- **Scope:** feed a refactored `DoomLoopDetector` (normalized `ToolUseObserved` /
  `ToolResultObserved` events, new `tool-loop-normalizer.ts` for volatile-field stripping
  and result hashing) from the canonical ingress — `adapter-runtime-event-bridge.ts` /
  `instance-communication-provider-events.ts` — never per-adapter; detect identical-call-identical-result repeats, unchanged polling, A/B
  ping-pong, and a global runaway cap; warn first, block only on demonstrated no-progress;
  arm a stricter short canary after automatic compaction. Fail open on incomplete data;
  scope history to one run; reset on lifecycle boundaries.
- **Acceptance:** polling whose result changes is never blocked; approval-pending pairs
  don't false-positive; events reach the existing renderer forwarding path; unit tests per
  detector.

> **WS-A3 as-built (2026-07-30):** DONE. `review-artifact-anchor.ts` persists the exact
> reviewed diff/output (bounded 6×32K in LoopState, checkpoint-persisted, stripped from
> renderer broadcasts) BEFORE reviewer prompting; findings carry optional
> anchor/anchorStatus/evidenceClass via an `#EVIDENCE#` prompt tail (parser never reads
> evidenceClass from model output — verified no self-claimed deterministic-gate bypass).
> Blocking now requires deterministic-gate OR severity+verified/re-anchored quote;
> unverifiable severity findings demote to visible-advisory with demotedReason. Five
> fixtures honestly updated. Known trade-off: >32K diffs can truncate a quote into
> demotion. Fresh-eyes PASS; full suite green.

### WS-A3 Evidence-anchored, injection-hardened review findings
- **Sources:** codex P0 (storybloq quote-anchor verification); fable jean A15 (untrusted-
  diff injection defense, `introduced_by_diff`, mandatory failure_scenario), OMX A16
  (locatable-evidence completion gate).
- **Verified gap:** `FreshEyesFinding` can veto completion on severity with only
  title/body/file/confidence — a hallucinated or mislocated finding forces loop cycles.
- **Scope:** the exact redacted anchoring artifact is built **before reviewer prompting**
  (new `review-artifact-anchor.ts` beside `headless-review-runner.ts`) and its hash carried
  through aggregation; blocking findings must carry file, side/range, exact quote (or hash)
  verified against that artifact/work hash; unique-match realignment for moved
  lines, else classify `evidence_unverified` (visible, non-blocking); explicit classes for
  localized / unlocalized-advisory / deterministic gates (secret detection stays trusted).
  Add injection-hardening lines and the machine-checkable finding schema to review prompts
  per prompt-engineering house style.
- **Acceptance:** an unverifiable finding cannot block completion and is visibly explained;
  moved-line realignment covered by tests; secrets gate unaffected.

> **WS-A4 as-built (2026-07-30):** DONE. RLM migration 056 (`governed_proposals` +
> `proposal_audit`), `governed-proposal-store.ts`/`-service.ts` (capture hook parallel to
> the unchanged lesson path, dedupe-reinforce, backfill-once, startup rehydration into the
> in-memory LessonStore), gate extended with exactly one value — `user-approved`, settable
> only via audited approve() (IPC schemas accept no provenance field) — `agent-derived`
> still blocked from instruction tier. `/memory-review` inbox page (approve /
> edit-then-approve / reject + history) wired into routes/nav/help. Fresh-eyes PASS;
> full suite green. Worker-closure ceiling documented +1 for the migration file;
> route-parity spec updated.

### WS-A4 Governed memory promotion review queue
- **Sources:** codex P0 #1 + fable OB1 A5–A7 (trust ladder, use policy, recall traces,
  used/ignored feedback) — the top pick of **both** audits.
- **Verified gap:** the provenance instruction gate exists but is implicit in storage and
  diagnostics; no operator workflow to inspect/promote/reject agent-derived memory.
- **Scope:** a generic `GovernedProposal` store (`kind: memory | skill | hook | rule`;
  SQLite tables for proposals + audit events, new `governed-proposal-store.ts` +
  review service under `src/main/memory/`) reusing the existing memory
  authorities (lesson store, recall traces, instruction gate) rather than duplicating them.
  Local-only review inbox UI rendering `memory` proposals first: provenance, scope,
  originating session/tool evidence, use policy snapshot, expiry; actions confirm / edit-
  then-promote / reject / supersede; audit trail; "used by this session" badge from recall
  traces. WS-B8 later writes its proposals into this same store — one review inbox.
  Generated memory stays advisory by default; never store raw reasoning or secrets.
- **Acceptance:** promotion is reversible and audited; instruction-tier use requires
  explicit promotion; UI renders provenance for every card.

### WS-A5 Single automated-writer chokepoint ("sessionguard")
- **Sources:** fable agent-orchestrator A6.
- **Discovery gate:** inventory every automated writer into a session (automations, loop,
  reactions, doc-review, MCP `send_chat_message`-equivalents, remote nodes, channel
  adapters, mobile gateway) and how each currently checks "is this session awaiting the
  human". Memory notes the mobile gateway has its own queue and the renderer owns
  send-while-busy — confirm main-process paths are the unguarded ones.
- **Scope (if gap confirmed):** the WS-A1 `SessionAdmissionService` extended to automated
  writers — not a separate guard. Every automated write funnels through it with its typed
  origin; it re-reads session state immediately before writing and returns a typed outcome
  whose **zero value is a suppression**, so a forgotten assignment can never read as a
  successful send; suppressed deliveries stay visibly pending and re-fire when workable.
  Known writers to route: doc-review delivery coordinator, mobile input queue, channel
  message router, automation thread-wakeup runner, loop interventions.
- **Acceptance:** no automated path can answer a permission dialog by writing into a parked
  session; suppression outcomes are logged and testable; renderer/user sends unaffected.

## 5. Tier B — P1 workstreams: delivery loop and provider leverage

> **WS-B1 phase 1 as-built (2026-07-31):** DONE after one fresh-eyes FAIL→fix→PASS cycle
> (critical: the renderer settings coercion's typeof fallback would have let renderer code
> self-grant `allowPrCreation` — fixed by schema-hardening ALL three structured closed-tier
> settings incl. projectPluginTrust and rejecting structured no-schema fallthrough
> entirely; a shared symlink-canonicalization gap in project-plugin-trust was found and
> fixed in the same round). `pr-creation-service.ts`: gates in strict order — per-project
> `allowPrCreation` opt-in (default OFF, schema-validated, human-settings-UI-only: MCP
> tools and privileged CLI both blocked) → `external_publish` never-delegable permission
> (deny honored without asking; 'allow' treated as invariant violation and still asks) →
> blocking Electron dialog approval covering push+PR as one action → array-args gh spawn
> with group-kill timeout. Evidence recorded on success only. IPC `vcs:create-pull-request`
> shipped; loop-UI button deferred (no clean host component — documented follow-up).
> Honest caveat recorded: same-path TOCTOU (directory swapped to symlink post-approval)
> out of scope. Live gh round-trip + approval dialog → livetest.
> **Phases 2–4 (PR facts polling → Workboard states, terminate-on-merge, issue intake):
> NOT started — next-phase backlog.**

### WS-B1 PR pipeline: prompt → worktree → PR → CI → review → merge → teardown
- **Sources:** fable agent-orchestrator A4/A5/A7, jean A3/A4/B15, Actual Claude A10.
- **Verified gap:** genuinely none of this exists — no PR-creation path in `src/main`
  (grep-verified); the existing `github-pr-poller` feeds only reaction-auto-merge; an
  autonomous loop's output today terminates at a local branch.
- **Phasing:** (1) PR creation from a completed loop/worktree via `gh` with explicit user
  authorization semantics; (2) provider-neutral PR facts observation (ETag-guarded polling,
  typed transitions → needs_input / ready_to_merge / merged notifications) feeding
  Workboard; (3) terminate-on-merge / teardown; (4) later, assignee-scoped issue intake
  (mandatory assignee filter rail) as a separate follow-up plan.
- **Guardrails:** pushing/PR-opening is an outward-facing action — per-project opt-in and
  explicit authority, never a silent default. **Dependency (Codex amendment):** phase 1
  lands only after WS-B3's never-delegable `external_publish` category (or a minimal
  equivalent guard) exists in the permission layer, so PR creation is not a special-case
  approval path. Respect AIO worktree lifecycle (AIO owns
  harvest/promotion). No second scheduler; intake rides the automation system.
- **Acceptance per phase:** phase 1: a loop can end with a PR URL recorded as evidence;
  phase 2: Workboard shows PR-derived attention states from typed facts.

### WS-B2 Adopt external CLI sessions for all four providers
- **Sources:** fable jean A18 (per-CLI on-disk history discovery, worktree filtering,
  noise-message stripping), CodePilot B7 (JSONL parser + import dialog with cwd/branch/
  counts/preview); codex confirmed AIO has `native-claude-importer.ts` only.
- **Discovery gate:** map Codex (AIO uses per-instance `CODEX_HOME` — external sessions
  live in `~/.codex/sessions`), Gemini, and Copilot on-disk session formats and resume
  semantics; confirm what "adopt" can honestly mean per provider (import-as-history vs
  live resume). Do not fake resume where no resume id exists (jean A12 rule).
- **Scope:** discovery of terminal-started sessions scoped to known workspaces; import
  dialog with provenance preview; injected-noise filtering on render; per-provider resume
  where the CLI supports it.
- **Acceptance:** a session started in a terminal appears adoptable in the GUI with honest
  capability labelling; no fabricated resume.

> **WS-B3 as-built (2026-07-31):** DONE after one fresh-eyes FAIL→fix→PASS cycle (critical:
> breaker reset didn't clear the tripped flag — permanent adjudication disable, masked by a
> test gap; fixed + test rewritten to trip→blocked→reset→consulted-again→fresh-streak).
> Never-delegable categories (`credentials`/`billing`/`external_publish`/
> `interactive_question`) forced to 'ask' BEFORE YOLO and structurally bypassing the
> decision cache (`approval-category.ts` + guard in checkPermission); explicit categoryHint
> for publish/billing callers — WS-B1 must set `external_publish`. Guardian adjudicator
> (`approval-adjudicator.ts`): opt-in via `approvalAdjudicationEnabled` (default OFF), new
> `approvalAdjudication` aux-LLM slot, Zod-validated verdicts, fail-closed on
> malformed/timeout/unavailable, unattended = active-loop instances only, audit
> `resolved_by='adjudicator'` with risk/reason detail. 3-denial breaker per instance, human
> decision un-trips, state cleaned on terminate. Deliberately unwired surfaces documented:
> `permission_denial` metaType (allow is a no-op there) and orchestrator-tool asks.

### WS-B3 Approval adjudication: Guardian + denial breaker + never-delegable categories
- **Sources:** fable codex A1 (Guardian LLM adjudicator, fail-closed, denial caps),
  Actual Claude A17 (3-consecutive-denials circuit breaker, soft_deny), CodePilot A12
  (auto_review is a reviewer not a bypass; HUMAN_ONLY categories; who-decided audit),
  CodePilot B3 (edit-before-approve, deny-with-message, timeout ≠ deny).
- **Discovery gate:** map AIO's current auto-approve surfaces (`permission-registry.ts`,
  adapter auto-approve flags, YOLO modes) and the Task 18 finding that agent rules can
  override system denies if priority is unenforced.
- **Scope:** an opt-in adjudicator for on-request approvals in unattended runs: compacted-
  transcript-budgeted review, strict JSON verdict, fail closed on timeout/malformed output,
  consecutive-denial cap that reverts to human prompting; **never-delegable categories**
  (credentials, billing/spend, external publish, interactive questions) enforced in the
  permission layer, not prompts; who-decided audit distinguishing user / adjudicator /
  rule-engine; approval UI gains deny-with-message and (where provider supports it)
  edit-input-before-approve; timeout-deny rendered distinctly from user-deny.
- **Acceptance:** unattended loops proceed without blanket auto-approve; a wedged or
  over-permissive adjudicator degrades to human prompting; audit log never contains
  model-authored free text in closed-vocabulary fields.

> **WS-B4 as-built (2026-07-30):** DONE. `src/main/context/prompt-injection-contract.ts`
> (locked `SYSTEM_PROMPT_BLOCK_ORDER`, composer with sha256 manifest, `findVolatileText`
> scanner) wired through `createInstance()`; assembly then extracted to
> `src/main/instance/instance-system-prompt.ts` (lifecycle 3573→3225 lines, LOC ratchet
> green). Key finding: wake-context `generatedAt` was metadata-only, never rendered —
> assembly was already deterministic; now locked by tripwire + time-independence tests and
> an e2e regression spec against the real createInstance. All gates + fresh-eyes PASS;
> full suite 16,818 green.

### WS-B4 Prompt-cache injection contract + tripwire tests
- **Sources:** codex P1 (oh-my-opencode-slim 4-layer enforcement); fable cross-cutting
  theme #1 (append-at-end injection; everything else compounds on this).
- **Verified state:** AIO has cache analytics and provider cache-marker tests, but detects
  collapse after the fact; no pre-release proof that transforms preserve the prefix.
- **Scope:** one stable-prefix API for AIO-owned prompt injection (memory, skills, hooks,
  loop state): deterministic additions at stable positions, volatile additions confined to
  a tagged tail; CI checks for byte-prefix stability, volatile-tail isolation, time/random
  determinism, and reviewed volatility exceptions. Scope assertions to payloads AIO
  controls; no golden tests around opaque provider CLI payloads.
- **Acceptance:** a regression that busts the cached prefix fails CI before release.

> **WS-B5 as-built (2026-07-30): CLOSED as investigated — no implementation.** Measurement
> found AIO already near-optimal: `buildMcpRuntimeToolContextSelection` caps injection at 6
> tools, description-only (~300–400 tokens vs ~3,600 if schemas were inlined), with
> everything else deferred behind ranked search. Provider CLIs load their own MCP configs
> and none evidences native defer_loading, so no further AIO-side lever exists. fable_todo's
> "pathological case" claim recorded as incorrect for the current codebase. Small follow-up
> moved to §7 deferred: persist per-instance MCP-injection token telemetry (extend
> context-attribution) so future decisions have longitudinal data.

### WS-B5 MCP tool-surface measurement + deferred loading (discovery-first)
- **Sources:** fable theme #2 / Actual Claude A8 (ToolSearch defer_loading, 10%-of-window
  auto-trigger), pi A4, copilot-sdk A7; codex says lazy ranked MCP selection already exists.
- **Discovery gate (this IS the workstream initially):** measure real per-instance MCP
  token overhead through `mcp-tool-search.ts` / `mcp-runtime-tool-context.ts` — what is
  loaded eagerly per provider, what the ranked selection actually saves, and whether a
  defer-to-names-only mode with on-demand schema fetch would add anything. Produce numbers.
- **Scope (only if numbers justify):** defer-loading mode with per-tool opt-out and an
  auto-enable threshold tied to window share.
- **Acceptance:** a written measurement either closes this WS as already-covered or defines
  the implementation follow-up with expected savings.

> **WS-B6 as-built (2026-07-31):** DONE. Compare runs are now per-member state machines
> (queued/running/succeeded/failed/cancelled) with immediate reveal, AbortController-backed
> cancellation, and durable recovery via `council-run-store.ts` (capped JSON store,
> corruption-safe). Synthesis with ≥2 completed members through three routes: consensus
> (`synthesizeFromResponses`, no new provider calls), debate (ephemeral synthesis debate
> that never touches coordinator state), or a chosen provider — attributed
> `<council_answer>` blocks with closing-tag escaping (injection-tested) and absent members
> named. Legacy `compare()` behaviour preserved. New `/compare` IPC surface (5 channels +
> strict run-updated event). Fresh-eyes PASS. Follow-up noted: mark stale 'running'
> members terminal on rehydrate after an app crash; live UI pass pending livetest.

### WS-B6 Progressive Council with synthesis
- **Sources:** codex P1 (online-orchestrator interaction pattern only — never its DOM
  injection); fable theme #5.
- **Verified gap:** `multi-provider-compare-service.ts` awaits `Promise.all`; nothing is
  usable until the slowest provider finishes; completed view has no next action.
- **Scope:** per-provider card lifecycle (queued/running/succeeded/failed) with immediate
  reveal, durable recovery of partially complete runs, cancellation, and a synthesis action
  routing completed answers through AIO consensus, debate, or a chosen provider with
  attribution and disagreements preserved.
- **Acceptance:** first answer visible while others run; synthesis works with N-1 members;
  failed members named, not hidden.

> **WS-B7 as-built (2026-07-31):** DONE. Pure read-only `previewCompaction` (mode honesty:
> only Codex app-server is adapter-self-managed and the preview says AIO cannot bound it;
> all other providers are aio-managed where the boundary applies) + `applyCompaction` with
> MANUAL checkpoint-before-compact and checkpointId attached to the existing boundary
> message. `keepLatestExchanges` boundary shares the SAME cut functions as the real
> compactor (no duplicated logic; includes the mid-range user-turn rescue), with a
> byte-compatibility test for the no-boundary default. One-click Compact Now now also
> checkpoints. tokenEstimate.source is honest (measured only for provider-reported usage).
> Renderer preview dialog (OnPush/signals, aria-modal, bounded numeric input) beside the
> existing Compact Now. Fresh-eyes PASS. Non-blocking follow-ups noted: same-fixture
> preview/compact parity test; live evidence-preservation check → livetest.

### WS-B7 Manual compaction preview
- **Sources:** codex P1 (hermes role-safe preview/boundary); fable Actual Claude A2–A5
  micro-compaction details as reference only.
- **Verified state:** compaction exists and is instrumented; the warning offers only a
  one-click Compact Now with no scope inspection.
- **Scope:** read-only preview endpoint first (affected range, token estimate + its source,
  protected recent exchanges, whether the adapter self-manages compaction); "keep latest N
  exchanges" boundary control; apply only on explicit confirmation; persist a before/after
  checkpoint; automatic path unchanged.
- **Acceptance:** user can see and bound what will be summarised before it happens.

> **WS-B8 as-built (2026-07-31):** DONE. `src/main/learning/` correction miner (pure:
> same-session 12-call lookahead pairing, 6 conservative error classes gated on real
> `is_error` metadata — Gemini honestly skipped; TDD red-green + path-exploration FP
> filters; confidence capped <1.0 per observation) + manual-only, bounded (≤200 sessions),
> RLM-checkpointed scan service (migration 057). Evidence redacted via redactForEgress
> BEFORE persistence. Rule proposals land in the WS-A4 governed store ('agent-derived',
> dedupe-reinforce by baseCommand::errorClass) and reach prompts ONLY on explicit approval
> via the same lesson-promotion path as memory proposals — no new injection path.
> /memory-review gains scan trigger + rule cards with expandable evidence. Fresh-eyes
> PASS, zero findings. skill/hook proposal kinds still have no producer (unchanged).
> Side fix during this batch: the two Phase-B IPC trust-wrapper handlers now satisfy the
> handler-contract checker via explicit IpcResponse return annotations.

### WS-B8 Learning loop: fail→fix mining into governed proposals
- **Sources:** fable rtk A7 (fail→fix pair mining with TDD/path false-positive filters),
  claude-code A8 (frustration-signal mining), openclaw A18/A19 + codex P1 Skill Workshop
  (proposal-first, provenance-bearing, never auto-trusted).
- **Discovery gate:** confirm the transcript/prompt-history corpus AIO can mine locally and
  the skill/hook/memory targets a proposal can write to; reuse skill attribution and
  diagnostics services.
- **Scope:** manual-by-default, workspace-scoped, checkpointed scans of settled sessions
  producing reviewable proposals (new rule / skill edit / memory candidate) with source
  evidence, confidence, and occurrence counts; false-positive filters (TDD red-green,
  path-exploration); proposals flow into the WS-A4 review queue lifecycle — **one**
  governed promotion surface, not two.
- **Acceptance:** a repeated correction across sessions becomes a one-click reviewable
  proposal; nothing auto-promotes into trusted instructions.

> **WS-B9 as-built (2026-07-31):** DONE. `review-coverage.ts`: per-attempt
> ReviewCoverageReport (used/cached/skipped/failed/parse_failed + activationReason + model
> + findingCount) persisted on LoopState (bounded, broadcast-stripped); a
> failed/parse_failed/skipped REQUIRED angle routes through the same fail-closed
> errored→pause-operator-review path as zero-reviewers — partial coverage can never read
> clean. Per-angle cache keyed REVIEW_SCHEMA_VERSION + prompt-text hash (depth, guidance,
> evidence section, JSON shape) + reviewer/model/angle + rulesHash('none' — no rules feed
> prompts today) + redacted-content workHash; hits re-run verifyAnchor against the CURRENT
> artifact (moved quotes demote per A3); failures never cached; antigravity multi-model
> reviewers excluded from cache (ambiguous identity) but not from coverage. Review-driven
> completion mode deliberately left advisory per its own tested design. Coverage field
> added to fresh-eyes event schemas in lockstep. Fresh-eyes PASS, zero findings.

### WS-B9 Exact reviewer coverage + per-angle cache
- **Sources:** codex P1 (storybloq activation/coverage/cache).
- **Scope:** record every intended reviewer/angle as used/cached/skipped/failed/
  parse_failed with activation reason and model; required-vs-achieved coverage exposed to
  the completion decision (partial required coverage ≠ clean); cache successful angles
  independently keyed on schema/prompt version, reviewer/model/angle, rules, and redacted
  artifact work hash; re-anchor cached findings to the current artifact (depends on WS-A3
  anchor machinery).
- **Acceptance:** a fix→review cycle reuses unchanged clean angles; a parse-failed required
  angle blocks "clean" verdicts.

> **WS-B10 as-built (2026-07-30):** DONE. Added `unknown` (fail-closed, 4096-byte payload
> cap), `tool_use_observed`/`tool_result_observed` (stable-hash normalizers exported as an
> unwired seam for WS-A2), and envelope-level `ephemeral` honored at the single
> persistence chokepoint (`provider-runtime-event-bus.ts` captureRawBackedEvent). Zod
> schemas in lockstep. Wave-2 `@frozen` annotation amended (not silently overridden) with
> doc references. Previously-dropped malformed output/context events now preserved. All
> gates + fresh-eyes PASS; full suite 16,818 green.

### WS-B10 Provider runtime event taxonomy hardening (Codex amendment)
- **Sources:** fable shortlist #12 (t3code A1 canonical event taxonomy, CodePilot A9
  8-event canonical union + mandatory unknown_item, copilot-sdk A3 ephemeral-vs-persisted
  envelope); added on Codex review — wrongly dropped from the first draft.
- **Verified state:** `packages/contracts/src/types/provider-runtime-events.ts` holds a
  small union (output/tool/status/context/error/exit/spawned/complete).
- **Scope:** richer closed event classes with explicit unknown-item handling (fail-closed
  routing of unrecognized provider events into a typed `unknown` envelope rather than
  drops), provider refs, and persisted-vs-ephemeral semantics. Consumers: WS-A2 detection,
  WS-C1 decision timeline, WS-B9 coverage, future PR/approval flows.
- **Sequencing:** before or alongside WS-A2 so loop detection consumes the hardened
  taxonomy instead of growing bespoke normalization.
- **Acceptance:** an unrecognized provider event is preserved, typed, and visible in
  capture rather than silently dropped; existing consumers compile against the widened
  union with no behaviour change.

## 6. Tier C — P1 operator-experience workstreams

> **WS-C1 as-built (2026-07-31):** DONE. Read-only on-demand `OperationalDecision`
> projection (`src/main/workboard/`, new `@contracts/schemas/workboard` subpath with full
> alias protocol) over five durable sources: provider-limit ledger (loop AND
> plain-instance parks), loop terminal intents + final status (transient fresh-eyes
> events correctly not queried), compaction epoch history (in-memory, labelled
> informational), automation run rows (never fabricates retry times), and WS-A1 admission
> suppressions. Plain-language titles; epochs formatted renderer-side; bounded most-recent
> -20 after merge; single "Resume now" action only for the active, currently-resumable
> park, dispatched via existing LoopStore.resume with an immediate post-action re-query
> (reviewer warning fixed same-day). Rendered as a bounded sibling section in Workboard
> detail. Fresh-eyes PASS.

### WS-C1 Workboard decision timeline
- **Sources:** codex P1 (claw-code typed policy-decision events).
- **Scope:** small cross-domain `OperationalDecision` projection (timestamp, cause/rule,
  resulting status, retry/resume time, one safe operator action) referencing — not copying —
  provider-limit, loop terminal/review-gate, compaction, and automation-recovery events.
  Plain-language entries in Workboard detail. No second policy engine.
- **Acceptance:** "why is this Waiting / Needs you, and what moves it next?" answerable
  from the card.

> **WS-C2 as-built (2026-07-31):** DONE. Numeric discovery honoured: the palette premise
> was FALSE (nothing groups by urgency there — session-picker substituted, documented);
> the real measured gap: 60% of Workboard's needs-you states (degraded/error/failed) gave
> ZERO mobile signal. Fixed via one shared ordered scale (`src/shared/attention/`,
> blocked>failed>review>waiting>working>idle, assertNever-exhaustive) consumed by
> Workboard lanes (thin wrappers, old lane assignments preserved), mobile serializers
> (sets now DERIVED, byte-identical verified; new needsAttentionCount closes the gap;
> pendingApprovalCount semantics deliberately unchanged), and session-picker (needs-you
> group first). Act-from-the-card: approve/reject via the existing user-action-request
> flow, restricted to approve_action/confirm, double-click-guarded, stale-response-checked;
> CLI-native permission prompts deliberately excluded. Snooze with hand-raise (auto-clears
> on blocked/failed/review/idle), in-memory, keyboard accessible. Cross-surface
> consistency test present. Fresh-eyes PASS, zero findings. Follow-up noted:
> instance-row.component still has a local narrower needsAttention vocabulary.

### WS-C2 Unified attention scale + act-from-the-card
- **Sources:** fable theme #8 (t3code B1 settled/snoozed with hand-raise, jean B2/B3
  approve-from-card + unread bell, agent-orchestrator B1 one ordered vocabulary across
  desktop/palette/mobile).
- **Discovery gate:** codex judged Workboard "no retained gap" for attention boards, so
  this WS is a *refinement*, not a rebuild: compare Workboard lanes, palette groups, and
  the mobile chip vocabulary; confirm they use different scales computed in different
  places (fable claims mobile differs and lanes are renderer-derived).
- **Scope (if confirmed):** one ordered attention level computed in main, shared by
  Workboard, palette, and mobile; approve/answer directly from the card; snooze overlay
  that raises its hand when the item becomes blocked-on-you, fails, or completes; unread
  predicate derived from existing data. Feeds on WS-B1 phase 2 for PR-derived states.
- **Acceptance:** the same item shows the same urgency everywhere; a routine approval is
  one click from the board.

> **WS-C3 as-built (2026-07-31):** DONE within its own constraint. Pure renderer builder
> `run-readiness.ts` + banner (blocking disables Send via extended canSend; role=alert/
> status; per-instance dismissal for non-blocking only) docked above the composer, fed by
> the EXISTING StartupCapabilityReport pull — no new probes, no new IPC. Deliberate
> exclusions documented in code: compaction pressure (context-warning owns it),
> quota-park/auth-required (sends intentionally queue-and-replay — gating would regress),
> dead-session recovery (own banner). **Acceptance amendment:** of the plan's example
> trio, only "dead provider" has an existing renderer-visible signal; missing-workspace
> and cost-spike need new signals first and are recorded as a follow-up, honoring the
> no-second-health-system rule rather than overclaiming. Fresh-eyes PASS, zero findings
> (startup race verified safe: non-blocking until the capabilities report proves no
> provider works; input-panel sits exactly at its LOC tolerance boundary — next editor
> must extract).

### WS-C3 Run readiness checkpoint at the action point
- **Sources:** codex P1 (CodePilot `checkpointReasons`); fable CodePilot B4 (pure builder,
  one primary action per reason, banner-never-modal, renders nothing when empty).
- **Scope:** single typed reason contract (severity, blocking/confirmable, remediation
  command, dedup) aggregating existing Doctor/preflight/provider/context signals near
  Run/Send. Reuse existing services; no second health system.
- **Acceptance:** an expensive failed start (dead provider, missing workspace, cost spike)
  is surfaced as a reasoned banner before send.

> **WS-C4 as-built (2026-07-31):** DONE after one fresh-eyes FAIL→fix→PASS cycle
> (critical: stale annotations were sent under an "exact current lines" preamble — fixed
> both ways: state="stale"/"re-anchored" packet attributes with a three-way preamble
> explanation, plus an inline confirm banner with Send-anyway / Remove-stale-first).
> Annotations live in the Source Control diff viewer (the instance-wired one; the shared
> context-free component deliberately untouched): hunk/side-bounded click+shift and
> keyboard selection, exact-excerpt capture, unique-exact-match re-anchoring (re-anchored
> excerpts guaranteed current by construction), data-not-command packet framing with
> escaped delimiters + attribute escaping (cross-check-tested identical in both builders),
> dispatch via the existing sendInput queue path (draft preserved + error surfaced on
> failure — tested). Review-findings panel gains stable-key checkboxes → "Fix selected"
> packet. Send is instance-scoped (documented choice).

### WS-C4 Inline diff review comments → structured dispatch
- **Sources:** codex P1 (t3code annotatable diffs); fable jean B9 (findings with stable
  keys + checkbox subset → fix prompt).
- **Scope:** select old/new-side ranges in the existing diff viewer, attach typed comments
  (path, side, range, excerpt, comment, work hash, stale/re-anchored state), keep a review
  draft, send one structured packet to the instance or Loop; render the same objects in
  diff and transcript. Review-findings panels gain select-subset → dispatch-fix.
- **Acceptance:** correcting an agent on three specific lines requires no copy/paste.

> **WS-C5 as-built (2026-07-31):** DONE. Pure `deriveAutomationAuthority` over REAL config
> fields only — six cards (May access / May change / Must ask before / Stops when /
> Verification / Report destination), every statement classified technical vs
> instruction-only with badge+text (not colour alone). Key honesty outcomes verified by
> fresh-eyes (PASS): workingDirectory worded as cwd-not-a-jail; yolo-off →
> unattended-approval-becomes-hard-failure backed by WAIT_STATUSES; worktree isolation is
> the only real "don't publish" containment and prompt-level "don't push" is never shown
> as enforced. Three honest one-click presets (read-only monitor / prepare-don't-publish /
> implement-in-one-repo), all concurrency 'skip'. Rendered live in the form + read-only in
> the detail overlay.

### WS-C5 Automation operating-authority contract
- **Sources:** codex P1 (openclaw standing orders).
- **Scope:** structured May-access / May-change / Must-ask-before / Stops-when /
  Verification / Report-destination cards in the automation form and preflight, each marked
  technically-enforced vs instruction-only; compile enforced parts into existing
  permission/preflight machinery; templates for read-only monitor, prepare-don't-publish,
  single-repo implementation.
- **Acceptance:** an automation's blast radius is legible at a glance; prose gates are
  never presented as sandboxes.

> **WS-C6 as-built (2026-07-31):** DONE. WS-B4's composer manifest now persists:
> `context-manifest-store.ts` (in-memory per-instance, 20-epoch cap — correct for
> "what did the RUNNING session receive" semantics), captured at the single
> assembleInstanceSystemPrompt call site (spawn vs respawn classified) plus an honest
> EMPTY epoch for restart-compact (that path injects no system-prompt blocks — verified).
> All 9 block kinds recorded supplied/skipped-empty/unavailable from the real
> timeout/error paths; entries carry kind/status/hash/length only (redaction-tested).
> IPC `context:manifest-for-instance`; context-attribution panel gains per-epoch
> disclosure with a provider-cache honesty note. 'provider-confirmed' deliberately
> omitted as unprovable. Fresh-eyes PASS, zero findings. Wrap-up item: wire the exported
> deleteContextManifest into terminateInstance's cleanup block.

### WS-C6 Privileged-context manifest and epoch (observability-only)
- **Sources:** codex P1 (opencode context epochs).
- **Scope:** record exactly which AIO-owned context sources (kind, provenance, ordering,
  hash/version, missing status) a session received; reconcile at safe boundaries and
  advance an epoch; distinguish requested / supplied / provider-confirmed; redact paths.
  Authoritative only for AIO-owned inputs.
- **Acceptance:** "which version of the project brief did this running session get?" is
  answerable.

> **WS-C7 as-built (2026-07-31):** DONE (fresh-eyes PASS; its one warning + suggestion
> fixed same-day). Honest containment per the discovery matrix: `executionProfile
> 'contained'` is Codex-only at the technical tier — fire-time gate consumes the SAME
> resolved spawn target the real spawn uses; non-Codex → recorded run failure, never a
> downgrade; thread-wakeup/loop shapes explicitly REFUSED (they bypass the one-shot spawn
> path and would run unsandboxed). Contained spawn: forced read-only sandbox + filtered
> env via new `getSafeEnvStrict` (host env AND caller-supplied options.env both filtered —
> the reviewer's latent-leak finding closed with its prescribed test). Respawns re-filter
> via the per-instance registry (cleaned on terminate). 7th "what this run can access"
> authority card + profile selector with resolved-provider mismatch warning + explicit
> keychain/config auth note (env-key auth cannot work contained — documented, not hidden).
> Known limits recorded: no network middle-ground on Codex read-only; standard-run env
> remains unfiltered (see §7 follow-ups). Campaign polish: deleteContextManifest wired
> into terminateInstance beside the other per-instance cleanups.

### WS-C7 Contained execution profile for unattended runs
- **Sources:** codex P1 (nanoclaw isolation model); fable theme #20 (egress policy +
  credential brokering: codex A10, nanoclaw A16, claude-code A10).
- **Discovery gate:** inventory each provider's actual sandbox guarantees and the remote-
  node runtime first (codex's stated precondition). Note the existing constraint that
  Automation Read Only breaks outbound network (memory: automation-readonly-blocks-network)
  — the profile must be more expressive than that binary.
- **Scope:** opt-in `contained` profile for loops/automations: explicit workspace
  allowlist, read-only inputs by default, network and credential-broker policy, unsupported-
  provider fallback, teardown behaviour, and a visible "what this run can access" card.
  Never silently downgrade a contained run to host execution.
- **Acceptance:** a high-autonomy run can be provably unable to reach the user profile,
  unrelated repos, or durable credentials — and says so honestly.

> **WS-C8 as-built (2026-07-31):** DONE. `progress-draft-compositor.ts` (pure composition:
> 700-char bound, redactForEgress with new additive 'channel' egress kind, 5s min-interval
> + normalized-detail change detection excluding the elapsed clock) +
> `progress-draft-manager.ts` (per-draft promise-chain serialization; two races
> dedicated-tested: completion-vs-in-flight-edit final-wins, and new-turn-during-finalize
> via object-identity delete). Capability surface: supportsMessageEditing base false,
> Discord true; non-edit channels keep byte-identical legacy heartbeats; WhatsApp gets NO
> draft (calmer than a stack). Collapse edit ordered before the final reply in both flush
> branches (invocationCallOrder-tested). Everything behind the existing channelToolHeartbeat
> opt-in (default off) — replaces that feature's message stack on edit-capable channels.
> Fresh-eyes PASS, zero findings. Live Discord round-trip → livetest.

### WS-C8 Editable channel progress drafts
- **Sources:** codex P1 (openclaw progress drafts); Discord `editMessage` already exists.
- **Scope:** on edit-capable channels, one bounded evolving Working… message (typed,
  redacted status lines), collapsed/replaced at completion; rate-limited edits; skip for
  short tasks; fresh-message fallback preserved as capability fallback.
- **Acceptance:** a long Discord task produces one calm receipt, not a message stack.

> **WS-C9 as-built (2026-07-31):** DONE after one fresh-eyes FAIL→fix cycle (critical: the
> new keybindingCustomizations schema rejected its own empty-string default; fixed
> call-site-scoped after impact analysis of the shared helper's other users). Key
> discovery: AIO already had a wired KeybindingService system — EXTENDED it per the
> no-shadow-authority rule instead of building a parallel registry. **Real live bug found
> and fixed**: overlay Escape bubbled past a missing stopPropagation into the global
> cancel-operation binding's stale eligibility snapshot and could reach
> interruptInstance() — dismissing a picker could interrupt the running session
> (regression-tested; pre-change reality verified at HEAD by the reviewer). Added:
> 'overlay' context + setContext tracking, most-specific-context-wins resolver
> (behaviour-preserving), cross-context conflict validation with a zero-violations unit
> test as the shipping gate, conservative reserved-keys list, validated
> customizeBindingSafe + reserved-key import checks, keybindingCustomizations persistence
> round-trip, resolver-derived ShortcutHintPipe, searchable context-grouped Settings →
> Keyboard tab, and a documented not-migrated inventory. Final-sweep to confirm the fix
> delta.

### WS-C9 Context-scoped keyboard registry
- **Sources:** codex P1 (Actual Claude bindings/resolver/validator).
- **Scope:** one action namespace over the existing command/overlay system; context-scoped
  bindings with conflict validation and platform fallbacks; every displayed hint derived
  from the live resolver; searchable shortcut surface; user overrides with reserved-key
  checks.
- **Acceptance:** adding a new overlay cannot silently steal an existing binding.

> **WS-C10 as-built (2026-07-31):** DONE behind `transcriptVirtualization` (default OFF;
> flag-off branch byte-identical to HEAD, zero observers attached when off). Measured
> dynamic-height windowing (`transcript-virtualizer-math/height-cache/controller`) with
> ordered row/spacer segments, semantic anchors (topmost-visible id + offset, prepend-
> stable), per-session height cache, and session-switch anchor memory. Constraint
> resolutions: user-message rows PINNED (always rendered) making jump-rail's synchronous
> querySelector correct by construction; find-open bypasses virtualization so search sees
> the full loaded transcript. Inline-edit extracted (net −29 lines on output-stream).
> Reviewer traced the prepend scroll-compensation as valid under spacers (scrollHeight is
> a complete DOM measurement). Fresh-eyes PASS. Real-browser continuity benchmarks +
> default-on decision → livetest.

### WS-C10 True transcript virtualization (flagged prototype)
- **Sources:** codex P1 (opencode measured dynamic-height virtualization + continuity
  benchmarks).
- **Scope:** behind a flag: dynamic-height virtualization with per-session measurement
  cache and semantic visible anchors across prepend/streaming/collapse/session-switch;
  preserve message IDs, jump rail, find, context menus, screen-reader order; real-browser
  continuity benchmarks before default-on.
- **Acceptance:** very long sessions stop growing the DOM unboundedly with no regression in
  the preserved features.

## 7. Deferred backlog (P2 — do not schedule now)

Kept with one-line rationale; promote only via a new dated plan.

- **Queue-policy UX** (steer/follow-up/collect/interrupt modes) — blocked on WS-A1.
- **Cursor-based transcript backfill** — validate current ledger pagination first.
- **Guided requirements interview** — reuse existing review controls when picked up.
- **Declarative plugin UI contribution points** — schema-constrained, worker-validated.
- **RTK adoption/quality doctor** — local evidence only; extend the existing tab.
- **Large-paste composer tokens** — with screen-reader labelling and secret-scan states.
- **Recap output contract + "while you were away" recap** (jean B4, Actual Claude B5) —
  strong idea; pairs naturally with WS-C2 once attention states exist.
- **Conversation-branch tree navigator** (pi) — projection over existing fork lineage.
- **Session-linked live preview co-annotation** (t3code) — remote/AIO-managed browser only;
  never James's local browser.
- **Agent-built dashboard widgets / generative UI** (openclaw B2, CodePilot B6) — needs the
  sandboxed-iframe security recipe; not before the plugin-UI story.
- **tmux/conpty multiplexer runtime + headless daemon + detached execution**
  (agent-orchestrator A1/A2, jean A7) — big-build architectural change; revisit only with a
  concrete crash-tolerance requirement. P0.1 covers the near-term kill-bug risk.
- **Event replay ring buffer for gateway reconnects** (jean A14) — verify current
  remote-node/mobile sequence recovery first; codex found recovery already exists.
- **Speculative execution overlay, host-declared canvas panels, five-tier auxiliary-model
  routing, `aio.json` repo contract, searchable settings anchors, magic action sheet** —
  noted; none has a verified gap statement yet.

## 8. Explicitly rejected / already covered (do not re-open)

- **Compaction subsystem, turn checkpointing, cross-provider handoff state, context
  attribution, ensemble coordinators, MCP lazy tool selection** — fable_todo claimed these
  missing; they exist (see §1 table). Only the *refinements* in WS-B4/B5/B6/B7 remain.
- **Browser DOM automation of logged-in provider tabs** (online-orchestrator) — rejected by
  codex audit; unsafe pattern; interaction ideas retained in WS-B6 only.
- **Second policy engine / shadow task ledger / plugin-shaped review broker / separate
  memory daemon** (claw-code lanes, OMX ultragoal shell, codex-plugin-cc broker,
  mempalace rooms) — codex audit: would fragment existing authorities.
- **Copying RTK filtering into AIO** — belongs in the RTK binary AIO invokes.
- **Remote telemetry of any kind** — rejected across the board.

## 9. Sequencing and dependencies

1. **Phase 0** first (single run, independent items).
2. **Phase 0.6 = WS-B4 (cache contract) as a hard gate** — no workstream that adds or
   changes prompt/context injection starts before it (Codex amendment; fable's strongest
   cross-cutting signal).
3. **WS-B10 (event taxonomy)** before or alongside WS-A2.
4. Tier A in order A1(+A5, one admission service) → A2 → A3 → A4 (A3 before WS-B9, which
   reuses its anchors; A4 before WS-B8, which feeds its store).
5. **WS-B3 before WS-B1 phase 1** (external-publish authority before PR creation).
6. Remaining Tier B/C in listed order by default; WS-B1 phases may interleave; WS-C2
   consumes WS-B1 phase 2 outputs but can start its discovery gate independently.
7. Each WS is one run with the fresh-eyes gate; livetest deferrals per project rules.

## 10. Source-document disposition

Disposed 2026-07-31: the source backlogs moved to `docs/fable_todo_2_completed.md` and
`docs/codex_todo_2_completed.md` (the `_2` suffix avoids colliding with round one's
completed todos), each stamped with a disposition header pointing back at this plan. This
plan file completed the standard lifecycle: untracked while active, renamed
`_plan_completed.md` after implementation and verification, with live checks deferred to
`2026-07-30-sibling-audit-round2_livetest.md`.
