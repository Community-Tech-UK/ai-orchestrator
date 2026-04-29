# Wave 5: Orchestration HUD & Verification Verdicts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make multi-agent runs and verification results legible at a glance. Ship derived child-state badges (stale/active/waiting/failed/turn/churn), an orchestration HUD above the existing child panel, quick actions (focus, copy prompt hash, open diagnostic bundle, summarize), and a canonical `VerificationVerdict` rendered as a compact header above the existing verification detailed consensus display — without migrating the agent-tree schema, without breaking existing tabs, and while preserving raw responses.

**Architecture:** Pure derivers in shared (`child-state-deriver.ts`) and main (`verification-verdict-deriver.ts`, `orchestration-hud-builder.ts`). New `VerificationVerdict` shared type + Zod schema in a new `@contracts/schemas/verification` subpath (with the four-place alias sync per AGENTS.md gotcha #1). New `verification:verdict-ready` IPC event emitted by the orchestration activity bridge. Renderer adds a `currentVerdict` computed signal on the verification store, a verdict header on the results component, role/heartbeat/derived-state/churn badges in the child panel, a new `OrchestrationHudComponent`, a `ChildDiagnosticBundleModal`, and a `QuickActionDispatcherService` that delegates clipboard writes to Wave 4's `ClipboardService` (Wave 4 ships before Wave 5 per the parent design's recommended ship order).

**Tech Stack:** TypeScript 5.9, Angular 21 (zoneless, signals), Electron 40, Zod 4, Vitest, ESLint.

**Spec:** [`docs/superpowers/specs/2026-04-28-wave5-orchestration-hud-verification-verdicts-design_completed.md`](../specs/2026-04-28-wave5-orchestration-hud-verification-verdicts-design_completed.md)
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md`](../specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md`](./2026-04-28-cross-repo-usability-upgrades-plan_completed.md)

---

## How to read this plan

- **Phases** group related tasks. Phases 1–4 are pure-function and shared-type foundations. Phase 5 sets up the new contracts subpath. Phases 6–7 wire main → renderer plumbing. Phases 8–12 deliver UI. Phase 13 is final integration / smoke / packaged-DMG verification.
- **Tasks** are bite-sized work units (target ≤ 30 minutes). Each ends with a local commit.
- **TDD discipline:** behavioral code follows test → fail → implement → pass → commit. Pure type-only changes use type-check as the verification.
- **Verification commands** (run after every code-change task):
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - Targeted vitest spec(s) for the touched code
- **Critical rule (per `AGENTS.md`):** **NEVER run `git commit` without explicit user approval.** Every task below ends with a suggested commit message — run the commit only after the user approves. **Never push to remote** under any circumstances; pushing is always the user's call.

## Phase index

1. Phase 1 — Shared types: `VerificationVerdict`, `VerdictStatus`, `ChildDerivedState`, `OrchestrationHudSnapshot`
2. Phase 2 — `child-state-deriver.ts` pure utility + tests
3. Phase 3 — `verification-verdict-deriver.ts` pure function + tests
4. Phase 4 — `orchestration-hud-builder.ts` + tests
5. Phase 5 — Verdict schema (`@contracts/schemas/verification` subpath + 4-place alias sync)
6. Phase 6 — `orchestration-activity-bridge.ts` emits `verification:verdict-ready`
7. Phase 7 — Renderer verification store + computed verdict signal
8. Phase 8 — Verification results component verdict header (HTML/CSS)
9. Phase 9 — Child instances panel: role badges, heartbeat, derived state, churn count
10. Phase 10 — `OrchestrationHudComponent` (collapsible header above child panel)
11. Phase 11 — Quick actions (focus, copy hash, open diag bundle, summarize)
12. Phase 12 — `ChildDiagnosticBundleModal` component
13. Phase 13 — Final compile/lint/test/manual smoke

---

## Phase 1 — Shared types

These are pure-type and pure-helper additions. No behavior coupling yet. After this phase, the new types compile but nothing consumes them.

### Task 1.1: Add `VerdictStatus`, `VerificationVerdict`, and supporting types to `verification.types.ts`

**Files:**
- Modify: `src/shared/types/verification.types.ts`

- [x] **Step 1: Append the new types**

Open `src/shared/types/verification.types.ts`. Below the existing `VerificationResult` interface and helper functions, append:

```ts
// ──────────────────────────────────────────────────────────────────────────
// Wave 5: Verification Verdict
// ──────────────────────────────────────────────────────────────────────────

/**
 * Closed enum for the canonical verdict status. Mutually exclusive.
 */
export type VerdictStatus =
  | 'pass'
  | 'pass-with-notes'
  | 'needs-changes'
  | 'blocked'
  | 'inconclusive';

export const VERDICT_STATUSES: readonly VerdictStatus[] = [
  'pass', 'pass-with-notes', 'needs-changes', 'blocked', 'inconclusive',
] as const;

export type RiskAreaSeverity = 'low' | 'medium' | 'high';

export type RiskAreaCategory =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'compatibility'
  | 'data-loss'
  | 'ux'
  | 'maintainability'
  | 'unknown';

export interface RiskArea {
  category: RiskAreaCategory;
  description: string;
  severity: RiskAreaSeverity;
  agentIds?: string[];
}

export interface VerdictEvidence {
  kind: 'agent-response' | 'agreement' | 'disagreement' | 'outlier' | 'unique-insight';
  agentId?: string;
  snippet?: string;
  keyPointId?: string;
}

/**
 * Canonical, presentation-oriented verdict. Derived synchronously from a
 * VerificationResult via deriveVerdict(). NOT a replacement for VerificationResult.
 */
export interface VerificationVerdict {
  status: VerdictStatus;
  confidence: number;
  headline?: string;
  requiredActions: string[];
  riskAreas: RiskArea[];
  evidence: VerdictEvidence[];
  rawResponses: AgentResponse[];
  sourceResultId: string;
  derivedAt: number;
  schemaVersion: 1;
}

export const VERIFICATION_VERDICT_SCHEMA_VERSION = 1;

export interface VerdictDerivationDiagnostic {
  reason:
    | 'normal'
    | 'low-confidence'
    | 'missing-analysis'
    | 'no-disagreements'
    | 'unknown-error';
  note?: string;
}

export interface VerificationVerdictReadyPayload {
  resultId: string;
  instanceId: string;
  verdict: VerificationVerdict;
  diagnostic?: VerdictDerivationDiagnostic;
}
```

- [x] **Step 2: Verify type-check**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both pass. If they fail, the most likely cause is the `AgentResponse` reference in `VerificationVerdict.rawResponses` — the symbol is already exported from this file, so confirm the export precedes the new block.

- [x] **Step 3: Commit**

```bash
git add src/shared/types/verification.types.ts
git commit -m "feat(verification): add VerdictStatus, VerificationVerdict, RiskArea, evidence + payload types"
```

---

### Task 1.2: Add `OrchestrationHudSnapshot` and `HudQuickAction` types

**Files:**
- Create: `src/shared/types/orchestration-hud.types.ts`

- [x] **Step 1: Create the file**

Create `src/shared/types/orchestration-hud.types.ts`:

```ts
import type { ChildDerivedState, ChildStateCategory } from '../utils/child-state-deriver';

export interface HudChildEntry {
  instanceId: string;
  displayName: string;
  role?: string;
  spawnPromptHash?: string;
  derived: ChildDerivedState;
  activity?: string;
}

export interface OrchestrationHudSnapshot {
  parentInstanceId: string;
  totalChildren: number;
  countsByCategory: Record<ChildStateCategory, number>;
  churningCount: number;
  children: HudChildEntry[];
  attentionItems: HudChildEntry[];
  generatedAt: number;
}

export type HudQuickAction =
  | { kind: 'focus-child'; childInstanceId: string }
  | { kind: 'copy-prompt-hash'; childInstanceId: string; spawnPromptHash: string }
  | { kind: 'open-diagnostic-bundle'; childInstanceId: string }
  | { kind: 'summarize-children'; parentInstanceId: string };

export interface HudQuickActionResult {
  ok: boolean;
  reason?: string;
}
```

> Note: this file imports from `../utils/child-state-deriver`, which doesn't exist yet — that's fine; Phase 2 creates it. The reason we declare this here first is to keep types alongside the rest of `src/shared/types/`. Type-check will fail until Phase 2 lands.

- [x] **Step 2: Defer type-check until Phase 2**

```bash
# Type-check will currently fail with "Cannot find module '../utils/child-state-deriver'".
# This is expected. Don't run tsc yet — Phase 2 lands the file in the next task.
```

- [x] **Step 3: Commit**

```bash
git add src/shared/types/orchestration-hud.types.ts
git commit -m "feat(orchestration): add OrchestrationHudSnapshot, HudChildEntry, HudQuickAction types"
```

---

## Phase 2 — `child-state-deriver` pure utility

### Task 2.1: Write failing tests for `deriveChildState`

**Files:**
- Create: `src/shared/utils/__tests__/child-state-deriver.spec.ts`

- [x] **Step 1: Write the test file**

