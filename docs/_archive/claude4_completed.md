# AI Orchestrator — Improvement Recommendations (Pass 4)

> **Filename note.** You asked for `claude.md`. This filesystem is **case-insensitive**,
> so `claude.md` is literally the same file as the existing `CLAUDE.md` (a 33-byte
> Claude Code import stub: `@~/.claude/angular.md` + `@AGENTS.md`). Writing `claude.md`
> would destroy that stub. This doc is therefore `claude4.md`, continuing the
> established `claude_completed.md` → `claude2_completed.md` → `claude3_completed.md`
> sequence. Rename it `claude4_completed.md` once the work here lands.

## How this was produced

A deep dive across ~20 sibling projects in `orchestrat0r/` (agent-orchestrator,
online-orchestrator, hermes-agent, nanoclaw, openclaw, opencode, oh-my-opencode-slim,
CodePilot, OB1, claw-code, "Actual Claude", claude-code, codex, oh-my-codex,
codex-plugin-cc, copilot-sdk, CodexDesktop-Rebuild, t3code, mempalace-reference,
storybloq, rtk) and against `ai-orchestrator` itself.

**Every claim below was verified against the current code** (file sizes, line numbers,
`ci.yml`, `package.json`, configs). Findings that turned out to be already-done were
dropped — see the last section.

## What's already strong (verified — do not redo)

Passes 1–3 landed. These are confirmed in the tree and should **not** be re-touched:

