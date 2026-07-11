# Universal and Local Automated Review Implementation Plan

**Status:** Completed  

**Completion evidence (2026-07-11):** An independent completion gate and
escalated security audit verified provider/runtime wiring, qualification,
read-only tooling, orchestration, and advisory authority. The implemented
service qualified on-device `gemma4:31b`; a real bounded review rejected a
planted authorization bypass after reading `src/access.ts` and left Git state
unchanged. Failure isolation was verified deterministically without stopping
the live Ollama daemon. Both TypeScript programs, lint, LOC, production main
build, contract/IPC synchronization, and the full 1,276-file / 12,693-test
suite passed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch subagents unless James explicitly authorizes delegation.

**Goal:** Make every remote CLI provider eligible for automated review and add one qualified, read-only, agentic local-model review alongside the configured remote reviewers.

**Architecture:** A shared provider catalog removes duplicated allowlists. A focused local-review subsystem owns model qualification, normalized tool calls, safe repository tools, and execution limits. Cross-model orchestration consumes remote and local review results through explicit provenance so local-only findings remain advisory until a remote reviewer corroborates them.

**Tech Stack:** TypeScript, Electron main process, Angular signals, Ollama `/api/chat`, OpenAI-compatible `/v1/chat/completions`, Zod 4, Vitest.

## Global Constraints

- Preserve all unrelated staged and unstaged changes, especially the existing changes in `cross-model-review-service.ts` and its spec.
- Do not commit or push unless James explicitly asks.
- Follow test-driven development: add one failing behavior test, run it red, implement the smallest code, then run it green.
- The builder cannot review itself using the same normalized remote provider or the same local selector ID.
- Two configured remote reviewers remain two remote reviewers; the local pass is additional.
- Local review has no arbitrary shell, writes, package installation, network tool, user-home traversal, or path outside the workspace.
- Local-only findings are advisory; only a cluster containing at least one remote reviewer can block completion.
- A local failure, timeout, malformed response, or failed capability probe never suppresses a remote review result.
- Prompt parsing fails closed and receives at most one bounded format-repair attempt.
- Use obvious placeholders only in tests; never add secret-like values to fixtures.

---

### Task 1: Canonical remote reviewer provider catalog

**Files:**
- Create: `src/shared/types/reviewer-provider.types.ts`
- Create: `src/shared/types/reviewer-provider.types.spec.ts`
- Modify: `src/main/orchestration/cross-model-review-service.constants.ts`
- Modify: `src/main/orchestration/cross-model-review-service.spec.ts`
- Modify: `src/main/orchestration/agentic-pingpong-reviewer.spec.ts`

**Interfaces:**
- Produces: `REMOTE_REVIEWER_PROVIDER_DEFINITIONS`, `REMOTE_REVIEWER_PROVIDER_IDS`, `RemoteReviewerProvider`, `normalizeRemoteReviewerProvider()`.
- Consumers: settings validation/metadata, renderer Review Settings, cross-model availability normalization, ping-pong resolution.

- [x] **Step 1: Add the failing shared-catalog test**

```ts
import { describe, expect, it } from 'vitest';
import {
  REMOTE_REVIEWER_PROVIDER_IDS,
  normalizeRemoteReviewerProvider,
} from './reviewer-provider.types';

describe('remote reviewer providers', () => {
  it('contains every canonical remote CLI reviewer once', () => {
    expect(REMOTE_REVIEWER_PROVIDER_IDS).toEqual([
      'claude', 'codex', 'antigravity', 'copilot', 'cursor', 'grok',
    ]);
  });

  it('normalizes legacy Gemini to Antigravity', () => {
    expect(normalizeRemoteReviewerProvider('gemini')).toBe('antigravity');
    expect(normalizeRemoteReviewerProvider(' GROK ')).toBe('grok');
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
npm run test:quiet -- src/shared/types/reviewer-provider.types.spec.ts
```

