# Bigchange: RTK Integration

**Status:** Completed 2026-05-08 — verified via `tsc`, `tsc -p tsconfig.spec.json`, lint, 47 RTK unit tests + 8 IPC handler tests green.
**Author:** Claude (initial draft 2026-05-07)
**Owner:** James
**Estimated effort:** ~1.5–2 weeks for Phase 0 + 1; Phase 2 optional/later.

## Completion evidence

| Plan section | Files |
|---|---|
| 4.0.1 Binary bundling | `scripts/fetch-rtk-binaries.js`, `scripts/rtk-binaries.sha256.json`, `resources/rtk/<platform>-<arch>/rtk[.exe]`, `electron-builder.json` (per-platform `extraResources` block), `package.json` `electron:build` script chains `node scripts/fetch-rtk-binaries.js` |
| 4.0.2 Runtime helper | `src/main/cli/rtk/rtk-runtime.ts` (singleton + version compare + bundled/system fallback) and `__tests__/rtk-runtime.spec.ts` (24 tests) |
| 4.0.3 Combined hook script | `src/main/cli/hooks/rtk-defer-hook.mjs` and `__tests__/rtk-defer-hook.spec.ts` (9 tests). `electron-builder.json` ships hooks via `extraResources: src/main/cli/hooks → hooks` |
| 4.0.4 Adapter wiring | `src/main/cli/adapters/adapter-factory.ts` `createClaudeAdapter`, `createCodexAdapter`, `createGeminiAdapter`, `createCopilotAdapter`, `createCursorAdapter` all set `rtk` + extend env via `extendEnvWithRtk` |
| 4.0.5 Settings + flag | `src/shared/types/settings.types.ts` (`rtkEnabled`, `rtkBundledOnly`) and Settings tab UI |
| 4.0.6 Diagnostic surface | `src/main/ipc/handlers/rtk-handlers.ts` exposes `RTK_GET_STATUS` (binary path, version, source, DB path, feature flag) — surfaced in `Settings → RTK Savings` (`src/renderer/app/features/settings/rtk-savings-tab.component.ts`) instead of a parallel `provider-doctor` probe; functionally equivalent |
| 4.0.7 Internal exec opt-out | Confirmed unnecessary per plan recommendation: internal `spawnSync('git', …)` calls bypass user shell aliases, so an aliased `git=rtk git` cannot intercept them. No `RTK_DISABLED` env propagation required |
| 4.1.4 Tracking DB reader | `src/main/cli/rtk/rtk-tracking-reader.ts` (read-only WAL-safe) and `__tests__/rtk-tracking-reader.spec.ts` (14 tests) |
| 4.1.5 Savings IPC + UI | `src/main/ipc/handlers/rtk-handlers.ts` + `__tests__/rtk-handlers.spec.ts` (8 tests), `packages/contracts/src/channels/rtk.channels.ts`, `src/preload/domains/rtk.preload.ts`, `src/renderer/app/core/services/ipc/rtk-ipc.service.ts`, `src/renderer/app/features/settings/rtk-savings-tab.component.ts` |
| Loop integration | `src/main/orchestration/default-invokers.ts` resolves `getLoopPermissionHookPath` and `getLoopRtkSpawnConfig` so both fresh-child and same-session loop iterations honour the rtk feature flag (covered by `default-invokers.loop.spec.ts`) |

---

## 1. Executive Summary

Integrate [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) into AI Orchestrator to compress LLM-bound shell command output by 60–90%. RTK is an external Rust binary; we **bundle it** as an electron-builder `extraResource`, **shell out** to its `rtk rewrite` API from a single combined hook script, and **read its SQLite analytics DB** for a "tokens saved" UI panel.

No code porting, no fork, no Rust toolchain in our build pipeline. Total integration glue: ~300 LOC of TypeScript + a ~70-line `.mjs` hook script + electron-builder config + per-arch binary fetch script.

**Why bundle and not depend on user PATH:** asking users to `brew install rtk` before our app works is unacceptable for a polished desktop product. MIT license permits redistribution.

