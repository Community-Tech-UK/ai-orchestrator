# Architecture and code-quality remediation

Status: completed. Approved by James (review `2026-09-15-architecture-quality-remediation`, overall APPROVED). Independently-landable Phases 2–6, Phase 2b, overflow compact/retry policy, and Angular 5.4 are as-built in the dated `_plan_completed.md` files below.
Date: 2026-09-15

## Scope and method

James asked for a thorough pass over the codebase to improve architecture, speed, reliability, and code size while staying safe. This repo is ~4,860 TypeScript files (52 MB under `src/`) with an already-mature toolchain: a strict 700-line-per-file LOC ratchet (`scripts/check-ts-max-loc.ts`) with an active in-flight extraction plan (`2026-09-02-loc-ratchet-refactor_plan_completed.md`), a livetest-remediation register for reproduced defects, and Angular conventions that are already well enforced.

Rewriting this codebase wholesale is not proposed and would be reckless: it is a live product with deep provider/orchestration logic that took a long time to get right, and a blind rewrite risks regressing reliability precisely where this plan is trying to improve it. Instead, this is a **prioritized, evidence-based punch list** built from five targeted audits (main-process core, CLI adapters, IPC/type-safety boundary, Angular renderer, cross-cutting tooling/dead-code/logging). Every item below cites concrete files/lines. File-size splitting is explicitly **out of scope** here — that is already tracked and actively worked via the LOC ratchet plan.

### Non-goals

- No line-count-driven file splitting (already covered elsewhere).
- No rewrite of working provider protocol logic without a reproduced defect or a concrete duplication target.
- No renderer overhaul — the audit found the Angular layer already conforms well to `docs/angular-conventions.md` (standalone, OnPush, signal inputs are ~100% adopted). Renderer gets a short cleanup phase, not a redesign.
- No new dependencies added speculatively; tooling additions (phase 5) are proposed, not assumed.

### How to execute this plan

Each phase below should become its own `*_spec.md` → `*_plan.md` per the repo's plan/spec convention before code changes start, sized to land and verify independently (targeted specs + the canonical gate checklist). Do not attempt all phases in one sitting. Phases are ordered by risk-reduction value, not by dependency — Phase 1 can start immediately.

---

## Phase 1 — Reliability: stop silently swallowing failures (highest value, lowest risk)

Silent `catch` blocks in core paths mean real failures currently look like success. This is the single highest-leverage category: fixing it surfaces bugs users are already hitting blind.