Create `src/shared/utils/__tests__/child-state-deriver.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  deriveChildState,
  FAILED_STATUSES,
  ACTIVE_STATUSES,
} from '../child-state-deriver';
import type { AgentTreeNode } from '../../types/agent-tree.types';

const NOW = 1_900_000_000_000;
const HEAD = (overrides: Partial<AgentTreeNode> = {}): Pick<AgentTreeNode, 'status' | 'statusTimeline' | 'lastActivityAt' | 'heartbeatAt'> => ({
  status: 'idle',
  statusTimeline: [{ status: 'idle', timestamp: NOW - 1_000 }],
  lastActivityAt: NOW - 1_000,
  ...overrides,
});

describe('deriveChildState', () => {
  it('buckets failed status as "failed"', () => {
    const r = deriveChildState(HEAD({ status: 'error' }), { now: NOW });
    expect(r.category).toBe('failed');
    expect(r.isFailed).toBe(true);
    expect(r.isActive).toBe(false);
  });

  it('buckets waiting_for_input as "waiting"', () => {
    const r = deriveChildState(HEAD({ status: 'waiting_for_input' }), { now: NOW });
    expect(r.category).toBe('waiting');
    expect(r.isWaiting).toBe(true);
  });

  it('buckets active statuses as "active"', () => {
    for (const s of ACTIVE_STATUSES) {
      const r = deriveChildState(HEAD({ status: s }), { now: NOW });
      expect(r.category).toBe('active');
      expect(r.isActive).toBe(true);
    }
  });

  it('buckets idle past stale threshold as "stale"', () => {
    const r = deriveChildState(
      HEAD({ status: 'idle', lastActivityAt: NOW - 60_000 }),
      { now: NOW, staleThresholdMs: 30_000 },
    );
    expect(r.category).toBe('stale');
    expect(r.isStale).toBe(true);
  });

  it('keeps idle within threshold as "idle"', () => {
    const r = deriveChildState(
      HEAD({ status: 'idle', lastActivityAt: NOW - 5_000 }),
      { now: NOW, staleThresholdMs: 30_000 },
    );
    expect(r.category).toBe('idle');
    expect(r.isStale).toBe(false);
  });

  it('failed wins over stale (priority order)', () => {
    const r = deriveChildState(
      HEAD({ status: 'error', lastActivityAt: NOW - 60_000 }),
      { now: NOW, staleThresholdMs: 30_000 },
    );
    expect(r.category).toBe('failed');
  });

  it('counts turns as statusTimeline.length', () => {
    const r = deriveChildState(HEAD({
      statusTimeline: [
        { status: 'idle', timestamp: NOW - 5_000 },
        { status: 'busy', timestamp: NOW - 4_000 },
        { status: 'idle', timestamp: NOW - 3_000 },
      ],
    }), { now: NOW });
    expect(r.turnCount).toBe(3);
  });

  it('counts churn within rolling window', () => {
    const r = deriveChildState(HEAD({
      statusTimeline: [
        { status: 'idle', timestamp: NOW - 50_000 },
        { status: 'busy', timestamp: NOW - 40_000 },
        { status: 'idle', timestamp: NOW - 30_000 },
        { status: 'busy', timestamp: NOW - 20_000 },
        { status: 'idle', timestamp: NOW - 10_000 },
        { status: 'busy', timestamp: NOW - 70_000 }, // outside 60s window
      ],
    }), { now: NOW, churnWindowMs: 60_000, churnThreshold: 5 });
    expect(r.churnCount).toBe(5);
    expect(r.isChurning).toBe(true);
  });

  it('does not flag churn under threshold', () => {
    const r = deriveChildState(HEAD({
      statusTimeline: [
        { status: 'idle', timestamp: NOW - 5_000 },
        { status: 'busy', timestamp: NOW - 4_000 },
      ],
    }), { now: NOW, churnThreshold: 5 });
    expect(r.isChurning).toBe(false);
  });

  it('clamps ageMs to non-negative when lastActivityAt is in the future', () => {
    const r = deriveChildState(HEAD({ lastActivityAt: NOW + 5_000 }), { now: NOW });
    expect(r.ageMs).toBe(0);
  });

  it('echoes heartbeatAt and lastActivityAt for caller convenience', () => {
    const r = deriveChildState(HEAD({ lastActivityAt: NOW - 1_000, heartbeatAt: NOW - 500 }), { now: NOW });
    expect(r.lastActivityAt).toBe(NOW - 1_000);
    expect(r.heartbeatAt).toBe(NOW - 500);
  });

  it('FAILED_STATUSES includes core failure states', () => {
    expect(FAILED_STATUSES.has('error')).toBe(true);
    expect(FAILED_STATUSES.has('crashed')).toBe(true);
    expect(FAILED_STATUSES.has('failed')).toBe(true);
  });

  it('uses default thresholds when options are omitted', () => {
    const r = deriveChildState(HEAD({ status: 'idle', lastActivityAt: NOW - 31_000 }), { now: NOW });
    expect(r.category).toBe('stale'); // default staleThresholdMs is 30000
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

```bash
npx vitest run src/shared/utils/__tests__/child-state-deriver.spec.ts
```

Expected: FAIL — `Cannot find module '../child-state-deriver'`.

---

### Task 2.2: Implement `deriveChildState`

**Files:**
- Create: `src/shared/utils/child-state-deriver.ts`

- [x] **Step 1: Implement**

Create `src/shared/utils/child-state-deriver.ts`:

```ts
import type { AgentTreeNode } from '../types/agent-tree.types';

export type ChildStateCategory = 'failed' | 'waiting' | 'active' | 'stale' | 'idle';

export interface ChildDerivedState {
  category: ChildStateCategory;
  isFailed: boolean;
  isWaiting: boolean;
  isActive: boolean;
  isStale: boolean;
  turnCount: number;
  churnCount: number;
  isChurning: boolean;
  lastActivityAt: number;
  heartbeatAt?: number;
  ageMs: number;
}

export interface ChildStateDeriverOptions {
  staleThresholdMs?: number;
  churnWindowMs?: number;
  churnThreshold?: number;
  now?: number;
}

export const FAILED_STATUSES: ReadonlySet<string> = new Set([
  'error', 'crashed', 'failed',
]);

export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'busy', 'initializing', 'respawning', 'interrupting',
  'cancelling', 'interrupt-escalating',
]);

const DEFAULT_STALE_THRESHOLD_MS = 30_000;
const DEFAULT_CHURN_WINDOW_MS = 60_000;
const DEFAULT_CHURN_THRESHOLD = 5;

export function deriveChildState(
  node: Pick<AgentTreeNode, 'status' | 'statusTimeline' | 'lastActivityAt' | 'heartbeatAt'>,
  options: ChildStateDeriverOptions = {},
): ChildDerivedState {
  const now = options.now ?? Date.now();
  const staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const churnWindowMs = options.churnWindowMs ?? DEFAULT_CHURN_WINDOW_MS;
  const churnThreshold = options.churnThreshold ?? DEFAULT_CHURN_THRESHOLD;

  const ageMs = Math.max(0, now - node.lastActivityAt);
  const turnCount = node.statusTimeline.length;
  const churnCount = node.statusTimeline.filter((entry) => (now - entry.timestamp) <= churnWindowMs).length;
  const isChurning = churnCount >= churnThreshold;

  const status = node.status;
  const isFailedStatus = FAILED_STATUSES.has(status);
  const isWaitingStatus = status === 'waiting_for_input';
  const isActiveStatus = ACTIVE_STATUSES.has(status);

  let category: ChildStateCategory;
  if (isFailedStatus) {
    category = 'failed';
  } else if (isWaitingStatus) {
    category = 'waiting';
  } else if (isActiveStatus) {
    category = 'active';
  } else if (ageMs > staleThresholdMs) {
    category = 'stale';
  } else {
    category = 'idle';
  }

  return {
    category,
    isFailed: category === 'failed',
    isWaiting: category === 'waiting',
    isActive: category === 'active',
    isStale: category === 'stale',
    turnCount,
    churnCount,
    isChurning,
    lastActivityAt: node.lastActivityAt,
    heartbeatAt: node.heartbeatAt,
    ageMs,
  };
}
```

- [x] **Step 2: Run the test and confirm it passes**

```bash
npx vitest run src/shared/utils/__tests__/child-state-deriver.spec.ts
```

Expected: all tests pass.

- [x] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/shared/utils/child-state-deriver.ts src/shared/utils/__tests__/child-state-deriver.spec.ts
git commit -m "feat(orchestration): add deriveChildState pure utility + tests"
```

The Phase 1 type file `orchestration-hud.types.ts` should now type-check (its import from `../utils/child-state-deriver` resolves).

---

## Phase 3 — `verification-verdict-deriver`

### Task 3.1: Write failing tests for `deriveVerdict`

**Files:**
- Create: `src/main/orchestration/__tests__/verification-verdict-deriver.spec.ts`

- [x] **Step 1: Write the test file**

Create `src/main/orchestration/__tests__/verification-verdict-deriver.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveVerdict, headlineForStatus } from '../verification-verdict-deriver';
import type {
  VerificationResult,
  AgentResponse,
  VerificationAnalysis,
} from '../../../shared/types/verification.types';

const NOW = 1_900_000_000_000;

const RESPONSE = (overrides: Partial<AgentResponse> = {}): AgentResponse => ({
  agentId: 'agent-1',
  agentIndex: 0,
  model: 'claude-3-opus',
  response: 'response text',
  keyPoints: [],
  confidence: 0.8,
  duration: 1000,
  tokens: 100,
  cost: 0.01,
  ...overrides,
});

const ANALYSIS = (overrides: Partial<VerificationAnalysis> = {}): VerificationAnalysis => ({
  agreements: [],
  disagreements: [],
  uniqueInsights: [],
  responseRankings: [],
  overallConfidence: 0.8,
  outlierAgents: [],
  consensusStrength: 0.8,
  ...overrides,
});

const RESULT = (overrides: Partial<VerificationResult> = {}): VerificationResult => ({
  id: 'result-1',
  request: {
    id: 'req-1',
    instanceId: 'inst-1',
    prompt: 'test',
    config: { agentCount: 3, timeout: 30_000, synthesisStrategy: 'merge' },
  },
  responses: [RESPONSE()],
  analysis: ANALYSIS(),
  synthesizedResponse: 'synth',
  synthesisMethod: 'merge',
  synthesisConfidence: 0.9,
  totalDuration: 1000,
  totalTokens: 100,
  totalCost: 0.01,
  completedAt: NOW,
  ...overrides,
});

describe('deriveVerdict', () => {
  it('returns "pass" for high confidence + empty riskAreas + no requiredActions', () => {
    const { verdict, diagnostic } = deriveVerdict(RESULT({ synthesisConfidence: 0.92 }), { now: NOW });
    expect(verdict.status).toBe('pass');
    expect(verdict.confidence).toBe(0.92);
    expect(verdict.requiredActions).toEqual([]);
    expect(verdict.riskAreas).toEqual([]);
    expect(diagnostic.reason).toBe('normal');
  });

  it('returns "pass-with-notes" for high confidence + non-empty riskAreas', () => {
    const { verdict } = deriveVerdict(RESULT({
      synthesisConfidence: 0.9,
      analysis: ANALYSIS({
        uniqueInsights: [{
          point: 'unusual edge case',
          category: 'warning',
          agentId: 'agent-2',
          confidence: 0.7,
          value: 'high',
          reasoning: 'because',
        }],
      }),
    }), { now: NOW });
    expect(verdict.status).toBe('pass-with-notes');
    expect(verdict.riskAreas.length).toBeGreaterThan(0);
  });

  it('returns "needs-changes" when requiredActions are non-empty', () => {
    const { verdict } = deriveVerdict(RESULT({
      synthesisConfidence: 0.7,
      analysis: ANALYSIS({
        disagreements: [{
          topic: 'should we use approach A or B?',
          positions: [{ agentId: 'a1', position: 'A', confidence: 0.7 }],
          requiresHumanReview: true,
        }],
      }),
    }), { now: NOW });
    expect(verdict.status).toBe('needs-changes');
    expect(verdict.requiredActions.some((a) => a.includes('Resolve'))).toBe(true);
  });

  it('returns "blocked" with outliers + low confidence', () => {
    const { verdict } = deriveVerdict(RESULT({
      synthesisConfidence: 0.45,
      analysis: ANALYSIS({
        outlierAgents: ['agent-3'],
        consensusStrength: 0.3,
      }),
    }), { now: NOW });
    expect(verdict.status).toBe('blocked');
  });

  it('returns "inconclusive" when confidence < 0.4', () => {
    const { verdict, diagnostic } = deriveVerdict(RESULT({ synthesisConfidence: 0.2 }), { now: NOW });
    expect(verdict.status).toBe('inconclusive');
    expect(diagnostic.reason).toBe('low-confidence');
  });

  it('clamps NaN confidence to 0 and marks "missing-analysis"', () => {
    const { verdict, diagnostic } = deriveVerdict(RESULT({ synthesisConfidence: Number.NaN }), { now: NOW });
    expect(verdict.confidence).toBe(0);
    expect(diagnostic.reason).toBe('missing-analysis');
    expect(verdict.status).toBe('inconclusive');
  });

  it('clamps confidence above 1 down to 1', () => {
    const { verdict } = deriveVerdict(RESULT({ synthesisConfidence: 5 }), { now: NOW });
    expect(verdict.confidence).toBe(1);
  });

  it('clamps negative confidence up to 0', () => {
    const { verdict } = deriveVerdict(RESULT({ synthesisConfidence: -1 }), { now: NOW });
    expect(verdict.confidence).toBe(0);
  });

  it('preserves rawResponses verbatim (deep equality)', () => {
    const r1 = RESPONSE({ agentId: 'a1', response: 'one' });
    const r2 = RESPONSE({ agentId: 'a2', response: 'two' });
    const result = RESULT({ responses: [r1, r2] });
    const { verdict } = deriveVerdict(result, { now: NOW });
    expect(verdict.rawResponses).toEqual(result.responses);
    expect(verdict.rawResponses.length).toBe(2);
  });

  it('caps requiredActions at 10 entries with overflow suffix', () => {
    const disagreements = Array.from({ length: 15 }, (_, i) => ({
      topic: `topic-${i}`,
      positions: [{ agentId: `a${i}`, position: 'p', confidence: 0.7 }],
      requiresHumanReview: true,
    }));
    const { verdict } = deriveVerdict(RESULT({
      synthesisConfidence: 0.7,
      analysis: ANALYSIS({ disagreements }),
    }), { now: NOW });
    expect(verdict.requiredActions.length).toBeLessThanOrEqual(10);
  });

  it('caps riskAreas at 8 entries', () => {
    const insights = Array.from({ length: 12 }, (_, i) => ({
      point: `risk-${i}`,
      category: 'warning' as const,
      agentId: `a${i}`,
      confidence: 0.7,
      value: 'high' as const,
      reasoning: 'r',
    }));
    const { verdict } = deriveVerdict(RESULT({
      synthesisConfidence: 0.9,
      analysis: ANALYSIS({ uniqueInsights: insights }),
    }), { now: NOW });
    expect(verdict.riskAreas.length).toBeLessThanOrEqual(8);
  });

  it('emits sourceResultId and derivedAt', () => {
    const { verdict } = deriveVerdict(RESULT({ id: 'res-xyz' }), { now: NOW });
    expect(verdict.sourceResultId).toBe('res-xyz');
    expect(verdict.derivedAt).toBe(NOW);
    expect(verdict.schemaVersion).toBe(1);
  });

  it('sets a headline matching status', () => {
    const { verdict } = deriveVerdict(RESULT({ synthesisConfidence: 0.95 }), { now: NOW });
    expect(verdict.headline).toBe(headlineForStatus(verdict.status));
  });
});

describe('headlineForStatus', () => {
  it('returns a non-empty string for every status', () => {
    for (const s of ['pass', 'pass-with-notes', 'needs-changes', 'blocked', 'inconclusive'] as const) {
      expect(headlineForStatus(s).length).toBeGreaterThan(0);
    }
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

```bash
npx vitest run src/main/orchestration/__tests__/verification-verdict-deriver.spec.ts
```

Expected: FAIL — `Cannot find module '../verification-verdict-deriver'`.

---

### Task 3.2: Implement `deriveVerdict`

**Files:**
- Create: `src/main/orchestration/verification-verdict-deriver.ts`

- [x] **Step 1: Implement**

Create `src/main/orchestration/verification-verdict-deriver.ts`:

```ts
import type {
  VerificationResult,
  VerificationVerdict,
  VerdictStatus,
  VerdictDerivationDiagnostic,
  VerdictEvidence,
  VerificationAnalysis,
  RiskArea,
  AgentResponse,
} from '../../shared/types/verification.types';