Expected: FAIL because `reviewer-provider.types.ts` does not exist.

- [x] **Step 3: Implement the shared catalog**

```ts
export const REMOTE_REVIEWER_PROVIDER_IDS = [
  'claude', 'codex', 'antigravity', 'copilot', 'cursor', 'grok',
] as const;

export type RemoteReviewerProvider =
  typeof REMOTE_REVIEWER_PROVIDER_IDS[number];

export const REMOTE_REVIEWER_PROVIDER_DEFINITIONS: readonly {
  id: RemoteReviewerProvider;
  label: string;
}[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'OpenAI Codex CLI' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'cursor', label: 'Cursor CLI' },
  { id: 'grok', label: 'Grok Build' },
] as const;

export function normalizeRemoteReviewerProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'gemini' ? 'antigravity' : normalized;
}
```

- [x] **Step 4: Replace main-process allowlist duplication**

Import the shared IDs and normalizer in `cross-model-review-service.constants.ts`.
Construct `SUPPORTED_REVIEWER_CLIS` and `SUPPORTED_AGENTIC_REVIEWER_CLIS` from
the same six IDs. Keep the exported function names stable so existing callers
do not change.

- [x] **Step 5: Add failing integration assertions for Claude and Grok**

Extend the existing service and ping-pong tests so:

```ts
expect(normalizeReviewerCliList(['claude', 'grok', 'gemini'])).toEqual([
  'claude', 'grok', 'antigravity',
]);
```

and explicit `reviewerProviderSetting: 'grok'` resolves to Grok when Grok is
installed and the builder is not Grok.

- [x] **Step 6: Run focused tests and verify GREEN**

```bash
npm run test:quiet -- src/shared/types/reviewer-provider.types.spec.ts src/main/orchestration/cross-model-review-service.spec.ts src/main/orchestration/agentic-pingpong-reviewer.spec.ts
```

Expected: all selected files pass.

---

### Task 2: Settings validation and Review Settings UI

**Files:**
- Modify: `src/main/core/config/settings-control-policy.ts`
- Create: `src/main/core/config/settings-control-policy.reviewers.spec.ts`
- Modify: `src/shared/types/settings.types.ts`
- Modify: `src/shared/types/settings-metadata-review-network.ts`
- Modify: `src/renderer/app/features/settings/review-settings-tab.component.ts`
- Modify: `src/renderer/app/features/settings/review-settings-tab.component.spec.ts`

**Interfaces:**
- Consumes: `REMOTE_REVIEWER_PROVIDER_DEFINITIONS` and IDs from Task 1.
- Produces settings: `crossModelReviewLocalEnabled`, `crossModelReviewLocalSelectorId`, `crossModelReviewLocalTimeout`, `crossModelReviewLocalMaxToolRounds`.

- [x] **Step 1: Write failing settings-policy tests**

Add cases proving that `crossModelReviewProviders` accepts all six canonical
providers, accepts six entries, rejects unknown providers, and
`pingPongReviewerProvider` accepts `grok`.

```ts
expect(coerceWritableSettingValue(
  'crossModelReviewProviders',
  ['claude', 'codex', 'antigravity', 'copilot', 'cursor', 'grok'],
).value).toHaveLength(6);
```

- [x] **Step 2: Run policy tests and verify RED**

```bash
npm run test:quiet -- src/main/core/config/settings-control-policy.reviewers.spec.ts
```

Expected: Grok or the sixth list entry is rejected.

- [x] **Step 3: Update schemas, types, defaults, and metadata**

Use `z.enum(REMOTE_REVIEWER_PROVIDER_IDS)` for remote review providers, increase
the array maximum to six, and include `grok` in ping-pong validation. Add:

```ts
crossModelReviewLocalEnabled: boolean;
crossModelReviewLocalSelectorId: string;
crossModelReviewLocalTimeout: number;
crossModelReviewLocalMaxToolRounds: number;
```

