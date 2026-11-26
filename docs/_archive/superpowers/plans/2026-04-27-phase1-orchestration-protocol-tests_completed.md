# Phase 1 — Stabilize Orchestration Operating Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock the parent operating contract, command parsing, validation, and renderer command-stripping behind tests so future prompt or protocol drift fails CI.

**Architecture:** Pure characterization-test slice. We add focused vitest specs that pin the current behavior of `generateOrchestrationPrompt`, `generateChildPrompt`, `parseOrchestratorCommands`, `isValidCommand` (via `parseOrchestratorCommands`'s validation gate), `stripOrchestrationMarkers`, and the renderer's `MarkdownService.render()`/`renderSync()`. No production code changes are introduced.

**Tech Stack:** TypeScript 5.9, Vitest 1.x, Angular 21 (zoneless), Electron 40. Tests live next to source under `src/main/**/*.spec.ts` and `src/renderer/**/*.spec.ts`. They run via `npm run test` (vitest).

**Source spec:** `unified.md` §"Phase 1 - Stabilize The Orchestration Operating Contract".

---

## Commit Policy (read before any `git commit` step)

The repo's `AGENTS.md` says: **"NEVER commit or push unless the user explicitly asks you to."** Each task below ends with a `git commit` block. Treat those as **conditional**:

- If the user has **explicitly authorized commits** for this work, run them as written.
- If the user has **not** explicitly authorized commits, run the verification (test + typecheck + lint) but **do not** commit. Pause and ask the user how they want changes integrated.

Additionally:

- **Never use `git add -A`** in this plan — the worktree may contain unrelated user work. Only stage the files explicitly named by the current task.
- If a task did not modify the file it lists in `git add`, drop it from the `git add` line for that step.

The commit message strings in each task are suggestions — keep them or adapt to the project's commit-message convention.

---

## File Structure

We create three new test files. We do **not** modify any production code in this phase. Each test file is focused on one concern so it stays readable and any failure points at the exact contract that drifted.

| File | Responsibility | Action |
|------|----------------|--------|
| `src/main/orchestration/orchestration-protocol.spec.ts` | Prompt-content invariants (parent + child), parser round-trip, validator accept/reject coverage, marker-stripping tests. | **Create** |
| `src/main/orchestration/orchestration-handler.spec.ts` | Existing streaming-marker, user-action, consensus tests. **No edits — already covers its scope.** | _untouched_ |
| `src/renderer/app/core/services/markdown.service.spec.ts` | `MarkdownService.renderSync()` strips command and response blocks; preserves surrounding markdown. | **Create** |

The test helper layout inside `orchestration-protocol.spec.ts`:

```
describe('generateOrchestrationPrompt')          // Task 2
describe('generateChildPrompt')                   // Task 3
describe('parseOrchestratorCommands')             // Task 4
describe('isValidCommand (via parser)')           // Task 5
describe('stripOrchestrationMarkers')             // Task 6
describe('formatCommandResponse')                 // Task 6
```

---

## Test Helpers (introduced as each task needs them)

Helpers go at the top of `src/main/orchestration/orchestration-protocol.spec.ts`. **Imports and helpers are added incrementally per task** so every task ends with no unused imports — the project uses `no-unused-vars`/`no-unused-imports` lint rules and we want each commit to be lint-clean on its own.

The two reusable helpers (added in the tasks where they are first used):

```typescript
/** Wrap a JSON command in the documented marker block. Introduced in Task 4. */
function commandBlock(command: Record<string, unknown>): string {
  return [
    ORCHESTRATION_MARKER_START,
    JSON.stringify(command),
    ORCHESTRATION_MARKER_END,
  ].join('\n');
}

/** Helper for tests that only need the first parsed command. Introduced in Task 4. */
function parseFirst(input: string): OrchestratorCommand | undefined {
  return parseOrchestratorCommands(input)[0];
}
```

Each task's snippet shows the **delta** (new imports + new describe block). When you apply a task, merge new imports into the existing import block at the top of the file.

---

## Pre-Flight (read these before starting)

- `src/main/orchestration/orchestration-protocol.ts` (579 lines). Read it end-to-end. The exported surface you are testing: `ORCHESTRATION_MARKER_START`, `ORCHESTRATION_MARKER_END`, `generateOrchestrationPrompt`, `generateChildPrompt`, `parseOrchestratorCommands`, `stripOrchestrationMarkers`, `formatCommandResponse`. The internal `isValidCommand` is exercised through `parseOrchestratorCommands` (invalid commands are silently dropped).
- `src/main/orchestration/orchestration-handler.spec.ts` (213 lines). Look at `commandBlock(...)` (lines 25–31) — the helper signature you'll mirror.
- `src/renderer/app/core/services/markdown.service.ts:144-165` — the `stripOrchestrationCommands` regex and how `render()`/`renderSync()` (lines 201, 222) call it.
- `src/shared/types/child-result.types.ts` — defines `ReportResultCommand`, `GetChildSummaryCommand`, `GetChildArtifactsCommand`, `GetChildSectionCommand`. These are imported into the protocol's discriminated union.
- `vitest.config.ts` — confirms `src/**/*.spec.ts` is auto-picked up; no extra wiring needed.

---

## Task 1: Set up the new spec file scaffolding

**Files:**
- Create: `src/main/orchestration/orchestration-protocol.spec.ts`

- [ ] **Step 1: Create the new spec file with only the imports that this task uses, plus a single sanity test.**

Write the file with exactly this initial content (later tasks will append their own imports):

```typescript
import { describe, expect, it } from 'vitest';

import {
  ORCHESTRATION_MARKER_START,
  ORCHESTRATION_MARKER_END,
} from './orchestration-protocol';

describe('orchestration-protocol module', () => {
  it('exports the documented marker constants', () => {
    expect(ORCHESTRATION_MARKER_START).toBe(':::ORCHESTRATOR_COMMAND:::');
    expect(ORCHESTRATION_MARKER_END).toBe(':::END_COMMAND:::');
  });
});
```

- [ ] **Step 2: Run the new spec to confirm it discovers and passes.**

Run: `npx vitest run src/main/orchestration/orchestration-protocol.spec.ts --reporter=verbose`

Expected: 1 passing test (`exports the documented marker constants`). No TS errors. No unused imports.

- [ ] **Step 3: Lint the new file in isolation.**

Run: `npx eslint src/main/orchestration/orchestration-protocol.spec.ts`

Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit the scaffolding (only if commits are authorized; see Commit Policy above).**

```bash
git add src/main/orchestration/orchestration-protocol.spec.ts
git commit -m "test(orchestration): scaffold protocol spec file"
```

---

## Task 2: Pin parent prompt invariants in `generateOrchestrationPrompt`

**Files:**
- Modify: `src/main/orchestration/orchestration-protocol.spec.ts`

The parent prompt is the operating contract. These tests pin every load-bearing rule from `unified.md` §Phase 1 so a refactor that drops them fails CI. Each assertion checks for a stable substring chosen from the current prompt body — see `src/main/orchestration/orchestration-protocol.ts:199-319`.

- [ ] **Step 1: Extend the existing import block.**

Edit the import block at the top of `src/main/orchestration/orchestration-protocol.spec.ts` so it reads:

```typescript
import {
  ORCHESTRATION_MARKER_START,
  ORCHESTRATION_MARKER_END,
  generateOrchestrationPrompt,
} from './orchestration-protocol';
```

- [ ] **Step 2: Add the `generateOrchestrationPrompt` describe block.**

Insert after the existing top-level `describe('orchestration-protocol module', ...)` block:

```typescript
describe('generateOrchestrationPrompt', () => {
  const instanceId = 'inst_test_42';
  const prompt = generateOrchestrationPrompt(instanceId, 'claude-sonnet-4');

  it('interpolates the instance id into the prompt body', () => {
    expect(prompt).toContain(`Instance ID: ${instanceId}`);
  });

  it('interpolates the current model into the identity preamble when supplied', () => {
    expect(prompt).toContain('You are currently running as **claude-sonnet-4**');
  });

  it('omits the identity preamble when no model is supplied', () => {
    const bare = generateOrchestrationPrompt(instanceId);
    expect(bare).not.toContain('You are currently running as');
    expect(bare).toContain(`Instance ID: ${instanceId}`);
  });

  describe('delegation rules', () => {
    it('tells the parent to spawn children only for parallel or specialized work', () => {
      expect(prompt).toMatch(/Spawn children ONLY when:[\s\S]*2\+ independent tasks/);
      expect(prompt).toMatch(/specialized focus/);
    });

    it('tells the parent NOT to spawn children for sequential, single-file, or simple-read tasks', () => {
      expect(prompt).toMatch(/Do NOT spawn children for:[\s\S]*Sequential analysis/);
      expect(prompt).toMatch(/Single-file or few-file tasks/);
      expect(prompt).toMatch(/Simple file reading/);
    });

    it('tells the parent to retry once and then do the work directly on failure', () => {
      expect(prompt).toMatch(/On failure:[\s\S]*retry once[\s\S]*do the work directly/);
    });

    it('tells the parent to terminate children when done', () => {
      expect(prompt).toMatch(/[Aa]lways terminate children when done/);
    });
  });

  describe('retrieval-first preference', () => {
    it('prefers structured retrieval over raw output', () => {
      expect(prompt).toMatch(/prefer structured retrieval over raw output/i);
    });

    it('lists every structured-retrieval command', () => {
      expect(prompt).toContain('get_child_summary');
      expect(prompt).toContain('get_child_artifacts');
      expect(prompt).toContain('get_child_section');
    });

    it('warns that get_child_output is a last-resort raw read', () => {
      expect(prompt).toMatch(/get_child_output[\s\S]*Raw output[\s\S]*last resort/);
    });
  });

  describe('model + provider routing guidance', () => {
    it('tells the parent to set both provider and model when the user names both', () => {
      expect(prompt).toContain('set both `provider` and `model`');
    });

    it('lists supported providers', () => {
      expect(prompt).toMatch(/Providers:[\s\S]*claude[\s\S]*codex[\s\S]*gemini[\s\S]*copilot/);
    });

    it('lists model tiers', () => {
      expect(prompt).toMatch(/Model tiers:[\s\S]*fast[\s\S]*balanced[\s\S]*powerful/);
    });
  });

  describe('native cross-LLM coordination', () => {
    it('tells the parent to use spawn_child.provider for cross-LLM work', () => {
      expect(prompt).toContain('always use `spawn_child` with the `provider` field');
    });

    it('explicitly forbids the MCP wrappers for provider coordination', () => {
      // The cross-LLM coordination paragraph names all three providers via
      // wildcard suffix (`mcp__<provider>__*`). The "Do NOT use:" line gives
      // two concrete example tools — Codex deliberately appears only via the
      // wildcard form, so do not assert a literal `mcp__codex-cli__codex`.
      expect(prompt).toContain('mcp__copilot__*');
      expect(prompt).toContain('mcp__gemini-cli__*');
      expect(prompt).toContain('mcp__codex-cli__*');
      expect(prompt).toMatch(/Do NOT use:/);
    });
  });

  describe('user interaction', () => {
    it('documents request_user_action and its valid request types', () => {
      expect(prompt).toContain('request_user_action');
      for (const requestType of ['switch_mode', 'approve_action', 'ask_questions']) {
        expect(prompt).toContain(requestType);
      }
    });
  });

  describe('consensus guidance', () => {
    it('documents consensus_query as a high-confidence-validation tool', () => {
      expect(prompt).toMatch(/consensus_query[\s\S]*high-confidence/);
    });

    it('warns against consensus for simple lookups', () => {
      expect(prompt).toMatch(/Do NOT use[\s\S]*simple lookups/);
    });
  });
});
```

- [ ] **Step 3: Run the new tests.**

Run: `npx vitest run src/main/orchestration/orchestration-protocol.spec.ts --reporter=verbose`

Expected: All `generateOrchestrationPrompt` tests pass. They are characterization tests — the prompt already contains every assertion target. If any test fails on first run, that means the prompt has already drifted from `unified.md`; investigate before continuing (do **not** edit the test to make it pass — read the prompt and decide whether the test or the prompt is correct).

- [ ] **Step 4: Lint.**

Run: `npx eslint src/main/orchestration/orchestration-protocol.spec.ts`

Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit (only if commits are authorized; see Commit Policy).**

```bash
git add src/main/orchestration/orchestration-protocol.spec.ts
git commit -m "test(orchestration): pin parent prompt invariants from unified.md phase 1"
```

---

## Task 3: Pin child prompt invariants in `generateChildPrompt`

**Files:**
- Modify: `src/main/orchestration/orchestration-protocol.spec.ts`

Source for the assertions: `src/main/orchestration/orchestration-protocol.ts:325-386`.

> **Note on artifact-type coverage:** The full `ArtifactType` union in `src/shared/types/child-result.types.ts:13-28` has 15 members, but the child prompt at `orchestration-protocol.ts:379` currently advertises only the 11 listed below (it omits `screenshot`, `console_log_excerpt`, `network_error_summary`, `trace_reference`). Closing that gap is **not** in scope for Phase 1 — it would mean editing the prompt, and Phase 1 is testing-only. We therefore test what the prompt **currently advertises**, and the test description says so explicitly. If a later phase decides to expand or shrink the list, this test must be updated alongside the prompt.

- [ ] **Step 1: Extend the import block.**

The import block at the top of the file should now read:

```typescript
import {
  ORCHESTRATION_MARKER_START,
  ORCHESTRATION_MARKER_END,
  generateOrchestrationPrompt,
  generateChildPrompt,
} from './orchestration-protocol';
```

- [ ] **Step 2: Append the `generateChildPrompt` describe block.**

Add after the `generateOrchestrationPrompt` describe block:

```typescript
describe('generateChildPrompt', () => {
  it('includes the child id and parent id', () => {
    const out = generateChildPrompt('child_1', 'parent_1', 'do something useful');
    expect(out).toContain('Instance: child_1');
    expect(out).toContain('Parent: parent_1');
  });

  it('embeds the task verbatim', () => {
    const task = 'audit the auth module for missing CSRF guards';
    const out = generateChildPrompt('c', 'p', task);
    expect(out).toContain(`**Your Task:** ${task}`);
  });

  it('includes the task id when provided', () => {
    const out = generateChildPrompt('c', 'p', 'task body', 'task_99');
    expect(out).toContain('(Task: task_99)');
  });

  it('omits the task id label when no task id is provided', () => {
    const out = generateChildPrompt('c', 'p', 'task body');
    expect(out).not.toContain('(Task:');
  });

  it('forbids the child from spawning further children', () => {
    const out = generateChildPrompt('c', 'p', 'task body');
    expect(out).toMatch(/cannot spawn children/i);
  });

  it('instructs the child to report results via the orchestrator command marker', () => {
    const out = generateChildPrompt('c', 'p', 'task body');
    expect(out).toContain(ORCHESTRATION_MARKER_START);
    expect(out).toContain(ORCHESTRATION_MARKER_END);
    expect(out).toContain('"action": "report_result"');
  });

  it('renders the parent context section only when context is provided', () => {
    const without = generateChildPrompt('c', 'p', 'task body');
    expect(without).not.toContain('Parent Context');

    const withCtx = generateChildPrompt('c', 'p', 'task body', undefined, 'recent decisions: …');
    expect(withCtx).toContain('## Parent Context');
    expect(withCtx).toContain('recent decisions: …');
  });

  // The full ArtifactType union has 15 members, but the prompt currently
  // advertises only the 11 below. We test what is actually in the prompt.
  // If you change the prompt, update this list to match.
  it('lists each artifact type currently advertised in the prompt', () => {
    const out = generateChildPrompt('c', 'p', 'task body');
    for (const artifactType of [
      'finding', 'recommendation', 'code_snippet', 'file_reference',
      'decision', 'data', 'command', 'error', 'warning', 'success', 'metric',
    ]) {
      expect(out).toContain(artifactType);
    }
  });

  it('lists every supported severity level', () => {
    const out = generateChildPrompt('c', 'p', 'task body');
    for (const sev of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(out).toContain(sev);
    }
  });
});
```

- [ ] **Step 3: Run the tests.**

Run: `npx vitest run src/main/orchestration/orchestration-protocol.spec.ts --reporter=verbose`

Expected: all `generateChildPrompt` tests pass. (Again — characterization. Failures mean the child prompt has drifted from the unified contract.)

- [ ] **Step 4: Lint.**

Run: `npx eslint src/main/orchestration/orchestration-protocol.spec.ts`

Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit (only if commits are authorized; see Commit Policy).**

```bash
git add src/main/orchestration/orchestration-protocol.spec.ts
git commit -m "test(orchestration): pin child prompt invariants from unified.md phase 1"
```

---

## Task 4: Pin parser behavior — round-trip every command type

**Files:**
- Modify: `src/main/orchestration/orchestration-protocol.spec.ts`

We assert that for every action in `OrchestratorAction`, a well-formed command embedded in surrounding text is extracted intact. Source: `src/main/orchestration/orchestration-protocol.ts:391-526` (parser + validator).

- [ ] **Step 1: Extend the import block and add the shared helpers.**

The import block at the top of the file should now read:

```typescript
import {
  ORCHESTRATION_MARKER_START,
  ORCHESTRATION_MARKER_END,
  generateOrchestrationPrompt,
  generateChildPrompt,
  parseOrchestratorCommands,
  type OrchestratorCommand,
} from './orchestration-protocol';
```

Add these helpers immediately after the import block (above the existing `describe(...)` calls). They are used by Tasks 4, 5, and 6:

```typescript
/** Wrap a JSON command in the documented marker block. */
function commandBlock(command: Record<string, unknown>): string {
  return [
    ORCHESTRATION_MARKER_START,
    JSON.stringify(command),
    ORCHESTRATION_MARKER_END,
  ].join('\n');
}

/** Helper for tests that only need the first parsed command. */
function parseFirst(input: string): OrchestratorCommand | undefined {
  return parseOrchestratorCommands(input)[0];
}
```

- [ ] **Step 2: Append the `parseOrchestratorCommands` describe block.**

Add after the `generateChildPrompt` block:

```typescript
describe('parseOrchestratorCommands', () => {
  it('returns an empty list when the text contains no markers', () => {
    expect(parseOrchestratorCommands('plain assistant text with no commands')).toEqual([]);
  });

  it('extracts a spawn_child command embedded in surrounding markdown', () => {
    const cmd = {
      action: 'spawn_child',
      task: 'audit auth module',
      provider: 'copilot',
      model: 'gemini-3.1-pro-preview',
      name: 'audit-1',
    };
    const text = `Lead-in prose.\n${commandBlock(cmd)}\nTrailing prose.`;
    expect(parseFirst(text)).toEqual(cmd);
  });

  it('extracts multiple commands in a single text', () => {
    const a = { action: 'get_children' };
    const b = { action: 'terminate_child', childId: 'c1' };
    const text = `${commandBlock(a)}\n--\n${commandBlock(b)}`;
    expect(parseOrchestratorCommands(text)).toEqual([a, b]);
  });

  it('round-trips every documented action type', () => {
    const samples: Array<Record<string, unknown>> = [
      { action: 'spawn_child', task: 't' },
      { action: 'message_child', childId: 'c', message: 'hi' },
      { action: 'get_children' },
      { action: 'terminate_child', childId: 'c' },
      { action: 'get_child_output', childId: 'c' },
      { action: 'call_tool', toolId: 'fs.read' },
      { action: 'report_task_complete', success: true, summary: 's' },
      { action: 'report_progress', percentage: 25, currentStep: 'reading' },
      { action: 'report_error', code: 'E_X', message: 'm' },
      { action: 'get_task_status' },
      { action: 'request_user_action', requestType: 'confirm', title: 't', message: 'm' },
      { action: 'report_result', summary: 's' },
      { action: 'get_child_summary', childId: 'c' },
      { action: 'get_child_artifacts', childId: 'c' },
      { action: 'get_child_section', childId: 'c', section: 'conclusions' },
      { action: 'consensus_query', question: 'is this safe?' },
    ];
    for (const sample of samples) {
      expect(
        parseFirst(commandBlock(sample)),
        `expected to round-trip action "${sample.action}"`,
      ).toEqual(sample);
    }
  });

  it('drops non-JSON marker payloads silently', () => {
    const text = `${ORCHESTRATION_MARKER_START}\nthis is not json\n${ORCHESTRATION_MARKER_END}`;
    expect(parseOrchestratorCommands(text)).toEqual([]);
  });

  it('drops commands whose action is unknown', () => {
    const text = commandBlock({ action: 'totally_made_up', task: 't' });
    expect(parseOrchestratorCommands(text)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests.**

Run: `npx vitest run src/main/orchestration/orchestration-protocol.spec.ts --reporter=verbose`

Expected: All `parseOrchestratorCommands` tests pass.

- [ ] **Step 4: Lint.**

Run: `npx eslint src/main/orchestration/orchestration-protocol.spec.ts`

Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit (only if commits are authorized; see Commit Policy).**

```bash
git add src/main/orchestration/orchestration-protocol.spec.ts
git commit -m "test(orchestration): round-trip every orchestrator command via parser"
```

---

## Task 5: Pin validator behavior — reject malformed for every action

**Files:**
- Modify: `src/main/orchestration/orchestration-protocol.spec.ts`

`isValidCommand` is internal, so we exercise it via `parseOrchestratorCommands` (which silently drops invalid commands). Each negative case asserts the parser returns `[]` for a malformed payload. Source: `src/main/orchestration/orchestration-protocol.ts:419-526`.

- [ ] **Step 1: Append the validator describe block.**

Add after the `parseOrchestratorCommands` block:

```typescript
describe('isValidCommand (via parser drop behavior)', () => {
  function rejects(name: string, payload: Record<string, unknown>): void {
    it(`rejects ${name}`, () => {
      expect(parseOrchestratorCommands(commandBlock(payload))).toEqual([]);
    });
  }

  rejects('spawn_child without a task',         { action: 'spawn_child' });
  rejects('spawn_child with non-string task',   { action: 'spawn_child', task: 7 });
  rejects('message_child without childId',      { action: 'message_child', message: 'hi' });
  rejects('message_child without message',      { action: 'message_child', childId: 'c' });
  rejects('terminate_child without childId',    { action: 'terminate_child' });
  rejects('get_child_output without childId',   { action: 'get_child_output' });
  rejects('call_tool without toolId',           { action: 'call_tool' });
  rejects('report_task_complete without summary', {
    action: 'report_task_complete', success: true,
  });
  rejects('report_task_complete with non-boolean success', {
    action: 'report_task_complete', summary: 's', success: 'yes',
  });
  rejects('report_progress without percentage', {
    action: 'report_progress', currentStep: 'reading',
  });
  rejects('report_progress without currentStep', {
    action: 'report_progress', percentage: 50,
  });
  rejects('report_error without code', { action: 'report_error', message: 'm' });
  rejects('report_error without message', { action: 'report_error', code: 'E' });

  describe('request_user_action', () => {
    rejects('with unknown requestType', {
      action: 'request_user_action', requestType: 'banana', title: 't', message: 'm',
    });
    rejects('switch_mode without targetMode', {
      action: 'request_user_action', requestType: 'switch_mode', title: 't', message: 'm',
    });
    rejects('switch_mode with invalid targetMode', {
      action: 'request_user_action', requestType: 'switch_mode',
      title: 't', message: 'm', targetMode: 'banana',
    });
    rejects('select_option with empty options', {
      action: 'request_user_action', requestType: 'select_option',
      title: 't', message: 'm', options: [],
    });
    rejects('select_option with bad option shape', {
      action: 'request_user_action', requestType: 'select_option',
      title: 't', message: 'm',
      options: [{ id: '', label: '' }],
    });
    rejects('ask_questions without questions', {
      action: 'request_user_action', requestType: 'ask_questions', title: 't', message: 'm',
    });
    rejects('ask_questions with empty-string question', {
      action: 'request_user_action', requestType: 'ask_questions',
      title: 't', message: 'm', questions: ['  '],
    });
  });

  describe('structured-result commands', () => {
    rejects('report_result without summary',     { action: 'report_result' });
    rejects('get_child_summary without childId', { action: 'get_child_summary' });
    rejects('get_child_artifacts without childId', { action: 'get_child_artifacts' });
    rejects('get_child_section without childId', { action: 'get_child_section', section: 'conclusions' });
    rejects('get_child_section with bad section', {
      action: 'get_child_section', childId: 'c', section: 'banana',
    });
  });

  rejects('consensus_query without a question', { action: 'consensus_query' });
});
```

This block uses the `commandBlock(...)` helper added in Task 4 and the already-imported `parseOrchestratorCommands`. No new imports.

- [ ] **Step 2: Run the tests.**

Run: `npx vitest run src/main/orchestration/orchestration-protocol.spec.ts --reporter=verbose`

Expected: every reject-case passes. If any malformed payload _is_ accepted today, that's a real validator gap — fix `isValidCommand` in `orchestration-protocol.ts` rather than weakening the test. Treat that fix as a Phase 1 bonus (and call it out separately when you ask the user about the commit, since it would change production code).

- [ ] **Step 3: Lint.**

Run: `npx eslint src/main/orchestration/orchestration-protocol.spec.ts`

Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit (only if commits are authorized; see Commit Policy).**

```bash
git add src/main/orchestration/orchestration-protocol.spec.ts
git commit -m "test(orchestration): reject malformed commands across every action type"
```

---

## Task 6: Pin marker stripping and response formatting

**Files:**
- Modify: `src/main/orchestration/orchestration-protocol.spec.ts`

`stripOrchestrationMarkers` is used to sanitize parent context before embedding it in child prompts (so children don't echo or re-execute their parent's commands). `formatCommandResponse` constructs the canonical response format. Source: `src/main/orchestration/orchestration-protocol.ts:540-579`.

- [ ] **Step 1: Extend the import block.**

The import block at the top of the file should now read:

```typescript
import {
  ORCHESTRATION_MARKER_START,
  ORCHESTRATION_MARKER_END,
  generateOrchestrationPrompt,
  generateChildPrompt,
  parseOrchestratorCommands,
  stripOrchestrationMarkers,
  formatCommandResponse,
  type OrchestratorCommand,
} from './orchestration-protocol';
```

(`OrchestratorAction` is **not** imported. The `formatCommandResponse` signature takes `action: OrchestratorAction`, but TypeScript narrows string literals like `'get_children'` to that union member automatically — no cast needed.)

- [ ] **Step 2: Append the strip + format describe blocks.**

Add after the validator block:

```typescript
describe('stripOrchestrationMarkers', () => {
  it('removes a single command block while preserving surrounding text', () => {
    const text = `before\n${commandBlock({ action: 'get_children' })}\nafter`;
    const cleaned = stripOrchestrationMarkers(text);
    expect(cleaned).not.toContain(ORCHESTRATION_MARKER_START);
    expect(cleaned).not.toContain(ORCHESTRATION_MARKER_END);
    expect(cleaned).toContain('before');
    expect(cleaned).toContain('after');
  });

  it('removes multiple command blocks', () => {
    const text = [
      'lead',
      commandBlock({ action: 'get_children' }),
      'middle',
      commandBlock({ action: 'terminate_child', childId: 'c1' }),
      'tail',
    ].join('\n');
    const cleaned = stripOrchestrationMarkers(text);
    expect(cleaned).not.toContain(ORCHESTRATION_MARKER_START);
    expect(cleaned).toContain('lead');
    expect(cleaned).toContain('middle');
    expect(cleaned).toContain('tail');
  });

  it('removes orchestrator response blocks', () => {
    const text = [
      'preamble',
      '[Orchestrator Response]',
      'Action: get_children',
      'Status: SUCCESS',
      '[/Orchestrator Response]',
      'postamble',
    ].join('\n');
    const cleaned = stripOrchestrationMarkers(text);
    expect(cleaned).not.toContain('[Orchestrator Response]');
    expect(cleaned).not.toContain('[/Orchestrator Response]');
    expect(cleaned).toContain('preamble');
    expect(cleaned).toContain('postamble');
  });

  it('collapses runs of 3+ blank lines down to 2', () => {
    const text = `line1\n\n\n\nline2`;
    expect(stripOrchestrationMarkers(text)).toBe('line1\n\nline2');
  });
});

describe('formatCommandResponse', () => {
  it('produces the canonical [Orchestrator Response] block with action, status and JSON data', () => {
    const out = formatCommandResponse('get_children', true, { children: [] });
    expect(out).toContain('[Orchestrator Response]');
    expect(out).toContain('Action: get_children');
    expect(out).toContain('Status: SUCCESS');
    expect(out).toContain('"children": []');
    expect(out).toContain('[/Orchestrator Response]');
  });

  it('reports FAILED status when success is false', () => {
    const out = formatCommandResponse('terminate_child', false, { error: 'no such child' });
    expect(out).toContain('Status: FAILED');
    expect(out).toContain('"error": "no such child"');
  });
});
```

- [ ] **Step 3: Run the tests.**

Run: `npx vitest run src/main/orchestration/orchestration-protocol.spec.ts --reporter=verbose`

Expected: all `stripOrchestrationMarkers` and `formatCommandResponse` tests pass.

- [ ] **Step 4: Lint.**

Run: `npx eslint src/main/orchestration/orchestration-protocol.spec.ts`

Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit (only if commits are authorized; see Commit Policy).**

```bash
git add src/main/orchestration/orchestration-protocol.spec.ts
git commit -m "test(orchestration): pin marker stripping and response formatting"
```

---

## Task 7: Pin renderer-side command stripping in `MarkdownService`

**Files:**
- Create: `src/renderer/app/core/services/markdown.service.spec.ts`

The renderer has its **own** copy of the strip regex inside `MarkdownService.stripOrchestrationCommands()` (`src/renderer/app/core/services/markdown.service.ts:144-165`). That is drift risk — if the protocol's marker constants ever change, the renderer's hard-coded regex won't notice. We pin the renderer behavior independently so a regression here is surfaced in CI.

`stripOrchestrationCommands` is private. We exercise it via the public `renderSync()` (line 222), which calls strip → marked → DOMPurify and returns sanitized HTML. Vitest is configured with `environment: 'jsdom'` (`vitest.config.ts:6`), so `DOMPurify` works.

- [ ] **Step 1: Create the renderer spec file.**

Write `src/renderer/app/core/services/markdown.service.spec.ts` with:

```typescript
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';

import { MarkdownService } from './markdown.service';

describe('MarkdownService.renderSync command stripping', () => {
  let service: MarkdownService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(MarkdownService);
  });

  it('renders normal markdown unchanged in surrounding paragraphs', () => {
    const html = service.renderSync('hello **world**');
    expect(html).toContain('<strong>world</strong>');
  });

  it('removes orchestrator command blocks from rendered output', () => {
    const md = [
      'before the command',
      ':::ORCHESTRATOR_COMMAND:::',
      '{"action":"get_children"}',
      ':::END_COMMAND:::',
      'after the command',
    ].join('\n');
    const html = service.renderSync(md);
    expect(html).not.toContain('ORCHESTRATOR_COMMAND');
    expect(html).not.toContain('END_COMMAND');
    expect(html).not.toContain('"action":"get_children"');
    expect(html).toContain('before the command');
    expect(html).toContain('after the command');
  });

  it('removes multiple command blocks in a single message', () => {
    const md = [
      'lead',
      ':::ORCHESTRATOR_COMMAND:::',
      '{"action":"get_children"}',
      ':::END_COMMAND:::',
      'middle',
      ':::ORCHESTRATOR_COMMAND:::',
      '{"action":"terminate_child","childId":"c1"}',
      ':::END_COMMAND:::',
      'tail',
    ].join('\n');
    const html = service.renderSync(md);
    expect(html).not.toContain('ORCHESTRATOR_COMMAND');
    expect(html).not.toContain('terminate_child');
    expect(html).toContain('lead');
    expect(html).toContain('middle');
    expect(html).toContain('tail');
  });

  it('removes orchestrator response blocks', () => {
    const md = [
      'preamble',
      '[Orchestrator Response]',
      'Action: get_children',
      'Status: SUCCESS',
      '[/Orchestrator Response]',
      'postamble',
    ].join('\n');
    const html = service.renderSync(md);
    expect(html).not.toContain('[Orchestrator Response]');
    expect(html).not.toContain('[/Orchestrator Response]');
    expect(html).toContain('preamble');
    expect(html).toContain('postamble');
  });

  it('returns an empty string for empty input', () => {
    expect(service.renderSync('')).toBe('');
  });
});
```

- [ ] **Step 2: Run the renderer spec.**

Run: `npx vitest run src/renderer/app/core/services/markdown.service.spec.ts --reporter=verbose`

Expected: all 5 tests pass. If `TestBed.inject(MarkdownService)` complains about missing zone setup, double-check `src/test-setup.ts` (referenced by `vitest.config.ts:setupFiles`) — it should already initialize Angular's testing environment for the rest of the renderer test suite, so no new wiring is needed here.

- [ ] **Step 3: Lint.**

Run: `npx eslint src/renderer/app/core/services/markdown.service.spec.ts`

Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit (only if commits are authorized; see Commit Policy).**

```bash
git add src/renderer/app/core/services/markdown.service.spec.ts
git commit -m "test(renderer): pin MarkdownService orchestrator-command stripping"
```

---

## Task 8: Verify the full slice — types, lint, all relevant tests

This is the verification gate from `unified.md` §"Verification Standard". No new code, just running everything.

- [ ] **Step 1: Run TypeScript compilation for the renderer + main projects.**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 2: Run TypeScript compilation for the spec project.**

Run: `npx tsc --noEmit -p tsconfig.spec.json`

Expected: 0 errors.

- [ ] **Step 3: Lint the new test files.**

Run: `npx eslint src/main/orchestration/orchestration-protocol.spec.ts src/renderer/app/core/services/markdown.service.spec.ts`

Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Run the full orchestration test suite to make sure neighbors still pass.**

Run: `npx vitest run src/main/orchestration --reporter=verbose`

Expected: all suites pass, including the pre-existing `orchestration-handler.spec.ts`. If anything in the existing suite fails, the cause is unrelated to this slice — investigate, but do not abandon Phase 1 verification on it.

- [ ] **Step 5: Run the renderer markdown test in isolation.**

Run: `npx vitest run src/renderer/app/core/services/markdown.service.spec.ts --reporter=verbose`

Expected: 5 passing tests.

- [ ] **Step 6: Inspect for any incidental changes to the two spec files (e.g., editor auto-formatting).**

```bash
git status -- \
  src/main/orchestration/orchestration-protocol.spec.ts \
  src/renderer/app/core/services/markdown.service.spec.ts