export interface DeriveVerdictOptions {
  inconclusiveBelow?: number;
  blockedBelow?: number;
  passAtOrAbove?: number;
  now?: number;
}

export interface DeriveVerdictResult {
  verdict: VerificationVerdict;
  diagnostic: VerdictDerivationDiagnostic;
}

const DEFAULT_INCONCLUSIVE_BELOW = 0.4;
const DEFAULT_BLOCKED_BELOW = 0.5;
const DEFAULT_PASS_AT_OR_ABOVE = 0.85;
const MAX_REQUIRED_ACTIONS = 10;
const MAX_RISK_AREAS = 8;
const SNIPPET_MAX = 280;

export function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function headlineForStatus(status: VerdictStatus): string {
  switch (status) {
    case 'pass':            return 'Looks good — no actions required.';
    case 'pass-with-notes': return 'Acceptable, but review the noted risks.';
    case 'needs-changes':   return 'Needs changes — see required actions.';
    case 'blocked':         return 'Blocked — significant outlier disagreement.';
    case 'inconclusive':    return 'Inconclusive — confidence below threshold.';
  }
}

export function extractRequiredActions(analysis: VerificationAnalysis): string[] {
  const actions: string[] = [];

  for (const d of analysis.disagreements) {
    if (d.requiresHumanReview) {
      actions.push(`Resolve: ${d.topic}`);
    }
  }
  for (const agentId of analysis.outlierAgents) {
    actions.push(`Audit response from ${agentId}`);
  }

  // Deduplicate by exact-string match, preserving order.
  const seen = new Set<string>();
  const deduped = actions.filter((a) => {
    if (seen.has(a)) return false;
    seen.add(a);
    return true;
  });

  if (deduped.length > MAX_REQUIRED_ACTIONS) {
    const truncated = deduped.slice(0, MAX_REQUIRED_ACTIONS - 1);
    truncated.push(`…and ${deduped.length - truncated.length} more`);
    return truncated;
  }
  return deduped;
}

export function extractRiskAreas(analysis: VerificationAnalysis): RiskArea[] {
  const areas: RiskArea[] = [];

  for (const d of analysis.disagreements) {
    if (d.positions.length >= 3) {
      areas.push({
        category: 'correctness',
        description: d.topic,
        severity: 'medium',
        agentIds: d.positions.map((p) => p.agentId),
      });
    }
  }
  for (const i of analysis.uniqueInsights) {
    if (i.value === 'high' && i.category === 'warning') {
      areas.push({
        category: 'unknown',
        description: i.point,
        severity: 'medium',
        agentIds: [i.agentId],
      });
    }
  }
  if (analysis.outlierAgents.length > 0 && analysis.consensusStrength < 0.5) {
    areas.push({
      category: 'correctness',
      description: 'Significant outlier disagreement',
      severity: 'high',
      agentIds: [...analysis.outlierAgents],
    });
  }

  return areas.slice(0, MAX_RISK_AREAS);
}

function buildEvidence(analysis: VerificationAnalysis): VerdictEvidence[] {
  const evidence: VerdictEvidence[] = [];

  for (const a of analysis.agreements) {
    if (a.strength >= 0.66) {
      evidence.push({
        kind: 'agreement',
        snippet: a.point.slice(0, SNIPPET_MAX),
      });
    }
  }
  for (const d of analysis.disagreements) {
    evidence.push({ kind: 'disagreement', snippet: d.topic.slice(0, SNIPPET_MAX) });
  }
  for (const agentId of analysis.outlierAgents) {
    evidence.push({ kind: 'outlier', agentId });
  }
  for (const i of analysis.uniqueInsights) {
    if (i.value === 'high') {
      evidence.push({
        kind: 'unique-insight',
        agentId: i.agentId,
        snippet: i.point.slice(0, SNIPPET_MAX),
      });
    }
  }
  return evidence;
}

function selectStatus(args: {
  confidence: number;
  outlierCount: number;
  requiredActionCount: number;
  riskAreaCount: number;
  inconclusiveBelow: number;
  blockedBelow: number;
  passAtOrAbove: number;
}): VerdictStatus {
  const { confidence, outlierCount, requiredActionCount, riskAreaCount } = args;

  if (confidence < args.inconclusiveBelow) return 'inconclusive';
  if (outlierCount > 0 && confidence < args.blockedBelow) return 'blocked';
  if (requiredActionCount > 0) return 'needs-changes';
  if (riskAreaCount > 0 && confidence >= args.passAtOrAbove) return 'pass-with-notes';
  if (riskAreaCount === 0 && requiredActionCount === 0 && confidence >= args.passAtOrAbove) return 'pass';
  return 'needs-changes';
}

export function deriveVerdict(
  result: VerificationResult,
  options: DeriveVerdictOptions = {},
): DeriveVerdictResult {
  const inconclusiveBelow = options.inconclusiveBelow ?? DEFAULT_INCONCLUSIVE_BELOW;
  const blockedBelow = options.blockedBelow ?? DEFAULT_BLOCKED_BELOW;
  const passAtOrAbove = options.passAtOrAbove ?? DEFAULT_PASS_AT_OR_ABOVE;
  const now = options.now ?? Date.now();

  const rawConfidence = result.synthesisConfidence;
  const confidence = clampConfidence(rawConfidence);

  let diagnostic: VerdictDerivationDiagnostic;
  if (!Number.isFinite(rawConfidence)) {
    diagnostic = { reason: 'missing-analysis', note: 'synthesisConfidence was not finite' };
  } else if (confidence < inconclusiveBelow) {
    diagnostic = { reason: 'low-confidence' };
  } else {
    diagnostic = { reason: 'normal' };
  }

  const analysis = result.analysis;
  const requiredActions = extractRequiredActions(analysis);
  const riskAreas = extractRiskAreas(analysis);
  const evidence = buildEvidence(analysis);
  const rawResponses: AgentResponse[] = [...result.responses];

  const status = selectStatus({
    confidence,
    outlierCount: analysis.outlierAgents.length,
    requiredActionCount: requiredActions.length,
    riskAreaCount: riskAreas.length,
    inconclusiveBelow,
    blockedBelow,
    passAtOrAbove,
  });

  const verdict: VerificationVerdict = {
    status,
    confidence,
    headline: headlineForStatus(status),
    requiredActions,
    riskAreas,
    evidence,
    rawResponses,
    sourceResultId: result.id,
    derivedAt: now,
    schemaVersion: 1,
  };

  return { verdict, diagnostic };
}
```

- [x] **Step 2: Run tests, expect pass**

```bash
npx vitest run src/main/orchestration/__tests__/verification-verdict-deriver.spec.ts
```

If a test fails, read the diagnostic output carefully — the most likely sources are: status priority order, the cap-at-10 truncation message, or NaN handling in `clampConfidence`.

- [x] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/orchestration/verification-verdict-deriver.ts src/main/orchestration/__tests__/verification-verdict-deriver.spec.ts
git commit -m "feat(verification): add deriveVerdict pure function + tests"
```

---

## Phase 4 — `orchestration-hud-builder`

### Task 4.1: Write failing tests for `buildHudSnapshot`

**Files:**
- Create: `src/main/orchestration/__tests__/orchestration-hud-builder.spec.ts`

- [x] **Step 1: Write the test file**

