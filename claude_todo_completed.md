# AI Orchestrator — Improvement TODO (t3code + opencode comparison)

> **Scope.** A focused comparison of `ai-orchestrator` against two sibling projects only:
> `../t3code` (a minimal GUI wrapper for coding-agent CLIs, built on the Effect ecosystem
> and the Agent Client Protocol) and `../opencode` (the open-source AI coding agent —
> client/server, mature provider abstraction). Deep-dive passes read actual source.
>
> **Verification.** Every "Current state" claim below was checked against the live tree by
> reading the files. Findings that turned out to be **already done** were dropped — see
> *"Already strong"* below. Where a prior pass (`claude4_completed.md`,
> `claude5_completed.md`) flagged something, it is only re-listed if a fresh read shows it
> is still a real gap, and this doc adds the concrete t3code/opencode pattern to copy.
>
> **Built over three passes.** The numbering below is the final integrated priority order.
> Each pass also verified — and therefore did *not* list — several candidates that turned
> out to be already implemented; the most notable are recorded under *"Already strong"* so
> the due diligence is visible.
>
> **Relationship to `codex_todo.md`.** A sibling `codex_todo.md` exists from the same
> exercise. This is an independent Claude pass. Some overlap is expected — both found the
> same real gaps — but this doc differs in prioritization and surfaces several items
> `codex_todo.md` did not (typed-RPC boundary, CLI fixture replay, scripted provider
> adapter, SQLite statement caching, metrics, crash capture, auto-update, E2E testing,
> plugin sandboxing, spawned-helper secret hardening).

---

## Already strong — verified, do NOT redo

A fresh read confirms these are implemented well. They are *not* on the list below:

- **Permission engine** — `src/main/security/permission-manager.ts` is *already* "inspired
  by OpenCode": rule shape `{ permission, pattern, action }`, glob matching, composable
  rulesets (agent + user + project + default), session decision caching.
