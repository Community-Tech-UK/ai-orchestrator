# Wave 3: Workflow, Resume, History & Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship deterministic workflow transitions, advanced history search with transcript snippets, a resume picker with five actions, conservative natural-language workflow suggestions, and explicit interrupt-boundary + compaction-summary display items — all on top of the existing `WorkflowManager`, `HistoryManager`, `SessionRecallService`, `SessionContinuityManager`, and `InterruptRespawnHandler` services.

**Architecture:** Add `WorkflowTransitionPolicy` as a pure evaluator hooked synchronously into `WorkflowManager.startWorkflow`. Precompute transcript snippets at archive time and store them on `ConversationHistoryEntry`. Extend `SessionRecallService` with a new `'history-transcript'` source instead of building a parallel index. Coordinate advanced search through `AdvancedHistorySearch`. Generate both a new sessionId AND a new historyThreadId on resume fork to avoid cursor collision. Project interrupt phases and compaction events as new `DisplayItem` kinds (`'interrupt-boundary'`, `'compaction-summary'`). Use Wave 1's `OverlayShellComponent` + `OverlayController<T>` for the resume picker.

**Tech Stack:** TypeScript 5.9, Angular 21 (zoneless, signals), Electron 40, `electron-store`, Vitest, Zod 4, ESLint.

**Spec:** [`docs/superpowers/specs/2026-04-28-wave3-workflow-resume-history-recovery-design.md`](../specs/2026-04-28-wave3-workflow-resume-history-recovery-design.md)
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design.md`](../specs/2026-04-28-cross-repo-usability-upgrades-design.md)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`](./2026-04-28-cross-repo-usability-upgrades-plan.md)
**Wave 1 spec consumed (treated as available):** [`docs/superpowers/specs/2026-04-28-wave1-command-registry-and-overlay-design.md`](../specs/2026-04-28-wave1-command-registry-and-overlay-design.md)

---

## How to read this plan

- **Phases** group related tasks. Phases 1–7 are pure backend (types, policy, snippet service, recall extension, search coordinator). Phases 8–10 wire IPC and renderer state. Phases 11–13 ship UI. Phase 14 is final integration.
- **Tasks** are bite-sized work units (target ≤ 30 minutes). Each ends with a local commit.
- **TDD discipline:** behavioral code follows test → fail → implement → pass → commit. Pure type-only changes use type-check as the verification.
- **Verification commands** (run after every code-change task):
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - Targeted vitest spec(s) for the touched code
- **Critical rule (per `AGENTS.md`):** **NEVER run `git commit` without explicit user approval.** Every task below ends with a suggested commit message — run the commit only after the user approves. **Never push to remote** under any circumstances; pushing is always the user's call. Hooks must run; do not pass `--no-verify`.
- **Wave 1 prerequisite:** Phase 10 onward consumes Wave 1's `OverlayShellComponent`, `OverlayController<T>`, and `UsageStore`. Verify Wave 1 is merged before starting Phase 10. If not, stop at Phase 9 and report.

## Phase index

1. Phase 1 — Foundational shared types
2. Phase 2 — `WorkflowTransitionPolicy` evaluator (pure)
3. Phase 3 — Hook policy into `WorkflowManager.startWorkflow`
4. Phase 4 — `TranscriptSnippetService` (precompute on archive)
5. Phase 5 — Extend `HistoryManager.getEntries` (paginate, time/source/project filters)
6. Phase 6 — Add `'history-transcript'` source to `SessionRecallService`
7. Phase 7 — `AdvancedHistorySearch` coordinator
8. Phase 8 — IPC handlers + preload bridges (workflow, history search, resume)
9. Phase 9 — Renderer `HistoryStore` extension
10. Phase 10 — `ResumePickerController` + host (consumes Wave 1)
11. Phase 11 — Interrupt-boundary display item (main emit + renderer render)
12. Phase 12 — Compaction-summary display item (main emit + renderer render)
13. Phase 13 — `NlWorkflowClassifier` + suggestion surface
14. Phase 14 — Final integration: compile, lint, test, manual smoke

---

## Phase 1 — Foundational shared types

These are pure-type additions. After this phase, the new types compile but nothing consumes them yet.

### Task 1.1: Extend `workflow.types.ts` with `WorkflowTransitionPolicy`

**Files:**
- Modify: `src/shared/types/workflow.types.ts`

- [ ] **Step 1: Add the new types at the bottom of the file**

Append:

```ts
/**
 * Source of a workflow start request — used by the policy evaluator to apply
 * different rules (NL suggestions are stricter than explicit slash invocations).
 */
export type WorkflowStartSource =
  | 'slash-command'
  | 'nl-suggestion'
  | 'automation'
  | 'manual-ui'
  | 'restore';

/**
 * Outcome of evaluating a requested workflow start against current state.
 *   allow                — no overlap; start as a fresh execution.
 *   allowWithOverlap     — overlap permitted; caller may start without auto-completing.
 *   autoCompleteCurrent  — caller should mark the active workflow completed
 *                          (with `transitionAutoCompletion.reason = 'superseded'`)
 *                          before starting.
 *   deny                 — caller must NOT start. Surface `reason` and (optionally)
 *                          `suggestedAction` to the operator.
 */
export type WorkflowTransitionPolicy =
  | { kind: 'allow' }
  | { kind: 'allowWithOverlap'; maxConcurrent?: number }
  | { kind: 'autoCompleteCurrent' }
  | { kind: 'deny'; reason: string; suggestedAction?: string };

export interface WorkflowTransitionInputs {
  current: {
    execution: WorkflowExecution;
    template: WorkflowTemplate;
  } | null;
  requested: {
    template: WorkflowTemplate;
    instanceId: string;
  };
  source: WorkflowStartSource;
}
```

- [ ] **Step 2: Extend `WorkflowExecution` with `transitionAutoCompletion`**

In the existing `WorkflowExecution` interface, after `totalCost: number;`, add:

```ts
  /**
   * Set when this execution was auto-completed by the transition policy
   * (e.g. another workflow superseded it). Additive; absent means manual
   * completion or in-progress.
   */
  transitionAutoCompletion?: {
    reason: 'superseded' | 'manual-cancel' | 'restore-cleanup';
    supersededBy?: string;
  };
```

- [ ] **Step 3: Verify type-check**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/workflow.types.ts
git commit -m "feat(workflow): add WorkflowTransitionPolicy + WorkflowStartSource + transitionAutoCompletion types"
```

---

### Task 1.2: Extend `history.types.ts` with `HistorySnippet` + advanced options

**Files:**
- Modify: `src/shared/types/history.types.ts`

- [ ] **Step 1: Add new types**

Append (or insert near `HistoryLoadOptions`):

```ts
/**
 * A precomputed transcript snippet attached to a `ConversationHistoryEntry`.
 * `position` is the buffer index of the message it was extracted from.
 * `excerpt` is capped at 240 chars; truncated edges use ellipses.
 * `score` is a relevance number from archive-time scoring.
 */
export interface HistorySnippet {
  position: number;
  excerpt: string;
  score: number;
}

export type HistorySearchSource =
  | 'history-transcript'
  | 'child_result'
  | 'child_diagnostic'
  | 'automation_run'
  | 'agent_tree'
  | 'archived_session';

export interface HistoryTimeRange {
  /** ms epoch (inclusive). */
  from?: number;
  /** ms epoch (inclusive). */
  to?: number;
}

export type HistoryProjectScope = 'current' | 'all' | 'none';

export interface HistoryPageRequest {
  /** Clamped to [1, 100] in the handler. */
  pageSize: number;
  /** 1-indexed. */
  pageNumber: number;
}
```

- [ ] **Step 2: Extend `HistoryLoadOptions`**

Replace the existing interface with:

```ts
export interface HistoryLoadOptions {
  /** Maximum number of entries to return. Ignored when `page` is set. */
  limit?: number;

  /** Search query (matches metadata: displayName, first/last user message, working directory). */
  searchQuery?: string;

  /** Filter by working directory. */
  workingDirectory?: string;

  // ── Wave 3 additions (all optional) ──

  /** Plain-text query against transcript snippets. Matches precomputed snippets first. */
  snippetQuery?: string;

  /** Wall-clock filter applied to `endedAt`. */
  timeRange?: HistoryTimeRange;

  /** Restrict by source. Defaults to all when omitted. */
  source?: HistorySearchSource | HistorySearchSource[];

  /** Project scope filter. Defaults to `'current'` when `workingDirectory` is set, else `'all'`. */
  projectScope?: HistoryProjectScope;

  /** Pagination request. When omitted, `limit` semantics apply. */
  page?: HistoryPageRequest;
}
```

- [ ] **Step 3: Extend `ConversationHistoryEntry`**

Inside the existing interface, after `executionLocation?: ExecutionLocation;`, add:

```ts
  /** Precomputed transcript snippets for advanced search. Capped at 5 per entry. */
  snippets?: HistorySnippet[];
```

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/shared/types/history.types.ts
git commit -m "feat(history): add HistorySnippet + extended HistoryLoadOptions + entry.snippets"
```

---

### Task 1.3: Extend `session-recall.types.ts` with the new source

**Files:**
- Modify: `src/shared/types/session-recall.types.ts`

- [ ] **Step 1: Add `'history-transcript'` to `SessionRecallSource`**

Replace the union:

```ts
export type SessionRecallSource =
  | 'history-transcript'   // ← Wave 3: transcript snippets from archived history
  | 'child_result'
  | 'child_diagnostic'
  | 'automation_run'
  | 'provider_event'
  | 'agent_tree'
  | 'archived_session';
```

- [ ] **Step 2: Extend `SessionRecallQuery`**

Append two optional fields:

```ts
export interface SessionRecallQuery {
  // ── existing ──
  query: string;
  intent?: SessionRecallIntent;
  parentId?: string;
  automationId?: string;
  provider?: string;
  model?: string;
  repositoryPath?: string;
  sources?: SessionRecallSource[];
  limit?: number;

  // ── Wave 3 ──
  /** Opt in to scanning history-transcript snippets. Default false. */
  includeHistoryTranscripts?: boolean;
  /** Cap on history-transcript results merged. Default 25. */
  maxHistoryTranscriptResults?: number;
}
```

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/shared/types/session-recall.types.ts
git commit -m "feat(session-recall): add history-transcript source + opt-in flags"
```

---

### Task 1.4: Add new `DisplayItem` kinds and metadata interfaces

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.ts`

- [ ] **Step 1: Read the existing file fully**

```bash
# (Use the Read tool, not cat — instruction-compliant)
```

Note the current `DisplayItem` interface (lines 12–36) and the existing constants below it.

- [ ] **Step 2: Extend the `type` union and add metadata fields**

Replace the existing `DisplayItem` interface with:

```ts
export interface DisplayItem {
  id: string;
  type:
    | 'message'
    | 'tool-group'
    | 'thought-group'
    | 'work-cycle'
    | 'system-event-group'
    | 'interrupt-boundary'
    | 'compaction-summary';
  message?: OutputMessage;
  renderedMessage?: unknown;
  toolMessages?: OutputMessage[];
  thinking?: ThinkingContent[];
  thoughts?: string[];
  response?: OutputMessage;
  renderedResponse?: unknown;
  timestamp?: number;
  repeatCount?: number;
  showHeader?: boolean;
  bufferIndex?: number;
  children?: DisplayItem[];
  systemEvents?: OutputMessage[];
  groupAction?: string;
  groupLabel?: string;
  groupPreview?: string;

  // ── Wave 3 ──
  interruptBoundary?: InterruptBoundaryDisplay;
  compactionSummary?: CompactionSummaryDisplay;
}

export type InterruptDisplayPhase =
  | 'requested'
  | 'cancelling'
  | 'escalated'
  | 'respawning'
  | 'completed';

export type InterruptDisplayOutcome =
  | 'cancelled'
  | 'cancelled-for-edit'
  | 'respawn-success'
  | 'respawn-fallback'
  | 'unresolved';

export interface InterruptBoundaryDisplay {
  phase: InterruptDisplayPhase;
  requestId: string;
  outcome: InterruptDisplayOutcome;
  at: number;
  reason?: string;
  fallbackMode?: 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';
}

export type CompactionFallbackMode =
  | 'in-place'
  | 'snapshot-restore'
  | 'native-resume'
  | 'replay-fallback';

export interface CompactionSummaryDisplay {
  reason: string;
  beforeCount: number;
  afterCount: number;
  tokensReclaimed?: number;
  fallbackMode?: CompactionFallbackMode;
  at: number;
}
```