Create `src/main/orchestration/__tests__/orchestration-hud-builder.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildHudSnapshot } from '../orchestration-hud-builder';
import type { AgentTreeNode } from '../../../shared/types/agent-tree.types';

const NOW = 1_900_000_000_000;

const NODE = (overrides: Partial<AgentTreeNode>): AgentTreeNode => ({
  instanceId: overrides.instanceId ?? 'c1',
  displayName: overrides.displayName ?? 'Child 1',
  parentId: 'parent',
  childrenIds: [],
  depth: 1,
  status: 'idle',
  provider: 'claude',
  workingDirectory: '/x',
  sessionId: 's1',
  hasResult: false,
  statusTimeline: [{ status: 'idle', timestamp: NOW - 1_000 }],
  lastActivityAt: NOW - 1_000,
  createdAt: NOW - 10_000,
  ...overrides,
});

describe('buildHudSnapshot', () => {
  it('returns empty snapshot for no children', () => {
    const snap = buildHudSnapshot({ parentInstanceId: 'p1', children: [] });
    expect(snap.totalChildren).toBe(0);
    expect(snap.children).toEqual([]);
    expect(snap.attentionItems).toEqual([]);
    expect(snap.countsByCategory).toEqual({ failed: 0, waiting: 0, active: 0, stale: 0, idle: 0 });
    expect(snap.churningCount).toBe(0);
  });

  it('counts categories correctly', () => {
    const snap = buildHudSnapshot({
      parentInstanceId: 'p1',
      children: [
        NODE({ instanceId: 'c1', status: 'error' }),
        NODE({ instanceId: 'c2', status: 'waiting_for_input' }),
        NODE({ instanceId: 'c3', status: 'busy' }),
        NODE({ instanceId: 'c4', status: 'idle', lastActivityAt: NOW - 60_000 }),
        NODE({ instanceId: 'c5', status: 'idle', lastActivityAt: NOW - 1_000 }),
      ],
      derivationOptions: { now: NOW, staleThresholdMs: 30_000 },
    });
    expect(snap.countsByCategory.failed).toBe(1);
    expect(snap.countsByCategory.waiting).toBe(1);
    expect(snap.countsByCategory.active).toBe(1);
    expect(snap.countsByCategory.stale).toBe(1);
    expect(snap.countsByCategory.idle).toBe(1);
    expect(snap.totalChildren).toBe(5);
  });

  it('sorts failed first, then waiting, active, stale, idle', () => {
    const snap = buildHudSnapshot({
      parentInstanceId: 'p1',
      children: [
        NODE({ instanceId: 'c-idle', status: 'idle' }),
        NODE({ instanceId: 'c-failed', status: 'error' }),
        NODE({ instanceId: 'c-active', status: 'busy' }),
        NODE({ instanceId: 'c-waiting', status: 'waiting_for_input' }),
      ],
      derivationOptions: { now: NOW },
    });
    const order = snap.children.map((c) => c.instanceId);
    expect(order[0]).toBe('c-failed');
    expect(order[1]).toBe('c-waiting');
    expect(order[2]).toBe('c-active');
    expect(order[3]).toBe('c-idle');
  });

  it('attentionItems = failed | waiting | churning', () => {
    const snap = buildHudSnapshot({
      parentInstanceId: 'p1',
      children: [
        NODE({ instanceId: 'c-failed', status: 'error' }),
        NODE({ instanceId: 'c-waiting', status: 'waiting_for_input' }),
        NODE({ instanceId: 'c-idle', status: 'idle' }),
      ],
      derivationOptions: { now: NOW },
    });
    const ids = snap.attentionItems.map((a) => a.instanceId).sort();
    expect(ids).toEqual(['c-failed', 'c-waiting']);
  });

  it('counts churning as a separate scalar', () => {
    const churning = NODE({
      instanceId: 'c-churn',
      status: 'busy',
      statusTimeline: Array.from({ length: 6 }, (_, i) => ({ status: 'busy', timestamp: NOW - 5_000 - i * 1_000 })),
    });
    const snap = buildHudSnapshot({
      parentInstanceId: 'p1',
      children: [churning],
      derivationOptions: { now: NOW, churnThreshold: 5 },
    });
    expect(snap.churningCount).toBe(1);
    expect(snap.attentionItems[0]?.instanceId).toBe('c-churn');
  });

  it('passes activities through to entries', () => {
    const snap = buildHudSnapshot({
      parentInstanceId: 'p1',
      children: [NODE({ instanceId: 'c1' })],
      activities: new Map([['c1', 'currently typing']]),
      derivationOptions: { now: NOW },
    });
    expect(snap.children[0]?.activity).toBe('currently typing');
  });

  it('echoes role and spawnPromptHash', () => {
    const snap = buildHudSnapshot({
      parentInstanceId: 'p1',
      children: [NODE({ instanceId: 'c1', role: 'reviewer', spawnPromptHash: 'abc' })],
      derivationOptions: { now: NOW },
    });
    expect(snap.children[0]?.role).toBe('reviewer');
    expect(snap.children[0]?.spawnPromptHash).toBe('abc');
  });
});
```

- [x] **Step 2: Run, expect FAIL**

```bash
npx vitest run src/main/orchestration/__tests__/orchestration-hud-builder.spec.ts
```

---

### Task 4.2: Implement `buildHudSnapshot`

**Files:**
- Create: `src/main/orchestration/orchestration-hud-builder.ts`

- [x] **Step 1: Implement**

```ts
import { deriveChildState, type ChildStateCategory, type ChildStateDeriverOptions } from '../../shared/utils/child-state-deriver';
import type { AgentTreeNode } from '../../shared/types/agent-tree.types';
import type {
  HudChildEntry,
  OrchestrationHudSnapshot,
} from '../../shared/types/orchestration-hud.types';

export interface BuildHudSnapshotInput {
  parentInstanceId: string;
  children: AgentTreeNode[];
  activities?: ReadonlyMap<string, string>;
  derivationOptions?: ChildStateDeriverOptions;
}

const CATEGORY_RANK: Record<ChildStateCategory, number> = {
  failed: 0,
  waiting: 1,
  active: 2,
  stale: 3,
  idle: 4,
};

export function buildHudSnapshot(input: BuildHudSnapshotInput): OrchestrationHudSnapshot {
  const now = input.derivationOptions?.now ?? Date.now();
  const countsByCategory: Record<ChildStateCategory, number> = {
    failed: 0, waiting: 0, active: 0, stale: 0, idle: 0,
  };

  const entries: HudChildEntry[] = input.children.map((node) => {
    const derived = deriveChildState(node, input.derivationOptions);
    countsByCategory[derived.category] += 1;
    return {
      instanceId: node.instanceId,
      displayName: node.displayName,
      role: node.role,
      spawnPromptHash: node.spawnPromptHash,
      derived,
      activity: input.activities?.get(node.instanceId),
    };
  });

  entries.sort((a, b) => {
    const rankDiff = CATEGORY_RANK[a.derived.category] - CATEGORY_RANK[b.derived.category];
    if (rankDiff !== 0) return rankDiff;
    // Within bucket: churning first, then most recently active.
    if (a.derived.isChurning !== b.derived.isChurning) {
      return a.derived.isChurning ? -1 : 1;
    }
    return b.derived.lastActivityAt - a.derived.lastActivityAt;
  });

  const churningCount = entries.filter((e) => e.derived.isChurning).length;
  const attentionItems = entries.filter((e) => e.derived.isFailed || e.derived.isWaiting || e.derived.isChurning);

  return {
    parentInstanceId: input.parentInstanceId,
    totalChildren: entries.length,
    countsByCategory,
    churningCount,
    children: entries,
    attentionItems,
    generatedAt: now,
  };
}
```

- [x] **Step 2: Run tests, expect pass**

```bash
npx vitest run src/main/orchestration/__tests__/orchestration-hud-builder.spec.ts
```

- [x] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/orchestration/orchestration-hud-builder.ts src/main/orchestration/__tests__/orchestration-hud-builder.spec.ts
git commit -m "feat(orchestration): add buildHudSnapshot pure function + tests"
```

---

## Phase 5 — Verdict schema (`@contracts/schemas/verification` + 4-place sync)

> **Critical:** This phase touches **four** alias-sync sites. Missing any one will break the packaged DMG even though typecheck and lint pass. Phase 13's smoke step verifies the packaged app starts.

### Task 5.1: Create the schema file

**Files:**
- Create: `packages/contracts/src/schemas/verification.schemas.ts`

- [x] **Step 1: Create the file**

```ts
import { z } from 'zod';

export const VERDICT_STATUS_VALUES = [
  'pass', 'pass-with-notes', 'needs-changes', 'blocked', 'inconclusive',
] as const;

export const VerdictStatusSchema = z.enum(VERDICT_STATUS_VALUES);

export const RiskAreaCategorySchema = z.enum([
  'correctness', 'security', 'performance', 'compatibility',
  'data-loss', 'ux', 'maintainability', 'unknown',
]);

export const RiskAreaSeveritySchema = z.enum(['low', 'medium', 'high']);

export const RiskAreaSchema = z.object({
  category: RiskAreaCategorySchema,
  description: z.string().min(1).max(2_000),
  severity: RiskAreaSeveritySchema,
  agentIds: z.array(z.string()).optional(),
});

export const VerdictEvidenceSchema = z.object({
  kind: z.enum(['agent-response', 'agreement', 'disagreement', 'outlier', 'unique-insight']),
  agentId: z.string().optional(),
  snippet: z.string().max(280).optional(),
  keyPointId: z.string().optional(),
});

export const AgentResponseSchema = z.object({
  agentId: z.string(),
  agentIndex: z.number().int().nonnegative(),
  model: z.string(),
  personality: z.string().optional(),
  response: z.string(),
  keyPoints: z.array(z.unknown()),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),
  duration: z.number().nonnegative(),
  tokens: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  error: z.string().optional(),
  timedOut: z.boolean().optional(),
});

export const VerificationVerdictSchema = z.object({
  status: VerdictStatusSchema,
  confidence: z.number().min(0).max(1),
  headline: z.string().max(500).optional(),
  requiredActions: z.array(z.string().max(1_000)),
  riskAreas: z.array(RiskAreaSchema),
  evidence: z.array(VerdictEvidenceSchema),
  rawResponses: z.array(AgentResponseSchema),
  sourceResultId: z.string(),
  derivedAt: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
});

export const VerdictDerivationDiagnosticSchema = z.object({
  reason: z.enum(['normal', 'low-confidence', 'missing-analysis', 'no-disagreements', 'unknown-error']),
  note: z.string().max(2_000).optional(),
});

export const VerificationVerdictReadyPayloadSchema = z.object({
  resultId: z.string(),
  instanceId: z.string(),
  verdict: VerificationVerdictSchema,
  diagnostic: VerdictDerivationDiagnosticSchema.optional(),
});

