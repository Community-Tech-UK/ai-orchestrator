# claude1_todo.md — implementation progress (verified against actual code)

> Untracked working tracker (do NOT commit per AGENTS.md). Status was verified by
> reading the real code, NOT trusting the backlog's or coordination doc's claims
> (operator instruction 2026-05-30). Where the audit/grep said "missing", I
> re-checked the real integration point — several "gaps" were already handled.

## Tooling lesson (load-bearing)
macOS BSD `grep "a\|b"` treats `\|` literally → **false negatives**. My first pass
wrongly concluded #6/#25 were unimplemented. Use the ripgrep Grep tool or `grep -E`.
Agent **positive** evidence (file:line shows X) is reliable; **negative** ("missing")
claims must be re-verified by reading the integration point.

## DONE 2026-05-31 session 2 (self-contained features completed + verified)
- **#22 hook lifecycle (other half)** — added `file.edited` + `tui.command.execute` to the **plugin
  hook bus** (`PluginHookPayloads` in `plugin.types.ts`; NB: NOT the rule-engine `HookEvent` union —
  the dotted-lowercase names belong to the opencode-style plugin bus). `file.edited` emits from
  `instance-communication.ts` on a mutating `tool_use` (one event per resolved path; gated to tool_use
  so it fires once across providers; decoupled from the diff tracker; read-only tools excluded via
  `extractFilePaths`). `tui.command.execute` emits from `command-handlers.ts` COMMAND_EXECUTE after
  applicability passes, before the compact/ui/prompt branch. Tests: 2 emit-site tests in
  instance-communication.spec + 2 bus-dispatch tests in hook-wiring.spec.
- **#12 Magic prompts** — new `src/main/magic-prompts/` (registry + service). Provider-agnostic
  one-shot: reuses `createAdapter`+`sendMessage` (auto-title pattern), embeds a JSON `schemaHint`,
  parses with `extractJson`, validates with Zod → typed discriminated-union result. 3 starter commands
  (recap, commit-message, summarize-diff). Exposed over IPC: channels `magic-prompt:list|run`
  (infrastructure.channels), Zod payloads in command.schemas, handler `magic-prompt-handlers.ts`
  (registered in ipc-main-handler), preload `magicPromptList`/`magicPromptRun`. Injectable deps →
  13 unit tests. Renderer reaches it via the generic `invoke('magic-prompt:run', …)` mapper (no
  renderer code needed). REMAINING for #12: a renderer UI surface to invoke/display results, and
  optional native `--json-schema`/`--output-schema` wiring (Codex already accepts `outputSchema`).
- Verification: electron+renderer+spec tsc ✓ · oxlint (my files) 0/0 ✓ · verify:ipc (941 synced) +
  check:contracts ✓ · my 3 specs 52 tests ✓ · fresh-eyes code-review found no correctness issues.