- [ ] **Step 3: Verify type-check (the existing `process` method does not yet branch on the new kinds — that lands in Phases 11 + 12)**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.ts
git commit -m "feat(display-items): add interrupt-boundary + compaction-summary kinds (types only)"
```

---

## Phase 2 — `WorkflowTransitionPolicy` evaluator (pure)

This phase ships only the pure function and its tests. No `WorkflowManager` wiring.

### Task 2.1: Write failing tests for `evaluateTransition`

**Files:**
- Create: `src/main/workflows/__tests__/workflow-transition-policy.spec.ts`

- [ ] **Step 1: Write the spec**

Create the file:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateTransition, classifyOverlap } from '../workflow-transition-policy';
import type {
  WorkflowExecution,
  WorkflowTemplate,
  WorkflowStartSource,
} from '../../../shared/types/workflow.types';

const makeTemplate = (id: string, category: WorkflowTemplate['category'] = 'review', name = id): WorkflowTemplate => ({
  id,
  name,
  description: '',
  icon: '🧪',
  category,
  triggerPatterns: [],
  autoTrigger: false,
  phases: [
    { id: 'p1', name: 'P1', description: '', order: 0, systemPromptAddition: '', gateType: 'none' },
  ],
  estimatedDuration: '5m',
  requiredAgents: [],
});

const makeExecution = (templateId: string, opts: Partial<WorkflowExecution> = {}): WorkflowExecution => ({
  id: `wf-${templateId}`,
  instanceId: 'inst-1',
  templateId,
  currentPhaseId: 'p1',
  phaseStatuses: { p1: 'active' },
  phaseData: {},
  startedAt: Date.now(),
  agentInvocations: 0,
  totalTokens: 0,
  totalCost: 0,
  ...opts,
});

const inputs = (
  current: { execution: WorkflowExecution; template: WorkflowTemplate } | null,
  requestedTemplate: WorkflowTemplate,
  source: WorkflowStartSource = 'manual-ui',
) => ({
  current,
  requested: { template: requestedTemplate, instanceId: 'inst-1' },
  source,
});

describe('evaluateTransition', () => {
  it('rule 1: no active workflow → allow', () => {
    expect(evaluateTransition(inputs(null, makeTemplate('a')))).toEqual({ kind: 'allow' });
  });

  it('rule 2: self-overlap (same templateId) → deny', () => {
    const t = makeTemplate('a');
    const e = makeExecution('a');
    const r = evaluateTransition(inputs({ execution: e, template: t }, t));
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') {
      expect(r.reason).toMatch(/already active/i);
    }
  });

  it('rule 3: completed execution is treated as no overlap → allow', () => {
    const t = makeTemplate('a');
    const e = makeExecution('a', { completedAt: Date.now() });
    expect(evaluateTransition(inputs({ execution: e, template: t }, makeTemplate('b')))).toEqual({ kind: 'allow' });
  });

  it('rule 4: pending gate + nl-suggestion → deny', () => {
    const t = makeTemplate('a');
    const e = makeExecution('a', {
      pendingGate: {
        phaseId: 'p1',
        gateType: 'user_confirmation',
        gatePrompt: 'Continue?',
        submittedAt: Date.now(),
      },
    });
    const r = evaluateTransition(inputs({ execution: e, template: t }, makeTemplate('b'), 'nl-suggestion'));
    expect(r.kind).toBe('deny');
  });

  it('rule 5: sibling categories → autoCompleteCurrent', () => {
    const a = makeTemplate('a', 'review');
    const b = makeTemplate('b', 'review');
    const r = evaluateTransition(inputs({ execution: makeExecution('a'), template: a }, b));
    expect(r.kind).toBe('autoCompleteCurrent');
  });

  it('rule 6: cross-category compatible → allowWithOverlap', () => {
    const a = makeTemplate('a', 'review');
    const b = makeTemplate('b', 'debugging');
    const r = evaluateTransition(inputs({ execution: makeExecution('a'), template: a }, b));
    expect(r.kind).toBe('allowWithOverlap');
  });

  it('rule 8: source=restore short-circuits to allow', () => {
    const a = makeTemplate('a', 'review');
    const b = makeTemplate('b', 'review');
    const r = evaluateTransition(inputs({ execution: makeExecution('a'), template: a }, b, 'restore'));
    expect(r.kind).toBe('allow');
  });

  it('rule 9: source=automation never auto-completes (allow or deny only)', () => {
    const a = makeTemplate('a', 'review');
    const b = makeTemplate('b', 'review'); // sibling → would normally autoCompleteCurrent
    const r = evaluateTransition(inputs({ execution: makeExecution('a'), template: a }, b, 'automation'));
    expect(r.kind === 'allow' || r.kind === 'deny').toBe(true);
    expect(r.kind).not.toBe('autoCompleteCurrent');
  });

  it('classifyOverlap returns no-overlap when current is null', () => {
    expect(classifyOverlap(inputs(null, makeTemplate('a')))).toBe('no-overlap');
  });

  it('classifyOverlap returns superseding for sibling categories', () => {
    const a = makeTemplate('a', 'review');
    const b = makeTemplate('b', 'review');
    expect(classifyOverlap(inputs({ execution: makeExecution('a'), template: a }, b))).toBe('superseding');
  });
});
```

- [ ] **Step 2: Confirm fail**

```bash
npx vitest run src/main/workflows/__tests__/workflow-transition-policy.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Commit failing tests**

```bash
git add src/main/workflows/__tests__/workflow-transition-policy.spec.ts
git commit -m "test(workflow): failing tests for evaluateTransition policy (red)"
```

---

### Task 2.2: Implement `evaluateTransition`

**Files:**
- Create: `src/main/workflows/workflow-transition-policy.ts`

- [ ] **Step 1: Implement**

```ts
/**
 * WorkflowTransitionPolicy - pure evaluator for "may we start the requested
 * workflow given the current state?".
 *
 * Rules and matrix are documented in the Wave 3 design spec, § 2.1. Decision
 * logic is intentionally synchronous and side-effect-free so the same function
 * can be called from main (in `WorkflowManager.startWorkflow`) and renderer
 * (for previewing button enabled state).
 */

import type {
  WorkflowExecution,
  WorkflowTemplate,
  WorkflowTransitionInputs,
  WorkflowTransitionPolicy,
  WorkflowStartSource,
} from '../../shared/types/workflow.types';

export type WorkflowOverlapCategory =
  | 'no-overlap'
  | 'compatible'
  | 'incompatible'
  | 'superseding'
  | 'blocked';

type TemplateCategory = WorkflowTemplate['category'];

const COMPATIBLE_OVERLAP: Record<TemplateCategory, ReadonlySet<TemplateCategory>> = {
  development: new Set<TemplateCategory>(['review', 'debugging', 'custom']),
  review:      new Set<TemplateCategory>(['development', 'debugging', 'custom']),
  debugging:   new Set<TemplateCategory>(['development', 'review', 'custom']),
  custom:      new Set<TemplateCategory>(['development', 'review', 'debugging']),
};

export function evaluateTransition(
  i: WorkflowTransitionInputs,
): WorkflowTransitionPolicy {
  // Rule 8: source=restore is always allowed.
  if (i.source === 'restore') return { kind: 'allow' };

  // Rule 1: no active workflow.
  if (!i.current) return { kind: 'allow' };

  const { execution: cur, template: curT } = i.current;

  // Rule 3: completed execution is treated as no overlap.
  if (cur.completedAt) return { kind: 'allow' };

  // Rule 2: self-overlap.
  if (cur.templateId === i.requested.template.id) {
    return {
      kind: 'deny',
      reason: `Workflow ${curT.name} is already active.`,
      suggestedAction: cur.pendingGate ? 'open-active-gate' : 'cancel-current',
    };
  }

  // Rule 4: pending gate + nl-suggestion.
  if (cur.pendingGate && i.source === 'nl-suggestion') {
    return {
      kind: 'deny',
      reason: `Active workflow is awaiting your input on phase ${cur.pendingGate.phaseId}. Resolve it first.`,
      suggestedAction: 'open-active-gate',
    };
  }

  const sameCategory = curT.category === i.requested.template.category;
  const compatible = COMPATIBLE_OVERLAP[curT.category]?.has(i.requested.template.category) ?? false;

  if (sameCategory) {
    // Rule 9: automation never auto-completes; downgrade to deny so the
    // operator must intervene explicitly.
    if (i.source === 'automation') {
      return {
        kind: 'deny',
        reason: `Cannot supersede ${curT.name} from a background automation.`,
        suggestedAction: 'cancel-current',
      };
    }
    return { kind: 'autoCompleteCurrent' };
  }

  if (compatible) {
    return { kind: 'allowWithOverlap', maxConcurrent: 2 };
  }

  // Rule 7: incompatible.
  return {
    kind: 'deny',
    reason: `Cannot run ${i.requested.template.name} while ${curT.name} (${curT.category}) is active.`,
    suggestedAction: 'cancel-current',
  };
}

export function classifyOverlap(
  i: WorkflowTransitionInputs,
): WorkflowOverlapCategory {
  if (!i.current) return 'no-overlap';
  if (i.current.execution.completedAt) return 'no-overlap';
  if (i.current.execution.templateId === i.requested.template.id) return 'blocked';
  if (i.current.template.category === i.requested.template.category) return 'superseding';
  return COMPATIBLE_OVERLAP[i.current.template.category]?.has(i.requested.template.category)
    ? 'compatible'
    : 'incompatible';
}

/** Public for telemetry / Doctor; cheap to call. */
export function describeSource(s: WorkflowStartSource): string {
  switch (s) {
    case 'slash-command': return 'slash command';
    case 'nl-suggestion': return 'natural-language suggestion';
    case 'automation':    return 'automation';
    case 'manual-ui':     return 'manual UI';
    case 'restore':       return 'restore';
  }
}
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/main/workflows/__tests__/workflow-transition-policy.spec.ts
```

Expected: all green.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- --quiet src/main/workflows/workflow-transition-policy.ts
git add src/main/workflows/workflow-transition-policy.ts
git commit -m "feat(workflow): pure evaluateTransition + classifyOverlap policy evaluator"
```

---

## Phase 3 — Hook policy into `WorkflowManager.startWorkflow`

### Task 3.1: Add `WorkflowTransitionDenied` typed error

**Files:**
- Modify: `src/main/workflows/workflow-manager.ts`

- [ ] **Step 1: Read the existing file fully** before editing (especially `startWorkflow` lines 122–155 and the existing event emitter usage).

- [ ] **Step 2: Add the typed error class near the top of the file (after imports)**

```ts
import type { WorkflowTransitionPolicy } from '../../shared/types/workflow.types';

export class WorkflowTransitionDenied extends Error {
  override readonly name = 'WorkflowTransitionDenied';
  constructor(
    message: string,
    readonly policy: Extract<WorkflowTransitionPolicy, { kind: 'deny' }>,
  ) {
    super(message);
  }
}
```

- [ ] **Step 3: Verify and commit (no behavior change)**

```bash
npx tsc --noEmit
git add src/main/workflows/workflow-manager.ts
git commit -m "feat(workflow): add WorkflowTransitionDenied typed error class"
```

---

### Task 3.2: Write failing integration tests for the policy hook

**Files:**
- Create: `src/main/workflows/__tests__/workflow-manager-policy-integration.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowManager, WorkflowTransitionDenied } from '../workflow-manager';
import type { WorkflowTemplate } from '../../../shared/types/workflow.types';

const dummyTemplate = (id: string, category: WorkflowTemplate['category'] = 'review'): WorkflowTemplate => ({
  id, name: id, description: '', icon: '🧪', category,
  triggerPatterns: [], autoTrigger: false,
  phases: [{ id: 'p1', name: 'P1', description: '', order: 0, systemPromptAddition: '', gateType: 'none' }],
  estimatedDuration: '5m', requiredAgents: [],
});

describe('WorkflowManager + transition policy', () => {
  let mgr: WorkflowManager;

  beforeEach(() => {
    WorkflowManager._resetForTesting();
    mgr = WorkflowManager.getInstance();
    mgr.registerTemplate(dummyTemplate('a-review', 'review'));
    mgr.registerTemplate(dummyTemplate('b-review', 'review'));
    mgr.registerTemplate(dummyTemplate('c-debug', 'debugging'));
  });

  it('happy path: no overlap → start succeeds', () => {
    const exec = mgr.startWorkflow('inst-1', 'a-review', 'manual-ui');
    expect(exec.templateId).toBe('a-review');
  });

  it('autoCompleteCurrent: marks previous complete with superseded reason', () => {
    const a = mgr.startWorkflow('inst-1', 'a-review', 'manual-ui');
    const b = mgr.startWorkflow('inst-1', 'b-review', 'manual-ui');
    expect(b.templateId).toBe('b-review');
    // The auto-completed previous execution is no longer the active mapping
    // for inst-1, but we can fetch it by id.
    const prior = mgr.getExecution(a.id);
    expect(prior?.completedAt).toBeDefined();
    expect(prior?.transitionAutoCompletion?.reason).toBe('superseded');
    expect(prior?.transitionAutoCompletion?.supersededBy).toBe('b-review');
  });

  it('deny: nl-suggestion while pending gate throws WorkflowTransitionDenied', () => {
    const a = mgr.startWorkflow('inst-1', 'a-review', 'manual-ui');
    // simulate gate pending
    const exec = mgr.getExecution(a.id)!;
    exec.pendingGate = { phaseId: 'p1', gateType: 'user_confirmation', gatePrompt: '?', submittedAt: Date.now() };
    expect(() => mgr.startWorkflow('inst-1', 'b-review', 'nl-suggestion'))
      .toThrowError(WorkflowTransitionDenied);
  });

  it('allowWithOverlap: cross-category proceeds without auto-completing', () => {
    const a = mgr.startWorkflow('inst-1', 'a-review', 'manual-ui');
    // Cross-category overlap is allowed; current implementation maps to a fresh
    // execution but keeps the prior one accessible by id (not auto-completed).
    const b = mgr.startWorkflow('inst-1', 'c-debug', 'manual-ui');
    expect(b.templateId).toBe('c-debug');
    const prior = mgr.getExecution(a.id);
    expect(prior?.completedAt).toBeUndefined();
  });

  it('automation source on sibling overlap → deny (never auto-completes)', () => {
    mgr.startWorkflow('inst-1', 'a-review', 'manual-ui');
    expect(() => mgr.startWorkflow('inst-1', 'b-review', 'automation'))
      .toThrowError(WorkflowTransitionDenied);
  });
});
```

> If `WorkflowManager` does not currently expose a public `getExecution(id)`, add it (one-line getter) as part of Task 3.3. Spec uses it to assert on auto-completed previous execution state.

- [ ] **Step 2: Confirm fail**

```bash
npx vitest run src/main/workflows/__tests__/workflow-manager-policy-integration.spec.ts
```

Expected: FAIL — `startWorkflow` does not accept `source`, does not call policy, does not mark prior auto-completed.

- [ ] **Step 3: Commit failing tests**

```bash
git add src/main/workflows/__tests__/workflow-manager-policy-integration.spec.ts
git commit -m "test(workflow): failing integration tests for policy hook (red)"
```

---

### Task 3.3: Wire the policy into `startWorkflow`

**Files:**
- Modify: `src/main/workflows/workflow-manager.ts`

- [ ] **Step 1: Add a public getter (if absent)**

After the existing `private` field declarations, add:

```ts
public getExecution(id: string): WorkflowExecution | undefined {
  return this.executions.get(id);
}
```

(Skip if already present.)

- [ ] **Step 2: Replace `startWorkflow` body**

Replace the existing method (currently lines 122–155) with the policy-aware version:

```ts
startWorkflow(
  instanceId: string,
  templateId: string,
  source: WorkflowStartSource = 'manual-ui',
): WorkflowExecution {
  const requested = this.templates.get(templateId);
  if (!requested) throw new Error(`Template not found: ${templateId}`);

  const currentId = this.instanceExecutions.get(instanceId);
  const currentExecution = currentId ? this.executions.get(currentId) : undefined;
  const currentTemplate = currentExecution
    ? this.templates.get(currentExecution.templateId)
    : undefined;

  const policy = evaluateTransition({
    current: currentExecution && currentTemplate
      ? { execution: currentExecution, template: currentTemplate }
      : null,
    requested: { template: requested, instanceId },
    source,
  });

  if (policy.kind === 'deny') {
    this.emit('workflow:transition-denied', { policy, requested, source });
    throw new WorkflowTransitionDenied(
      `Cannot start ${requested.name}: ${policy.reason}`,
      policy,
    );
  }

  if (policy.kind === 'autoCompleteCurrent' && currentExecution && !currentExecution.completedAt) {
    currentExecution.completedAt = Date.now();
    currentExecution.transitionAutoCompletion = {
      reason: 'superseded',
      supersededBy: requested.id,
    };
    this.persistExecution(currentExecution);
    this.emit('workflow:auto-completed', { execution: currentExecution, supersededBy: requested.id });
    this.instanceExecutions.delete(instanceId);
  }

  const execution = createWorkflowExecution(instanceId, templateId, requested);
  this.executions.set(execution.id, execution);
  this.instanceExecutions.set(instanceId, execution.id);
  this.persistExecution(execution);
  this.emit('workflow:started', { execution, template: requested, policy });

  const firstPhase = requested.phases[0];
  if (firstPhase.agents) {
    setImmediate(() => {
      this.launchPhaseAgents(execution, firstPhase).catch((err) => {
        logger.error('Error launching phase agents', err instanceof Error ? err : undefined);
      });
    });
  }

  return execution;
}
```