export type VerificationVerdictPayload = z.infer<typeof VerificationVerdictSchema>;
export type VerificationVerdictReadyPayloadParsed = z.infer<typeof VerificationVerdictReadyPayloadSchema>;
```

- [x] **Step 2: Type-check (will succeed but won't be importable yet from `@contracts/schemas/verification` until the alias is registered)**

```bash
npx tsc --noEmit
```

---

### Task 5.2: Add the alias in all four sync sites

**Files:**
- Modify: `tsconfig.json`
- Modify: `tsconfig.electron.json`
- Modify: `src/main/register-aliases.ts`
- Modify: `vitest.config.ts`

- [x] **Step 1: `tsconfig.json`** — under `compilerOptions.paths`, add the entry alongside the existing `@contracts/schemas/*` entries:

```json
"@contracts/schemas/verification": ["./packages/contracts/src/schemas/verification.schemas.ts"]
```

- [x] **Step 2: `tsconfig.electron.json`** — same entry, same value.

- [x] **Step 3: `src/main/register-aliases.ts`** — inside the `exactAliases` object (lines 22+), add a new entry preserving the alphabetical ordering used by neighbors:

```ts
'@contracts/schemas/verification':           path.join(baseContracts, 'schemas', 'verification.schemas'),
```

- [x] **Step 4: `vitest.config.ts`** — if a test imports from `@contracts/schemas/verification` (Phase 5.3 spec does), mirror the alias in the `resolve.alias` block. Match the existing `@contracts/schemas/*` patterns exactly.

- [x] **Step 5: Verify**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all pass.

> **Reminder:** the `prebuild` script (`scripts/verify-native-abi.js`) does NOT verify alias-sync. Only the packaged-DMG smoke run in Phase 13 catches a missed entry.

---

### Task 5.3: Add roundtrip tests for the schema

**Files:**
- Create: `packages/contracts/src/schemas/__tests__/verification.schemas.spec.ts`

- [x] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import {
  VerificationVerdictSchema,
  VerificationVerdictReadyPayloadSchema,
  VerdictStatusSchema,
} from '@contracts/schemas/verification';
import type { VerificationVerdict } from '../../../../../src/shared/types/verification.types';

const VERDICT: VerificationVerdict = {
  status: 'pass-with-notes',
  confidence: 0.88,
  headline: 'Acceptable, but review the noted risks.',
  requiredActions: [],
  riskAreas: [
    { category: 'correctness', description: 'edge case', severity: 'medium', agentIds: ['a1'] },
  ],
  evidence: [
    { kind: 'agreement', snippet: 'agree' },
    { kind: 'unique-insight', agentId: 'a2', snippet: 'unusual' },
  ],
  rawResponses: [
    {
      agentId: 'a1',
      agentIndex: 0,
      model: 'claude-3-opus',
      response: 'r',
      keyPoints: [],
      confidence: 0.8,
      duration: 100,
      tokens: 10,
      cost: 0.001,
    },
  ],
  sourceResultId: 'res-1',
  derivedAt: 1_900_000_000_000,
  schemaVersion: 1,
};

describe('VerificationVerdictSchema', () => {
  it('parses a valid verdict roundtrip', () => {
    const parsed = VerificationVerdictSchema.parse(VERDICT);
    expect(parsed).toEqual(VERDICT);
  });

  it('rejects an invalid status', () => {
    const bad = { ...VERDICT, status: 'mostly-good' };
    expect(() => VerificationVerdictSchema.parse(bad)).toThrow();
  });

  it('rejects confidence > 1', () => {
    const bad = { ...VERDICT, confidence: 1.2 };
    expect(() => VerificationVerdictSchema.parse(bad)).toThrow();
  });

  it('rejects schemaVersion !== 1', () => {
    const bad = { ...VERDICT, schemaVersion: 2 };
    expect(() => VerificationVerdictSchema.parse(bad)).toThrow();
  });
});

describe('VerificationVerdictReadyPayloadSchema', () => {
  it('parses a valid payload (with optional diagnostic)', () => {
    const payload = {
      resultId: 'res-1',
      instanceId: 'inst-1',
      verdict: VERDICT,
      diagnostic: { reason: 'normal' as const },
    };
    expect(VerificationVerdictReadyPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('parses without diagnostic', () => {
    const payload = { resultId: 'res-1', instanceId: 'inst-1', verdict: VERDICT };
    expect(VerificationVerdictReadyPayloadSchema.parse(payload)).toEqual(payload);
  });
});

describe('VerdictStatusSchema', () => {
  it('accepts every closed-enum value', () => {
    for (const v of ['pass', 'pass-with-notes', 'needs-changes', 'blocked', 'inconclusive']) {
      expect(VerdictStatusSchema.parse(v)).toBe(v);
    }
  });
});
```

- [x] **Step 2: Run + commit**

```bash
npx vitest run packages/contracts/src/schemas/__tests__/verification.schemas.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add packages/contracts/src/schemas/verification.schemas.ts \
        packages/contracts/src/schemas/__tests__/verification.schemas.spec.ts \
        tsconfig.json tsconfig.electron.json src/main/register-aliases.ts vitest.config.ts
git commit -m "feat(verification): add @contracts/schemas/verification subpath + 4-place alias sync"
```

---

## Phase 6 — Activity bridge emits `verification:verdict-ready`

### Task 6.1: Write a bridge test for the new event

**Files:**
- Modify: `src/main/orchestration/__tests__/orchestration-activity-bridge.spec.ts` (if exists; otherwise create)

- [x] **Step 1: Add a test case**

In the verification-wiring section of the bridge spec, append:

```ts
it('emits verification:verdict-ready after verification:completed', async () => {
  const sentEvents: Array<{ channel: string; payload: unknown }> = [];
  const fakeWindowManager = {
    sendToRenderer: (channel: string, payload: unknown) => {
      sentEvents.push({ channel, payload });
    },
  };

  const fakeVerification = new (require('events').EventEmitter)();
  // …construct OrchestrationActivityBridge with the fake window manager and emitter…

  // Pretend a verification completed.
  const completedResult = {/* …a minimal VerificationResult… */};
  fakeVerification.emit('verification:completed', completedResult);

  // Assert that one of the sent events was 'verification:verdict-ready'.
  const verdictEvent = sentEvents.find((e) => e.channel === 'verification:verdict-ready');
  expect(verdictEvent).toBeDefined();
  expect((verdictEvent!.payload as { verdict: { status: string } }).verdict.status).toBeTypeOf('string');
});
```

> The exact wiring depends on how the existing bridge test stubs the `MultiVerifyCoordinator`. Read `src/main/orchestration/orchestration-activity-bridge.ts` lines 232–305 first; then mirror the existing event-fixture style.

- [x] **Step 2: Run, expect FAIL**

```bash
npx vitest run src/main/orchestration/__tests__/orchestration-activity-bridge.spec.ts
```

Expected: FAIL — the bridge does not emit `verification:verdict-ready` yet.

---

### Task 6.2: Wire `deriveVerdict` into `wireVerification`

**Files:**
- Modify: `src/main/orchestration/orchestration-activity-bridge.ts`

- [x] **Step 1: Add the import**

```ts
import { deriveVerdict } from './verification-verdict-deriver';
import type { VerificationResult, VerificationVerdictReadyPayload } from '../../shared/types/verification.types';
```

- [x] **Step 2: In `wireVerification`, extend the `verification:completed` listener**

The current listener (lines 272–283) sends only the activity string. Augment it to also emit the verdict:

```ts
this.listen(verification, 'verification:completed', (...args: unknown[]) => {
  const result = args[0] as VerificationResult;
  const instanceId = this.verificationInstanceMap.get(result.id);
  if (!instanceId) return;

  // existing activity event
  this.send({
    instanceId,
    activity: 'Verification complete',
    category: 'verification',
  });

  // NEW: derive and emit verdict
  try {
    const { verdict, diagnostic } = deriveVerdict(result);
    const payload: VerificationVerdictReadyPayload = {
      resultId: result.id,
      instanceId,
      verdict,
      ...(diagnostic.reason !== 'normal' ? { diagnostic } : {}),
    };
    this.windowManager?.sendToRenderer('verification:verdict-ready', payload);
    if (diagnostic.reason !== 'normal') {
      logger.info(`Verdict derived with reason=${diagnostic.reason} resultId=${result.id} status=${verdict.status}`);
    }
  } catch (err) {
    logger.warn(`Failed to derive verdict for resultId=${result.id}: ${(err as Error).message}`);
  }

  this.verificationInstanceMap.delete(result.id);
});
```

> Note: the prior signature relied on `args[0] as { id: string }`. We now need the full `VerificationResult`. Confirm by reading the emitter — `MultiVerifyCoordinator` emits the full result on `verification:completed`. If not, adjust to fetch via the existing IPC and only emit the verdict event. This is a test-driven check.

- [x] **Step 3: Run, expect PASS**

```bash
npx vitest run src/main/orchestration/__tests__/orchestration-activity-bridge.spec.ts
```

- [x] **Step 4: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/main/orchestration/orchestration-activity-bridge.ts \
        src/main/orchestration/__tests__/orchestration-activity-bridge.spec.ts
git commit -m "feat(verification): emit verification:verdict-ready from activity bridge"
```

---

## Phase 7 — Renderer verification store + computed verdict signal

### Task 7.1: Add verdict signal + IPC subscription in `verification.store.ts`

**Files:**
- Modify: `src/renderer/app/core/state/verification/verification.store.ts`

- [x] **Step 1: Add imports + signals**

Near the existing imports:

```ts
import { signal, computed } from '@angular/core';
import type { VerificationVerdict, VerificationVerdictReadyPayload } from '../../../../../shared/types/verification.types';
```

Inside the class, add:

```ts
private _verdictsByResultId = signal<Map<string, VerificationVerdict>>(new Map());
verdictsByResultId = this._verdictsByResultId.asReadonly();

readonly currentVerdict = computed<VerificationVerdict | null>(() => {
  const r = this.result();
  if (!r) return null;
  return this._verdictsByResultId().get(r.id) ?? null;
});
```

- [x] **Step 2: Subscribe to the IPC event**

In the existing `constructor` / IPC-subscription block, add:

```ts
this.unsubscribes.push(
  this.ipc.on<VerificationVerdictReadyPayload>('verification:verdict-ready', (payload) => {
    const next = new Map(this._verdictsByResultId());
    next.set(payload.resultId, payload.verdict);
    this._verdictsByResultId.set(next);
  })
);
```

- [x] **Step 3: Re-export the verdict type from `verification.types.ts` (renderer)**

Open `src/renderer/app/core/state/verification/verification.types.ts` and append (mirroring the existing re-export pattern):

```ts
export type { VerificationVerdict, VerdictStatus, RiskArea, VerdictEvidence } from '../../../../../shared/types/verification.types';
```

- [x] **Step 4: Type-check + targeted spec**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npx vitest run src/renderer/app/core/state/verification/
```

- [x] **Step 5: Commit**

```bash
git add src/renderer/app/core/state/verification/verification.store.ts \
        src/renderer/app/core/state/verification/verification.types.ts
git commit -m "feat(verification): add currentVerdict computed signal + IPC subscription"
```

---

### Task 7.2: Expose the IPC channel via preload

**Files:**
- Modify: `src/preload/preload.ts`

- [x] **Step 1: Read existing preload patterns**

Find the existing `verification:*` listener pattern. Mirror it for the new channel name. (Do not invent a new wrapper API; the existing event-bridge pattern handles it generically if the channel name matches a configured pattern.)

- [x] **Step 2: If preload needs an explicit allow-list entry, add `'verification:verdict-ready'`**

The exact diff depends on whether preload uses an allow-list or a generic forwarder. Read the file fully before editing.

- [x] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/preload/preload.ts
git commit -m "feat(verification): expose verification:verdict-ready listener via preload"
```

---

## Phase 8 — Verification results component verdict header

### Task 8.1: Update component TS — add verdict computed + label/format helpers

**Files:**
- Modify: `src/renderer/app/features/verification/results/verification-results.component.ts`

- [x] **Step 1: Add imports**

```ts
import type { VerificationVerdict, VerdictStatus } from '../../../core/state/verification/verification.types';
```

- [x] **Step 2: Add fields and helpers**

Inside the class:

```ts
verdict = computed<VerificationVerdict | null>(() => this.store.currentVerdict());

verdictStatusLabel(status: VerdictStatus): string {
  switch (status) {
    case 'pass':            return 'Pass';
    case 'pass-with-notes': return 'Pass with notes';
    case 'needs-changes':   return 'Needs changes';
    case 'blocked':         return 'Blocked';
    case 'inconclusive':    return 'Inconclusive';
  }
}

formatConfidence(c: number): string {
  return `${Math.round(c * 100)}% confidence`;
}
```

- [x] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

---

### Task 8.2: Update component HTML — render verdict header

**Files:**
- Modify: `src/renderer/app/features/verification/results/verification-results.component.html`

- [x] **Step 1: Insert verdict header**

Just inside `<div class="results-container">`, BEFORE `<div class="results-header">` (around line 4), add:

```html
@if (verdict(); as v) {
  <div
    class="verdict-header"
    [attr.data-status]="v.status"
    role="region"
    aria-label="Verification verdict"
  >
    <div class="verdict-status-row">
      <span class="verdict-chip verdict-chip--{{ v.status }}">
        {{ verdictStatusLabel(v.status) }}
      </span>
      <span class="verdict-confidence">
        {{ formatConfidence(v.confidence) }}
      </span>
      @if (v.headline) {
        <span class="verdict-headline">{{ v.headline }}</span>
      }
    </div>

    @if (v.requiredActions.length > 0) {
      <div class="verdict-actions">
        <h3>Required actions</h3>
        <ul>
          @for (a of v.requiredActions; track a) {
            <li>{{ a }}</li>
          }
        </ul>
      </div>
    }

    @if (v.riskAreas.length > 0) {
      <div class="verdict-risk-areas">
        <h3>Risk areas</h3>
        <ul>
          @for (r of v.riskAreas; track r.description) {
            <li>
              <span class="risk-category">{{ r.category }}</span>
              <span class="risk-severity risk-severity--{{ r.severity }}">{{ r.severity }}</span>
              <span class="risk-description">{{ r.description }}</span>
            </li>
          }
        </ul>
      </div>
    }
  </div>
}
```