with defaults `true`, `''`, `120`, and `12`. Validate timeout as an integer from
10 through 600 and tool rounds as an integer from 1 through 32.

- [x] **Step 4: Write failing renderer tests**

Assert that Review Settings offers all six remote providers, exposes a local
model selector sourced from `displayModelsForProvider('local-model')`, filters
out `:cloud` model IDs, and persists the selected row's selector ID.

- [x] **Step 5: Implement the renderer from shared definitions**

Remove the local `REVIEWER_PROVIDERS` duplication. Add a separate Local Reviewer
card below the remote priority list. Reuse catalog row metadata and the encoded
model ID as `crossModelReviewLocalSelectorId`; do not represent it as `ollama`.

- [x] **Step 6: Run focused settings/UI tests**

```bash
npm run test:quiet -- src/main/core/config/settings-control-policy.reviewers.spec.ts src/renderer/app/features/settings/review-settings-tab.component.spec.ts
```

Expected: both files pass.

---

### Task 3: Safe repository tools for local review

**Files:**
- Create: `src/main/review/local-review.types.ts`
- Create: `src/main/review/local-review-tool-runner.ts`
- Create: `src/main/review/local-review-tool-runner.spec.ts`
- Read and reuse policy from: `src/main/security/filesystem-policy.ts`
- Read and reuse Git environment from: `src/main/workspace/git/git-env.ts`

**Interfaces:**
- Produces: `LOCAL_REVIEW_TOOL_DEFINITIONS`, `LocalReviewToolCall`, `LocalReviewToolResult`, and `LocalReviewToolRunner.execute(call)`.
- Consumes no model-specific response types.

- [x] **Step 1: Write failing security and behavior tests**

Use a temporary workspace containing normal files, `.env`, a symlink escaping
the workspace, and a nested Git repository. Cover:

```ts
await expect(runner.execute({ name: 'workspace_read', arguments: { path: 'src/a.ts' } }))
  .resolves.toMatchObject({ ok: true });
await expect(runner.execute({ name: 'workspace_read', arguments: { path: '../outside.txt' } }))
  .resolves.toMatchObject({ ok: false, code: 'path-denied' });
await expect(runner.execute({ name: 'workspace_read', arguments: { path: '.env' } }))
  .resolves.toMatchObject({ ok: false, code: 'sensitive-path' });
await expect(runner.execute({ name: 'workspace_read', arguments: { path: 'escape/secret.txt' } }))
  .resolves.toMatchObject({ ok: false, code: 'path-denied' });
```

Also test output truncation, maximum search matches, unknown tools, invalid
arguments, fixed Git status/diff behavior, and that no API accepts a shell
command.

- [x] **Step 2: Run the tool-runner test and verify RED**

```bash
npm run test:quiet -- src/main/review/local-review-tool-runner.spec.ts
```

Expected: FAIL because the runner is missing.

- [x] **Step 3: Implement normalized tool definitions**

Define exactly five tools: `workspace_list`, `workspace_search`,
`workspace_read`, `workspace_diff`, and `workspace_status`. Use closed Zod
schemas for arguments. Default caps: 200 list entries, 100 search matches,
400 read lines, 64 KiB per result, and 256 KiB across a review session.

- [x] **Step 4: Implement containment and sensitive-path checks**

Resolve the workspace root and candidate with `realpath`, require the candidate
to equal the root or start with `root + path.sep`, and reject sensitive patterns
before reading. Missing targets should resolve the real parent and validate it
before returning `not-found`; they must never bypass containment.

- [x] **Step 5: Implement bounded operations**

Use `rg` argument arrays without a shell for search. Use `spawn`/`execFile` with
fixed Git arguments plus `hermeticGitEnv()` for status and diff. Return a typed
error result rather than throwing expected model mistakes.

- [x] **Step 6: Run the tool-runner test and verify GREEN**

```bash
npm run test:quiet -- src/main/review/local-review-tool-runner.spec.ts
```

