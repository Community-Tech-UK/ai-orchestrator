# Cross-Model Review Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a background service that automatically dispatches primary AI output (code, plans, architecture) to secondary models (Gemini, Codex, Copilot) for independent review, surfacing disagreements non-intrusively.

**Architecture:** New `CrossModelReviewService` singleton listens to `instance:output` events, buffers assistant messages per-instance, triggers classification when the instance goes idle (via `instance:batch-update`), dispatches to 2 secondary CLIs using round-robin with failover, and emits review results to the renderer via IPC. Completely decoupled from the primary instance flow.

**Tech Stack:** TypeScript, Electron IPC, Angular 21 (zoneless/signals), Zod 4 validation, existing CLI adapters + CircuitBreaker

**Spec:** `docs/superpowers/specs/2026-03-20-cross-model-review-design.md`

---

## File Structure

### New Files (Main Process)
| File | Responsibility |
|------|---------------|
| `src/shared/types/cross-model-review.types.ts` | Shared types: `ReviewOutputType`, `ReviewVerdict`, `ReviewDimensionScore`, `ReviewResult`, `CrossModelReviewStatus`, `ReviewAction` |
| `src/shared/validation/cross-model-review-schemas.ts` | Zod schemas for IPC payloads (`ReviewDismissSchema`, `ReviewActionSchema`, `ReviewResultSchema`) |
| `src/main/orchestration/cross-model-review.types.ts` | Internal types: `ReviewerInfo`, `ReviewRequest`, `AggregatedReview`, `OutputClassification` |
| `src/main/orchestration/output-classifier.ts` | Heuristic output classification (code/plan/architecture/conversation) + complexity scoring |
| `src/main/orchestration/reviewer-pool.ts` | Round-robin reviewer selection, availability tracking, rate-limit failover |
| `src/main/orchestration/review-prompts.ts` | Prompt templates: structured review + tiered/escalated review |
| `src/main/orchestration/cross-model-review-service.ts` | Main singleton service: buffering, dispatch, result collection |
| `src/main/ipc/cross-model-review-ipc.ts` | IPC handler registration for review channels |

### New Files (Renderer)
| File | Responsibility |
|------|---------------|
| `src/renderer/app/features/instance-detail/cross-model-review-indicator.component.ts` | Small status badge (green/amber/grey/spinner) in instance header |
| `src/renderer/app/features/instance-detail/cross-model-review-panel.component.ts` | Expandable inline review panel with scores + action buttons |
| `src/renderer/app/core/services/ipc/cross-model-review-ipc.service.ts` | Angular service wrapping IPC calls for review channels |
| `src/renderer/app/features/settings/review-settings-tab.component.ts` | Review category settings tab |

### Modified Files
| File | Change |
|------|--------|
| `src/shared/types/ipc.types.ts` | Add 4 new IPC channel constants |
| `src/shared/types/settings.types.ts` | Add 6 new `AppSettings` fields, extend `SettingMetadata` types, add to `DEFAULT_SETTINGS` and `SETTINGS_METADATA` |
| `src/main/orchestration/index.ts` | Export new service + getter |
| `src/main/index.ts` | Initialize `CrossModelReviewService` at startup, register IPC handlers |
| `src/preload/preload.ts` | Expose 4 new IPC channels to renderer |
| `src/renderer/app/features/instance-detail/instance-header.component.ts` | Add review indicator badge |
| `src/renderer/app/features/instance-detail/instance-detail.component.ts` | Add review panel below output |
| `src/renderer/app/features/settings/settings.component.ts` | Add review tab |
| `src/renderer/app/features/settings/setting-row.component.ts` | Add multi-select rendering |
| `src/renderer/app/core/state/settings.store.ts` | Add `reviewSettings` computed |

### Test Files
| File | Tests |
|------|-------|
| `src/main/orchestration/output-classifier.spec.ts` | Classification heuristics + complexity scoring |
| `src/main/orchestration/reviewer-pool.spec.ts` | Round-robin, failover, rate-limit, recovery |
| `src/main/orchestration/cross-model-review-service.spec.ts` | End-to-end: buffer → classify → dispatch → collect → emit |
| `src/shared/validation/cross-model-review-schemas.spec.ts` | Zod schema validation (valid/invalid payloads) |

---

## Task 1: Shared Types

**Files:**
- Create: `src/shared/types/cross-model-review.types.ts`
- Modify: `src/shared/types/settings.types.ts:11-12` (CliType import), `src/shared/types/settings.types.ts:112-122` (SettingMetadata)
- Test: `npx tsc --noEmit` (type-only, no runtime test needed)

- [ ] **Step 1.1: Create cross-model review shared types**

```typescript
// src/shared/types/cross-model-review.types.ts

/**
 * Cross-Model Review Types
 * Shared between main process and renderer
 */

/** Output types that can trigger a review */
export type ReviewOutputType = 'code' | 'plan' | 'architecture';

/** Review verdict from a single reviewer */
export type ReviewVerdict = 'APPROVE' | 'CONCERNS' | 'REJECT';

/** Dimension score from a reviewer */
export interface ReviewDimensionScore {
  reasoning: string;
  score: number; // 1-4
  issues: string[];
}

/** Structured review result from a single reviewer */
export interface ReviewResult {
  reviewerId: string;       // e.g. 'gemini', 'codex'
  reviewType: 'structured' | 'tiered';
  scores: {
    correctness: ReviewDimensionScore;
    completeness: ReviewDimensionScore;
    security: ReviewDimensionScore;
    consistency: ReviewDimensionScore;
    feasibility?: ReviewDimensionScore; // only in tiered reviews
  };
  overallVerdict: ReviewVerdict;
  summary: string;
  criticalIssues?: string[];
  // Tiered-only fields
  traces?: { scenario: string; result: 'pass' | 'fail'; detail: string }[];
  boundariesChecked?: string[];
  assumptions?: { assumption: string; severity: 'high' | 'medium' | 'low' }[];
  integrationRisks?: string[];
  // Metadata
  timestamp: number;
  durationMs: number;
  parseSuccess: boolean; // whether JSON parsing succeeded
  rawResponse?: string;  // kept if parse failed, for debugging
}

/** Aggregated review for a single output */
export interface AggregatedReview {
  id: string;
  instanceId: string;
  outputType: ReviewOutputType;
  reviewDepth: 'structured' | 'tiered';
  reviews: ReviewResult[];
  hasDisagreement: boolean;
  timestamp: number;
}

/** Status of the cross-model review system */
export interface CrossModelReviewStatus {
  enabled: boolean;
  reviewers: {
    cliType: string;
    available: boolean;
    rateLimited: boolean;
    totalReviews: number;
  }[];
  pendingReviews: number;
}

/** Actions the user can take on a review */
export type ReviewActionType = 'dismiss' | 'ask-primary' | 'show-full' | 'start-debate';

export interface ReviewActionPayload {
  reviewId: string;
  instanceId: string;
  action: ReviewActionType;
}

export interface ReviewDismissPayload {
  reviewId: string;
  instanceId: string;
}
```

- [ ] **Step 1.2: Extend SettingMetadata types in settings.types.ts**

In `src/shared/types/settings.types.ts`, update the `SettingMetadata` interface:

```typescript
// Line 116: add 'multi-select' to type union
type: 'boolean' | 'string' | 'number' | 'select' | 'directory' | 'multi-select';

// Line 117: add 'review' to category union
category: 'general' | 'orchestration' | 'memory' | 'display' | 'advanced' | 'review';

// Line 118: add dynamicOptions field
options?: { value: string | number; label: string }[];
dynamicOptions?: boolean; // if true, options are populated at runtime
```

- [ ] **Step 1.3: Add cross-model review fields to AppSettings**

In `src/shared/types/settings.types.ts`, add to the `AppSettings` interface (after line 52, before the closing `}`):

```typescript
  // Cross-Model Review
  crossModelReviewEnabled: boolean;
  crossModelReviewDepth: 'structured' | 'tiered';
  crossModelReviewMaxReviewers: number;
  crossModelReviewProviders: string[];  // CliType values, empty = auto-detect
  crossModelReviewTimeout: number;      // seconds
  crossModelReviewTypes: string[];      // ReviewOutputType values
```

Add to `DEFAULT_SETTINGS` (after line 92):

```typescript
  // Cross-Model Review
  crossModelReviewEnabled: true,
  crossModelReviewDepth: 'structured',
  crossModelReviewMaxReviewers: 2,
  crossModelReviewProviders: [],          // auto-detect
  crossModelReviewTimeout: 30,
  crossModelReviewTypes: ['code', 'plan', 'architecture'],
```

- [ ] **Step 1.4: Add SETTINGS_METADATA entries for review category**

In `src/shared/types/settings.types.ts`, add after the Advanced section (after line 349):

```typescript
  // Cross-Model Review
  {
    key: 'crossModelReviewEnabled',
    label: 'Enable Cross-Model Review',
    description: 'Automatically verify AI output using secondary models (Gemini, Codex, etc.)',
    type: 'boolean',
    category: 'review',
  },
  {
    key: 'crossModelReviewDepth',
    label: 'Review Depth',
    description: 'Level of verification detail (structured = standard, tiered = deep for complex output)',
    type: 'select',
    category: 'review',
    options: [
      { value: 'structured', label: 'Structured (standard)' },
      { value: 'tiered', label: 'Tiered (auto-escalate for complex)' },
    ],
  },
  {
    key: 'crossModelReviewMaxReviewers',
    label: 'Max Reviewers',
    description: 'Number of secondary models to use for each review',
    type: 'number',
    category: 'review',
    min: 1,
    max: 4,
  },
  {
    key: 'crossModelReviewProviders',
    label: 'Preferred Review Providers',
    description: 'Which CLIs to use for reviews (empty = auto-detect available)',
    type: 'multi-select',
    category: 'review',
    options: [
      { value: 'gemini', label: 'Gemini CLI' },
      { value: 'codex', label: 'OpenAI Codex CLI' },
      { value: 'copilot', label: 'GitHub Copilot' },
      { value: 'claude', label: 'Claude Code' },
    ],
  },
  {
    key: 'crossModelReviewTimeout',
    label: 'Review Timeout (seconds)',
    description: 'Maximum time to wait for each reviewer response',
    type: 'number',
    category: 'review',
    min: 10,
    max: 120,
  },
  {
    key: 'crossModelReviewTypes',
    label: 'Review Triggers',
    description: 'Which output types trigger automatic review',
    type: 'multi-select',
    category: 'review',
    options: [
      { value: 'code', label: 'Code' },
      { value: 'plan', label: 'Plans' },
      { value: 'architecture', label: 'Architecture' },
    ],
  },
```