The existing tabs and content blocks remain unchanged.

- [x] **Step 2: Add verdict styles**

Append to `verification-results.component.scss`:

```scss
.verdict-header {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  padding: var(--space-3);
  margin-bottom: var(--space-3);

  .verdict-status-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .verdict-chip {
    font-weight: 600;
    text-transform: uppercase;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    letter-spacing: 0.04em;

    &--pass            { background: var(--color-success-bg); color: var(--color-success); }
    &--pass-with-notes { background: var(--color-info-bg);    color: var(--color-info); }
    &--needs-changes   { background: var(--color-warning-bg); color: var(--color-warning); }
    &--blocked         { background: var(--color-danger-bg);  color: var(--color-danger); }
    &--inconclusive    { background: var(--bg-tertiary);      color: var(--text-secondary); }
  }

  .verdict-confidence { font-size: 12px; color: var(--text-secondary); }
  .verdict-headline   { font-size: 13px; color: var(--text-primary); flex-basis: 100%; margin-top: 4px; }

  .verdict-actions, .verdict-risk-areas {
    margin-top: var(--space-3);
    h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin: 0 0 var(--space-2); }
    ul { padding-left: var(--space-4); margin: 0; }
    li { font-size: 13px; line-height: 1.5; }
  }

  .verdict-risk-areas li {
    display: flex; gap: var(--space-2); align-items: baseline;
    .risk-severity {
      font-size: 10px; padding: 1px 6px; border-radius: var(--radius-sm); text-transform: uppercase;
      &--low    { background: var(--color-info-bg);    color: var(--color-info); }
      &--medium { background: var(--color-warning-bg); color: var(--color-warning); }
      &--high   { background: var(--color-danger-bg);  color: var(--color-danger); }
    }
  }
}
```

- [x] **Step 3: Update / extend component spec**

In `verification-results.component.spec.ts`, add:

```ts
it('renders verdict header when currentVerdict signal is non-null', async () => {
  // …seed store.currentVerdict with a fixture, render the component…
  expect(fixture.nativeElement.querySelector('.verdict-header')).not.toBeNull();
  expect(fixture.nativeElement.querySelector('.verdict-chip--pass-with-notes')).not.toBeNull();
});

it('does not render verdict header when verdict is null', async () => {
  // …leave currentVerdict empty…
  expect(fixture.nativeElement.querySelector('.verdict-header')).toBeNull();
});
```

- [x] **Step 4: Run + commit**

```bash
npx vitest run src/renderer/app/features/verification/results/
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/renderer/app/features/verification/results/
git commit -m "feat(verification): render verdict header above existing detailed results"
```

---

## Phase 9 — Child instances panel: role, heartbeat, derived state, churn

### Task 9.1: Extend `InstanceStore` to expose AgentTreeNode v2 fields per child

**Files:**
- Modify: `src/renderer/app/core/state/instance.store.ts`

- [x] **Step 1: Read the file fully** before editing — confirm whether an `agent-tree` snapshot is already maintained (it should be; the orchestration layer ships it via IPC). Find the existing setter for the snapshot.

- [x] **Step 2: Add a `getAgentTreeNode(instanceId): AgentTreeNode | undefined` accessor**

```ts
import type { AgentTreeNode } from '../../../../shared/types/agent-tree.types';

// inside the store class:
getAgentTreeNode(instanceId: string): AgentTreeNode | undefined {
  return this._agentTreeNodes().get(instanceId); // or whatever the existing snapshot map is named
}
```

> If no such map exists, surface the agent-tree IPC into a new `_agentTreeNodes = signal<Map<string, AgentTreeNode>>(new Map())` and listen for the existing `agent-tree:updated` event (or equivalent — check `src/main/session/agent-tree-persistence.ts` and `src/preload/preload.ts`).

- [x] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
git add src/renderer/app/core/state/instance.store.ts
git commit -m "feat(instance-store): expose getAgentTreeNode accessor for HUD/derived-state consumers"
```

---

### Task 9.2: Add `orchestration.staleThresholdMs` to settings

**Files:**
- Modify: `src/renderer/app/core/state/settings.store.ts`
- Possibly: `src/shared/types/settings.types.ts` or wherever `AppSettings` lives

- [x] **Step 1: Read AppSettings**

Find `AppSettings` type. Add an optional `orchestration?.staleThresholdMs?: number`. Default = 30000.

- [x] **Step 2: Expose a typed computed**

```ts
readonly staleThresholdMs = computed<number>(() =>
  this._settings().orchestration?.staleThresholdMs ?? 30_000
);
```

- [x] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
git add src/renderer/app/core/state/settings.store.ts
# plus any settings.types.ts edit
git commit -m "feat(settings): add orchestration.staleThresholdMs (default 30s)"
```

---

### Task 9.3: Update `child-instances-panel.component.ts` to surface role/heartbeat/derived/churn

**Files:**
- Modify: `src/renderer/app/features/instance-detail/child-instances-panel.component.ts`

- [x] **Step 1: Extend `ChildInfo` type**

```ts
import type { ChildDerivedState } from '../../../../shared/utils/child-state-deriver';
import { deriveChildState } from '../../../../shared/utils/child-state-deriver';
import { SettingsStore } from '../../core/state/settings.store';

interface ChildInfo {
  id: string;
  displayName: string;
  status: Instance['status'];
  statusLabel: string;
  isRunning: boolean;
  activity?: string;
  role?: string;
  derived?: ChildDerivedState;
}
```

- [x] **Step 2: Inject `SettingsStore` + recompute `childrenInfo`**

```ts
private settings = inject(SettingsStore);

childrenInfo = computed<ChildInfo[]>(() => {
  const ids = this.childrenIds();
  const activityMap = this.activities();
  const staleThresholdMs = this.settings.staleThresholdMs();

  return ids.map((id) => {
    const instance = this.store.getInstance(id);
    const node = this.store.getAgentTreeNode(id);
    const derived = node ? deriveChildState(node, { staleThresholdMs }) : undefined;
    const status = instance?.status || 'terminated';
    return {
      id,
      displayName: instance?.displayName || id.slice(0, 8),
      status,
      statusLabel: this.getStatusLabel(status),
      isRunning: this.runningStatuses.has(status),
      activity: activityMap.get(id),
      role: node?.role,
      derived,
    };
  }).sort((a, b) => {
    const ar = this.derivedRank(a.derived) - this.derivedRank(b.derived);
    if (ar !== 0) return ar;
    return this.getStatusRank(a.status) - this.getStatusRank(b.status);
  });
});

staleChildCount   = computed(() => this.childrenInfo().filter((c) => c.derived?.isStale).length);
failedChildCount  = computed(() => this.childrenInfo().filter((c) => c.derived?.isFailed).length);
churningChildCount = computed(() => this.childrenInfo().filter((c) => c.derived?.isChurning).length);

private derivedRank(derived?: ChildDerivedState): number {
  if (!derived) return 5;
  switch (derived.category) {
    case 'failed':  return 0;
    case 'waiting': return 1;
    case 'active':  return 2;
    case 'stale':   return 3;
    case 'idle':    return 4;
  }
}

formatRelativeAge(ms: number): string {
  if (ms < 1_000) return 'just now';
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
```

- [x] **Step 3: Update template (inside the component decorator)**

Replace the `<button class="child-item" …>` body with the new role/churn/stale/heartbeat markup (per design § 4.3). Keep the existing `<app-status-indicator>` and click handler.

- [x] **Step 4: Add styles for the new badges**

