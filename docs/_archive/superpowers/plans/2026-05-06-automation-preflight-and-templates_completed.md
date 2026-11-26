# Automation Preflight and Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automation-specific preflight and reusable templates so unattended automations are less likely to stop on predictable permission/input/provider blockers.

**Architecture:** Extend the existing `TaskPreflightService` with `getAutomationPreflight()` rather than creating a parallel service. Add automation template definitions in the automation domain, expose both through IPC, and wire the Automations page to show blockers, warnings, suggested permission rules, and template starts.

**Tech Stack:** Electron main process, Angular 21 signals, TypeScript, Zod contracts, Vitest.

---

## File Map

- Modify `src/main/security/task-preflight-service.ts`: add automation entry point.
- Modify `src/shared/types/task-preflight.types.ts`: add automation preflight request/result/suggestion types.
- Modify `packages/contracts/src/schemas/automation.schemas.ts`: add preflight/template IPC payload schemas if automation IPC payloads live here; otherwise create `packages/contracts/src/schemas/automation-preflight.schemas.ts`.
- Create `src/main/automations/automation-templates.ts`: built-in template catalog.
- Modify `src/main/ipc/handlers/automation-handlers.ts`: add preflight and template handlers.
- Modify `packages/contracts/src/channels/automation.channels.ts`: add channels.
- Run `npm run generate:ipc`.
- Modify `src/preload/domains/automation.preload.ts`: expose methods.
- Modify `src/renderer/app/core/state/automation.store.ts`: load templates and run preflight.
- Modify `src/renderer/app/features/automations/automations-page.component.ts`: show template picker and preflight panel.
- Tests:
  - `src/main/security/task-preflight-service.automation.spec.ts`
  - `src/main/automations/automation-templates.spec.ts`
  - `src/renderer/app/core/state/automation.store.spec.ts`

## Tasks

### Task 1: Automation Preflight Types

**Files:**
- Modify: `src/shared/types/task-preflight.types.ts`
- Test: `src/main/security/task-preflight-service.automation.spec.ts`

- [x] **Step 1: Add failing type-level test through service usage**

Create a test that calls:

```ts
const report = await service.getAutomationPreflight({
  workingDirectory: repoPath,
  prompt: 'Run npm install and fix lint errors',
  provider: 'claude',
  model: 'claude-sonnet',
  yoloMode: false,
  expectedUnattended: true,
});

expect(report.surface).toBe('automation');
expect(report.suggestedPermissionRules.length).toBeGreaterThan(0);
```

Run:

```bash
npx vitest run src/main/security/task-preflight-service.automation.spec.ts
```

Expected: fail because `getAutomationPreflight()` does not exist.

- [x] **Step 2: Add types**

Add:

```ts
export interface AutomationPreflightRequest {
  workingDirectory: string;
  prompt: string;
  provider?: string;
  model?: string;
  yoloMode?: boolean;
  expectedUnattended?: boolean;
}

export interface SuggestedPermissionRule {
  id: string;
  scope: 'session' | 'project' | 'user';
  permission: string;
  pattern: string;
  action: 'allow' | 'ask';
  reason: string;
  risk: 'low' | 'medium' | 'high';
  writeTarget?: {
    filePath: string;
    mode: 'append-rule' | 'update-rule';
  };
  previewRule: {
    permission: string;
    pattern: string;
    action: 'allow' | 'ask';
  };
}

export interface AutomationPreflightReport extends TaskPreflightReport {
  surface: 'automation';
  okToSave: boolean;
  suggestedPermissionRules: SuggestedPermissionRule[];
  suggestedPromptEdits: Array<{ id: string; reason: string; replacementPrompt: string }>;
}
```

If `TaskPreflightSurface` is a union, add `'automation'`.

### Task 2: Extend `TaskPreflightService`

**Files:**
- Modify: `src/main/security/task-preflight-service.ts`
- Test: `src/main/security/task-preflight-service.automation.spec.ts`

- [x] **Step 1: Implement prompt classifiers**

Inside `TaskPreflightService`, add private helpers:

```ts
private inferRequiresWrite(prompt: string): boolean {
  return /\b(write|edit|modify|fix|install|update|delete|create|commit|format|lint --fix)\b/i.test(prompt);
}

private inferRequiresNetwork(prompt: string): boolean {
  return /\b(fetch|download|install|npm install|pnpm install|yarn add|curl|wget|api|github|pull request|pr)\b/i.test(prompt);
}
```

- [x] **Step 2: Implement `getAutomationPreflight()`**

Implementation:

1. Calls `getPreflight()` with `surface: 'automation'`, inferred write/network flags, and `taskType: 'automation'`.
2. Adds blocker when working directory does not exist.
3. Adds warning when `expectedUnattended` and permission predictions include `expected` or `likely`.
4. Adds prompt edit suggestion if the prompt lacks output instructions.
5. Adds scoped suggested permission rules for write/network cases when default action is `ask`.

- [x] **Step 3: Verify service**

Run:

```bash
npx vitest run src/main/security/task-preflight-service.automation.spec.ts
```

Expected: pass.

### Task 3: Built-in Automation Templates

**Files:**
- Create: `src/main/automations/automation-templates.ts`
- Test: `src/main/automations/automation-templates.spec.ts`

- [x] **Step 1: Write failing template tests**

Assert template IDs and prompt content:

```ts
const templates = listAutomationTemplates();
expect(templates.map(t => t.id)).toEqual([
  'daily-repo-health',
  'dependency-audit',
  'open-pr-review-sweep',
  'weekly-project-summary',
  'log-triage',
]);
expect(templates[0].prompt).toContain('Return a concise summary');
```

- [x] **Step 2: Implement catalog**

Create:

```ts
export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  suggestedSchedule: { type: 'cron'; expression: string; timezone: string };
  tags: string[];
}

export function listAutomationTemplates(): AutomationTemplate[] {
  return [/* five templates with output expectations in every prompt */];
}
```

Prompts must include explicit output expectations and avoid broad permission assumptions.

- [x] **Step 3: Verify templates**

Run:

```bash
npx vitest run src/main/automations/automation-templates.spec.ts
```

Expected: pass.

### Task 4: IPC and Renderer

**Files:**
- Modify: `packages/contracts/src/channels/automation.channels.ts`
- Modify: `src/main/ipc/handlers/automation-handlers.ts`
- Modify: `src/preload/domains/automation.preload.ts`
- Modify: `src/renderer/app/core/state/automation.store.ts`
- Modify: `src/renderer/app/features/automations/automations-page.component.ts`
- Test: `src/renderer/app/core/state/automation.store.spec.ts`

- [x] **Step 1: Add channels**

Add:

```ts
AUTOMATION_PREFLIGHT: 'automation:preflight',
AUTOMATION_TEMPLATES_LIST: 'automation:templates-list',
```

Run:

```bash
npm run generate:ipc
```

- [x] **Step 2: Add IPC handlers**

Handlers validate payloads and call:

```ts
getTaskPreflightService().getAutomationPreflight(payload)
listAutomationTemplates()
```

- [x] **Step 3: Add renderer store methods**

Add:

```ts
runPreflight(draft: AutomationDraft): Promise<AutomationPreflightReport>
loadTemplates(): Promise<AutomationTemplate[]>
applyTemplate(templateId: string): void
```

- [x] **Step 4: Update page**

Add a template picker, preflight button/auto-run before save, blockers, warnings, and suggested rules preview. Saving is blocked when `okToSave === false`; warnings can be acknowledged.

- [x] **Step 5: Verify Task 4**

Run:

```bash
npx vitest run src/renderer/app/core/state/automation.store.spec.ts
npx tsc --noEmit
```

Expected: pass.

### Task 5: Full Slice Verification

- [x] **Step 1: Focused tests**

```bash
npx vitest run src/main/security/task-preflight-service.automation.spec.ts src/main/automations/automation-templates.spec.ts src/renderer/app/core/state/automation.store.spec.ts
```

- [x] **Step 2: Required quality gates**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

- [x] **Step 3: Manual verification**

Create a draft automation that writes files while permissions default to ask. Confirm preflight shows a permission warning and suggested scoped rule. Apply a template and confirm the generated prompt includes output expectations.

## Completion Validation

Completed on 2026-05-06.

- Red/green service test: `npx vitest run src/main/security/task-preflight-service.automation.spec.ts`
- Red/green template test: `npx vitest run src/main/automations/automation-templates.spec.ts`
- Renderer store contract test: `npx vitest run src/renderer/app/core/state/automation.store.spec.ts`
- Focused slice tests: `npx vitest run src/main/security/task-preflight-service.automation.spec.ts src/main/automations/automation-templates.spec.ts src/renderer/app/core/state/automation.store.spec.ts`
- TypeScript app check: `npx tsc --noEmit`
- TypeScript spec check: `npx tsc --noEmit -p tsconfig.spec.json`
- Lint: `npm run lint`
- Full suite: `npm run test`
- Native ABI restored after tests: `npm run rebuild:native`
- Production build: `npm run build`
- Browser sanity pass: Angular renderer on `http://localhost:4568/automations` with mocked Electron API verified template application, output-expectation prompt text, preflight warning/rule display, warning acknowledgement gate, and final create payload.