- **Per-turn checkpointing** — `src/main/session/git-checkpoint-store.ts` already supports
  a shadow-git `mode: 'git' | 'shadow'` (opencode's snapshot pattern).
- **Tracing** — `src/main/observability/` already has `otel-setup.ts`, `otel-spans.ts`,
  and `local-trace-exporter.ts` (t3code's local-trace-file model). *Metrics* are the gap — see #7.
- **Context compaction** — `src/main/context/` is mature (`context-compactor.ts`,
  `microcompact.ts`, `context-collapse.ts`, a prune pass with the same `PRUNE_MINIMUM`
  constant opencode uses, `token-budget-tracker.ts`). `codex_todo.md` #13 covers the
  remaining anchored-template refinement; not repeated here.
- **Config layering** — `src/main/core/config/` already has `config-layers.ts` +
  `config-resolver.ts` (global/project/instruction precedence).
- **Subagent / child-session model** — `src/main/orchestration/derive-subagent-permission.ts`,
  `background-task-manager.ts`, `child-result-storage.ts`, `durable-approval-store.ts` —
  opencode's subagent-as-child-session-with-derived-permissions pattern is largely present.
- **Tool output handling** — `tools/tool-result-normalizer.ts` + `tool-use-summarizer.ts`
  already normalize and truncate tool results.
- **Code search** — `src/main/indexing/` is a full semantic stack (BM25 + embeddings +
  tree-sitter chunking + merkle-tree incremental indexing) — *ahead* of opencode's
  shell-to-ripgrep approach.
- **ACP + Codex transports exist** — `acp-cli-adapter.ts` is a real ACP client;
  `codex/app-server-client.ts` is a mature JSON-RPC client. The gap is *consolidation*, not absence.
- **Unit/component test depth** — 441 main-process specs + 102 renderer component specs +
  a `smoke:electron` launch check. The gap is *end-to-end* coverage — see #13.
- **Generated IPC** (775 channels, `verify:ipc` + `check:contracts` guards),
  **SQLite driver abstraction**, **forked + memory-capped tool sandbox**,
  **oxlint + oxfmt, `check:ts-max-loc`, turbo, bootstrap registry, macOS native-ABI CI
  smoke** — all present.

---

## TL;DR — priority order

| # | Item | Borrowed from | Effort | Risk |
|---|------|---------------|--------|------|
| 1 | Unify & flatten the CLI adapter + provider layer | t3code, opencode | L | Med–High |
| 2 | Schema-first typed RPC for the renderer↔main boundary | opencode, t3code | L | Med |
| 3 | Code-generate provider protocol bindings from pinned upstream | t3code | M | Low |
| 4 | CLI subprocess fixture-replay (cassettes) | opencode | M | Low |
| 5 | Reusable scripted/mock provider adapter for offline tests | opencode, t3code | M | Low |
| 6 | Cache SQLite prepared statements on the hot path | opencode | S–M | Low |
| 7 | Add metrics + complete OTel span coverage | t3code, opencode | M | Low |
| 8 | Crash capture & renderer crash recovery | opencode, code review | M | Low |
| 9 | Auto-update & release/distribution pipeline | t3code | M | Low–Med |
| 10 | Harden secret passing to spawned helpers | t3code | S–M | Low–Med |
| 11 | Ship a custom oxlint plugin for project invariants | t3code | M | Low |
| 12 | Close the CI coverage gaps | code review | S | Low |
| 13 | End-to-end testing of the running app (Playwright) | opencode, t3code | M | Low |
| 14 | Sandbox plugins the way tools are already sandboxed | code review | M | Med |
| 15 | Pin the toolchain + deterministic multi-instance dev-runner | t3code | S–M | Low |
| 16 | Ship a comprehensive committed model-capability catalog | opencode | S–M | Low |
| 17 | Deterministic test synchronization (drainable workers) | t3code | M | Low |
| 18 | Consolidate the error taxonomy | t3code, opencode | M | Med |

---

## P0 — Architecture (highest leverage)

### 1. Unify & flatten the CLI adapter + provider layer

**Current state (verified).** `src/main/cli/adapters/` is ~15,000 LOC across 7 adapters
(`codex-cli-adapter.ts` 3,003 LOC, `claude-cli-adapter.ts` 2,169, `acp-cli-adapter.ts`
2,141, …). The contract leaks badly:

- `spawn()` is **not on `BaseCliAdapter`** — each adapter reimplements it with divergent
  return semantics; Gemini and Codex return **fake random PIDs**
  (`Math.floor(Math.random()*100000)+10000`).
- **Three separate NDJSON parsers**: `cli/ndjson-parser.ts` (Claude only),
  inline `chunk.split('\n')` (Gemini, Cursor), and `codex/exec-transcript-parser.ts`.
- **Two parallel capability systems** (`CliCapabilities` + `AdapterRuntimeCapabilities`).
- `checkStatus()`, version-regex parsing, token/usage extraction (Gemini has 4 fallback
  formats), and timeout/watchdog logic are re-implemented near-identically per adapter.
- **Two parallel abstraction layers**: the live path (`instance-lifecycle.ts`) drives
  `CliAdapter` objects directly; `providers/` (`BaseProvider`, `FailoverManager`,
  `ProviderInstanceManager`) is fully built but **bypassed on the hot path**.
  `AnthropicApiProvider` is a complete direct-SDK integration that is **not registered**
  anywhere (dormant code).
- `acp-cli-adapter.ts` says it is "intentionally transport-focused… does not expose ACP
  as a first-class UI-selectable provider yet."

**Reference.** t3code forces *every* agent — Codex (app-server JSON-RPC), Claude (SDK),
Cursor (ACP), OpenCode (HTTP SDK) — through one `ProviderAdapterShape` interface that
emits one canonical `ProviderRuntimeEvent` discriminated union (**47 typed variants**:
tool calls, plan updates, token usage, request lifecycle, reasoning, …) with a `raw`
field preserving the un-normalized provider payload
(`t3code/packages/contracts/src/providerRuntime.ts`). opencode's `packages/llm` splits
the concern into orthogonal axes — Protocol / Endpoint / Auth / Framing — so providers
sharing an output shape reuse code with zero forks (`packages/llm/src/route/client.ts`).

**Do this.**
- Put `spawn()` on the base class with one return type (a real, typed process handle —
  never a fake PID). One streaming **frame parser** (NDJSON today; make it transport-shaped
  so a header-framed transport can slot in later).
- Collapse the two capability systems into one.
- Expand `ProviderRuntimeEventEnvelope` toward t3code's granularity and **keep a `raw`
  escape hatch** — this directly addresses the `MEMORY.md` "Task 16 / `ProviderOutputEvent`
  is lossier than `OutputMessage`" note.
- Pick **one** load-bearing layer. Either route `instance-lifecycle.ts` through
  `providers/` (so `FailoverManager` is actually exercised) or delete the unused half.
  Decide `AnthropicApiProvider`'s fate: register it or remove it.
- **Promote ACP to a first-class, UI-selectable transport.** Any ACP-capable agent
  (Cursor, Gemini, Copilot) should route through `acp-cli-adapter.ts` as a real provider.
- Headless pipes are the *correct* default for structured agents — t3code does the same
  and explicitly avoids PTY-ing agents. If the in-flight `codex/loop-terminal-control`
  work needs a genuine TTY, copy t3code's swappable `PtyAdapter`
  (`apps/server/src/terminal/Services/PTY.ts`) and its `ensureNodePtySpawnHelperExecutable`
  chmod-fix for packaged builds — don't PTY the agents.

**Files.** `src/main/cli/adapters/*`, `src/main/cli/ndjson-parser.ts`,
`src/main/providers/*`, `src/main/instance/instance-lifecycle.ts`, `packages/contracts`.

**Effort.** L. **Risk.** Med–High — this is the running-instance hot path. Land behind
behavior tests per adapter before deleting old code.

**Validation.** Per-adapter behavior tests first; then `npm run typecheck` +
`typecheck:spec` + `lint:fast` + `test` + `smoke:electron`.

---

### 2. Make the renderer↔main boundary a schema-first typed RPC

**Current state (verified).** IPC is 775 generated channel constants + Zod schemas in
`packages/contracts/src/schemas/*`. It works, but: it is **convention-and-script
enforced**, not a single typed RPC layer — nothing guarantees at compile time that a
channel has a handler (the runtime `verify:ipc` script fills that gap). Validation
adoption is **inconsistent**: a clean `ipc/validated-handler.ts` wrapper exists, yet
`ipc/handlers/provider-handlers.ts` hand-writes `try/catch` + `validateIpcPayload` +
manual `IpcResponse` per handler. Channels carry a payload schema but **no per-channel
error schema**. `packages/sdk` is described as an external SDK but is really an internal
types module with no build output or client.

**Reference.** opencode declares its API schema-first (Effect `HttpApi`, every endpoint
with query/body/**success/error** schemas) and **mechanically generates the typed client**
from the live server's OpenAPI via `@hey-api/openapi-ts` — zero client drift
(`packages/sdk/js/script/build.ts`). t3code declares each method once as
`Rpc.make(METHOD, { payload, success, error, stream? })` grouped into a `RpcGroup`
consumed by both server and client — one declaration, both sides typed, drift impossible
(`t3code/packages/contracts/src/rpc.ts`).

**Do this.**
- Treat each IPC channel as a typed RPC: declare **payload + success + error** schemas
  together, in one place.
- Make `validated-handler.ts` the *only* handler entry point; convert `provider-handlers.ts`
  and any other hand-rolled handlers to it. Add a lint rule (see #11) banning raw `ipcMain.handle`.
- **Generate** the renderer-side typed client/facade from the contract.
- This also gives `packages/sdk` a real reason to exist: the generated contract artifact
  *is* the SDK surface for any future plugin/remote integration.
- This is the pragmatic, in-process version. The full opencode model — orchestration
  engine behind a local HTTP/WS server, renderer as an HTTP client — is a larger bet
  worth noting: it would make the engine independently testable/scriptable and unlock a
  future remote/mobile client. Not required now; the typed-RPC-over-IPC step is the
  prerequisite either way.

**Files.** `packages/contracts/*`, `src/main/ipc/*`, `src/preload/*`, `packages/sdk/*`,
`scripts/generate-preload-channels.js`.

**Effort.** L. **Risk.** Med — wide but mechanical; `verify:ipc` guards the migration.

**Validation.** `verify:ipc`, `verify:exports`, `check:contracts`, `typecheck`, `test`.

---

### 3. Code-generate provider protocol bindings from pinned upstream schemas

**Current state (verified).** Codex and ACP wire types are **hand-maintained** —
`src/main/cli/adapters/codex/app-server-types.ts` is a hand-written file;
`acp-cli-adapter.ts` hard-codes `ACP_PROTOCOL_VERSION = 1` and the message shapes. Every
upstream protocol change is a manual edit. (`claude4_completed.md` #10 flagged this; a
fresh read shows it has not landed.)

**Reference.** t3code never hand-maintains protocol types. `packages/effect-acp/scripts/
generate.ts` downloads a **pinned** upstream ACP schema release
(`CURRENT_SCHEMA_RELEASE = "v0.11.3"`) and generates `src/_generated/schema.gen.ts`
(~10k lines) + a method-name map. `packages/effect-codex-app-server/scripts/generate.ts`
does the same for Codex's app-server protocol (~36k generated lines). The pinned version
is one constant; bumping it regenerates everything.

**Do this.**
- Add `scripts/generate-acp-schema.ts` and `scripts/generate-codex-protocol.ts` that
  fetch a pinned upstream release and emit typed bindings (Zod schemas + method maps)
  into a `generated/` dir.
- Pin the release as a single `const`. Add a CI check that the committed generated file
  matches a fresh generation (same pattern as `verify:ipc`).
- Replace the hand-written `app-server-types.ts` / ACP types with imports from generated.

**Files.** new `scripts/generate-*`, `src/main/cli/adapters/codex/*`,
`src/main/cli/adapters/acp-cli-adapter.ts`.

**Effort.** M. **Risk.** Low — additive; generated output is type-checked against existing usage.

**Validation.** `typecheck`, the new generation-drift CI check, ACP/Codex adapter specs.

---

## P1 — Reliability & correctness

### 4. CLI subprocess fixture-replay (cassettes) — unblocks the deferred Task 24

**Current state (verified).** CLI adapters produce non-deterministic streaming output
that is hard to test. `MEMORY.md` records: *"Task 24 fixture-replay deferred pending
adapter `__feedRaw` hooks this codebase doesn't have."* So the team already wants this.

**Reference.** opencode's `packages/http-recorder` is a polished VCR-style record/replay
layer. **Cassettes** are JSON files of interactions (`cassette.ts`); a middleware runs in
modes `auto` / `record` / `replay` / `passthrough` — **`auto` records locally and replays
in CI** (`resolveAutoMode`); `matching.ts` canonicalizes requests and emits
human-readable diffs on mismatch; **`redaction.ts` scans for secrets and refuses to write
a cassette containing them** (`UnsafeCassetteError`).

**Do this.**
- Add the missing `__feedRaw`-style seam: a hook on the base adapter that lets a test
  feed a recorded stdout/stderr stream in place of a real process.
- Build a cassette format for CLI subprocess I/O (spawn args + env + ordered stdout/
  stderr/exit). Record real CLI runs to `src/main/cli/adapters/__fixtures__/*.cassette.json`.
- Mode: auto-record locally, **replay-only in CI** (deterministic).
- **Secret-scan before writing** a cassette — reuse `src/main/security/secret-detector.ts`.

**Files.** `src/main/cli/adapters/base-cli-adapter.ts` (the `__feedRaw` seam),
new `src/main/cli/adapters/__fixtures__/` + a replay harness, `vitest.config.ts`.

**Effort.** M. **Risk.** Low — test infrastructure only.

**Validation.** A round-trip test (record → replay → identical normalized events);
secret-scan negative fixture; the replay suite runs green in CI.

---

### 5. Ship a reusable scripted/mock provider adapter for offline orchestration tests

**Current state (verified).** No reusable `MockAdapter` / `FakeProvider` /
`ScriptedAdapter` exists — a grep finds only inline mocks inside individual spec files.
`claude4_completed.md` #12 recommended "a mock provider so the orchestration loop is
testable offline"; a fresh read shows no shared artifact landed. The orchestration
coordinators (debate, verify, consensus, loop) can therefore only be exercised against
real CLIs or one-off per-spec fakes.

**Reference.** opencode's whole runtime is testable because the provider is an interface,
not a concretion. t3code provides `makeInMemoryStdio`
(`effect-acp/_internal/stdio.ts`) — an in-memory transport pair purely for tests.

**Do this.**
- Once #1 lands a clean adapter contract, ship **one** reusable `ScriptedAdapter` behind
  it: it emits a programmed timeline of canonical runtime events (text deltas, tool
  calls, token usage, errors, idle, mid-stream crash) with no process and no network.
- Use it to test the debate / verify / consensus / loop coordinators deterministically.
- This is the complement of #4: cassettes give *real-session fidelity* (regression
  protection); the scripted adapter gives *synthetic edge cases* (timeouts, malformed
  events, partial streams) that are painful to capture for real.

**Files.** new `src/main/cli/adapters/scripted-adapter.ts` (test utility),
`src/main/orchestration/__tests__/*`.

**Effort.** M. **Risk.** Low — test infrastructure only.

**Validation.** A coordinator spec that runs a full debate/verify round against the
scripted adapter with zero network or child processes.

---

### 6. Cache SQLite prepared statements on the hot path

**Current state (verified).** ~**144 inline `db.prepare(sql)` calls** across
`src/main/rlm/`, `src/main/orchestration/event-store/`, `src/main/persistence/`, each
*inside* a per-call CRUD function. There is **no statement cache anywhere** (grep for
`prepareCached` / `stmtCache` / `preparedStatements` returns nothing). Every read/write —
including event-store `append()` and BM25 search — recompiles SQL.

**Reference.** opencode prepares statements once and threads them through; its
`packages/opencode/src/storage/db.ts` sets a sane pragma set
(`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout`, `foreign_keys=ON`) once at
open and uses Drizzle (which prepares + caches).

**Do this.**
- Add a small `prepareCached(sql)` helper on the SQLite driver layer (`src/main/db/`) —
  a `Map<string, Statement>` keyed by SQL text, populated lazily.
- Convert the hot modules (`rlm/rlm-stores.ts`, `orchestration/event-store/
  orchestration-event-store.ts`, `indexing/bm25-search.ts`) to use it.
- Longer-term, opencode's move to **Drizzle + a hybrid schema** + **bundled timestamped
  migrations** is worth evaluating, but statement caching is the cheap, low-risk win first.

**Files.** `src/main/db/*`, `src/main/rlm/rlm-stores.ts`,
`src/main/orchestration/event-store/orchestration-event-store.ts`,
`src/main/indexing/bm25-search.ts`.

**Effort.** S–M. **Risk.** Low.

**Validation.** Existing DB specs; a `bench` comparison on event-append / search before & after.

---

### 7. Add metrics + complete OTel span coverage

**Current state (verified).** `src/main/observability/` does **tracing only** —
`otel-setup.ts`, `otel-spans.ts`, `local-trace-exporter.ts`, `lifecycle-trace.ts`,
`provider-runtime-trace-*`. A grep for `createCounter` / `Histogram` / `Meter` / `Counter`
returns **nothing**: there are **no metrics** — no counters, no timers/histograms. Spans
are also created manually, so coverage exists only where someone remembered to add one.

**Reference.** t3code's `apps/server/src/observability/Metrics.ts` defines counters +
timers (`t3_rpc_requests_total`, `t3_provider_turn_duration`,
`t3_orchestration_command_ack_duration`, `t3_db_query_duration`, …) attached via a
pipeable `withMetrics({ counter, timer, attributes })` combinator that records duration +
an outcome-labeled counter from the call's result. Its rule: high-cardinality detail
(IDs, paths) → span annotations; low-cardinality (operation kind, provider, outcome) →
metric labels. opencode wraps every tool call in a span.

**Do this.**
- Add an OTel `Meter` to `otel-setup.ts`. Define counters/timers for what matters for a
  "thousands of instances" app: instance spawn count + duration, provider turn duration,
  orchestration command latency (dispatch → first event), IPC request duration, DB query
  duration, CLI restart count.
- Add a `withMetrics`-style wrapper so instrumenting an operation is one wrapped call.
- Audit adapter calls / IPC handlers / spawned-process calls for span coverage.

**Files.** `src/main/observability/*`, plus instrumented call sites.

**Effort.** M. **Risk.** Low — additive.

**Validation.** Metrics visible in local trace / OTLP output; a smoke test asserting
counters increment on a spawn + a turn.

---

### 8. Crash capture & renderer crash recovery

**Current state (verified).** `src/main/index.ts` has `process.on('uncaughtException')`
and `process.on('unhandledRejection')` handlers (lines 347 / 351) — basic main-process
logging only. Beyond that there is **nothing**: no Electron `crashReporter`, no
`render-process-gone` / `child-process-gone` / `gpu-process-crashed` handling, and the
**renderer has zero global error handling** (no custom Angular `ErrorHandler`, no
`window.onerror` / `unhandledrejection` listener — a grep across `src/renderer/app`
returns no hits). A renderer crash today produces a silent dead window with no recovery;
a renderer uncaught error is simply lost. `diagnostics/operator-artifact-exporter.ts`
produces redacted support bundles, but only when a user manually triggers one — nothing
is captured automatically at crash time.

**Reference.** opencode wires Sentry (`@sentry/solid` + `@sentry/vite-plugin` are in its
dependency catalog) for crash/error telemetry. Electron's own `crashReporter` and the
`render-process-gone` event are the platform primitives. t3code's observability model
(a local NDJSON trace as the always-on artifact) is the privacy-respecting local
equivalent of an upload.

**Do this.**
- Add a custom Angular `ErrorHandler` and a `window.addEventListener('unhandledrejection')`
  in the renderer; forward both to the main-process logger over IPC.
- Handle `app.on('render-process-gone')` (and per-`webContents`) — show a recovery UI
  with a reload action instead of a dead window.
- On any crash / uncaught path, **auto-write a redacted crash artifact** through the
  existing `operator-artifact-exporter.ts` + `redaction.ts` pipeline (reuse, don't rebuild).
- Optionally enable Electron `crashReporter` for local minidumps; keep any *upload*
  strictly opt-in (local-first, same privacy stance as the trace exporter).

**Files.** `src/main/index.ts`, `src/renderer/app/app.config.ts` (the `ErrorHandler`
provider), a new renderer error service, `src/main/diagnostics/operator-artifact-exporter.ts`.

**Effort.** M. **Risk.** Low — additive, no hot-path change.

**Validation.** Force a renderer throw and a renderer-process kill; confirm the recovery
UI appears and a redacted crash artifact is written.

---

### 9. Auto-update & release/distribution pipeline

**Current state (verified).** `package.json` has **no `electron-updater`**;
`electron-builder.json` has **no `publish` block**; the `mac` target is
`notarize: false` and `arch: ["arm64"]` only. The build *emits* `release/latest-mac.yml`
(an update manifest) but **nothing consumes it** — there is no in-app update path.
Consequences: shipped users are stranded on whatever version they installed (no security
fixes, no bug fixes); an un-notarized arm64-only DMG is Gatekeeper-blocked on a fresh Mac
and excludes Intel hardware entirely. (`release/` even still contains stale
`Claude Orchestrator-*.dmg` artifacts beside `AI Orchestrator-*.dmg` — leftovers from the
app rename.)

**Reference.** t3code ships a complete desktop release pipeline: `scripts/
build-desktop-artifact.ts`, `electron-updater` wired into the app,
`merge-update-manifests.ts`, a `mock-update-server.ts` for testing the update flow,
`resolve-nightly-release.ts` for a nightly channel, and `notify-discord-release.ts`.
`electron-updater` + a `publish` target is the standard Electron answer.

**Do this.**
- Add `electron-updater`; wire `autoUpdater.checkForUpdatesAndNotify()` into the main
  process with a user-visible "update available / restart to apply" affordance.
- Add a `publish` target to `electron-builder.json` (GitHub Releases or a generic server).
- Enable macOS **notarization** (`notarize: true` + Developer ID signing) — auto-update on
  macOS *requires* signed + notarized builds — and add an **x64 (or universal) mac
  target**, plus Windows/Linux targets as distribution needs dictate.
- Add a `mock-update-server`-style test so the update flow is exercised without a real release.
- Remove the stale `Claude Orchestrator` artifacts; keep `appId` / `productName` stable
  (auto-update keys off them).

**Files.** `package.json`, `electron-builder.json`, new `src/main/app/auto-updater.ts`
(wired from `index.ts`), `scripts/`, `.github/workflows/ci.yml`.

**Effort.** M. **Risk.** Low–Med — the signing/notarization setup is fiddly but well-trodden.

**Validation.** A `mock-update-server` round-trip: the app detects, downloads, and applies
a newer version.

---

## P1 — Guardrails, CI & testing

### 10. Harden secret passing to spawned helpers

**Current state (verified).** The remote `worker-agent` receives its auth token via a
`--token` **CLI argument** — `src/worker-agent/worker-config.ts` does
`parseCliArgs(process.argv.slice(2))` then `if (args['token']) merged.authToken =
args['token']`. Anything on argv is visible in the OS process table (`ps`, `/proc`) to
any local user. `start-worker.sh` forwards `"$@"` straight through.

**Reference.** t3code's `apps/desktop/src/backend/DesktopBackendManager.ts` deliberately
passes the backend's bootstrap config — including secrets — as JSON over **file
descriptor 3** (`additionalFds.fd3`) rather than argv, explicitly to keep secrets off the
process table.

**Do this.**
- Pass the worker-agent token (and any other secret bootstrap) over **stdin or a
  dedicated fd**, not argv. Keep `--token` as a deprecated fallback for one release.
- Audit the other spawned helpers (`loop-control-cli`, SEA binaries) for the same pattern.
- While here, confirm the enrollment token is stored at rest via Electron `safeStorage`
  (claude5 A5 territory).

**Files.** `src/worker-agent/worker-config.ts`, `worker-agent.ts`, `cli/service-cli.ts`,
`start-worker.sh` / `start-worker.bat`, the spawn site in `src/main/remote-node/`.

**Effort.** S–M. **Risk.** Low–Med — changes the worker bootstrap contract; version it.

**Validation.** Process-table inspection shows no token; worker enrollment round-trip test.

---

### 11. Ship a custom oxlint plugin for project invariants

**Current state (verified).** `.oxlintrc.json` has **no `jsPlugins`** and only ~10
generic rules. Project-specific invariants are unenforced. (`claude4_completed.md` #14
recommended custom rules; a fresh read shows none exist.)

**Reference.** t3code ships `oxlint-plugin-t3code/` — a complete, copyable template:
`index.ts` (`definePlugin`), `rules/no-inline-schema-compile.ts` (`defineRule` with
`createOnce` returning AST visitors, `functionDepth` tracking), `utils.ts`, and
`test/utils.ts` — a harness that **spawns the real `oxlint` binary** against a temp
fixture so rules are tested end-to-end. Wired via `"jsPlugins": ["./oxlint-plugin-t3code/index.ts"]`.

**Do this.** Stand up `oxlint-plugin-ai-orchestrator/` from t3code's template and write
rules for invariants this codebase actually cares about:
- No raw IPC channel **string literals** outside the generated channel modules.
- No unvalidated `JSON.parse` on IPC / provider / tool payloads.
- No `EventEmitter.emit()` outside the `IpcEventBusService` facade (directly enforces the
  Wave 2 work in `MEMORY.md` — Tasks 25/26/27).
- No `EventEmitter` listener registration without a matching cleanup in long-lived services.
- No direct `ipcMain.handle` (must go through `validated-handler.ts` — pairs with #2).

Start every rule at `warn`, ratchet to `error` after cleanup.

**Files.** new `oxlint-plugin-ai-orchestrator/`, `.oxlintrc.json`, `package.json`
(`@oxlint/plugins` devDep), CI.

**Effort.** M. **Risk.** Low.

**Validation.** Per-rule positive/negative fixtures via the spawn-the-linter harness;
`lint:fast` in CI.

---

### 12. Close the CI coverage gaps

**Current state (verified — `.github/workflows/ci.yml`).** The `quality` job runs
fmt/lint/typecheck/`verify:ipc`/`verify:exports`/`check:ts-max-loc`/`build:main`/
`build:worker-agent`/test. Gaps:
- **`build:renderer` is never run** — the Angular production build is not exercised in CI.
- **`verify:architecture`** (import-boundary + architecture-inventory) and
  **`check:contracts`** are not run, though both exist and `verify` includes them.
- **`npm audit` is `continue-on-error: true`** (non-blocking).
- No **`electron-builder` packaging smoke** — and `AGENTS.md` documents two traps that
  have *silently broken the packaged DMG twice*.

Separately: `turbo.json` declares `generate:ipc` output as `src/preload/channels.ts`, but
the generator writes `src/preload/generated/channels.ts` — the stale glob makes that
task's caching unreliable.

**Do this.**
- Add `build:renderer` to CI (catch Angular AOT/template breakage before release).
- Add `verify:architecture` + `check:contracts` steps.
- Make `npm audit` blocking with a tracked allowlist for the known-unfixable `protobufjs`
  transitive CVE, so *new* vulns fail the build.
- Add a minimal `electron-builder` packaging smoke (even `--dir`, no signing) on the
  `macos-smoke` job.
- Fix the `turbo.json` `generate:ipc` output glob.

**Files.** `.github/workflows/ci.yml`, `turbo.json`.

**Effort.** S. **Risk.** Low.

**Validation.** CI goes green with the new steps; intentionally break a template and
confirm CI catches it.

---

### 13. End-to-end testing of the running app (Playwright)

**Current state (verified).** Testing is strong at the unit level — 441 main-process
specs + 102 renderer component specs + a `smoke:electron` launch check. But there is **no
end-to-end test that drives the real running app** — renderer + preload + IPC + main
together, through actual user flows. `package.json` has no `playwright` /
`@playwright/test` / `webdriverio` (`puppeteer-core` is present, but for the app's
*browser-automation feature*, not for testing). The integration seam — exactly where #1
(adapter unification) and #2 (typed RPC) carry the most regression risk — is covered only
by a launch smoke.

**Reference.** opencode tests with Playwright (`@playwright/test` in its catalog); t3code
has a `test:desktop-smoke` turbo task for its Electron app.

**Do this.**
- Add Playwright with Electron support (the `_electron` launcher). Write E2E specs for the
  highest-value flows: create an instance → send a prompt → see streamed output; run a
  debate / verification round; resume a session; the settings + MCP surfaces.
- Drive E2E against the **scripted provider adapter (#5)** so runs are deterministic and
  offline.
- Run E2E in CI on the `macos-smoke` job (it already builds the app) — pairs with #12.

**Files.** new `e2e/`, `playwright.config.ts`, `package.json` scripts,
`.github/workflows/ci.yml`.

**Effort.** M. **Risk.** Low — additive.

**Validation.** E2E suite green locally and in CI; intentionally break an IPC channel and
confirm an E2E test catches it.

---

### 14. Sandbox plugins the way tools are already sandboxed

**Current state (verified).** Tools run in a **forked child process** with
`--max-old-space-size=256` and a SIGKILL timeout (`tools/tool-runner-child.ts`).
**Plugins do not** — `plugins/plugin-manager.ts` loads them with a plain dynamic
`import(moduleUrl)` and they execute **in the Electron main process with full Node
privileges**. The path-safety check only prevents directory escape at discovery time, not
runtime capability. A plugin can do anything the main process can. Plugin "slots" are
also a fixed enum (`notifier`/`tracker`/`telemetry`), so non-hook extensibility is narrow.

**Reference.** A self-review finding (opencode also runs plugins in-process — but
opencode *is* the agent; an orchestrator that loads third-party plugins carries more
risk). What both opencode and t3code do well is give plugins a **typed contract** and a
scoped SDK client rather than raw internals — worth copying regardless of isolation.

**Do this.**
- Run plugin code in the same forked/worker isolation tools already use, or at minimum a
  `worker_threads` boundary.
- Add a capability/permission declaration to `PluginManifestSchema` and gate the `ctx`
  surface (the coordinators a plugin can reach) by declared capability.
- Give plugins a typed, narrow API object instead of direct coordinator references.

**Files.** `src/main/plugins/plugin-manager.ts`, `plugin-validator.ts`,
`packages/sdk/src/plugins.ts`.

**Effort.** M. **Risk.** Med — changes the plugin execution model; version the manifest.

**Validation.** Plugin specs; a test proving a plugin without a declared capability cannot
reach a gated coordinator.

---

## P2 — Developer experience & code health

### 15. Pin the toolchain + a deterministic, multi-instance dev-runner

**Current state (verified).** Tool versions are pinned only by `.nvmrc` (Node).
`npm run dev` hard-codes renderer port `4567`, so two `ai-orchestrator` dev instances
collide — awkward for a project whose whole purpose is running many agents at once.
There is also **no `.devcontainer`** for a reproducible onboarding environment.

**Reference.** t3code pins Bun + Node via `.mise.toml` and ships a `.devcontainer`.
`t3code/scripts/dev-runner.ts` computes a deterministic **port offset** per dev instance
and **probes ports for availability** before picking, so multiple dev instances run
side-by-side with no collision. Every t3code dev/release script has a co-located `.test.ts`.

**Do this.**
- Add a `.mise.toml` (or equivalent) pinning Node — and any other required tooling — for
  reproducible local + CI environments; optionally add a `.devcontainer`.
- Replace the fixed `4567` with a small dev-runner that derives a deterministic offset
  from an instance id and probes for a free port.
- Add co-located tests for `build-*.ts` / release scripts (they currently have none).

**Files.** new `.mise.toml`, `package.json` (`dev`/`start` scripts), new `scripts/dev-runner.ts`.

**Effort.** S–M. **Risk.** Low.

**Validation.** Two `npm run dev` instances run concurrently without port conflict.

---

### 16. Ship a comprehensive, committed model-capability catalog

**Current state (verified).** `src/main/providers/model-discovery.ts` discovers models by
**fetching from provider APIs at runtime** (the file's own header: "Fetch available
models from provider APIs"; it imports `https`/`http`), with a TTL cache and only a small
hand-maintained `CLAUDE_MODELS` constant as a static fallback. The model list and its
capability data therefore depend on a network round-trip, and non-Claude capability
fields are only as good as what each API returns.

**Reference.** opencode ships a committed ~2.5 MB `packages/core/src/models-snapshot.js`
sourced from models.dev — context window, max output, cost, modalities, and capability
flags for *every* model of *every* provider — so the model picker is instant and fully
offline; `fromModelsDevProvider()` normalizes a snapshot entry into opencode's shape.

**Do this.**
- Commit a comprehensive model-capability catalog (the models.dev snapshot is a ready
  source) covering context window, max output tokens, pricing, modalities, and capability
  flags for every model AI Orchestrator can route to.
- Treat runtime API discovery as an **enrichment layer** over the static catalog, not the
  primary source — the picker and routing logic should never block on a network call.
- Regenerate the snapshot on a schedule (an AI Orchestrator automation), not per launch.

**Files.** new `src/shared/data/models-catalog.*` (or under `packages/contracts`),
`src/main/providers/model-discovery.ts`, `model-capabilities.ts`.

**Effort.** S–M. **Risk.** Low.

**Validation.** Model picker works fully offline; capability fields populated for all
routable models; routing decisions no longer depend on a live fetch.

---

### 17. Deterministic test synchronization (drainable workers)

**Current state (verified).** ~30 of 441 main-process spec files use `setTimeout` /
`await sleep` / `await delay` to wait for async work. Time-based waits are the classic
source of flaky CI and slow suites — they either flake under load or pad every run.

**Reference.** t3code's `packages/shared/src/DrainableWorker.ts` — queue-backed workers
expose an explicit `drain()` signal so a test deterministically waits for "all queued
work processed" instead of sleeping; the codebase tests against `drain()`, never timers.

**Do this.**
- For the coalescing/batching/queue components tests currently sleep on (the 50 ms
  batched store updates, `provider-runtime-event-bus`, file-watcher debounce, the autosave
  queue), expose a `drain()` / `flush()` / `whenIdle()` test hook.
- Convert the ~30 sleep-based specs to await it. (`codex_todo.md` #7's keyed-coalescing
  worker is the natural production-side home for this.)

**Files.** the queue/batch components under `src/main/*` + their specs.

**Effort.** M. **Risk.** Low — test-only behavior change.

**Validation.** Converted specs pass without timers; suite wall-time drops.

---

### 18. Consolidate the error taxonomy

**Current state (verified).** Error classification is spread across at least four
overlapping modules — `tools/tool-error-classifier.ts`, `cli/cli-error-handler.ts`,
`orchestration/utils/coordinator-error-handler.ts`, `orchestration/child-error-classifier.ts`
— plus per-adapter error handling. (`claude4_completed.md` #7 flagged ~9 scattered error
files and called for a single classifier; a fresh read shows the fragmentation largely
remains.) Each module reimplements its own notion of retryable / fatal / user-actionable.

**Reference.** t3code models every failure as a `Schema.TaggedError` in one tagged-error
union per domain, pattern-matched with `Effect.catchTag` — failure modes are exhaustive
and typed. opencode's `session/retry.ts` is a single `retryable(error, provider)`
classifier: 5xx always retried, rate-limit patterns detected, context-overflow **never**
retried, header-aware backoff.

**Do this.**
- Define one shared discriminated error model — a tagged union with
  `{ kind, retryable, severity, userActionable, cause }` — not thrown strings.
- Provide **one** `classifyError()` that the tool, CLI, coordinator, and adapter layers
  all call; keep any domain-specific wrappers thin on top of it.
- Make "never retry context-overflow / auth failure; always retry transient 5xx / spawn
  errors" a single source of truth that feeds both the retry-manager and failover.

**Files.** new `src/main/core/errors/` (or `src/shared/`), then the four classifier
modules above + the per-adapter handlers.

**Effort.** M. **Risk.** Med — touches many call sites; migrate incrementally behind tests.

**Validation.** A table-driven classifier spec covering every error kind; existing
retry/failover specs stay green.

---

## Suggested execution order

1. **#3** (codegen protocol bindings) and **#12** (CI gaps) first — low risk, and #3
   makes #1 cleaner to land.
2. **#6** (statement caching), **#11** (oxlint plugin), **#16** (model catalog) —
   independent, low risk, fast wins.
3. **#8** (crash capture) and **#9** (auto-update) — independent of the architecture work;
   do them early since they protect *shipped* users (no field crash visibility, no way to
   push a fix).
4. **#2** (typed RPC boundary) — large but mechanical; the `verify:ipc` guard de-risks it.
5. **#1** (unify the adapter/provider layer) — the big one; do it behind per-adapter
   behavior tests and after #3 lands.
6. **#4** + **#5** (fixture replay + scripted adapter) — best done alongside #1 so the new
   adapter contract is born testable.
7. **#13** (E2E) — after #5 lands (it supplies the deterministic backend) and once #1/#2
   have stabilized the seam it exercises.
8. **#7** (metrics), **#10** (secret hardening), **#14** (plugin sandboxing), **#15**
   (dev-runner), **#17** (test determinism), **#18** (error consolidation) — independent;
   schedule as capacity allows.

## Verification commands

Use the smallest relevant subset per change; run the broader suite after multi-file work:

```bash
npm run typecheck && npm run typecheck:spec
npm run lint && npm run lint:fast
npm run test
npm run verify:ipc && npm run verify:exports && npm run check:contracts
npm run verify:architecture
npm run smoke:electron
npm run verify          # full gate
```