Append to the inline styles (or to the component's styles array):

```scss
.role-badge { font-size: 10px; padding: 1px 6px; border-radius: var(--radius-pill); background: var(--bg-tertiary); color: var(--text-secondary); margin-right: 4px; }
.churn-badge { font-size: 10px; padding: 1px 6px; border-radius: var(--radius-sm); background: var(--color-warning-bg); color: var(--color-warning); }
.stale-badge { font-size: 10px; padding: 1px 6px; border-radius: var(--radius-sm); background: var(--bg-tertiary); color: var(--text-secondary); font-style: italic; }
.heartbeat   { font-size: 10px; color: var(--text-tertiary); margin-left: auto; }
```

- [x] **Step 5: Update spec**

In (or create) `src/renderer/app/features/instance-detail/__tests__/child-instances-panel.component.spec.ts`, assert:

- role badge renders when `node.role` is set;
- churn badge renders past threshold;
- stale badge renders past staleThresholdMs;
- ordering puts failed first.

- [x] **Step 6: Verify**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npx vitest run src/renderer/app/features/instance-detail/
```

- [x] **Step 7: Commit**

```bash
git add src/renderer/app/features/instance-detail/child-instances-panel.component.ts \
        src/renderer/app/features/instance-detail/__tests__/child-instances-panel.component.spec.ts
git commit -m "feat(child-panel): show role badge, heartbeat, derived-state, churn count"
```

---

## Phase 10 — `OrchestrationHudComponent`

### Task 10.1: Scaffold the component

**Files:**
- Create: `src/renderer/app/features/orchestration/orchestration-hud.component.ts`
- Create: `src/renderer/app/features/orchestration/orchestration-hud.component.html`
- Create: `src/renderer/app/features/orchestration/orchestration-hud.component.scss`

- [x] **Step 1: TS skeleton**

```ts
import {
  Component, ChangeDetectionStrategy, inject, input, output, signal, computed,
} from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { buildHudSnapshot } from '../../../../main/orchestration/orchestration-hud-builder';
import type { OrchestrationHudSnapshot, HudQuickAction } from '../../../../shared/types/orchestration-hud.types';

@Component({
  selector: 'app-orchestration-hud',
  standalone: true,
  imports: [],
  templateUrl: './orchestration-hud.component.html',
  styleUrl: './orchestration-hud.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrchestrationHudComponent {
  private instanceStore = inject(InstanceStore);
  private settings = inject(SettingsStore);

  parentInstanceId = input.required<string>();
  quickAction = output<HudQuickAction>();

  isExpanded = signal(true);

  snapshot = computed<OrchestrationHudSnapshot>(() => {
    const parentId = this.parentInstanceId();
    const parent = this.instanceStore.getInstance(parentId);
    const childIds = parent?.childrenIds ?? [];
    const children = childIds
      .map((id) => this.instanceStore.getAgentTreeNode(id))
      .filter((n): n is NonNullable<typeof n> => n != null);
    const activities = this.instanceStore.instanceActivities();
    return buildHudSnapshot({
      parentInstanceId: parentId,
      children,
      activities,
      derivationOptions: { staleThresholdMs: this.settings.staleThresholdMs() },
    });
  });

  counts = computed(() => this.snapshot().countsByCategory);
  attentionItems = computed(() => this.snapshot().attentionItems);

  toggleExpand(): void { this.isExpanded.update((v) => !v); }

  emitAction(action: HudQuickAction): void { this.quickAction.emit(action); }
}
```

> Note: `buildHudSnapshot` is currently in `src/main/orchestration/`. It is pure — re-importing from the renderer side is safe because the file has no main-process side effects. Confirm by reading the implementation: only `deriveChildState` and types are imported. If TS path resolution complains, add the file to a "pure utility" location (e.g. `src/shared/utils/build-hud-snapshot.ts`) and re-export from `src/main/orchestration/orchestration-hud-builder.ts`. Decide based on type-check output.

- [x] **Step 2: HTML template**

Mirror design § 4.4. Save to `orchestration-hud.component.html`.

- [x] **Step 3: SCSS** — minimal placeholder; refine after first render works.

- [x] **Step 4: Spec**

Create `src/renderer/app/features/orchestration/__tests__/orchestration-hud.component.spec.ts` with at least:

- renders correct counts when `snapshot.countsByCategory` is set;
- emits `quickAction` `{ kind: 'focus-child', childInstanceId: '…' }` on click;
- toggles `isExpanded` on header click.

- [x] **Step 5: Verify**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npx vitest run src/renderer/app/features/orchestration/
```

- [x] **Step 6: Commit**

```bash
git add src/renderer/app/features/orchestration/orchestration-hud.component.ts \
        src/renderer/app/features/orchestration/orchestration-hud.component.html \
        src/renderer/app/features/orchestration/orchestration-hud.component.scss \
        src/renderer/app/features/orchestration/__tests__/orchestration-hud.component.spec.ts
git commit -m "feat(orchestration): add OrchestrationHudComponent with derived counts + quick-action emitter"
```

---

### Task 10.2: Mount the HUD above the child panel in `instance-detail.component.html`

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts`
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.html`

- [x] **Step 1: Import the new component**

In the host's TS:

```ts
import { OrchestrationHudComponent } from '../orchestration/orchestration-hud.component';

@Component({
  // …
  imports: [/* …existing… */, OrchestrationHudComponent],
})
```

- [x] **Step 2: Insert in the template**

Around line 228 of the html (just above `<app-child-instances-panel>`):

```html
<app-orchestration-hud
  [parentInstanceId]="inst.id"
  (quickAction)="onQuickAction($event)"
/>
```

`onQuickAction` is added in Phase 11.

- [x] **Step 3: Quick stub on the host**

Until Phase 11 lands, add a temporary stub:

```ts
onQuickAction(_action: HudQuickAction): void { /* Phase 11 wires this */ }
```

- [x] **Step 4: Verify visually + type-check**

```bash
npx tsc --noEmit
npm run lint
```

- [x] **Step 5: Commit**

```bash
git add src/renderer/app/features/instance-detail/instance-detail.component.ts \
        src/renderer/app/features/instance-detail/instance-detail.component.html
git commit -m "feat(instance-detail): mount OrchestrationHudComponent above child panel"
```

---

## Phase 11 — Quick actions

### Task 11.1: Create `QuickActionDispatcherService`

**Files:**
- Create: `src/renderer/app/features/orchestration/quick-action-dispatcher.service.ts`
- Create: `src/renderer/app/features/orchestration/__tests__/quick-action-dispatcher.service.spec.ts`

- [x] **Step 1: Spec**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuickActionDispatcherService } from '../quick-action-dispatcher.service';
import type { HudQuickAction } from '../../../../../shared/types/orchestration-hud.types';

describe('QuickActionDispatcherService', () => {
  let svc: QuickActionDispatcherService;
  let fakeInstanceStore: { selectInstance: ReturnType<typeof vi.fn> };
  let fakeIpc: { invoke: ReturnType<typeof vi.fn> };
  let fakeModal: { open: ReturnType<typeof vi.fn> };
  let fakeClipboard: { copyText: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    fakeInstanceStore = { selectInstance: vi.fn() };
    fakeIpc = { invoke: vi.fn().mockResolvedValue({ ok: true }) };
    fakeModal = { open: vi.fn() };
    fakeClipboard = { copyText: vi.fn().mockResolvedValue({ ok: true }) };
    svc = new QuickActionDispatcherService(
      fakeInstanceStore as never,
      fakeIpc as never,
      fakeModal as never,
      fakeClipboard as never,
    );
  });

  it('focus-child calls selectInstance', async () => {
    const action: HudQuickAction = { kind: 'focus-child', childInstanceId: 'c1' };
    const r = await svc.dispatch(action);
    expect(fakeInstanceStore.selectInstance).toHaveBeenCalledWith('c1');
    expect(r.ok).toBe(true);
  });

  it('copy-prompt-hash delegates to ClipboardService.copyText', async () => {
    fakeClipboard.copyText.mockResolvedValue({ ok: true });
    const action: HudQuickAction = { kind: 'copy-prompt-hash', childInstanceId: 'c1', spawnPromptHash: 'abc' };
    const r = await svc.dispatch(action);
    expect(fakeClipboard.copyText).toHaveBeenCalledWith('abc');
    expect(r.ok).toBe(true);
  });

  it('copy-prompt-hash returns reason when ClipboardService reports failure', async () => {
    fakeClipboard.copyText.mockResolvedValue({ ok: false, reason: 'permission-denied' });
    const action: HudQuickAction = { kind: 'copy-prompt-hash', childInstanceId: 'c1', spawnPromptHash: 'abc' };
    const r = await svc.dispatch(action);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('clipboard');
  });

  it('open-diagnostic-bundle invokes IPC and opens modal', async () => {
    fakeIpc.invoke.mockResolvedValue({ ok: true, bundle: { childInstanceId: 'c1' } });
    const action: HudQuickAction = { kind: 'open-diagnostic-bundle', childInstanceId: 'c1' };
    await svc.dispatch(action);
    expect(fakeIpc.invoke).toHaveBeenCalledWith('orchestration:get-child-diagnostic-bundle', { childInstanceId: 'c1' });
    expect(fakeModal.open).toHaveBeenCalled();
  });

  it('summarize-children invokes orchestrator broadcast', async () => {
    const action: HudQuickAction = { kind: 'summarize-children', parentInstanceId: 'p1' };
    await svc.dispatch(action);
    expect(fakeIpc.invoke).toHaveBeenCalledWith('orchestration:summarize-children', { parentInstanceId: 'p1' });
  });
});
```

- [x] **Step 2: Run, expect FAIL**

- [x] **Step 3: Implement**

```ts
import { Injectable, inject } from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { ElectronIpcService } from '../../core/services/ipc';
import { ChildDiagnosticBundleModalService } from './child-diagnostic-bundle.modal.service'; // Phase 12 will create this
import { CLIPBOARD_SERVICE, type ClipboardService } from '../../core/services/clipboard.service'; // Wave 4 dependency — see ship-order in parent design
import type { HudQuickAction, HudQuickActionResult } from '../../../../shared/types/orchestration-hud.types';
import { getLogger } from '../../core/logging/logger';

const logger = getLogger('QuickActionDispatcher');

@Injectable({ providedIn: 'root' })
export class QuickActionDispatcherService {
  constructor(
    private instanceStore = inject(InstanceStore),
    private ipc = inject(ElectronIpcService),
    private bundleModal = inject(ChildDiagnosticBundleModalService),
    private clipboard = inject(CLIPBOARD_SERVICE),
  ) {}

  async dispatch(action: HudQuickAction): Promise<HudQuickActionResult> {
    switch (action.kind) {
      case 'focus-child':
        this.instanceStore.selectInstance(action.childInstanceId);
        return { ok: true };

      case 'copy-prompt-hash': {
        if (!action.spawnPromptHash) return { ok: false, reason: 'No prompt hash on this child' };
        // Per parent design ship order, Wave 4 ships before Wave 5; ClipboardService is available.
        const result = await this.clipboard.copyText(action.spawnPromptHash);
        if (result.ok) return { ok: true };
        logger.warn(`copy-prompt-hash failed: ${result.reason}`);
        return { ok: false, reason: `clipboard write failed: ${result.reason}` };
      }

      case 'open-diagnostic-bundle': {
        const r = await this.ipc.invoke('orchestration:get-child-diagnostic-bundle', { childInstanceId: action.childInstanceId });
        if ((r as { ok: boolean }).ok) {
          this.bundleModal.open((r as { bundle: unknown }).bundle);
          return { ok: true };
        }
        return { ok: false, reason: 'failed to fetch diagnostic bundle' };
      }

      case 'summarize-children': {
        const r = await this.ipc.invoke('orchestration:summarize-children', { parentInstanceId: action.parentInstanceId });
        return { ok: !!(r as { ok: boolean }).ok };
      }
    }
  }
}
```

- [x] **Step 4: Run, type-check, lint, commit**

```bash
npx vitest run src/renderer/app/features/orchestration/__tests__/quick-action-dispatcher.service.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/renderer/app/features/orchestration/quick-action-dispatcher.service.ts \
        src/renderer/app/features/orchestration/__tests__/quick-action-dispatcher.service.spec.ts
git commit -m "feat(orchestration): add QuickActionDispatcherService with clipboard fallback (Wave-4-migratable)"
```

---

### Task 11.2: Wire `onQuickAction` in `instance-detail.component.ts`

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts`

- [x] **Step 1: Inject + replace stub**

```ts
import { QuickActionDispatcherService } from '../orchestration/quick-action-dispatcher.service';
import type { HudQuickAction } from '../../../../shared/types/orchestration-hud.types';

private dispatcher = inject(QuickActionDispatcherService);

async onQuickAction(action: HudQuickAction): Promise<void> {
  const result = await this.dispatcher.dispatch(action);
  if (!result.ok) {
    // Inline banner via existing `lastError` pattern, or console.warn fallback if no banner system.
    console.warn(`[QuickAction:${action.kind}] ${result.reason ?? 'failed'}`);
  }
}
```

- [x] **Step 2: Verify**

```bash
npx tsc --noEmit
npm run lint
git add src/renderer/app/features/instance-detail/instance-detail.component.ts
git commit -m "feat(instance-detail): route HUD quick actions through dispatcher"
```

---

### Task 11.3: Add backend handler for `orchestration:get-child-diagnostic-bundle` and `orchestration:summarize-children` (if not already present)

**Files:**
- Modify (or create): `src/main/ipc/handlers/orchestration-handlers.ts`

- [x] **Step 1: Read existing handlers**

The existing `child-diagnostics.ts` builds the bundle. Confirm whether an IPC handler already invokes it. If yes, just verify the channel name matches `orchestration:get-child-diagnostic-bundle`. If no, register it now:

```ts
ipcMain.handle('orchestration:get-child-diagnostic-bundle', async (_evt, payload: { childInstanceId: string }) => {
  const child = getInstanceManager().getInstance(payload.childInstanceId);
  if (!child) return { ok: false, reason: 'instance-not-found' };
  const bundle = await buildChildDiagnosticBundle(child);
  return { ok: true, bundle };
});
```

For `orchestration:summarize-children`, route through the existing orchestrator's broadcast helper. If no helper exists, emit a synthetic spawn-child task with prompt "Summarize current children's status and progress" — defer the implementation if it's nontrivial; the action is allowed to no-op for Wave 5 with `{ ok: true, reason: 'not-implemented-yet' }` and a logger note.

- [x] **Step 2: Validate payload with Zod**

Add a payload schema (in `@contracts/schemas/orchestration` or co-located) — keep AGENTS.md gotcha #1 in mind only if a brand-new alias is introduced. Existing `orchestration.schemas.ts` is the natural home; the alias is already registered.

- [x] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
git add src/main/ipc/handlers/orchestration-handlers.ts
# plus any schema edits
git commit -m "feat(orchestration): IPC handlers for get-child-diagnostic-bundle and summarize-children"
```

---

## Phase 12 — `ChildDiagnosticBundleModal`

### Task 12.1: Modal service + component

**Files:**
- Create: `src/renderer/app/features/orchestration/child-diagnostic-bundle.modal.service.ts`
- Create: `src/renderer/app/features/orchestration/child-diagnostic-bundle.modal.component.ts`
- Create: `src/renderer/app/features/orchestration/child-diagnostic-bundle.modal.component.html`
- Create: `src/renderer/app/features/orchestration/child-diagnostic-bundle.modal.component.scss`

- [x] **Step 1: Service skeleton**

```ts
import { Injectable, signal } from '@angular/core';
import type { ChildDiagnosticBundle } from '../../../../shared/types/agent-tree.types';

