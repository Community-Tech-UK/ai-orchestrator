# Headless Review Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a headless npm-script review command that returns stable JSON for PR URL and local diff targets without starting the Electron renderer.

**Architecture:** Refactor cross-model review dispatch behind a narrow `ReviewExecutionHost` so the command does not need full `InstanceManager` state. The first version is an npm script (`npm run review -- ...`), not a packaged bin.

**Tech Stack:** Node/Electron main-process TypeScript, existing provider adapters, CrossModelReviewService, RepoJobService, Vitest.

---

## File Map

- Create `src/main/review/review-execution-host.ts`.
- Modify `src/main/orchestration/cross-model-review-service.ts`: accept/use the narrow host.
- Create `src/main/cli-entrypoints/review-command.ts`.
- Create `src/main/cli-entrypoints/review-command-output.ts`.
- Modify `package.json`: add `review` script and build wiring if needed.
- Test:
  - `src/main/cli-entrypoints/review-command-output.spec.ts`
  - `src/main/cli-entrypoints/review-command.spec.ts`
  - `src/main/orchestration/cross-model-review-service.headless.spec.ts`

## Tasks

### Task 1: Review Output Contract

**Files:**
- Create: `src/main/cli-entrypoints/review-command-output.ts`
- Test: `src/main/cli-entrypoints/review-command-output.spec.ts`

- [x] **Step 1: Write failing output tests**

Test JSON formatting with findings, skipped reviewers, and infrastructure errors.

- [x] **Step 2: Implement output types**

Export:

```ts
export interface HeadlessReviewResult {
  target: string;
  cwd: string;
  startedAt: string;
  completedAt: string;
  reviewers: Array<{ provider: string; model?: string; status: 'used' | 'skipped' | 'failed'; reason?: string }>;
  findings: Array<{ title: string; body: string; file?: string; line?: number; severity: 'critical' | 'high' | 'medium' | 'low'; confidence: number }>;
  summary: string;
  infrastructureErrors: string[];
}
```

Add `formatReviewJson(result): string` that returns pretty JSON and never throws on missing optional fields.

### Task 2: Decouple Review Dispatch

**Files:**
- Create: `src/main/review/review-execution-host.ts`
- Modify: `src/main/orchestration/cross-model-review-service.ts`
- Test: `src/main/orchestration/cross-model-review-service.headless.spec.ts`

- [x] **Step 1: Add host interface**

```ts
export interface ReviewExecutionHost {
  getWorkingDirectory(instanceId: string): string | undefined;
  getTaskDescription(instanceId: string): string | undefined;
  dispatchReviewerPrompt(provider: string, prompt: string, cwd: string, signal: AbortSignal): Promise<string>;
}
```

- [x] **Step 2: Refactor service**

Keep current `setInstanceManager()` for app mode, but add `setReviewExecutionHost(host)`. `onInstanceIdle()` can keep instance-buffer behavior; a new method `runHeadlessReview(request)` uses only the host.

- [x] **Step 3: Verify no renderer dependency**

Test imports `review-command.ts` in a Node/Vitest context without constructing Electron windows.

### Task 3: CLI Entrypoint

**Files:**
- Create: `src/main/cli-entrypoints/review-command.ts`
- Modify: `package.json`
- Test: `src/main/cli-entrypoints/review-command.spec.ts`

- [x] **Step 1: Parse arguments**

Support:

```bash
npm run review -- https://github.com/org/repo/pull/123 --json
npm run review -- main...feature --json
npm run review -- --cwd /path/to/repo --target HEAD --json
```

- [x] **Step 2: Resolve target**

Use `RepoJobService` PR URL metadata where possible. For local targets, gather diff text using non-interactive git commands.

- [x] **Step 3: Run review**

Call the headless review service path and print JSON to stdout. Exit non-zero for infrastructure failure only, not for findings.

### Task 4: Verification

```bash
npx vitest run src/main/cli-entrypoints/review-command-output.spec.ts src/main/cli-entrypoints/review-command.spec.ts src/main/orchestration/cross-model-review-service.headless.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

Manual check:

```bash
npm run build
npm run review -- --cwd /Users/suas/work/orchestrat0r/ai-orchestrator --target HEAD --json
```

## Completion Validation

- `npx vitest run src/main/cli-entrypoints/review-command-output.spec.ts src/main/cli-entrypoints/review-command.spec.ts src/main/orchestration/cross-model-review-service.headless.spec.ts src/main/orchestration/cross-model-review-service.spec.ts`
- `npx tsc --noEmit`
- `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint`
- `npm run build`
- Manual smoke: `npm run review -- --cwd /Users/suas/work/orchestrat0r/ai-orchestrator --target HEAD --json --reviewer none`

The manual smoke uses `--reviewer none` to validate the npm script, git target resolution, and stable JSON output without invoking external AI CLIs on the dirty implementation worktree.