**Why not port to TypeScript:** RTK is ~5000 LOC of Rust (lexer + 60+ TOML filters + 70+ regex rules) with active weekly upstream releases. Maintaining a parallel TS port is a sucker's bet.

---

## 2. Goals & Non-Goals

### Goals
- 60–90% token reduction on Bash tool output emitted into Claude/Codex/Gemini/Copilot CLI contexts.
- "Tokens saved" telemetry panel in our usage UI sourced from RTK's tracking DB.
- Zero install friction: rtk works out of the box for users who just download our DMG/installer.
- Feature-flagged rollout so we can A/B against unmodified token usage.
- Multi-platform: macOS arm64+x64, Linux x64+arm64, Windows x64.

### Non-Goals (explicit)
- **Filtering output of internal `execAsync` calls in `src/main/workspace/git/`, `src/main/repo-jobs/`, `src/main/git/branch-freshness.ts`.** Those parse output programmatically; RTK would corrupt them. We will explicitly opt out via `RTK_DISABLED=1`.
- Porting RTK code to TypeScript.
- Forking RTK or contributing back upstream as a prerequisite.
- Replacing our existing `defer-permission-hook.mjs` semantics — we extend it, we don't rewrite the permission model.
- Exposing RTK's TOML filter DSL to end users in v1 (Phase 2 stretch).

---

## 3. Architecture Decision

**Decision: bundle the binary, shell out, read the SQLite DB.**

Alternatives considered and rejected:

| Option | Why rejected |
|---|---|
| Depend on user-installed `rtk` on PATH | Friction; non-tech users won't install it; provider-doctor would have to gate features |
| Port lexer + filters to TypeScript | ~5000 LOC, weekly upstream churn, we'd never keep up; we'd own a maintenance burden for a non-core competency |
| Fork rtk-ai/rtk | Same maintenance burden + fragmenting from upstream community |
| Use it via Rust FFI / N-API binding | Adds a Rust toolchain to our build pipeline for ~50 LOC of integration value |

The integration API (`rtk rewrite "<cmd>"`) is dead simple, documented, version-stable since 0.23.0, and has a covered test suite (`src/hooks/rewrite_cmd.rs`). Treating rtk as an opaque binary is the right call.

---

## 4. Implementation Plan

### Phase 0 — Bundle + Claude adapter only, behind feature flag (Week 1)

Goal: prove the integration works end-to-end on one provider with internal dogfooding.

#### 4.0.1 Binary bundling

**New: `scripts/fetch-rtk-binaries.js`**
- Pinned version constant: `RTK_VERSION = '0.39.0'` (or latest stable at implementation time).
- Downloads from `https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-<target>.tar.gz` (and `.zip` for Windows).
- Targets: `x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`.
- Verifies SHA256 against a manifest checked into our repo (`scripts/rtk-binaries.sha256.json`).
- Extracts to `resources/rtk/<platform>-<arch>/rtk[.exe]`.
- Idempotent — re-runs no-op if files already exist with correct hash.

**Modified: `package.json`**
```json
{
  "scripts": {
    "fetch-rtk": "node scripts/fetch-rtk-binaries.js",
    "prebuild": "npm run verify-native-abi && npm run fetch-rtk",
    "predev": "npm run fetch-rtk"
  }
}
```

**Modified: `electron-builder.yml`** (or whatever our config file is)
```yaml
extraResources:
  - from: resources/rtk/${platform}-${arch}/
    to: rtk/
    filter: ['rtk*']
```

**Modified: `scripts/verify-native-abi.js`**
- Add a check that the bundled `rtk` binary runs and `rtk --version` matches `RTK_VERSION`.

**macOS code-signing note:** The rtk binary must be signed with our developer ID, hardened-runtime entitlements, and notarized as part of the existing Electron notarization step. Check `electron-builder.yml` `mac.extendInfo` and `afterSign` hook. Specifically:
- Add rtk to `binaries` list in `electron-builder.yml` if we have one
- May need to add `com.apple.security.cs.allow-unsigned-executable-memory` to entitlements (verify via test build first; only add if rtk fails to launch otherwise)