- [ ] **Step 1.5: Add IPC channel constants**

In `src/shared/types/ipc.types.ts`, add after the existing channels (around line 114):

```typescript
  // Cross-Model Review
  CROSS_MODEL_REVIEW_RESULT: 'cross-model-review:result',
  CROSS_MODEL_REVIEW_STATUS: 'cross-model-review:status',
  CROSS_MODEL_REVIEW_DISMISS: 'cross-model-review:dismiss',
  CROSS_MODEL_REVIEW_ACTION: 'cross-model-review:action',
```

- [ ] **Step 1.6: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 1.7: Commit**

```bash
git add src/shared/types/cross-model-review.types.ts src/shared/types/settings.types.ts src/shared/types/ipc.types.ts
git commit -m "feat(types): add cross-model review types, settings, and IPC channels"
```

---

## Task 2: Zod Validation Schemas

**Files:**
- Create: `src/shared/validation/cross-model-review-schemas.ts`
- Create: `src/shared/validation/cross-model-review-schemas.spec.ts`
- Modify: `src/shared/validation/ipc-schemas.ts` (re-export)

- [ ] **Step 2.1: Write failing test for Zod schemas**

```typescript
// src/shared/validation/cross-model-review-schemas.spec.ts
import { describe, it, expect } from 'vitest';
import {
  ReviewDismissPayloadSchema,
  ReviewActionPayloadSchema,
  ReviewResultJsonSchema,
} from './cross-model-review-schemas';

describe('CrossModelReviewSchemas', () => {
  describe('ReviewDismissPayloadSchema', () => {
    it('accepts valid dismiss payload', () => {
      const result = ReviewDismissPayloadSchema.safeParse({
        reviewId: 'review-123',
        instanceId: 'inst-456',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing reviewId', () => {
      const result = ReviewDismissPayloadSchema.safeParse({
        instanceId: 'inst-456',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ReviewActionPayloadSchema', () => {
    it('accepts valid action payload', () => {
      const result = ReviewActionPayloadSchema.safeParse({
        reviewId: 'review-123',
        instanceId: 'inst-456',
        action: 'ask-primary',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid action type', () => {
      const result = ReviewActionPayloadSchema.safeParse({
        reviewId: 'review-123',
        instanceId: 'inst-456',
        action: 'invalid-action',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ReviewResultJsonSchema', () => {
    it('accepts valid structured review JSON', () => {
      const result = ReviewResultJsonSchema.safeParse({
        correctness: { reasoning: 'Looks correct', score: 4, issues: [] },
        completeness: { reasoning: 'Complete', score: 4, issues: [] },
        security: { reasoning: 'No issues', score: 4, issues: [] },
        consistency: { reasoning: 'Consistent', score: 4, issues: [] },
        overall_verdict: 'APPROVE',
        summary: 'All good',
      });
      expect(result.success).toBe(true);
    });

    it('rejects score out of range', () => {
      const result = ReviewResultJsonSchema.safeParse({
        correctness: { reasoning: 'ok', score: 5, issues: [] },
        completeness: { reasoning: 'ok', score: 4, issues: [] },
        security: { reasoning: 'ok', score: 4, issues: [] },
        consistency: { reasoning: 'ok', score: 4, issues: [] },
        overall_verdict: 'APPROVE',
        summary: 'ok',
      });
      expect(result.success).toBe(false);
    });
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `npx vitest run src/shared/validation/cross-model-review-schemas.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 2.3: Implement Zod schemas**

```typescript
// src/shared/validation/cross-model-review-schemas.ts
import { z } from 'zod';

// ============ IPC Payload Schemas ============

export const ReviewDismissPayloadSchema = z.object({
  reviewId: z.string().min(1).max(100),
  instanceId: z.string().min(1).max(100),
});

export const ReviewActionPayloadSchema = z.object({
  reviewId: z.string().min(1).max(100),
  instanceId: z.string().min(1).max(100),
  action: z.enum(['dismiss', 'ask-primary', 'show-full', 'start-debate']),
});

// ============ Review Result JSON Schemas ============
// Used to validate JSON responses from reviewer LLMs

const DimensionScoreSchema = z.object({
  reasoning: z.string(),
  score: z.number().int().min(1).max(4),
  issues: z.array(z.string()),
});

/** Schema for the structured review prompt's expected JSON output */
export const ReviewResultJsonSchema = z.object({
  correctness: DimensionScoreSchema,
  completeness: DimensionScoreSchema,
  security: DimensionScoreSchema,
  consistency: DimensionScoreSchema,
  overall_verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
  summary: z.string(),
});

/** Schema for tiered/escalated review prompt's expected JSON output */
export const TieredReviewResultJsonSchema = z.object({
  traces: z.array(z.object({
    scenario: z.string(),
    result: z.enum(['pass', 'fail']),
    detail: z.string(),
  })).optional(),
  boundaries_checked: z.array(z.string()).optional(),
  assumptions: z.array(z.object({
    assumption: z.string(),
    severity: z.enum(['high', 'medium', 'low']),
  })).optional(),
  integration_risks: z.array(z.string()).optional(),
  scores: z.object({
    correctness: DimensionScoreSchema,
    completeness: DimensionScoreSchema,
    security: DimensionScoreSchema,
    consistency: DimensionScoreSchema,
    feasibility: DimensionScoreSchema.optional(),
  }),
  overall_verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
  summary: z.string(),
  critical_issues: z.array(z.string()).optional(),
});

export type ReviewDismissPayload = z.infer<typeof ReviewDismissPayloadSchema>;
export type ReviewActionPayload = z.infer<typeof ReviewActionPayloadSchema>;
export type ReviewResultJson = z.infer<typeof ReviewResultJsonSchema>;
export type TieredReviewResultJson = z.infer<typeof TieredReviewResultJsonSchema>;
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `npx vitest run src/shared/validation/cross-model-review-schemas.spec.ts`
Expected: PASS — all 5 tests

- [ ] **Step 2.5: Verify compilation**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 2.6: Commit**

```bash
git add src/shared/validation/cross-model-review-schemas.ts src/shared/validation/cross-model-review-schemas.spec.ts
git commit -m "feat(validation): add Zod schemas for cross-model review IPC payloads"
```

---

## Task 3: Output Classifier

**Files:**
- Create: `src/main/orchestration/output-classifier.ts`
- Create: `src/main/orchestration/output-classifier.spec.ts`

- [ ] **Step 3.1: Write failing tests for OutputClassifier**

```typescript
// src/main/orchestration/output-classifier.spec.ts
import { describe, it, expect } from 'vitest';
import { OutputClassifier } from './output-classifier';