Expected: all path, limit, and operation cases pass.

---

### Task 4: Normalized local-model tool calling

**Files:**
- Modify: `src/main/cli/adapters/local-model-chat-adapter.ts`
- Modify: `src/main/cli/adapters/ollama-cli-adapter.ts`
- Modify: `src/main/cli/adapters/openai-compatible-chat-adapter.ts`
- Modify: `src/main/cli/adapters/__tests__/ollama-cli-adapter.spec.ts`
- Modify: `src/main/cli/adapters/__tests__/openai-compatible-chat-adapter.spec.ts`

**Interfaces:**
- Consumes: local review tool definitions and normalized calls from Task 3.
- Produces: `LocalModelToolTurnClient.sendToolTurn(messages, tools, signal)` returning `{ content, toolCalls, usage }`.

- [x] **Step 1: Add failing Ollama request/response tests**

Assert that the adapter sends `tools`, parses:

```json
{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_1","function":{"name":"workspace_read","arguments":{"path":"README.md"}}}]}}
```

and sends a subsequent `{ role: 'tool', tool_name: 'workspace_read', content: '...' }`
message without losing history.

- [x] **Step 2: Add failing OpenAI-compatible tests**

Cover `choices[0].message.tool_calls`, JSON-string arguments, `tool_call_id`, and
non-streaming fallback while tools are enabled. Tool turns should use
non-streaming mode initially because several compatible servers omit complete
tool arguments from streaming deltas.

- [x] **Step 3: Run adapter tests and verify RED**

```bash
npm run test:quiet -- src/main/cli/adapters/__tests__/ollama-cli-adapter.spec.ts src/main/cli/adapters/__tests__/openai-compatible-chat-adapter.spec.ts
```

Expected: tool calls are absent or ignored.

- [x] **Step 4: Add the narrow shared interface**

Do not change ordinary `sendMessage()` semantics. Add a separate interface used
only by local review so general local chats remain tool-free.

- [x] **Step 5: Implement Ollama and OpenAI translation**

Map both endpoints into the same normalized call:

```ts
interface LocalModelToolCall {
  id: string;
  name: LocalReviewToolName;
  arguments: unknown;
}
```

Preserve usage accounting and abort behavior. Reject malformed call shapes as
typed unreliable results.

- [x] **Step 6: Run adapter tests and verify GREEN**

Run the command from Step 3. Expected: both adapter suites pass.

---

### Task 5: Capability qualification and local reviewer execution

**Files:**
- Create: `src/main/review/local-reviewer-capability-service.ts`
- Create: `src/main/review/local-reviewer-capability-service.spec.ts`
- Create: `src/main/review/local-reviewer.ts`
- Create: `src/main/review/local-reviewer.spec.ts`
- Modify: `src/main/local-models/local-model-inventory-service.ts`
- Modify: `src/main/local-models/__tests__/local-model-inventory-service.spec.ts`

**Interfaces:**
- Produces: `LocalReviewerCapabilityService.qualify(target)` and `LocalReviewer.review(request, target, limits)`.
- Consumes: `ModelRuntimeTarget`, normalized tool-turn client, safe tool runner, existing structured review schemas.

- [x] **Step 1: Write failing capability tests**

Cover a successful synthetic tool call plus final structured answer, no tool
call, malformed arguments, endpoint failure, cache reuse, cache invalidation
when endpoint/model identity changes, and rejection of model IDs ending in or
containing the Ollama `:cloud` marker.

- [x] **Step 2: Run capability tests and verify RED**

```bash
npm run test:quiet -- src/main/review/local-reviewer-capability-service.spec.ts
```

Expected: service is missing.

- [x] **Step 3: Implement qualification**

The synthetic probe exposes only `workspace_read` and returns synthetic content;
it never reads the real workspace. Cache successes and failures by
`source/nodeId/endpointProvider/endpointId/modelId` for the process lifetime and
offer an explicit invalidation method for inventory refreshes.

