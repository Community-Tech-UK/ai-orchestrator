# Prompt History All-Project Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a recall scope toggle so prompt recall can search the current thread, current project, or all projects, with text-only insertion for all-project results.

**Architecture:** Reuse existing prompt history persistence and `allEntries`; only the renderer store/controller and overlay UI need scope support. v1 does not restore attachments from other projects.

**Tech Stack:** Angular 21 signals, TypeScript, existing ElectronStore-backed prompt history, Vitest.

---

## File Map

- Modify `src/renderer/app/core/state/prompt-history.store.ts`.
- Modify `src/renderer/app/features/prompt-history/prompt-history-search.controller.ts`.
- Modify input overlay/component files that host prompt recall.
- Modify or create focused specs:
  - `src/renderer/app/core/state/prompt-history.store.spec.ts`
  - `src/renderer/app/features/prompt-history/prompt-history-search.controller.spec.ts`

## Tasks

### Task 1: Store Scope Support

- [x] **Step 1: Write failing store tests**

Assert:

```ts
expect(store.getEntriesForRecall({ scope: 'thread', instanceId, workingDirectory })).toEqual(threadOnly);
expect(store.getEntriesForRecall({ scope: 'project', instanceId, workingDirectory })).toEqual(projectEntries);
expect(store.getEntriesForRecall({ scope: 'all', instanceId, workingDirectory })).toEqual(allEntries);
```

- [x] **Step 2: Add scope type**

```ts
export type PromptRecallScope = 'thread' | 'project' | 'all';
```

- [x] **Step 3: Update recall selector**

Change `getEntriesForRecall()` to accept `{ scope, instanceId, workingDirectory }`. Default scope is `project` to preserve current behavior.

### Task 2: Controller and UI

- [x] **Step 1: Write failing controller tests**

Assert scope switching changes results and all-project result labels include source project/working directory.

- [x] **Step 2: Add scope state**

Add a small segmented control or menu with `Thread`, `Project`, `All`. Persist selected scope in the existing local settings pattern used by similar UI state, or keep it in the store if no durable preference exists.

- [x] **Step 3: Text-only insertion**

When selecting an all-project result, insert only the prompt text. Do not reattach files. If result metadata mentions attachments, show a small note in the overlay row that attachments are not recalled in all-project mode.

### Task 3: Verification

```bash
npx vitest run src/renderer/app/core/state/prompt-history.store.spec.ts src/renderer/app/features/prompt-history/prompt-history-search.controller.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

Manual check: open prompt recall in one project, switch to `All`, select a prompt from another project, and confirm only text is inserted.

## Completion Validation

- Red test run: `npx vitest run src/renderer/app/core/state/__tests__/prompt-history.store.spec.ts src/renderer/app/features/prompt-history/prompt-history-search.controller.spec.ts` failed before implementation for the missing scope API.
- Green focused test run: `npx vitest run src/renderer/app/core/state/__tests__/prompt-history.store.spec.ts src/renderer/app/features/prompt-history/prompt-history-search.controller.spec.ts`
- `npx tsc --noEmit`
- `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint`
- `npm run build`

The all-project text-only behavior is validated in the controller spec by passing an entry with attachment-shaped metadata and asserting the recall request strips it before insertion.