| # | File:line | Problem | Fix |
|---|---|---|---|
| 1.1 | `src/main/browser-gateway/browser-target-persistence-sentinel.ts` (`catch (e) {}`) | Fully empty catch in production main-process code. | Log at debug/warn with the error; only stay silent if there's a documented, narrow expected-failure reason. |
| 1.2 | `src/main/instance/instance-manager.ts:410,417,450,465,486,588,866,964,1162` | Multiple best-effort catches in core instance flow, including one swallowing `productionCoreDeps()` failure. | Audit each: log with context for genuinely non-fatal cleanup; propagate for anything that affects correctness. |
| 1.3 | `src/main/instance/instance-communication.ts:2587` | Swallowed stats/telemetry error in a hot path. | Make telemetry errors observable (log once, don't crash the flow). |
| 1.4 | `src/main/session/agent-tree-persistence.ts:61-85,103-126,291-323` | Broad catches during snapshot discovery/cleanup mask real IO/corruption vs. expected "not found". | Split expected-missing from real IO errors; only the former should be silent. |
| 1.5 | `src/main/process/hibernation-manager.ts:74-85`, `src/main/routing/hot-model-switcher.ts:211-219,545` | Swallowed catches around scheduling/model-switch state. | Surface switch/eviction failures instead of dropping them. |
| 1.6 | Cross-cutting: 309 raw `console.*` calls across 74 files in `src/main`/`src/renderer` (production, excluding `__tests__`/`benchmarks`/`load`) | Bypasses the structured `getLogger()` pattern — no subsystem context, no redaction, inconsistent severity. Examples: `src/renderer/main.ts` (`console.error` on unhandled rejection), `src/renderer/app/features/file-explorer/file-explorer.component.ts`, a stray success-path `console.log('Image copied to clipboard')` in `message-attachments.component.ts`. | **Approved scope: expanded.** Sweep ALL 309 call sites to `getLogger(subsystem)` in one pass (not staged); add a lint rule banning bare `console.*` in `src/main` and `src/renderer` (excluding test/bench/load paths and the logger implementation itself). |

**Effort:** ~2-4 days. **Verification:** targeted specs per touched file, then `npm run lint` (with the new rule), full `test:quiet`.

---

## Phase 2 — Main-process core: de-god-object the instance/session layer

The audit confirms `InstanceManager` and `InstanceCommunicationManager` are true god objects — not just long files, but genuinely mixed concerns (routing, permissions, history, provider runtime, retry/circuit-breaker, overflow handling, rate-limit detection, auth recovery, TODO parsing all in one place). This is where reliability bugs hide and where new features become risky to add.

| # | File | Problem | Fix |
|---|---|---|---|
| 2.1 | `src/main/instance/instance-manager.ts:13-162,192-220` | Direct hard-wiring of routing, permissions, history, provider runtime, pause state, worker registry, notifications, task management. Import fan-in is extreme, coupling it to nearly every subsystem. | Introduce an orchestration-context object or a small service graph; extract narrow facades (e.g. `InstancePermissions`, `InstanceHistoryFacade`) and inject rather than hard-import. |
| 2.2 | `src/main/instance/instance-communication.ts:5-106,111-153` | One class does adapter-event handling, retry/circuit-breaker, context-overflow handling, rate-limit detection, auth-failure recovery, TODO parsing, and provider-event translation. A comment says history archiving "moved away" but the import surface says otherwise — the split is incomplete. | Extract recovery/overflow/retry and provider-event translation into dedicated collaborators; finish the archiving separation the comment claims already happened. |
| 2.3 | `src/main/instance/instance-communication.ts:2287` | `adapter as any` in a hot path. | Add a narrow interface/type guard for the adapter method actually used. |
| 2.4 | `src/main/communication/cross-instance-comm.ts:32-51,60-179,202-216` | Singleton owns bridge lifecycle, storage, pub/sub, and validation together. | Split storage from pub/sub; inject storage so the bridge is testable without real persistence. |
| 2.5 | `src/main/providers/provider-runtime-registry.ts:108-127,350` | Global mutable registry plus a double cast (`as unknown as CliShadowReport`) weakening provider-health type guarantees. | Replace the cast with a real parser/normalizer function. |
| 2.6 | `src/main/instance/instance-manager.ts:212-216` | A comment admits a lazy-resolution workaround exists specifically so test spies attach post-construction — a test concern leaking into production design. | Inject the interrupt dependency directly; expose test seams via constructor args instead. |
| 2.7 | Cross-module | Inconsistent singleton conventions: some services follow the documented `getInstance()` + `getXxx()` + `_resetForTesting()` pattern, others (`hibernation-manager.ts`, `hot-model-switcher.ts`, `cross-instance-comm.ts`, `provider-runtime-registry.ts`, `agent-tree-persistence.ts`) vary in accessibility/reset support. | Standardize on the documented pattern (already in `AGENTS.md`); audit and align each singleton in one pass. |

**Effort:** ~1-2 weeks, split into independently-landable extractions (mirror the incremental style of the existing LOC-ratchet plan — one collaborator extraction per PR, targeted specs each time, no behavior change). **Risk:** medium — this is the riskiest phase because it touches the most-used code path; each extraction must ship with before/after behavior-preserving tests, not new tests that assume the refactor is already correct.

---

## Phase 3 — CLI adapter consolidation (biggest duplication, biggest reliability payoff)

The four provider adapters (Claude, Codex, Gemini, Copilot) have drifted. There's a `BaseCliAdapter` contract, but each provider re-implements stream parsing, stderr policy, and output-message construction independently, with inconsistent error visibility and wildly uneven test coverage.

| # | File | Problem | Fix |
|---|---|---|---|
| 3.1 | `src/main/cli/adapters/gemini-cli-adapter.ts:215-340,419-473,476-700` | NDJSON parsing re-implemented three times (send, stream, final parse) with slightly different heuristics. | Extract one shared line/event parser; reuse for streaming, final parse, and error extraction. |
| 3.2 | `src/main/cli/adapters/copilot-cli-adapter.ts:335-345,622-645,698-736,740-780` | Same line-buffered JSON decoding repeated three times; server-mode and exec-mode logic interleaved in one adapter (`144-148,275-280,369-620`), increasing drift risk. | Factor stdout framing/dispatch into a shared helper; consider splitting server-mode into its own module or shared turn bridge. |
| 3.3 | `src/main/cli/adapters/claude-cli-adapter.ts:811,848,1285-1288,1629,1761` | Heavy reliance on `as unknown as` casts (`RawCliPayload`, `ClaudeAssistantMessageHost`, `Record<string, unknown>`) instead of one shared decoder. | Add type guards/decoder functions; centralize event normalization through one pipeline. |
| 3.4 | Cross-provider stderr policy | Gemini emits stderr as an `error` output and separately suppresses noise; Copilot only logs a warning for stderr matching `/error\|fatal\|failed/i` with no output/error event; Claude uses a third approach. | Standardize: visible output + typed error event for real failures, diagnostic-only logging for banners/noise, applied identically across all four adapters. |
| 3.5 | `src/main/cli/adapters/gemini-cli-adapter.ts:321,462,517,605,627,645,690`; `claude-cli-adapter.ts:476`; Copilot's JSON-coercion catch | Broad `catch {}` blocks suppress all parse exceptions. | Narrow to expected-malformed-input cases; log unexpected failures once. |
| 3.6 | Repeated `as OutputMessage` assertions: `copilot-cli-adapter.ts:351-359,421-428,460-525,543-549,703-706`; `gemini-cli-adapter.ts:236-365,382-387,428-433` | Manual shape assertions instead of typed constructors. | Small factory functions for output-message construction, shared across adapters. |
| 3.7 | `copilot-cli-adapter.ts:851-859` | Only `--prompt` is redacted from logged argv; any new sensitive flag needs separate handling. | Shared redaction helper used by all adapters for argv/env logging. |
| 3.8 | Test coverage imbalance | Claude spec ~1004 lines; Codex has 30+ dedicated spec files; Copilot's main spec is ~53 lines; Gemini has one ~161-line spec. `src/main/cli/__tests__/adapter-parity.spec.ts` exists but provider-specific behavior mostly isn't covered by it. | Add parity tests for Copilot/Gemini covering event parsing, stderr policy, resume/timeout, status emission; extend `adapter-parity.spec.ts` to assert the shared contract (output, status, context, error semantics) across all four providers so drift fails CI, not audits. |

**Effort:** ~1-2 weeks. Start with 3.8 (parity tests) *before* the refactors in 3.1-3.3 — tests that pin current behavior make the extraction safe and catch any accidental behavior change immediately.

---

## Phase 4 — IPC/type-safety boundary hardening

This is the security- and reliability-critical trust boundary between renderer and main. Findings show validation exists but is inconsistently applied.

| # | File:line | Problem | Fix |
|---|---|---|---|
| 4.1 | `src/main/ipc/handlers/session-handlers.ts:91-99,107-116` | Uses a custom `registerTrustedIpcHandler` wrapper instead of the common validated-handler pattern used elsewhere; the wrapper doesn't visibly enforce a schema before dispatch. | One shared registration helper for all channels that always enforces trust + Zod validation + structured error return. |
| 4.2 | `src/main/ipc/handlers/supervision-handlers.ts:250-252,283-296` | `forwardToRenderer(data: any)` and event spreading (`...data`) forward unvalidated shapes to the renderer. | Typed event envelopes per channel; validate/serialize before forwarding. |
| 4.3 | `src/preload/preload.ts:118-124` | Unchecked cast `response?.data as { ipcAuthToken?: string }` at the trust boundary during `appReady`. | Validate shape before extracting the token. |
| 4.4 | `src/main/ipc/handlers/instance-handlers.ts:149-171,227-230` | Validated payloads are then re-cast (`as FileAttachment[]`, `as InstanceProvider`), which can mask schema/type drift. | Derive the TypeScript type from the Zod schema (`z.infer`) so the schema is the single source of truth. |
| 4.5 | `src/main/ipc/handlers/codebase-handlers.ts:85-97,104-120` | Registers via a local `registerHandler` wrapper (inconsistent with the rest of IPC) and defines inline `z.object(...)` schemas instead of sharing them via `src/shared/validation`. | Standardize registration; extract schemas to shared validation so renderer and main can't drift. |
| 4.6 | `src/main/ipc/handlers/rtk-handlers.ts:23-38` | Payload schemas local to the handler file, not shared with the renderer contract layer. | Move to `src/shared/validation/ipc-schemas.ts` (or a colocated shared module) and import on both sides. |
| 4.7 | `src/main/ipc/handlers/command-handlers.ts:104-118` | Error payloads forced through `as never`/manual shape hacks for `candidates`. | Model error variants explicitly in the shared `IpcResponse` type. |
| 4.8 | `src/main/ipc/handlers/settings-handlers.ts:72-110` | `validated.settings \|\| validated` fallback-to-root-object semantics are loose for a settings write path. | Validate the exact expected update shape; remove the fallback ambiguity. |
| 4.9 | `src/main/ipc/ipc-main-runtime-wiring.ts:89-106` | `serializeInstanceForIpc` manually strips fields from `unknown` and returns `Record<string, unknown>` — brittle if the instance shape changes. | Define an explicit serialized-instance type; derive the omit/transform from it. |
| 4.10 | `src/preload/preload.ts:69-107` | No runtime contract check that every exposed preload method maps to a registered channel with a known response shape. | Add a contract test asserting preload-exposed methods ⟷ registered IPC channels are in 1:1 correspondence (catches both dead channels and unregistered exposed methods). |

**Effort:** ~1 week for 4.1/4.4/4.5/4.6/4.10 (the systemic fixes); the rest are quick per-file follow-ups once the shared helper/schema pattern lands.

---

## Phase 5 — Tooling gaps (enables everything else to stay fixed)

| # | Finding | Fix |
|---|---|---|
| 5.1 | No dead-code/unused-export tool beyond the narrow `scripts/check-dead-exports.js`. No `ts-prune`/`knip`/`depcheck`. | Evaluate `knip` (covers unused exports, files, and dependencies in one pass) as a `--warn`-only local gate first, matching the LOC-ratchet's warn/strict split, before promoting to CI. |
| 5.2 | Circular-dependency detection isn't feasible today — `madge --circular` on `src/main src/renderer src/shared` hung and had to be aborted. | Needs a bounded, incremental checker (e.g. run `madge` per-domain instead of whole-tree, with a timeout) rather than a whole-repo scan; add as a scoped script, not a blind `npx` invocation in CI. |
| 5.3 | Highest-LOC production files have no sibling spec at all: `loop-coordinator.ts` (4005 lines), `instance-lifecycle.ts` (3575), `instance-manager.ts` (2768), `channel-message-router.ts` (2663), `browser-gateway-service.ts` (2512). | Add focused specs for the highest-risk state-transition and error-recovery branches in each — prioritize alongside the Phase 2 extractions, since new specs there will directly support the safety of those refactors. |
| 5.4 | Angular ecosystem versions have drifted slightly (`@angular/*` at `^22.1.5` vs. `@angular-devkit/build-angular`/`@angular/cli` at `^22.1.7`, `angular-eslint` at `22.1.0`). | Align to one tested release line in a single dependency-bump PR, verified with the full renderer build gate. |
| 5.5 | `console.*` policy (see 1.6) has no lint enforcement, so it will regress again. | Add an ESLint rule banning `console.*` in `src/main`/`src/renderer` production paths once the Phase 1 sweep lands, so the fix sticks. |

**Effort:** ~3-5 days for tooling setup; 5.3 spec-writing is ongoing alongside Phase 2.

---

## Phase 6 — Renderer cleanup (small; renderer is already in good shape)

The audit found the Angular renderer already conforms well to `docs/angular-conventions.md`: 0 `NgModule`/non-standalone components, effectively complete `OnPush` coverage, only one file still using legacy `@Input()`/`@Output()`. This phase is minor polish, not a redesign.

| # | File:line | Problem | Fix |
|---|---|---|---|
| 6.1 | `src/renderer/app/features/instance-detail/composer-autocomplete.ts:128-130` | Legacy `@Input()` decorators (`textarea`, `workspaceCwd`) instead of `input()` signals. | Convert to `input()` per convention. |
| 6.2 | `src/renderer/app/features/verification/config/verification-preferences.component.ts:~70-190` | Repeated `$any($event.target)` casts in templates for sliders/checkboxes/text inputs. | Typed event handlers or typed reactive form controls. |
| 6.3 | Renderer-wide | Zero `@defer` usage anywhere, including below-the-fold settings subpanels/large modals/inspectors where the convention explicitly recommends it. | Identify 3-5 genuinely heavy, non-critical panels (settings sub-tabs, large modals) and wrap with `@defer` where it measurably helps first paint — don't apply blanket-wide without measuring. |

**Effort:** ~1-2 days.

---

## Phase 1 as-built (completed 2026-09-15)

- **1.1** `browser-target-persistence-sentinel.ts` empty catch: investigated further — it's injected in-page CDP `evaluate` JS, not main-process Node code. Left the swallow (a hostile/unusual page DOM must not abort the safety scan) but documented the intent inline instead of leaving it bare.
- **1.2** `instance-manager.ts` catches at the audited line numbers: on inspection, all but one already carried a justifying comment (`best-effort`, `non-critical`, `optional`) — those were left as-is since they already meet the "document why" bar. The one unexplained case (`coreDeps: productionCoreDeps()` fallback) now logs a warning with the error instead of failing silently.
- **1.3** `instance-communication.ts:2587` token-stats catch now logs at debug level (best-effort telemetry still never fails the message flow, but failures are now observable). Also fixed the adjacent `adapter as any` cast (was mis-numbered 2.3 in the audit) with a structural type guard against the exported `DeferredToolUse` type instead of `any`.
- **1.4** `agent-tree-persistence.ts`: added an `isEnoent()` helper so "directory doesn't exist yet" stays silent while real IO errors are now logged; the corrupted-snapshot-JSON catch (previously `/* skip corrupted */` with zero visibility) now logs a warning with project/file/error — this was the one genuine data-loss-hiding bug in the group.
- **1.5** `hibernation-manager.ts`: no actual empty/silent catch existed at the audited lines — that finding was about singleton-pattern consistency, which is Phase 2 (item 2.7) scope, not a Phase 1 fix. `hot-model-switcher.ts`'s `validateNewAdapter` catch now logs at debug level before returning `false`.
- **1.6 (expanded per review decision)**: audited all remaining raw `console.*` in `src/main` production code (6 call sites across 3 files, not the audit's rougher 309/74 estimate, which included worker-agent, renderer, tests, and benchmarks). Investigation found the true picture is more nuanced than "sweep everything":
  - `src/worker-agent/**` console usage is **intentional by design** — `worker-file-logger.ts` tees `console.*` to a rotating file specifically because the worker must stay dependency-light and cannot import Electron/`getLogger`. Converting these to a different logging call would work against the documented architecture, not improve it. Left unchanged.
  - `src/renderer/**` console usage is **partly intentional** — `RendererErrorHandler` deliberately keeps `console.error` "so DevTools shows it" alongside IPC forwarding to the main-process logger, and the existing ESLint config already narrowly allows `console.log` in ~10 specific renderer files carrying operator-facing diagnostics. A blanket ban would fight an existing, considered design. Left unchanged — flagged as a design question rather than mechanically "fixed" (see Deferred below).
  - `src/main/**` (true production Node process, always has `getLogger()`, no DevTools) had 3 genuine inconsistencies, all fixed: `codemem/index-worker-main.ts` (3 call sites — confirmed `getLogger` has no Electron dependency and sibling codemem files already use it in the same worker thread) and `skills/skill-loader.ts` (2 call sites). `main-process-entry.ts`'s single `console.error` is a deliberate pre-logger-init bootstrap fallback and was left in place with a clarifying comment.
  - **Lint enforcement added**: `eslint.config.js` now has a `src/main/**/*.ts` override setting `no-console: "error"` with no method allowances (closing the `warn`/`error` gap left by the pre-existing repo-wide rule), scoped away from `logging/logger.ts` itself, `main-process-entry.ts`, and test/benchmark/load paths. This makes the main-process console policy self-enforcing going forward.
- **5.5** (pulled forward): discovered the base lint config already bans `console.log/info/debug` repo-wide via `no-console: ["error", { allow: ["warn", "error"] }]`, with a narrow renderer allowlist — the audit's "no lint enforcement" framing was incomplete. The new `src/main` override above closes the one real gap (`warn`/`error` were still allowed there).

**Deferred (not fixed, flagged for a decision):** renderer console policy is more nuanced than assumed — recommend a follow-up decision doc rather than a mechanical sweep: (a) should uncaught-error paths outside `RendererErrorHandler`'s reach (e.g. `file-explorer.component.ts`'s `console.error('Failed to load directory:', err)`) also forward to the main-process logger via `LoggingIpcService`? (b) should the stray success-path `console.log('Image copied to clipboard')` in `message-attachments.component.ts` simply be removed (it's in the file's existing lint-allowlist, so it's not a violation, just noise)? Neither is a reliability risk on its own, so this was not pursued unprompted under the "no.6" review comment's scope.

**Verification:** `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer` all pass. `npm run test:quiet`: 24,832 of 24,834 passed; the 2 failures (`loop-review-reuse-anchor.spec.ts` timeout, `adapter-factory-copilot.spec.ts` reasoning-effort assertion) are in files untouched by this phase and trace to the pre-existing dirty working tree (`cli.types.ts`, `copilot-cli-adapter.ts`, `claude-cli-adapter.ts` were already modified before this session started) — not introduced by these changes. Targeted specs for every touched file (`instance-manager-logging.spec.ts`, `instance-communication.spec.ts`, `browser-target-persistence-sentinel.spec.ts`, and others) pass.


1. **Phase 1** (reliability/logging) — do first, lowest risk, immediate value, unblocks accurate diagnosis of everything else.
2. **Phase 5.3** (specs for the biggest unspecced files) — do in parallel with Phase 1, so Phase 2's refactor has a safety net before it starts.
3. **Phase 3.8** (adapter parity tests) — do before Phase 3's actual adapter refactors.
4. **Phase 4** (IPC hardening) — independent of 2/3, can run in parallel.
5. **Phase 2** (instance/session decomposition) — highest value but highest risk; do after 1 and 5.3 land.
6. **Phase 3** (adapter consolidation) — after 3.8 tests land.
7. **Phase 5.1/5.2/5.4** (tooling) — opportunistic, no urgency.
8. **Phase 6** (renderer polish) — lowest priority, do whenever convenient.

Each phase should be tracked as its own dated `_plan.md` (linked from a `_spec.md` where the change is non-trivial) per `AGENTS.md`, verified with the canonical gate checklist (`tsc --noEmit` x2, `lint`, `check:ts-max-loc`, `build:main`, `build:renderer`, `test:quiet`) before being marked `_completed`.

## Later-phase as-built (2026-09-16)

Per-phase completed plans: `2026-09-16-architecture-quality-phase2_plan_completed.md`, `phase2b_plan_completed.md`, `phase3_plan_completed.md`, `phase38_plan_completed.md`, `phase4_plan_completed.md`, `phase5_plan_completed.md`, `phase6_plan_completed.md`, `2026-09-17-architecture-quality-remaining_plan_completed.md`. Independent completion-gate: `VERDICT: PASS`.

- **Phase 2:** permissions facade, communication circuit-breaker collaborator, cross-instance store injection, `parseCliShadowReport`, optional `ToolLoopWiringDeps`, singleton `_resetForTesting` alignment. Phase 2b: overflow/last-sent tracker + input-required permission-request flow. Remaining extract: overflow compact/retry/idle/silent-empty policy on `InstanceCommunicationOverflowPolicy`.
- **Phase 3 / 3.8:** shared NDJSON buffer, output-message factory, argv redaction, stderr classifier (Gemini/Copilot/Claude), Claude payload decoders, Copilot server-mode module, adapter lifecycle + Copilot stderr parity tests.
- **Phase 4:** `registerValidatedIpcHandler`, Zod supervision envelopes, IPC auth-token/read helpers, RTK schemas, `ErrorInfo.candidates`, settings write shape, `serializeInstanceForIpc`, preload channel contract.
- **Phase 5:** `npm run check:knip` (warn-only, scoped `knip.json`) and `npm run check:circular`. 5.4: `@angular/*` and `compiler-cli` aligned to `^22.1.7` with CLI / build-angular. `angular-eslint` stays `22.1.0` (only 22.1 published).
- **Phase 6:** composer autocomplete `input()`/`effect()`, typed verification handlers, five settings tabs behind `@defer`.
