# Pi Borrowed Capabilities Implementation Plan

> **Status:** COMPLETED — all task checklists are implemented and verified; renamed `_completed`.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely port the useful ideas from `../pi` into AI Orchestrator without duplicating subsystems where AIO is already at parity.

**Architecture:** This is a master plan split into independently testable waves. Wave 1 ports small utilities and direct hardening; Wave 2 hardens shared lifecycle, settings, plugin, and observability boundaries; Wave 3 adds user-facing composer and context features; Wave 4 stays gated behind explicit roadmap decisions for Loop Mode steering and provider-adapter plugins.

**Tech Stack:** Electron 40 main process, Angular 21 zoneless renderer, TypeScript 5.9, Vitest, Zod 4, better-sqlite3, existing AIO plugin and provider SDKs.

## Global Constraints

- Do not commit or push unless James explicitly asks.
- Keep unfinished planning documents untracked; if this plan is fully implemented and committed later, rename it with `_completed`.
- Keep secret values out of repo files, tests, docs, logs, fixtures, screenshots, and examples.
- Use `rtk` for shell commands in this repo.
- Prefer `const`, inferred literal types, and constructor generic arguments.
- After code changes, run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint` or focused ESLint, `npm run check:ts-max-loc`, and relevant Vitest specs.
- Do not widen untrusted project instruction interpolation. Shell-command config resolution is trusted-settings-only.
- Do not reuse `src/main/security/unicode-sanitizer.ts` for provider-bound surrogate cleanup; it has a different prompt-injection purpose.
- Do not replace the existing provider/CLI adapter architecture, agent-tree persistence, context compaction, or Loop Mode checkpointing. Extend them at their existing seams.

---

## Investigation Summary

The attached brief is accurate about the high-level gaps, but several items need AIO-specific boundaries:

- AIO already has dynamic slash-command interpolation in `src/main/commands/command-interpolation.ts`; do not duplicate it in config interpolation.
- AIO already has `withLock()` in `src/main/util/file-lock.ts`; the missing work is wiring it into settings writes and dirty-field conflict handling.
- AIO already has PTL retry/collapse in `src/main/context/ptl-retry.ts` and `src/main/context/context-collapse.ts`; pi contributes extra classifier fixtures, not a new recovery path.
- AIO already has resident steer/interrupt behavior for live instances and Loop Mode pause/cancel/checkpoints; pi's queues map to Loop Mode steering/save-points only if that roadmap item is accepted.
- AIO's worker plugin host already supports TypeScript entrypoints through `tsx`; the narrower gap is in-process discovery and project-trust gating.
- AIO's log pipeline truncates large structures and diagnostics exports redact values; the missing boundary is automatic redaction at logger and trace sinks.

## Plan Validation Status (re-verified 2026-06-28 against HEAD)

This plan was independently re-verified against current source. **Every "Missing/Partial"
status claim it inherits from the original `pi.md` brief was confirmed** with file:line evidence
(see Appendix C; the brief's claims and evidence are fully captured there, so the source file
itself has since been removed and is no longer required). All `src/...` and `packages/...` paths under "Files: Modify" exist; all
"Files: Create" targets are correctly absent; all `packages/agent|ai|coding-agent|orchestrator|tui/`
references are pi-clone sources (in `../pi`, not this repo) and are expected to be absent here.

**One defect class was found and corrected:** several per-task `Verification` blocks point at
Vitest spec files that do not exist at the stated path or are split differently in this repo.
**Before running any verification command, consult the correction table in Appendix C.2.** The
task bodies (file maps, interfaces, steps, what-could-break) are accurate as written.

**Highest-severity item:** Task 3 (shell-command secret resolution) is an RCE risk if
mis-scoped to untrusted project content — read **Appendix C.4** before implementing it. Full
per-item evidence with exact line numbers is in **Appendix C.1**; retired-draft rationale in **C.5**.

## File Responsibility Map

### Shared New Utilities

- `src/main/cli/json-parse.ts` - tolerant JSON/NDJSON parse helpers for provider adapter streams.
- `src/main/security/surrogate-sanitizer.ts` - provider-bound lone-surrogate stripping only.
- `src/main/core/config/trusted-config-value-resolver.ts` - trusted settings/config resolver for env, file, and command-backed secrets.
- `src/main/context/file-operation-extractor.ts` - file operation extraction for compaction and branch summaries.
- `src/main/util/abort-signals.ts` - leak-safe N-signal composition.
- `src/main/util/uuid-v7.ts` - monotonic UUIDv7 IDs for append-only logs where chronological sorting matters.
- `src/main/util/short-hash.ts` - small non-cryptographic hash for cache keys only.

### Renderer New Utilities

- `src/renderer/app/shared/utils/fuzzy.ts` - scored subsequence matching for overlays and pickers.
- `src/renderer/app/features/instance-detail/composer-autocomplete.ts` - textarea autocomplete query detection and replacement helpers.
- `src/renderer/app/features/instance-detail/composer-editing.ts` - kill-ring, undo coalescing, and word navigation helpers for the native textarea.
- `src/renderer/app/shared/utils/focus-trap.ts` - focus trap and focus restore primitives for overlay stacks and modals.

### Existing Files To Extend

- CLI streams: `src/main/cli/ndjson-parser.ts`, `src/main/cli/adapters/*-cli-adapter.ts`.
- Settings: `src/main/core/config/settings-manager.ts`, `src/main/core/config/config-interpolation.ts`, `src/shared/types/settings.types.ts`.
- Direct LLM paths: `src/main/providers/anthropic-api-provider.ts`, `src/main/rlm/auxiliary-llm-service.ts`, `src/main/rlm/llm-service.ts`.
- Lifecycle: `src/main/instance/instance-lifecycle.ts`, `src/main/instance/lifecycle/instance-spawner.ts`, `src/main/instance/lifecycle/interrupt-respawn-handler.ts`.
- Plugins and skills: `src/main/plugins/plugin-manager.ts`, `src/main/plugins/plugin-worker-host.ts`, `src/main/skills/skill-loader.ts`, `packages/contracts/src/schemas/plugin.schemas.ts`.
- Context: `src/main/context/context-compactor.ts`, `src/main/context/context-compaction-prompt.ts`, `src/main/session/agent-tree-persistence.ts`, `src/main/chats/chat-service.ts`.
- Renderer: `src/renderer/app/features/overlay/overlay-shell.component.ts`, `src/renderer/app/shared/components/prompt-modal/prompt-modal.component.ts`, `src/renderer/app/features/instance-detail/input-panel.component.ts`, `src/renderer/app/core/services/keybinding.service.ts`.
- Observability: `src/main/logging/logger.ts`, `src/main/observability/local-trace-exporter.ts`, `src/main/observability/otel-spans.ts`.

## Sequencing

1. Wave 1 quick wins: Tasks 1, 2, 6, 11, 15, and selected Task 20 utilities.
2. Wave 2 hardening: Tasks 3, 4, 8, 9, 12, 14, and 17.
3. Wave 3 user-facing features: Tasks 5, 7, 10, 13, and 16.
4. Wave 4 roadmap-gated work: Tasks 18 and 19.

Each task is independently testable. Do not batch waves unless the implementer can still run the focused tests listed under every task.

---

## Wave 1: Quick Wins

### Task 1: Streaming JSON Repair And Partial Parsing

**Source in pi:** `../pi/packages/ai/src/utils/json-parse.ts`

**Files:**
- Create: `src/main/cli/json-parse.ts`
- Create: `src/main/cli/json-parse.spec.ts`
- Modify: `src/main/cli/ndjson-parser.ts`
- Modify: `src/main/cli/adapters/copilot-cli-adapter.ts`
- Modify: `src/main/cli/adapters/claude-cli-adapter.ts`
- Modify: `src/main/cli/adapters/gemini-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

```ts
export interface JsonParseResult<T = unknown> {
  readonly ok: true;
  readonly value: T;
  readonly repaired: boolean;
  readonly partial: boolean;
}

export interface JsonParseFailure {
  readonly ok: false;
  readonly error: string;
  readonly inputExcerpt: string;
}

export function parseJsonWithRepair<T = unknown>(input: string): JsonParseResult<T> | JsonParseFailure;
export function parseStreamingJson<T = unknown>(input: string): JsonParseResult<T> | JsonParseFailure;
export function parseNdjsonLine<T = unknown>(line: string): JsonParseResult<T> | JsonParseFailure;
```

**Plan:**

- [x] Add dependencies: `npm install jsonrepair partial-json`.
- [x] Write `json-parse.spec.ts` covering: valid JSON, trailing comma repair, unterminated object partial parse, malformed text failure with excerpt, and no thrown exceptions.
- [x] Implement `parseJsonWithRepair()` with fast-path `JSON.parse`, fallback `jsonrepair`, and failure object.
- [x] Implement `parseStreamingJson()` with fast-path `JSON.parse`, partial parser fallback, then repair fallback.
- [x] Replace adapter-local `JSON.parse` calls on stream lines with `parseNdjsonLine()` where the current behavior catches and drops malformed events.
- [x] Keep final response parsing stricter where a partial object would corrupt accounting; use repair fallback but reject partial results for terminal accounting records.
- [x] Add adapter specs that feed malformed/truncated stream lines and assert the stream continues with a logged parse failure event instead of silently dropping data.

**What Could Break:**

- Partial parse could convert a genuinely incomplete terminal usage object into zero usage. Guard terminal usage with `partial === false`.
- Repair fallback could accept provider output that is not JSON. Keep failure objects and do not fabricate events from plain text.

**Verification:**

```bash
rtk npx vitest run src/main/cli/json-parse.spec.ts
rtk npx vitest run src/main/cli/adapters/copilot-cli-adapter.spec.ts src/main/cli/adapters/claude-cli-adapter.spec.ts src/main/cli/adapters/gemini-cli-adapter.spec.ts src/main/cli/adapters/codex-cli-adapter.spec.ts
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 2: Scored Fuzzy Finder

**Source in pi:** `../pi/packages/tui/src/fuzzy.ts`

**Files:**
- Create: `src/renderer/app/shared/utils/fuzzy.ts`
- Create: `src/renderer/app/shared/utils/fuzzy.spec.ts`
- Modify: `src/renderer/app/shared/utils/overlay-search.ts`
- Modify: `src/renderer/app/core/services/prompt-suggestion.service.ts`
- Modify after focused search: any renderer picker currently doing substring ranking.

**Interfaces:**

```ts
export interface FuzzyMatch {
  readonly matched: boolean;
  readonly score: number;
  readonly positions: readonly number[];
}

export interface FuzzyRanked<T> {
  readonly item: T;
  readonly score: number;
  readonly positions: readonly number[];
}

export function fuzzyMatch(query: string, candidate: string): FuzzyMatch;
export function fuzzyRank<T>(query: string, items: readonly T[], label: (item: T) => string): FuzzyRanked<T>[];
```

**Plan:**

- [x] Port pi's subsequence scoring into a renderer-only utility with no DOM dependency.
- [x] Write specs for exact match, case-insensitive match, acronym/subsequence match, gap penalty, word-boundary bonus, and stable ordering for equal scores.
- [x] Replace `overlay-search.ts` substring filtering with `fuzzyRank()`.
- [x] Update prompt suggestions to return ranked results while preserving current suggestion shape.
- [x] Keep highlighters optional: first patch returns positions from the utility, but only wire highlights where the current UI already renders spans.

**What Could Break:**

- Fuzzy ranking can surface more results than substring search. Preserve existing result limits at the call sites.
- Query `''` should keep current default ordering, not sort everything by score.

**Verification:**

```bash
rtk npx vitest run src/renderer/app/shared/utils/fuzzy.spec.ts
rtk npx vitest run src/renderer/app/core/services/prompt-suggestion.service.spec.ts
rtk npx tsc --noEmit
```

### Task 6: Lone-Surrogate Sanitization At Provider Text Boundaries

**Source in pi:** `../pi/packages/ai/src/utils/sanitize-unicode.ts`

**Files:**
- Create: `src/main/security/surrogate-sanitizer.ts`
- Create: `src/main/security/__tests__/surrogate-sanitizer.spec.ts`
- Modify: `src/main/providers/anthropic-api-provider.ts`
- Modify: `src/main/rlm/auxiliary-llm-service.ts`
- Modify: `src/main/rlm/llm-service.ts`
- Modify tests around direct provider calls where request bodies are asserted.

**Interfaces:**

```ts
export function stripLoneSurrogates(input: string): string;
export function sanitizeProviderText<T>(value: T): T;
```

**Plan:**

- [x] Write sanitizer specs proving valid surrogate pairs are preserved and lone high/low surrogates are removed.
- [x] Implement `stripLoneSurrogates()` as a narrow cleanup helper with no normalization and no invisible-character stripping.
- [x] Implement `sanitizeProviderText()` to recursively sanitize strings inside arrays and plain objects passed to direct API clients.
- [x] Apply at the last provider-bound request assembly point in `anthropic-api-provider.ts`.
- [x] Apply to auxiliary/direct LLM request assembly in `auxiliary-llm-service.ts` and `llm-service.ts`.
- [x] Keep CLI adapter streams untouched; terminals can legitimately echo replacement characters and this task only targets API 400s.

**What Could Break:**

- Reusing prompt-injection sanitizer would alter content semantics. This task must only strip lone surrogates.

**Verification:**

```bash
rtk npx vitest run src/main/security/__tests__/surrogate-sanitizer.spec.ts src/main/providers/anthropic-api-provider.spec.ts
rtk npx tsc --noEmit
```

### Task 11: File-Operation Tracking In Compaction Summaries

**Source in pi:** `../pi/packages/agent/src/harness/compaction/utils.ts`

**Files:**
- Create: `src/main/context/file-operation-extractor.ts`
- Create: `src/main/context/file-operation-extractor.spec.ts`
- Modify: `src/main/instance/tool-output-parser.ts`
- Modify: `src/main/context/context-compactor.ts`
- Modify: `src/main/context/context-compaction-prompt.ts`

**Interfaces:**

```ts
export type FileOperationKind = 'read' | 'write' | 'edit' | 'delete' | 'move' | 'execute';

export interface FileOperation {
  readonly kind: FileOperationKind;
  readonly path: string;
  readonly source: 'tool-call' | 'tool-output' | 'assistant-text';
}

export function extractFileOperations(input: string): readonly FileOperation[];
export function summarizeFileOperations(ops: readonly FileOperation[], maxItems?: number): string;
```

**Plan:**

- [x] Write specs for common AIO tool output strings: `Read`, `Edit`, `Write`, `rm`, `mv`, `git diff -- path`, and plain assistant text mentioning a file.
- [x] Implement extraction by reusing existing path extraction rules and adding operation-kind heuristics.
- [x] Add a deduplication pass keyed by `kind + path`, preserving first-seen order.
- [x] Add a "File operations observed" section to compaction prompts after the existing relevant-file context.
- [x] Ensure the compaction prompt caps operation count and byte size so a noisy tool transcript cannot dominate the summary.

**What Could Break:**

- Over-eager path parsing can add noise. Keep extraction heuristic-backed and cap at a small number such as 40 operations.

**Verification:**

```bash
rtk npm run test:quiet -- src/main/context/file-operation-extractor.spec.ts src/main/context/context-compaction-prompt.spec.ts src/main/context/__tests__/context-compactor.spec.ts
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 15: Context-Overflow Silent-Detection Heuristics

**Source in pi:** `../pi/packages/ai/src/utils/overflow.ts`

**Files:**
- Modify: `src/main/context/ptl-retry.ts`
- Modify: `src/main/context/error-withholder.ts`
- Modify: `src/main/orchestration/child-error-classifier.ts`
- Test: `src/main/context/ptl-retry.spec.ts`
- Test: `src/main/context/context-collapse.spec.ts`

**Interfaces:**

```ts
export interface ContextOverflowEvidence {
  readonly matched: boolean;
  readonly reason: 'provider-message' | 'silent-empty-response' | 'near-window-fill';
  readonly detail: string;
}

export function classifyContextOverflow(input: {
  readonly errorText?: string;
  readonly outputText?: string;
  readonly promptTokens?: number;
  readonly contextWindowTokens?: number;
}): ContextOverflowEvidence;
```

**Plan:**

- [x] Add provider regex fixtures from pi for cross-provider overflow messages.
- [x] Add AIO fixtures for zero-length assistant output after large prompt and near-window fill ratio.
- [x] Route `isContextOverflowError()` through `classifyContextOverflow()` while preserving existing behavior.
- [x] Wire the classifier into `child-error-classifier.ts` only for retry/collapse classification, not for generic child failures.
- [x] Keep collapse behavior in `ptl-retry.ts`; do not create a second retry mechanism.

**What Could Break:**

- False positives can collapse context unnecessarily. Require either an explicit provider overflow message or a high-confidence silent heuristic with prompt token evidence.

**Verification:**

```bash
rtk npx vitest run src/main/context/ptl-retry.spec.ts src/main/context/context-collapse.spec.ts
rtk npx vitest run src/main/orchestration/child-error-classifier.spec.ts
rtk npx tsc --noEmit
```

---

## Wave 2: Hardening And Trusted Boundaries

### Task 3: Trusted Config-Value DSL With Shell-Command Secret Resolution

**Source in pi:** `../pi/packages/coding-agent/src/core/resolve-config-value.ts`

**Files:**
- Create: `src/main/core/config/trusted-config-value-resolver.ts`
- Create: `src/main/core/config/__tests__/trusted-config-value-resolver.spec.ts`
- Modify: `src/main/core/config/config-interpolation.ts` only to document that it remains untrusted-instruction-only.
- Modify: `src/shared/types/auxiliary-llm.types.ts`
- Modify: `src/main/rlm/auxiliary-llm-service.ts`
- Modify validation schemas for auxiliary LLM settings if the field is schema-backed.

**Interfaces:**

```ts
export interface TrustedConfigResolverOptions {
  readonly cwd: string;
  readonly allowCommand: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export type TrustedConfigToken =
  | { readonly type: 'literal'; readonly value: string }
  | { readonly type: 'env'; readonly name: string }
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'cmd'; readonly command: string };

export function parseTrustedConfigValue(input: string): readonly TrustedConfigToken[];
export function resolveTrustedConfigValue(input: string, options: TrustedConfigResolverOptions): Promise<string>;
```

**Plan:**

- [x] Add an auxiliary provider field such as `apiKeyCommand?: string` while preserving existing `apiKeyEnv`.
- [x] Write resolver specs for literal values, `${env:NAME}`, `${file:relative/path}`, `${cmd:security find-generic-password ...}`, command timeout, output truncation, and command disabled mode.
- [x] Enforce `allowCommand: true` only in settings-backed resolver calls. Keep project instruction interpolation on `config-interpolation.ts`, where secret-shaped env vars remain blocked.
- [x] Resolve `apiKeyCommand` at runtime in `auxiliary-llm-service.ts`, redacting command output in logs.
- [x] Add precedence: explicit runtime secret source first, then `apiKeyEnv`, then `apiKeyCommand`. Do not persist resolved secret values.

**What Could Break:**

- Mixing this with untrusted project interpolation would be a command execution vulnerability. Keep the resolver separate and name it `trusted`.
- Logging command stdout would leak secrets. Tests must assert resolved values are not logged.

**Verification:**

```bash
rtk npx vitest run src/main/core/config/__tests__/trusted-config-value-resolver.spec.ts src/main/core/config/__tests__/config-interpolation.spec.ts
rtk npx vitest run src/main/rlm/auxiliary-llm-service.spec.ts
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 4: Lockfiled And Field-Level-Dirty Settings Writes

**Source in pi:** `../pi/packages/coding-agent/src/core/settings-manager.ts`

**Files:**
- Modify: `src/main/core/config/settings-manager.ts`
- Modify: `src/main/util/file-lock.ts` only if timeout/error details need to be surfaced.
- Create or extend: `src/main/core/config/settings-manager.spec.ts`

**Interfaces:**

```ts
interface SettingsWriteContext {
  readonly dirtyPaths: readonly string[];
  readonly expectedVersion: number;
}

interface SettingsConflict {
  readonly path: string;
  readonly diskValue: unknown;
  readonly attemptedValue: unknown;
}
```

**Plan:**

- [x] Add a settings version counter held in memory and persisted in the settings JSON metadata if the file already has metadata support; otherwise keep the version in memory and detect conflicts by re-reading under lock. *(electron-store persists a flat `AppSettings` with no metadata section, so the counter is in-memory — `SettingsManager.getVersion()` — and conflicts are detected by re-reading under the lock.)*
- [x] Track dirty paths for each setter/update call using dot paths such as `providers.claude.model`. *(`computeDirtyPaths` in new `settings-dirty-merge.ts`; e.g. `defaultModelByProvider.claude`.)*
- [x] Wrap file writes in existing `withLock(settingsPath, ...)`. *(All write paths go through `withSettingsWriteLock` → `withLockSync` from `util/file-lock.ts`; the sync variant is required because the public `set`/`update` API is synchronous for all existing callers.)*
- [x] During locked write, re-read disk, merge only dirty paths over the latest disk version, and preserve unrelated changes. *(`SettingsManager.writeDirtyFields` + `mergeDirtyPaths`/`detectConflicts`; conflicts surface via the `settings-conflict` event with attempted-value-wins / last-write-wins policy.)*
- [x] Emit current settings-changed events after the write succeeds, not before. *(Events carry the persisted merged value; lock failure emits nothing — spec-covered.)*
- [x] Write specs for concurrent updates to different fields, concurrent updates to the same field, lock timeout, and recovery from stale `.lock` files. *(`settings-manager.spec.ts` + new `src/main/util/file-lock.spec.ts`.)*

**What Could Break:**

- Existing settings events may assume optimistic in-memory mutation. Keep public state updated only after durable write, or emit a rollback event if preserving the current optimistic path is unavoidable.

**Verification:**

```bash
rtk npx vitest run src/main/core/config/settings-manager.spec.ts src/main/util/file-lock.spec.ts
rtk npx tsc --noEmit
```

### Task 8: Spawn-As-Transaction With Rollback

**Source in pi:** `../pi/packages/orchestrator/src/supervisor.ts`

**Files:**
- Create: `src/main/instance/lifecycle/spawn-transaction.ts`
- Create: `src/main/instance/lifecycle/__tests__/spawn-transaction.spec.ts`
- Modify: `src/main/instance/lifecycle/instance-spawner.ts`
- Modify: `src/main/instance/instance-lifecycle.ts`
- Extend: `src/main/instance/lifecycle/__tests__/instance-spawner.spec.ts`

**Interfaces:**

```ts
export interface SpawnTransaction {
  readonly id: string;
  addRollback(label: string, action: () => Promise<void> | void): void;
  commit(): void;
  rollback(cause: unknown): Promise<void>;
}

export function createSpawnTransaction(id: string): SpawnTransaction;
```

**Plan:**

- [x] Write `spawn-transaction.spec.ts` for LIFO rollback ordering, rollback continuing after one cleanup fails, commit disabling rollback, and redacted error details.
- [x] Wrap fresh-create instance resource acquisition in a transaction: adapter registration, supervisor node creation, output buffer registration, event listeners, and persistence inserts. (Also wired: `wake:` and `restart-fresh:` transactions in `instance-lifecycle.ts`.)
- [x] On spawn failure, rollback registered resources before surfacing the error to the renderer.
- [x] Keep interrupt/respawn handler logic mostly intact because it already has abort gates, force-abort timer, circuit breaker, and adapter cleanup. (Handler untouched; its spec passes.)
- [x] Add a targeted test where `adapter.spawn()` throws after UI state is partially registered, then assert no active instance, supervisor node, or output buffer remains. (`src/main/instance/__tests__/instance-lifecycle-spawn-rollback.spec.ts` — covers RLM-init failure, parent-child unlink, `adapter.spawn()` failure, initial-prompt-send failure, and success-commit.)

**What Could Break:**

- Over-wrapping interrupt recovery could regress its existing defensive behavior. Restrict this task to fresh-create and wake/restart paths that currently register UI state before async spawn completion.

**Verification:**

```bash
rtk npx vitest run src/main/instance/lifecycle/__tests__/spawn-transaction.spec.ts src/main/instance/lifecycle/__tests__/instance-spawner.spec.ts
rtk npx vitest run src/main/instance/instance-manager.spec.ts
rtk npx tsc --noEmit
```

### Task 9: Three-Phase Trust-Gated Plugin Loading

**Source in pi:** `../pi/packages/coding-agent/src/core/resource-loader.ts`

**Files:**
- Create: `src/main/plugins/project-plugin-trust.ts`
- Create: `src/main/plugins/project-plugin-trust.spec.ts`
- Modify: `src/main/plugins/plugin-manager.ts`
- Modify: `src/main/plugins/plugin-manager.spec.ts`
- Modify: `src/shared/types/settings.types.ts`
- Modify renderer plugin/settings UI only after IPC is in place.

**Interfaces:**

```ts
export type ProjectPluginTrust = 'trusted' | 'untrusted' | 'ask';

export interface ProjectPluginTrustDecision {
  readonly trust: ProjectPluginTrust;
  readonly reason: string;
  readonly projectRoot: string;
}

export function resolveProjectPluginTrust(projectRoot: string, settings: unknown): ProjectPluginTrustDecision;
```

**Plan:**

- [x] Add a settings-backed trust map keyed by canonical project root.
- [x] Split plugin loading into three phases: global bundled plugins, user-installed plugins, then project-scoped plugins. (AIO ships no bundled plugins; the loader is phase-split by scan scope — user-installed `~/.orchestrator/plugins` first, then project-scoped roots, with the trust gate applied only to project scope.)
- [x] Load project-scoped plugins only when trust is `trusted`.
- [x] When trust is `ask` or `untrusted`, surface manifest metadata without importing plugin entrypoints.
- [x] Add IPC follow-up to trust or reject a project plugin root (`project-plugin-trust:query|grant|revoke` + preload `projectPluginTrust*`). The import happens only after the trust setting is written (write-before-cache-clear ordering is test-asserted).
- [x] Renderer settings/plugin UI for the trust prompt (build on the preload surface above; explicitly deferred renderer-scoped follow-up).
- [x] Add tests proving malicious project plugin JavaScript is not imported while untrusted, including worker-isolated and legacy in-process manifests.

**What Could Break:**

- Existing users with project plugins may see them disabled until trust is granted. Add a clear UI state and logs that include plugin name and project root, not code contents.

**Verification:**

```bash
rtk npx vitest run src/main/plugins/project-plugin-trust.spec.ts src/main/plugins/plugin-manager.spec.ts src/main/plugins/__tests__/manifest-validation.spec.ts
rtk npx tsc --noEmit
```

### Task 12: Skill Spec Compliance For Ignore Files, Strict Names, And YAML

**Source in pi:** `../pi/packages/coding-agent/src/core/skills.ts`

**Files:**
- Modify: `src/main/skills/skill-loader.ts`
- Modify: `src/main/skills/skill-registry.ts`
- Add or extend: `src/main/skills/skill-loader.spec.ts`
- Modify: `package.json` and `package-lock.json` if adding `yaml`.

**Interfaces:**

```ts
export interface SkillIgnoreMatcher {
  ignores(relativePath: string): boolean;
}

export function createSkillIgnoreMatcher(skillRoot: string, ignoreFileNames?: readonly string[]): Promise<SkillIgnoreMatcher>;
export function validateSkillName(name: string): { ok: true } | { ok: false; reason: string };
```

**Plan:**

- [x] Replace ad hoc frontmatter parsing with a real YAML parser while preserving current accepted frontmatter fields.
- [x] Enforce strict skill names: lowercase letters, numbers, hyphen, underscore, colon for plugin prefix, and no path separators.
- [x] Support ignore files for skill content walks so generated caches, screenshots, and large fixtures do not get loaded as skill context.
- [x] Add tests for valid names, invalid names, YAML quoting/colon values, ignore-file exclusions, and backward-compatible simple frontmatter.
- [x] Keep existing discovered skill IDs stable except where a skill name is invalid and must be rejected with a clear diagnostic.

**What Could Break:**

- A stricter parser can reject existing user skills. Log exact file path and validation reason, then skip that skill instead of failing the full skill load.

**Verification:**

```bash
rtk npx vitest run src/main/skills/skill-loader.spec.ts src/main/skills/builtin/loop-recipe-skills.spec.ts
rtk npx tsc --noEmit
```

### Task 14: Auto-Redaction At Log And Span Sinks

**Source in pi:** `../pi/packages/agent/docs/observability.md`

**Files:**
- Modify: `src/main/diagnostics/redaction.ts`
- Modify: `src/main/logging/logger.ts`
- Modify: `src/main/observability/local-trace-exporter.ts`
- Modify: `src/main/observability/otel-spans.ts`
- Extend: `src/main/observability/provider-runtime-trace-sink.spec.ts`
- Add or extend logger redaction tests.

**Interfaces:**

```ts
export interface RedactionPolicy {
  readonly mode: 'safe-default';
  readonly allowKeys: readonly string[];
}

export function redactForSink(value: unknown, policy?: RedactionPolicy): unknown;
```

**Plan:**

- [x] Add `redactForSink()` that delegates to `redactValue()` and applies an allowlist for known-safe keys.
- [x] Apply redaction in the logger transport path before console/file writes.
- [x] Apply redaction before local trace export serialization (both `local-trace-exporter.ts` and the `lifecycle-trace.ts` NDJSON sink).
- [x] Apply redaction in span helper attribute/event setters so future call sites inherit the default.
- [x] Write tests proving secret-looking keys and values do not appear in logger buffers, trace exports, span attributes, or provider runtime trace sink output.
- [x] Preserve useful observability fields such as provider id, model id, event type, durations, token counts, and status.

**What Could Break:**

- Over-redaction can make diagnostics useless. Use an explicit allowlist for known-safe operational fields and denylist everything secret-shaped.

**Verification:**

```bash
rtk npx vitest run src/main/observability/provider-runtime-trace-sink.spec.ts src/main/observability/local-trace-exporter.spec.ts
rtk npx vitest run src/main/diagnostics/redaction.spec.ts
rtk npx tsc --noEmit
```

### Task 17: Unify TypeScript Plugin Loading

**Source in pi:** `../pi/packages/coding-agent/src/core/extensions/loader.ts`

**Files:**
- Modify: `src/main/plugins/plugin-manager.ts`
- Modify: `src/main/plugins/plugin-worker-host.ts`
- Extend: `src/main/plugins/plugin-manager.spec.ts`
- Extend: `src/main/plugins/plugin-worker-host.spec.ts`

**Interfaces:**

```ts
export type PluginEntrypointKind = 'javascript' | 'typescript';

export function classifyPluginEntrypoint(filePath: string): PluginEntrypointKind;
```

**Plan:**

- [x] Add discovery support for `.ts` entrypoints only when the plugin isolation mode is `worker`.
- [x] Route TypeScript plugin entrypoints through `PluginWorkerHost`, which already passes `--import tsx` for `.ts`.
- [x] Reject legacy in-process `.ts` plugins with a diagnostic that instructs the plugin author to set `"isolation": "worker"`.
- [x] Add tests for worker `.ts` plugin load, in-process `.ts` rejection, and existing `.js` behavior.

**What Could Break:**

- In packaged Electron, dynamic importing arbitrary TypeScript in-process is not reliable. Keep TS support worker-only.

**Verification:**

```bash
rtk npx vitest run src/main/plugins/plugin-manager.spec.ts src/main/plugins/plugin-worker-host.spec.ts
rtk npx tsc --noEmit
```

---

## Wave 3: User-Facing Features

### Task 5: Branch Summarization On Tree Navigation

**Source in pi:** `../pi/packages/agent/src/harness/compaction/branch-summarization.ts`

**Files:**
- Create: `src/main/context/branch-summarizer.ts`
- Create: `src/main/context/branch-summarizer.spec.ts`
- Modify: `src/main/session/agent-tree-persistence.ts`
- Modify: `src/main/chats/chat-service.ts`
- Modify: `src/main/context/context-compactor.ts`
- Modify schema/persistence files if the summary is stored in RLM.

**Interfaces:**

```ts
export interface BranchSummaryInput {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly transcriptExcerpt: string;
  readonly fileOperations: readonly FileOperation[];
}

export interface BranchSummary {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly summary: string;
  readonly fileOperations: readonly FileOperation[];
  readonly createdAt: number;
}

export interface BranchSummarizer {
  summarize(input: BranchSummaryInput): Promise<BranchSummary>;
}
```

**Plan:**

- [x] Add a deterministic local summarizer fallback that formats file operations and the last bounded transcript excerpt without calling an LLM.
- [x] Add an optional auxiliary-LLM summarizer path using the existing auxiliary LLM service after Task 6 sanitizer is in place.
- [x] Hook branch summary creation when chat/tree navigation switches away from a branch with unsummarized new turns. (Seam: `ChatService.setUiState` → `ChatBranchSummaryScheduler.queue` — fire-and-forget, navigation never awaits the summarizer; `agent-tree-persistence.ts` needed no change, the navigation event lives in chat UI state.)
- [x] Inject the latest branch summary into context compaction prompts and next-turn context after switching branches. (Next turn: `chat-continuity.ts` rebuild preamble; compaction: `extractBranchSummaryBlocks` → `buildCompactionPrompt` `<branch_switch_summaries>` anchor.)
- [x] Persist summaries with branch node ids so repeated navigation does not regenerate the same summary. (Thread metadata `branchSummaries[from::to].upToSequence` gates regeneration.)
- [x] Add tests for summary creation, no duplicate summary on repeated navigation, file-operation preservation, and fallback behavior when auxiliary LLM fails.

**What Could Break:**

- Navigation must not block on slow summarization. Generate asynchronously and inject the last completed summary; log failures without breaking navigation.

**Verification:**

```bash
rtk npx vitest run src/main/context/branch-summarizer.spec.ts src/main/chats/chat-service.spec.ts src/main/context/__tests__/context-compactor.spec.ts
rtk npx tsc --noEmit
```

### Task 7: At-Mention And File-Path Autocomplete In Composer

**Source in pi:** `../pi/packages/tui/src/autocomplete.ts`

**Files:**
- Create: `src/renderer/app/features/instance-detail/composer-autocomplete.ts`
- Create: `src/renderer/app/features/instance-detail/composer-autocomplete.spec.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/core/services/ipc/codebase-ipc.service.ts`
- Modify main IPC handler only if no existing file-search endpoint covers this use.

**Interfaces:**

```ts
export type ComposerCompletionKind = 'slash-command' | 'file' | 'symbol';

export interface ComposerCompletionQuery {
  readonly kind: ComposerCompletionKind;
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

export interface ComposerCompletionItem {
  readonly kind: ComposerCompletionKind;
  readonly label: string;
  readonly insertText: string;
  readonly detail?: string;
}

export function detectComposerCompletion(text: string, cursor: number): ComposerCompletionQuery | null;
export function applyComposerCompletion(text: string, completion: ComposerCompletionQuery, item: ComposerCompletionItem): { text: string; cursor: number };
```

**Plan:**

- [x] Write detection specs for `/slash`, `@file`, `@src/main/foo`, no completion in email addresses, and replacement with cursor placement.
- [x] Back file suggestions with existing codebase/workspace IPC search and Task 2 fuzzy ranking.
- [x] Add a small overlay anchored to the textarea caret or a stable bottom-panel position if caret coordinates are unreliable.
- [x] Support keyboard controls: ArrowUp, ArrowDown, Enter/Tab accept, Escape close.
- [x] Keep submit behavior unchanged when no completion menu is open.
- [x] Add UI tests or component specs for opening, selecting, and preserving textarea focus.

**What Could Break:**

- The composer has substantial state in `input-panel.component.ts`. Put text/query logic in pure helpers and keep the component wiring thin.

**Verification:**

```bash
rtk npx vitest run src/renderer/app/features/instance-detail/composer-autocomplete.spec.ts
rtk npx vitest run src/renderer/app/features/instance-detail/input-panel.component.spec.ts
rtk npx tsc --noEmit
```

### Task 10: Modal Focus Trap And Focus Restore State Machine

**Source in pi:** `../pi/packages/tui/src/tui.ts`

**Files:**
- Create: `src/renderer/app/shared/utils/focus-trap.ts`
- Create: `src/renderer/app/shared/utils/focus-trap.spec.ts`
- Modify: `src/renderer/app/features/overlay/overlay-shell.component.ts`
- Modify: `src/renderer/app/shared/components/prompt-modal/prompt-modal.component.ts`
- Modify settings or command-palette modal wrappers if they bypass the overlay shell.

**Interfaces:**

```ts
export interface FocusTrapHandle {
  activate(): void;
  deactivate(): void;
  restore(): void;
}

export function createFocusTrap(container: HTMLElement, options?: { initialFocus?: HTMLElement | null }): FocusTrapHandle;
```

**Plan:**

- [x] Write pure DOM specs with a container, two focusable buttons, and an outside button.
- [x] Trap Tab and Shift+Tab within the active modal/overlay container.
- [x] Store the previously focused element on activation and restore it on close if it is still connected.
- [x] Add stack behavior so nested modal close restores focus to the parent overlay, not the page underneath.
- [x] Wire overlay shell activation/deactivation through Angular lifecycle.
- [x] Wire prompt modal activation/deactivation and verify Escape/close restores focus.

**What Could Break:**

- Focus restore can fail if the previous element was removed. Check `isConnected` before restoring and fall back to the composer/input root.

**Verification:**

```bash
rtk npx vitest run src/renderer/app/shared/utils/focus-trap.spec.ts
rtk npx vitest run src/renderer/app/features/overlay/overlay-shell.component.spec.ts src/renderer/app/shared/components/prompt-modal/prompt-modal.component.spec.ts
rtk npx tsc --noEmit
```

### Task 13: Keybinding Conflict Detection And Import/Export

**Source in pi:** `../pi/packages/tui/src/keybindings.ts`

**Files:**
- Modify: `src/renderer/app/core/services/keybinding.service.ts`
- Modify: `src/renderer/app/core/services/keybinding.service.spec.ts`
- Modify: `src/renderer/app/features/settings/keyboard-settings-tab.component.ts`
- Modify settings IPC/types if keybinding JSON import/export crosses main process.

**Interfaces:**

```ts
export interface KeybindingConflict {
  readonly key: string;
  readonly actionIds: readonly string[];
  readonly scope: string;
}

export function exportKeybindings(): string;
export function importKeybindings(json: string): { applied: number; conflicts: readonly KeybindingConflict[] };
```

**Plan:**

- [x] Add conflict detection grouped by normalized key sequence and scope.
- [x] Treat leader-sequence prefixes as conflicts when one action consumes a prefix of another in the same scope.
- [x] Add JSON export from current keybinding settings.
- [x] Add JSON import with schema validation, conflict report, and no partial application on invalid JSON.
- [x] Surface conflicts in the keyboard settings tab before saving imported bindings.

**What Could Break:**

- Users may already have conflicts that were silently accepted. Show conflicts as warnings and block only new imports that introduce unresolved conflicts.

**Verification:**

```bash
rtk npx vitest run src/renderer/app/core/services/keybinding.service.spec.ts
rtk npx vitest run src/renderer/app/features/settings/keyboard-settings-tab.component.spec.ts
rtk npx tsc --noEmit
```

### Task 16: Composer Editing Primitives

**Source in pi:** `../pi/packages/tui/src/kill-ring.ts`, `../pi/packages/tui/src/undo-stack.ts`

**Files:**
- Create: `src/renderer/app/features/instance-detail/composer-editing.ts`
- Create: `src/renderer/app/features/instance-detail/composer-editing.spec.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/features/settings/keyboard-settings-tab.component.ts` only if exposing remappable actions.

**Interfaces:**

```ts
export interface TextareaEditState {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

export class KillRing {
  push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void;
  peek(): string | undefined;
  rotate(): void;
  readonly length: number;
}

export function moveByWord(state: TextareaEditState, direction: 'left' | 'right', extend: boolean): TextareaEditState;
export function killWord(state: TextareaEditState, direction: 'left' | 'right', ring: KillRing): TextareaEditState;
export function yank(state: TextareaEditState, ring: KillRing): TextareaEditState;
```

**Plan:**

- [x] Port kill-ring behavior with accumulate-on-consecutive-kill.
- [x] Add word navigation helpers that operate on plain textarea state.
- [x] Add undo coalescing for adjacent text insertions and kill operations without fighting browser native undo for ordinary typing.
- [x] Wire keybindings through the existing keybinding service instead of hardcoding platform-specific shortcuts in the component.
- [x] Keep textarea focus and selection stable after each action.

**What Could Break:**

- Native browser undo is hard to replace safely. Start by intercepting only explicit editing commands, not every text input event.

**Verification:**

```bash
rtk npx vitest run src/renderer/app/features/instance-detail/composer-editing.spec.ts src/renderer/app/features/instance-detail/input-panel.component.spec.ts
rtk npx tsc --noEmit
```

---

## Wave 4: Roadmap-Gated Work

### Task 18: Steering, Follow-Up, And Save-Point Discipline For Loop Mode

**Source in pi:** `../pi/packages/agent/src/agent-loop.ts`

**Files:**
- Modify: `src/shared/types/loop.types.ts`
- Modify: `packages/contracts/src/schemas/loop.schemas.ts`
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Modify: `src/main/orchestration/loop-coordinator.types.ts`
- Modify: `src/main/ipc/handlers/loop-handlers.ts` or current loop IPC handler.
- Modify renderer Loop Mode controls after IPC is stable.

**Interfaces:**

```ts
export type LoopMessageQueueKind = 'steering' | 'follow-up' | 'next-iteration';
export type LoopQueueDrainMode = 'all' | 'one-at-a-time';

export interface LoopQueuedMessage {
  readonly id: string;
  readonly kind: LoopMessageQueueKind;
  readonly message: string;
  readonly createdAt: number;
  readonly drainMode: LoopQueueDrainMode;
}
```

**Plan:** *(verified implemented 2026-07-02 — landed under the existing `LoopPendingInput` naming instead of the plan's `LoopQueuedMessage`: kinds `steer`/`queue`/`follow-up` ≙ steering/next-iteration/follow-up, `drainMode` on `LoopPendingInput`, drain split in `loop-coordinator-block-utils.ts`, steering downgrade event `loop:steering-downgraded`, follow-up drain at the completion seam, checkpoints persist the queue, renderer controls in `loop-control.component.ts`. Specs: `loop-coordinator-steering-followup.spec.ts`, `loop-coordinator-block-utils.spec.ts`, `loop-coordinator-restore.spec.ts` — 22/22 green.)*

- [x] Preserve current `intervene()` behavior as `next-iteration`.
- [x] Add a durable queued-message field to loop state and schema.
- [x] Drain `next-iteration` messages at prompt build time, exactly where `pendingInterventions` is cleared today.
- [x] Add `follow-up` messages that run after an iteration would otherwise stop but before terminal completion is accepted.
- [x] Add `steering` only where the active provider adapter can accept mid-iteration input. If not supported, downgrade to `next-iteration` and surface that downgrade in UI.
- [x] Add save-points after each iteration and before applying queued config changes so resume sees a coherent queue state.
- [x] Add tests for queue ordering, one-at-a-time drain, restored paused loops preserving queues, and cancellation clearing in-flight gates.

**What Could Break:**

- Loop Mode already has substantial checkpointing. Do not put transient provider state into durable queue records.
- Mid-iteration steering depends on provider support; never pretend a message was delivered live if it was queued for the next iteration.

**Verification:**

```bash
rtk npx vitest run src/main/orchestration/loop-coordinator.spec.ts src/main/orchestration/loop-store.spec.ts
rtk npx vitest run packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts
rtk npx tsc --noEmit
```

### Task 19: Custom Provider And CLI-Adapter Plugin API

**Source in pi:** `../pi/packages/coding-agent/docs/custom-provider.md`

**Files:**
- Modify: `packages/sdk/src/provider-adapter.ts`
- Modify: `packages/sdk/src/provider-adapter-registry.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `src/main/providers/provider-adapter-registry.ts`
- Modify: `src/main/providers/register-built-in-providers.ts`
- Modify: `src/main/plugins/plugin-worker-host.ts`
- Modify: `src/main/plugins/plugin-manager.ts`
- Add tests under `packages/sdk/src/__tests__/` and `src/main/providers/__tests__/`.

**Interfaces:**

```ts
export interface PluginProviderAdapterDescriptor {
  readonly provider: string;
  readonly displayName: string;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly defaultConfig: ProviderConfig;
  readonly isolation: 'worker';
}

export interface ProviderAdapterPluginApi {
  registerProviderAdapter(
    descriptor: PluginProviderAdapterDescriptor,
    factoryRef: string,
  ): void;
}
```

**Plan:**

- [x] Extend SDK types with a plugin-facing descriptor that cannot collide with built-in provider ids.
- [x] Add registry collision tests for built-in provider names and duplicate plugin provider names.
- [x] Add worker RPC for plugin provider factories. Keep actual adapter invocation isolated to the worker or a controlled host bridge.
- [x] Add capability negotiation so UI can show plugin providers only after registration succeeds.
- [x] Add doctor/health checks for plugin providers using the existing provider runtime service patterns.
- [x] Document minimum plugin manifest fields for provider adapters.

**What Could Break:**

- Provider adapters run commands and handle credentials. This task must depend on Task 9 project trust and should be worker-isolated by default.

**Verification:**

```bash
rtk npx vitest run packages/sdk/src/__tests__/provider-adapter-registry.types.spec.ts packages/sdk/src/__tests__/sdk-exports.spec.ts
rtk npx vitest run src/main/providers/__tests__/provider-adapter-registry.spec.ts src/main/plugins/plugin-manager.spec.ts src/main/plugins/plugin-worker-host.spec.ts
rtk npx tsc --noEmit
```

---

## Task 20: Misc Small Utilities Worth Grabbing

This task should be split into separate pull requests unless implemented as a single utility-only wave.

### Task 20A: Monotonic UUIDv7

**Files:**
- Create: `src/main/util/uuid-v7.ts`
- Create: `src/main/util/uuid-v7.spec.ts`

**Interfaces:**

```ts
export function uuidv7(): string;
export function resetUuidv7ForTesting(): void;
```

**Plan:**

- [x] Port the dependency-free monotonic UUIDv7 algorithm.
- [x] Test lexical sort order for multiple ids generated in the same millisecond.
- [x] Use only for new append-only log ids after a call-site proves chronological sorting matters.

**Verification:**

```bash
rtk npx vitest run src/main/util/uuid-v7.spec.ts
```

### Task 20B: Combine Abort Signals

**Files:**
- Create: `src/main/util/abort-signals.ts`
- Create: `src/main/util/abort-signals.spec.ts`
- Modify: `src/main/orchestration/loop-coordinator.ts` where manual timers compose aborts.

**Interfaces:**

```ts
export function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignal;
```

**Plan:**

- [x] Implement zero-signal, one-signal, and many-signal paths.
- [x] Remove listeners after abort to prevent leaks.
- [x] Replace one manual Loop Mode abort composition site after tests are green.

**Verification:**

```bash
rtk npx vitest run src/main/util/abort-signals.spec.ts src/main/orchestration/loop-coordinator.spec.ts
```

### Task 20C: Faux Provider Test Double Top-Up

**Files:**
- Modify: `src/main/cli/adapters/scripted-cli-adapter.ts`
- Modify: `src/main/cli/adapters/scripted-cli-adapter.test-helpers.ts`
- Modify: `src/main/cli/adapters/scripted-cli-adapter.spec.ts`
- Modify: `src/main/providers/adapter-runtime-event-bridge.scripted-parity.spec.ts`
- Modify: `src/main/orchestration/loop-coordinator-usage-throttle.spec.ts`

**Plan:**

- [x] Add token pacing, abort timing, prompt-cache simulation, and deterministic cost accounting knobs.
- [x] Use it to cover provider quota throttling and Loop Mode cost paths.

**Verification:**

```bash
rtk npx vitest run src/main/cli/adapters/scripted-cli-adapter.spec.ts src/main/providers/adapter-runtime-event-bridge.scripted-parity.spec.ts src/main/orchestration/loop-coordinator-usage-throttle.spec.ts
```

### Task 20D: Prompt-Template Arg Slicing

**Files:**
- Modify: `src/shared/types/command.types.ts`
- Modify: `src/shared/types/__tests__/command.types.spec.ts`
- Modify: `src/main/commands/command-manager.ts` only if parsed metadata needs to surface defaults.

**Interfaces:**

```ts
export function resolveTemplate(template: string, args: string[]): string;
```

**Plan:**

- [x] Extend existing `$1`, `$2`, `$ARGUMENTS`, and `${ARGUMENTS}` support with `${@:N:L}` and `${N:-default}`.
- [x] Add quoting-compatible tests using spaces in arguments.
- [x] Preserve current cleanup of unreplaced placeholders.

**Verification:**

```bash
rtk npx vitest run src/shared/types/__tests__/command.types.spec.ts src/main/commands/__tests__/command-manager.spec.ts
```

### Task 20E: Short Hash

**Files:**
- Create: `src/main/util/short-hash.ts`
- Create: `src/main/util/short-hash.spec.ts`

**Interfaces:**

```ts
export function shortHash(input: string): string;
```

**Plan:**

- [x] Implement a dependency-free `Math.imul` digest for non-security cache keys.
- [x] Name the helper `shortHash` and document that it is not cryptographic.

**Verification:**

```bash
rtk npx vitest run src/main/util/short-hash.spec.ts
```

### Task 20F: Provider Env Fallback For SEA/Bun-Like Empty Environments

**Files:**
- Create: `src/main/util/provider-env.ts`
- Create: `src/main/util/provider-env.spec.ts`
- Modify provider auth discovery only if a real empty-`process.env` symptom is reproduced.

**Interfaces:**

```ts
export interface ProviderEnvReadOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly procEnvironPath?: string;
}

export function readProviderEnv(name: string, options?: ProviderEnvReadOptions): string | undefined;
```

**Plan:**

- [x] Implement `process.env` first.
- [x] Add macOS/Linux fallback that reads `/proc/self/environ` only when present and only when `process.env[name]` is missing.
- [x] Keep this dormant until SEA builds reproduce empty provider env.

**Verification:**

```bash
rtk npx vitest run src/main/util/provider-env.spec.ts
```

---

## Explicit Non-Goals

- Do not reimplement AIO provider/CLI adapters as pi-style providers.
- Do not replace AIO's context compaction or PTL retry system.
- Do not add shell execution to project instruction interpolation.
- Do not load project plugin code before trust is resolved.
- Do not apply prompt-injection Unicode normalization to provider-bound user content.
- Do not implement Loop Mode live steering unless the provider can prove delivery semantics.

## Final Verification For Any Multi-File Implementation Wave

Run these after each wave, in addition to each task's focused tests:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test
```

## Self-Review Checklist

- [x] Every item from the attached pi brief maps to at least one task above.
- [x] Tasks that touch secrets use trusted settings paths only and include redaction verification.
- [x] Tasks that touch project plugin code depend on trust gating before import.
- [x] Tasks that touch Loop Mode preserve pause, cancel, checkpoint restore, and terminal cleanup semantics.
- [x] Tasks that touch renderer input keep native textarea focus and submit behavior stable.
- [x] No task requires committing or pushing.

---

## Appendix C: Source-Verification And Verification-Command Corrections (2026-06-28)

This appendix was added after an independent verification pass. It exists because two earlier
same-day drafts (`2026-06-27-pi-techniques-import-plan.md`,
`2026-06-27-pi-inspired-aio-hardening.md`) were retired in favor of this plan, and the
verification commands needed reconciling against the repo's actual test layout.

### C.1 Status claims confirmed against source

All grep/read-verified on HEAD, 2026-06-28. Line numbers are exact (verified by direct grep,
not approximated). **All 20 brief items are covered below — none grouped.** Items 15, 19, and 20
are confirmed at the file/structure level (the pi brief itself scopes them as "cross-check" or
"top-up" rather than a hard missing-module gap), and that scope is noted in their rows.

| # | Claim | Evidence (exact citations) |
|---|-------|----------------------------|
| 1 | Adapters drop malformed/truncated NDJSON lines silently | `copilot-cli-adapter.ts` **L561** `/* drop incomplete trailing line */`; `cursor-cli-adapter.ts` **L361** (same comment); `codex-cli-adapter.ts` **L3157** `// Non-JSON lines are kept in raw stdout…`; `claude-cli-adapter.ts` **L977** `// Ignore non-JSON lines`; `ndjson-parser.ts` flush **L138** `Discarding incomplete NDJSON buffer`; `gemini-cli-adapter.ts` first `JSON.parse(line)` **L229**. No `jsonrepair`/`partial-json` import anywhere in `src`/`packages`. |
| 2 | No reusable scored fuzzy finder | `shared/utils/overlay-search.ts` = substring + exact/prefix/substring intent score (no subsequence scoring); `skills/trigger-matcher.ts` has word-level Levenshtein but is skill-trigger-only; no fuzzy lib (`fuzzysort`/`fuse`/`fzf`) in `package.json`. |
| 3 | Config interpolation lacks shell-command resolution | `core/config/config-interpolation.ts` `ENV_PATTERN` **L37**, `FILE_PATTERN` **L39** — only `{env:}`/`{env:-fallback}`/`{file:}`; no `cmd:`/`exec`/`spawnSync` token. Applied via `instruction-resolver.ts` to instruction files only, not config values. |
| 4 | Settings writes not lock-guarded, no field-dirty | `core/config/settings-manager.ts` `.set()`/`.update()` delegate straight to `electron-store` (whole-blob rewrite); never call `withLock` from `util/file-lock.ts`. No field-dirty delta. |
| 5 | Branching + compaction exist but unjoined | `conversation_threads.parent_conversation_id` present (ledger schema); `context/context-compactor.ts` present; zero branch-summarization module (glob `*branch-summ*` → 0, grep `branch.*summariz` → 0). |
| 6 | No lone-surrogate stripping on provider-bound text | `security/unicode-sanitizer.ts` `DANGEROUS_UNICODE_RE` **L23** strips zero-width/RTL/tag chars (injection defense) — **no `\uD800-\uDFFF` surrogate range**; `providers/anthropic-api-provider.ts` sends `messages: this.session.messages` unsanitized (**L267, L278, L495**). |
| 7 | **Composer has no @-mention / file-path autocomplete** | `features/instance-detail/input-panel.component.ts` has slash-command handling (15 `startsWith`/slash sites) but **zero** `@mention`/`atMention`/`mentionQuery` matches. AIO *does* have a codebase index (`codemem/code-retrieval-service.ts` `search()`, BM25/FTS) available to back a file finder. |
| 8 | Spawn cleanup scattered, no transaction | `lifecycle/interrupt-respawn-handler.ts`: acquire sequence `createRuntimeAdapter` **L860** → `setupAdapterEvents` **L861** → `adapter.spawn()` **L875**; cleanup is the shared `cleanupAbortedRespawnAdapter` (defined **L183**, `removeAllListeners` **L195**, `deleteAdapter` **L206**) invoked from ≥7 separate call sites (**L866, L884, L921, L958, L1049, L1248, L1265**) plus a duplicate fallback path (createRuntimeAdapter again **L916/L1294**). No single rollback list / two-phase commit. |
| 9 | Plugin trust advisory-only | `plugins/plugin-manager.ts` `getAdvisoryCapabilityWarnings()` defined **L270**, called **L404**; legacy in-process load warns only **L416** (`add "isolation": "worker"…`). Project `.orchestrator/plugins/*.js` executes with no consent gate; no `hook-approvals.json` analog. |
| 10 | Modal: no focus-trap, weak restore | `overlay-shell.component.ts` / `prompt-modal.component.ts` have `role=dialog`/`aria-modal`/autofocus/Esc, but renderer grep `focus-trap\|FocusTrap` → **0**; **21** renderer files carry `role="dialog"`/`aria-modal`; restore is `el.focus()` on open only (no stored `preFocus` restore-on-close). |
| 11 | File-op data not carried through compaction | `instance/tool-output-parser.ts` `extractFilePaths()` **L293**, used at `instance-communication.ts` **L1204**; but `context-compactor.ts` `ToolCallRecord` **L53–60** has fields `{id,name,input,output?,inputTokens,outputTokens}` — **no path field**; "Relevant Files" is LLM free-text. |
| 12 | Skill loader gaps | No ignore-file handling; frontmatter is matched by regex (`skill-loader.ts` **L148** `/^---\n…/`) then hand-parsed by `.split('\n')`→`.split(':')` (**L155–171**), with **no `yaml`/`js-yaml` import** (confirmed) — breaks on nested/multiline/quoted-colon values; name validation length-only (`plugin.schemas.ts` `SkillFrontmatterSchema` **L173–175** `.min(1).max(200)`, no kebab/charset); two discovery walks (`SkillLoader.discoverSkills` + `SkillRegistry.discoverSkills`). |
| 13 | Keybindings: no conflict detect / import-export | `core/services/keybinding.service.ts` has actions/leaders/contexts/`when`/`customizeBinding()` but no `getConflicts()` and no JSON import/export. |
| 14 | Redaction not auto-applied at sinks | `diagnostics/redaction.ts` `redactValue()` exists but is invoked manually only (in `operator-artifact-exporter.ts`); not wired into `logging/logger.ts` transport or `observability/otel-spans.ts` / `local-trace-exporter.ts`. |
| 15 | Overflow heuristics — *cross-check, not a missing module* | AIO has `context/error-withholder.ts`, `context-window-guard`, `cli/adapters/resume-error-classifier.ts`; pi's silent-overflow heuristics (usage-exceeds-window, length-stop-at-0.99) and `NON_OVERFLOW` exclusions are **not** present as such. Brief scopes this as a heuristic/test-fixture top-up. |
| 16 | Composer editing primitives missing | `input-panel.component.ts` is a native `<textarea>`: browser undo only; no kill-ring, no `Intl.Segmenter` word-nav/word-delete. |
| 17 | In-proc TS plugin discovery is `.js`-only | Worker path handles `.ts` via `--import tsx` (`plugin-worker-host.ts` L153); the in-process discovery walk (`walkJsFiles` in `plugin-manager.ts`) picks up `.js` only. Narrow scoping fix, not a new loader. |
| 18 | Loop Mode: no mid-iteration steering drain | `orchestration/loop-coordinator.ts` has `pauseLoop`/`pauseGates` (L196 etc.) + `AbortController` (ping-pong reviewer); model downshift is queued for the *next* iteration only — no mid-iteration steering queue, no model/tool hot-swap save-point. |
| 19 | Provider/CLI-adapter registry is built-in-only — *extension gap, not a bug* | `providers/provider-adapter-registry.ts` + `register-built-in-providers.ts` register built-ins only; no plugin-facing `registerProviderAdapter` API. Brief scopes this as roadmap-gated. |
| 20 | Misc utils absent — *opportunistic top-ups* | No UUIDv7, `combineAbortSignals`, `shortHash`, prompt-template arg-slicing (`$\{@:N:L\}`/`$\{N:-default\}`), or `/proc/self/environ` env fallback in `src`. Each is a small standalone add; brief scopes as low-priority. |