```

- If both files are clean, skip the rest of this step.
- If there are unstaged formatting tweaks **on the two spec files only**, and commits are authorized, commit them explicitly by file (do **not** use `git add -A`, which would stage unrelated user work):

```bash
git add \
  src/main/orchestration/orchestration-protocol.spec.ts \
  src/renderer/app/core/services/markdown.service.spec.ts
git commit -m "chore: formatter cleanup after phase-1 protocol tests"
```

- If `git status` shows changes to **other** files in the worktree (production code, unrelated specs, dotfiles), do **not** stage them. Surface the diff to the user and ask whether they belong with this slice or are pre-existing local edits that should stay separate.

---

## Phase 1 Exit Criteria — Self-Check

Before declaring Phase 1 done, confirm each of these is true (these mirror `unified.md` §Phase 1 exit criteria):

- [ ] The operating contract from `unified.md` is test-covered:
  - delegation rules for spawning vs not spawning ✅ (Task 2)
  - retry-once-then-do-directly ✅ (Task 2)
  - terminate when done ✅ (Task 2)
  - prefer `get_child_summary` / `get_child_artifacts` / `get_child_section` over `get_child_output` ✅ (Task 2)
  - set both `provider` and `model` when both are named ✅ (Task 2)
  - native `spawn_child` provider routing — never MCP wrappers ✅ (Task 2)
  - `request_user_action` for approvals/clarifications ✅ (Task 2)
  - `consensus_query` only for high-confidence validation ✅ (Task 2)
- [ ] Parser/validator coverage exists for every command marker block (Tasks 4 & 5).
- [ ] Renderer command stripping is independently test-covered (Task 7).
- [ ] No new runtime system was introduced (only test files were created).
- [ ] All verification commands from Task 8 ran clean.

If any item is unchecked, the phase is **not** done — circle back. Do not edit the spec to make it pass.

---

## Out of Scope (do **not** do in this phase)

These are tempting and might come up — defer them. They're tracked in the master roadmap (`2026-04-27-unified-orchestration-master-plan.md`):

- Adding new lifecycle hook events (Phase 2).
- Recording requested-vs-routed provider/model on spawn (Phase 4).
- Touching `consensus-coordinator.ts` to bound output (Phase 4).
- Refactoring the parent prompt to make it smaller (out of scope for stabilization — first pin it, then evolve it).

---

## Resume Notes

If a worker picks this up mid-execution:

1. Check `git log --oneline | head -10` for the most recent commit message starting with `test(orchestration):` or `test(renderer):`.
2. Check the phase Exit Criteria checklist above to identify which task is next.
3. Re-read the source files listed in **Pre-Flight** before editing — they may have changed.
4. Run `npx vitest run src/main/orchestration/orchestration-protocol.spec.ts --reporter=verbose` first to confirm the existing portion still passes.