Add the import at the top of the file:

```ts
import { evaluateTransition } from './workflow-transition-policy';
import type { WorkflowStartSource } from '../../shared/types/workflow.types';
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/main/workflows/__tests__/workflow-manager-policy-integration.spec.ts
npx vitest run src/main/workflows/__tests__/workflow-transition-policy.spec.ts
```

Expected: all green.

- [ ] **Step 4: Run the full workflow specs to ensure no regression**

```bash
npx vitest run src/main/workflows
```

If any prior spec relied on overlap throwing a generic Error rather than `WorkflowTransitionDenied`, update it to assert the new typed error. Document the change in the commit.

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/main/workflows/workflow-manager.ts src/main/workflows/__tests__/
git commit -m "feat(workflow): hook transition policy into startWorkflow + emit auto-completed/denied events"
```

---

## Phase 4 — `TranscriptSnippetService` (precompute on archive)

### Task 4.1: Write failing tests for the snippet extractor

**Files:**
- Create: `src/main/history/__tests__/transcript-snippet-service.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTranscriptSnippetService,
  _resetTranscriptSnippetServiceForTesting,
} from '../transcript-snippet-service';
import type { OutputMessage } from '../../../shared/types/instance.types';

const msg = (id: string, type: OutputMessage['type'], content: string, timestamp = Date.now()): OutputMessage => ({
  id, type, content, timestamp,
} as OutputMessage);