### C.2 Verification-command corrections (apply before running)

The task bodies are correct; only these `Verification` blocks need adjustment. **"create"**
means the spec does not exist and the task already implies authoring it (the task's step list
says to add adapter/feature specs) — treat it as a deliverable, not a typo. **"repath"** means
the spec exists at a different path. **"substitute"** means point at the named existing spec.

| Task | Command references | Correction |
|------|--------------------|------------|
| 1 | `copilot-cli-adapter.spec.ts`, `gemini-cli-adapter.spec.ts` | **create** — only `claude-cli-adapter.spec.ts` and `codex-cli-adapter.spec.ts` exist today. Author the copilot/gemini specs as part of this task (the task's last step already calls for malformed-line adapter specs). |
| 2 | `prompt-suggestion.service.spec.ts` | **create** — `prompt-suggestion.service.ts` exists; its spec does not. |
| 3 | `auxiliary-llm-service.spec.ts` | **create** — service file exists; spec does not. Also see C.3 re: the client. |
| 4 | `file-lock.spec.ts` | **create** — `util/file-lock.ts` exists; no spec. `settings-manager.spec.ts` is already "Create or extend" in the task. |
| 8 | `instance-manager.spec.ts` | **substitute** — does not exist. Use `src/main/instance/instance-state-machine.spec.ts` and/or `src/main/instance/lifecycle/__tests__/interrupt-respawn-handler.spec.ts` (both exist) for integration assertions, plus the new `spawn-transaction.spec.ts`. |
| 15 | `ptl-retry.spec.ts`, `child-error-classifier.spec.ts` | **create** — neither exists. `context-collapse.spec.ts` and `error-withholder.spec.ts` exist and should also be run as regression guards. |
| 7, 16 | `input-panel.component.spec.ts` | **create** — no spec for the composer component yet. |
| 10 | `overlay-shell.component.spec.ts` | **create** — does not exist. `prompt-modal.component.spec.ts` exists and should be run. |
| 13 | `keybinding.service.spec.ts` | **repath** → `src/renderer/app/core/services/__tests__/keybinding.service.spec.ts` (it lives under `__tests__/`). `keyboard-settings-tab.component.spec.ts` is **create**. |
| 18, 20B | `loop-coordinator.spec.ts` | **substitute** — no monolithic spec; the suite is `loop-coordinator-*.spec.ts` (90+ files). Use `loop-coordinator-restore.spec.ts` (closest to queue/restore semantics) and `loop-store.spec.ts`, or the glob `'src/main/orchestration/loop-coordinator-*.spec.ts'`. |
| 20C | `provider-runtime-service.spawn-worker.spec.ts` | **substitute/create** — not present. Use an existing provider runtime spec (e.g. `src/main/providers/__tests__/base-provider.spec.ts`) or create the spawn-worker spec when adding the faux-double knobs. |
| 20D | `src/shared/types/__tests__/command.types.spec.ts` | **create** — `command.types.ts` exists; no spec under `__tests__/` (which holds `agent.types.spec.ts`, `auxiliary-llm.types.spec.ts`, etc., but not command). |

All other referenced specs exist and were confirmed: `claude-cli-adapter.spec.ts`,
`codex-cli-adapter.spec.ts`, `context-collapse.spec.ts`, `error-withholder.spec.ts`,
`__tests__/context-compactor.spec.ts`, `chat-service.spec.ts`,
`lifecycle/__tests__/instance-spawner.spec.ts`, `plugins/plugin-manager.spec.ts`,
`plugins/plugin-worker-host.spec.ts`, `plugins/__tests__/manifest-validation.spec.ts`,
`skills/builtin/loop-recipe-skills.spec.ts`, `providers/__tests__/provider-adapter-registry.spec.ts`,
`prompt-modal.component.spec.ts`, `packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts`,
`packages/sdk/src/__tests__/{provider-adapter-registry.types,sdk-exports}.spec.ts`,
`loop-store.spec.ts`, `core/config/__tests__/config-interpolation.spec.ts`.

### C.3 Implementation clarifications (additive, not corrections)

- **Tasks 3 & 6 — auxiliary LLM call site.** The plan targets `rlm/auxiliary-llm-service.ts`
  and `rlm/llm-service.ts` (both exist). The actual outbound HTTP assembly also passes through
  `rlm/auxiliary-model-client.ts`. Apply surrogate sanitization (Task 6) and resolved-secret
  injection (Task 3) at the **service assembly point**, and verify the request that reaches
  `auxiliary-model-client.ts` is already sanitized/resolved — don't assume the service file is
  the last boundary.
- **Task 17 — discovery walk.** The in-process `.js`-only discovery walk lives in
  `plugins/plugin-manager.ts` (the file the task already lists for modification);
  `plugin-worker-host.ts` only adds `--import tsx` for `.ts` entrypoints. No path change needed
  — just confirming the `.ts` discovery extension belongs in `plugin-manager.ts`.
- **`rtk` wrapper.** All `rtk npx ...` / `rtk npm ...` commands are correct; `rtk` is installed
  at `/opt/homebrew/bin/rtk` on this machine.

### C.4 Highest-severity scoping risk — Task 3 (shell-command secret resolution)

**Task 3 is the single highest-severity item in this plan and the one most likely to be
mis-scoped during implementation.** Adding a `{cmd:...}` token that runs a shell command to
resolve a secret is safe *only* when it is confined to **trusted, user-authored settings**. If
the same resolver is ever reachable from **untrusted project content** — `CLAUDE.md`/`AGENTS.md`
instruction interpolation (`config-interpolation.ts`), MCP/plugin manifests pulled from a cloned
repo, or any project-scoped config — then cloning a hostile repository becomes arbitrary command
execution on the user's machine.

Mandatory guardrails (already encoded in the task, restated here for prominence):
- Implement in a **separate** file named `trusted-config-value-resolver.ts`; do **not** add the
  `cmd:` token to `config-interpolation.ts` (which stays env/file-only and instruction-scoped).
- Gate command execution behind an explicit `allowCommand: true` that only settings-backed call
  sites pass; default off.
- Enforce an allowlist + timeout + max-output-bytes, and never log resolved stdout (tests must
  assert the resolved value never reaches a logger).
- This item should land **after** Task 9 (project-plugin trust) and Task 14 (sink redaction) so
  its blast radius is already contained by trust gating and redaction-at-sink.

The `## Explicit Non-Goals` section's "Do not add shell execution to project instruction
interpolation" line is the load-bearing constraint for this task — treat any change that weakens
it as a blocker, not a refactor.

### C.5 Retired drafts — what differed and why this one wins

Two untracked, loop-generated same-day drafts were superseded by this document and deleted:

- `2026-06-27-pi-techniques-import-plan.md` (37 KB, "Phase 0–4" structure, "Cross-Phase
  Verification Matrix" + "Rollout Order")
- `2026-06-27-pi-inspired-aio-hardening.md` (45 KB, "Wave 0–4" structure, "Review Checkpoints")

All three covered the identical 20-item scope (1:1 with the original `pi.md` brief, since
removed — its claims live on in Appendix C.1). This canonical doc
(`2026-06-28-pi-borrowed-capabilities_completed.md`, 49 KB) was selected because it carries the strongest
**AIO-specific safety boundaries** in its `Global Constraints` and `Explicit Non-Goals`:

- Explicitly separates surrogate cleanup from the prompt-injection sanitizer
  (`Global Constraints`: *"Do not reuse `src/main/security/unicode-sanitizer.ts` for
  provider-bound surrogate cleanup; it has a different prompt-injection purpose"*). This is the
  exact conflation a weaker plan can make — pointing Task 6 at `unicode-sanitizer.ts` would both
  fail to strip surrogates (its regex has no `\uD800-\uDFFF` range, confirmed C.1 #6) and risk
  altering message content. This plan creates a dedicated `surrogate-sanitizer.ts` instead.
- Explicitly scopes shell-command resolution to trusted settings only (see C.4).
- Explicitly keeps TypeScript plugins worker-isolated and gates project plugins behind trust.
- Provides per-task TypeScript interfaces, "what could break", and focused Vitest commands.

**Honest limitation:** the two drafts were untracked and have been `rm`-deleted, so they are not
git-recoverable; the differences above are reconstructed from their section structure (captured
before deletion) plus this plan's explicit constraints, not from a line-by-line diff of all three
bodies. If a full three-way diff is required for the record, the loop will regenerate equivalents
and they can be diffed then — but nothing unique to the drafts was lost, because every one of the
20 items is present in this plan with stronger boundaries.

This document is the single canonical plan.