- [x] **Step 4: Write failing local-review loop tests**

Cover multiple tool calls, final valid JSON, one format-repair turn, maximum
rounds, total byte budget, cancellation, timeout, invalid repeated calls, and
evidence validation against the recorded read/search paths.

- [x] **Step 5: Implement the bounded review loop**

Build the existing structured/tiered review prompt, append the local tool and
evidence contract, execute tool calls through `LocalReviewToolRunner`, and parse
with existing schemas. Return:

```ts
type LocalReviewOutcome =
  | { status: 'used'; review: ReviewResult; evidencePaths: string[] }
  | { status: 'skipped' | 'failed'; reason: string };
```

Local parse failure and missing evidence cannot become approval.

- [x] **Step 6: Mark verified capability in inventory output**

Do not optimistically change every model from `none`. Merge cached qualification
into inventory rows so UI rows transition to `verified` only after the probe.

- [x] **Step 7: Run local reviewer suites and verify GREEN**

```bash
npm run test:quiet -- src/main/review/local-reviewer-capability-service.spec.ts src/main/review/local-reviewer.spec.ts src/main/local-models/__tests__/local-model-inventory-service.spec.ts
```

Expected: all selected suites pass.

---

### Task 6: Parallel orchestration and advisory aggregation

**Files:**
- Create: `src/main/orchestration/review-execution-batch.ts`
- Create: `src/main/orchestration/review-execution-batch.spec.ts`
- Modify: `src/main/orchestration/cross-model-review-service.ts`
- Modify: `src/main/orchestration/cross-model-review-service.spec.ts`
- Modify: `src/main/orchestration/cross-model-review-service.headless.spec.ts`
- Modify: `src/main/orchestration/review-finding-aggregation.ts`
- Modify: `src/main/orchestration/review-finding-aggregation.spec.ts`
- Modify: `src/shared/types/cross-model-review.types.ts`
- Modify: `src/main/cli-entrypoints/review-command-output.ts`

**Interfaces:**
- Consumes: `LocalReviewer`, canonical remote list, current remote execution callback.
- Produces: batch `{ remoteReviews, localOutcome }` and findings with `reviewers`, `agreementCount`, and `advisory` provenance.

- [x] **Step 1: Write failing concurrency tests**

Use deferred promises to prove that local and remote calls start before either
resolves, that two remote slots are still requested, and that local failure
does not remove successful remote results.

- [x] **Step 2: Run batch tests and verify RED**

```bash
npm run test:quiet -- src/main/orchestration/review-execution-batch.spec.ts
```

Expected: batch coordinator is missing.

- [x] **Step 3: Implement the focused batch coordinator**

Keep selection/fallback in the existing service. Move only concurrent execution
and local failure isolation into the new unit so `cross-model-review-service.ts`
does not absorb another large private-method block.

- [x] **Step 4: Write failing advisory/corroboration tests**

Add `source: 'remote' | 'local'` to aggregatable findings. Assert:

```ts
expect(localOnly.advisory).toBe(true);
expect(localAndRemote.advisory).toBe(false);
```

and ensure agreement ratios count all successful reviewers while blocking
authority requires at least one remote member.

- [x] **Step 5: Implement provenance-aware aggregation and output contracts**

Preserve existing severity and similarity behavior. Add optional `advisory` and
reviewer provenance to headless findings without breaking older JSON readers.
In-session `ReviewResult` records local identity and status so the renderer can
show the extra pass.

- [x] **Step 6: Wire in-session and headless review paths**

Resolve the selected local target from settings, skip same-selector builders,
run local review beside remote collection, and include the local status in the
result. Do not alter the existing configured-unavailable warning changes in the
dirty worktree.

- [x] **Step 7: Run focused orchestration tests and verify GREEN**