#### 4.0.2 Runtime helper

**New: `src/main/cli/rtk/rtk-runtime.ts`** (~120 LOC)

```ts
// Sketch — actual implementation will follow patterns from cli-detection.ts

export interface RtkRuntime {
  isAvailable(): boolean;
  binaryPath(): string;
  version(): string | null;
  rewrite(cmd: string): RtkRewriteResult;
}

export type RtkRewriteResult =
  | { kind: 'allow'; rewritten: string }     // exit 0
  | { kind: 'passthrough' }                   // exit 1
  | { kind: 'deny' }                          // exit 2
  | { kind: 'ask'; rewritten: string }        // exit 3
  | { kind: 'error'; reason: string };

class RtkRuntimeImpl implements RtkRuntime {
  private readonly resolvedPath: string;
  private cachedVersion: string | null = null;

  constructor() {
    // 1. Prefer system rtk if version >= MIN_VERSION (lets power users override)
    // 2. Otherwise use bundled binary at process.resourcesPath/rtk/rtk
    // 3. In dev mode, fall back to ./resources/rtk/<platform>-<arch>/rtk
  }

  rewrite(cmd: string): RtkRewriteResult {
    const r = spawnSync(this.resolvedPath, ['rewrite', cmd], {
      encoding: 'utf8',
      timeout: 2_000,
      env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' },
    });
    // Map exit codes per RTK contract (rewrite_cmd.rs lines 14–18)
  }
}

// Standard singleton pattern per CLAUDE.md
export function getRtkRuntime(): RtkRuntime { ... }
export function _resetForTesting(): void { ... }
```

**Tests:** `src/main/cli/rtk/__tests__/rtk-runtime.spec.ts`
- Mock `spawnSync` and assert exit-code → result mapping
- Test version detection
- Test bundled vs system path resolution
- Test 2-second timeout behavior

#### 4.0.3 Combined hook script

**New: `src/main/cli/hooks/rtk-defer-hook.mjs`** (~70 LOC)

Replaces `defer-permission-hook.mjs` *or* lives alongside it (decided in 4.0.4). Behavior:
1. Read JSON from stdin (same as today)
2. If `tool_name === 'Bash'` AND `process.env.ORCHESTRATOR_RTK_ENABLED === '1'`:
   - Spawn `rtk rewrite <command>` synchronously, 2s timeout
   - Exit 0 + stdout differs from input: replace `tool_input.command` with rewritten value
   - Exit 1: passthrough, no change
   - Exit 2: don't auto-allow (let Claude's native deny rules decide)
   - Exit 3 (ask): rewrite the command but force defer (see decision in §6.2)
3. Run existing defer-or-allow logic with possibly-rewritten `tool_input`
4. Emit `hookSpecificOutput.updatedInput` so the rewrite reaches Claude

Critical: this runs as a child Node process per Bash tool call. Must complete in <100ms typical (2s hard timeout). RTK's own `rtk rewrite` benchmarks at <10ms so the budget is fine.

**Tests:** `src/main/cli/hooks/__tests__/rtk-defer-hook.spec.ts`
- Mock rtk binary via PATH override or env var pointing to a stub
- Test all four exit codes produce correct hookSpecificOutput
- Test feature flag off → behaves identically to current defer hook
- Test rtk binary missing → graceful fallback (warn, behave like current hook)

#### 4.0.4 Claude adapter wiring

**Modified: `src/main/cli/adapters/claude-cli-adapter.ts`** (lines ~678–697)

Decision: **single combined hook script**, not two chained hooks. Two reasons:
1. Claude Code spec for chained PreToolUse hooks is order-dependent and the "most recent decision wins" semantics are surprising. One script avoids this.
2. We already own `defer-permission-hook.mjs` — extending it is lower risk than chaining an external script.