@Injectable({ providedIn: 'root' })
export class ChildDiagnosticBundleModalService {
  private _bundle = signal<ChildDiagnosticBundle | null>(null);
  readonly bundle = this._bundle.asReadonly();

  open(bundle: ChildDiagnosticBundle): void {
    this._bundle.set(bundle);
  }
  close(): void {
    this._bundle.set(null);
  }
}
```

- [x] **Step 2: Component**

```ts
import {
  Component, ChangeDetectionStrategy, inject, computed, HostListener,
} from '@angular/core';
import { ChildDiagnosticBundleModalService } from './child-diagnostic-bundle.modal.service';

@Component({
  selector: 'app-child-diagnostic-bundle-modal',
  standalone: true,
  templateUrl: './child-diagnostic-bundle.modal.component.html',
  styleUrl: './child-diagnostic-bundle.modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChildDiagnosticBundleModalComponent {
  private svc = inject(ChildDiagnosticBundleModalService);
  private clipboard = inject(CLIPBOARD_SERVICE);
  bundle = computed(() => this.svc.bundle());

  close(): void { this.svc.close(); }

  @HostListener('document:keydown.escape')
  onEscape(): void { this.close(); }

  copyPromptHash(): void {
    const b = this.bundle();
    if (!b?.spawnPromptHash) return;
    void this.clipboard.copyText(b.spawnPromptHash);
  }
}
```

- [x] **Step 3: HTML**

```html
@if (bundle(); as b) {
  <div class="modal-backdrop" (click)="close()">
    <article
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Child diagnostic bundle"
      (click)="$event.stopPropagation()"
    >
      <header class="modal-header">
        <h2>{{ b.childId }}</h2>
        <span class="status">{{ b.status }}</span>
        <button class="close" (click)="close()" aria-label="Close">×</button>
      </header>

      <section class="modal-body">
        <dl class="metadata">
          <dt>Provider</dt><dd>{{ b.provider }}</dd>
          @if (b.model) { <dt>Model</dt><dd>{{ b.model }}</dd> }
          <dt>Working dir</dt><dd>{{ b.workingDirectory }}</dd>
          @if (b.spawnTaskSummary) { <dt>Task</dt><dd>{{ b.spawnTaskSummary }}</dd> }
          @if (b.spawnPromptHash) {
            <dt>Prompt hash</dt>
            <dd class="hash">
              <code>{{ b.spawnPromptHash }}</code>
              <button (click)="copyPromptHash()">Copy</button>
            </dd>
          }
          @if (b.timeoutReason) { <dt>Timeout reason</dt><dd>{{ b.timeoutReason }}</dd> }
        </dl>

        @if (b.routing) {
          <section>
            <h3>Routing</h3>
            <pre>{{ b.routing | json }}</pre>
          </section>
        }

        <section>
          <h3>Status timeline</h3>
          <ul class="timeline">
            @for (t of b.statusTimeline; track t.timestamp) {
              <li>
                <time>{{ t.timestamp }}</time>
                <span>{{ t.status }}</span>
              </li>
            }
          </ul>
        </section>

        <section>
          <h3>Recent events</h3>
          <ul>
            @for (e of b.recentEvents; track e.timestamp) {
              <li>[{{ e.type }}] {{ e.summary }}</li>
            }
          </ul>
        </section>

        <section>
          <h3>Recent output</h3>
          <pre class="output">@for (l of b.recentOutputTail; track l.timestamp) {{{ l.content }}
}</pre>
        </section>

        <section>
          <h3>Artifacts</h3>
          <pre>{{ b.artifactsSummary | json }}</pre>
        </section>
      </section>
    </article>
  </div>
}
```

- [x] **Step 4: SCSS — minimal modal styles**

(Standard backdrop + centered modal. Use existing CSS variables from the design tokens.)

- [x] **Step 5: Spec**

```ts
import { describe, it, expect } from 'vitest';
// …mount component, set svc.open(bundle), assert renders, fire Esc, assert close.
```

- [x] **Step 6: Mount the modal globally**

Add `<app-child-diagnostic-bundle-modal />` once at the app root (e.g. in `app.component.html` or `instance-detail.component.html`'s outermost wrapper). It renders only when the service has a bundle.

- [x] **Step 7: Verify + commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npx vitest run src/renderer/app/features/orchestration/
git add src/renderer/app/features/orchestration/child-diagnostic-bundle.modal.*.ts \
        src/renderer/app/features/orchestration/child-diagnostic-bundle.modal.component.html \
        src/renderer/app/features/orchestration/child-diagnostic-bundle.modal.component.scss \
        src/renderer/app/features/orchestration/__tests__/child-diagnostic-bundle.modal.component.spec.ts
# plus any app.component.html mount edit
git commit -m "feat(orchestration): add ChildDiagnosticBundleModal + service"
```

---

## Phase 13 — Final integration, lint, tests, manual smoke, packaged DMG smoke

### Task 13.1: Full repo verification

- [x] **Step 1: Full type-check**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

- [x] **Step 2: Full lint**

```bash
npm run lint
```

- [x] **Step 3: Full test suite**

```bash
npm run test
```

If a previously-passing test fails, read the error carefully — the most likely culprit is a verification or child-panel spec that expected the pre-Wave-5 shape. Update tests to match the new contract; do NOT change the implementation just to make stale tests pass.

---

### Task 13.2: Verify the 4-place alias-sync visually

- [x] **Step 1: `tsconfig.json`** — confirm `@contracts/schemas/verification` entry present.
- [x] **Step 2: `tsconfig.electron.json`** — same.
- [x] **Step 3: `src/main/register-aliases.ts`** — confirm `'@contracts/schemas/verification'` in `exactAliases`.
- [x] **Step 4: `vitest.config.ts`** — confirm alias mirrors the others.

---

### Task 13.3: Manual smoke (UI)

- [x] Start `npm run dev`.
- [x] Open a parent session and spawn ≥3 children.
- [x] Verify the HUD renders above the child panel with correct counts.
- [x] Pause one child for >30s and confirm a "stale" badge appears.
- [x] Click "Focus" on a child → renderer routes to that instance.
- [x] Click "Copy hash" → paste into another app, hex hash present.
- [x] Click "Diagnostics" on a child → modal opens with bundle data; close on Esc.
- [x] Click "Summarize" → orchestrator broadcasts (or logs not-implemented-yet, allowable for Wave 5).
- [x] Trigger a multi-verify; verdict header renders above the existing tabs.
- [x] Switch to Raw tab → all responses still listed (rawResponses preserved).

---

### Task 13.4: Packaged DMG smoke (verifies alias-sync)

- [x] Build:

```bash
npm run build
```

- [x] Open the produced DMG. Launch the app. Confirm:
  - App starts without `Cannot find module '…/schemas/verification'`.
  - Multi-verify still works end-to-end.
  - HUD renders.

If the app crashes on startup with a missing-module error, return to Task 5.2 and find the missing alias-sync site. (Common miss: `vitest.config.ts` is fine for tests but irrelevant at runtime; `register-aliases.ts` is the runtime resolver and **must** include the entry.)

---

### Task 13.5: Final commit

```bash
git add -A
git commit -m "chore(wave5): verification verdict + orchestration HUD ready for review"
```

> Local commit only. Do **not** push.

---

## Acceptance criteria recap

The wave is shippable when **all** of the following hold:

1. `npx tsc --noEmit` passes.
2. `npx tsc --noEmit -p tsconfig.spec.json` passes.
3. `npm run lint` passes with no new warnings.
4. New unit specs (Phases 2, 3, 4, 5, 10, 11, 12) pass.
5. Existing tests (`child-diagnostics.spec.ts`, `verification-results.component.spec.ts`, etc.) still pass.
6. `verification:verdict-ready` round-trips main → renderer; verdict header renders.
7. Stale child surfaces "stale" badge in child panel and HUD without log diving.
8. Churning child surfaces "churn ×N" badge in both panel and HUD.
9. Quick actions: focus, copy hash (fallback path), open bundle, summarize all dispatch correctly.
10. Packaged DMG starts (smoke run) — confirms `@contracts/schemas/verification` 4-place alias-sync is correct.
11. `VerificationResult.responses` deep-equals `verdict.rawResponses` (no truncation).

---

## Non-goals

- No agent-tree v3 schema migration.
- No replacement of existing verification tabs (Summary/Comparison/Debate/Raw).
- No persisted verdicts across app restart (follow-up; verdict re-derives in-memory on fresh result).
- No rewrite of `MultiVerifyCoordinator`.

---

## Appendix A — Wave 4 dependency

Wave 5 consumes Wave 4's `ClipboardService` directly (no fallback path or `WAVE-4-MIGRATE` markers). The parent design pins Wave 4 to ship before Wave 5; if for some reason Wave 4 has not landed when Wave 5 starts, **STOP and escalate** rather than introducing a temporary `navigator.clipboard.writeText` path. The `HudQuickAction` discriminated union and the dispatcher signature are stable; no migration is needed downstream.

## Appendix B — Mapping back to parent plan

| Parent plan task (Wave 5) | Phase / Task |
|---|---|
| Add derived child state fields (stale, active, waiting, failed, turn count, churn count) | Phase 2 |
| Expose role badges and heartbeat/last activity in the child panel | Phase 9 |
| Add compact orchestration HUD for parent sessions | Phase 10 |
| Add quick actions: focus, copy hash, open bundle, summarize | Phase 11 |
| Add shared `VerificationVerdict` type and schema | Phase 1, Phase 5 |
| Normalize multi-verify results into the verdict contract | Phase 3, Phase 6 |
| Render verdict status, confidence, required actions, risk areas above details | Phase 7, Phase 8 |

## Appendix C — File-by-file change inventory

### Created

| Path | Phase |
|---|---|
| `src/shared/utils/child-state-deriver.ts` + spec | Phase 2 |
| `src/shared/types/orchestration-hud.types.ts` | Phase 1 |
| `src/main/orchestration/verification-verdict-deriver.ts` + spec | Phase 3 |
| `src/main/orchestration/orchestration-hud-builder.ts` + spec | Phase 4 |
| `packages/contracts/src/schemas/verification.schemas.ts` + spec | Phase 5 |
| `src/renderer/app/features/orchestration/orchestration-hud.component.ts` + html + scss + spec | Phase 10 |
| `src/renderer/app/features/orchestration/quick-action-dispatcher.service.ts` + spec | Phase 11 |
| `src/renderer/app/features/orchestration/child-diagnostic-bundle.modal.component.ts` + html + scss + service + spec | Phase 12 |

### Modified

| Path | Phase |
|---|---|
| `src/shared/types/verification.types.ts` | Phase 1 |
| `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, `vitest.config.ts` | Phase 5 |
| `src/main/orchestration/orchestration-activity-bridge.ts` (+ spec) | Phase 6 |
| `src/preload/preload.ts` | Phase 7 |
| `src/renderer/app/core/state/verification/verification.store.ts`, `verification.types.ts` | Phase 7 |
| `src/renderer/app/features/verification/results/verification-results.component.ts` (+ html + scss + spec) | Phase 8 |
| `src/renderer/app/core/state/instance.store.ts` | Phase 9 |
| `src/renderer/app/core/state/settings.store.ts` (+ settings types) | Phase 9 |
| `src/renderer/app/features/instance-detail/child-instances-panel.component.ts` (+ spec) | Phase 9 |
| `src/renderer/app/features/instance-detail/instance-detail.component.ts` + html | Phase 10, Phase 11 |
| `src/main/ipc/handlers/orchestration-handlers.ts` (if necessary) | Phase 11 |

### Removed

None.

---

## End of plan