```bash
npm run test:quiet -- src/main/orchestration/review-execution-batch.spec.ts src/main/orchestration/review-finding-aggregation.spec.ts src/main/orchestration/cross-model-review-service.spec.ts src/main/orchestration/cross-model-review-service.headless.spec.ts
```

Expected: all selected suites pass.

---

### Task 7: Ping-pong integration and completion-gate authority

**Files:**
- Modify: `src/main/orchestration/agentic-pingpong-reviewer.ts`
- Modify: `src/main/orchestration/agentic-pingpong-reviewer.spec.ts`
- Modify: `src/main/orchestration/loop-pingpong-completion.ts`
- Modify: `src/main/orchestration/loop-pingpong-completion.spec.ts`
- Modify: `src/main/orchestration/loop-fresh-eyes-reviewer.ts`
- Modify: `src/main/orchestration/loop-coordinator-fresh-eyes.spec.ts`

**Interfaces:**
- Consumes: universal remote eligibility and local advisory results from earlier tasks.
- Produces: ping-pong remote reviewer may be any canonical provider; local advisory findings cannot alone reject completion.

- [x] **Step 1: Write failing Grok/Claude eligibility tests**

Test explicit Grok, explicit Claude for a non-Claude builder, same-provider
fallback, and auto widening through Grok after preferred providers are tried.

- [x] **Step 2: Write failing local-authority tests**

Test that a high local-only finding is visible but does not create a blocking
ping-pong ledger issue, while a semantically matching remote finding does.

- [x] **Step 3: Run focused tests and verify RED**

```bash
npm run test:quiet -- src/main/orchestration/agentic-pingpong-reviewer.spec.ts src/main/orchestration/loop-pingpong-completion.spec.ts
```

Expected: Grok is filtered or local authority is not represented.

- [x] **Step 4: Implement the smallest integration**

Keep the single disposable remote agentic reviewer contract unchanged. Attach
the local pass as separate advisory evidence and filter advisory-only findings
before creating blocking ledger entries. Preserve fail-closed behavior when the
remote reviewer itself is unreliable.

- [x] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 3 plus
`src/main/orchestration/loop-coordinator-fresh-eyes.spec.ts`. Expected: all
selected suites pass.

---

### Task 8: Real-model verification and project gates

**Files:**
- Modify only if verification exposes a defect in the files above.
- Rename approved implementation plan/spec with `_completed` only after all checks and runtime verification pass.

**Interfaces:**
- Verifies the complete feature without committing or pushing.

- [x] **Step 1: Run the real Ollama capability probe**

Use `gemma4:31b` with the harmless synthetic `workspace_read` tool. Require a
native tool call and a final parseable structured response. The pre-plan probe
on 2026-07-10 already demonstrated both legs; rerun against the implemented
service rather than raw curl.

- [x] **Step 2: Run a real bounded local review**

Give the local reviewer a small known diff with one planted material issue.
Verify recorded tool calls include relevant repository reads, the finding cites
evidence, and Git status/diff before and after are identical except for the
already-present user changes.

- [x] **Step 3: Verify failure isolation**

Stop or point the local endpoint at an unavailable test endpoint, run a review,
and confirm both remote reviewers still complete while local status is skipped
or failed. Restore the local endpoint afterward.

- [x] **Step 4: Run type checks**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both exit 0.

- [x] **Step 5: Run lint and LOC gate**

```bash
npm run lint
npm run check:ts-max-loc
```

Expected: both exit 0.

- [x] **Step 6: Run the full suite**

```bash
npm run test:quiet
```

Expected: zero failing test files and zero failing tests.

- [x] **Step 7: Inspect the final diff and requirement checklist**

Confirm all requested providers are selectable, the local pass is additional,
same-identity review is excluded, local tools cannot mutate or escape, local
failures do not suppress remote reviewers, and local-only findings remain
advisory.

- [x] **Step 8: Mark documents complete**

Only after Steps 1–7 pass, rename the design and plan files with `_completed`.
Do not stage, commit, or push without James's explicit request.