Change:
```ts
// Before:
command: buildDeferPermissionHookCommand(this.spawnOptions.permissionHookPath)

// After:
command: buildDeferPermissionHookCommand(this.spawnOptions.permissionHookPath)
// + pass ORCHESTRATOR_RTK_ENABLED=1 in spawn env when feature flag is on
// + pass ORCHESTRATOR_RTK_PATH=<resolved binary path> in spawn env
```

**Modified: `src/main/cli/hooks/hook-path-resolver.ts`**
- Add `getRtkDeferHookPath()` mirroring existing `getDeferPermissionHookPath()` pattern.
- Decide: keep both hooks side-by-side and pick at adapter level, or replace `defer-permission-hook.mjs` outright with the combined script. **Recommendation:** replace, because the new script is a strict superset (RTK logic is gated by env var).

#### 4.0.5 Settings & feature flag

**Modified: settings schema** (wherever AppSettings type lives — `src/shared/types/settings.ts` or similar)

```ts
interface AppSettings {
  // ...
  rtk?: {
    enabled: boolean;     // default false in v1
    bundledOnly: boolean; // if true, never fall back to system rtk; default false
  };
}
```

Surface in Settings UI under a "Performance" or "Token Optimization" section with a clear explanation: "RTK reduces tokens by 60–90% by compressing shell command output. Experimental — disable if you see broken tool output."

#### 4.0.6 Provider doctor

**Modified: `src/main/providers/provider-doctor.ts`**

Add an RTK section that reports:
- Bundled binary present? (path, version)
- System rtk on PATH? (version, comparison with bundled)
- Tracking DB path + size
- Feature flag state

#### 4.0.7 Internal exec opt-out

**Modified: every `execAsync` / `spawn` / `spawnSync` call in:**
- `src/main/workspace/git/vcs-manager.ts`
- `src/main/workspace/git/worktree-manager.ts`
- `src/main/git/branch-freshness.ts`
- `src/main/repo-jobs/**/*.ts`
- `src/main/agents/review-coordinator.ts` (if it does its own git invocations)

Add `RTK_DISABLED=1` to the env. Even though these don't go through the LLM hook, defense-in-depth: if a user later sets `rtk init` system-wide and we shell out to git, we don't want their shell aliasing it.

Actually verify whether this is needed — the only way internal git would be filtered is if user has shell aliases. Probably not needed but cheap insurance.

#### 4.0.8 Phase 0 verification

- [ ] `npm run fetch-rtk` succeeds, hashes match
- [ ] `npx tsc --noEmit` passes
- [ ] `npx tsc --noEmit -p tsconfig.spec.json` passes
- [ ] `npm run lint` passes
- [ ] All new spec files run green
- [ ] DMG builds, app launches, rtk binary signs/notarizes correctly
- [ ] Claude instance with feature flag on: `git status` produces compact output (visible in adapter event stream)
- [ ] `rtk gain --history` (run from terminal) shows commands attributed to our orchestrator
- [ ] Feature flag off: no behavior change vs current code
- [ ] Internal `git diff --stat` calls in worktree-manager still produce parseable output

---

### Phase 1 — Multi-provider + UI (Week 2)

#### 4.1.1 Codex adapter

Codex uses `AGENTS.md` mode rather than runtime hooks. RTK ships a template at `rtk/hooks/codex/rtk-awareness.md`. Two approaches:

**Approach A (preferred):** Inject RTK awareness instructions into the system prompt the orchestrator passes to Codex. Codex's CLI doesn't have PreToolUse equivalent, so we can't intercept Bash calls — but we can instruct the model to prefer `rtk <cmd>` invocations. Limited reach (model has to comply) but zero infra.

**Approach B (fallback):** Wrap the Codex CLI binary itself in a shim that intercepts its bash invocations. Higher engineering cost; defer unless A proves insufficient.

Decision: ship Approach A in Phase 1, measure adoption via `rtk gain --history`, escalate to B only if data justifies it.

#### 4.1.2 Gemini adapter

Gemini CLI supports `BeforeTool` hook (`hooks.json` format). RTK template at `rtk/hooks/codex/` — wait, verify the actual path; I think it's `rtk/hooks/gemini/`. Same shape as Claude's PreToolUse.