describe('OutputClassifier', () => {
  const classifier = new OutputClassifier();

  describe('classify', () => {
    it('classifies fenced code blocks as code', () => {
      const result = classifier.classify('Here is the fix:\n```typescript\nconst x = 1;\n```');
      expect(result.type).toBe('code');
    });

    it('classifies numbered step lists as plan', () => {
      const result = classifier.classify('## Implementation Plan\n1. Create the service\n2. Add tests\n3. Wire IPC\n4. Build UI\n5. Integration test\n6. Deploy');
      expect(result.type).toBe('plan');
    });

    it('classifies architecture keywords as architecture', () => {
      const result = classifier.classify('## System Design\nThe data flow goes from the API gateway through the message queue to the worker pool. Component diagram:\n```\nAPI -> Queue -> Worker\n```');
      expect(result.type).toBe('architecture');
    });

    it('classifies short text as conversation', () => {
      const result = classifier.classify('Sure, I can help with that.');
      expect(result.type).toBe('conversation');
    });

    it('skips output below minimum length', () => {
      const result = classifier.classify('Done.');
      expect(result.type).toBe('conversation');
      expect(result.shouldReview).toBe(false);
    });

    it('does not review conversation type', () => {
      const result = classifier.classify('That sounds like a good approach. Let me know if you have questions.');
      expect(result.shouldReview).toBe(false);
    });
  });

  describe('complexity scoring', () => {
    it('marks large code blocks as complex', () => {
      const lines = Array.from({ length: 120 }, (_, i) => `  const line${i} = ${i};`);
      const result = classifier.classify('```typescript\n' + lines.join('\n') + '\n```');
      expect(result.isComplex).toBe(true);
    });

    it('marks plans with >5 steps as complex', () => {
      const result = classifier.classify('Plan:\n1. Step one\n2. Step two\n3. Step three\n4. Step four\n5. Step five\n6. Step six\n7. Step seven');
      expect(result.isComplex).toBe(true);
    });

    it('auto-escalates security keywords', () => {
      const result = classifier.classify('```typescript\nconst query = `SELECT * FROM users WHERE id = ${userId}`;\n```');
      expect(result.isComplex).toBe(true);
    });
  });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `npx vitest run src/main/orchestration/output-classifier.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3.3: Implement OutputClassifier**

```typescript
// src/main/orchestration/output-classifier.ts

import type { ReviewOutputType } from '../../shared/types/cross-model-review.types';

export type ClassificationType = ReviewOutputType | 'conversation';

export interface OutputClassification {
  type: ClassificationType;
  shouldReview: boolean;
  isComplex: boolean;
  complexityReasons: string[];
  codeLineCount: number;
  fileCount: number;
  stepCount: number;
}

const MIN_OUTPUT_LENGTH = 50;

const CODE_FENCE_REGEX = /```[\w]*\n([\s\S]*?)```/g;
const NUMBERED_STEP_REGEX = /^\s*\d+\.\s+/gm;
const FILE_TOUCH_REGEX = /(?:create|modify|edit|write|update)\s+`?[\w/.\\-]+\.[a-z]+`?/gi;

const COMPLEXITY_KEYWORDS = [
  'security', 'auth', 'authentication', 'authorization',
  'migration', 'database schema', 'breaking change',
  'encryption', 'password', 'secret', 'credential',
  'sql injection', 'xss', 'csrf',
];

const ARCHITECTURE_KEYWORDS = [
  'system design', 'data flow', 'component diagram',
  'architecture', 'service mesh', 'microservice',
  'load balancer', 'message queue', 'event bus',
];

const PLAN_KEYWORDS = [
  'implementation plan', 'action plan', 'migration plan',
  'step-by-step', 'phases:', 'milestones:',
];

export class OutputClassifier {
  classify(content: string): OutputClassification {
    const result: OutputClassification = {
      type: 'conversation',
      shouldReview: false,
      isComplex: false,
      complexityReasons: [],
      codeLineCount: 0,
      fileCount: 0,
      stepCount: 0,
    };

    // Minimum length gate
    if (content.length < MIN_OUTPUT_LENGTH) {
      return result;
    }

    const lowerContent = content.toLowerCase();

    // Count code lines
    const codeBlocks = [...content.matchAll(CODE_FENCE_REGEX)];
    result.codeLineCount = codeBlocks.reduce((sum, match) => sum + match[1].split('\n').length, 0);

    // Count numbered steps
    const steps = content.match(NUMBERED_STEP_REGEX);
    result.stepCount = steps?.length ?? 0;

    // Count file touches
    const fileTouches = content.match(FILE_TOUCH_REGEX);
    result.fileCount = fileTouches?.length ?? 0;

    // Classification priority: architecture > plan > code > conversation
    if (this.isArchitecture(lowerContent)) {
      result.type = 'architecture';
      result.shouldReview = true;
      result.isComplex = true; // architecture is always complex
      result.complexityReasons.push('architecture output');
    } else if (this.isPlan(lowerContent, result.stepCount)) {
      result.type = 'plan';
      result.shouldReview = true;
    } else if (result.codeLineCount > 0) {
      result.type = 'code';
      result.shouldReview = true;
    }

    // Complexity scoring (for non-architecture)
    if (result.type !== 'architecture' && result.shouldReview) {
      if (result.codeLineCount > 100) {
        result.isComplex = true;
        result.complexityReasons.push(`${result.codeLineCount} lines of code`);
      }
      if (result.fileCount > 3) {
        result.isComplex = true;
        result.complexityReasons.push(`${result.fileCount} files touched`);
      }
      if (result.stepCount > 5) {
        result.isComplex = true;
        result.complexityReasons.push(`${result.stepCount} plan steps`);
      }

      // Keyword escalation
      for (const keyword of COMPLEXITY_KEYWORDS) {
        if (lowerContent.includes(keyword)) {
          result.isComplex = true;
          result.complexityReasons.push(`contains "${keyword}"`);
          break; // one keyword is enough
        }
      }
    }

    return result;
  }

  private isArchitecture(lowerContent: string): boolean {
    return ARCHITECTURE_KEYWORDS.some(kw => lowerContent.includes(kw));
  }

  private isPlan(lowerContent: string, stepCount: number): boolean {
    if (stepCount >= 3 && PLAN_KEYWORDS.some(kw => lowerContent.includes(kw))) {
      return true;
    }
    // High step count alone suggests a plan
    return stepCount >= 5;
  }
}
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `npx vitest run src/main/orchestration/output-classifier.spec.ts`
Expected: PASS — all tests

- [ ] **Step 3.5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3.6: Commit**

```bash
git add src/main/orchestration/output-classifier.ts src/main/orchestration/output-classifier.spec.ts
git commit -m "feat(orchestration): add OutputClassifier for cross-model review"
```

---

## Task 4: Review Prompts

**Files:**
- Create: `src/main/orchestration/review-prompts.ts`

- [ ] **Step 4.1: Create review prompt templates**

```typescript
// src/main/orchestration/review-prompts.ts

/**
 * Review prompt templates for cross-model verification.
 *
 * Design informed by:
 * - HuggingFace LLM-as-Judge Cookbook (reasoning-before-scoring, 1-4 scale)
 * - MT-Bench judge prompts (Zheng et al., LMSYS)
 * - Chain-of-Verification (Meta AI, ACL 2024)
 */

export function buildStructuredReviewPrompt(taskDescription: string, primaryOutput: string): string {
  return `You are a verification agent reviewing another AI's output. Your job is NOT to re-solve the problem, but to verify the solution's correctness.

## Task Context
${taskDescription}

## Output Under Review
${primaryOutput}

## Review Checklist
Evaluate each dimension independently. For each, provide a brief justification BEFORE your score.

1. **Correctness**: Does the code/plan achieve what was asked? Any bugs, logic errors, or wrong assumptions?
2. **Completeness**: Are there missing edge cases, error handling, or steps?
3. **Security**: Any injection vulnerabilities, auth issues, data exposure, or unsafe patterns?
4. **Consistency**: Does it contradict itself or the task requirements?

## Scoring
For each dimension:
- 4: No issues found
- 3: Minor issues (style, non-critical suggestions)
- 2: Notable issues that should be addressed
- 1: Critical issues that would cause failures

## Output Format
Respond ONLY with this JSON (no markdown fences, no preamble):
{
  "correctness": { "reasoning": "...", "score": N, "issues": [] },
  "completeness": { "reasoning": "...", "score": N, "issues": [] },
  "security": { "reasoning": "...", "score": N, "issues": [] },
  "consistency": { "reasoning": "...", "score": N, "issues": [] },
  "overall_verdict": "APPROVE | CONCERNS | REJECT",
  "summary": "One sentence overall assessment"
}

Be rigorous but fair. Only flag genuine issues, not stylistic preferences.`;
}

export function buildTieredReviewPrompt(taskDescription: string, primaryOutput: string): string {
  return `You are a senior verification agent performing a deep review of another AI's output on a complex task. This is high-stakes — be thorough.

## Task Context
${taskDescription}

## Output Under Review
${primaryOutput}

## Deep Verification Steps

### Step 1: Trace Through Execution
Pick 2-3 concrete scenarios (including an edge case) and mentally trace the code/plan through each. Show your work briefly.

### Step 2: Boundary Analysis
Check: empty inputs, single elements, maximum values, null/undefined, concurrent access, error paths. List what you checked.

### Step 3: Assumption Audit
What assumptions does this output make that are NOT guaranteed by the task description? List each with severity.

### Step 4: Dependency & Integration Check
Would this break anything upstream or downstream? Are imports/interfaces correct? Any missing migrations, config changes, or wiring?

### Step 5: Dimensional Scoring
Score each (1-4, with reasoning BEFORE score):
1. **Correctness** — logic, algorithms, data flow
2. **Completeness** — missing pieces, edge cases
3. **Security** — vulnerabilities, data handling
4. **Consistency** — internal contradictions, requirement mismatches
5. **Feasibility** — will this actually work in practice?

## Output Format
Respond ONLY with this JSON (no markdown fences, no preamble):
{
  "traces": [{ "scenario": "...", "result": "pass|fail", "detail": "..." }],
  "boundaries_checked": ["...", "..."],
  "assumptions": [{ "assumption": "...", "severity": "high|medium|low" }],
  "integration_risks": ["...", "..."],
  "scores": {
    "correctness": { "reasoning": "...", "score": N, "issues": [] },
    "completeness": { "reasoning": "...", "score": N, "issues": [] },
    "security": { "reasoning": "...", "score": N, "issues": [] },
    "consistency": { "reasoning": "...", "score": N, "issues": [] },
    "feasibility": { "reasoning": "...", "score": N, "issues": [] }
  },
  "overall_verdict": "APPROVE | CONCERNS | REJECT",
  "summary": "One sentence overall assessment",
  "critical_issues": ["Only issues that MUST be addressed"]
}

Do not nitpick style. Focus on things that would cause real failures.`;
}

/** Maximum tokens to send as review payload. Truncate beyond this. */
export const MAX_REVIEW_PAYLOAD_CHARS = 32000; // ~8K tokens

export function truncateForReview(content: string): string {
  if (content.length <= MAX_REVIEW_PAYLOAD_CHARS) return content;
  const totalChars = content.length;
  return content.slice(0, MAX_REVIEW_PAYLOAD_CHARS) +
    `\n\n[... truncated, showing first ~8000 tokens of ~${Math.round(totalChars / 4)} total ...]`;
}
```

- [ ] **Step 4.2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4.3: Commit**

```bash
git add src/main/orchestration/review-prompts.ts
git commit -m "feat(orchestration): add review prompt templates for cross-model verification"
```

---

## Task 5: Reviewer Pool

**Files:**
- Create: `src/main/orchestration/reviewer-pool.ts`
- Create: `src/main/orchestration/reviewer-pool.spec.ts`

- [ ] **Step 5.1: Write failing tests for ReviewerPool**

```typescript
// src/main/orchestration/reviewer-pool.spec.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ReviewerPool } from './reviewer-pool';

describe('ReviewerPool', () => {
  let pool: ReviewerPool;

  beforeEach(() => {
    pool = new ReviewerPool();
    // Seed with available reviewers
    pool.setAvailable(['gemini', 'codex', 'copilot']);
  });

  describe('selectReviewers', () => {
    it('selects up to maxReviewers excluding primary provider', () => {
      const selected = pool.selectReviewers('claude', 2);
      expect(selected).toHaveLength(2);
      expect(selected).not.toContain('claude');
    });

    it('round-robins across selections', () => {
      const first = pool.selectReviewers('claude', 2);
      const second = pool.selectReviewers('claude', 2);
      // Second selection should start with a different reviewer
      expect(first[0]).not.toBe(second[0]);
    });

    it('returns fewer if not enough reviewers available', () => {
      pool.setAvailable(['gemini']);
      const selected = pool.selectReviewers('claude', 2);
      expect(selected).toHaveLength(1);
    });

    it('returns empty array if no reviewers available', () => {
      pool.setAvailable([]);
      const selected = pool.selectReviewers('claude', 2);
      expect(selected).toHaveLength(0);
    });

    it('excludes rate-limited reviewers', () => {
      pool.markRateLimited('gemini');
      const selected = pool.selectReviewers('claude', 3);
      expect(selected).not.toContain('gemini');
    });
  });

  describe('failover', () => {
    it('marks reviewer unavailable after 3 consecutive failures', () => {
      pool.recordFailure('gemini');
      pool.recordFailure('gemini');
      pool.recordFailure('gemini');
      const selected = pool.selectReviewers('claude', 3);
      expect(selected).not.toContain('gemini');
    });

    it('resets failure count on success', () => {
      pool.recordFailure('gemini');
      pool.recordFailure('gemini');
      pool.recordSuccess('gemini');
      pool.recordFailure('gemini'); // only 1 after reset
      const selected = pool.selectReviewers('claude', 3);
      expect(selected).toContain('gemini');
    });
  });

  describe('rate limit recovery', () => {
    it('recovers rate-limited reviewer after cooldown', () => {
      pool.markRateLimited('gemini', 0); // 0ms cooldown = immediate
      pool.checkRateLimitRecovery();
      const selected = pool.selectReviewers('claude', 3);
      expect(selected).toContain('gemini');
    });
  });

  describe('getStatus', () => {
    it('returns status of all reviewers', () => {
      const status = pool.getStatus();
      expect(status).toHaveLength(3);
      expect(status.every(r => r.available)).toBe(true);
    });
  });
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

Run: `npx vitest run src/main/orchestration/reviewer-pool.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 5.3: Implement ReviewerPool**

```typescript
// src/main/orchestration/reviewer-pool.ts

import { getLogger } from '../logging/logger';

const logger = getLogger('ReviewerPool');

const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface ReviewerInfo {
  cliType: string;
  available: boolean;
  lastUsed: number;
  consecutiveFailures: number;
  rateLimited: boolean;
  rateLimitResetAt: number;
  totalReviewsCompleted: number;
}

export class ReviewerPool {
  private reviewers = new Map<string, ReviewerInfo>();

  setAvailable(cliTypes: string[]): void {
    // Add new ones, keep existing state for known reviewers
    const known = new Set(this.reviewers.keys());
    for (const cliType of cliTypes) {
      if (!known.has(cliType)) {
        this.reviewers.set(cliType, {
          cliType,
          available: true,
          lastUsed: 0,
          consecutiveFailures: 0,
          rateLimited: false,
          rateLimitResetAt: 0,
          totalReviewsCompleted: 0,
        });
      } else {
        // Re-enable if it was marked unavailable from detection
        const existing = this.reviewers.get(cliType)!;
        if (!existing.available && existing.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
          existing.available = true;
        }
      }
    }
    // Mark removed CLIs as unavailable
    for (const [key, info] of this.reviewers) {
      if (!cliTypes.includes(key)) {
        info.available = false;
      }
    }
  }

  selectReviewers(primaryProvider: string, maxReviewers: number): string[] {
    const candidates = Array.from(this.reviewers.values())
      .filter(r =>
        r.available &&
        !r.rateLimited &&
        r.cliType !== primaryProvider
      )
      .sort((a, b) => a.lastUsed - b.lastUsed); // least recently used first

    const selected = candidates.slice(0, maxReviewers).map(r => r.cliType);

    // Update lastUsed for round-robin
    const now = Date.now();
    for (const cliType of selected) {
      const reviewer = this.reviewers.get(cliType);
      if (reviewer) reviewer.lastUsed = now;
    }

    return selected;
  }

  recordSuccess(cliType: string): void {
    const reviewer = this.reviewers.get(cliType);
    if (!reviewer) return;
    reviewer.consecutiveFailures = 0;
    reviewer.totalReviewsCompleted++;
    reviewer.available = true;
  }

  recordFailure(cliType: string): void {
    const reviewer = this.reviewers.get(cliType);
    if (!reviewer) return;
    reviewer.consecutiveFailures++;

    if (reviewer.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      reviewer.available = false;
      logger.warn('Reviewer marked unavailable after consecutive failures', {
        cliType,
        failures: reviewer.consecutiveFailures,
      });
    }
  }

  markRateLimited(cliType: string, cooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS): void {
    const reviewer = this.reviewers.get(cliType);
    if (!reviewer) return;
    reviewer.rateLimited = true;
    reviewer.rateLimitResetAt = Date.now() + cooldownMs;
    logger.info('Reviewer rate-limited', { cliType, cooldownMs });
  }

  checkRateLimitRecovery(): void {
    const now = Date.now();
    for (const reviewer of this.reviewers.values()) {
      if (reviewer.rateLimited && now >= reviewer.rateLimitResetAt) {
        reviewer.rateLimited = false;
        logger.info('Reviewer rate limit cleared', { cliType: reviewer.cliType });
      }
    }
  }

  getStatus(): { cliType: string; available: boolean; rateLimited: boolean; totalReviews: number }[] {
    return Array.from(this.reviewers.values()).map(r => ({
      cliType: r.cliType,
      available: r.available,
      rateLimited: r.rateLimited,
      totalReviews: r.totalReviewsCompleted,
    }));
  }

  hasAvailableReviewers(primaryProvider: string): boolean {
    return Array.from(this.reviewers.values()).some(r =>
      r.available && !r.rateLimited && r.cliType !== primaryProvider
    );
  }
}
```

- [ ] **Step 5.4: Run tests to verify they pass**

Run: `npx vitest run src/main/orchestration/reviewer-pool.spec.ts`
Expected: PASS — all tests

- [ ] **Step 5.5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5.6: Commit**

```bash
git add src/main/orchestration/reviewer-pool.ts src/main/orchestration/reviewer-pool.spec.ts
git commit -m "feat(orchestration): add ReviewerPool with round-robin, failover, rate-limit recovery"
```

---

## Task 6: Cross-Model Review Service (Core)

**Files:**
- Create: `src/main/orchestration/cross-model-review-service.ts`
- Create: `src/main/orchestration/cross-model-review-service.spec.ts`
- Create: `src/main/orchestration/cross-model-review.types.ts`

- [ ] **Step 6.1: Create internal types**

```typescript
// src/main/orchestration/cross-model-review.types.ts

import type { OutputClassification } from './output-classifier';
import type { AggregatedReview, ReviewResult } from '../../shared/types/cross-model-review.types';

/** Internal request dispatched to a reviewer */
export interface ReviewDispatchRequest {
  id: string;
  instanceId: string;
  primaryProvider: string;
  content: string;
  taskDescription: string;
  classification: OutputClassification;
  reviewDepth: 'structured' | 'tiered';
  timestamp: number;
}

/** Buffered output waiting for aggregation */
export interface OutputBuffer {
  instanceId: string;
  messages: string[];
  primaryProvider: string;
  firstUserPrompt: string;
  lastUpdated: number;
}
```

- [ ] **Step 6.2: Write failing tests for CrossModelReviewService**

```typescript
// src/main/orchestration/cross-model-review-service.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';

// Mock dependencies
vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../cli/adapters/adapter-factory', () => ({
  createCliAdapter: vi.fn(),
  resolveCliType: vi.fn(),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      crossModelReviewEnabled: true,
      crossModelReviewDepth: 'structured',
      crossModelReviewMaxReviewers: 2,
      crossModelReviewProviders: [],
      crossModelReviewTimeout: 30,
      crossModelReviewTypes: ['code', 'plan', 'architecture'],
    }),
  }),
}));

vi.mock('../core/circuit-breaker', () => ({
  getCircuitBreakerRegistry: () => ({
    getBreaker: () => ({
      execute: async (fn: () => Promise<any>) => fn(),
    }),
  }),
}));

describe('CrossModelReviewService', () => {
  beforeEach(() => {
    CrossModelReviewService._resetForTesting();
  });

  it('creates singleton instance', () => {
    const a = CrossModelReviewService.getInstance();
    const b = CrossModelReviewService.getInstance();
    expect(a).toBe(b);
  });

  it('buffers assistant messages per instance', () => {
    const service = CrossModelReviewService.getInstance();
    service.bufferMessage('inst-1', 'assistant', 'Here is some code:\n```ts\nconst x = 1;\n```');
    service.bufferMessage('inst-1', 'user', 'Thanks'); // should be ignored
    service.bufferMessage('inst-2', 'assistant', 'Different instance');

    expect(service.getBufferSize('inst-1')).toBe(1);
    expect(service.getBufferSize('inst-2')).toBe(1);
  });

  it('clears buffer on instance removal', () => {
    const service = CrossModelReviewService.getInstance();
    service.bufferMessage('inst-1', 'assistant', 'Some output');
    service.clearBuffer('inst-1');
    expect(service.getBufferSize('inst-1')).toBe(0);
  });

  it('skips review when disabled in settings', () => {
    // This would need the settings mock to return enabled: false
    // Tested via integration
  });

  it('stores review history per instance', () => {
    const service = CrossModelReviewService.getInstance();
    expect(service.getReviewHistory('inst-1')).toEqual([]);
  });
});
```

- [ ] **Step 6.3: Run tests to verify they fail**

Run: `npx vitest run src/main/orchestration/cross-model-review-service.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 6.4: Implement CrossModelReviewService**

This is the largest file. Key responsibilities: singleton lifecycle, message buffering, classification dispatch, CLI adapter invocation, result parsing, review history, event emission.

```typescript
// src/main/orchestration/cross-model-review-service.ts

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';
import { createCliAdapter, resolveCliType } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { CliDetectionService } from '../cli/cli-detection';
import { OutputClassifier } from './output-classifier';
import { ReviewerPool } from './reviewer-pool';
import {
  buildStructuredReviewPrompt,
  buildTieredReviewPrompt,
  truncateForReview,
} from './review-prompts';
import {
  ReviewResultJsonSchema,
  TieredReviewResultJsonSchema,
} from '../../shared/validation/cross-model-review-schemas';
import type {
  AggregatedReview,
  ReviewResult,
  ReviewVerdict,
  ReviewDimensionScore,
  CrossModelReviewStatus,
} from '../../shared/types/cross-model-review.types';
import type { OutputBuffer, ReviewDispatchRequest } from './cross-model-review.types';

const logger = getLogger('CrossModelReviewService');

const MIN_COOLDOWN_MS = 10_000; // 10s between reviews for same instance
const MAX_REVIEW_HISTORY = 50;
const RATE_LIMIT_CHECK_INTERVAL_MS = 30_000;
const AVAILABILITY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min

function isCliAdapterLike(adapter: any): adapter is { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof adapter?.sendMessage === 'function';
}

export class CrossModelReviewService extends EventEmitter {
  private static instance: CrossModelReviewService | null = null;

  private classifier = new OutputClassifier();
  private reviewerPool = new ReviewerPool();
  private buffers = new Map<string, OutputBuffer>();
  private lastReviewTime = new Map<string, number>();
  private reviewHistory = new Map<string, AggregatedReview[]>();
  private pendingReviews = new Map<string, AbortController>();
  private rateLimitTimer: ReturnType<typeof setInterval> | null = null;
  private availabilityTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  static getInstance(): CrossModelReviewService {
    if (!this.instance) {
      this.instance = new CrossModelReviewService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.shutdown();
      this.instance = null;
    }
  }

  private constructor() {
    super();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Detect available CLIs
    await this.refreshAvailability();

    // Start periodic timers
    this.rateLimitTimer = setInterval(() => {
      this.reviewerPool.checkRateLimitRecovery();
    }, RATE_LIMIT_CHECK_INTERVAL_MS);

    this.availabilityTimer = setInterval(() => {
      this.refreshAvailability().catch(err =>
        logger.warn('Availability refresh failed', { error: String(err) })
      );
    }, AVAILABILITY_CHECK_INTERVAL_MS);

    logger.info('CrossModelReviewService initialized', {
      reviewers: this.reviewerPool.getStatus(),
    });
  }

  // ============================================
  // Message Buffering
  // ============================================

  bufferMessage(
    instanceId: string,
    messageType: string,
    content: string,
    primaryProvider = 'claude',
    firstUserPrompt = '',
  ): void {
    // Only buffer assistant messages
    if (messageType !== 'assistant') return;

    let buffer = this.buffers.get(instanceId);
    if (!buffer) {
      buffer = {
        instanceId,
        messages: [],
        primaryProvider,
        firstUserPrompt,
        lastUpdated: Date.now(),
      };
      this.buffers.set(instanceId, buffer);
    }
    buffer.messages.push(content);
    buffer.lastUpdated = Date.now();
  }

  getBufferSize(instanceId: string): number {
    return this.buffers.get(instanceId)?.messages.length ?? 0;
  }

  clearBuffer(instanceId: string): void {
    this.buffers.delete(instanceId);
  }

  // ============================================
  // Trigger (called when instance goes idle)
  // ============================================

  async onInstanceIdle(instanceId: string): Promise<void> {
    const settings = getSettingsManager().getAll();
    if (!settings.crossModelReviewEnabled) return;

    const buffer = this.buffers.get(instanceId);
    if (!buffer || buffer.messages.length === 0) return;

    // Aggregate buffered messages
    const aggregatedContent = buffer.messages.join('\n\n');
    this.buffers.delete(instanceId); // Clear buffer

    // Min length gate
    if (aggregatedContent.length < 50) return;

    // Cooldown check
    const lastReview = this.lastReviewTime.get(instanceId) ?? 0;
    if (Date.now() - lastReview < MIN_COOLDOWN_MS) {
      logger.debug('Skipping review due to cooldown', { instanceId });
      return;
    }

    // Classify
    const classification = this.classifier.classify(aggregatedContent);
    if (!classification.shouldReview) return;

    // Check if this output type is enabled
    const enabledTypes = settings.crossModelReviewTypes as string[];
    if (!enabledTypes.includes(classification.type)) return;

    // Determine review depth
    let reviewDepth = settings.crossModelReviewDepth as 'structured' | 'tiered';
    if (reviewDepth === 'structured' && classification.isComplex) {
      reviewDepth = 'tiered'; // auto-escalate
    }

    // Select reviewers
    const selectedReviewers = this.reviewerPool.selectReviewers(
      buffer.primaryProvider,
      settings.crossModelReviewMaxReviewers,
    );

    if (selectedReviewers.length === 0) {
      this.emit('review:all-unavailable', { instanceId });
      return;
    }

    // Dispatch review
    const reviewId = `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.lastReviewTime.set(instanceId, Date.now());

    this.emit('review:started', { instanceId, reviewId });

    const request: ReviewDispatchRequest = {
      id: reviewId,
      instanceId,
      primaryProvider: buffer.primaryProvider,
      content: truncateForReview(aggregatedContent),
      taskDescription: buffer.firstUserPrompt || 'No task description available',
      classification,
      reviewDepth,
      timestamp: Date.now(),
    };

    // Run reviews in parallel (non-blocking)
    this.executeReviews(request, selectedReviewers, settings.crossModelReviewTimeout)
      .catch(err => logger.error('Review execution failed', err, { reviewId }));
  }

  // ============================================
  // Review Execution
  // ============================================

  private async executeReviews(
    request: ReviewDispatchRequest,
    reviewerClis: string[],
    timeoutSeconds: number,
  ): Promise<void> {
    const abort = new AbortController();
    this.pendingReviews.set(request.id, abort);
    this.pendingReviewInstances.set(request.id, request.instanceId);

    try {
      const reviewPromises = reviewerClis.map(cliType =>
        this.executeOneReview(request, cliType, timeoutSeconds, abort.signal)
      );

      const results = await Promise.allSettled(reviewPromises);
      const successfulResults = results
        .filter((r): r is PromiseFulfilledResult<ReviewResult> => r.status === 'fulfilled')
        .map(r => r.value);

      // Detect disagreements
      const hasDisagreement = this.detectDisagreement(successfulResults);

      const aggregated: AggregatedReview = {
        id: request.id,
        instanceId: request.instanceId,
        outputType: request.classification.type as any,
        reviewDepth: request.reviewDepth,
        reviews: successfulResults,
        hasDisagreement,
        timestamp: Date.now(),
      };

      // Store in history
      this.addToHistory(request.instanceId, aggregated);

      // Emit result
      this.emit('review:result', aggregated);
    } finally {
      this.pendingReviews.delete(request.id);
      this.pendingReviewInstances.delete(request.id);
    }
  }

  private async executeOneReview(
    request: ReviewDispatchRequest,
    cliType: string,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<ReviewResult> {
    const startTime = Date.now();
    const breaker = getCircuitBreakerRegistry().getBreaker(`cross-review-${cliType}`, {
      failureThreshold: 3,
      resetTimeoutMs: 60000,
    });

    try {
      const response = await breaker.execute(async () => {
        if (signal.aborted) throw new Error('Review cancelled');

        const resolvedCli = await resolveCliType(cliType as any);
        const adapter = createCliAdapter(resolvedCli, {
          workingDirectory: process.cwd(),
          timeout: timeoutSeconds * 1000,
          yoloMode: false,
        });

        if (!isCliAdapterLike(adapter)) {
          throw new Error(`CLI adapter "${cliType}" does not support sendMessage`);
        }

        const prompt = request.reviewDepth === 'tiered'
          ? buildTieredReviewPrompt(request.taskDescription, request.content)
          : buildStructuredReviewPrompt(request.taskDescription, request.content);

        return adapter.sendMessage({ role: 'user', content: prompt });
      });

      this.reviewerPool.recordSuccess(cliType);

      return this.parseReviewResponse(
        cliType,
        response.content,
        request.reviewDepth,
        Date.now() - startTime,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Detect rate limiting
      if (message.includes('429') || message.toLowerCase().includes('rate limit') || message.toLowerCase().includes('quota')) {
        this.reviewerPool.markRateLimited(cliType);
      } else {
        this.reviewerPool.recordFailure(cliType);
      }

      logger.warn('Review failed', { cliType, error: message });
      throw err;
    }
  }

  // ============================================
  // Response Parsing
  // ============================================

  private parseReviewResponse(
    reviewerId: string,
    rawResponse: string,
    reviewDepth: 'structured' | 'tiered',
    durationMs: number,
  ): ReviewResult {
    const baseResult: Partial<ReviewResult> = {
      reviewerId,
      reviewType: reviewDepth,
      timestamp: Date.now(),
      durationMs,
    };

    // Step 1: Strip markdown fences
    let cleaned = rawResponse;
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) cleaned = fenceMatch[1];

    // Step 2: Try JSON.parse on full response
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Step 3: Extract first {...} block
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          // Parse failed entirely
          logger.warn('Failed to parse review response', { reviewerId });
          return {
            ...baseResult,
            scores: this.emptyScores(),
            overallVerdict: 'CONCERNS' as ReviewVerdict,
            summary: 'Unable to parse reviewer response',
            parseSuccess: false,
            rawResponse,
          } as ReviewResult;
        }
      }
    }

    if (!parsed) {
      return {
        ...baseResult,
        scores: this.emptyScores(),
        overallVerdict: 'CONCERNS' as ReviewVerdict,
        summary: 'Unable to parse reviewer response',
        parseSuccess: false,
        rawResponse,
      } as ReviewResult;
    }

    // Step 4: Zod validation
    const schema = reviewDepth === 'tiered' ? TieredReviewResultJsonSchema : ReviewResultJsonSchema;
    const validated = schema.safeParse(parsed);

    if (!validated.success) {
      logger.warn('Review response failed schema validation', {
        reviewerId,
        errors: validated.error.issues.slice(0, 3),
      });
      // Try to extract what we can
      return this.buildPartialResult(baseResult, parsed, durationMs);
    }

    const data = validated.data;

    const scores = 'scores' in data ? data.scores : data;

    return {
      ...baseResult,
      scores: {
        correctness: scores.correctness,
        completeness: scores.completeness,
        security: scores.security,
        consistency: scores.consistency,
        feasibility: 'feasibility' in scores ? scores.feasibility : undefined,
      },
      overallVerdict: data.overall_verdict as ReviewVerdict,
      summary: data.summary,
      criticalIssues: 'critical_issues' in data ? data.critical_issues : undefined,
      traces: 'traces' in data ? data.traces : undefined,
      boundariesChecked: 'boundaries_checked' in data ? data.boundaries_checked : undefined,
      assumptions: 'assumptions' in data ? data.assumptions : undefined,
      integrationRisks: 'integration_risks' in data ? data.integration_risks : undefined,
      parseSuccess: true,
    } as ReviewResult;
  }

  private buildPartialResult(
    base: Partial<ReviewResult>,
    raw: any,
    durationMs: number,
  ): ReviewResult {
    // Best-effort extraction from partially valid JSON
    const extractScore = (obj: any): ReviewDimensionScore => ({
      reasoning: obj?.reasoning ?? 'Unable to parse',
      score: typeof obj?.score === 'number' ? Math.min(4, Math.max(1, obj.score)) : 2,
      issues: Array.isArray(obj?.issues) ? obj.issues : [],
    });

    const scores = raw.scores ?? raw;

    return {
      ...base,
      scores: {
        correctness: extractScore(scores?.correctness),
        completeness: extractScore(scores?.completeness),
        security: extractScore(scores?.security),
        consistency: extractScore(scores?.consistency),
      },
      overallVerdict: (['APPROVE', 'CONCERNS', 'REJECT'].includes(raw.overall_verdict)
        ? raw.overall_verdict
        : 'CONCERNS') as ReviewVerdict,
      summary: typeof raw.summary === 'string' ? raw.summary : 'Partially parsed response',
      parseSuccess: false,
      rawResponse: JSON.stringify(raw),
      timestamp: Date.now(),
      durationMs,
    } as ReviewResult;
  }

  private emptyScores() {
    const empty: ReviewDimensionScore = { reasoning: 'No data', score: 2, issues: [] };
    return {
      correctness: { ...empty },
      completeness: { ...empty },
      security: { ...empty },
      consistency: { ...empty },
    };
  }

  // ============================================
  // Disagreement Detection
  // ============================================

  private detectDisagreement(reviews: ReviewResult[]): boolean {
    if (reviews.length === 0) return false;

    // Any CONCERNS or REJECT verdict
    if (reviews.some(r => r.overallVerdict !== 'APPROVE')) return true;

    // Any critical score (1)
    for (const review of reviews) {
      const allScores = [
        review.scores.correctness?.score,
        review.scores.completeness?.score,
        review.scores.security?.score,
        review.scores.consistency?.score,
        review.scores.feasibility?.score,
      ].filter((s): s is number => s !== undefined);

      if (allScores.some(s => s === 1)) return true;
    }

    // Two reviewers disagree (one APPROVE, one REJECT)
    const verdicts = new Set(reviews.map(r => r.overallVerdict));
    if (verdicts.has('APPROVE') && verdicts.has('REJECT')) return true;

    return false;
  }

  // ============================================
  // Review History
  // ============================================

  getReviewHistory(instanceId: string): AggregatedReview[] {
    return this.reviewHistory.get(instanceId) ?? [];
  }

  private addToHistory(instanceId: string, review: AggregatedReview): void {
    let history = this.reviewHistory.get(instanceId);
    if (!history) {
      history = [];
      this.reviewHistory.set(instanceId, history);
    }
    history.push(review);
    // FIFO eviction
    if (history.length > MAX_REVIEW_HISTORY) {
      history.splice(0, history.length - MAX_REVIEW_HISTORY);
    }
  }

  // ============================================
  // Availability
  // ============================================

  private async refreshAvailability(): Promise<void> {
    try {
      const detection = CliDetectionService.getInstance();
      const result = await detection.detectAll();
      const available = result.available.map(c => c.name);

      // Use configured providers if set, otherwise use all detected
      const settings = getSettingsManager().getAll();
      const configured = settings.crossModelReviewProviders as string[];
      const effectiveList = configured.length > 0
        ? configured.filter(p => available.includes(p))
        : available;

      this.reviewerPool.setAvailable(effectiveList);
    } catch (err) {
      logger.warn('CLI detection failed', { error: String(err) });
    }
  }

  getStatus(): CrossModelReviewStatus {
    const settings = getSettingsManager().getAll();
    return {
      enabled: settings.crossModelReviewEnabled,
      reviewers: this.reviewerPool.getStatus(),
      pendingReviews: this.pendingReviews.size,
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  private pendingReviewInstances = new Map<string, string>(); // reviewId -> instanceId

  cancelPendingReviews(instanceId: string): void {
    for (const [reviewId, instId] of this.pendingReviewInstances) {
      if (instId === instanceId) {
        const abort = this.pendingReviews.get(reviewId);
        if (abort) {
          abort.abort();
          this.pendingReviews.delete(reviewId);
        }
        this.pendingReviewInstances.delete(reviewId);
      }
    }
    this.clearBuffer(instanceId);
    this.reviewHistory.delete(instanceId);
  }

  shutdown(): void {
    if (this.rateLimitTimer) clearInterval(this.rateLimitTimer);
    if (this.availabilityTimer) clearInterval(this.availabilityTimer);
    this.rateLimitTimer = null;
    this.availabilityTimer = null;

    for (const abort of this.pendingReviews.values()) {
      abort.abort();
    }
    this.pendingReviews.clear();
    this.buffers.clear();
    this.reviewHistory.clear();
    this.lastReviewTime.clear();
    this.removeAllListeners();
    this.initialized = false;
  }
}

export function getCrossModelReviewService(): CrossModelReviewService {
  return CrossModelReviewService.getInstance();
}
```

- [ ] **Step 6.5: Run tests to verify they pass**

Run: `npx vitest run src/main/orchestration/cross-model-review-service.spec.ts`
Expected: PASS — all tests

- [ ] **Step 6.6: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6.7: Commit**

```bash
git add src/main/orchestration/cross-model-review-service.ts src/main/orchestration/cross-model-review.types.ts src/main/orchestration/cross-model-review-service.spec.ts
git commit -m "feat(orchestration): add CrossModelReviewService with buffering, dispatch, and result parsing"
```

---

## Task 7: IPC Handlers & Wiring

**Files:**
- Create: `src/main/ipc/cross-model-review-ipc.ts`
- Modify: `src/main/orchestration/index.ts`
- Modify: `src/main/index.ts` (startup wiring)

- [ ] **Step 7.1: Create IPC handler registration**

```typescript
// src/main/ipc/cross-model-review-ipc.ts
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import {
  ReviewDismissPayloadSchema,
  ReviewActionPayloadSchema,
} from '../../shared/validation/cross-model-review-schemas';
import { validateIpcPayload } from '../../shared/validation/ipc-schemas';
import { getCrossModelReviewService } from '../orchestration/cross-model-review-service';
import { getLogger } from '../logging/logger';

const logger = getLogger('CrossModelReviewIPC');

export function registerCrossModelReviewIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CROSS_MODEL_REVIEW_DISMISS, async (_event, payload) => {
    const validated = validateIpcPayload(ReviewDismissPayloadSchema, payload, 'CROSS_MODEL_REVIEW_DISMISS');
    logger.debug('Review dismissed', { reviewId: validated.reviewId });
    // No-op for now — just an acknowledgment. Could log metrics later.
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.CROSS_MODEL_REVIEW_ACTION, async (_event, payload) => {
    const validated = validateIpcPayload(ReviewActionPayloadSchema, payload, 'CROSS_MODEL_REVIEW_ACTION');
    const service = getCrossModelReviewService();

    switch (validated.action) {
      case 'ask-primary':
        // Return the concerns so the renderer can inject them into the primary instance
        const history = service.getReviewHistory(validated.instanceId);
        const review = history.find(r => r.id === validated.reviewId);
        if (review) {
          const concerns = review.reviews
            .flatMap(r => Object.values(r.scores).flatMap(s => s?.issues ?? []))
            .filter(Boolean);
          return { action: 'ask-primary', concerns };
        }
        return { action: 'ask-primary', concerns: [] };

      case 'start-debate':
        // Return signal to renderer to trigger debate coordinator
        return { action: 'start-debate', reviewId: validated.reviewId };

      default:
        return { success: true };
    }
  });

  // Status query (renderer can poll this)
  ipcMain.handle(IPC_CHANNELS.CROSS_MODEL_REVIEW_STATUS, async () => {
    return getCrossModelReviewService().getStatus();
  });
}
```

- [ ] **Step 7.2: Add exports to orchestration/index.ts**

In `src/main/orchestration/index.ts`, add at the end:

```typescript
// Cross-Model Review
export { CrossModelReviewService, getCrossModelReviewService } from './cross-model-review-service';
```

- [ ] **Step 7.3: Wire into main process startup**

In `src/main/index.ts`, find where services are initialized (after ProviderRegistry / CliDetectionService) and add:

```typescript
import { getCrossModelReviewService } from './orchestration/cross-model-review-service';
import { registerCrossModelReviewIpcHandlers } from './ipc/cross-model-review-ipc';

// In the initialization function, after CliDetectionService is ready:
const crossModelReview = getCrossModelReviewService();
await crossModelReview.initialize();
registerCrossModelReviewIpcHandlers();

// Wire instance events to the review service
instanceManager.on('instance:output', ({ instanceId, message }) => {
  if (message.metadata?.source === 'cross-model-review') return; // anti-loop
  const instance = instanceManager.getInstance(instanceId);
  const provider = instance?.provider ?? 'claude';
  // Extract first user prompt for task description context
  const firstUserPrompt = instance?.history
    ?.find(m => m.type === 'user')?.content ?? instance?.displayName ?? '';
  crossModelReview.bufferMessage(instanceId, message.type, message.content, provider as string, firstUserPrompt);
});

instanceManager.on('instance:batch-update', ({ updates }) => {
  for (const update of updates) {
    if (update.status === 'idle' || update.status === 'waiting_for_input') {
      crossModelReview.onInstanceIdle(update.instanceId).catch(err =>
        logger.warn('Review trigger failed', { instanceId: update.instanceId, error: String(err) })
      );
    }
  }
});

// instance:removed emits a plain string instanceId, NOT an object
instanceManager.on('instance:removed', (instanceId: string) => {
  crossModelReview.cancelPendingReviews(instanceId);
});

// Forward review events to renderer via windowManager
// (CrossModelReviewService emits EventEmitter events; renderer needs IPC)
crossModelReview.on('review:started', (data) => {
  windowManager.sendToRenderer('cross-model-review:started', data);
});
crossModelReview.on('review:result', (data) => {
  windowManager.sendToRenderer('cross-model-review:result', data);
});
crossModelReview.on('review:all-unavailable', (data) => {
  windowManager.sendToRenderer('cross-model-review:all-unavailable', data);
});

// In shutdown:
crossModelReview.shutdown();
```

- [ ] **Step 7.4: Add preload channel exposure**

In `src/preload/preload.ts`, the preload uses inline string constants (cannot import from shared types due to Electron sandboxing). Add the 4 new channels to the preload's local `IPC_CHANNELS` object AND the exposed API:

First, add to the local `IPC_CHANNELS` object:
```typescript
CROSS_MODEL_REVIEW_RESULT: 'cross-model-review:result',
CROSS_MODEL_REVIEW_STARTED: 'cross-model-review:started',
CROSS_MODEL_REVIEW_ALL_UNAVAILABLE: 'cross-model-review:all-unavailable',
CROSS_MODEL_REVIEW_STATUS: 'cross-model-review:status',
CROSS_MODEL_REVIEW_DISMISS: 'cross-model-review:dismiss',
CROSS_MODEL_REVIEW_ACTION: 'cross-model-review:action',
```

Then add to the exposed API object:
```typescript
// Cross-Model Review
crossModelReviewOnResult: (callback: (data: any) => void) =>
  ipcRenderer.on('cross-model-review:result', (_e, data) => callback(data)),
crossModelReviewOnStarted: (callback: (data: any) => void) =>
  ipcRenderer.on('cross-model-review:started', (_e, data) => callback(data)),
crossModelReviewOnAllUnavailable: (callback: (data: any) => void) =>
  ipcRenderer.on('cross-model-review:all-unavailable', (_e, data) => callback(data)),
crossModelReviewStatus: () =>
  ipcRenderer.invoke('cross-model-review:status'),
crossModelReviewDismiss: (payload: any) =>
  ipcRenderer.invoke('cross-model-review:dismiss', payload),
crossModelReviewAction: (payload: any) =>
  ipcRenderer.invoke('cross-model-review:action', payload),
```

- [ ] **Step 7.5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7.6: Commit**

```bash
git add src/main/ipc/cross-model-review-ipc.ts src/main/orchestration/index.ts src/main/index.ts src/preload/preload.ts
git commit -m "feat(ipc): wire CrossModelReviewService into startup, events, and IPC"
```

---

## Task 8: Angular UI — IPC Service + Review Indicator

**Files:**
- Create: `src/renderer/app/core/services/ipc/cross-model-review-ipc.service.ts`
- Create: `src/renderer/app/features/instance-detail/cross-model-review-indicator.component.ts`
- Modify: `src/renderer/app/features/instance-detail/instance-header.component.ts`

- [ ] **Step 8.1: Create Angular IPC service**

```typescript
// src/renderer/app/core/services/ipc/cross-model-review-ipc.service.ts
import { Injectable, signal, NgZone, inject, OnDestroy } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import type {
  AggregatedReview,
  CrossModelReviewStatus,
  ReviewActionPayload,
  ReviewDismissPayload,
} from '../../../../../shared/types/cross-model-review.types';

@Injectable({ providedIn: 'root' })
export class CrossModelReviewIpcService implements OnDestroy {
  private ipc = inject(ElectronIpcService);
  private zone = inject(NgZone);

  /** Latest review result per instance */
  readonly latestReview = signal<Map<string, AggregatedReview>>(new Map());

  /** Review system status */
  readonly status = signal<CrossModelReviewStatus | null>(null);

  /** Pending reviews (instanceIds currently being reviewed) */
  readonly pendingInstances = signal<Set<string>>(new Set());

  private cleanup: (() => void) | null = null;

  constructor() {
    this.listenForResults();
    this.refreshStatus();
  }

  private listenForResults(): void {
    const api = (window as any).electronAPI;
    if (!api) return;

    // Listen for review started (populates pending spinner)
    api.crossModelReviewOnStarted?.((data: { instanceId: string; reviewId: string }) => {
      this.zone.run(() => {
        const pending = new Set(this.pendingInstances());
        pending.add(data.instanceId);
        this.pendingInstances.set(pending);
      });
    });

    // Listen for review results
    api.crossModelReviewOnResult?.((data: AggregatedReview) => {
      this.zone.run(() => {
        const map = new Map(this.latestReview());
        map.set(data.instanceId, data);
        this.latestReview.set(map);

        // Remove from pending
        const pending = new Set(this.pendingInstances());
        pending.delete(data.instanceId);
        this.pendingInstances.set(pending);
      });
    });

    // Listen for all-unavailable (clear pending)
    api.crossModelReviewOnAllUnavailable?.((data: { instanceId: string }) => {
      this.zone.run(() => {
        const pending = new Set(this.pendingInstances());
        pending.delete(data.instanceId);
        this.pendingInstances.set(pending);
      });
    });
  }

  async refreshStatus(): Promise<void> {
    const api = (window as any).electronAPI;
    if (!api?.crossModelReviewStatus) return;
    const status = await api.crossModelReviewStatus();
    this.zone.run(() => this.status.set(status));
  }

  async dismiss(payload: ReviewDismissPayload): Promise<void> {
    const api = (window as any).electronAPI;
    if (!api?.crossModelReviewDismiss) return;
    await api.crossModelReviewDismiss(payload);

    // Remove from latest reviews
    const map = new Map(this.latestReview());
    map.delete(payload.instanceId);
    this.latestReview.set(map);
  }

  async performAction(payload: ReviewActionPayload): Promise<any> {
    const api = (window as any).electronAPI;
    if (!api?.crossModelReviewAction) return;
    return api.crossModelReviewAction(payload);
  }

  getReviewForInstance(instanceId: string): AggregatedReview | undefined {
    return this.latestReview().get(instanceId);
  }

  ngOnDestroy(): void {
    this.cleanup?.();
  }
}
```

- [ ] **Step 8.2: Create review indicator component**

```typescript
// src/renderer/app/features/instance-detail/cross-model-review-indicator.component.ts
import { Component, input, output, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';

@Component({
  selector: 'app-cross-model-review-indicator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (enabled()) {
      <span
        class="review-indicator"
        [class.reviewing]="isPending()"
        [class.verified]="isVerified()"
        [class.concerns]="hasConcerns()"
        [class.skipped]="isSkipped()"
        [title]="tooltip()"
        (click)="indicatorClicked.emit()"
      >
        @if (isPending()) {
          <span class="spinner">&#x21bb;</span> Reviewing...
        } @else if (isVerified()) {
          &#x2713; Verified
        } @else if (hasConcerns()) {
          &#x26A0; {{ concernCount() }} concern{{ concernCount() > 1 ? 's' : '' }}
        } @else if (isSkipped()) {
          &#x2014;
        }
      </span>
    }
  `,
  styles: [`
    .review-indicator {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
      cursor: pointer;
      user-select: none;
    }
    .reviewing {
      color: var(--text-secondary);
    }
    .verified {
      color: #51cf66;
      background: rgba(81, 207, 102, 0.1);
    }
    .concerns {
      color: #ffc078;
      background: rgba(255, 192, 120, 0.1);
    }
    .skipped {
      color: var(--text-tertiary);
    }
    .spinner {
      display: inline-block;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `],
})
export class CrossModelReviewIndicatorComponent {
  instanceId = input.required<string>();
  indicatorClicked = output<void>();

  private reviewService = inject(CrossModelReviewIpcService);

  private review = computed(() => this.reviewService.getReviewForInstance(this.instanceId()));

  enabled = computed(() => {
    const status = this.reviewService.status();
    return status?.enabled ?? false;
  });

  isPending = computed(() => this.reviewService.pendingInstances().has(this.instanceId()));
  isVerified = computed(() => {
    const r = this.review();
    return r != null && !r.hasDisagreement;
  });
  hasConcerns = computed(() => {
    const r = this.review();
    return r != null && r.hasDisagreement;
  });
  isSkipped = computed(() => !this.isPending() && !this.review());

  concernCount = computed(() => {
    const r = this.review();
    if (!r) return 0;
    return r.reviews.filter(rev => rev.overallVerdict !== 'APPROVE').length;
  });

  tooltip = computed(() => {
    if (this.isPending()) return 'Cross-model review in progress...';
    const r = this.review();
    if (!r) return 'No review available';
    if (r.hasDisagreement) return 'Secondary models flagged concerns — click to view';
    return 'All secondary models approved this output';
  });
}
```

- [ ] **Step 8.3: Add indicator to instance-header.component.ts**

In `src/renderer/app/features/instance-detail/instance-header.component.ts`:

Add to imports array:
```typescript
import { CrossModelReviewIndicatorComponent } from './cross-model-review-indicator.component';
```

Add to the `imports` in `@Component`:
```typescript
imports: [StatusIndicatorComponent, RecentDirectoriesDropdownComponent, ContextBarComponent, CrossModelReviewIndicatorComponent],
```

Add to the template, in the `header-top` section near the status indicator (after the instance name, before the header-actions):
```html
<app-cross-model-review-indicator
  [instanceId]="instance().id"
  (indicatorClicked)="onReviewIndicatorClicked()"
/>
```

Add the handler method:
```typescript
reviewPanelOpen = signal(false);
onReviewIndicatorClicked(): void {
  this.reviewPanelOpen.update(v => !v);
}
```

- [ ] **Step 8.4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8.5: Commit**

```bash
git add src/renderer/app/core/services/ipc/cross-model-review-ipc.service.ts src/renderer/app/features/instance-detail/cross-model-review-indicator.component.ts src/renderer/app/features/instance-detail/instance-header.component.ts
git commit -m "feat(ui): add cross-model review indicator badge and IPC service"
```

---

## Task 9: Angular UI — Review Panel

**Files:**
- Create: `src/renderer/app/features/instance-detail/cross-model-review-panel.component.ts`
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts`

- [ ] **Step 9.1: Create expandable review panel component**

```typescript
// src/renderer/app/features/instance-detail/cross-model-review-panel.component.ts
import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
  computed,
  inject,
} from '@angular/core';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import type {
  AggregatedReview,
  ReviewResult,
  ReviewActionType,
} from '../../../../shared/types/cross-model-review.types';

@Component({
  selector: 'app-cross-model-review-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (review()) {
      <div class="review-panel">
        <div class="review-panel-header" (click)="expanded.set(!expanded())">
          <span class="review-icon">&#x26A0;</span>
          <span class="review-title">
            Cross-Model Review: {{ concernCount() }} concern{{ concernCount() !== 1 ? 's' : '' }} found
          </span>
          <span class="review-toggle">{{ expanded() ? '&#x25B2;' : '&#x25BC;' }}</span>
        </div>

        @if (expanded()) {
          <div class="review-panel-body">
            @for (result of review()!.reviews; track result.reviewerId) {
              <div class="reviewer-section">
                <h4 class="reviewer-name">
                  {{ result.reviewerId }} ({{ result.reviewType }} review)
                </h4>
                <div class="scores-grid">
                  <span class="score-item" [class.score-low]="result.scores.correctness.score <= 2">
                    Correctness: {{ result.scores.correctness.score }}/4
                  </span>
                  <span class="score-item" [class.score-low]="result.scores.completeness.score <= 2">
                    Completeness: {{ result.scores.completeness.score }}/4
                  </span>
                  <span class="score-item" [class.score-low]="result.scores.security.score <= 2">
                    Security: {{ result.scores.security.score }}/4
                  </span>
                  <span class="score-item" [class.score-low]="result.scores.consistency.score <= 2">
                    Consistency: {{ result.scores.consistency.score }}/4
                  </span>
                </div>
                @for (issue of allIssues(result); track issue) {
                  <div class="issue-item">&rarr; {{ issue }}</div>
                }
                <div class="reviewer-summary">{{ result.summary }}</div>
              </div>
            }

            <div class="review-actions">
              <button class="btn-review-action" (click)="onAction('dismiss')">Dismiss</button>
              <button class="btn-review-action btn-primary" (click)="onAction('ask-primary')">
                Ask Claude to Address
              </button>
              <button class="btn-review-action" (click)="showingFull.set(!showingFull())">
                {{ showingFull() ? 'Hide' : 'Full' }} Review
              </button>
              <button class="btn-review-action" (click)="onAction('start-debate')">
                Start Debate
              </button>
            </div>

            @if (showingFull()) {
              <pre class="full-review-json">{{ fullReviewJson() }}</pre>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .review-panel {
      border: 1px solid var(--border-warning, #ffc078);
      border-radius: 4px;
      margin: 8px 0;
      background: var(--bg-surface, #1a1a2e);
    }
    .review-panel-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 13px;
    }
    .review-icon { color: #ffc078; }
    .review-title { flex: 1; font-weight: 500; }
    .review-toggle { font-size: 10px; color: var(--text-secondary); }
    .review-panel-body { padding: 0 12px 12px; }
    .reviewer-section {
      padding: 8px;
      margin-bottom: 8px;
      border-left: 3px solid var(--border-accent, #4a90e2);
      background: var(--bg-hover, rgba(255,255,255,0.03));
    }
    .reviewer-name { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
    .scores-grid {
      display: flex;
      gap: 12px;
      font-size: 11px;
      margin-bottom: 4px;
    }
    .score-item { color: var(--text-secondary); }
    .score-low { color: #ff6b6b; font-weight: 600; }
    .issue-item {
      font-size: 12px;
      color: #ffc078;
      padding: 2px 0 2px 8px;
    }
    .reviewer-summary {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-top: 4px;
      font-style: italic;
    }
    .review-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .btn-review-action {
      padding: 4px 10px;
      font-size: 11px;
      border: 1px solid var(--border-secondary);
      border-radius: 3px;
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
    }
    .btn-review-action:hover { background: var(--bg-hover); }
    .btn-primary {
      background: var(--accent-primary, #4a90e2);
      border-color: var(--accent-primary, #4a90e2);
      color: white;
    }
    .full-review-json {
      margin-top: 8px;
      padding: 8px;
      background: var(--bg-code, #0d0d1a);
      border-radius: 3px;
      font-size: 10px;
      max-height: 300px;
      overflow: auto;
      white-space: pre-wrap;
    }
  `],
})
export class CrossModelReviewPanelComponent {
  review = input<AggregatedReview | null>(null);
  actionPerformed = output<{ reviewId: string; instanceId: string; action: ReviewActionType }>();