- NOTE: a concurrent session was editing the repo live during this work (instance-manager, mcp/*,
  settings*, subagent-spawn-guard — none mine). Verification was scoped to my files to avoid
  entangling with their in-flight changes.

## DONE 2026-05-31 session 2 (cont.) — more self-contained features + verified
- **#21 Config {env:}/{file:} interpolation** — new `core/config/config-interpolation.ts`:
  `{env:VAR}`, `{env:VAR:-default}`, `{file:path}` (~ expands), single-pass (resolved content not
  re-scanned = anti-injection), bounded file reads, no-op fast path. Wired into `instruction-resolver`
  so CLAUDE.md/AGENTS.md resolve placeholders at injection time (never persisted). 17 tests; existing
  instruction-resolver tests intact. SECURITY-HARDENED (automated review flagged path traversal):
  {file:} is confined to the project root (lexical + realpath symlink check; absolute/~/`..` rejected)
  and {env:} blocks secret-shaped names by default (allowSecretEnv opt-in) — defeats arbitrary file
  read / secret exfiltration from a hostile repo's CLAUDE.md. (Remaining: per-provider instruction-file
  emission at spawn — largely redundant since instructions already flow in-memory post-interpolation.)
- **#31 Session @T-<id> references + search exposure** — new `session/session-reference-resolver.ts`
  parses `@T-<id>`, archive-searches, annotates text + builds a context block (exact>prefix match;
  no short-id false positives). Exposed the previously-unwired `sessionRecallSearch` + new
  `session-recall:resolve-ref` channel/handler/Zod over preload. 10 tests. (Remaining: renderer
  composer wiring into the send path + a search UI — instance-manager/renderer seam.)
- **#28 Action/cost circuit breaker** — new `security/action-circuit-breaker.ts` (per-instance,
  trips at N actions or $X, auto-resets). Wired into `tool-execution-gate` (downgrades allow→ask;
  zero behavior change when disabled = default). 8 tests; existing gate tests intact. (Remaining for
  #28: modify/synthesize verbs + per-capability matrix need the instance-manager apply-site +
  settings, both concurrent-owned — deferred with documented seam.)
- Verification: electron+renderer+spec tsc ✓ · oxlint (my files) 0/0 ✓ · verify:ipc (942) +
  check:contracts ✓ · 91 tests across 8 specs ✓ · fresh-eyes review (1 finding fixed: removed an
  over-broad id match in the @T resolver).

## DONE 2026-05-31 session 2 (cont. 2) — auto-update + event-driven LSP loop
- **#24 Auto-update** — installed `electron-updater` (operator-consented). New `updates/auto-update-service.ts`
  wraps autoUpdater into one observable status state-machine (idle/checking/available/downloading/
  downloaded/error), disabled in dev (enabled=app.isPackaged), injectable updater for tests. IPC:
  update:check/download/install/get-status + update:status-changed push; preload methods; handler
  registered in ipc-main-handler. `electron-builder.json` gained a `publish` block. 8 tests.
  GATED: replace the placeholder feed URL + add signing/notarization certs before shipping (notarize
  still false).
- **#13 LSP post-edit feedback (architecture + logic)** — adopted the EVENT-DRIVEN COORDINATOR pattern
  (best architecture; avoids editing concurrent-owned instance-manager). New `instance/file-edit-bus.ts`
  (internal main-process bus; emitted from instance-communication alongside the file.edited plugin hook)
  + `codemem/lsp-feedback-coordinator.ts`: debounced, idle-gated, errors-only, loop-guarded (no re-inject
  of identical error sets), DEFAULT-OFF. 9 tests. REMAINING: the real-wiring factory (LSP worker-gateway
  handle → diagnostics, instanceManager.sendInput → inject, enable setting) + runtime validation — the
  coordinator logic is done/tested; activation is a small validated follow-up (auto-injecting into a live
  agent must be runtime-checked before enabling; enable-flag lives in concurrent-owned settings.types).
- The file-edit bus is a reusable seam that also unblocks #11/#18 coordinators later.
- Verification: electron+renderer+spec tsc ✓ · oxlint (my files) 0/0 ✓ · verify:ipc (947) +
  check:contracts ✓ · 114 tests across 10 specs ✓ · native ABI intact after npm install.

## DONE 2026-05-31 session 2 (cont. 3) — multi-provider compare
- **#11 Multi-provider compare** — new `compare/multi-provider-compare-service.ts`: fan out the SAME
  prompt to N providers as parallel ephemeral one-shots (same createAdapter+sendMessage infra as
  magic-prompts — NO instance-manager), per-cell ok/error/duration, provider-notice + empty guards,
  de-dupe + MAX_PROVIDERS cap, `listAvailableProviders()`. IPC `compare:run` / `compare:list-providers`
  + Zod (command.schemas) + handler (registered) + preload. 8 tests. Renderer reaches it via the
  generic invoke mapper. REMAINING: a renderer side-by-side diff UI surface.
- Concurrent session has largely SETTLED: only compaction-coordinator, instance-orchestration,
  settings.types still foreign-modified; instance-manager/mcp/initialization-steps are free again.
  Once settings.types settles, the 1-line activation seams for #13/#28/#31/#18 can be wired.
- Verification: electron+renderer+spec tsc ✓ · oxlint 0/0 ✓ · verify:ipc (949) + check:contracts ✓ ·
  compare 8 tests ✓.

## DONE 2026-05-31 session 2 (cont. 4) — ACTIVATION wiring (concurrent session settled)
Concurrent session settled enough that instance-manager.ts was free; wired the tested-logic seams
into the live paths (minimal, additive edits; re-verified free before each edit):
- **#31 LIVE** — `instance-manager.sendInput` now resolves `@T-<id>` refs (after slash-cmd resolution),
  prepending the referenced session's context block. No-op when no token present.
- **#28 FULLY ACTIVATED** — action dim already gated allow→ask; cost dim now FED by subscribing to
  cost-tracker `cost-recorded` (decoupled, no reverse import) via `security/circuit-breaker-registration`;
  recordCost refactored to accumulate-only (trip at the action gate, not swallowed); config IPC
  `circuit-breaker:get/set` + preload.
- **#13 WIRED** — `codemem/lsp-feedback-registration`: real deps (getLspManager diagnostics → mapped,
  instance idle check, sendInput inject), DEFAULT-OFF flag toggled via `lsp-feedback:get/set` IPC.
- **#18 DONE** — per-agent override rules in permission-manager (`addAgentRule/clearAgentRules/
  getAgentRules`, gathered by `request.context.agentId`), `agentId` plumbed at both gate call sites.
  SECURITY: agent-rule priority clamped to floor 20 so it can NEVER override a system security deny
  (SSH/creds=5, sysdirs=10, dangerous-bash=1) — regression-tested. AbortSignal-per-tool: N/A (CLIs own
  tool exec; instance-level interrupt already exists). "always this session" memory already existed.
- **#11** — multi-provider compare backend (one-shot fan-out) + IPC + preload.
- Fresh-eyes review of the load-bearing wiring → 2 findings FIXED: (1) agent-rule priority clamp [done],
  (2) per-instance counter leak → `terminateInstance` now resets the breaker + forgets LSP state.
- Verification: electron+renderer+spec tsc ✓ · oxlint 0/0 on new files (10 warnings in
  permission/instance-manager are PRE-EXISTING, outside my hunks) · verify:ipc (951) + check:contracts ✓
  · 119+ tests across 12 specs ✓ · existing permission specs (57) still green.

## STILL OPEN (genuinely out of reach in this env — NOT fabricated)
- **#27 repo-map** — large; ranked token-budgeted map needs a codemem feed + spawn-time injection.
- **#15/#29/#30** — renderer UI (checkpoint timeline / per-hunk diff accept-reject / MCP marketplace);
  backends largely exist; can't verify a renderer headlessly here.
- **#10/#26** — durable resumable streams / phase routing: deep changes in instance-manager streaming +
  settings.types (still concurrent).
- **Rocks #1/#2/#3/#16/#20/#23** — multi-week replatforms (thin-client event API, codegen RPC, adapter
  unification, utilityProcess offload, mock+E2E, plugin sandbox). Out of scope for one session.
- **#24 ship-readiness** — replace placeholder publish URL + signing/notarization certs (operator).

## DONE 2026-05-31 session 2 (cont. 5) — runtime fix found via `npm run dev`
- **Context-worker `@contracts/schemas/plugin` crash FIXED** — discovered at runtime: the context
  worker (worker_thread) crashed on load with `Cannot find module '@contracts/schemas/plugin'` and
  exceeded restart attempts → memory/RLM context silently DISABLED every session. Root cause: worker
  threads are separate module realms and don't inherit the main thread's `register-aliases`
  `_resolveFilename` patch; `context-worker-main.ts` never registered aliases. Fix: `require('../register-aliases')`
  as the FIRST statement (before any import), mirroring `index.ts`. register-aliases is worker-safe
  (imports only path+module, no electron). Verified: emitted JS has the require first; isolated load
  test gets PAST the @contracts import; **real `npm run dev` now logs `Context worker started` with
  ZERO crash/degraded/module-not-found in the full log.**
- Evidence-driven scope: only the context-worker needed it — the LSP worker demonstrably loads fine
  WITHOUT register-aliases, and the full boot log shows NO other `@contracts` crash. Deliberately did
  NOT speculatively edit the other 6 worker entries (esp. conversation-ledger, which has explicit
  import-isolation discipline + a guarding spec). If a future worker adds an `@contracts` import and
  crashes, the same one-line bootstrap is the fix.
- **ARCHITECTURAL FIX (prevent the class):** new `src/main/__tests__/worker-alias-bootstrap.spec.ts` —
  pure-fs static guard (mirrors the conversation-ledger import-isolation spec). DYNAMICALLY discovers
  every worker entry (found 8, incl. `logging/log-writer-worker.ts` a manual grep missed), walks each
  one's value-import closure (skipping `import type`), and FAILS any worker that reaches an aliased
  import (@contracts/@shared/@sdk) without `require('../register-aliases')` first. Alias-free workers
  are exempt (no needless no-op). Proven to have teeth: stripping the context-worker bootstrap makes it
  fail with the exact chain (skill-registry→skill-loader→@contracts/schemas/plugin) + the fix. 10 tests.
  Result: only context-worker reaches an alias (now bootstrapped); other 7 genuinely alias-free →
  validates the evidence-driven "don't touch the rest" call, and guards all future workers forever.
- NOTE: my prior session-2 work is all preserved — it was swept into commit 910de7d8 by the concurrent
  session's `git add -A` (agentRules×12, sendInput @T wiring×4, compare/ etc. all in HEAD).

## DONE this session (genuine gaps closed + verified)
- **#25 Store no-op guards** — `instance-state.service.ts`: `updateInstance` now shallow-compares
  with `Object.is` and returns the same state ref when nothing changed (skips waking every
  `instances` computed); `setLoading/setError/setSelectedInstance` short-circuit; `markImagesResolved`
  skips when absent/already-resolved. (loop.store already guarded; settings uses primitive signals.)
- **#7 Transcript cap** — confirmed `TranscriptScrollStrategy` genuinely windows (setRenderedRange).
  Renderer trimmed to a hardcoded 1000 while main retains `LIMITS.OUTPUT_BUFFER_MAX_SIZE=2000` —
  fixed the mismatch so the renderer respects the shared cap (memory-only cost, disk-backed history).
- **#17 Teardown escalation** — per-instance `terminate()` already escalated; added
  `BaseCliAdapter.killAllActiveProcessesGraceful()` (SIGTERM → grace → SIGKILL survivors) and wired it
  into async `cleanup()` so wedged orphan CLIs can't survive quit.
- **#8 runtime_lost surfacing** — `markRuntimeLost` now emits a transcript system note explaining the
  death (it only flips to `error` + logs before). stream:idle watchdog + StuckProcessDetector +
  multi-level activity cascade were already robust.
- **#22 Command interpolation** — new `command-interpolation.ts`: `` !`shell` `` + `@{file}` resolved on
  the raw template BEFORE arg substitution (args can't inject into shell blocks), bounded output/time,
  wired into both command-manager call sites. 6 unit tests.

## Verified ALREADY DONE (no work needed — do not rebuild)
- **#6 Block-memoized markdown** — `markdown.service.ts:303-322` lexer block-split + per-block LRU
  cache (limit 1000) + LRU highlight cache (limit 500) + idle highlighting. Complete.
- **#5 Exact cost (core)** — adapters read real `total_cost_usd`; `cost-tracker.ts` per-call entries;
  sidebar-footer shows session total + Amp-style per-provider breakdown; `showCost()` hide toggle.
  *Remaining refinement:* per-turn INLINE badge (needs CostEntry↔message link) — deferred.
- **#19 Trust controls** — acceptEdits default, YOLO opt-in confirmation, `yolo-badge` in instance
  header w/ tooltip, per-provider flag gating, Electron hardening (sandbox/contextIsolation/senderFrame).

## Verification run
renderer `tsc` ✓ · electron `tsc` ✓ · ESLint (changed files) ✓ (also fixed 1 pre-existing
generic-constructor violation in command-manager.ts) · vitest: command-interpolation 6, instance
state 29, markdown-registry 8, instance-manager 56 — all green.

## REMAINING (verified PARTIAL/OPEN — accurate state + what's actually missing)

### Multi-week architectural rocks (coordination doc: do NOT start autonomously)
- **#1 Thin-client event API** — PARTIAL. observer-server SSE + provider-runtime-event-bus +
  normalized union (`provider-runtime-events.ts`) exist but are a *secondary* path; main UI still on
  IPC. XL replatform — needs design pass + operator decision.
- **#2 Code-gen typed RPC** — PARTIAL. `packages/contracts` EXISTS (schemas/channels/types + Zod);
  no codegen of preload bridge/renderer client from one spec. L.
- **#3 Adapter unification** — PARTIAL. `BaseProvider` + `adapter-runtime-event-bridge` normalize to the
  union; adapters still ~7.2k LOC (codex 2728, claude 1819, acp 1846) hand-rolling framing. Official
  SDKs not adopted. L — highest-leverage seam; unlocks #20.
- **#16 utilityProcess offload** — OPEN. spawn+JSONL parse on main thread; `KeyedCoalescingWorker`
  exists but unused for this. L.
- **#20 Mock adapter + Playwright E2E** — PARTIAL. `MockCliHarness` exists; no union-mapper scripted
  mock / fixtures / Playwright. XL, depends on #3.
- **#23 Plugin sandboxing** — OPEN. plugins run in-process via dynamic `import()`. L.

### Operator-gated
- **#24 Auto-update** — OPEN. No electron-updater; `notarize:false`. Needs `npm i electron-updater`
  (CLAUDE.md forbids installing deps without consent) + signing/notarization certs.

### Collision risk (in-flight model-picker session owns these files)
- **#4 Per-instance routing/model memory** — PARTIAL. instanceId threaded everywhere; no
  per-instance model memory (`modelByProvider`) / canonical per-instance event log.
- **#9 models.dev → picker** — PARTIAL. `models-dev-service.ts` fetches + bootstrap refresh + pricing
  overlay; not wired into the picker UI / no live-refresh signal.

### Self-contained features (M, finishable next — not collision/dep-blocked)
- **#11 Multi-provider compare UI** — consensus/debate backend exists; needs a user-facing
  "ask N providers, diff answers" renderer surface + broadcast prompt.
- **#12 Magic prompts** — needs `--json-schema`/`--output-schema` adapter flags + structured_output
  parsing + a few schema-backed one-shot commands.
- **#13 LSP post-edit feedback** — `AgentLspFacade.diagnostics()` ready; trigger point is
  `tool-output-parser.ts:172` (Write/Edit); needs debounced didChange→diagnostics→inject-to-agent. L.
- **#14 Session sharing links** — `SessionShareService` bundles + observer SSE exist; needs
  /share link gen + access control + web replay. L.
- **#15 Checkpoint timeline UI** — `git-checkpoint-store` write-tree/restore solid; needs transcript
  per-turn timeline + Files/Conversation/Both restore + shadow-repo isolation. L.
- **#18 Glob per-agent perms** — `permission-manager` has globToRegex + rules; needs per-agent
  overrides + AbortSignal-per-tool + "always this session" memory.
- **#21 Config {env:}/{file:} interpolation** — merge + instruction-resolver exist; needs interp engine
  + per-provider instruction-file emission at spawn. (MCP-injection secrets semantics are subtle —
  needs care so secrets resolve at injection, not persistence.)
- **#22 hook lifecycle** (other half) — add `file.edited` / `tui.command.execute` to the hook bus.
- **#26 Phase/role routing** — model-router routes by complexity; needs Plan→Act / lead→worker phase
  handoff as a session setting + transcript stitching. L.
- **#27 Repo-map injection** — codemem+BM25 exist; needs ranked token-budgeted repo-map + @-mention
  resolver injected into every provider prompt. M-L.
- **#28 Permission verbs** — evaluator does allow/deny/ask; needs modify/synthesize verbs +
  per-capability matrix + action/cost circuit breaker.
- **#29 Diff/plan UX** — `diff-viewer` has per-line accept/reject; needs wiring into agent-proposed
  edits + Esc-Esc/Enter-Enter steering + Mermaid plan rendering.
- **#30 MCP marketplace** — `shared-mcp-coordinator` central injection halfway; needs marketplace UI +
  registry + one-click install.
- **#31 Session search/@T-id** — `SessionRecallService.search()` exists; needs @T-<id> resolver in the
  input path + a search UI surface.
- **#10 Durable resumable streams** — session continuity + resumeCursor-in-spawn exist; needs durable
  per-message stream + verified mid-turn reattach after reload. L.

## Log
- 2026-05-30: Audited all 31 via 6 parallel investigators; directly re-verified disputed claims
  (#6 DONE, packages/contracts EXISTS, #19 DONE). Closed genuine gaps #7/#8/#17/#22/#25; confirmed
  #5/#6/#19 already done. Full typecheck+lint+tests green. Remaining are L/XL rocks, operator-gated,
  collision-risky, or M-features queued above.