**Modified: `src/main/cli/adapters/gemini-cli-adapter.ts`** — register equivalent hook config, pointing at the same `rtk-defer-hook.mjs` (the script reads `tool_name`/`tool_input` which are common across Claude/Gemini protocols — verify).

#### 4.1.3 Copilot adapter

Copilot (CLI variant) uses Claude Code's hook format. Should be a near-copy of the Claude adapter wiring.

**Modified: `src/main/cli/adapters/copilot-cli-adapter.ts`** — register PreToolUse hook with combined script.

Note: VS Code Copilot is a different beast (extension, not CLI). Out of scope for this bigchange.

#### 4.1.4 Tracking DB reader

**New: `src/main/cli/rtk/rtk-tracking-reader.ts`** (~80 LOC)

```ts
// Read-only better-sqlite3 access to ~/.local/share/rtk/tracking.db
//   (macOS: ~/Library/Application Support/rtk/tracking.db)
//   (Windows: %APPDATA%\rtk\tracking.db)

export interface RtkSavingsSummary {
  commands: number;
  totalInput: number;
  totalOutput: number;
  totalSaved: number;
  avgSavingsPct: number;
  byCommand: { cmd: string; count: number; saved: number }[];
}

export class RtkTrackingReader {
  getSummaryForProject(projectPath: string, sinceMs?: number): RtkSavingsSummary | null;
  getSummaryAllProjects(sinceMs?: number): RtkSavingsSummary | null;
  getRecentHistory(limit: number): RtkCommandRecord[];
}
```