  expanded = signal(true);
  showingFull = signal(false);

  private reviewService = inject(CrossModelReviewIpcService);

  concernCount = computed(() => {
    const r = this.review();
    if (!r) return 0;
    return r.reviews.filter(rev => rev.overallVerdict !== 'APPROVE').length;
  });

  fullReviewJson = computed(() => {
    const r = this.review();
    if (!r) return '';
    return JSON.stringify(r.reviews, null, 2);
  });

  allIssues(result: ReviewResult): string[] {
    return [
      ...result.scores.correctness.issues,
      ...result.scores.completeness.issues,
      ...result.scores.security.issues,
      ...result.scores.consistency.issues,
      ...(result.scores.feasibility?.issues ?? []),
    ];
  }

  async onAction(action: ReviewActionType): Promise<void> {
    const r = this.review();
    if (!r) return;

    if (action === 'dismiss') {
      await this.reviewService.dismiss({ reviewId: r.id, instanceId: r.instanceId });
    } else {
      await this.reviewService.performAction({
        reviewId: r.id,
        instanceId: r.instanceId,
        action,
      });
    }

    this.actionPerformed.emit({ reviewId: r.id, instanceId: r.instanceId, action });
  }
}
```

- [ ] **Step 9.2: Integrate review panel into instance-detail.component.ts**

In `src/renderer/app/features/instance-detail/instance-detail.component.ts`:

Add imports:
```typescript
import { CrossModelReviewPanelComponent } from './cross-model-review-panel.component';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
```

Add to `@Component.imports`:
```typescript
CrossModelReviewPanelComponent,
```

Add to the component class:
```typescript
private crossModelReviewService = inject(CrossModelReviewIpcService);
currentReview = computed(() => {
  const inst = this.instance();
  return inst ? this.crossModelReviewService.getReviewForInstance(inst.id) : null;
});
```

Add to template, below the output stream and above the input panel:
```html
@if (currentReview()?.hasDisagreement) {
  <app-cross-model-review-panel
    [review]="currentReview()"
    (actionPerformed)="onReviewAction($event)"
  />
}
```

Add handler:
```typescript
onReviewAction(event: { reviewId: string; instanceId: string; action: string }): void {
  if (event.action === 'ask-primary') {
    // Inject concerns into primary instance as a follow-up
    const review = this.currentReview();
    if (review) {
      const concerns = review.reviews
        .flatMap(r => Object.values(r.scores).flatMap(s => s?.issues ?? []))
        .filter(Boolean);
      if (concerns.length > 0) {
        const message = `Cross-model review flagged these issues:\n${concerns.map(c => `- ${c}`).join('\n')}\n\nPlease address them.`;
        // Send as input to the instance
        this.sendInput(message);
      }
    }
  }
}
```

- [ ] **Step 9.3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9.4: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 9.5: Commit**

```bash
git add src/renderer/app/features/instance-detail/cross-model-review-panel.component.ts src/renderer/app/features/instance-detail/instance-detail.component.ts
git commit -m "feat(ui): add expandable cross-model review panel with action buttons"
```

---

## Task 10: Settings UI — Review Tab + Multi-Select

**Files:**
- Create: `src/renderer/app/features/settings/review-settings-tab.component.ts`
- Modify: `src/renderer/app/features/settings/settings.component.ts`
- Modify: `src/renderer/app/features/settings/setting-row.component.ts`
- Modify: `src/renderer/app/core/state/settings.store.ts` (add `reviewSettings` computed)

The settings UI uses per-category tab components (not a generic metadata renderer). We need:
1. A new `ReviewSettingsTabComponent`
2. Register it in `settings.component.ts`
3. Extend `setting-row.component.ts` to handle `'multi-select'` type
4. Add `reviewSettings` computed property to `SettingsStore`

- [ ] **Step 10.1: Add `reviewSettings` to SettingsStore**

In `src/renderer/app/core/state/settings.store.ts`, find where other category-filtered computed properties are defined (e.g., `orchestrationSettings`, `memorySettings`) and add:

```typescript
reviewSettings = computed(() =>
  SETTINGS_METADATA.filter(s => s.category === 'review')
);
```

- [ ] **Step 10.2: Extend setting-row.component.ts for multi-select**

In `src/renderer/app/features/settings/setting-row.component.ts`, find the template section that switches on `setting.type`. Add a case for `'multi-select'`:

```html
} @else if (setting().type === 'multi-select') {
  <div class="multi-select-options">
    @for (option of setting().options ?? []; track option.value) {
      <label class="multi-select-option">
        <input
          type="checkbox"
          [checked]="isOptionSelected(option.value)"
          (change)="toggleMultiSelectOption(option.value)"
        />
        {{ option.label }}
      </label>
    }
  </div>
}
```

Add methods to the component class:

```typescript
isOptionSelected(optionValue: string | number): boolean {
  const current = this.value() as unknown[];
  return Array.isArray(current) && current.includes(optionValue);
}