- **Preload is decomposed** — `src/preload/preload.ts` is 102 lines composing 24
  domain factories in `src/preload/domains/*.preload.ts`. (The old "5,300-line
  preload" is gone.)
- **IPC channels are generated** — 775 channels generated from `packages/contracts`,
  with `verify:ipc` + `check:contracts` guarding packaging.
- **Provider Doctor** (`src/main/providers/provider-doctor.ts`), **sandbox**
  (`src/main/security/sandbox-manager.ts`, 876 lines), **permission engine**
  (`src/main/security/permission-manager.ts`, 1,559 lines), **RTK integration**,
  **Justfile**, **turbo**, **tsgo** (`typecheck:fast`), **alias codegen**
  (`generate:aliases`), **loop mode** (`loop-coordinator.ts`) — all present.
- `retry-manager.ts` **already has exponential backoff + jitter**.
- `compaction-coordinator.ts` **already has a consecutive-failure circuit breaker**.

The codebase is mature (~975 main-process files, 614 spec files, 412 renderer files).
The gaps below are the ones that survived verification.

## TL;DR — priority order

| # | Improvement | Effort | Risk |
|---|-------------|--------|------|
| 1 | Wire `oxlint` into CI + deepen the ruleset | S | Low |
| 2 | Add a file-size ratchet (`check-ts-max-loc`) | S | Low |
| 3 | macOS CI runner + native-ABI gate as first step | S–M | Low |
| 4 | Adopt `oxfmt` (no formatter exists today) | S | Low |
| 5 | Move 11 completed plans out of the repo root | S | None |
| 6 | Make the tool contract input-aware + persist large results | M | Med |
| 7 | Consolidate the ~9 scattered error files into one classifier | M | Med |
| 8 | Enforce `platform.ts` (ban inline `process.platform`) | S–M | Low |
| 9 | One tracked provider-capability / parity matrix | M | Low |
| 10 | Codegen Codex/Copilot protocol types instead of hand-editing | M | Med |
| 11 | Self-registering event registry → derive IPC schemas | M | Med |
| 12 | A mock provider so the orchestration loop is testable offline | M | Low |
| 13 | Per-subsystem verification maps for risky domains | S each | None |
| 14 | Custom oxlint rules for project invariants | M | Low |
| 15 | A typed state machine for the agent query loop | M–L | Med |
| 16 | Factor shared process spawn/kill out of the giant CLI adapters | L | Med |

Do Tier 1 (#1–5) first — it's a few hours of work, near-zero risk, and closes real
gaps. Tier 2+ should be scheduled.

---

## Tier 1 — CI & tooling (cheap, high-value, low-risk)

### 1. `oxlint` is defined but never runs in CI — `src/main` is unlinted

**Evidence.** `package.json` defines `lint:fast` (`oxlint … src/main src/shared
src/preload …`), but CI (`.github/workflows/ci.yml`) and the `verify` script both run
`npm run lint`, which is `ng lint`. `angular.json`'s lint target has
`lintFilePatterns: ["src/renderer/**/*.ts", "src/renderer/**/*.html"]`. So **ESLint
only covers the renderer**, and `lint:fast` is referenced only in the `Justfile`.
Net result: **811 main-process files + preload + shared have zero lint coverage in CI.**
On top of that, `.oxlintrc.json` enables just ~8 rules — no `categories`, no
`plugins`, no type-aware pass.

**Why it matters.** This is the single highest value-to-effort fix. `oxlint` with
`typescript/no-floating-promises` (type-aware) catches unhandled promise rejections in
NDJSON stream handlers and child-process callbacks — exactly the bug class that makes a
test suite flaky. Right now nothing catches it for the main process.

**Do this.**
- Add an `Oxlint` step to `ci.yml` running `npm run lint:fast` (and add it to `verify`).
- Deepen `.oxlintrc.json` to `"categories": { "correctness": "error", "suspicious":
  "warn", "perf": "warn" }`, add the `typescript`/`unicorn` plugins, and enable
  type-aware (`oxlint-tsgolint`). Relax `no-explicit-any` for `*.spec.ts` via `overrides`.

**Borrowed from.** `openclaw/.oxlintrc.json` (170+ rules, categories, clean test
override), `opencode/.oxlintrc.json` (`typeAware: true`). **Effort: S** (config + one CI
step; budget M once for the first batch of `no-floating-promises` fixes).

### 2. No file-size ceiling — eight files over 2,000 lines

**Evidence.** Verified with `wc -l`:

```
3303  src/main/instance/instance-lifecycle.ts
3003  src/main/cli/adapters/codex-cli-adapter.ts
2501  src/main/channels/channel-message-router.ts
2499  src/main/instance/instance-manager.ts
2454  src/main/browser-gateway/browser-gateway-service.ts
2235  src/main/instance/instance-communication.ts
2169  src/main/cli/adapters/claude-cli-adapter.ts
2141  src/main/cli/adapters/acp-cli-adapter.ts
```

There is no LOC check anywhere in the build.

**Why it matters.** "Codebase size" is the standing complaint. A 3,300-line file is
hard for both humans and AI agents to safely change. You can't split all of them now,
but you *can* stop the bleeding.

**Do this.** Copy `openclaw/scripts/check-ts-max-loc.ts` (84 lines, zero deps, uses
`git ls-files` so untracked files can't sneak past). Run it **warn-only as a ratchet**
first (fail only if a file *grows* past its current size), then set a hard cap (~700
LOC for new files) once the worst offenders are split.

**Borrowed from.** `openclaw/scripts/check-ts-max-loc.ts`. **Effort: S** to add the
ratchet; splitting the offenders is incremental L.

### 3. CI is a single ubuntu job with no native-module ABI gate

**Evidence.** `ci.yml` is one job, `runs-on: ubuntu-latest`. It runs `build:main`
directly — which does **not** invoke `prebuild`, so `scripts/verify-native-abi.js`
**never runs in CI**. `AGENTS.md` itself documents that "the packaged DMG has silently
broken twice" — once from a stale `better-sqlite3` ABI after an Electron bump.

**Why it matters.** This ships as a macOS DMG. CI never builds or sanity-checks on
macOS, and the exact failure mode that broke the DMG twice has no CI guard.

**Do this.**
- Add a `macos-latest` job to the CI matrix (at minimum: install + `rebuild:native` +
  `build:main` + `smoke:electron`).
- Add a **fast first step** that spawns `better-sqlite3` and exits — a 5-line
  `node -e` check, or just run `verify-native-abi.js` explicitly — so an ABI mismatch
  fails in seconds with a clear message instead of mid-build.

**Borrowed from.** `agent-orchestrator/.github/workflows/ci.yml` (2-OS matrix +
fail-fast native smoke as step one). **Effort: S–M.**

### 4. There is no code formatter

**Evidence.** No `.oxfmtrc*`, no `.prettierrc`, no Prettier dependency.
`claude_completed.md §1.1` recommended adopting `oxfmt`; `oxlint` landed, `oxfmt` did
not. Formatting is currently unenforced.

**Why it matters.** Inconsistent formatting produces noisy diffs and pointless review
churn across a 1,200-file codebase.

**Do this.** Add `oxfmt`, an `.oxfmtrc.jsonc`, an `fmt` + `fmt:check` script, and
`fmt:check` to CI. `openclaw/.oxfmtrc.jsonc` is a ready template.

**Borrowed from.** `openclaw`, `t3code` (both standardized on `oxfmt`). **Effort: S.**

### 5. The repository root is cluttered with 11 completed plans

**Evidence.** 19 `.md` files in the root; 11 are finished planning artifacts —
`claude_completed.md`, `claude2_completed.md`, `claude3_completed.md`,
`copilot_completed.md`, `cursor_completed.md`, `gemini_completed.md`,
`copilot-t3code_completed.md`, `unified_plan_completed.md`, `plan_loop_mode_Completed.md`,
`bigchange_rtk_integration_Completed.md`, `memory-research_completed.md`.
`claude_completed.md §8.2` already recommended this; it wasn't done.

**Why it matters.** New contributors and AI agents can't tell the live docs (`AGENTS.md`,
`DESIGN.md`, `NOTES.md`) from archived plans.

**Do this.** Create `docs/plans/completed/` and move all `*_completed.md` /
`*_Completed.md` there. Add a `docs/plans/README.md` index. Adopt CodePilot's
`active/` → `completed/` folder lifecycle so this doesn't recur.

**Borrowed from.** `CodePilot/docs/exec-plans/` (active/completed split + per-folder
README index). **Effort: S.**

---

## Tier 2 — Architecture & correctness

### 6. The tool contract is anemic — static safety, no validation, silent truncation

**Evidence.** `src/main/tools/define-tool.ts` is 58 lines. `ToolSafetyMetadata` is
**static** per tool (`DEFAULT_SAFETY = { isConcurrencySafe: true, isReadOnly: false,
isDestructive: false }`). There is no per-tool `validateInput`, no `maxResultSizeChars`.
`tool-result-normalizer.ts` records `{ truncated, byteCount }` but **discards** the
overflow.

**Why it matters.** Concurrency/read-only/destructive are genuinely *input-dependent*:
a `Bash` running `ls` vs `rm -rf` are not equally safe, yet today they share one static
flag. And silently truncating a large tool result loses data the agent may need next
turn.

**Do this.**
- Make the predicates input-aware: `isConcurrencySafe(input)`, `isReadOnly(input)`,
  `isDestructive(input)` as `(input) => boolean`, with a `buildTool()` factory that
  fail-closed-defaults them in one place.
- Add a per-tool `validateInput()` semantic check and return **model-readable**
  failures (`<tool_use_error>…corrective instruction…</tool_use_error>`) so the agent
  self-corrects instead of looping.
- Add `maxResultSizeChars`; on overflow, persist the full output via the existing
  `src/main/context/output-persistence.ts` and hand the model a `<persisted-output>`
  path preview.

**Borrowed from.** `Actual Claude/Tool.ts` (`buildTool` + `TOOL_DEFAULTS`),
`Actual Claude/services/tools/toolExecution.ts`, `Actual Claude/utils/toolResultStorage.ts`.
**Effort: M.**

### 7. Error classification is scattered across ~9 files

**Evidence.** Distinct, overlapping error modules: `tools/tool-error-classifier.ts`,
`orchestration/child-error-classifier.ts`, `core/error-recovery.ts`,
`core/failover-error.ts`, `util/error-utils.ts`, `cli/cli-error-handler.ts`,
`cli/adapters/codex/app-server-errors.ts`, `orchestration/utils/coordinator-error-handler.ts`,
`pause/orchestrator-paused-error.ts`. Each CLI emits different error text; recovery
strategy is re-derived in several places.

**Why it matters.** With 4+ heterogeneous CLIs, "what kind of failure is this and what
do I do about it" should be answered **once**. `unified_plan_completed.md` was explicit:
**extend the existing taxonomy — do NOT build a parallel one.**

**Do this.** Pick the richest existing module as the home and consolidate the others
into one `classifyError()` that returns a typed result — a reason enum plus boolean
*recovery hints* (`retryable`, `shouldCompress`, `shouldRotateCredential`,
`shouldFailover`). Callers consume hints; they never re-classify. CodePilot's pattern
of reclassifying a `PROCESS_CRASH` whose stderr mentions "session" into
`SESSION_STATE_ERROR` is directly relevant to your `src/main/session/` recovery path.

**Borrowed from.** `hermes-agent/agent/error_classifier.py` (one classifier, priority
pipeline, hint struct), `CodePilot/src/lib/error-classifier.ts` (typed categories +
`recoveryActions`). **Effort: M.**

### 8. `platform.ts` exists but isn't enforced

**Evidence.** `src/main/util/platform.ts` exists (76 lines) — `claude3_completed.md §14`
landed it. But **35 main-process files still call `process.platform` inline**, bypassing
the tested helpers.

**Why it matters.** This app spawns and kills child processes for every CLI on macOS,
Linux, and Windows. Inline platform checks aren't covered by `platform.ts`'s tests and
become silent cross-platform regressions — half-done consolidation is barely better
than none.

**Do this.** Migrate the 35 inline checks into `platform.ts` helpers, then add a guard
(a custom oxlint rule per #14, or a one-line `grep` CI gate) banning `process.platform`
outside `platform.ts`.

**Borrowed from.** `agent-orchestrator/packages/core/src/platform.ts` +
`docs/CROSS_PLATFORM.md` (enforced "no inline platform checks" rule). **Effort: S–M.**

### 9. No single provider-capability / parity matrix

**Evidence.** Capability data is split between `providers/model-capabilities.ts`,
per-adapter ad-hoc checks, and the project `MEMORY.md` (Wave 2 notes on what's
deferred/partial per provider). There is no one place that answers "does Codex support
thinking mode / attachments / session resume, and is it actually wired or stubbed?"

**Why it matters.** Claude, Codex, Gemini, and Copilot CLIs have genuinely divergent
feature surfaces. Without a tracked matrix, the UI can't reliably gate behavior and
nobody knows what's real vs stubbed.

**Do this.** Add a `getCapabilities()` returning a typed `ProviderCapabilities` struct
to `provider-interface.ts`, and a tracked `docs/PROVIDER_PARITY.md` mapping each
capability to its status **with evidence** (file + symbol). Optionally add claw-code's
CI check that fails when a test references a parity anchor that no longer exists.

**Borrowed from.** `claw-code/PARITY.md` + `run_mock_parity_diff.py`,
`CodePilot/src/lib/channels/types.ts` (`getCapabilities()` on the interface).
**Effort: M.**

### 10. Codex/Copilot protocol types are hand-maintained and drifting

**Evidence.** `src/main/cli/adapters/codex/app-server-types.ts` is hand-written and
visibly drifting — it carries comments like "Legacy name accepted by older Codex builds"
and `[key: string]: unknown` escape hatches. `copilot-cli-provider.ts` is a thin
spawn-based wrapper, but the Copilot CLI is actually a typed JSON-RPC server.

**Why it matters.** Hand-maintained protocol types silently fall behind upstream — a
missing field surfaces as a mysterious mid-turn failure rather than a clear error.

**Do this.**
- Codex publishes JSON Schemas / TS bindings (`codex-rs/app-server-protocol`'s `export`
  binary). Vendor or codegen the generated `v2/` types instead of editing
  `app-server-types.ts` by hand. You already have a `generate:ipc` step — add a
  `generate:protocol-types` step beside it.
- For Copilot, depend on `@github/copilot-sdk` (it ships generated `rpc.ts` /
  `session-events.ts` with an 80+ variant `SessionEvent` union) rather than
  reimplementing JSON-RPC.
- Add a protocol-version handshake with a range check so incompatibility fails loudly
  at connect time.

**Borrowed from.** `codex/codex-rs/app-server-protocol/src/bin/export.rs`,
`copilot-sdk/nodejs/src/generated/*`, `copilot-sdk/nodejs/src/client.ts`
(`verifyProtocolVersion`). **Effort: M.**

### 11. Provider event types drift from their IPC schemas

**Evidence.** The project `MEMORY.md` records ongoing pain here: `ProviderOutputEvent`
is "lossier than `OutputMessage`", `event-normalizer.ts` stays alive only to bridge
main→renderer, and an adapter event bridge had to be removed. Event types are defined
in one place; the IPC/validation surface is hand-maintained separately, so they drift.

**Why it matters.** Every drift is a class of "event silently lost / mis-shaped" bug,
and you've already hit several.

**Do this.** Introduce a self-registering event registry — `defineEvent(type, zodSchema)`
pushes into a module `Map` — and **derive** the IPC event-channel schema
(`z.discriminatedUnion`) from that registry. Define an event once; its transport schema
updates for free. Plain Zod, which you already use — no Effect needed.

**Borrowed from.** `opencode/packages/opencode/src/bus/bus-event.ts` (`define()`
self-registers; `effectPayloads()` derives the wire union). **Effort: M.**

---

## Tier 3 — Testing & verifiability

### 12. The orchestration loop can't be tested without spawning real CLIs

**Evidence.** Verification, debate, consensus, and supervisor logic all run on top of
real CLI child processes. There is no mock provider/adapter. The project `MEMORY.md`
notes that recorded fixture-replay (Wave 2 Task 24) was **deferred** because adapters
lack a `__feedRaw` injection hook.

**Why it matters.** Slow, non-deterministic, real-CLI tests get skipped — and the
multi-agent coordination machinery (the heart of this app) ends up under-tested.

**Do this.** Register a `mock-cli-adapter` in `provider-adapter-registry.ts` with an
injectable scripted NDJSON stream and full `push`/`end`/`abort` support. Then drive the
whole orchestration loop against it with zero subprocesses. This is also the seam that
unblocks the deferred fixture-replay task.

**Borrowed from.** `nanoclaw`'s `MockProvider` (`container/agent-runner/src/providers/
mock.ts`) + `poll-loop.test.ts`, `claw-code`'s `mock-anthropic-service` harness.
**Effort: M.**

### 13. No per-subsystem verification maps

**Evidence.** `docs/runbooks/` are *user* runbooks; `docs/architecture.md` is one
monolithic map. Nothing tells an agent "these files own orchestration, these tests
cover it, run *this exact command* to verify."

**Why it matters.** In a 975-file main process largely edited by AI agents, "verify
before claiming done" needs to be mechanical, not improvised.

**Do this.** For the riskiest domains — `orchestration/`, `session/`, `process/`,
`cli/adapters/` — add a short `docs/verification-maps/<domain>.md`: owning files +
symbols, the exact test command, known integration hazards, and a dated
PASS/FAIL evidence block. Create them lazily, riskiest first.

**Borrowed from.** `claw-code/docs/g002-security-verification-map.md`. **Effort: S each.**

### 14. No custom lint rules for project-specific invariants

**Evidence.** Real invariants of this codebase are enforced only by review or `verify:*`
shell scripts — e.g. "every IPC handler validates its payload with a Zod schema", "no
`ipcMain.handle` outside the registry", "no inline `process.platform`" (#8).

**Why it matters.** Review-only invariants rot. A CI-enforced AST rule doesn't.

**Do this.** Once `oxlint` runs in CI (#1), add a small oxlint JS-plugin with 2–3
project rules. Start with the `process.platform` ban for #8.

**Borrowed from.** `t3code/oxlint-plugin-t3code/` (custom oxlint plugin + `jsPlugins`
wiring + a unit test for the rule). **Effort: M.**

---

## Tier 4 — Larger refactors (schedule deliberately)

### 15. The agent query loop has no typed state machine

**Evidence.** The recovery pieces all exist as separate modules — `context/ptl-retry.ts`,
`context/error-withholder.ts`, `context/output-token-escalator.ts`,
`context/continuation-injector.ts`, `usage`-side budget tracking — but nothing sequences
them as one loop with named, guarded transitions.

**Why it matters.** Ordering and cross-iteration guards matter as much as the individual
recoverers. The reference implementation's hard-won lesson: a guard like
`hasAttemptedReactiveCompact` must be **preserved across retries**, or you get a
`compact → still too long → error → retry → compact` infinite loop. `doom-loop-detector.ts`
is only a blunt backstop for this.

**Do this.** Refactor the loop into a state-carrying generator where every `continue`
writes a typed `transition: { reason: '…' }`. Makes the loop testable without inspecting
message contents and makes the guards explicit.

**Borrowed from.** `Actual Claude/query.ts` (the `State` type + named transitions) and
`Actual Claude/query/transitions.ts`. **Effort: M–L** (pieces exist; this is sequencing).

### 16. The giant CLI adapters duplicate process spawn/kill logic

**Evidence.** `codex-cli-adapter.ts` (3,003), `claude-cli-adapter.ts` (2,169),
`acp-cli-adapter.ts` (2,141) — each almost certainly re-implements spawn, timeout,
output buffering, and process-tree kill.

**Why it matters.** Three copies of process-lifecycle code is three places for a
Windows kill-tree or no-output-timeout bug to hide. This also overlaps with the
file-size problem (#2).

**Do this.** Factor a shared `ProcessSupervisor` + `kill-tree` helper (graceful SIGTERM
→ grace → SIGKILL; Windows `taskkill /T`; detached-group kill only when detached). Each
adapter then shrinks to "build argv + parse this CLI's NDJSON dialect." Model the
termination reason as a closed union, not freeform strings.

**Borrowed from.** `openclaw/src/process/supervisor/` + `openclaw/src/process/kill-tree.ts`.
**Effort: L** (high payoff given the 3,000-line adapters).

---

## Suggested first sprint (~1 week, low risk)

1. **#1** — `oxlint` into CI + deepen `.oxlintrc.json` (half a day; budget more for the
   first `no-floating-promises` cleanup).
2. **#2** — `check-ts-max-loc` ratchet (1–2 hours).
3. **#4** — `oxfmt` + `fmt:check` in CI (2–3 hours).
4. **#5** — move 11 completed plans into `docs/plans/completed/` (30 minutes).
5. **#3** — macOS CI job + native-ABI fast gate (half a day).

That's a week of mostly-mechanical, near-zero-risk work that closes the verified CI/
tooling gaps. Then schedule **#7** (error consolidation), **#6** (tool contract), and
**#9** (parity matrix) as the first real feature work.

## Verified NOT recommended (already done, or rejected upstream)

So you don't burn time re-doing closed items:

- **Add jitter to retries** — `retry-manager.ts` already has it (`config.jitter`,
  `jitterFactor`).
- **Autocompact circuit breaker** — `compaction-coordinator.ts` already trips on
  `CIRCUIT_BREAKER_MAX_FAILURES`.
- **Decompose the monster preload** — done; `preload.ts` is 102 lines + domain factories.
- **IPC channel codegen / verification** — done (`generate:ipc`, `verify:ipc`,
  `check:contracts`).
- **oxlint / turbo / tsgo / alias codegen adoption** — all already present (passes 1–3).
  This doc only asks to *deepen* and *wire up* oxlint, not adopt it.
- **Provider Doctor, sandbox, permission engine, lifecycle state machine** — all exist
  (`instance-state-machine.ts` is present).
- **A second permission system, a second sandbox, a YAML super-manifest, merging
  `remote/`+`remote-node/`** — explicitly rejected in `unified_plan_completed.md`. Do
  not revisit.
- **Wholesale Effect-TS rewrite** — not recommended; `opencode` is Effect-native end to
  end and transferring that is a multi-month rewrite. Take the *patterns* (#11 event
  registry) re-expressed in plain Zod.

---

*Pass 4 of the cross-project review. Sources: agent-orchestrator, openclaw, opencode,
oh-my-opencode-slim, "Actual Claude", claude-code, hermes-agent, nanoclaw, CodePilot,
OB1, claw-code, codex, copilot-sdk, oh-my-codex, codex-plugin-cc, CodexDesktop-Rebuild,
t3code, mempalace-reference, storybloq, rtk, online-orchestrator.*