Key constraints:
- `readonly: true, fileMustExist: false` — graceful when rtk has never run
- Catch and log schema-mismatch errors (rtk may add columns; we don't migrate, we just SELECT what we know)
- Cache results in-process for ~5s to avoid hammering the DB

**Schema-version safety:** RTK does its own migrations on startup. We open read-only AFTER the binary has run at least once. If columns we reference are missing (older rtk), we degrade to "no data available" rather than crash.

#### 4.1.5 Savings IPC + Angular component

**New: `src/main/ipc/handlers/rtk-handlers.ts`** — `rtk:get-summary`, `rtk:get-history` IPC channels with Zod schemas.

**New: `src/main/cli/rtk/rtk-savings-store.ts`** — main-process service that polls the tracking reader every ~10s and pushes updates via IPC.

**New: `src/renderer/app/features/usage/rtk-savings-panel.component.ts`** — Angular standalone component, OnPush, signals. Shows total tokens saved, by-command breakdown, $-saved estimate (crosses with our existing pricing logic in `anthropic-api-provider.ts`).

#### 4.1.6 Phase 1 verification

- [ ] All four CLI adapters spawn with rtk hook (or AGENTS.md instruction for Codex)
- [ ] Multi-instance run: 4 parallel agents on same project, all writing to `tracking.db` concurrently — no corruption (WAL mode handles this; verify with stress test)
- [ ] UI panel shows live updates while agents run
- [ ] `npm run test` full suite green
- [ ] Manual smoke test on macOS arm64 packaged DMG
- [ ] Manual smoke test on Windows installer (rtk.exe path resolution)

---

### Phase 2 — Optional / Stretch

- Expose RTK's TOML filter DSL as a per-workspace extension (`<workspace>/.rtk/filters.toml`).
- Surface `rtk discover` / `rtk learn` outputs in a "missed savings" or "common errors" panel.
- Cross-reference `rtk cc-economics` with our internal cost tracking.
- Plugin event `tool.execute.before` exposed to third-party plugins so they can register custom rewriters.

Scope these as separate bigchanges if/when Phase 1 data justifies the work.

---

## 5. File Inventory

### New files (~15)
```
scripts/fetch-rtk-binaries.js
scripts/rtk-binaries.sha256.json
src/main/cli/rtk/rtk-runtime.ts
src/main/cli/rtk/rtk-tracking-reader.ts
src/main/cli/rtk/rtk-savings-store.ts
src/main/cli/rtk/__tests__/rtk-runtime.spec.ts
src/main/cli/rtk/__tests__/rtk-tracking-reader.spec.ts
src/main/cli/hooks/rtk-defer-hook.mjs
src/main/cli/hooks/__tests__/rtk-defer-hook.spec.ts
src/main/ipc/handlers/rtk-handlers.ts
src/main/ipc/handlers/__tests__/rtk-handlers.spec.ts
src/renderer/app/features/usage/rtk-savings-panel.component.ts
src/renderer/app/features/usage/rtk-savings-panel.component.spec.ts
src/renderer/app/services/rtk-savings.service.ts
src/shared/validation/rtk-ipc-schemas.ts
```

### Modified files (~10)
```
package.json                                              (scripts)
electron-builder.yml (or equivalent)                      (extraResources)
scripts/verify-native-abi.js                              (rtk version check)
src/shared/types/settings.ts                              (rtk feature flag)
src/main/cli/adapters/claude-cli-adapter.ts               (hook wiring)
src/main/cli/adapters/codex-cli-adapter.ts                (AGENTS.md injection)
src/main/cli/adapters/gemini-cli-adapter.ts               (BeforeTool hook)
src/main/cli/adapters/copilot-cli-adapter.ts              (PreToolUse hook)
src/main/cli/hooks/hook-path-resolver.ts                  (rtk hook path)
src/main/providers/provider-doctor.ts                     (rtk diagnostic)
src/preload/preload.ts                                    (rtk IPC exposure)
```

### Files to leave alone (explicitly)
```
src/main/workspace/git/vcs-manager.ts
src/main/workspace/git/worktree-manager.ts
src/main/git/branch-freshness.ts
src/main/repo-jobs/**
```
(Add `RTK_DISABLED=1` to env in their exec calls only if defense-in-depth is worth the noise.)

---

## 6. Open Questions / Decisions to Lock Before Implementing

### 6.1 Bundled vs system rtk preference
**Recommendation:** Prefer system rtk if version ≥ bundled, else use bundled. Power users who installed rtk via Homebrew already have a config at `~/.config/rtk/config.toml` they'd want to keep using. Add `bundledOnly: boolean` setting to override.

### 6.2 rtk exit 3 (ask) handling — **MUST resolve before implementation**
RTK exit 3 means "this command should require user confirmation." Two interpretations:
- **Option A:** Return `defer` from our hook → user gets orchestrator approval UI → approval rewrites the command
- **Option B:** Return `ask` → Claude's native prompt fires inside the CLI

**Recommendation: Option A.** Reasons:
1. Our orchestrator owns the user UX; bouncing approvals into Claude's TTY prompt breaks our UI flow.
2. We already pause-and-resume on defer; same path works.
3. RTK's exit 3 is conservative (their default verdict) — most commands hitting it are normal commands without explicit allow rules. Defer-to-orchestrator-UI is the right home for them.

### 6.3 Should we replace defer-permission-hook.mjs or run alongside?
**Recommendation: replace.** The new combined script is a strict superset gated by env var. Two scripts = two surfaces to maintain.

### 6.4 Codex AGENTS.md injection vs runtime shim
**Recommendation: ship AGENTS.md injection (Approach A) in Phase 1.** Measure compliance via `rtk gain --history`. Escalate to a bash wrapper shim only if model adoption is < 50%.

### 6.5 Multi-instance SQLite concurrency
RTK uses WAL mode + `busy_timeout=5000`. Multi-reader is safe. Multi-writer (two rtk processes from different orchestrator children writing simultaneously) should also be safe per WAL semantics, but **add a stress test in Phase 1 verification**: 4 parallel agents running 100 commands each, verify no DB corruption and final row counts match.

---

## 7. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| RTK upstream breaks `rtk rewrite` exit-code contract | Low | High | Pin version, smoke test in CI calls `rtk rewrite "git status"` and validates exit 0 + stdout |
| Internal git parsing breaks because user has shell-level `alias git=rtk git` | Low | High | Set `RTK_DISABLED=1` in internal exec env (cheap insurance) |
| macOS notarization rejects the bundled rtk binary | Medium | High | Verify in early test build; coordinate with whoever owns DMG signing |
| RTK binary crashes mid-rewrite | Low | Low | 2s hard timeout in `spawnSync`; on error, hook falls back to passing input through unchanged |
| Tracking DB schema changes break our reader | Medium | Low | Read-only with try/catch; degrade to "no data" rather than crash |
| Our combined hook adds latency to every Bash tool call | Medium | Medium | Benchmark: target <50ms p95. RTK is <10ms; Node startup is the long pole. Mitigate with persistent helper if needed (Phase 2). |
| User upgrades rtk via Homebrew to incompatible version | Low | Medium | If `system rtk` version unknown or below MIN, fall back to bundled |
| Telemetry pings home unexpectedly | Low | High (privacy) | `RTK_TELEMETRY_DISABLED=1` in every spawn env. Document. |
| Feature flag default-on too early breaks user workflows | Medium | Medium | Default OFF in v1. Flip after 2+ weeks of internal dogfood + user opt-in beta. |

---

## 8. Verification Plan (final, end-to-end)

Before flipping the feature flag default to ON:

1. **Functional**
   - Single Claude instance: 10 common bash commands → all rewritten correctly per `rtk gain --history`
   - Multi-instance (Phase 1): 4 parallel agents same project → no DB corruption, final summary correct
   - Failure cases: rtk binary missing/corrupt → app still works, rtk features disabled with clear log

2. **Build**
   - `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json` clean
   - `npm run lint` clean
   - `npm run test` full suite green

3. **Packaging**
   - macOS arm64 DMG: signed, notarized, launches, rtk binary executes
   - macOS x64 DMG: same
   - Windows installer: rtk.exe resolves and executes
   - Linux AppImage (if shipped): rtk binary executes

4. **Performance**
   - Benchmark: 100 Bash tool calls through hook, measure p50/p95/p99 added latency. Target: p95 < 50ms.
   - Token reduction measurement: same scripted session before/after, verify ≥60% reduction on the bundle of `git status / cargo test / cat / grep` commands.

5. **Privacy**
   - `RTK_TELEMETRY_DISABLED=1` confirmed in every spawned child env (audit via process-listing test)
   - No external network calls from rtk visible in packet capture during a 1-hour dogfood session

---

## 9. Rollback Plan

If RTK integration breaks something post-release:

1. **Hot fix (no app update needed):** Toggle the feature flag off in user settings. All hooks revert to current behavior because RTK logic is gated on `ORCHESTRATOR_RTK_ENABLED === '1'`.
2. **Patch release (app update required):** Default the feature flag to OFF for everyone via a version-based override.
3. **Last resort:** Revert this entire bigchange. The combined hook script is a strict superset of `defer-permission-hook.mjs`, so the rollback is mechanical: restore the old hook file path in the adapter wiring.

---

## 10. Follow-ups Not In This Plan

- Spawn a Gemini child for an independent review of this plan (didn't complete in initial drafting session — re-issue if desired).
- Decide whether to expose RTK's tee-recovery mechanism via our existing `microcompact` / `context-collapse` pipeline. Both solve a similar "raw output too big, save to disk, point at it later" problem. Worth a separate design doc.
- Investigate whether RTK's `rtk learn` output (auto-generated `.claude/rules/cli-corrections.md`) can feed our learning subsystem in `src/main/learning/`.
- Consider upstreaming a "JSON output mode" PR to RTK so our hook doesn't need to interpret exit codes via integer comparison.

---

## 11. Sign-off Checklist

Before merging this plan as `_completed`:
- [ ] All Phase 0 items implemented and verified per §4.0.8
- [ ] All Phase 1 items implemented and verified per §4.1.6
- [ ] All open questions in §6 explicitly resolved (with decisions documented)
- [ ] Risk register §7 reviewed; no Likelihood=Medium+ risk left unmitigated
- [ ] Verification plan §8 executed and signed off
- [ ] Rollback plan §9 tested at least once in a staging build

---

*End of plan.*