describe('TranscriptSnippetService.extractAtArchiveTime', () => {
  beforeEach(() => _resetTranscriptSnippetServiceForTesting());

  it('returns empty when messages is empty', () => {
    const out = getTranscriptSnippetService().extractAtArchiveTime({ messages: [] });
    expect(out).toEqual([]);
  });

  it('skips tool/system messages', () => {
    const out = getTranscriptSnippetService().extractAtArchiveTime({
      messages: [
        msg('1', 'tool' as OutputMessage['type'], 'tool output'),
        msg('2', 'system' as OutputMessage['type'], 'system note'),
        msg('3', 'user', 'how does the auth bug repro?'),
      ],
    });
    expect(out.length).toBe(1);
    expect(out[0].excerpt).toContain('auth');
  });

  it('caps at 5 snippets by default', () => {
    const messages: OutputMessage[] = Array.from({ length: 20 }, (_, i) =>
      msg(`u${i}`, 'user', `message about feature ${i}`)
    );
    const out = getTranscriptSnippetService().extractAtArchiveTime({ messages });
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('honors maxSnippets', () => {
    const messages: OutputMessage[] = Array.from({ length: 10 }, (_, i) =>
      msg(`u${i}`, 'user', `feature ${i}`)
    );
    const out = getTranscriptSnippetService().extractAtArchiveTime({ messages, maxSnippets: 2 });
    expect(out.length).toBe(2);
  });

  it('uses query for token-set scoring when supplied', () => {
    const messages: OutputMessage[] = [
      msg('1', 'user', 'fix the layout regression in the header'),
      msg('2', 'user', 'investigate the auth token refresh issue'),
      msg('3', 'user', 'add a unit test for parseArgs'),
    ];
    const out = getTranscriptSnippetService().extractAtArchiveTime({
      messages, query: 'auth token',
    });
    expect(out[0].excerpt).toMatch(/auth/i);
  });

  it('truncates excerpts to 240 chars with ellipsis', () => {
    const long = 'a'.repeat(500);
    const out = getTranscriptSnippetService().extractAtArchiveTime({
      messages: [msg('1', 'user', long)],
      maxExcerptChars: 240,
    });
    expect(out[0].excerpt.length).toBeLessThanOrEqual(240);
  });

  it('attaches stable `position` (buffer index of source message)', () => {
    const messages: OutputMessage[] = [
      msg('a', 'tool' as OutputMessage['type'], 'noise'),
      msg('b', 'user', 'meaningful content about auth'),
    ];
    const out = getTranscriptSnippetService().extractAtArchiveTime({ messages, query: 'auth' });
    expect(out[0].position).toBe(1);
  });
});
```

- [ ] **Step 2: Confirm fail**

```bash
npx vitest run src/main/history/__tests__/transcript-snippet-service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Commit failing tests**

```bash
git add src/main/history/__tests__/transcript-snippet-service.spec.ts
git commit -m "test(history): failing tests for TranscriptSnippetService.extractAtArchiveTime (red)"
```

---

### Task 4.2: Implement `TranscriptSnippetService`

**Files:**
- Create: `src/main/history/transcript-snippet-service.ts`

- [ ] **Step 1: Write the implementation**

```ts
import { getLogger } from '../logging/logger';
import type { OutputMessage } from '../../shared/types/instance.types';
import type { HistorySnippet } from '../../shared/types/history.types';

const logger = getLogger('TranscriptSnippetService');

const DEFAULT_MAX_SNIPPETS = 5;
const DEFAULT_EXCERPT_CHARS = 240;
const MIN_TOKEN_LENGTH = 3;

export interface SnippetExtractionInput {
  messages: OutputMessage[];
  query?: string;
  maxSnippets?: number;
  maxExcerptChars?: number;
}

export interface TranscriptSnippetService {
  extractAtArchiveTime(input: SnippetExtractionInput): HistorySnippet[];
  expandSnippetsOnDemand(
    entryId: string,
    query: string,
    opts?: { maxSnippets?: number; maxExcerptChars?: number },
  ): Promise<HistorySnippet[]>;
}

class DefaultTranscriptSnippetService implements TranscriptSnippetService {
  extractAtArchiveTime(input: SnippetExtractionInput): HistorySnippet[] {
    const max = input.maxSnippets ?? DEFAULT_MAX_SNIPPETS;
    const maxChars = input.maxExcerptChars ?? DEFAULT_EXCERPT_CHARS;
    const queryTokens = tokenize(input.query ?? '');
    const now = Date.now();

    const candidates: { position: number; score: number; content: string; ts: number }[] = [];
    input.messages.forEach((m, i) => {
      if (m.type !== 'user' && m.type !== 'assistant') return;
      const content = (m.content ?? '').toString();
      if (!content.trim()) return;

      const msgTokens = tokenize(content);
      const intersection = queryTokens.size === 0
        ? 1
        : countIntersection(msgTokens, queryTokens);
      if (queryTokens.size > 0 && intersection === 0) return;

      const recency = recencyDecay(m.timestamp ?? now, now);
      const score = (queryTokens.size === 0 ? recency : intersection * recency);
      candidates.push({ position: i, score, content, ts: m.timestamp ?? now });
    });

    candidates.sort((a, b) => b.score - a.score);

    return candidates.slice(0, max).map(c => ({
      position: c.position,
      excerpt: buildExcerpt(c.content, queryTokens, maxChars),
      score: round(c.score),
    }));
  }

  async expandSnippetsOnDemand(
    entryId: string,
    query: string,
    opts: { maxSnippets?: number; maxExcerptChars?: number } = {},
  ): Promise<HistorySnippet[]> {
    // Lazy import to avoid a singleton-cycle with HistoryManager.
    const { getHistoryManager } = await import('./history-manager');
    const data = await getHistoryManager().loadConversation(entryId);
    if (!data) {
      logger.warn('expandSnippetsOnDemand: entry not found', { entryId });
      return [];
    }
    return this.extractAtArchiveTime({
      messages: data.messages,
      query,
      maxSnippets: opts.maxSnippets,
      maxExcerptChars: opts.maxExcerptChars,
    });
  }
}

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .split(/\W+/u)
      .filter(t => t.length >= MIN_TOKEN_LENGTH),
  );
}

function countIntersection(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of b) if (a.has(t)) n += 1;
  return n;
}

function recencyDecay(messageTs: number, now: number): number {
  const ageMs = Math.max(0, now - messageTs);
  const oneDay = 24 * 60 * 60 * 1000;
  if (ageMs <= oneDay) return 1.0;
  if (ageMs <= 7 * oneDay) return 0.6;
  if (ageMs <= 30 * oneDay) return 0.3;
  return 0.1;
}

function buildExcerpt(content: string, queryTokens: Set<string>, maxChars: number): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;

  // Find the first occurrence of any query token; center the window around it.
  let center = 0;
  if (queryTokens.size > 0) {
    const lower = cleaned.toLowerCase();
    let earliest = -1;
    for (const t of queryTokens) {
      const idx = lower.indexOf(t);
      if (idx >= 0 && (earliest === -1 || idx < earliest)) earliest = idx;
    }
    if (earliest >= 0) center = earliest;
  }

  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, center - half);
  let end = Math.min(cleaned.length, start + maxChars);
  start = Math.max(0, end - maxChars);

  let excerpt = cleaned.slice(start, end);
  if (start > 0) excerpt = `…${excerpt}`;
  if (end < cleaned.length) excerpt = `${excerpt}…`;
  if (excerpt.length > maxChars) excerpt = excerpt.slice(0, maxChars - 1) + '…';
  return excerpt;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

let instance: TranscriptSnippetService | null = null;

export function getTranscriptSnippetService(): TranscriptSnippetService {
  if (!instance) instance = new DefaultTranscriptSnippetService();
  return instance;
}

export function _resetTranscriptSnippetServiceForTesting(): void {
  instance = null;
}
```

> If `getHistoryManager()` does not yet exist as a convenience getter, add it as a one-liner alongside `HistoryManager.getInstance()` (Task 5.1 will need it as well).

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/main/history/__tests__/transcript-snippet-service.spec.ts
```

Expected: all green.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- --quiet src/main/history/transcript-snippet-service.ts
git add src/main/history/transcript-snippet-service.ts
git commit -m "feat(history): add TranscriptSnippetService (extract + on-demand expand)"
```

---

### Task 4.3: Wire snippet precompute into `archiveInstance`

**Files:**
- Modify: `src/main/history/history-manager.ts`

- [ ] **Step 1: Read `archiveInstance` fully** (lines 67–210). Note that `messages` is already a snapshot in scope.

- [ ] **Step 2: Inject the snippet service**

Add the import:

```ts
import { getTranscriptSnippetService } from './transcript-snippet-service';
```

Inside `archiveInstance`, just before constructing `entry: ConversationHistoryEntry`, compute snippets:

```ts
const snippets = getTranscriptSnippetService().extractAtArchiveTime({ messages });
```

Then add `snippets` to the entry literal:

```ts
const entry: ConversationHistoryEntry = {
  // ...existing fields...
  executionLocation,
  snippets,
};
```

- [ ] **Step 3: Add a `getHistoryManager()` convenience getter (if absent)**

Below the class:

```ts
let _instance: HistoryManager | null = null;
export function getHistoryManager(): HistoryManager {
  if (!_instance) _instance = new HistoryManager();
  return _instance;
}
export function _resetHistoryManagerForTesting(): void {
  _instance = null;
}
```

(Skip if equivalent already exists.)

- [ ] **Step 4: Add a focused test**

Create `src/main/history/__tests__/history-manager-snippets.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/wave3-history-test' } }));

import { HistoryManager } from '../history-manager';
import type { Instance } from '../../../shared/types/instance.types';

describe('HistoryManager.archiveInstance — snippet precompute', () => {
  beforeEach(() => {
    // (use a temp dir per the existing spec patterns; redacted here for brevity)
  });

  it('writes precomputed snippets onto the archived entry', async () => {
    const mgr = new HistoryManager();
    const instance = {
      id: 'i-1',
      displayName: 'test',
      createdAt: Date.now(),
      workingDirectory: '/tmp',
      parentId: null,
      provider: 'claude',
      outputBuffer: [
        { id: 'm1', type: 'user', content: 'we have a regression in the auth flow', timestamp: Date.now() },
        { id: 'm2', type: 'assistant', content: 'I see — the session refresh path broke when we shipped X', timestamp: Date.now() },
      ],
    } as unknown as Instance;
    await mgr.archiveInstance(instance);
    const entry = mgr.getEntries({ workingDirectory: '/tmp' })[0];
    expect(entry.snippets?.length).toBeGreaterThan(0);
  });
});
```

> The exact temp-dir pattern matches the existing history-manager spec. Reuse helpers from there if present.

- [ ] **Step 5: Run, verify, commit**

```bash
npx vitest run src/main/history/__tests__/history-manager-snippets.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/main/history/history-manager.ts src/main/history/__tests__/history-manager-snippets.spec.ts
git commit -m "feat(history): precompute snippets at archive time and persist on entry"
```

---

### Task 4.5 (post-ship benchmark, NON-BLOCKING)

Per design § 2.3, `extractAtArchiveTime` is synchronous and O(n log n). For archives with >5,000 messages, archive latency may exceed 50ms.

- [ ] Create a quick benchmark script (NOT a CI-gated test): `scripts/bench/transcript-snippet-bench.ts`. Generate synthetic transcripts of 1k / 5k / 25k messages; time `extractAtArchiveTime` on each.
- [ ] If 5k or 25k case exceeds 50ms in a release build, file a follow-up issue: "Move snippet extraction to a worker thread or defer to `setImmediate`".
- [ ] No commit required if benchmarks pass. Document the numbers in the follow-up issue if they don't.
- [ ] Verification: manual benchmark; not part of `npm run test`.

This task is explicitly NON-blocking for Wave 3 acceptance — Wave 3 ships the synchronous implementation. Benchmarking is a defensive measurement.

---

## Phase 5 — Extend `HistoryManager.getEntries`

### Task 5.1: Failing tests for new options

**Files:**
- Modify: `src/main/history/__tests__/history-manager.spec.ts` (or create a sibling spec if the existing file is large; prefer a new `history-manager-advanced-options.spec.ts`)

- [ ] **Step 1: Write a new spec block (sibling file recommended)**

Create `src/main/history/__tests__/history-manager-advanced-options.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
// (use the same temp-dir + spec helpers as history-manager.spec.ts)

import { HistoryManager } from '../history-manager';
import type { ConversationHistoryEntry } from '../../../shared/types/history.types';

const seedEntries = (mgr: HistoryManager, entries: Partial<ConversationHistoryEntry>[]) => {
  // helper: monkey-patch the index for test seed (existing test pattern)
  // ...redacted: copy from history-manager.spec.ts...
};

describe('HistoryManager.getEntries — Wave 3 options', () => {
  it('paginates with page request', () => {
    const mgr = new HistoryManager();
    seedEntries(mgr, Array.from({ length: 25 }, (_, i) => ({ id: `e${i}`, endedAt: Date.now() - i * 1000 })));
    const page1 = mgr.getEntries({ page: { pageSize: 10, pageNumber: 1 } });
    const page2 = mgr.getEntries({ page: { pageSize: 10, pageNumber: 2 } });
    expect(page1.length).toBe(10);
    expect(page2.length).toBe(10);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it('filters by timeRange', () => {
    const mgr = new HistoryManager();
    seedEntries(mgr, [
      { id: 'old', endedAt: 1000 },
      { id: 'recent', endedAt: 9_000_000_000_000 },
    ]);
    const recent = mgr.getEntries({ timeRange: { from: 5000 } });
    expect(recent.map(e => e.id)).toEqual(['recent']);
  });

  it('filters by projectScope=current with workingDirectory', () => {
    const mgr = new HistoryManager();
    seedEntries(mgr, [
      { id: 'a', workingDirectory: '/x' },
      { id: 'b', workingDirectory: '/y' },
    ]);
    const a = mgr.getEntries({ workingDirectory: '/x', projectScope: 'current' });
    expect(a.map(e => e.id)).toEqual(['a']);
  });

  it('projectScope=all ignores workingDirectory filter', () => {
    const mgr = new HistoryManager();
    seedEntries(mgr, [
      { id: 'a', workingDirectory: '/x' },
      { id: 'b', workingDirectory: '/y' },
    ]);
    const all = mgr.getEntries({ workingDirectory: '/x', projectScope: 'all' });
    expect(all.length).toBe(2);
  });

  it('snippetQuery matches precomputed snippets', () => {
    const mgr = new HistoryManager();
    seedEntries(mgr, [
      { id: 'a', snippets: [{ position: 1, excerpt: 'auth bug fixed', score: 0.9 }] },
      { id: 'b', snippets: [{ position: 0, excerpt: 'layout tweaks', score: 0.5 }] },
    ]);
    const out = mgr.getEntries({ snippetQuery: 'auth' });
    expect(out.map(e => e.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Confirm fail**

```bash
npx vitest run src/main/history/__tests__/history-manager-advanced-options.spec.ts
```

- [ ] **Step 3: Commit failing tests**

```bash
git add src/main/history/__tests__/history-manager-advanced-options.spec.ts
git commit -m "test(history): failing tests for paginate/timeRange/projectScope/snippetQuery (red)"
```

---

### Task 5.2: Implement the new filters + pagination

**Files:**
- Modify: `src/main/history/history-manager.ts`

- [ ] **Step 0: Check for existing count method.** Read `src/main/history/history-manager.ts` end-to-end. If a method like `count()`, `getTotal()`, `countEntries()`, or `getEntriesTotalCount()` already exists, REUSE it instead of adding a new one. Match the existing visibility (private/public). If no count method exists, proceed below to add `countEntries(options)` as a public method that mirrors `getEntries` filtering and returns the unpaginated total.

- [ ] **Step 1: Replace `getEntries`**

Find the existing `getEntries(options?: HistoryLoadOptions)` method (around line 215) and replace with:

```ts
getEntries(options?: HistoryLoadOptions): ConversationHistoryEntry[] {
  let entries = [...this.index.entries];

  // ── existing metadata search ──
  if (options?.searchQuery) {
    const q = options.searchQuery.toLowerCase();
    entries = entries.filter(e =>
      e.displayName.toLowerCase().includes(q) ||
      e.firstUserMessage.toLowerCase().includes(q) ||
      e.lastUserMessage.toLowerCase().includes(q) ||
      e.workingDirectory.toLowerCase().includes(q)
    );
  }

  // ── projectScope (defaults to 'current' when workingDirectory set) ──
  const scope = options?.projectScope ?? (options?.workingDirectory ? 'current' : 'all');
  if (scope === 'current' && options?.workingDirectory) {
    entries = entries.filter(e => e.workingDirectory === options.workingDirectory);
  } else if (scope === 'none') {
    entries = entries.filter(e => !e.workingDirectory);
  }

  // ── timeRange (against endedAt) ──
  if (options?.timeRange) {
    const { from, to } = options.timeRange;
    if (from !== undefined) entries = entries.filter(e => e.endedAt >= from);
    if (to   !== undefined) entries = entries.filter(e => e.endedAt <= to);
  }

  // ── snippetQuery against precomputed snippets ──
  if (options?.snippetQuery) {
    const q = options.snippetQuery.toLowerCase();
    entries = entries.filter(e => (e.snippets ?? []).some(s => s.excerpt.toLowerCase().includes(q)));
  }

  // ── pagination ──
  if (options?.page) {
    const pageSize = clamp(options.page.pageSize, 1, 100);
    const pageNumber = Math.max(1, Math.floor(options.page.pageNumber));
    const start = (pageNumber - 1) * pageSize;
    return entries.slice(start, start + pageSize);
  }

  if (options?.limit && options.limit > 0) {
    entries = entries.slice(0, options.limit);
  }

  return entries;
}

private getEntriesTotalCount(options?: HistoryLoadOptions): number {
  // Reuse filtering logic without pagination; called by AdvancedHistorySearch.
  const opts = { ...(options ?? {}) };
  delete opts.page;
  delete opts.limit;
  return this.getEntries(opts).length;
}

// public alias used by IPC + AdvancedHistorySearch
public countEntries(options?: HistoryLoadOptions): number {
  return this.getEntriesTotalCount(options);
}
```

Add a helper at the top of the file (or in a sibling util):

```ts
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/main/history/__tests__/history-manager-advanced-options.spec.ts
npx vitest run src/main/history
```

Expected: all green; existing specs continue to pass.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/main/history/history-manager.ts
git commit -m "feat(history): paginate + timeRange + projectScope + snippetQuery filters in getEntries"
```

---

## Phase 6 — Add `'history-transcript'` source to `SessionRecallService`

### Task 6.1: Failing tests for the new source

**Files:**
- Create: `src/main/session/__tests__/session-recall-history-transcript.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/wave3-recall-test' } }));

import { SessionRecallService } from '../session-recall-service';
// stub providers (use existing test patterns: mock storage modules)

describe('SessionRecallService — history-transcript source', () => {
  it('returns no history-transcript results when includeHistoryTranscripts is false', async () => {
    const svc = new SessionRecallService(/* injected mocks producing 0 child/automation/etc results */);
    const out = await svc.search({ query: 'auth' });
    expect(out.filter(r => r.source === 'history-transcript')).toEqual([]);
  });

  it('includes history-transcript results when flag is true and matches found', async () => {
    // Inject a HistoryManager mock that returns one entry with a matching snippet.
    // ...
    const svc = new SessionRecallService(/* with mocked history manager */);
    const out = await svc.search({ query: 'auth', includeHistoryTranscripts: true });
    const ht = out.filter(r => r.source === 'history-transcript');
    expect(ht.length).toBeGreaterThan(0);
    expect(ht[0].metadata).toMatchObject({ entryId: expect.any(String) });
  });

  it('caps history-transcript results to maxHistoryTranscriptResults', async () => {
    const svc = new SessionRecallService(/* mocked to return 50 matches */);
    const out = await svc.search({ query: 'auth', includeHistoryTranscripts: true, maxHistoryTranscriptResults: 10 });
    expect(out.filter(r => r.source === 'history-transcript').length).toBeLessThanOrEqual(10);
  });
});
```

> Mocks: extend the existing recall spec patterns to inject a fake `HistoryManager` provider via constructor DI. If the constructor doesn't currently accept history, pass it as the 5th positional arg or via an options bag — match the existing project DI style.

- [ ] **Step 2: Confirm fail and commit**

```bash
npx vitest run src/main/session/__tests__/session-recall-history-transcript.spec.ts
git add src/main/session/__tests__/session-recall-history-transcript.spec.ts
git commit -m "test(session-recall): failing tests for history-transcript source (red)"
```

---

### Task 6.2: Implement the new source

**Files:**
- Modify: `src/main/session/session-recall-service.ts`

- [ ] **Step 1: Inject `HistoryManager`**

Add an optional dep to the constructor:

```ts
import { getHistoryManager, type HistoryManager } from '../history/history-manager';

export class SessionRecallService {
  constructor(
    private readonly automationStore: AutomationStore = getAutomationStore(),
    private readonly treePersistence = AgentTreePersistence.getInstance(),
    private readonly childResultStorage: ChildResultStorage = getChildResultStorage(),
    private readonly archiveManagerProvider: () => SessionArchiveManager = getSessionArchiveManager,
    private readonly historyProvider: () => HistoryManager = getHistoryManager,
  ) {}
  // ...
}
```

- [ ] **Step 2: Add the new source branch in `search()`**

Append (after the `archived_session` branch):

```ts
if (includeSource('history-transcript') && query.includeHistoryTranscripts === true) {
  const cap = query.maxHistoryTranscriptResults ?? 25;
  const entries = this.historyProvider().getEntries({
    snippetQuery: query.query,
    projectScope: 'all',
  });
  let added = 0;
  for (const entry of entries) {
    if (added >= cap) break;
    const matchedSnippets = (entry.snippets ?? []).filter(s =>
      s.excerpt.toLowerCase().includes(query.query.toLowerCase())
    );
    for (const snippet of matchedSnippets) {
      if (added >= cap) break;
      results.push({
        source: 'history-transcript',
        id: `${entry.id}:${snippet.position}`,
        title: entry.displayName,
        summary: compact(snippet.excerpt),
        score: snippet.score + scoreText(terms, entry.displayName) * 0.1,
        timestamp: entry.endedAt,
        sourceLink: { type: 'archived_session', ref: entry.id, label: 'Open archived session' },
        hasMore: (entry.snippets?.length ?? 0) > matchedSnippets.length,
        metadata: {
          entryId: entry.id,
          position: snippet.position,
          excerpt: snippet.excerpt,
          provider: entry.provider,
          workingDirectory: entry.workingDirectory,
          historyThreadId: entry.historyThreadId,
        },
      });
      added += 1;
    }
  }
}
```

- [ ] **Step 3: Run, verify, commit**

```bash
npx vitest run src/main/session/__tests__/session-recall-history-transcript.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/main/session/session-recall-service.ts
git commit -m "feat(session-recall): add history-transcript source gated by includeHistoryTranscripts"
```

---

## Phase 7 — `AdvancedHistorySearch` coordinator

### Task 7.1: Failing tests for the coordinator

**Files:**
- Create: `src/main/history/__tests__/advanced-history-search.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/wave3-advanced-test' } }));

import {
  getAdvancedHistorySearch,
  _resetAdvancedHistorySearchForTesting,
} from '../advanced-history-search';

// Spy on HistoryManager + SessionRecallService to verify delegation.

describe('AdvancedHistorySearch.search', () => {
  beforeEach(() => _resetAdvancedHistorySearchForTesting());

  it('history-transcript-only path delegates to HistoryManager only', async () => {
    // Stub HistoryManager.getEntries to return a known shape.
    // Stub SessionRecallService.search to throw if called.
    const svc = getAdvancedHistorySearch();
    const out = await svc.search({ snippetQuery: 'auth', source: 'history-transcript' });
    expect(out.entries.length).toBeGreaterThan(0);
    expect(out.recallResults).toEqual([]);
  });

  it('mixed-source path delegates to SessionRecallService with includeHistoryTranscripts:false', async () => {
    // Stub both; assert SessionRecallService was called with the right query.
    const svc = getAdvancedHistorySearch();
    const out = await svc.search({
      searchQuery: 'auth', source: ['child_result', 'history-transcript'],
    });
    expect(out.recallResults.length).toBeGreaterThanOrEqual(0);
  });

  it('paginates total count separately from page slice', async () => {
    const svc = getAdvancedHistorySearch();
    const out = await svc.search({ page: { pageSize: 10, pageNumber: 1 } });
    expect(out.page).toMatchObject({ pageNumber: 1, pageSize: 10, totalPages: expect.any(Number), totalCount: expect.any(Number) });
  });

  it('dedups by entryId across history + recall sources', async () => {
    // Inject mocks where SessionRecallService returns a history-transcript hit
    // for the same entryId that HistoryManager also returns.
    const svc = getAdvancedHistorySearch();
    const out = await svc.search({ snippetQuery: 'auth', source: ['history-transcript', 'child_result'] });
    const entryIds = out.entries.map(e => e.id);
    expect(new Set(entryIds).size).toBe(entryIds.length);
  });
});
```

- [ ] **Step 2: Confirm fail and commit**

```bash
npx vitest run src/main/history/__tests__/advanced-history-search.spec.ts
git add src/main/history/__tests__/advanced-history-search.spec.ts
git commit -m "test(history): failing tests for AdvancedHistorySearch coordinator (red)"
```

---

### Task 7.2: Implement the coordinator

**Files:**
- Create: `src/main/history/advanced-history-search.ts`

- [ ] **Step 1: Implement**

```ts
import { getLogger } from '../logging/logger';
import {
  type ConversationHistoryEntry,
  type HistoryLoadOptions,
  type HistorySearchSource,
  type HistoryTimeRange,
  type HistoryProjectScope,
  type HistoryPageRequest,
} from '../../shared/types/history.types';
import { getHistoryManager, type HistoryManager } from './history-manager';
import { SessionRecallService } from '../session/session-recall-service';
import type { SessionRecallResult, SessionRecallSource } from '../../shared/types/session-recall.types';

const logger = getLogger('AdvancedHistorySearch');

const HISTORY_ONLY_SOURCES: ReadonlySet<HistorySearchSource> = new Set(['history-transcript']);

export interface AdvancedHistorySearchInput {
  searchQuery?: string;
  snippetQuery?: string;
  workingDirectory?: string;
  projectScope?: HistoryProjectScope;
  source?: HistorySearchSource | HistorySearchSource[];
  timeRange?: HistoryTimeRange;
  page?: HistoryPageRequest;
}

export interface AdvancedHistorySearchResult {
  entries: ConversationHistoryEntry[];
  recallResults: SessionRecallResult[];
  page: {
    pageNumber: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

export interface AdvancedHistorySearch {
  search(input: AdvancedHistorySearchInput): Promise<AdvancedHistorySearchResult>;
}

class DefaultAdvancedHistorySearch implements AdvancedHistorySearch {
  constructor(
    private readonly history: HistoryManager = getHistoryManager(),
    private readonly recall: SessionRecallService = new SessionRecallService(),
  ) {}

  async search(input: AdvancedHistorySearchInput): Promise<AdvancedHistorySearchResult> {
    const sources = normalizeSources(input.source);
    const wantsHistory = sources.has('history-transcript');
    const otherSources = [...sources].filter((s): s is Exclude<HistorySearchSource, 'history-transcript'> => s !== 'history-transcript');

    // Build the HistoryManager options
    const historyOpts: HistoryLoadOptions = {
      searchQuery: input.searchQuery,
      snippetQuery: input.snippetQuery,
      workingDirectory: input.workingDirectory,
      projectScope: input.projectScope,
      timeRange: input.timeRange,
    };

    let entries: ConversationHistoryEntry[] = [];
    let totalCount = 0;
    if (wantsHistory) {
      totalCount = this.history.countEntries(historyOpts);
      entries = this.history.getEntries({
        ...historyOpts,
        page: input.page,
      });
    }

    // Delegate other sources to SessionRecallService
    let recallResults: SessionRecallResult[] = [];
    if (otherSources.length > 0) {
      try {
        recallResults = await this.recall.search({
          query: input.searchQuery ?? input.snippetQuery ?? '',
          sources: otherSources as SessionRecallSource[],
          // We do NOT include history-transcript here — history is sourced
          // directly above to keep pagination/total counts deterministic.
          includeHistoryTranscripts: false,
        });
      } catch (err) {
        logger.warn('AdvancedHistorySearch recall delegation failed', { err: String(err) });
        recallResults = [];
      }
    }

    // Dedup history-transcript matches that overlap with recall recall_results
    // (rare but possible if other sources surface the same entryId).
    const entryIds = new Set(entries.map(e => e.id));
    recallResults = recallResults.filter(r => {
      const eid = r.metadata?.entryId as string | undefined;
      return !eid || !entryIds.has(eid);
    });

    const pageSize = input.page?.pageSize ?? entries.length;
    const pageNumber = input.page?.pageNumber ?? 1;
    const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1;

    return {
      entries,
      recallResults,
      page: { pageNumber, pageSize, totalCount, totalPages },
    };
  }
}

function normalizeSources(s: HistorySearchSource | HistorySearchSource[] | undefined): Set<HistorySearchSource> {
  if (!s) return new Set<HistorySearchSource>(['history-transcript']);
  return new Set(Array.isArray(s) ? s : [s]);
}

let instance: AdvancedHistorySearch | null = null;
export function getAdvancedHistorySearch(): AdvancedHistorySearch {
  if (!instance) instance = new DefaultAdvancedHistorySearch();
  return instance;
}
export function _resetAdvancedHistorySearchForTesting(): void {
  instance = null;
}
```

- [ ] **Step 2: Run, verify, commit**

```bash
npx vitest run src/main/history/__tests__/advanced-history-search.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/main/history/advanced-history-search.ts
git commit -m "feat(history): AdvancedHistorySearch coordinator (history + session-recall delegate)"
```

---

## Phase 8 — IPC handlers + preload bridges

### Task 8.1: Add channel constants

**Files:**
- Modify: `packages/contracts/src/channels/session.channels.ts`
- Create: `packages/contracts/src/channels/workflow.channels.ts`
- Modify: `src/preload/generated/channels.ts` (regenerate or sync; see existing pattern)

- [ ] **Step 1: Extend `session.channels.ts`**

Append inside the `as const` object:

```ts
HISTORY_SEARCH_ADVANCED: 'history:search-advanced',
HISTORY_EXPAND_SNIPPETS: 'history:expand-snippets',
RESUME_LATEST: 'resume:latest',
RESUME_BY_ID: 'resume:by-id',
RESUME_SWITCH_TO_LIVE: 'resume:switch-to-live',
RESUME_FORK_NEW: 'resume:fork-new',
RESUME_RESTORE_FALLBACK: 'resume:restore-fallback',
```

- [ ] **Step 2: Create `workflow.channels.ts`**

```ts
export const WORKFLOW_CHANNELS = {
  WORKFLOW_CAN_TRANSITION: 'workflow:can-transition',
  WORKFLOW_NL_SUGGEST: 'workflow:nl-suggest',
  // existing workflow channels (start/complete/cancel) live elsewhere — do NOT
  // duplicate them here.
} as const;
```

- [ ] **Step 3: Sync `src/preload/generated/channels.ts`**

If the project regenerates this file from the contracts package, run the generator (check `package.json` scripts for `gen:channels` or similar). Otherwise mirror the additions manually.

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit
git add packages/contracts/src/channels/ src/preload/generated/channels.ts
git commit -m "feat(ipc): add channel constants for history-search-advanced + resume:* + workflow:can-transition + workflow:nl-suggest"
```

---

### Task 8.2: Add Zod schemas

**Files:**
- Modify: `packages/contracts/src/schemas/session.schemas.ts`
- Create: `packages/contracts/src/schemas/workflow.schemas.ts`

- [ ] **Step 1: Read the existing `session.schemas.ts`** to understand its export pattern (named exports, imports of `z`).

- [ ] **Step 2: Append history search schemas**

```ts
export const HistoryTimeRangeSchema = z.object({
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
});
export const HistoryProjectScopeSchema = z.enum(['current', 'all', 'none']);
export const HistorySearchSourceSchema = z.enum([
  'history-transcript', 'child_result', 'child_diagnostic', 'automation_run', 'agent_tree', 'archived_session',
]);
export const HistoryPageRequestSchema = z.object({
  pageSize: z.number().int().min(1).max(100),
  pageNumber: z.number().int().min(1),
});

export const HistorySearchAdvancedPayloadSchema = z.object({
  searchQuery: z.string().optional(),
  snippetQuery: z.string().optional(),
  workingDirectory: z.string().optional(),
  projectScope: HistoryProjectScopeSchema.optional(),
  source: z.union([HistorySearchSourceSchema, z.array(HistorySearchSourceSchema)]).optional(),
  timeRange: HistoryTimeRangeSchema.optional(),
  page: HistoryPageRequestSchema.optional(),
});

export const HistoryExpandSnippetsPayloadSchema = z.object({
  entryId: z.string().min(1),
  query: z.string().min(1),
});

export const ResumeLatestPayloadSchema = z.object({
  workingDirectory: z.string().optional(),
});
export const ResumeByIdPayloadSchema = z.object({ entryId: z.string().min(1) });
export const ResumeSwitchToLivePayloadSchema = z.object({ instanceId: z.string().min(1) });
export const ResumeForkNewPayloadSchema = z.object({ entryId: z.string().min(1) });
export const ResumeRestoreFallbackPayloadSchema = z.object({ entryId: z.string().min(1) });
```

- [ ] **Step 3: Create `workflow.schemas.ts`**

```ts
import { z } from 'zod';

export const WorkflowStartSourceSchema = z.enum([
  'slash-command', 'nl-suggestion', 'automation', 'manual-ui', 'restore',
]);

export const WorkflowCanTransitionPayloadSchema = z.object({
  instanceId: z.string().min(1),
  templateId: z.string().min(1),
  source: WorkflowStartSourceSchema,
});

export const WorkflowNlSuggestPayloadSchema = z.object({
  promptText: z.string().min(1),
  provider: z.string().optional(),
  workingDirectory: z.string().optional(),
});
```

- [ ] **Step 4: Add 4-place alias sync for the new `@contracts/schemas/workflow` subpath**

Per design decision #12 (revised): `workflow.schemas.ts` is a NEW file with no existing alias, so it requires the 4-place sync per AGENTS.md packaging gotcha #1. Update each of the following to add `'@contracts/schemas/workflow'`:

  - `tsconfig.json` — add `"@contracts/schemas/workflow": ["./packages/contracts/src/schemas/workflow.schemas"]` to `compilerOptions.paths` (mirror the existing `@contracts/schemas/session` entry).
  - `tsconfig.electron.json` — same path entry under its `compilerOptions.paths`.
  - `src/main/register-aliases.ts` — add `'@contracts/schemas/workflow': path.join(baseContracts, 'schemas', 'workflow.schemas'),` (mirror the existing `@contracts/schemas/session` entry).
  - `vitest.config.ts` — add the same alias under `resolve.alias` (only required if any test imports from `@contracts/schemas/workflow`; if no spec imports it, the entry is still recommended for consistency).

`session.schemas.ts` is reused (existing alias `@contracts/schemas/session`); no sync needed for it.

- [ ] **Step 5: Verify the contracts package still compiles**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

If `tsc` cannot resolve `@contracts/schemas/workflow`, re-check Step 4 — one of the four sync points is missing. Wave 7's `scripts/check-contracts-aliases.ts` (added in Wave 7 Phase 3) will guard this in CI; this wave's local check is preventative.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/schemas/ tsconfig.json tsconfig.electron.json src/main/register-aliases.ts vitest.config.ts
git commit -m "feat(contracts): add Zod schemas + 4-place alias sync for workflow subpath"
```

---

### Task 8.3a (prerequisite): Verify or extend `InstanceLifecycle.restoreFromHistory` signature

> **Grounded in source reading:** As of today, `restoreFromHistory` does NOT exist on `InstanceLifecycleManager` (`src/main/instance/instance-lifecycle.ts`). The current restore path lives entirely inside the `HISTORY_RESTORE` IPC handler (`src/main/ipc/handlers/session-handlers.ts`, around line 1013), which calls `history.loadConversation(entryId)` then `instanceManager.createInstance(...)`. Wave 3's resume actions need a single typed entry point that supports `forkAs` and `forceFallback` without re-implementing the recovery-plan / native-resume / replay-fallback dance in three separate handlers.
>
> The cleanest move: extract the existing `HISTORY_RESTORE` body into a method on `InstanceLifecycleManager` (or a sibling `RestoreCoordinator` module if `instance-lifecycle.ts` is already too large), with the new opts param. Existing `HISTORY_RESTORE` handler then delegates to it. New resume handlers (Task 8.3) call the same method.

- [ ] Read `src/main/instance/instance-lifecycle.ts` and `src/main/ipc/handlers/session-handlers.ts` (the `HISTORY_RESTORE` handler, lines 1013–1465). Decide whether to host the new method on `InstanceLifecycleManager` directly or in a sibling coordinator (`src/main/instance/lifecycle/restore-coordinator.ts`).
- [ ] Define the method signature:
  ```ts
  restoreFromHistory(
    entryId: string,
    opts?: {
      forkAs?: { sessionId: string; historyThreadId: string };
      forceFallback?: boolean;
    },
  ): Promise<{
    success: boolean;
    instanceId?: string;
    restoreMode?: 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';
    error?: string;
  }>;
  ```
- [ ] Move the existing `HISTORY_RESTORE` body into the new method, parametrizing on `opts`:
  - `opts.forkAs?.sessionId` overrides `nativeResumeSessionId` and the new instance's `sessionId`.
  - `opts.forkAs?.historyThreadId` overrides the resolved `historyThreadId`.
  - `opts.forceFallback === true` skips the native-resume attempt and goes straight to replay-fallback (preserves the existing fallback path for the picker's `restoreFromFallback` action).
  - Defaults (`opts === undefined`): legacy behavior — identical to today's `HISTORY_RESTORE` flow.
- [ ] Update the existing `HISTORY_RESTORE` handler to delegate to the new method (no behavior change for legacy callers).
- [ ] Add a unit test in `src/main/instance/__tests__/instance-lifecycle-fork.spec.ts` covering: no opts (legacy parity), `forkAs` (new IDs propagated to the created instance), `forceFallback` (no native-resume attempt; replay-fallback runs).
- Verification: `npx vitest run src/main/instance/__tests__/instance-lifecycle-fork.spec.ts`
- Commit: `feat(lifecycle): support forkAs and forceFallback options for restoreFromHistory`

---

### Task 8.3: Implement IPC handlers

**Files:**
- Create: `src/main/ipc/handlers/history-search-handlers.ts`
- Create: `src/main/ipc/handlers/resume-handlers.ts`
- Create: `src/main/ipc/handlers/workflow-handlers.ts`
- Modify: `src/main/index.ts` (register all three)

**Shared response shape** — every handler in this task returns one of:

```ts
type HandlerResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
```

When `ok` is `false`, the response **does NOT** include a `data` field (omitted, not `undefined`). Renderers must always check `res.ok` before accessing `res.data`. This is enforced in tests (Task 8.3 Step 4).

- [ ] **Step 1: Write `history-search-handlers.ts`**

```ts
import { ipcMain } from 'electron';
import { SESSION_CHANNELS } from '@contracts/channels/session.channels';
import {
  HistorySearchAdvancedPayloadSchema,
  HistoryExpandSnippetsPayloadSchema,
} from '@contracts/schemas/session';
import { getAdvancedHistorySearch } from '../../history/advanced-history-search';
import { getTranscriptSnippetService } from '../../history/transcript-snippet-service';
import { getLogger } from '../../logging/logger';

const logger = getLogger('HistorySearchHandlers');

export function registerHistorySearchHandlers(): void {
  ipcMain.handle(SESSION_CHANNELS.HISTORY_SEARCH_ADVANCED, async (_e, raw) => {
    const parsed = HistorySearchAdvancedPayloadSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    try {
      const result = await getAdvancedHistorySearch().search(parsed.data);
      return { ok: true, data: result };
    } catch (err) {
      logger.error('search-advanced failed', err instanceof Error ? err : undefined);
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(SESSION_CHANNELS.HISTORY_EXPAND_SNIPPETS, async (_e, raw) => {
    const parsed = HistoryExpandSnippetsPayloadSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    try {
      const snippets = await getTranscriptSnippetService().expandSnippetsOnDemand(
        parsed.data.entryId, parsed.data.query,
      );
      return { ok: true, data: snippets };
    } catch (err) {
      logger.error('expand-snippets failed', err instanceof Error ? err : undefined);
      return { ok: false, error: String(err) };
    }
  });
}
```

- [ ] **Step 2: Write `resume-handlers.ts`**

```ts
import { ipcMain } from 'electron';
import { SESSION_CHANNELS } from '@contracts/channels/session.channels';
import {
  ResumeLatestPayloadSchema,
  ResumeByIdPayloadSchema,
  ResumeSwitchToLivePayloadSchema,
  ResumeForkNewPayloadSchema,
  ResumeRestoreFallbackPayloadSchema,
} from '@contracts/schemas/session';
import { getHistoryManager } from '../../history/history-manager';
import { getInstanceLifecycle } from '../../instance/instance-lifecycle';
import { generateId } from '../../../shared/utils/id-generator';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ResumeHandlers');

export function registerResumeHandlers(): void {
  ipcMain.handle(SESSION_CHANNELS.RESUME_LATEST, async (_e, raw) => {
    const parsed = ResumeLatestPayloadSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const candidates = getHistoryManager().getEntries({
      workingDirectory: parsed.data.workingDirectory,
      projectScope: parsed.data.workingDirectory ? 'current' : 'all',
      limit: 1,
    });
    if (candidates.length === 0) return { ok: false, error: 'No archived threads found' };
    const restored = await getInstanceLifecycle().restoreFromHistory(candidates[0].id);
    return restored.success
      ? { ok: true, data: { instanceId: restored.instanceId } }
      : { ok: false, error: restored.error ?? 'Resume failed' };
  });

  ipcMain.handle(SESSION_CHANNELS.RESUME_BY_ID, async (_e, raw) => {
    const parsed = ResumeByIdPayloadSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const restored = await getInstanceLifecycle().restoreFromHistory(parsed.data.entryId);
    return restored.success
      ? { ok: true, data: { instanceId: restored.instanceId } }
      : { ok: false, error: restored.error ?? 'Resume failed' };
  });

  ipcMain.handle(SESSION_CHANNELS.RESUME_SWITCH_TO_LIVE, async (_e, raw) => {
    const parsed = ResumeSwitchToLivePayloadSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    // Renderer-side concern; handler asserts liveness by checking the instance store.
    const inst = getInstanceLifecycle().getInstance(parsed.data.instanceId);
    if (!inst) return { ok: false, error: 'Live instance not found' };
    return { ok: true, data: { instanceId: parsed.data.instanceId } };
  });

  ipcMain.handle(SESSION_CHANNELS.RESUME_FORK_NEW, async (_e, raw) => {
    const parsed = ResumeForkNewPayloadSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.message };

    // Locked decision #5: forks generate BOTH a new sessionId AND a new historyThreadId.
    const newSessionId = `fork-${Date.now()}-${generateId()}`;
    const newHistoryThreadId = generateId();

    // Force the lifecycle to use the fresh ids when restoring (overrideNewIds path).
    const restored = await getInstanceLifecycle().restoreFromHistory(parsed.data.entryId, {
      forkAs: { sessionId: newSessionId, historyThreadId: newHistoryThreadId },
    });
    if (!restored.success || !restored.instanceId) {
      logger.warn('fork-new restore failed', { error: restored.error });
      return { ok: false, error: restored.error ?? 'Fork failed' };
    }
    return {
      ok: true,
      data: {
        instanceId: restored.instanceId,
        newSessionId,
        newHistoryThreadId,
      },
    };
  });

  ipcMain.handle(SESSION_CHANNELS.RESUME_RESTORE_FALLBACK, async (_e, raw) => {
    const parsed = ResumeRestoreFallbackPayloadSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const restored = await getInstanceLifecycle().restoreFromHistory(parsed.data.entryId, {
      forceFallback: true,
    });
    return restored.success && restored.restoreMode
      ? { ok: true, data: { instanceId: restored.instanceId, restoreMode: restored.restoreMode } }
      : { ok: false, error: restored.error ?? 'Fallback restore failed' };
  });
}
```

> If `InstanceLifecycle.restoreFromHistory` does not yet accept `{ forkAs, forceFallback }`, add those options as part of this task. Mirror the existing options pattern; do not break other callers.

- [ ] **Step 3: Write `workflow-handlers.ts`**

```ts
import { ipcMain } from 'electron';
import { WORKFLOW_CHANNELS } from '@contracts/channels/workflow.channels';
import {
  WorkflowCanTransitionPayloadSchema,
  WorkflowNlSuggestPayloadSchema,
} from '@contracts/schemas/workflow';
import { WorkflowManager } from '../../workflows/workflow-manager';
import { evaluateTransition } from '../../workflows/workflow-transition-policy';
import { getNlWorkflowClassifier } from '../../session/nl-workflow-classifier';

export function registerWorkflowHandlers(): void {
  ipcMain.handle(WORKFLOW_CHANNELS.WORKFLOW_CAN_TRANSITION, async (_e, raw) => {
    const parsed = WorkflowCanTransitionPayloadSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const mgr = WorkflowManager.getInstance();
    const requested = mgr.getTemplate(parsed.data.templateId);
    if (!requested) return { ok: false, error: 'Template not found' };
    const currentExecutionId = mgr.getActiveExecutionForInstance?.(parsed.data.instanceId);
    const currentExecution = currentExecutionId ? mgr.getExecution(currentExecutionId) : undefined;
    const currentTemplate = currentExecution ? mgr.getTemplate(currentExecution.templateId) : undefined;
    const policy = evaluateTransition({
      current: currentExecution && currentTemplate
        ? { execution: currentExecution, template: currentTemplate }
        : null,
      requested: { template: requested, instanceId: parsed.data.instanceId },
      source: parsed.data.source,
    });
    return { ok: true, data: policy };
  });

  ipcMain.handle(WORKFLOW_CHANNELS.WORKFLOW_NL_SUGGEST, async (_e, raw) => {
    const parsed = WorkflowNlSuggestPayloadSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const suggestion = getNlWorkflowClassifier().classify(
      parsed.data.promptText,
      { provider: parsed.data.provider, workingDirectory: parsed.data.workingDirectory },
    );
    return { ok: true, data: suggestion };
  });
}
```

> Add `getActiveExecutionForInstance(instanceId)` getter to `WorkflowManager` if absent (reads `instanceExecutions`).

- [ ] **Step 4: Register handlers in `src/main/index.ts`**

After the existing handler registrations, add:

```ts
import { registerHistorySearchHandlers } from './ipc/handlers/history-search-handlers';
import { registerResumeHandlers } from './ipc/handlers/resume-handlers';
import { registerWorkflowHandlers } from './ipc/handlers/workflow-handlers';

registerHistorySearchHandlers();
registerResumeHandlers();
registerWorkflowHandlers();
```

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/main/ipc/handlers/ src/main/index.ts src/main/workflows/workflow-manager.ts
git commit -m "feat(ipc): handlers for history-search-advanced + resume:* + workflow:can-transition / nl-suggest"
```

---

### Task 8.4: Extend preload bridges

**Files:**
- Modify: `src/preload/domains/session.preload.ts`
- Create: `src/preload/domains/workflow.preload.ts`
- Modify: `src/preload/preload.ts`

- [ ] **Step 1: Append to `session.preload.ts`**

Inside the same `return { ... }` block (after `clearHistory`):

```ts
searchHistoryAdvanced: (input: AdvancedHistorySearchInput) =>
  ipcRenderer.invoke(ch.HISTORY_SEARCH_ADVANCED, input),
expandHistorySnippets: (entryId: string, query: string) =>
  ipcRenderer.invoke(ch.HISTORY_EXPAND_SNIPPETS, { entryId, query }),
resumeLatest: (workingDirectory?: string) =>
  ipcRenderer.invoke(ch.RESUME_LATEST, { workingDirectory }),
resumeById: (entryId: string) =>
  ipcRenderer.invoke(ch.RESUME_BY_ID, { entryId }),
switchToLive: (instanceId: string) =>
  ipcRenderer.invoke(ch.RESUME_SWITCH_TO_LIVE, { instanceId }),
forkNew: (entryId: string) =>
  ipcRenderer.invoke(ch.RESUME_FORK_NEW, { entryId }),
restoreFromFallback: (entryId: string) =>
  ipcRenderer.invoke(ch.RESUME_RESTORE_FALLBACK, { entryId }),
```

Add the import for the input type at the top.

- [ ] **Step 2: Create `workflow.preload.ts` as a domain factory**

> **Repo-specific preload pattern:** Sandboxed preload cannot import from `packages/` at runtime (per `src/preload/preload.ts` header comment). Each domain is a factory `createXxxDomain(ipcRenderer, IPC_CHANNELS)` returning methods to be flat-spread into the single `electronAPI` exposed via `contextBridge.exposeInMainWorld('electronAPI', electronAPI)`. Channels come from the generated `src/preload/generated/channels.ts`, NOT from `@contracts/channels/...` directly.

Create `src/preload/domains/workflow.preload.ts` mirroring `session.preload.ts`:

```ts
import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createWorkflowDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    workflowCanTransition: (input: { instanceId: string; templateId: string; source: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.WORKFLOW_CAN_TRANSITION, input),

    workflowNlSuggest: (input: { promptText: string; provider?: string; workingDirectory?: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.WORKFLOW_NL_SUGGEST, input),
  };
}
```

- [ ] **Step 3: Wire the factory into `preload.ts`**

In `src/preload/preload.ts`, mirror the existing composition pattern:

```ts
import { createWorkflowDomain } from './domains/workflow.preload';

const electronAPI = {
  ...createInstanceDomain(ipcRenderer, IPC_CHANNELS),
  // ... existing factories ...
  ...createWorkflowDomain(ipcRenderer, IPC_CHANNELS),
  platform: process.platform,
};
```

The renderer accesses these via `window.electronAPI.workflowCanTransition(...)` (typically through `ElectronIpcService`'s typed `api` field). Do NOT introduce a separate `window.workflow` global — Wave 3 follows the existing flat-namespace pattern.

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/preload/
git commit -m "feat(preload): expose history-search-advanced + resume:* + workflow:* via session/workflow domains"
```

---

## Phase 9 — Renderer `HistoryStore` extension

### Task 9.1: Add advanced-search state + IPC bridge

**Files:**
- Modify: `src/renderer/app/core/state/history.store.ts`

- [ ] **Step 1: Read the existing `HistoryStore`** to see the current signal pattern.

- [ ] **Step 2: Add new signals**

Inside the class:

```ts
private _advancedResults = signal<AdvancedHistorySearchResult | null>(null);
readonly advancedResults = this._advancedResults.asReadonly();

private _searching = signal(false);
readonly searching = this._searching.asReadonly();

async searchAdvanced(input: AdvancedHistorySearchInput): Promise<void> {
  this._searching.set(true);
  try {
    const res = await window.electronAPI.session.searchHistoryAdvanced(input);
    if (res.ok) this._advancedResults.set(res.data);
    else this._advancedResults.set(null);
  } finally {
    this._searching.set(false);
  }
}

async expandSnippets(entryId: string, query: string): Promise<HistorySnippet[]> {
  const res = await window.electronAPI.session.expandHistorySnippets(entryId, query);
  return res.ok ? res.data : [];
}
```

Add the necessary imports.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/renderer/app/core/state/history.store.ts
git commit -m "feat(history-store): advanced search + snippet expand bridges"
```

---

## Phase 10 — `ResumePickerController` + host (consumes Wave 1)

> **Wave 1 prerequisite:** verify Wave 1 has shipped before starting this phase. Check `src/renderer/app/shared/overlay-shell/overlay-shell.component.ts` exists. If not, stop here and report.

### Task 10.0 (precheck): Verify Wave 1 is shipped

- [ ] Confirm `OverlayShellComponent` exists at `src/renderer/app/features/overlay/overlay-shell.component.ts` (or wherever Wave 1 placed it — check both `src/renderer/app/features/overlay/` and `src/renderer/app/shared/overlay-shell/`).
- [ ] Confirm `OverlayController<T>` interface is exported and importable.
- [ ] Confirm `UsageStore` (with `frecency()` API) is registered as an injectable signal store.
- [ ] If any of the above are missing, **STOP and escalate**. Do not proceed with Phases 10–14. Phases 1–9 (backend) can still ship as-is; Phases 10–14 are blocked until Wave 1 lands.
- [ ] No commit; this is a verification gate.

---

### Task 10.1: Add `ResumePickerItem` types and `ResumeActionsService`

**Files:**
- Create: `src/renderer/app/features/resume/resume-picker.types.ts`
- Create: `src/renderer/app/features/resume/resume-actions.service.ts`

- [ ] **Step 1: Write `resume-picker.types.ts`**

(See § 1.5 of the design spec for the verbatim shape — paste the `ResumePickerAction` union and `ResumePickerItem` interface.)

- [ ] **Step 2: Write `resume-actions.service.ts`**

```ts
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ResumeActionsService {
  resumeLatest(workingDirectory: string | null) {
    return window.electronAPI.session.resumeLatest(workingDirectory ?? undefined);
  }
  resumeById(entryId: string) {
    return window.electronAPI.session.resumeById(entryId);
  }
  switchToLive(instanceId: string) {
    return window.electronAPI.session.switchToLive(instanceId);
  }
  forkNew(entryId: string) {
    return window.electronAPI.session.forkNew(entryId);
  }
  restoreFromFallback(entryId: string) {
    return window.electronAPI.session.restoreFromFallback(entryId);
  }
}
```

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add src/renderer/app/features/resume/
git commit -m "feat(resume): add ResumePickerItem types and ResumeActionsService"
```

---

### Task 10.2: Implement `ResumePickerController`

**Files:**
- Create: `src/renderer/app/features/resume/resume-picker.controller.ts`
- Create: `src/renderer/app/features/resume/__tests__/resume-picker.controller.spec.ts`

- [ ] **Step 1: Write the spec first**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ResumePickerController } from '../resume-picker.controller';

describe('ResumePickerController', () => {
  beforeEach(() => TestBed.configureTestingModule({}));

  it('exposes the expected mode label and placeholder', () => {
    const ctrl = TestBed.inject(ResumePickerController);
    expect(ctrl.id).toBe('resume-picker');
    expect(ctrl.modeLabel).toBe('Resume');
    expect(ctrl.placeholder).toMatch(/threads/i);
  });

  it('groups archived and live separately', async () => {
    // seed HistoryStore + InstanceStore with mocks; assert groups[0] is "Live" and groups[1] is "Recent"
  });

  it('availableActions includes restoreFromFallback only when nativeResumeFailedAt is set', async () => {
    // ...
  });

  it('forkNew action call uses ResumeActionsService.forkNew', async () => {
    // ...
  });
});
```

- [ ] **Step 2: Implement the controller**

Skeleton (fill in idiomatic signal/computed plumbing):

```ts
import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  OverlayController,
  OverlayGroup,
  OverlayItem,
  FooterHint,
} from '../../shared/overlay-shell/overlay-controller';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { UsageStore } from '../../core/state/usage.store';
import { ResumeActionsService } from './resume-actions.service';
import type { ResumePickerItem, ResumePickerAction } from './resume-picker.types';

@Injectable({ providedIn: 'root' })
export class ResumePickerController implements OverlayController<ResumePickerItem> {
  readonly id = 'resume-picker';
  readonly modeLabel = 'Resume';
  readonly placeholder = 'Search threads to resume…';

  private readonly historyStore = inject(HistoryStore);
  private readonly instanceStore = inject(InstanceStore);
  private readonly usageStore = inject(UsageStore);
  private readonly actions = inject(ResumeActionsService);

  private _query = signal('');
  private _selectedKey = signal<string | null>(null);
  private _lastError = signal<{ message: string; kind: string } | null>(null);

  readonly query = this._query.asReadonly();
  readonly selectedKey = this._selectedKey.asReadonly();
  readonly lastError = this._lastError.asReadonly();
  readonly loading = computed(() => this.historyStore.searching());
  readonly footerHints = computed<FooterHint[]>(() => [
    { keys: ['↑','↓'], label: 'Navigate' },
    { keys: ['⏎'], label: 'Resume' },
    { keys: ['Esc'], label: 'Close' },
  ]);

  readonly groups = computed<OverlayGroup<ResumePickerItem>[]>(() => {
    /* live + archived merge, frecency rank, filter by query */
    return [];
  });

  setQuery(q: string): void { this._query.set(q); this._selectedKey.set(null); }
  setSelectedKey(id: string | null): void { this._selectedKey.set(id); }
  clearError(): void { this._lastError.set(null); }

  async run(item: OverlayItem<ResumePickerItem>, action: ResumePickerAction = 'resumeById'): Promise<boolean> {
    try {
      switch (action) {
        case 'resumeLatest':       return await this.handleResumeLatest();
        case 'resumeById':         return await this.handleResumeById(item.data);
        case 'switchToLive':       return await this.handleSwitchToLive(item.data);
        case 'forkNew':            return await this.handleForkNew(item.data);
        case 'restoreFromFallback':return await this.handleFallback(item.data);
      }
    } catch (err) {
      this._lastError.set({ message: String(err), kind: 'execute-failed' });
      return false;
    }
  }
  // ... private handlers omitted for brevity ...
}
```

- [ ] **Step 3: Run, verify, commit**

```bash
npx vitest run src/renderer/app/features/resume/__tests__/resume-picker.controller.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/renderer/app/features/resume/resume-picker.controller.ts src/renderer/app/features/resume/__tests__/
git commit -m "feat(resume): ResumePickerController on Wave 1 OverlayController contract"
```

---

### Task 10.3: Add `[itemFooter]` projection slot to `OverlayShellComponent`

**Decision:** This change properly belongs in Wave 1, NOT Wave 3. See parent design's "Risks" section: "Wave 3's resume picker requires an `[itemFooter]` projection slot on Wave 1's `OverlayShellComponent`. If absent, add it to Wave 1 (additive, backward-compatible) before Wave 3 Phase 10."

**Files:**
- Modify: `src/renderer/app/shared/overlay-shell/overlay-shell.component.ts` (or wherever Wave 1 placed it)
- Modify: `src/renderer/app/shared/overlay-shell/overlay-shell.component.html`

- [ ] **Step 0: Pre-flight check.** Before modifying anything: open the actual `OverlayShellComponent` file (location varies by Wave 1's final layout — grep for `OverlayShellComponent` in `src/renderer/app/`).
  - **If the component already has an `itemFooter` input (or equivalent ng-template projection slot):** This task is a no-op. Skip directly to Task 10.4 and consume the existing slot.
  - **If the slot is absent:** STOP. Do NOT mutate Wave 1's component from inside Wave 3. Open a follow-up issue or escalate to the Wave 1 owner with a request: "Wave 1 OverlayShellComponent needs an optional `[itemFooter]` ng-template projection slot for Wave 3's resume picker action buttons. The slot is additive (other consumers ignore it) and should be added as a Wave 1 follow-up commit. See parent design Risks bullet for context." Wait for that change to land before resuming Task 10.3.
  - The remaining steps below describe the slot's contract — they are reference material for the Wave 1 owner if they need it, NOT instructions to apply from Wave 3.

- [ ] **Step 1: Document the new slot**

In the component class JSDoc, add:

```ts
/**
 * Per-row action footer projection slot.
 *
 * Hosts can pass `<ng-template #itemFooter let-item><...></ng-template>`
 * to render row-specific action buttons (e.g. resume picker's 5 actions).
 *
 * Wave 3 addition; existing Wave 1 hosts (palette, help) ignore this slot.
 */
```

- [ ] **Step 2: Add the template input**

```ts
itemFooter = input<TemplateRef<{ $implicit: OverlayItem }>>();
```

- [ ] **Step 3: Render it inside the row template**

In `overlay-shell.component.html`, where each row is rendered, add:

```html
@if (itemFooter()) {
  <div class="overlay-item-footer">
    <ng-container *ngTemplateOutlet="itemFooter()!; context: { $implicit: item }" />
  </div>
}
```

- [ ] **Step 4: Verify Wave 1 hosts still render correctly**

```bash
npx vitest run src/renderer/app/shared/overlay-shell
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/shared/overlay-shell/
git commit -m "feat(overlay-shell): add [itemFooter] per-row projection slot for picker actions (Wave 3)"
```

---

### Task 10.4: Implement the resume picker host component

**Files:**
- Create: `src/renderer/app/features/resume/resume-picker-host.component.ts`

- [ ] **Step 1: Write the host**

```ts
import { Component, ChangeDetectionStrategy, inject, output, signal } from '@angular/core';
import { OverlayShellComponent } from '../../shared/overlay-shell/overlay-shell.component';
import { ResumePickerController } from './resume-picker.controller';

@Component({
  selector: 'app-resume-picker-host',
  standalone: true,
  imports: [OverlayShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './resume-picker-host.component.html',
  styleUrls: ['./resume-picker-host.component.scss'],
})
export class ResumePickerHostComponent {
  protected readonly controller = inject(ResumePickerController);
  closeRequested = output<void>();
}
```

(Template: bind `<app-overlay-shell>` to the controller; project `[itemFooter]` for the 5 action buttons gated by `item.data.availableActions`.)

- [ ] **Step 2: Add the host to the `app.component.ts` overlay slot** (mirror the Wave 1 palette host pattern).

- [ ] **Step 3: Wire `Cmd/Ctrl+R` keybinding action `resume.openPicker`** in `keybinding.service.ts` (or the action-dispatch service).

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/renderer/app/features/resume/ src/renderer/app/app.component.ts
git commit -m "feat(resume): ResumePickerHostComponent + Cmd/Ctrl+R keybinding"
```

---

## Phase 11 — Interrupt-boundary display item

### Task 11.1: Failing test for the renderer projection

**Files:**
- Create: `src/renderer/app/features/instance-detail/__tests__/display-item-processor.interrupt-boundary.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { describe, it, expect } from 'vitest';
import { DisplayItemProcessor } from '../display-item-processor.service';
import type { OutputMessage } from '../../../core/state/instance/instance.types';

const interruptMsg = (id: string, phase: string, requestId: string, outcome = 'cancelled'): OutputMessage => ({
  id, type: 'system', content: '',
  metadata: { kind: 'interrupt-boundary', phase, requestId, outcome, at: Date.now() },
} as OutputMessage);

describe('DisplayItemProcessor — interrupt-boundary', () => {
  it('emits a peer-of-message item for each interrupt-boundary system message', () => {
    const proc = new DisplayItemProcessor();
    const items = proc.process([
      { id: 'u1', type: 'user', content: 'hello' } as OutputMessage,
      interruptMsg('i1', 'requested', 'req-1'),
      interruptMsg('i2', 'completed', 'req-1', 'respawn-success'),
      { id: 'u2', type: 'user', content: 'continue' } as OutputMessage,
    ]);
    const boundaries = items.filter(it => it.type === 'interrupt-boundary');
    expect(boundaries.length).toBe(2);
    expect(boundaries[0].interruptBoundary?.phase).toBe('requested');
    expect(boundaries[1].interruptBoundary?.outcome).toBe('respawn-success');
  });
});
```

- [ ] **Step 2: Confirm fail and commit**

```bash
npx vitest run src/renderer/app/features/instance-detail/__tests__/display-item-processor.interrupt-boundary.spec.ts
git add src/renderer/app/features/instance-detail/__tests__/display-item-processor.interrupt-boundary.spec.ts
git commit -m "test(display-items): failing test for interrupt-boundary kind (red)"
```

---

### Task 11.2: Implement the renderer branch

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.ts`

- [ ] **Step 0: Read DisplayItemProcessor.** Open `src/renderer/app/features/instance-detail/display-item-processor.service.ts` (lines 12–36 for the `DisplayItem` union, 309–339 for the system-event grouping pass). Locate the `process` (or `convertToItems`) method's message-processing loop. The interrupt-boundary branch must be added in the **first pass** (per-message), BEFORE any grouping. Otherwise the kind gets folded into `system-event-group` and renders as a tool-style log, breaking decision #7.

- [ ] **Step 1: Add detection in `process`**

Before the existing system-event-group grouping pass, branch:

```ts
if (m.type === 'system' && (m as any).metadata?.kind === 'interrupt-boundary') {
  const md = (m as any).metadata;
  this.items.push({
    id: m.id,
    type: 'interrupt-boundary',
    interruptBoundary: {
      phase: md.phase,
      requestId: md.requestId,
      outcome: md.outcome ?? 'unresolved',
      at: md.at ?? m.timestamp ?? Date.now(),
      reason: md.reason,
      fallbackMode: md.fallbackMode,
    },
    bufferIndex: i,
    timestamp: m.timestamp,
  });
  continue;
}
```

- [ ] **Step 2: Update the renderer template**

In `output-stream.component.html`, add a render branch for `'interrupt-boundary'` (visual: divider line + small phase/outcome label, see § 5.4 of design spec).

- [ ] **Step 3: Run, verify, commit**

```bash
npx vitest run src/renderer/app/features/instance-detail/__tests__/display-item-processor.interrupt-boundary.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/renderer/app/features/instance-detail/
git commit -m "feat(display-items): render interrupt-boundary kind"
```

---

### Task 11.3: Emit interrupt-boundary markers from `InterruptRespawnHandler`

**Files:**
- Modify: `src/main/instance/lifecycle/interrupt-respawn-handler.ts`
- Create: `src/main/display-items/interrupt-boundary-renderer.ts`

- [ ] **Step 1: Add an optional dep**

In `InterruptRespawnDeps`, add:

```ts
emitDisplayMarker?: (instanceId: string, marker: {
  kind: 'interrupt-boundary';
  phase: string;
  requestId: string;
  outcome?: string;
  reason?: string;
  fallbackMode?: string;
  at: number;
}) => void;
```

- [ ] **Step 2: Call it at the right phase transitions**

After each `transitionState` call inside `interrupt`, `respawnAfterInterrupt`, and `respawnAfterUnexpectedExit`, push a marker:

```ts
this.deps.emitDisplayMarker?.(instanceId, {
  kind: 'interrupt-boundary',
  phase: 'requested',
  requestId: instance.interruptRequestId ?? '',
  at: Date.now(),
});
```

(Adapt phase/outcome per call site.)

- [ ] **Step 3: Implement `interrupt-boundary-renderer.ts`**

```ts
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

/**
 * Pure helper used by InstanceLifecycle's `emitDisplayMarker` wiring.
 * Builds a system OutputMessage carrying interrupt-boundary metadata so the
 * marker survives archival and is recognized by DisplayItemProcessor.
 */
export function buildInterruptBoundaryMessage(
  instanceId: string,
  marker: {
    phase: string;
    requestId: string;
    outcome?: string;
    reason?: string;
    fallbackMode?: string;
    at: number;
  },
): OutputMessage {
  return {
    id: `interrupt-${marker.requestId}-${marker.phase}-${marker.at}`,
    type: 'system',
    content: `Interrupt ${marker.phase}`,
    timestamp: marker.at,
    metadata: { kind: 'interrupt-boundary', ...marker },
  } as OutputMessage;
}
```

- [ ] **Step 4: Wire `emitDisplayMarker` in `InstanceLifecycleManager`**

Look up where `InterruptRespawnHandler` is instantiated and pass:

```ts
emitDisplayMarker: (instanceId, marker) => {
  const inst = this.instances.get(instanceId);
  if (!inst) return;
  inst.outputBuffer.push(buildInterruptBoundaryMessage(instanceId, marker));
  this.emit('output', { instanceId, message: inst.outputBuffer.at(-1) });
},
```

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npx vitest run src/main/instance
git add src/main/instance/ src/main/display-items/
git commit -m "feat(interrupt-boundary): emit structured boundary markers from InterruptRespawnHandler"
```

---

## Phase 12 — Compaction-summary display item

### Task 12.1: Failing test for the renderer projection

**Files:**
- Create: `src/renderer/app/features/instance-detail/__tests__/display-item-processor.compaction-summary.spec.ts`

```ts
import { describe, it, expect } from 'vitest';
import { DisplayItemProcessor } from '../display-item-processor.service';
import type { OutputMessage } from '../../../core/state/instance/instance.types';

const compactionMsg = (): OutputMessage => ({
  id: 'comp-1', type: 'system', content: 'Conversation compacted',
  metadata: {
    kind: 'compaction-summary',
    reason: 'context budget',
    beforeCount: 120, afterCount: 32,
    tokensReclaimed: 18400, fallbackMode: 'in-place',
    at: Date.now(),
  },
} as OutputMessage);

describe('DisplayItemProcessor — compaction-summary', () => {
  it('emits a peer-of-message item with metadata', () => {
    const proc = new DisplayItemProcessor();
    const items = proc.process([compactionMsg()]);
    const summary = items.find(it => it.type === 'compaction-summary');
    expect(summary?.compactionSummary).toMatchObject({
      reason: 'context budget',
      beforeCount: 120,
      afterCount: 32,
    });
  });
});
```

- [ ] **Step 1: Confirm fail and commit**

```bash
npx vitest run src/renderer/app/features/instance-detail/__tests__/display-item-processor.compaction-summary.spec.ts
git add src/renderer/app/features/instance-detail/__tests__/
git commit -m "test(display-items): failing test for compaction-summary kind (red)"
```

---

### Task 12.2: Implement the renderer branch

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.ts`
- Modify: `src/renderer/app/features/instance-detail/output-stream.component.html`
- Modify: `src/renderer/app/features/instance-detail/output-stream.component.scss`

- [ ] **Step 0: Confirm Phase 11's branch location.** Phase 11 added the interrupt-boundary branch in the first pass (per-message), BEFORE the system-event grouping pass. Add the compaction-summary branch immediately adjacent to it. The two new kinds must remain top-level peers of `message`, NOT folded into `system-event-group` (decision #6).

- [ ] **Step 1: Add the branch in `process`** (peer of the interrupt-boundary branch from Phase 11)

```ts
if (m.type === 'system' && (m as any).metadata?.kind === 'compaction-summary') {
  const md = (m as any).metadata;
  this.items.push({
    id: m.id,
    type: 'compaction-summary',
    compactionSummary: {
      reason: md.reason ?? 'unspecified',
      beforeCount: md.beforeCount ?? 0,
      afterCount: md.afterCount ?? 0,
      tokensReclaimed: md.tokensReclaimed,
      fallbackMode: md.fallbackMode,
      at: md.at ?? m.timestamp ?? Date.now(),
    },
    bufferIndex: i,
    timestamp: m.timestamp,
  });
  continue;
}
```

- [ ] **Step 2: Render the card**

In `output-stream.component.html`, add a branch for `'compaction-summary'` rendering a small framed card with: title, reason, before→after counts, optional `tokensReclaimed`, optional `fallbackMode`. Style in `.scss`.

- [ ] **Step 3: Run, verify, commit**

```bash
npx vitest run src/renderer/app/features/instance-detail/__tests__/display-item-processor.compaction-summary.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/renderer/app/features/instance-detail/
git commit -m "feat(display-items): render compaction-summary kind"
```

---

### Task 12.3: Emit structured `session:compaction-display` from `SessionContinuityManager`

**Files:**
- Modify: `src/main/session/session-continuity.ts`
- Create: `src/main/display-items/compaction-summary-renderer.ts`

- [ ] **Step 1: Emit the new event**

In `maybeCompact` (around line 745), after `state.conversationHistory = result.entries;`, add:

```ts
const after = state.conversationHistory.length;
this.emit('session:compaction-display', {
  instanceId,
  reason: decision.reason,
  beforeCount: messageCountBeforeCompaction,
  afterCount: after,
  tokensReclaimed: undefined,
  fallbackMode: 'in-place',
  at: Date.now(),
});
```

- [ ] **Step 2: Wire a renderer in `compaction-summary-renderer.ts`**

```ts
import type { OutputMessage } from '../../shared/types/instance.types';

export function buildCompactionSummaryMessage(payload: {
  instanceId: string;
  reason: string;
  beforeCount: number;
  afterCount: number;
  tokensReclaimed?: number;
  fallbackMode?: string;
  at: number;
}): OutputMessage {
  return {
    id: `compaction-${payload.at}-${payload.beforeCount}`,
    type: 'system',
    content: `Conversation compacted (${payload.beforeCount} → ${payload.afterCount} messages)`,
    timestamp: payload.at,
    metadata: { kind: 'compaction-summary', ...payload },
  } as OutputMessage;
}
```

- [ ] **Step 3: Hook the event in `InstanceLifecycleManager` (or wherever `SessionContinuityManager` is wired)**

```ts
sessionContinuity.on('session:compaction-display', (payload) => {
  const inst = this.instances.get(payload.instanceId);
  if (!inst) return;
  const msg = buildCompactionSummaryMessage(payload);
  inst.outputBuffer.push(msg);
  this.emit('output', { instanceId: payload.instanceId, message: msg });
});
```

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npx vitest run src/main/session
git add src/main/session/session-continuity.ts src/main/display-items/ src/main/instance/
git commit -m "feat(compaction-summary): emit structured session:compaction-display event"
```

---

## Phase 13 — `NlWorkflowClassifier` + suggestion surface

### Task 13.1: Failing tests for the classifier

**Files:**
- Create: `src/main/session/__tests__/nl-workflow-classifier.spec.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getNlWorkflowClassifier,
  _resetNlWorkflowClassifierForTesting,
} from '../nl-workflow-classifier';

describe('NlWorkflowClassifier', () => {
  beforeEach(() => _resetNlWorkflowClassifierForTesting());

  it('classifies a single-file question as small', () => {
    const out = getNlWorkflowClassifier().classify('explain what main.ts does', {});
    expect(out.size).toBe('small');
    expect(out.surface).toBe('slash-command');
  });

  it('classifies multi-file change as medium', () => {
    const out = getNlWorkflowClassifier().classify(
      'update auth.ts and refresh.ts to use the new token format', {},
    );
    expect(out.size).toBe('medium');
    expect(out.surface).toBe('template-confirm');
  });

  it('classifies "review for security issues" as large', () => {
    const out = getNlWorkflowClassifier().classify(
      'review the codebase for security issues in auth.ts, db.ts, api.ts', {},
    );
    expect(out.size).toBe('large');
    expect(out.surface).toBe('preflight-modal');
  });

  it('detects "3 reviewers" → large', () => {
    const out = getNlWorkflowClassifier().classify(
      'spawn 3 reviewers to look at this PR', {},
    );
    expect(out.size).toBe('large');
  });
});
```

- [ ] **Step 1: Confirm fail and commit**

```bash
npx vitest run src/main/session/__tests__/nl-workflow-classifier.spec.ts
git add src/main/session/__tests__/nl-workflow-classifier.spec.ts
git commit -m "test(session): failing tests for NlWorkflowClassifier (red)"
```

---

### Task 13.2: Implement the classifier

**Files:**
- Create: `src/main/session/nl-workflow-classifier.ts`

- [ ] **Step 1: Implement**

```ts
const FILE_REGEX = /(?:\b|^)([a-z0-9_./-]+\.[a-z]{1,5})\b/gi;
const CHILDREN_REGEX = /\b(\d+)\s+(?:children|agents|reviewers|verifiers|workers)\b/i;
const WORKFLOW_KEYWORDS: Array<{ pattern: RegExp; signal: NlWorkflowSignal; suggestedRef: string }> = [
  { pattern: /\breview(?:\b|s|ing|ed)/i,   signal: 'workflow-keyword-review',   suggestedRef: 'wf-review' },
  { pattern: /\baudit(?:\b|s|ing|ed)/i,    signal: 'workflow-keyword-audit',    suggestedRef: 'wf-audit' },
  { pattern: /\brefactor(?:\b|s|ing|ed)/i, signal: 'workflow-keyword-refactor', suggestedRef: 'wf-refactor' },
  { pattern: /\bdebug(?:\b|s|ging|ged)/i,  signal: 'workflow-keyword-debug',    suggestedRef: 'wf-debug' },
  { pattern: /\bfeature(?:\b|s)/i,         signal: 'workflow-keyword-feature',  suggestedRef: 'wf-feature-dev' },
];

export type NlWorkflowSize = 'small' | 'medium' | 'large';
export type NlWorkflowSignal =
  | 'mentions-multiple-files' | 'mentions-three-or-more-children'
  | 'workflow-keyword-review' | 'workflow-keyword-audit' | 'workflow-keyword-refactor'
  | 'workflow-keyword-debug'  | 'workflow-keyword-feature'
  | 'orchestration-mention'   | 'no-orchestration-mention';

export interface NlWorkflowSuggestion {
  size: NlWorkflowSize;
  surface: 'slash-command' | 'template-confirm' | 'preflight-modal';
  suggestedRef: string | null;
  matchedSignals: NlWorkflowSignal[];
  estimatedChildCount?: number;
  estimatedProviderImpact?: 'none' | 'low' | 'medium' | 'high';
}

export interface NlWorkflowClassifier {
  classify(text: string, ctx: { provider?: string; workingDirectory?: string }): NlWorkflowSuggestion;
}

class DefaultNlClassifier implements NlWorkflowClassifier {
  classify(text: string): NlWorkflowSuggestion {
    const signals: NlWorkflowSignal[] = [];

    const fileMatches = [...text.matchAll(FILE_REGEX)].map(m => m[1]);
    const fileCount = new Set(fileMatches).size;
    if (fileCount > 1) signals.push('mentions-multiple-files');

    const childrenMatch = text.match(CHILDREN_REGEX);
    const childCount = childrenMatch ? parseInt(childrenMatch[1], 10) : 0;
    if (childCount >= 3) signals.push('mentions-three-or-more-children');

    let suggestedRef: string | null = null;
    for (const kw of WORKFLOW_KEYWORDS) {
      if (kw.pattern.test(text)) {
        signals.push(kw.signal);
        suggestedRef = kw.suggestedRef;
      }
    }
    const hasWorkflowKeyword = WORKFLOW_KEYWORDS.some(k => signals.includes(k.signal));

    if (/\b(orchestrat\w+|spawn|child|agent)\b/i.test(text)) signals.push('orchestration-mention');
    else signals.push('no-orchestration-mention');

    let size: NlWorkflowSize = 'small';
    let surface: NlWorkflowSuggestion['surface'] = 'slash-command';

    const isLarge =
      childCount >= 3 ||
      (signals.includes('workflow-keyword-review') && signals.includes('mentions-multiple-files')) ||
      (text.length > 1000 && hasWorkflowKeyword);
    const isMedium = !isLarge && (hasWorkflowKeyword || fileCount > 1);

    if (isLarge) { size = 'large';  surface = 'preflight-modal'; }
    else if (isMedium) { size = 'medium'; surface = 'template-confirm'; }
    else { suggestedRef = '/explain'; }

    return {
      size, surface, suggestedRef,
      matchedSignals: signals,
      estimatedChildCount: size === 'large' ? Math.max(childCount, 3) : undefined,
      estimatedProviderImpact: size === 'large' ? 'medium' : size === 'medium' ? 'low' : 'none',
    };
  }
}

let instance: NlWorkflowClassifier | null = null;
export function getNlWorkflowClassifier(): NlWorkflowClassifier {
  if (!instance) instance = new DefaultNlClassifier();
  return instance;
}
export function _resetNlWorkflowClassifierForTesting(): void { instance = null; }
```

- [ ] **Step 2: Run tests, verify, commit**

```bash
npx vitest run src/main/session/__tests__/nl-workflow-classifier.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/main/session/nl-workflow-classifier.ts
git commit -m "feat(nl-classifier): heuristic small/medium/large workflow suggestion classifier"
```

---

### Task 13.3: Wire suggestion surface in the composer

**Files:**
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`

- [ ] **Step 1: Debounce-call the classifier on input**

Use a 400ms debounce; call `window.electronAPI.workflow.nlSuggest({ promptText, ... })` and store the suggestion in a signal.

- [ ] **Step 2: Render the surface based on `surface`**

- `slash-command` → ghost-text suggestion in the input bar (no IPC call until the user accepts).
- `template-confirm` → inline confirm chip above the input ("Use review template?" / Confirm / Dismiss). On confirm, call `WORKFLOW_START` with `source: 'nl-suggestion'`.
- `preflight-modal` → modal dialog showing `estimatedChildCount`, `estimatedProviderImpact`, and the matched signals. Confirm / Cancel buttons; confirm triggers `WORKFLOW_START` with `source: 'nl-suggestion'`.

> Implementation never calls `WORKFLOW_START` automatically — locked decision #8.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/renderer/app/features/instance-detail/
git commit -m "feat(nl-suggestion): wire small/medium/large surfaces in composer (suggestion-only)"
```

---

### Task 13.4 (deferred to Wave 6 Doctor)

The thresholds for small/medium/large classification are heuristic. To validate post-ship:

- [ ] In `NlWorkflowClassifier.classify()`, emit a structured event via the existing telemetry/logger pipeline:

  ```ts
  logger.info('nl-classifier.classified', {
    classification: result.kind,
    matchedSignals: result.signals,
    promptLength: prompt.length,
    actedOn: undefined, // filled in by suggestion-surface caller
  });
  ```

- [ ] In the suggestion-surface UI (whoever consumes the classifier), fire a follow-up event when the user accepts or dismisses the suggestion: `logger.info('nl-classifier.acted-on', { classification, action: 'accepted' | 'dismissed' });`
- [ ] Wave 6 Doctor surfaces this telemetry as a "classifier accuracy" metric for threshold tuning.
- Verification: `npx vitest run src/main/session/__tests__/nl-workflow-classifier.spec.ts`
- Commit: `feat(nl-classifier): emit telemetry for threshold tuning`

---

## Phase 14 — Final integration

### Task 14.1: Full type-check, lint, and test

- [ ] **Step 1: Run the full quality gate**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
```

Fix any issues before continuing. Update existing specs only if they encode behavior that this wave intentionally changed (note such updates in the commit message with the locked-decision number).

- [ ] **Step 2: Manual smoke tests**

Run the app:

```bash
npm run dev
```

Validate (check off each):
- [ ] Start workflow A while workflow B (same category) is active → confirm card appears, on confirm B is auto-completed with `superseded`.
- [ ] Try to start workflow with `source: 'automation'` overlap → deny banner shows.
- [ ] Open advanced history search panel; query "auth bug" with project scope `Current` and last week filter → snippets render with `<mark>` highlighting; pagination works.
- [ ] Open resume picker (Cmd/Ctrl+R); pick a thread that previously failed native resume → only `Restore from fallback` button appears in the row footer.
- [ ] Fork an archived thread → confirm both new sessionId and new historyThreadId in the response (check log lines or DevTools).
- [ ] Trigger an interrupt during an agent turn → transcript shows `interrupt requested` then `cancelled` boundary line; restart app and confirm boundary persists in the rehydrated transcript.
- [ ] Hit context budget → compaction summary card renders with before/after counts.
- [ ] Type "review the auth flow for security issues touching auth.ts and db.ts" in the composer → preflight modal appears with estimated child count.

- [ ] **Step 3: Packaged DMG smoke (canary on shared-types changes)**

```bash
npm run build
# install the produced DMG, launch it, repeat the smoke checklist quickly
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore(wave3): final integration — typecheck, lint, tests pass; manual smoke complete"
```

> **Reminder: do not push.** The user will review and push from their machine.

---

## Appendix A — Verification quick reference

| Phase | What to run after |
|---|---|
| 1, 2, 3 | `npx vitest run src/main/workflows`, `npx tsc --noEmit` |
| 4, 5, 6, 7 | `npx vitest run src/main/history src/main/session`, `npx tsc --noEmit` |
| 8 | `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint` |
| 9, 10 | `npx vitest run src/renderer/app/core/state src/renderer/app/features/resume`, Angular lint |
| 11, 12 | `npx vitest run src/renderer/app/features/instance-detail src/main/instance src/main/session` |
| 13 | `npx vitest run src/main/session/__tests__/nl-workflow-classifier.spec.ts` |
| 14 | full suite + manual smoke + DMG packaging canary |

## Appendix B — Cross-reference to design spec

| Plan phase | Design spec § |
|---|---|
| Phase 1 | § 1.1 – 1.5 |
| Phase 2 | § 2.1 |
| Phase 3 | § 2.2 |
| Phase 4 | § 2.3 |
| Phase 5 | § 1.2, § 2.4 (HistoryManager parts) |
| Phase 6 | § 1.3, § 2.4 (SessionRecallService parts) |
| Phase 7 | § 2.4 (Coordinator) |
| Phase 8 | § 2.7, § 6 |
| Phase 9 | § 2.4, § 5.2 |
| Phase 10 | § 1.5, § 2.6, § 5.1, § 9.4 |
| Phase 11 | § 1.4, § 5.4 |
| Phase 12 | § 1.4, § 5.5 |
| Phase 13 | § 2.5, § 3.2 |
| Phase 14 | § 10 (acceptance criteria) |

## Appendix C — Files inventory (cross-check on completion)

Created (24 files):
- `src/main/workflows/workflow-transition-policy.ts` + spec
- `src/main/history/transcript-snippet-service.ts` + spec
- `src/main/history/advanced-history-search.ts` + spec
- `src/main/history/__tests__/history-manager-advanced-options.spec.ts`
- `src/main/history/__tests__/history-manager-snippets.spec.ts`
- `src/main/session/nl-workflow-classifier.ts` + spec
- `src/main/session/__tests__/session-recall-history-transcript.spec.ts`
- `src/main/display-items/interrupt-boundary-renderer.ts`
- `src/main/display-items/compaction-summary-renderer.ts`
- `src/main/ipc/handlers/history-search-handlers.ts`
- `src/main/ipc/handlers/resume-handlers.ts`
- `src/main/ipc/handlers/workflow-handlers.ts`
- `src/preload/domains/workflow.preload.ts`
- `src/renderer/app/features/resume/resume-picker.controller.ts` + spec
- `src/renderer/app/features/resume/resume-picker.types.ts`
- `src/renderer/app/features/resume/resume-actions.service.ts`
- `src/renderer/app/features/resume/resume-picker-host.component.ts` (+ html/scss)
- `src/renderer/app/features/history/history-search-panel.component.ts` (+ html/scss)
- `src/renderer/app/features/instance-detail/__tests__/display-item-processor.interrupt-boundary.spec.ts`
- `src/renderer/app/features/instance-detail/__tests__/display-item-processor.compaction-summary.spec.ts`
- `packages/contracts/src/schemas/workflow.schemas.ts`
- `packages/contracts/src/channels/workflow.channels.ts`

Modified:
- `src/shared/types/workflow.types.ts`, `src/shared/types/history.types.ts`, `src/shared/types/session-recall.types.ts`
- `src/main/workflows/workflow-manager.ts`
- `src/main/history/history-manager.ts`
- `src/main/session/session-recall-service.ts`, `src/main/session/session-continuity.ts`
- `src/main/instance/lifecycle/interrupt-respawn-handler.ts`
- `src/main/index.ts`
- `src/preload/domains/session.preload.ts`, `src/preload/preload.ts`
- `src/renderer/app/core/state/history.store.ts`
- `src/renderer/app/features/instance-detail/display-item-processor.service.ts`
- `src/renderer/app/features/instance-detail/output-stream.component.html` / `.scss`
- `src/renderer/app/shared/overlay-shell/overlay-shell.component.ts` / `.html`
- `src/renderer/app/features/instance-detail/input-panel.component.ts` (NL surface)
- `packages/contracts/src/schemas/session.schemas.ts`
- `packages/contracts/src/channels/session.channels.ts`
- `src/preload/generated/channels.ts`