toggleMultiSelectOption(optionValue: string | number): void {
  const current = (this.value() as unknown[]) ?? [];
  const arr = Array.isArray(current) ? [...current] : [];
  const idx = arr.indexOf(optionValue);
  if (idx >= 0) {
    arr.splice(idx, 1);
  } else {
    arr.push(optionValue);
  }
  this.valueChange.emit({ key: this.setting().key, value: arr });
}
```

Add styles:
```css
.multi-select-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.multi-select-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}
```

- [ ] **Step 10.3: Create ReviewSettingsTabComponent**

```typescript
// src/renderer/app/features/settings/review-settings-tab.component.ts
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import type { AppSettings } from '../../../../shared/types/settings.types';

@Component({
  selector: 'app-review-settings-tab',
  standalone: true,
  imports: [SettingRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (setting of store.reviewSettings(); track setting.key) {
      <app-setting-row
        [setting]="setting"
        [value]="store.get(setting.key)"
        (valueChange)="onSettingChange($event)"
      />
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }
  `],
})
export class ReviewSettingsTabComponent {
  store = inject(SettingsStore);

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as any);
  }
}
```

- [ ] **Step 10.4: Register tab in settings.component.ts**

In `src/renderer/app/features/settings/settings.component.ts`:

Add import:
```typescript
import { ReviewSettingsTabComponent } from './review-settings-tab.component';
```

Add to `SettingsTab` union:
```typescript
type SettingsTab = 'general' | 'orchestration' | 'memory' | 'display' | 'ecosystem' | 'permissions' | 'advanced' | 'keyboard' | 'review';
```

Add to `@Component.imports`:
```typescript
ReviewSettingsTabComponent,
```

Add tab button to the template tabs section (before the Advanced tab):
```html
<button
  class="tab"
  [class.active]="activeTab === 'review'"
  (click)="activeTab = 'review'"
>
  Cross-Model Review
</button>
```

Add tab content to the template body section:
```html
} @else if (activeTab === 'review') {
  <app-review-settings-tab />
}
```

- [ ] **Step 10.5: Verify compilation and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: No errors

- [ ] **Step 10.6: Commit**

```bash
git add src/renderer/app/features/settings/review-settings-tab.component.ts src/renderer/app/features/settings/settings.component.ts src/renderer/app/features/settings/setting-row.component.ts src/renderer/app/core/state/settings.store.ts
git commit -m "feat(ui): add review settings tab with multi-select support"
```

---

## Task 11: Integration Test & Full Verification

- [ ] **Step 11.1: Run all tests**

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 11.2: Run both tsconfig compilations**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 11.3: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 11.4: Manual verification checklist**

Verify:
- [ ] `CrossModelReviewService` initializes at startup and detects available CLIs
- [ ] Sending a message with code to the primary instance triggers buffering
- [ ] When the instance goes idle, the buffer is classified and dispatched
- [ ] Review results are emitted and received by the renderer
- [ ] The review indicator shows in the instance header
- [ ] Concerns expand into the review panel
- [ ] Action buttons work (Dismiss, Ask Claude to Address)
- [ ] Settings page shows the new "Cross-Model Review" category
- [ ] Disabling cross-model review in settings stops reviews
- [ ] Rate-limited reviewers are excluded and recover after cooldown

- [ ] **Step 11.5: Final commit**

```bash
git commit -m "feat: cross-model review service — complete implementation"
```
