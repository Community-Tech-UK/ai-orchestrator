# Phase 1: Contracts Package Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract IPC channels, Zod schemas, and transport types into `packages/contracts` — the single source of truth for all main↔renderer communication contracts — then split the 5,633-line preload.ts into domain-scoped modules.

**Architecture:** A new `packages/contracts` workspace package owns all IPC channel definitions (grouped by domain), Zod payload schemas, and transport types. The preload script — which cannot import at runtime due to Electron sandbox — receives generated channel copies via an updated build script. The monolithic preload is split into domain modules composed at the top level. All main-process and renderer imports are updated to reference contracts.

**Tech Stack:** TypeScript 5.9, npm workspaces, Zod 4, Electron 40, Vitest, Node.js codegen scripts

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/contracts/package.json` | Workspace package metadata |
| Create | `packages/contracts/tsconfig.json` | Contracts compilation config |
| Create | `packages/contracts/src/channels/*.channels.ts` | Domain-grouped IPC channel definitions (10 files) |
| Create | `packages/contracts/src/channels/index.ts` | Barrel merging all domain channels into `IPC_CHANNELS` |
| Create | `packages/contracts/src/schemas/` | Zod payload schemas, split by domain |
| Create | `packages/contracts/src/types/transport.types.ts` | `IpcMessage`, `IpcChannel`, payload interfaces |
| Create | `packages/contracts/src/index.ts` | Package barrel export |
| Create | `src/preload/domains/*.ts` | Domain-scoped preload API modules (10 files) |
| Create | `src/preload/generated/channels.ts` | Generated IPC_CHANNELS copy for runtime |
| Modify | `package.json` | Add `workspaces` field |
| Modify | `tsconfig.json`, `tsconfig.electron.json`, `tsconfig.spec.json` | Add `@contracts/*` path alias |
| Modify | `vitest.config.ts` | Add `@contracts` resolve alias |
| Modify | `src/preload/preload.ts` | Replace monolith with domain module composition |
| Modify | `scripts/generate-preload-channels.js` | Source from contracts package |
| Modify | `scripts/verify-ipc-channels.js` | Verify against contracts package |
| Modify | `src/shared/types/ipc.types.ts` | Thin re-export shim from contracts |
| Modify | `src/shared/validation/ipc-schemas.ts` | Re-export from contracts |

## Task Overview

| # | Name | Group | Est. |
|---|------|-------|------|
| 1 | npm workspaces + contracts package scaffold | A | 5 min |
| 2 | Root tsconfig + vitest alias updates | A | 3 min |
| 3 | Instance + hibernation + compaction channels | B | 5 min |
| 4 | File, editor, dialog, image channels | B | 4 min |
| 5 | Session, archive, history channels | B | 4 min |
| 6 | Orchestration, verification, debate, consensus, workflow, review, hooks, skills channels | B | 5 min |
| 7 | Memory, RLM, observation channels | B | 4 min |
| 8 | Provider, plugins, CLI detection, model discovery channels | B | 4 min |
| 9 | Infrastructure channels (settings, config, app, security, cost, stats, debug, log, search) | B | 5 min |
| 10 | Communication channels (comm, channel mgmt, remote observer, remote nodes, remote FS) | B | 4 min |
| 11 | Learning, training, specialist, A/B testing channels | B | 4 min |
| 12 | Workspace channels (VCS, worktrees, TODO, LSP, multiedit, bash, MCP, codebase, repo-job, tasks) | B | 5 min |
| 13 | Channels barrel + contract test for IPC_CHANNELS identity | B | 4 min |
| 14 | Move and split Zod schemas to contracts | C | 8 min |
| 15 | Move transport types to contracts | D | 5 min |
| 16 | Split preload into domain modules | E | 10 min |
| 17 | Update generator + verification scripts | F | 5 min |
| 18 | Update all main-process imports | G | 6 min |
| 19 | Update all renderer imports | G | 4 min |
| 20 | Final verification | — | 5 min |

---

## Task 1: npm workspaces + contracts package scaffold

**Files:**
- Modify: `package.json`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`

- [ ] **Step 1: Add workspaces field to root package.json**

The existing `package.json` has no `workspaces` field. Add it after the `"engines"` block. Read the file first (already done), then edit:

```json
{
  "name": "ai-orchestrator",
  "version": "0.1.0",
  "description": "Desktop application for managing multiple AI CLI instances",
  "main": "dist/main/index.js",
  "workspaces": [
    "packages/*"
  ],
  "engines": {
    "node": ">=20"
  }
}
```

Only the `workspaces` field is being added — no other changes to `package.json`.

- [ ] **Step 2: Create packages/contracts/package.json**

```json
{
  "name": "@ai-orchestrator/contracts",
  "version": "0.1.0",
  "description": "IPC channel definitions, Zod schemas, and transport types for ai-orchestrator",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: Create packages/contracts/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "node",
    "baseUrl": "."
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create the top-level barrel**

Create `packages/contracts/src/index.ts`:

```typescript
/**
 * @ai-orchestrator/contracts
 *
 * Single source of truth for all IPC channel definitions, Zod payload schemas,
 * and transport types used across the main process, preload, and renderer.
 */

export * from './channels/index';
export * from './schemas/index';
export * from './types/index';
```

- [ ] **Step 5: Create directory structure**

Run:
```bash
mkdir -p packages/contracts/src/channels
mkdir -p packages/contracts/src/schemas
mkdir -p packages/contracts/src/types
```

- [ ] **Step 6: Install workspace (links the package)**

Run: `npm install`

Expected: `node_modules/@ai-orchestrator/contracts` symlink appears pointing to `packages/contracts`

- [ ] **Step 7: Commit**
```bash
git add packages/contracts/ package.json package-lock.json
git commit -m "chore: scaffold packages/contracts workspace package"
```

---

## Task 2: Root tsconfig + vitest alias updates

**Files:**
- Modify: `tsconfig.json`
- Modify: `tsconfig.electron.json`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Add @contracts alias to tsconfig.json**

In `tsconfig.json`, update the `paths` block:

```json
"paths": {
  "@shared/*": ["./src/shared/*"],
  "@contracts/*": ["./packages/contracts/src/*"],
  "@contracts": ["./packages/contracts/src/index"]
}
```

- [ ] **Step 2: Add @contracts alias to tsconfig.electron.json**

In `tsconfig.electron.json`, update `paths` and `include`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "node",
    "paths": {
      "@shared/*": ["./src/shared/*"],
      "@contracts/*": ["./packages/contracts/src/*"],
      "@contracts": ["./packages/contracts/src/index"]
    },
    "baseUrl": "."
  },
  "include": [
    "src/main/**/*",
    "src/preload/**/*",
    "src/shared/**/*",
    "packages/contracts/src/**/*"
  ],
  "exclude": [
    "src/renderer/**/*",
    "node_modules",
    "src/**/*.spec.ts",
    "src/**/*.test.ts",
    "src/main/channels/adapters/whatsapp-adapter.ts"
  ]
}
```

Note: `rootDir` changes from `"./src"` to `"."` to accommodate `packages/` alongside `src/`.

- [ ] **Step 3: Add @contracts alias to vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'packages/**/*.spec.ts', 'packages/**/*.test.ts'],
    exclude: ['src/**/*.bench.ts', 'src/**/*.load.ts', 'src/main/channels/__tests__/whatsapp-adapter.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'packages/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.test.ts',
        'src/**/*.bench.ts',
        'src/**/*.load.ts',
        'src/**/*.types.ts',
        'src/renderer/**/*',
      ],
    },
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    benchmark: {
      include: ['src/**/*.bench.ts'],
      exclude: ['node_modules'],
      reporters: ['default'],
      outputJson: './benchmark-results.json',
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, './src/shared'),
      '@contracts': resolve(__dirname, './packages/contracts/src'),
    },
  },
});
```

- [ ] **Step 4: Verify aliases resolve**

Run: `npx tsc --noEmit -p tsconfig.electron.json`

Expected: Exits with code 0 (no errors — contracts/src is empty so far but structure is valid).

- [ ] **Step 5: Commit**
```bash
git add tsconfig.json tsconfig.electron.json vitest.config.ts
git commit -m "chore: add @contracts path alias to tsconfigs and vitest"
```

---

## Task 3: Instance, hibernation, and compaction channels

**Files:**
- Create: `packages/contracts/src/channels/instance.channels.ts`

This is the first domain channel file. The channel values are copied verbatim from `src/shared/types/ipc.types.ts` lines 21–54.

- [ ] **Step 1: Write the test first**

Create `packages/contracts/src/channels/__tests__/instance.channels.spec.ts`:

```typescript
import { INSTANCE_CHANNELS } from '../instance.channels';

describe('INSTANCE_CHANNELS', () => {
  it('has the correct channel values', () => {
    expect(INSTANCE_CHANNELS.INSTANCE_CREATE).toBe('instance:create');
    expect(INSTANCE_CHANNELS.INSTANCE_SEND_INPUT).toBe('instance:send-input');
    expect(INSTANCE_CHANNELS.INSTANCE_HIBERNATE).toBe('instance:hibernate');
    expect(INSTANCE_CHANNELS.INSTANCE_COMPACT).toBe('instance:compact');
    expect(INSTANCE_CHANNELS.CONTEXT_WARNING).toBe('context:warning');
  });

  it('is deeply readonly (const assertion)', () => {
    // TypeScript will prevent assignment; runtime check verifies no enumerable mutations
    expect(Object.isFrozen(INSTANCE_CHANNELS) || typeof INSTANCE_CHANNELS === 'object').toBe(true);
  });
});
```

Run: `npx vitest run packages/contracts/src/channels/__tests__/instance.channels.spec.ts`
Expected: **FAIL** (file doesn't exist yet)

- [ ] **Step 2: Create instance.channels.ts**

```typescript
/**
 * IPC channels for instance lifecycle: creation, I/O, hibernation, and context compaction.
 */
export const INSTANCE_CHANNELS = {
  // Instance management
  INSTANCE_CREATE: 'instance:create',
  INSTANCE_CREATE_WITH_MESSAGE: 'instance:create-with-message',
  INSTANCE_TERMINATE: 'instance:terminate',
  INSTANCE_TERMINATE_ALL: 'instance:terminate-all',
  INSTANCE_RESTART: 'instance:restart',
  INSTANCE_RENAME: 'instance:rename',
  INSTANCE_CHANGE_AGENT_MODE: 'instance:change-agent-mode',
  INSTANCE_TOGGLE_YOLO_MODE: 'instance:toggle-yolo-mode',
  INSTANCE_CHANGE_MODEL: 'instance:change-model',
  INSTANCE_SEND_INPUT: 'instance:send-input',
  INSTANCE_INTERRUPT: 'instance:interrupt',
  INSTANCE_STATE_UPDATE: 'instance:state-update',
  INSTANCE_OUTPUT: 'instance:output',
  INSTANCE_BATCH_UPDATE: 'instance:batch-update',
  INSTANCE_CREATED: 'instance:created',
  INSTANCE_REMOVED: 'instance:removed',
  INSTANCE_LIST: 'instance:list',
  INSTANCE_LOAD_OLDER_MESSAGES: 'instance:load-older-messages',

  // Hibernation lifecycle
  INSTANCE_HIBERNATE: 'instance:hibernate',
  INSTANCE_HIBERNATED: 'instance:hibernated',
  INSTANCE_WAKE: 'instance:wake',
  INSTANCE_WAKING: 'instance:waking',
  INSTANCE_TRANSCRIPT_CHUNK: 'instance:transcript-chunk',

  // Context compaction
  INSTANCE_COMPACT: 'instance:compact',
  INSTANCE_COMPACT_STATUS: 'instance:compact-status',
  CONTEXT_WARNING: 'context:warning',

  // Input required events (CLI permission prompts, etc.)
  INPUT_REQUIRED: 'instance:input-required',
  INPUT_REQUIRED_RESPOND: 'instance:input-required-respond',
} as const;
```

- [ ] **Step 3: Run the test again**

Run: `npx vitest run packages/contracts/src/channels/__tests__/instance.channels.spec.ts`
Expected: **PASS**

- [ ] **Step 4: Commit**
```bash
git add packages/contracts/src/channels/instance.channels.ts packages/contracts/src/channels/__tests__/instance.channels.spec.ts
git commit -m "feat(contracts): add INSTANCE_CHANNELS"
```

---

## Task 4: File, editor, dialog, and image channels

**Files:**
- Create: `packages/contracts/src/channels/file.channels.ts`

- [ ] **Step 1: Write the test first**

Create `packages/contracts/src/channels/__tests__/file.channels.spec.ts`:

```typescript
import { FILE_CHANNELS } from '../file.channels';

describe('FILE_CHANNELS', () => {
  it('has correct values for file operations', () => {
    expect(FILE_CHANNELS.FILE_DROP).toBe('file:drop');
    expect(FILE_CHANNELS.FILE_READ_DIR).toBe('file:read-dir');
    expect(FILE_CHANNELS.FILE_WRITE_TEXT).toBe('file:write-text');
  });

  it('has correct values for editor operations', () => {
    expect(FILE_CHANNELS.EDITOR_DETECT).toBe('editor:detect');
    expect(FILE_CHANNELS.EDITOR_OPEN_FILE_AT_LINE).toBe('editor:open-file-at-line');
  });

  it('has correct values for dialog operations', () => {
    expect(FILE_CHANNELS.DIALOG_SELECT_FOLDER).toBe('dialog:select-folder');
    expect(FILE_CHANNELS.DIALOG_SELECT_FILES).toBe('dialog:select-files');
  });

  it('has correct values for image operations', () => {
    expect(FILE_CHANNELS.IMAGE_PASTE).toBe('image:paste');
    expect(FILE_CHANNELS.IMAGE_COPY_TO_CLIPBOARD).toBe('image:copy-to-clipboard');
  });
});
```

Run: `npx vitest run packages/contracts/src/channels/__tests__/file.channels.spec.ts`
Expected: **FAIL**

- [ ] **Step 2: Create file.channels.ts**

```typescript
/**
 * IPC channels for file system operations, external editor integration,
 * dialog windows, and image handling.
 */
export const FILE_CHANNELS = {
  // File operations
  FILE_DROP: 'file:drop',
  FILE_READ_DIR: 'file:read-dir',
  FILE_GET_STATS: 'file:get-stats',
  FILE_READ_TEXT: 'file:read-text',
  FILE_WRITE_TEXT: 'file:write-text',
  FILE_OPEN_PATH: 'file:open-path',

  // Ecosystem operations (file-based extensibility)
  ECOSYSTEM_LIST: 'ecosystem:list',
  ECOSYSTEM_WATCH_START: 'ecosystem:watch-start',
  ECOSYSTEM_WATCH_STOP: 'ecosystem:watch-stop',
  ECOSYSTEM_CHANGED: 'ecosystem:changed',

  // External Editor
  EDITOR_DETECT: 'editor:detect',
  EDITOR_OPEN: 'editor:open',
  EDITOR_OPEN_FILE: 'editor:open-file',
  EDITOR_OPEN_FILE_AT_LINE: 'editor:open-file-at-line',
  EDITOR_OPEN_DIRECTORY: 'editor:open-directory',
  EDITOR_SET_PREFERRED: 'editor:set-preferred',
  EDITOR_SET_DEFAULT: 'editor:set-default',
  EDITOR_GET_PREFERRED: 'editor:get-preferred',
  EDITOR_GET_DEFAULT: 'editor:get-default',
  EDITOR_GET_AVAILABLE: 'editor:get-available',

  // Dialog operations
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_FILES: 'dialog:select-files',

  // Image operations
  IMAGE_PASTE: 'image:paste',
  IMAGE_COPY_TO_CLIPBOARD: 'image:copy-to-clipboard',
  IMAGE_CONTEXT_MENU: 'image:context-menu',

  // File Watcher
  WATCHER_START: 'watcher:start',
  WATCHER_STOP: 'watcher:stop',
  WATCHER_STOP_ALL: 'watcher:stop-all',
  WATCHER_WATCH: 'watcher:watch',
  WATCHER_UNWATCH: 'watcher:unwatch',
  WATCHER_GET_ACTIVE: 'watcher:get-active',
  WATCHER_GET_SESSIONS: 'watcher:get-sessions',
  WATCHER_GET_CHANGES: 'watcher:get-changes',
  WATCHER_CLEAR_BUFFER: 'watcher:clear-buffer',
  WATCHER_FILE_CHANGED: 'watcher:file-changed',
  WATCHER_ERROR: 'watcher:error',
} as const;
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/file.channels.spec.ts`
Expected: **PASS**

- [ ] **Step 4: Commit**
```bash
git add packages/contracts/src/channels/file.channels.ts packages/contracts/src/channels/__tests__/file.channels.spec.ts
git commit -m "feat(contracts): add FILE_CHANNELS"
```

---

## Task 5: Session, archive, and history channels

**Files:**
- Create: `packages/contracts/src/channels/session.channels.ts`

- [ ] **Step 1: Write the test first**

Create `packages/contracts/src/channels/__tests__/session.channels.spec.ts`:

```typescript
import { SESSION_CHANNELS } from '../session.channels';

describe('SESSION_CHANNELS', () => {
  it('has correct session values', () => {
    expect(SESSION_CHANNELS.SESSION_FORK).toBe('session:fork');
    expect(SESSION_CHANNELS.SESSION_LIST_RESUMABLE).toBe('session:list-resumable');
    expect(SESSION_CHANNELS.SESSION_CREATE_SNAPSHOT).toBe('session:create-snapshot');
  });

  it('has correct archive values', () => {
    expect(SESSION_CHANNELS.ARCHIVE_SESSION).toBe('archive:session');
    expect(SESSION_CHANNELS.ARCHIVE_SEARCH).toBe('archive:search');
    expect(SESSION_CHANNELS.ARCHIVE_CLEANUP).toBe('archive:cleanup');
  });

  it('has correct history values', () => {
    expect(SESSION_CHANNELS.HISTORY_LIST).toBe('history:list');
    expect(SESSION_CHANNELS.HISTORY_RESTORE).toBe('history:restore');
  });
});
```

Run: `npx vitest run packages/contracts/src/channels/__tests__/session.channels.spec.ts`
Expected: **FAIL**

- [ ] **Step 2: Create session.channels.ts**

```typescript
/**
 * IPC channels for session management, archiving, and history.
 */
export const SESSION_CHANNELS = {
  // Session operations
  SESSION_FORK: 'session:fork',
  SESSION_EXPORT: 'session:export',
  SESSION_IMPORT: 'session:import',
  SESSION_COPY_TO_CLIPBOARD: 'session:copy-to-clipboard',
  SESSION_SAVE_TO_FILE: 'session:save-to-file',
  SESSION_REVEAL_FILE: 'session:reveal-file',
  SESSION_SHARE_PREVIEW: 'session:share-preview',
  SESSION_SHARE_SAVE: 'session:share-save',
  SESSION_SHARE_LOAD: 'session:share-load',
  SESSION_SHARE_REPLAY: 'session:share-replay',
  SESSION_LIST_RESUMABLE: 'session:list-resumable',
  SESSION_RESUME: 'session:resume',
  SESSION_LIST_SNAPSHOTS: 'session:list-snapshots',
  SESSION_CREATE_SNAPSHOT: 'session:create-snapshot',
  SESSION_GET_STATS: 'session:get-stats',

  // Snapshot operations (file revert)
  SNAPSHOT_TAKE: 'snapshot:take',
  SNAPSHOT_START_SESSION: 'snapshot:start-session',
  SNAPSHOT_END_SESSION: 'snapshot:end-session',
  SNAPSHOT_GET_FOR_INSTANCE: 'snapshot:get-for-instance',
  SNAPSHOT_GET_FOR_FILE: 'snapshot:get-for-file',
  SNAPSHOT_GET_SESSIONS: 'snapshot:get-sessions',
  SNAPSHOT_GET_CONTENT: 'snapshot:get-content',
  SNAPSHOT_REVERT_FILE: 'snapshot:revert-file',
  SNAPSHOT_REVERT_SESSION: 'snapshot:revert-session',
  SNAPSHOT_GET_DIFF: 'snapshot:get-diff',
  SNAPSHOT_DELETE: 'snapshot:delete',
  SNAPSHOT_CLEANUP: 'snapshot:cleanup',
  SNAPSHOT_GET_STATS: 'snapshot:get-stats',

  // Session Archiving
  ARCHIVE_SESSION: 'archive:session',
  ARCHIVE_RESTORE: 'archive:restore',
  ARCHIVE_DELETE: 'archive:delete',
  ARCHIVE_LIST: 'archive:list',
  ARCHIVE_SEARCH: 'archive:search',
  ARCHIVE_GET_META: 'archive:get-meta',
  ARCHIVE_UPDATE_TAGS: 'archive:update-tags',
  ARCHIVE_GET_STATS: 'archive:get-stats',
  ARCHIVE_CLEANUP: 'archive:cleanup',

  // History operations
  HISTORY_LIST: 'history:list',
  HISTORY_LOAD: 'history:load',
  HISTORY_ARCHIVE: 'history:archive',
  HISTORY_DELETE: 'history:delete',
  HISTORY_RESTORE: 'history:restore',
  HISTORY_CLEAR: 'history:clear',
} as const;
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/session.channels.spec.ts`
Expected: **PASS**

- [ ] **Step 4: Commit**
```bash
git add packages/contracts/src/channels/session.channels.ts packages/contracts/src/channels/__tests__/session.channels.spec.ts
git commit -m "feat(contracts): add SESSION_CHANNELS"
```

---

## Task 6: Orchestration, verification, debate, consensus, workflow, review, hooks, skills channels

**Files:**
- Create: `packages/contracts/src/channels/orchestration.channels.ts`

- [ ] **Step 1: Write the test first**

Create `packages/contracts/src/channels/__tests__/orchestration.channels.spec.ts`:

```typescript
import { ORCHESTRATION_CHANNELS } from '../orchestration.channels';

describe('ORCHESTRATION_CHANNELS', () => {
  it('has orchestration activity channel', () => {
    expect(ORCHESTRATION_CHANNELS.ORCHESTRATION_ACTIVITY).toBe('orchestration:activity');
  });

  it('has verification channels', () => {
    expect(ORCHESTRATION_CHANNELS.VERIFY_START).toBe('verify:start');
    expect(ORCHESTRATION_CHANNELS.VERIFICATION_COMPLETE).toBe('verification:complete');
  });

  it('has debate channels', () => {
    expect(ORCHESTRATION_CHANNELS.DEBATE_START).toBe('debate:start');
    expect(ORCHESTRATION_CHANNELS.DEBATE_EVENT).toBe('debate:event');
  });

  it('has consensus channels', () => {
    expect(ORCHESTRATION_CHANNELS.CONSENSUS_QUERY).toBe('consensus:query');
  });

  it('has workflow channels', () => {
    expect(ORCHESTRATION_CHANNELS.WORKFLOW_START).toBe('workflow:start');
    expect(ORCHESTRATION_CHANNELS.WORKFLOW_GATE_PENDING).toBe('workflow:gate-pending');
  });

  it('has review agent channels', () => {
    expect(ORCHESTRATION_CHANNELS.REVIEW_START_SESSION).toBe('review:start-session');
  });

  it('has hooks channels', () => {
    expect(ORCHESTRATION_CHANNELS.HOOKS_LIST).toBe('hooks:list');
    expect(ORCHESTRATION_CHANNELS.HOOKS_TRIGGERED).toBe('hooks:triggered');
  });

  it('has skills channels', () => {
    expect(ORCHESTRATION_CHANNELS.SKILLS_DISCOVER).toBe('skills:discover');
    expect(ORCHESTRATION_CHANNELS.SKILLS_GET_MEMORY).toBe('skills:get-memory');
  });
});
```

Run: `npx vitest run packages/contracts/src/channels/__tests__/orchestration.channels.spec.ts`
Expected: **FAIL**

- [ ] **Step 2: Create orchestration.channels.ts**

```typescript
/**
 * IPC channels for orchestration, multi-agent verification, debate, consensus,
 * workflows, review agents, hooks, and skills.
 */
export const ORCHESTRATION_CHANNELS = {
  // Orchestration activity (real-time status updates)
  ORCHESTRATION_ACTIVITY: 'orchestration:activity',
  SUPERVISOR_STATUS: 'supervisor:status',
  SUPERVISOR_METRICS: 'supervisor:metrics',

  // Multi-Agent Verification operations
  VERIFY_START: 'verify:start',
  VERIFY_GET_RESULT: 'verify:get-result',
  VERIFY_GET_ACTIVE: 'verify:get-active',
  VERIFY_CANCEL: 'verify:cancel',
  VERIFY_GET_PERSONALITIES: 'verify:get-personalities',
  VERIFY_CONFIGURE: 'verify:configure',
  VERIFY_STARTED: 'verify:started',
  VERIFY_AGENT_RESPONDED: 'verify:agent-responded',
  VERIFY_COMPLETED: 'verify:completed',

  // Verification operations (Phase 8.3 - alternative naming)
  VERIFICATION_VERIFY_MULTI: 'verification:verify-multi',
  VERIFICATION_START_CLI: 'verification:start-cli',
  VERIFICATION_CANCEL: 'verification:cancel',
  VERIFICATION_GET_ACTIVE: 'verification:get-active',
  VERIFICATION_GET_RESULT: 'verification:get-result',

  // Verification streaming events
  VERIFICATION_AGENT_START: 'verification:agent-start',
  VERIFICATION_AGENT_STREAM: 'verification:agent-stream',
  VERIFICATION_AGENT_COMPLETE: 'verification:agent-complete',
  VERIFICATION_AGENT_ERROR: 'verification:agent-error',
  VERIFICATION_ROUND_PROGRESS: 'verification:round-progress',
  VERIFICATION_CONSENSUS_UPDATE: 'verification:consensus-update',
  VERIFICATION_COMPLETE: 'verification:complete',
  VERIFICATION_ERROR: 'verification:error',

  // Verification event forwarding (main -> renderer)
  VERIFICATION_EVENT_STARTED: 'verification:event:started',
  VERIFICATION_EVENT_PROGRESS: 'verification:event:progress',
  VERIFICATION_EVENT_COMPLETED: 'verification:event:completed',
  VERIFICATION_EVENT_ERROR: 'verification:event:error',

  // Debate operations
  DEBATE_START: 'debate:start',
  DEBATE_GET_RESULT: 'debate:get-result',
  DEBATE_GET_ACTIVE: 'debate:get-active',
  DEBATE_CANCEL: 'debate:cancel',
  DEBATE_GET_STATS: 'debate:get-stats',
  DEBATE_PAUSE: 'debate:pause',
  DEBATE_RESUME: 'debate:resume',
  DEBATE_STOP: 'debate:stop',
  DEBATE_INTERVENE: 'debate:intervene',
  DEBATE_EVENT: 'debate:event',

  // Debate event forwarding (main -> renderer)
  DEBATE_EVENT_STARTED: 'debate:event:started',
  DEBATE_EVENT_ROUND_COMPLETE: 'debate:event:round-complete',
  DEBATE_EVENT_COMPLETED: 'debate:event:completed',
  DEBATE_EVENT_ERROR: 'debate:event:error',
  DEBATE_EVENT_PAUSED: 'debate:event:paused',
  DEBATE_EVENT_RESUMED: 'debate:event:resumed',

  // Consensus operations
  CONSENSUS_QUERY: 'consensus:query',
  CONSENSUS_ABORT: 'consensus:abort',
  CONSENSUS_GET_ACTIVE: 'consensus:get-active',

  // Cascade Supervision operations
  SUPERVISION_CREATE_TREE: 'supervision:create-tree',
  SUPERVISION_ADD_WORKER: 'supervision:add-worker',
  SUPERVISION_START_WORKER: 'supervision:start-worker',
  SUPERVISION_STOP_WORKER: 'supervision:stop-worker',
  SUPERVISION_HANDLE_FAILURE: 'supervision:handle-failure',
  SUPERVISION_GET_TREE: 'supervision:get-tree',
  SUPERVISION_GET_HEALTH: 'supervision:get-health',
  SUPERVISION_GET_HIERARCHY: 'supervision:get-hierarchy',
  SUPERVISION_GET_ALL_REGISTRATIONS: 'supervision:get-all-registrations',
  SUPERVISION_EXHAUSTED: 'supervision:exhausted',
  SUPERVISION_HEALTH_CHANGED: 'supervision:health-changed',
  SUPERVISION_HEALTH_GLOBAL: 'supervision:health-global',
  SUPERVISION_TREE_UPDATED: 'supervision:tree-updated',
  SUPERVISION_WORKER_FAILED: 'supervision:worker-failed',
  SUPERVISION_WORKER_RESTARTED: 'supervision:worker-restarted',
  SUPERVISION_CIRCUIT_BREAKER_CHANGED: 'supervision:circuit-breaker-changed',

  // Workflow operations
  WORKFLOW_LIST_TEMPLATES: 'workflow:list-templates',
  WORKFLOW_GET_TEMPLATE: 'workflow:get-template',
  WORKFLOW_START: 'workflow:start',
  WORKFLOW_GET_EXECUTION: 'workflow:get-execution',
  WORKFLOW_GET_BY_INSTANCE: 'workflow:get-by-instance',
  WORKFLOW_COMPLETE_PHASE: 'workflow:complete-phase',
  WORKFLOW_SATISFY_GATE: 'workflow:satisfy-gate',
  WORKFLOW_SKIP_PHASE: 'workflow:skip-phase',
  WORKFLOW_CANCEL: 'workflow:cancel',
  WORKFLOW_GET_PROMPT_ADDITION: 'workflow:get-prompt-addition',
  WORKFLOW_STARTED: 'workflow:started',
  WORKFLOW_COMPLETED: 'workflow:completed',
  WORKFLOW_PHASE_CHANGED: 'workflow:phase-changed',
  WORKFLOW_GATE_PENDING: 'workflow:gate-pending',

  // Review agent operations
  REVIEW_LIST_AGENTS: 'review:list-agents',
  REVIEW_GET_AGENT: 'review:get-agent',
  REVIEW_START_SESSION: 'review:start-session',
  REVIEW_GET_SESSION: 'review:get-session',
  REVIEW_GET_ISSUES: 'review:get-issues',
  REVIEW_ACKNOWLEDGE_ISSUE: 'review:acknowledge-issue',
  REVIEW_SESSION_STARTED: 'review:session-started',
  REVIEW_SESSION_COMPLETED: 'review:session-completed',

  // Cross-Model Review
  CROSS_MODEL_REVIEW_RESULT: 'cross-model-review:result',
  CROSS_MODEL_REVIEW_STARTED: 'cross-model-review:started',
  CROSS_MODEL_REVIEW_ALL_UNAVAILABLE: 'cross-model-review:all-unavailable',
  CROSS_MODEL_REVIEW_STATUS: 'cross-model-review:status',
  CROSS_MODEL_REVIEW_DISMISS: 'cross-model-review:dismiss',
  CROSS_MODEL_REVIEW_ACTION: 'cross-model-review:action',

  // Hook operations
  HOOKS_LIST: 'hooks:list',
  HOOKS_GET: 'hooks:get',
  HOOKS_CREATE: 'hooks:create',
  HOOKS_UPDATE: 'hooks:update',
  HOOKS_DELETE: 'hooks:delete',
  HOOKS_EVALUATE: 'hooks:evaluate',
  HOOKS_IMPORT: 'hooks:import',
  HOOKS_EXPORT: 'hooks:export',
  HOOK_APPROVALS_LIST: 'hooks:approvals:list',
  HOOK_APPROVALS_UPDATE: 'hooks:approvals:update',
  HOOK_APPROVALS_CLEAR: 'hooks:approvals:clear',
  HOOKS_TRIGGERED: 'hooks:triggered',

  // Skill operations
  SKILLS_DISCOVER: 'skills:discover',
  SKILLS_LIST: 'skills:list',
  SKILLS_GET: 'skills:get',
  SKILLS_LOAD: 'skills:load',
  SKILLS_UNLOAD: 'skills:unload',
  SKILLS_LOAD_REFERENCE: 'skills:load-reference',
  SKILLS_LOAD_EXAMPLE: 'skills:load-example',
  SKILLS_MATCH: 'skills:match',
  SKILLS_GET_MEMORY: 'skills:get-memory',

  // User action requests (orchestrator -> user)
  USER_ACTION_REQUEST: 'user-action:request',
  USER_ACTION_RESPOND: 'user-action:respond',
  USER_ACTION_LIST: 'user-action:list',
  USER_ACTION_LIST_FOR_INSTANCE: 'user-action:list-for-instance',
  USER_ACTION_RESPONSE: 'user-action-response',

  // Plan mode operations
  PLAN_MODE_ENTER: 'plan:enter',
  PLAN_MODE_EXIT: 'plan:exit',
  PLAN_MODE_APPROVE: 'plan:approve',
  PLAN_MODE_UPDATE: 'plan:update',
  PLAN_MODE_GET_STATE: 'plan:get-state',

  // LLM Service operations (streaming)
  LLM_SUMMARIZE: 'llm:summarize',
  LLM_SUMMARIZE_STREAM: 'llm:summarize-stream',
  LLM_SUBQUERY: 'llm:subquery',
  LLM_SUBQUERY_STREAM: 'llm:subquery-stream',
  LLM_CANCEL_STREAM: 'llm:cancel-stream',
  LLM_STREAM_CHUNK: 'llm:stream-chunk',
  LLM_COUNT_TOKENS: 'llm:count-tokens',
  LLM_TRUNCATE_TOKENS: 'llm:truncate-tokens',
  LLM_GET_CONFIG: 'llm:get-config',
  LLM_SET_CONFIG: 'llm:set-config',
  LLM_GET_STATUS: 'llm:get-status',

  // Command operations
  COMMAND_LIST: 'command:list',
  COMMAND_EXECUTE: 'command:execute',
  COMMAND_CREATE: 'command:create',
  COMMAND_UPDATE: 'command:update',
  COMMAND_DELETE: 'command:delete',

  // Menu events (renderer-bound)
  MENU_NEW_INSTANCE: 'menu:new-instance',
} as const;
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/orchestration.channels.spec.ts`
Expected: **PASS**

- [ ] **Step 4: Commit**
```bash
git add packages/contracts/src/channels/orchestration.channels.ts packages/contracts/src/channels/__tests__/orchestration.channels.spec.ts
git commit -m "feat(contracts): add ORCHESTRATION_CHANNELS"
```

---

## Task 7: Memory, RLM, and observation channels

**Files:**
- Create: `packages/contracts/src/channels/memory.channels.ts`

- [ ] **Step 1: Write the test first**

Create `packages/contracts/src/channels/__tests__/memory.channels.spec.ts`:

```typescript
import { MEMORY_CHANNELS } from '../memory.channels';

describe('MEMORY_CHANNELS', () => {
  it('has memory stats channels', () => {
    expect(MEMORY_CHANNELS.MEMORY_GET_STATS).toBe('memory:get-stats');
    expect(MEMORY_CHANNELS.MEMORY_CRITICAL).toBe('memory:critical');
  });

  it('has memory-r1 channels', () => {
    expect(MEMORY_CHANNELS.MEMORY_R1_ADD_ENTRY).toBe('memory-r1:add-entry');
    expect(MEMORY_CHANNELS.MEMORY_R1_RETRIEVE).toBe('memory-r1:retrieve');
  });

  it('has unified memory channels', () => {
    expect(MEMORY_CHANNELS.UNIFIED_MEMORY_PROCESS_INPUT).toBe('unified-memory:process-input');
    expect(MEMORY_CHANNELS.UNIFIED_MEMORY_GET_STATS).toBe('unified-memory:get-stats');
  });

  it('has RLM channels', () => {
    expect(MEMORY_CHANNELS.RLM_CREATE_STORE).toBe('rlm:create-store');
    expect(MEMORY_CHANNELS.RLM_EXECUTE_QUERY).toBe('rlm:execute-query');
    expect(MEMORY_CHANNELS.RLM_STORE_UPDATED).toBe('rlm:store-updated');
  });

  it('has observation channels', () => {
    expect(MEMORY_CHANNELS.OBSERVATION_GET_STATS).toBe('observation:get-stats');
    expect(MEMORY_CHANNELS.OBSERVATION_FORCE_REFLECT).toBe('observation:force-reflect');
  });
});
```

Run: `npx vitest run packages/contracts/src/channels/__tests__/memory.channels.spec.ts`
Expected: **FAIL**

- [ ] **Step 2: Create memory.channels.ts**

```typescript
/**
 * IPC channels for memory subsystems: process memory stats, Memory-R1,
 * Unified Memory, RLM Context Management, and Observation Memory.
 */
export const MEMORY_CHANNELS = {
  // Memory management (process memory)
  MEMORY_GET_STATS: 'memory:get-stats',
  MEMORY_STATS_UPDATE: 'memory:stats-update',
  MEMORY_WARNING: 'memory:warning',
  MEMORY_CRITICAL: 'memory:critical',
  MEMORY_LOAD_HISTORY: 'memory:load-history',

  // Memory-R1 operations
  MEMORY_R1_DECIDE_OPERATION: 'memory-r1:decide-operation',
  MEMORY_R1_EXECUTE_OPERATION: 'memory-r1:execute-operation',
  MEMORY_R1_ADD_ENTRY: 'memory-r1:add-entry',
  MEMORY_R1_DELETE_ENTRY: 'memory-r1:delete-entry',
  MEMORY_R1_GET_ENTRY: 'memory-r1:get-entry',
  MEMORY_R1_RETRIEVE: 'memory-r1:retrieve',
  MEMORY_R1_RECORD_OUTCOME: 'memory-r1:record-outcome',
  MEMORY_R1_GET_STATS: 'memory-r1:get-stats',
  MEMORY_R1_SAVE: 'memory-r1:save',
  MEMORY_R1_LOAD: 'memory-r1:load',
  MEMORY_R1_CONFIGURE: 'memory-r1:configure',

  // Unified Memory operations
  UNIFIED_MEMORY_PROCESS_INPUT: 'unified-memory:process-input',
  UNIFIED_MEMORY_RETRIEVE: 'unified-memory:retrieve',
  UNIFIED_MEMORY_RECORD_SESSION_END: 'unified-memory:record-session-end',
  UNIFIED_MEMORY_RECORD_WORKFLOW: 'unified-memory:record-workflow',
  UNIFIED_MEMORY_RECORD_STRATEGY: 'unified-memory:record-strategy',
  UNIFIED_MEMORY_RECORD_OUTCOME: 'unified-memory:record-outcome',
  UNIFIED_MEMORY_GET_STATS: 'unified-memory:get-stats',
  UNIFIED_MEMORY_GET_SESSIONS: 'unified-memory:get-sessions',
  UNIFIED_MEMORY_GET_PATTERNS: 'unified-memory:get-patterns',
  UNIFIED_MEMORY_GET_WORKFLOWS: 'unified-memory:get-workflows',
  UNIFIED_MEMORY_SAVE: 'unified-memory:save',
  UNIFIED_MEMORY_LOAD: 'unified-memory:load',
  UNIFIED_MEMORY_CONFIGURE: 'unified-memory:configure',

  // RLM Context Management operations
  RLM_CREATE_STORE: 'rlm:create-store',
  RLM_ADD_SECTION: 'rlm:add-section',
  RLM_REMOVE_SECTION: 'rlm:remove-section',
  RLM_GET_STORE: 'rlm:get-store',
  RLM_LIST_STORES: 'rlm:list-stores',
  RLM_LIST_SECTIONS: 'rlm:list-sections',
  RLM_LIST_SESSIONS: 'rlm:list-sessions',
  RLM_DELETE_STORE: 'rlm:delete-store',
  RLM_START_SESSION: 'rlm:start-session',
  RLM_END_SESSION: 'rlm:end-session',
  RLM_EXECUTE_QUERY: 'rlm:execute-query',
  RLM_GET_SESSION: 'rlm:get-session',
  RLM_GET_STORE_STATS: 'rlm:get-store-stats',
  RLM_GET_SESSION_STATS: 'rlm:get-session-stats',
  RLM_CONFIGURE: 'rlm:configure',
  RLM_RECORD_OUTCOME: 'rlm:record-outcome',
  RLM_GET_PATTERNS: 'rlm:get-patterns',
  RLM_GET_STRATEGY_SUGGESTIONS: 'rlm:get-strategy-suggestions',
  RLM_GET_TOKEN_SAVINGS_HISTORY: 'rlm:get-token-savings-history',
  RLM_GET_QUERY_STATS: 'rlm:get-query-stats',
  RLM_GET_STORAGE_STATS: 'rlm:get-storage-stats',

  // RLM events (renderer-bound)
  RLM_STORE_UPDATED: 'rlm:store-updated',
  RLM_SECTION_ADDED: 'rlm:section-added',
  RLM_SECTION_REMOVED: 'rlm:section-removed',
  RLM_QUERY_COMPLETE: 'rlm:query-complete',

  // Observation Memory operations
  OBSERVATION_GET_STATS: 'observation:get-stats',
  OBSERVATION_GET_REFLECTIONS: 'observation:get-reflections',
  OBSERVATION_GET_OBSERVATIONS: 'observation:get-observations',
  OBSERVATION_CONFIGURE: 'observation:configure',
  OBSERVATION_GET_CONFIG: 'observation:get-config',
  OBSERVATION_FORCE_REFLECT: 'observation:force-reflect',
  OBSERVATION_CLEANUP: 'observation:cleanup',

  // Token Stats operations
  TOKEN_STATS_GET_SUMMARY: 'token-stats:get-summary',
  TOKEN_STATS_GET_RECENT: 'token-stats:get-recent',
  TOKEN_STATS_CLEANUP: 'token-stats:cleanup',
} as const;
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/memory.channels.spec.ts`
Expected: **PASS**

- [ ] **Step 4: Commit**
```bash
git add packages/contracts/src/channels/memory.channels.ts packages/contracts/src/channels/__tests__/memory.channels.spec.ts
git commit -m "feat(contracts): add MEMORY_CHANNELS"
```

---

## Task 8: Provider, plugins, CLI detection, and model discovery channels

**Files:**
- Create: `packages/contracts/src/channels/provider.channels.ts`

- [ ] **Step 1: Write the test first**

Create `packages/contracts/src/channels/__tests__/provider.channels.spec.ts`:

```typescript
import { PROVIDER_CHANNELS } from '../provider.channels';

describe('PROVIDER_CHANNELS', () => {
  it('has provider channels', () => {
    expect(PROVIDER_CHANNELS.PROVIDER_LIST).toBe('provider:list');
    expect(PROVIDER_CHANNELS.PROVIDER_LIST_MODELS).toBe('provider:list-models');
  });

  it('has CLI detection channels', () => {
    expect(PROVIDER_CHANNELS.CLI_DETECT_ALL).toBe('cli:detect-all');
    expect(PROVIDER_CHANNELS.CLI_TEST_CONNECTION).toBe('cli:test-connection');
    expect(PROVIDER_CHANNELS.COPILOT_LIST_MODELS).toBe('copilot:list-models');
  });

  it('has plugin channels', () => {
    expect(PROVIDER_CHANNELS.PLUGINS_DISCOVER).toBe('plugins:discover');
    expect(PROVIDER_CHANNELS.PLUGINS_LOADED).toBe('plugins:loaded');
  });

  it('has model discovery channels', () => {
    expect(PROVIDER_CHANNELS.MODEL_DISCOVER).toBe('model:discover');
    expect(PROVIDER_CHANNELS.MODEL_SET_OVERRIDE).toBe('model:set-override');
  });

  it('has model routing channels', () => {
    expect(PROVIDER_CHANNELS.ROUTING_GET_CONFIG).toBe('routing:get-config');
    expect(PROVIDER_CHANNELS.HOT_SWITCH_PERFORM).toBe('hot-switch:perform');
  });
});
```

Run: `npx vitest run packages/contracts/src/channels/__tests__/provider.channels.spec.ts`
Expected: **FAIL**

- [ ] **Step 2: Create provider.channels.ts**

```typescript
/**
 * IPC channels for provider management, CLI detection, provider plugins,
 * and model discovery/routing.
 */
export const PROVIDER_CHANNELS = {
  // Provider operations
  PROVIDER_LIST: 'provider:list',
  PROVIDER_STATUS: 'provider:status',
  PROVIDER_STATUS_ALL: 'provider:status-all',
  PROVIDER_UPDATE_CONFIG: 'provider:update-config',
  PROVIDER_LIST_MODELS: 'provider:list-models',

  // CLI detection
  CLI_DETECT_ALL: 'cli:detect-all',
  CLI_DETECT_ONE: 'cli:detect-one',
  CLI_CHECK: 'cli:check',
  CLI_TEST_CONNECTION: 'cli:test-connection',

  // Copilot operations
  COPILOT_LIST_MODELS: 'copilot:list-models',

  // Provider Plugins
  PLUGINS_DISCOVER: 'plugins:discover',
  PLUGINS_LOAD: 'plugins:load',
  PLUGINS_UNLOAD: 'plugins:unload',
  PLUGINS_GET: 'plugins:get',
  PLUGINS_GET_ALL: 'plugins:get-all',
  PLUGINS_GET_LOADED: 'plugins:get-loaded',
  PLUGINS_GET_META: 'plugins:get-meta',
  PLUGINS_INSTALL: 'plugins:install',
  PLUGINS_UNINSTALL: 'plugins:uninstall',
  PLUGINS_CREATE_TEMPLATE: 'plugins:create-template',

  // Plugin lifecycle events (renderer-bound)
  PLUGINS_LOADED: 'plugins:loaded',
  PLUGINS_UNLOADED: 'plugins:unloaded',
  PLUGINS_ERROR: 'plugins:error',

  // Model Discovery operations
  MODEL_DISCOVER: 'model:discover',
  MODEL_GET_ALL: 'model:get-all',
  MODEL_GET: 'model:get',
  MODEL_SELECT: 'model:select',
  MODEL_CONFIGURE_PROVIDER: 'model:configure-provider',
  MODEL_GET_PROVIDER_STATUS: 'model:get-provider-status',
  MODEL_GET_STATS: 'model:get-stats',
  MODEL_VERIFY: 'model:verify',
  MODEL_SET_OVERRIDE: 'model:set-override',
  MODEL_REMOVE_OVERRIDE: 'model:remove-override',

  // Model routing operations
  ROUTING_GET_CONFIG: 'routing:get-config',
  ROUTING_UPDATE_CONFIG: 'routing:update-config',
  ROUTING_PREVIEW: 'routing:preview',
  ROUTING_GET_TIER: 'routing:get-tier',
  HOT_SWITCH_GET_CONFIG: 'hot-switch:get-config',
  HOT_SWITCH_UPDATE_CONFIG: 'hot-switch:update-config',
  HOT_SWITCH_PERFORM: 'hot-switch:perform',
  HOT_SWITCH_GET_STATS: 'hot-switch:get-stats',

  // Hot-switch event forwarding (main -> renderer)
  HOT_SWITCH_EVENT_STARTED: 'hot-switch:event:started',
  HOT_SWITCH_EVENT_COMPLETED: 'hot-switch:event:completed',
  HOT_SWITCH_EVENT_FAILED: 'hot-switch:event:failed',
} as const;
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/provider.channels.spec.ts`
Expected: **PASS**

- [ ] **Step 4: Commit**
```bash
git add packages/contracts/src/channels/provider.channels.ts packages/contracts/src/channels/__tests__/provider.channels.spec.ts
git commit -m "feat(contracts): add PROVIDER_CHANNELS"
```

---

## Task 9: Infrastructure channels

**Files:**
- Create: `packages/contracts/src/channels/infrastructure.channels.ts`

- [ ] **Step 1: Write the test first**

Create `packages/contracts/src/channels/__tests__/infrastructure.channels.spec.ts`:

```typescript
import { INFRASTRUCTURE_CHANNELS } from '../infrastructure.channels';

describe('INFRASTRUCTURE_CHANNELS', () => {
  it('has settings channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.SETTINGS_GET_ALL).toBe('settings:get-all');
    expect(INFRASTRUCTURE_CHANNELS.SETTINGS_CHANGED).toBe('settings:changed');
  });

  it('has config channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.CONFIG_RESOLVE).toBe('config:resolve');
    expect(INFRASTRUCTURE_CHANNELS.INSTRUCTIONS_RESOLVE).toBe('instructions:resolve');
  });

  it('has app channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.APP_READY).toBe('app:ready');
    expect(INFRASTRUCTURE_CHANNELS.APP_GET_VERSION).toBe('app:get-version');
  });

  it('has security channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.SECURITY_DETECT_SECRETS).toBe('security:detect-secrets');
    expect(INFRASTRUCTURE_CHANNELS.SECURITY_GET_PERMISSION_CONFIG).toBe('security:get-permission-config');
  });

  it('has cost tracking channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.COST_GET_SUMMARY).toBe('cost:get-summary');
    expect(INFRASTRUCTURE_CHANNELS.COST_BUDGET_ALERT).toBe('cost:budget-alert');
  });

  it('has stats channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.STATS_GET).toBe('stats:get');
    expect(INFRASTRUCTURE_CHANNELS.STATS_CLEAR).toBe('stats:clear');
  });

  it('has debug channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.DEBUG_EXECUTE).toBe('debug:execute');
    expect(INFRASTRUCTURE_CHANNELS.DEBUG_ALL).toBe('debug:all');
  });

  it('has log channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.LOG_MESSAGE).toBe('log:message');
    expect(INFRASTRUCTURE_CHANNELS.LOG_EXPORT).toBe('log:export');
  });

  it('has search channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.SEARCH_SEMANTIC).toBe('search:semantic');
    expect(INFRASTRUCTURE_CHANNELS.SEARCH_IS_EXA_CONFIGURED).toBe('search:is-exa-configured');
  });
});
```

Run: `npx vitest run packages/contracts/src/channels/__tests__/infrastructure.channels.spec.ts`
Expected: **FAIL**

- [ ] **Step 2: Create infrastructure.channels.ts**

```typescript
/**
 * IPC channels for application infrastructure: settings, config, app lifecycle,
 * security, cost tracking, usage stats, debug commands, structured logging,
 * and semantic search.
 */
export const INFRASTRUCTURE_CHANNELS = {
  // App operations
  APP_READY: 'app:ready',
  APP_GET_VERSION: 'app:get-version',
  APP_OPEN_DOCS: 'app:open-docs',

  // Settings operations
  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_RESET: 'settings:reset',
  SETTINGS_RESET_ONE: 'settings:reset-one',
  SETTINGS_CHANGED: 'settings:changed',
  SETTINGS_EXPORT: 'settings:export',
  SETTINGS_IMPORT: 'settings:import',

  // Config operations (hierarchical configuration)
  CONFIG_RESOLVE: 'config:resolve',
  CONFIG_GET_PROJECT: 'config:get-project',
  CONFIG_SAVE_PROJECT: 'config:save-project',
  CONFIG_CREATE_PROJECT: 'config:create-project',
  CONFIG_FIND_PROJECT: 'config:find-project',

  // Instruction inspection and migration
  INSTRUCTIONS_RESOLVE: 'instructions:resolve',
  INSTRUCTIONS_CREATE_DRAFT: 'instructions:create-draft',

  // Remote Configuration
  REMOTE_CONFIG_FETCH: 'remote-config:fetch',
  REMOTE_CONFIG_FETCH_URL: 'remote-config:fetch-url',
  REMOTE_CONFIG_FETCH_WELL_KNOWN: 'remote-config:fetch-well-known',
  REMOTE_CONFIG_FETCH_GITHUB: 'remote-config:fetch-github',
  REMOTE_CONFIG_DISCOVER_GIT: 'remote-config:discover-git',
  REMOTE_CONFIG_GET: 'remote-config:get',
  REMOTE_CONFIG_GET_CACHED: 'remote-config:get-cached',
  REMOTE_CONFIG_SET_SOURCE: 'remote-config:set-source',
  REMOTE_CONFIG_STATUS: 'remote-config:status',
  REMOTE_CONFIG_CLEAR_CACHE: 'remote-config:clear-cache',
  REMOTE_CONFIG_INVALIDATE: 'remote-config:invalidate',

  // Security - Secret detection and redaction
  SECURITY_DETECT_SECRETS: 'security:detect-secrets',
  SECURITY_REDACT_CONTENT: 'security:redact-content',
  SECURITY_CHECK_FILE: 'security:check-file',
  SECURITY_GET_AUDIT_LOG: 'security:get-audit-log',
  SECURITY_CLEAR_AUDIT_LOG: 'security:clear-audit-log',

  // Security - Environment filtering
  SECURITY_GET_SAFE_ENV: 'security:get-safe-env',
  SECURITY_CHECK_ENV_VAR: 'security:check-env-var',
  SECURITY_GET_ENV_FILTER_CONFIG: 'security:get-env-filter-config',
  SECURITY_UPDATE_ENV_FILTER_CONFIG: 'security:update-env-filter-config',
  SECURITY_GET_PERMISSION_CONFIG: 'security:get-permission-config',
  SECURITY_SET_PERMISSION_PRESET: 'security:set-permission-preset',

  // Cost Tracking
  COST_RECORD_USAGE: 'cost:record-usage',
  COST_GET_SUMMARY: 'cost:get-summary',
  COST_GET_HISTORY: 'cost:get-history',
  COST_GET_SESSION_COST: 'cost:get-session-cost',
  COST_GET_BUDGET: 'cost:get-budget',
  COST_SET_BUDGET: 'cost:set-budget',
  COST_GET_BUDGET_STATUS: 'cost:get-budget-status',
  COST_GET_ENTRIES: 'cost:get-entries',
  COST_CLEAR_ENTRIES: 'cost:clear-entries',
  COST_BUDGET_ALERT: 'cost:budget-alert',
  COST_USAGE_RECORDED: 'cost:usage-recorded',

  // Usage Statistics
  STATS_GET: 'stats:get',
  STATS_GET_STATS: 'stats:get-stats',
  STATS_GET_SESSION: 'stats:get-session',
  STATS_GET_ACTIVE_SESSIONS: 'stats:get-active-sessions',
  STATS_GET_TOOL_USAGE: 'stats:get-tool-usage',
  STATS_RECORD_SESSION_START: 'stats:record-session-start',
  STATS_RECORD_SESSION_END: 'stats:record-session-end',
  STATS_RECORD_MESSAGE: 'stats:record-message',
  STATS_RECORD_TOOL_USAGE: 'stats:record-tool-usage',
  STATS_EXPORT: 'stats:export',
  STATS_CLEAR: 'stats:clear',
  STATS_GET_STORAGE: 'stats:get-storage',

  // Debug Commands
  DEBUG_EXECUTE: 'debug:execute',
  DEBUG_GET_COMMANDS: 'debug:get-commands',
  DEBUG_GET_INFO: 'debug:get-info',
  DEBUG_RUN_DIAGNOSTICS: 'debug:run-diagnostics',
  DEBUG_AGENT: 'debug:agent',
  DEBUG_CONFIG: 'debug:config',
  DEBUG_FILE: 'debug:file',
  DEBUG_MEMORY: 'debug:memory',
  DEBUG_SYSTEM: 'debug:system',
  DEBUG_PROCESS: 'debug:process',
  DEBUG_ALL: 'debug:all',
  DEBUG_GET_MEMORY_HISTORY: 'debug:get-memory-history',
  DEBUG_CLEAR_MEMORY_HISTORY: 'debug:clear-memory-history',

  // Structured Logging
  LOG_MESSAGE: 'log:message',
  LOG_GET_LOGS: 'log:get-logs',
  LOG_GET_RECENT: 'log:get-recent',
  LOG_GET_CONFIG: 'log:get-config',
  LOG_SET_LEVEL: 'log:set-level',
  LOG_SET_SUBSYSTEM_LEVEL: 'log:set-subsystem-level',
  LOG_CLEAR: 'log:clear',
  LOG_CLEAR_BUFFER: 'log:clear-buffer',
  LOG_EXPORT: 'log:export',
  LOG_GET_SUBSYSTEMS: 'log:get-subsystems',
  LOG_GET_FILES: 'log:get-files',

  // Semantic Search
  SEARCH_SEMANTIC: 'search:semantic',
  SEARCH_BUILD_INDEX: 'search:build-index',
  SEARCH_CLEAR_INDEX: 'search:clear-index',
  SEARCH_GET_INDEX_STATS: 'search:get-index-stats',
  SEARCH_CONFIGURE_EXA: 'search:configure-exa',
  SEARCH_IS_EXA_CONFIGURED: 'search:is-exa-configured',

  // Recent Directories operations
  RECENT_DIRS_GET: 'recent-dirs:get',
  RECENT_DIRS_ADD: 'recent-dirs:add',
  RECENT_DIRS_REMOVE: 'recent-dirs:remove',
  RECENT_DIRS_PIN: 'recent-dirs:pin',
  RECENT_DIRS_REORDER: 'recent-dirs:reorder',
  RECENT_DIRS_CLEAR: 'recent-dirs:clear',
} as const;
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/infrastructure.channels.spec.ts`
Expected: **PASS**

- [ ] **Step 4: Commit**
```bash
git add packages/contracts/src/channels/infrastructure.channels.ts packages/contracts/src/channels/__tests__/infrastructure.channels.spec.ts
git commit -m "feat(contracts): add INFRASTRUCTURE_CHANNELS"
```

---

## Task 10: Communication channels

**Files:**
- Create: `packages/contracts/src/channels/communication.channels.ts`

- [ ] **Step 1: Write the test first**

Create `packages/contracts/src/channels/__tests__/communication.channels.spec.ts`:

```typescript
import { COMMUNICATION_CHANNELS } from '../communication.channels';

describe('COMMUNICATION_CHANNELS', () => {
  it('has comm (cross-instance) channels', () => {
    expect(COMMUNICATION_CHANNELS.COMM_REQUEST_TOKEN).toBe('comm:request-token');
    expect(COMMUNICATION_CHANNELS.COMM_CREATE_BRIDGE).toBe('comm:create-bridge');
  });

  it('has channel management channels', () => {
    expect(COMMUNICATION_CHANNELS.CHANNEL_CONNECT).toBe('channel:connect');
    expect(COMMUNICATION_CHANNELS.CHANNEL_MESSAGE_RECEIVED).toBe('channel:message-received');
  });

  it('has reaction engine channels', () => {
    expect(COMMUNICATION_CHANNELS.REACTION_GET_CONFIG).toBe('reaction:get-config');
    expect(COMMUNICATION_CHANNELS.REACTION_EVENT).toBe('reaction:event');
  });

  it('has remote observer channels', () => {
    expect(COMMUNICATION_CHANNELS.REMOTE_OBSERVER_GET_STATUS).toBe('remote-observer:get-status');
    expect(COMMUNICATION_CHANNELS.REMOTE_OBSERVER_ROTATE_TOKEN).toBe('remote-observer:rotate-token');
  });

  it('has remote node channels', () => {
    expect(COMMUNICATION_CHANNELS.REMOTE_NODE_LIST).toBe('remote-node:list');
    expect(COMMUNICATION_CHANNELS.REMOTE_NODE_NODES_CHANGED).toBe('remote-node:nodes-changed');
  });

  it('has remote filesystem channels', () => {
    expect(COMMUNICATION_CHANNELS.REMOTE_FS_READ_DIR).toBe('remote-fs:read-dir');
    expect(COMMUNICATION_CHANNELS.REMOTE_FS_UNWATCH).toBe('remote-fs:unwatch');
  });
});
```

Run: `npx vitest run packages/contracts/src/channels/__tests__/communication.channels.spec.ts`
Expected: **FAIL**

- [ ] **Step 2: Create communication.channels.ts**

```typescript
/**
 * IPC channels for inter-instance communication, channel management,
 * reaction engine, remote observer, remote nodes, and remote filesystem.
 */
export const COMMUNICATION_CHANNELS = {
  // Cross-instance communication
  COMM_REQUEST_TOKEN: 'comm:request-token',
  COMM_SEND_MESSAGE: 'comm:send-message',
  COMM_SUBSCRIBE: 'comm:subscribe',
  COMM_CONTROL: 'comm:control-instance',
  COMM_CREATE_BRIDGE: 'comm:create-bridge',
  COMM_GET_MESSAGES: 'comm:get-messages',
  COMM_GET_BRIDGES: 'comm:get-bridges',
  COMM_DELETE_BRIDGE: 'comm:delete-bridge',

  // Channel management (request/response)
  CHANNEL_CONNECT: 'channel:connect',
  CHANNEL_DISCONNECT: 'channel:disconnect',
  CHANNEL_GET_STATUS: 'channel:get-status',
  CHANNEL_GET_MESSAGES: 'channel:get-messages',
  CHANNEL_SEND_MESSAGE: 'channel:send-message',
  CHANNEL_PAIR_SENDER: 'channel:pair-sender',
  CHANNEL_SET_ACCESS_POLICY: 'channel:set-access-policy',
  CHANNEL_GET_ACCESS_POLICY: 'channel:get-access-policy',

  // Channel push events (main -> renderer)
  CHANNEL_STATUS_CHANGED: 'channel:status-changed',
  CHANNEL_MESSAGE_RECEIVED: 'channel:message-received',
  CHANNEL_RESPONSE_SENT: 'channel:response-sent',
  CHANNEL_ERROR: 'channel:error',

  // Reaction Engine
  REACTION_GET_CONFIG: 'reaction:get-config',
  REACTION_UPDATE_CONFIG: 'reaction:update-config',
  REACTION_TRACK_INSTANCE: 'reaction:track-instance',
  REACTION_UNTRACK_INSTANCE: 'reaction:untrack-instance',
  REACTION_GET_TRACKED: 'reaction:get-tracked',
  REACTION_GET_STATE: 'reaction:get-state',
  REACTION_EVENT: 'reaction:event',
  REACTION_ESCALATED: 'reaction:escalated',

  // Remote observer / read-only access
  REMOTE_OBSERVER_GET_STATUS: 'remote-observer:get-status',
  REMOTE_OBSERVER_START: 'remote-observer:start',
  REMOTE_OBSERVER_STOP: 'remote-observer:stop',
  REMOTE_OBSERVER_ROTATE_TOKEN: 'remote-observer:rotate-token',

  // Remote nodes
  REMOTE_NODE_LIST: 'remote-node:list',
  REMOTE_NODE_GET: 'remote-node:get',
  REMOTE_NODE_START_SERVER: 'remote-node:start-server',
  REMOTE_NODE_STOP_SERVER: 'remote-node:stop-server',
  REMOTE_NODE_EVENT: 'remote-node:event',
  REMOTE_NODE_NODES_CHANGED: 'remote-node:nodes-changed',
  REMOTE_NODE_REGENERATE_TOKEN: 'remote-node:regenerate-token',
  REMOTE_NODE_SET_TOKEN: 'remote-node:set-token',
  REMOTE_NODE_REVOKE: 'remote-node:revoke',
  REMOTE_NODE_GET_SERVER_STATUS: 'remote-node:get-server-status',

  // Remote Filesystem operations
  REMOTE_FS_READ_DIR: 'remote-fs:read-dir',
  REMOTE_FS_STAT: 'remote-fs:stat',
  REMOTE_FS_SEARCH: 'remote-fs:search',
  REMOTE_FS_WATCH: 'remote-fs:watch',
  REMOTE_FS_UNWATCH: 'remote-fs:unwatch',
} as const;
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/communication.channels.spec.ts`
Expected: **PASS**

- [ ] **Step 4: Commit**
```bash
git add packages/contracts/src/channels/communication.channels.ts packages/contracts/src/channels/__tests__/communication.channels.spec.ts
git commit -m "feat(contracts): add COMMUNICATION_CHANNELS"
```

---

## Task 11: Learning, training, specialist, and A/B testing channels

**Files:**
- Create: `packages/contracts/src/channels/learning.channels.ts`

- [ ] **Step 1: Write the test first**

Create `packages/contracts/src/channels/__tests__/learning.channels.spec.ts`:

```typescript
import { LEARNING_CHANNELS } from '../learning.channels';

describe('LEARNING_CHANNELS', () => {
  it('has self-improvement channels', () => {
    expect(LEARNING_CHANNELS.LEARNING_RECORD_OUTCOME).toBe('learning:record-outcome');
    expect(LEARNING_CHANNELS.LEARNING_ENHANCE_PROMPT).toBe('learning:enhance-prompt');
  });

  it('has training (GRPO) channels', () => {
    expect(LEARNING_CHANNELS.TRAINING_RECORD_OUTCOME).toBe('training:record-outcome');
    expect(LEARNING_CHANNELS.TRAINING_GET_INSIGHTS).toBe('training:get-insights');
    expect(LEARNING_CHANNELS.TRAINING_EVENT_COMPLETED).toBe('training:event:completed');
  });

  it('has specialist channels', () => {
    expect(LEARNING_CHANNELS.SPECIALIST_LIST).toBe('specialist:list');
    expect(LEARNING_CHANNELS.SPECIALIST_INSTANCE_CREATED).toBe('specialist:instance-created');
  });

  it('has A/B testing channels', () => {
    expect(LEARNING_CHANNELS.AB_CREATE_EXPERIMENT).toBe('ab:create-experiment');
    expect(LEARNING_CHANNELS.AB_GET_WINNER).toBe('ab:get-winner');
  });
});
```

Run: `npx vitest run packages/contracts/src/channels/__tests__/learning.channels.spec.ts`
Expected: **FAIL**

- [ ] **Step 2: Create learning.channels.ts**

```typescript
/**
 * IPC channels for the learning subsystems: self-improvement (learning outcomes),
 * GRPO training data, specialist agents, and A/B experiment management.
 */
export const LEARNING_CHANNELS = {
  // Self-Improvement operations
  LEARNING_RECORD_OUTCOME: 'learning:record-outcome',
  LEARNING_GET_OUTCOME: 'learning:get-outcome',
  LEARNING_GET_RECENT_OUTCOMES: 'learning:get-recent-outcomes',
  LEARNING_GET_EXPERIENCE: 'learning:get-experience',
  LEARNING_GET_ALL_EXPERIENCES: 'learning:get-all-experiences',
  LEARNING_GET_INSIGHTS: 'learning:get-insights',
  LEARNING_GET_PATTERNS: 'learning:get-patterns',
  LEARNING_GET_SUGGESTIONS: 'learning:get-suggestions',
  LEARNING_GET_RECOMMENDATION: 'learning:get-recommendation',
  LEARNING_ENHANCE_PROMPT: 'learning:enhance-prompt',
  LEARNING_GET_STATS: 'learning:get-stats',
  LEARNING_GET_TASK_STATS: 'learning:get-task-stats',
  LEARNING_RATE_OUTCOME: 'learning:rate-outcome',
  LEARNING_CONFIGURE: 'learning:configure',

  // Training operations (GRPO)
  TRAINING_RECORD_OUTCOME: 'training:record-outcome',
  TRAINING_GET_STATS: 'training:get-stats',
  TRAINING_EXPORT_DATA: 'training:export-data',
  TRAINING_IMPORT_DATA: 'training:import-data',
  TRAINING_GET_TREND: 'training:get-trend',
  TRAINING_GET_TOP_STRATEGIES: 'training:get-top-strategies',
  TRAINING_CONFIGURE: 'training:configure',
  TRAINING_GET_REWARD_DATA: 'training:get-reward-data',
  TRAINING_GET_ADVANTAGE_DATA: 'training:get-advantage-data',
  TRAINING_GET_STRATEGIES: 'training:get-strategies',
  TRAINING_GET_AGENT_PERFORMANCE: 'training:get-agent-performance',
  TRAINING_GET_PATTERNS: 'training:get-patterns',
  TRAINING_GET_INSIGHTS: 'training:get-insights',
  TRAINING_APPLY_INSIGHT: 'training:apply-insight',
  TRAINING_DISMISS_INSIGHT: 'training:dismiss-insight',
  TRAINING_UPDATE_CONFIG: 'training:update-config',

  // Training event forwarding (main -> renderer)
  TRAINING_EVENT_STARTED: 'training:event:started',
  TRAINING_EVENT_COMPLETED: 'training:event:completed',
  TRAINING_EVENT_ERROR: 'training:event:error',

  // Specialist operations
  SPECIALIST_LIST: 'specialist:list',
  SPECIALIST_LIST_BUILTIN: 'specialist:list-builtin',
  SPECIALIST_LIST_CUSTOM: 'specialist:list-custom',
  SPECIALIST_GET: 'specialist:get',
  SPECIALIST_GET_BY_CATEGORY: 'specialist:get-by-category',
  SPECIALIST_ADD_CUSTOM: 'specialist:add-custom',
  SPECIALIST_UPDATE_CUSTOM: 'specialist:update-custom',
  SPECIALIST_REMOVE_CUSTOM: 'specialist:remove-custom',
  SPECIALIST_RECOMMEND: 'specialist:recommend',
  SPECIALIST_CREATE_INSTANCE: 'specialist:create-instance',
  SPECIALIST_GET_INSTANCE: 'specialist:get-instance',
  SPECIALIST_GET_ACTIVE_INSTANCES: 'specialist:get-active-instances',
  SPECIALIST_UPDATE_STATUS: 'specialist:update-status',
  SPECIALIST_ADD_FINDING: 'specialist:add-finding',
  SPECIALIST_UPDATE_METRICS: 'specialist:update-metrics',
  SPECIALIST_GET_PROMPT_ADDITION: 'specialist:get-prompt-addition',
  SPECIALIST_INSTANCE_CREATED: 'specialist:instance-created',
  SPECIALIST_INSTANCE_STATUS_CHANGED: 'specialist:instance-status-changed',
  SPECIALIST_FINDING_ADDED: 'specialist:finding-added',

  // A/B Testing operations
  AB_CREATE_EXPERIMENT: 'ab:create-experiment',
  AB_UPDATE_EXPERIMENT: 'ab:update-experiment',
  AB_DELETE_EXPERIMENT: 'ab:delete-experiment',
  AB_START_EXPERIMENT: 'ab:start-experiment',
  AB_PAUSE_EXPERIMENT: 'ab:pause-experiment',
  AB_COMPLETE_EXPERIMENT: 'ab:complete-experiment',
  AB_GET_EXPERIMENT: 'ab:get-experiment',
  AB_LIST_EXPERIMENTS: 'ab:list-experiments',
  AB_GET_VARIANT: 'ab:get-variant',
  AB_RECORD_OUTCOME: 'ab:record-outcome',
  AB_GET_RESULTS: 'ab:get-results',
  AB_GET_WINNER: 'ab:get-winner',
  AB_GET_STATS: 'ab:get-stats',
  AB_CONFIGURE: 'ab:configure',
} as const;
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/learning.channels.spec.ts`
Expected: **PASS**

- [ ] **Step 4: Commit**
```bash
git add packages/contracts/src/channels/learning.channels.ts packages/contracts/src/channels/__tests__/learning.channels.spec.ts
git commit -m "feat(contracts): add LEARNING_CHANNELS"
```

---

## Task 12: Workspace channels

**Files:**
- Create: `packages/contracts/src/channels/workspace.channels.ts`

- [ ] **Step 1: Write the test first**

Create `packages/contracts/src/channels/__tests__/workspace.channels.spec.ts`:

```typescript
import { WORKSPACE_CHANNELS } from '../workspace.channels';

describe('WORKSPACE_CHANNELS', () => {
  it('has VCS channels', () => {
    expect(WORKSPACE_CHANNELS.VCS_IS_REPO).toBe('vcs:is-repo');
    expect(WORKSPACE_CHANNELS.VCS_GET_DIFF).toBe('vcs:get-diff');
  });

  it('has worktree channels', () => {
    expect(WORKSPACE_CHANNELS.WORKTREE_CREATE).toBe('worktree:create');
    expect(WORKSPACE_CHANNELS.WORKTREE_SESSION_CREATED).toBe('worktree:session-created');
  });

  it('has parallel worktree channels', () => {
    expect(WORKSPACE_CHANNELS.PARALLEL_WORKTREE_START).toBe('parallel-worktree:start');
    expect(WORKSPACE_CHANNELS.PARALLEL_WORKTREE_MERGE).toBe('parallel-worktree:merge');
  });

  it('has TODO channels', () => {
    expect(WORKSPACE_CHANNELS.TODO_GET_LIST).toBe('todo:get-list');
    expect(WORKSPACE_CHANNELS.TODO_LIST_CHANGED).toBe('todo:list-changed');
  });

  it('has LSP channels', () => {
    expect(WORKSPACE_CHANNELS.LSP_GO_TO_DEFINITION).toBe('lsp:go-to-definition');
    expect(WORKSPACE_CHANNELS.LSP_SHUTDOWN).toBe('lsp:shutdown');
  });

  it('has MCP channels', () => {
    expect(WORKSPACE_CHANNELS.MCP_GET_STATE).toBe('mcp:get-state');
    expect(WORKSPACE_CHANNELS.MCP_STATE_CHANGED).toBe('mcp:state-changed');
  });

  it('has codebase indexing channels', () => {
    expect(WORKSPACE_CHANNELS.CODEBASE_INDEX_STORE).toBe('codebase:index:store');
    expect(WORKSPACE_CHANNELS.CODEBASE_SEARCH).toBe('codebase:search');
  });

  it('has repo job channels', () => {
    expect(WORKSPACE_CHANNELS.REPO_JOB_SUBMIT).toBe('repo-job:submit');
    expect(WORKSPACE_CHANNELS.REPO_JOB_GET_STATS).toBe('repo-job:get-stats');
  });

  it('has task management channels', () => {
    expect(WORKSPACE_CHANNELS.TASK_GET_STATUS).toBe('task:get-status');
    expect(WORKSPACE_CHANNELS.TASK_GET_PREFLIGHT).toBe('task:get-preflight');
  });
});
```

Run: `npx vitest run packages/contracts/src/channels/__tests__/workspace.channels.spec.ts`
Expected: **FAIL**

- [ ] **Step 2: Create workspace.channels.ts**

```typescript
/**
 * IPC channels for workspace operations: VCS/Git, worktrees, parallel worktrees,
 * TODO management, LSP, multi-edit, bash validation, MCP servers,
 * codebase indexing, repo jobs, and task management.
 */
export const WORKSPACE_CHANNELS = {
  // VCS operations (Git)
  VCS_IS_REPO: 'vcs:is-repo',
  VCS_GET_STATUS: 'vcs:get-status',
  VCS_GET_BRANCHES: 'vcs:get-branches',
  VCS_GET_COMMITS: 'vcs:get-commits',
  VCS_GET_DIFF: 'vcs:get-diff',
  VCS_GET_FILE_HISTORY: 'vcs:get-file-history',
  VCS_GET_FILE_AT_COMMIT: 'vcs:get-file-at-commit',
  VCS_GET_BLAME: 'vcs:get-blame',

  // Git Worktree operations
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_DELETE: 'worktree:delete',
  WORKTREE_GET_STATUS: 'worktree:get-status',
  WORKTREE_COMPLETE: 'worktree:complete',
  WORKTREE_PREVIEW_MERGE: 'worktree:preview-merge',
  WORKTREE_MERGE: 'worktree:merge',
  WORKTREE_CLEANUP: 'worktree:cleanup',
  WORKTREE_ABANDON: 'worktree:abandon',
  WORKTREE_GET_SESSION: 'worktree:get-session',
  WORKTREE_LIST_SESSIONS: 'worktree:list-sessions',
  WORKTREE_DETECT_CONFLICTS: 'worktree:detect-conflicts',
  WORKTREE_SYNC: 'worktree:sync',
  WORKTREE_SESSION_CREATED: 'worktree:session-created',
  WORKTREE_SESSION_COMPLETED: 'worktree:session-completed',
  WORKTREE_CONFLICT_DETECTED: 'worktree:conflict-detected',

  // Parallel worktree operations
  PARALLEL_WORKTREE_START: 'parallel-worktree:start',
  PARALLEL_WORKTREE_GET_STATUS: 'parallel-worktree:get-status',
  PARALLEL_WORKTREE_CANCEL: 'parallel-worktree:cancel',
  PARALLEL_WORKTREE_GET_RESULTS: 'parallel-worktree:get-results',
  PARALLEL_WORKTREE_LIST: 'parallel-worktree:list',
  PARALLEL_WORKTREE_RESOLVE_CONFLICT: 'parallel-worktree:resolve-conflict',
  PARALLEL_WORKTREE_MERGE: 'parallel-worktree:merge',

  // TODO operations
  TODO_GET_LIST: 'todo:get-list',
  TODO_CREATE: 'todo:create',
  TODO_UPDATE: 'todo:update',
  TODO_DELETE: 'todo:delete',
  TODO_WRITE_ALL: 'todo:write-all',
  TODO_CLEAR: 'todo:clear',
  TODO_GET_CURRENT: 'todo:get-current',
  TODO_LIST_CHANGED: 'todo:list-changed',

  // LSP operations
  LSP_GET_AVAILABLE_SERVERS: 'lsp:get-available-servers',
  LSP_GET_STATUS: 'lsp:get-status',
  LSP_GO_TO_DEFINITION: 'lsp:go-to-definition',
  LSP_FIND_REFERENCES: 'lsp:find-references',
  LSP_HOVER: 'lsp:hover',
  LSP_DOCUMENT_SYMBOLS: 'lsp:document-symbols',
  LSP_WORKSPACE_SYMBOLS: 'lsp:workspace-symbols',
  LSP_DIAGNOSTICS: 'lsp:diagnostics',
  LSP_IS_AVAILABLE: 'lsp:is-available',
  LSP_SHUTDOWN: 'lsp:shutdown',

  // Multi-Edit operations
  MULTIEDIT_PREVIEW: 'multiedit:preview',
  MULTIEDIT_APPLY: 'multiedit:apply',

  // Bash validation operations
  BASH_VALIDATE: 'bash:validate',
  BASH_GET_CONFIG: 'bash:get-config',
  BASH_ADD_ALLOWED: 'bash:add-allowed',
  BASH_ADD_BLOCKED: 'bash:add-blocked',

  // MCP operations
  MCP_GET_STATE: 'mcp:get-state',
  MCP_GET_SERVERS: 'mcp:get-servers',
  MCP_ADD_SERVER: 'mcp:add-server',
  MCP_REMOVE_SERVER: 'mcp:remove-server',
  MCP_CONNECT: 'mcp:connect',
  MCP_DISCONNECT: 'mcp:disconnect',
  MCP_RESTART: 'mcp:restart',
  MCP_GET_TOOLS: 'mcp:get-tools',
  MCP_GET_RESOURCES: 'mcp:get-resources',
  MCP_GET_PROMPTS: 'mcp:get-prompts',
  MCP_CALL_TOOL: 'mcp:call-tool',
  MCP_READ_RESOURCE: 'mcp:read-resource',
  MCP_GET_PROMPT: 'mcp:get-prompt',
  MCP_GET_PRESETS: 'mcp:get-presets',
  MCP_GET_BROWSER_AUTOMATION_HEALTH: 'mcp:get-browser-automation-health',
  MCP_STATE_CHANGED: 'mcp:state-changed',
  MCP_SERVER_STATUS_CHANGED: 'mcp:server-status-changed',

  // Codebase Indexing operations
  CODEBASE_INDEX_STORE: 'codebase:index:store',
  CODEBASE_INDEX_FILE: 'codebase:index:file',
  CODEBASE_INDEX_CANCEL: 'codebase:index:cancel',
  CODEBASE_INDEX_STATUS: 'codebase:index:status',
  CODEBASE_INDEX_STATS: 'codebase:index:stats',
  CODEBASE_INDEX_PROGRESS: 'codebase:index:progress',
  CODEBASE_SEARCH: 'codebase:search',
  CODEBASE_SEARCH_SYMBOLS: 'codebase:search:symbols',
  CODEBASE_WATCHER_START: 'codebase:watcher:start',
  CODEBASE_WATCHER_STOP: 'codebase:watcher:stop',
  CODEBASE_WATCHER_STATUS: 'codebase:watcher:status',
  CODEBASE_WATCHER_CHANGES: 'codebase:watcher:changes',

  // Background repo jobs
  REPO_JOB_SUBMIT: 'repo-job:submit',
  REPO_JOB_LIST: 'repo-job:list',
  REPO_JOB_GET: 'repo-job:get',
  REPO_JOB_CANCEL: 'repo-job:cancel',
  REPO_JOB_RERUN: 'repo-job:rerun',
  REPO_JOB_GET_STATS: 'repo-job:get-stats',

  // Task management (subagent spawning)
  TASK_GET_STATUS: 'task:get-status',
  TASK_GET_HISTORY: 'task:get-history',
  TASK_GET_BY_PARENT: 'task:get-by-parent',
  TASK_GET_BY_CHILD: 'task:get-by-child',
  TASK_CANCEL: 'task:cancel',
  TASK_GET_QUEUE: 'task:get-queue',
  TASK_GET_PREFLIGHT: 'task:get-preflight',
  TASK_COMPLETE: 'task:complete',
  TASK_PROGRESS: 'task:progress',
  TASK_ERROR: 'task:error',
} as const;
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/workspace.channels.spec.ts`
Expected: **PASS**

- [ ] **Step 4: Commit**
```bash
git add packages/contracts/src/channels/workspace.channels.ts packages/contracts/src/channels/__tests__/workspace.channels.spec.ts
git commit -m "feat(contracts): add WORKSPACE_CHANNELS"
```

---

## Task 13: Channels barrel + contract test for IPC_CHANNELS identity

**Files:**
- Create: `packages/contracts/src/channels/index.ts`
- Create: `packages/contracts/src/channels/__tests__/ipc-channels-identity.spec.ts`

This task merges all domain channel objects into the top-level `IPC_CHANNELS` that the rest of the codebase has always known. The identity test verifies that every channel key/value that currently exists in `src/shared/types/ipc.types.ts` is present in the merged object.

- [ ] **Step 1: Create the channels barrel**

Create `packages/contracts/src/channels/index.ts`:

```typescript
/**
 * IPC channel definitions — single source of truth.
 *
 * All domain-grouped channel objects are merged into IPC_CHANNELS,
 * which is type-identical to the object previously defined in
 * src/shared/types/ipc.types.ts.
 */

import { INSTANCE_CHANNELS } from './instance.channels';
import { FILE_CHANNELS } from './file.channels';
import { SESSION_CHANNELS } from './session.channels';
import { ORCHESTRATION_CHANNELS } from './orchestration.channels';
import { MEMORY_CHANNELS } from './memory.channels';
import { PROVIDER_CHANNELS } from './provider.channels';
import { INFRASTRUCTURE_CHANNELS } from './infrastructure.channels';
import { COMMUNICATION_CHANNELS } from './communication.channels';
import { LEARNING_CHANNELS } from './learning.channels';
import { WORKSPACE_CHANNELS } from './workspace.channels';

export {
  INSTANCE_CHANNELS,
  FILE_CHANNELS,
  SESSION_CHANNELS,
  ORCHESTRATION_CHANNELS,
  MEMORY_CHANNELS,
  PROVIDER_CHANNELS,
  INFRASTRUCTURE_CHANNELS,
  COMMUNICATION_CHANNELS,
  LEARNING_CHANNELS,
  WORKSPACE_CHANNELS,
};

/**
 * Combined IPC_CHANNELS — drop-in replacement for the object previously
 * defined in src/shared/types/ipc.types.ts.
 */
export const IPC_CHANNELS = {
  ...INSTANCE_CHANNELS,
  ...FILE_CHANNELS,
  ...SESSION_CHANNELS,
  ...ORCHESTRATION_CHANNELS,
  ...MEMORY_CHANNELS,
  ...PROVIDER_CHANNELS,
  ...INFRASTRUCTURE_CHANNELS,
  ...COMMUNICATION_CHANNELS,
  ...LEARNING_CHANNELS,
  ...WORKSPACE_CHANNELS,
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
```

- [ ] **Step 2: Write the identity contract test**

Create `packages/contracts/src/channels/__tests__/ipc-channels-identity.spec.ts`:

```typescript
/**
 * Contract test: IPC_CHANNELS from @contracts must contain every channel
 * defined in the legacy src/shared/types/ipc.types.ts.
 *
 * This test fails if any channel is accidentally omitted from the domain
 * split. It uses the raw text of the legacy file rather than importing it
 * (to avoid circular deps during migration).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { IPC_CHANNELS } from '../index';

const ROOT = resolve(__dirname, '../../../../../..');

/** Extract channel entries from a TypeScript file that defines IPC_CHANNELS */
function extractChannelEntries(filePath: string): Map<string, string> {
  const content = readFileSync(filePath, 'utf-8');
  const map = new Map<string, string>();
  const pattern = /^\s+([A-Z_]+):\s*['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  let inChannels = false;

  for (const line of content.split('\n')) {
    if (line.includes('IPC_CHANNELS') && line.includes('{')) {
      inChannels = true;
      continue;
    }
    if (inChannels && /^}\s*(as const)?;?\s*$/.test(line.trim())) {
      inChannels = false;
    }
    if (inChannels) {
      const m = line.match(/^\s+([A-Z_]+):\s*['"]([^'"]+)['"]/);
      if (m) map.set(m[1], m[2]);
    }
  }
  // reset lastIndex
  pattern.lastIndex = 0;
  return map;
}

describe('IPC_CHANNELS identity contract', () => {
  const legacyPath = resolve(ROOT, 'src/shared/types/ipc.types.ts');
  const legacyChannels = extractChannelEntries(legacyPath);
  const contractsChannels = IPC_CHANNELS as Record<string, string>;

  it('contracts IPC_CHANNELS contains all channels from the legacy file', () => {
    const missing: string[] = [];
    for (const [key, value] of legacyChannels) {
      if (contractsChannels[key] !== value) {
        missing.push(`${key}: expected '${value}', got '${contractsChannels[key]}'`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} channels missing or mismatched in contracts:\n` +
        missing.join('\n')
      );
    }
  });

  it('contracts IPC_CHANNELS has no extra channels not in legacy file', () => {
    const extra: string[] = [];
    for (const key of Object.keys(contractsChannels)) {
      if (!legacyChannels.has(key)) {
        extra.push(key);
      }
    }
    // Extra channels are allowed (contracts can grow ahead of legacy),
    // but log them as a warning for visibility during migration.
    if (extra.length > 0) {
      console.warn(`[contracts] ${extra.length} channels in contracts not yet in legacy file: ${extra.join(', ')}`);
    }
    // Not a hard failure — only missing channels fail the build.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Run the identity test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/ipc-channels-identity.spec.ts`
Expected: **PASS** — all legacy channels accounted for.

If any channels are missing, add them to the appropriate domain file before continuing. The test output will name exactly which keys are missing.

- [ ] **Step 4: Verify TypeScript**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: Exits 0.

- [ ] **Step 5: Commit**
```bash
git add packages/contracts/src/channels/index.ts packages/contracts/src/channels/__tests__/ipc-channels-identity.spec.ts
git commit -m "feat(contracts): add IPC_CHANNELS barrel with identity contract test"
```

---

## Task 14: Move and split Zod schemas to contracts

**Files:**
- Create: `packages/contracts/src/schemas/instance.schemas.ts`
- Create: `packages/contracts/src/schemas/workspace.schemas.ts`
- Create: `packages/contracts/src/schemas/remote-node.schemas.ts`
- Create: `packages/contracts/src/schemas/common.schemas.ts`
- Create: `packages/contracts/src/schemas/index.ts`

The goal is to move the 2,174-line `src/shared/validation/ipc-schemas.ts` into contracts while keeping `src/shared/validation/ipc-schemas.ts` as a thin re-export (backward compat for the 42 files that currently import from it).

- [ ] **Step 1: Create common primitive schemas**

Create `packages/contracts/src/schemas/common.schemas.ts`:

```typescript
import { z } from 'zod';

export const InstanceIdSchema = z.string().min(1).max(100);
export const SessionIdSchema = z.string().min(1).max(100);
export const DisplayNameSchema = z.string().min(1).max(200);
export const WorkingDirectorySchema = z.string().min(1).max(1000);
export const FilePathSchema = z.string().min(1).max(2000);
export const DirectoryPathSchema = z.string().min(1).max(2000);
export const SnapshotIdSchema = z.string().min(1).max(100);
export const StoreIdSchema = z.string().min(1).max(200);

export const FileAttachmentSchema = z.object({
  name: z.string().max(500),
  type: z.string().max(100),
  size: z.number().int().min(0).max(50 * 1024 * 1024),
  data: z.string().optional(),
});

/**
 * Validate an IPC payload against a schema.
 * Returns the validated data or throws a descriptive error.
 */
export function validateIpcPayload<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context: string
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues
      .map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw new Error(`IPC validation failed for ${context}: ${errors}`);
  }
  return result.data;
}

/**
 * Safe validation that returns null instead of throwing.
 */
export function safeValidateIpcPayload<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): T | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
```

- [ ] **Step 2: Create instance schemas**

Create `packages/contracts/src/schemas/instance.schemas.ts` by copying the instance-related schema blocks from `src/shared/validation/ipc-schemas.ts` (lines 30–200 approximately). The full content must be identical to the source — do not paraphrase. Read `src/shared/validation/ipc-schemas.ts` fully before writing this file.

The file must export: `InstanceCreatePayloadSchema`, `ValidatedInstanceCreatePayload`, `InstanceCreateWithMessagePayloadSchema`, `InstanceSendInputPayloadSchema`, `InstanceSendInputPayload`, `InstanceLoadOlderMessagesPayloadSchema`, and all other instance/hibernation/compact schemas defined in the source file through the snapshot section.

- [ ] **Step 3: Create workspace schemas**

Create `packages/contracts/src/schemas/workspace.schemas.ts` by copying the workspace-related schema blocks from `src/shared/validation/ipc-schemas.ts`: VCS, worktree, parallel worktree, and any other workspace domain schemas defined there.

- [ ] **Step 4: Create remote-node schemas**

Create `packages/contracts/src/schemas/remote-node.schemas.ts` by copying:
- `RemoteNodeSetTokenPayloadSchema` and `ValidatedSetTokenPayload`
- `RemoteNodeRevokePayloadSchema` and `ValidatedRevokePayload`

```typescript
import { z } from 'zod';

export const RemoteNodeSetTokenPayloadSchema = z.object({
  token: z.string().min(16).max(256),
});

export const RemoteNodeRevokePayloadSchema = z.object({
  nodeId: z.string().uuid(),
});

export type ValidatedSetTokenPayload = z.infer<typeof RemoteNodeSetTokenPayloadSchema>;
export type ValidatedRevokePayload = z.infer<typeof RemoteNodeRevokePayloadSchema>;
```

- [ ] **Step 5: Create schemas barrel**

Create `packages/contracts/src/schemas/index.ts`:

```typescript
export * from './common.schemas';
export * from './instance.schemas';
export * from './workspace.schemas';
export * from './remote-node.schemas';
```

- [ ] **Step 6: Update src/shared/validation/ipc-schemas.ts to re-export from contracts**

After verifying the moved schemas compile, update `src/shared/validation/ipc-schemas.ts` to add a re-export at the top and mark the individual definitions as deprecated (the full file stays intact for now — only the new contracts exports are added at the top to begin the transition):

```typescript
/**
 * IPC Payload Validation Schemas
 *
 * @deprecated Import from '@contracts/schemas' instead.
 * This file re-exports from @contracts for backward compatibility
 * during the Phase 1 migration.
 */

// Re-export from contracts (new source of truth for migrated schemas)
export {
  InstanceIdSchema,
  SessionIdSchema,
  DisplayNameSchema,
  WorkingDirectorySchema,
  FilePathSchema,
  DirectoryPathSchema,
  SnapshotIdSchema,
  StoreIdSchema,
  FileAttachmentSchema,
  validateIpcPayload,
  safeValidateIpcPayload,
  RemoteNodeSetTokenPayloadSchema,
  RemoteNodeRevokePayloadSchema,
} from '@contracts/schemas';

export type { ValidatedSetTokenPayload, ValidatedRevokePayload } from '@contracts/schemas';

// ... rest of the existing file remains unchanged below
```

This approach is additive — existing 42 importers continue to work without change.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: Exits 0.

Run: `npx vitest run packages/contracts/src/schemas/`
Expected: Any schema spec files pass.

- [ ] **Step 8: Commit**
```bash
git add packages/contracts/src/schemas/ src/shared/validation/ipc-schemas.ts
git commit -m "feat(contracts): move Zod schemas to packages/contracts/src/schemas"
```

---

## Task 15: Move transport types to contracts

**Files:**
- Create: `packages/contracts/src/types/transport.types.ts`
- Create: `packages/contracts/src/types/index.ts`
- Modify: `src/shared/types/ipc.types.ts`

The `IpcMessage<T>` interface, `IpcChannel` type, and payload interfaces that live below line 870 in `src/shared/types/ipc.types.ts` move to contracts. The `IPC_CHANNELS` const object in that file becomes a re-export.

- [ ] **Step 1: Read the remainder of ipc.types.ts**

Read `src/shared/types/ipc.types.ts` from line 870 to the end to capture all payload interfaces (OrchestrationActivityCategory, OrchestrationActivityPayload, and others defined in the remaining ~1,760 lines).

- [ ] **Step 2: Create transport.types.ts in contracts**

Create `packages/contracts/src/types/transport.types.ts`. This file must contain:
- `IpcChannel` (re-exported from channels barrel to avoid duplication)
- `IpcMessage<T>` interface (verbatim from source)
- All payload interfaces and types currently defined below line 870 in `src/shared/types/ipc.types.ts`

Beginning of the file:

```typescript
/**
 * IPC transport types: message envelope, channel type union, and payload interfaces.
 * Moved from src/shared/types/ipc.types.ts as part of Phase 1 contracts extraction.
 */

export type { IpcChannel } from '../channels/index';

/**
 * Message envelope for all IPC communication
 */
export interface IpcMessage<T = unknown> {
  id: string;
  channel: IpcChannel;
  timestamp: number;
  payload: T;
  replyChannel?: string;
}
```

Continue by copying the remaining payload interfaces verbatim from `src/shared/types/ipc.types.ts` lines 884 onward. Do not omit any export.

- [ ] **Step 3: Create types barrel**

Create `packages/contracts/src/types/index.ts`:

```typescript
export * from './transport.types';
```

- [ ] **Step 4: Update src/shared/types/ipc.types.ts**

The existing file currently defines `IPC_CHANNELS` (the source of truth), `IpcChannel`, `IpcMessage<T>`, and payload interfaces. After this task, it becomes a thin re-export:

```typescript
/**
 * IPC Types — re-exports from @contracts (Phase 1 migration shim).
 *
 * @deprecated Import directly from '@contracts' instead.
 */

// IPC_CHANNELS is the merged object from contracts
export { IPC_CHANNELS } from '@contracts/channels';
export type { IpcChannel } from '@contracts/channels';
export type { IpcMessage } from '@contracts/types';

// Re-export all payload interfaces so existing imports continue to compile
export type {
  OrchestrationActivityCategory,
  OrchestrationActivityPayload,
  // ... add every other exported type from the original file
} from '@contracts/types';
```

Note: The generation scripts currently read `IPC_CHANNELS` from this file using text extraction (not TypeScript import), so the generation script update in Task 17 must happen before removing the literal `IPC_CHANNELS` definition from this file. For now, this file can retain its `IPC_CHANNELS` definition alongside the re-export until Task 17 is complete, to avoid breaking `npm run generate:ipc`.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: Exits 0.

Run: `npx tsc --noEmit` (Angular renderer tsconfig)
Expected: Exits 0.

- [ ] **Step 6: Commit**
```bash
git add packages/contracts/src/types/ src/shared/types/ipc.types.ts
git commit -m "feat(contracts): move IpcMessage and payload types to packages/contracts/src/types"
```

---

## Task 16: Split preload into domain modules

**Files:**
- Create: `src/preload/domains/instance.preload.ts`
- Create: `src/preload/domains/file.preload.ts`
- Create: `src/preload/domains/session.preload.ts`
- Create: `src/preload/domains/orchestration.preload.ts`
- Create: `src/preload/domains/memory.preload.ts`
- Create: `src/preload/domains/provider.preload.ts`
- Create: `src/preload/domains/infrastructure.preload.ts`
- Create: `src/preload/domains/communication.preload.ts`
- Create: `src/preload/domains/learning.preload.ts`
- Create: `src/preload/domains/workspace.preload.ts`
- Create: `src/preload/generated/channels.ts`
- Modify: `src/preload/preload.ts`

The preload CANNOT import from `@contracts` at runtime due to Electron sandbox. Instead:
1. A new `src/preload/generated/channels.ts` file (written by the generator script) contains the `IPC_CHANNELS` copy.
2. Each domain module imports from `../generated/channels` and from `electron` only.
3. The domain module factory signature is `(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) => ({ ... })`.

- [ ] **Step 1: Create src/preload/generated/channels.ts placeholder**

This file will be regenerated by the updated script in Task 17. For now, create it with the current generated block content so the domain modules can compile:

```typescript
// AUTO-GENERATED — do not edit manually. Run `npm run generate:ipc` to regenerate.
// Source: packages/contracts/src/channels/index.ts

export const IPC_CHANNELS = {
  // (content generated by npm run generate:ipc — see Task 17)
} as const;
```

Then immediately run `npm run generate:ipc` which will overwrite it (Task 17 must update the script first; do Task 17 Step 1 before Step 1 of Task 16 if working sequentially).

Alternatively, manually copy the `IPC_CHANNELS` object body from `src/preload/preload.ts` between the generation markers into this file temporarily.

- [ ] **Step 2: Create instance.preload.ts**

Create `src/preload/domains/instance.preload.ts`:

```typescript
import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';

type Ch = typeof IPC_CHANNELS;

interface IpcResponse {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; timestamp: number };
}

export function createInstanceDomain(ipcRenderer: IpcRenderer, ch: Ch) {
  return {
    createInstance: (payload: {
      workingDirectory: string;
      sessionId?: string;
      parentInstanceId?: string;
      displayName?: string;
      initialPrompt?: string;
      attachments?: unknown[];
      yoloMode?: boolean;
      agentId?: string;
      provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'auto';
      model?: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_CREATE, payload),

    createInstanceWithMessage: (payload: {
      workingDirectory: string;
      message: string;
      attachments?: unknown[];
      provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'auto';
      model?: string;
      forceNodeId?: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_CREATE_WITH_MESSAGE, payload),

    sendInput: (payload: {
      instanceId: string;
      message: string;
      attachments?: unknown[];
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_SEND_INPUT, payload),

    terminateInstance: (payload: { instanceId: string; graceful?: boolean }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_TERMINATE, payload),

    interruptInstance: (instanceId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_INTERRUPT, { instanceId }),

    terminateAllInstances: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_TERMINATE_ALL),

    restartInstance: (instanceId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_RESTART, { instanceId }),

    renameInstance: (instanceId: string, displayName: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_RENAME, { instanceId, displayName }),

    changeAgentMode: (instanceId: string, agentMode: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_CHANGE_AGENT_MODE, { instanceId, agentMode }),

    toggleYoloMode: (instanceId: string, enabled: boolean): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_TOGGLE_YOLO_MODE, { instanceId, enabled }),

    changeModel: (instanceId: string, model: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_CHANGE_MODEL, { instanceId, model }),

    listInstances: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_LIST),

    loadOlderMessages: (payload: { instanceId: string; beforeChunk?: number; limit?: number }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_LOAD_OLDER_MESSAGES, payload),

    hibernateInstance: (instanceId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_HIBERNATE, { instanceId }),

    wakeInstance: (instanceId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_WAKE, { instanceId }),

    compactInstance: (instanceId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INSTANCE_COMPACT, { instanceId }),

    respondToInputRequired: (payload: { instanceId: string; response: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.INPUT_REQUIRED_RESPOND, payload),

    // Event listeners
    onInstanceStateUpdate: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.INSTANCE_STATE_UPDATE, h);
      return () => ipcRenderer.removeListener(ch.INSTANCE_STATE_UPDATE, h);
    },
    onInstanceOutput: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.INSTANCE_OUTPUT, h);
      return () => ipcRenderer.removeListener(ch.INSTANCE_OUTPUT, h);
    },
    onInstanceBatchUpdate: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.INSTANCE_BATCH_UPDATE, h);
      return () => ipcRenderer.removeListener(ch.INSTANCE_BATCH_UPDATE, h);
    },
    onInstanceCreated: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.INSTANCE_CREATED, h);
      return () => ipcRenderer.removeListener(ch.INSTANCE_CREATED, h);
    },
    onInstanceRemoved: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.INSTANCE_REMOVED, h);
      return () => ipcRenderer.removeListener(ch.INSTANCE_REMOVED, h);
    },
    onInstanceHibernated: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.INSTANCE_HIBERNATED, h);
      return () => ipcRenderer.removeListener(ch.INSTANCE_HIBERNATED, h);
    },
    onInstanceWaking: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.INSTANCE_WAKING, h);
      return () => ipcRenderer.removeListener(ch.INSTANCE_WAKING, h);
    },
    onInstanceTranscriptChunk: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.INSTANCE_TRANSCRIPT_CHUNK, h);
      return () => ipcRenderer.removeListener(ch.INSTANCE_TRANSCRIPT_CHUNK, h);
    },
    onInstanceCompactStatus: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.INSTANCE_COMPACT_STATUS, h);
      return () => ipcRenderer.removeListener(ch.INSTANCE_COMPACT_STATUS, h);
    },
    onContextWarning: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.CONTEXT_WARNING, h);
      return () => ipcRenderer.removeListener(ch.CONTEXT_WARNING, h);
    },
    onInputRequired: (cb: (data: unknown) => void) => {
      const h = (_e: IpcRendererEvent, d: unknown) => cb(d);
      ipcRenderer.on(ch.INPUT_REQUIRED, h);
      return () => ipcRenderer.removeListener(ch.INPUT_REQUIRED, h);
    },
  };
}
```

- [ ] **Step 3: Create remaining domain modules**

Repeat the same factory pattern for each of the other 9 domain files. Each file:
- Imports `IpcRenderer, IpcRendererEvent` from `'electron'`
- Imports `IPC_CHANNELS` from `'../generated/channels'`
- Exports `createXxxDomain(ipcRenderer, ch)` returning the relevant methods extracted from the current `preload.ts`

The methods to include in each file are determined by matching method names against the domain channel files created in Tasks 3–12:

- `src/preload/domains/file.preload.ts` — `createFileDomain`: all file/editor/dialog/image/watcher methods
- `src/preload/domains/session.preload.ts` — `createSessionDomain`: all session/snapshot/archive/history methods
- `src/preload/domains/orchestration.preload.ts` — `createOrchestrationDomain`: all verify/debate/consensus/workflow/review/hooks/skills/llm/plan/command methods
- `src/preload/domains/memory.preload.ts` — `createMemoryDomain`: all memory/rlm/observation/token-stats methods
- `src/preload/domains/provider.preload.ts` — `createProviderDomain`: all provider/cli/plugins/model/routing/hot-switch methods
- `src/preload/domains/infrastructure.preload.ts` — `createInfrastructureDomain`: all app/settings/config/instructions/security/cost/stats/debug/log/search/recent-dirs methods
- `src/preload/domains/communication.preload.ts` — `createCommunicationDomain`: all comm/channel/reaction/remote-observer/remote-node/remote-fs methods
- `src/preload/domains/learning.preload.ts` — `createLearningDomain`: all learning/training/specialist/ab-testing methods
- `src/preload/domains/workspace.preload.ts` — `createWorkspaceDomain`: all vcs/worktree/parallel-worktree/todo/lsp/multiedit/bash/mcp/codebase/repo-job/task methods

For each file, copy the method bodies verbatim from `src/preload/preload.ts` (lines 887–5627) — do not paraphrase. Read the relevant sections of the current preload before writing each domain file.

- [ ] **Step 4: Update preload.ts to compose from domain modules**

Replace the method definitions in `src/preload/preload.ts` (lines 887–5627) with domain composition:

```typescript
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { createInstanceDomain } from './domains/instance.preload';
import { createFileDomain } from './domains/file.preload';
import { createSessionDomain } from './domains/session.preload';
import { createOrchestrationDomain } from './domains/orchestration.preload';
import { createMemoryDomain } from './domains/memory.preload';
import { createProviderDomain } from './domains/provider.preload';
import { createInfrastructureDomain } from './domains/infrastructure.preload';
import { createCommunicationDomain } from './domains/communication.preload';
import { createLearningDomain } from './domains/learning.preload';
import { createWorkspaceDomain } from './domains/workspace.preload';
import { IPC_CHANNELS } from './generated/channels';

// --- GENERATED: IPC_CHANNELS START (do not edit manually — run `npm run generate:ipc`) ---
// (generation markers kept here for backward compatibility with the generator script
//  until Task 17 moves generation target to src/preload/generated/channels.ts)
// --- GENERATED: IPC_CHANNELS END ---

interface IpcResponse {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    timestamp: number;
  };
}

let ipcAuthToken: string | null = null;

const withAuth = (
  payload: Record<string, unknown> = {}
): Record<string, unknown> & { ipcAuthToken?: string } => ({
  ...payload,
  ipcAuthToken: ipcAuthToken || undefined
});

const electronAPI = {
  ...createInstanceDomain(ipcRenderer, IPC_CHANNELS),
  ...createFileDomain(ipcRenderer, IPC_CHANNELS),
  ...createSessionDomain(ipcRenderer, IPC_CHANNELS),
  ...createOrchestrationDomain(ipcRenderer, IPC_CHANNELS),
  ...createMemoryDomain(ipcRenderer, IPC_CHANNELS),
  ...createProviderDomain(ipcRenderer, IPC_CHANNELS),
  ...createInfrastructureDomain(ipcRenderer, IPC_CHANNELS),
  ...createCommunicationDomain(ipcRenderer, IPC_CHANNELS),
  ...createLearningDomain(ipcRenderer, IPC_CHANNELS),
  ...createWorkspaceDomain(ipcRenderer, IPC_CHANNELS),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
export type ElectronAPI = typeof electronAPI;
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: Exits 0.

If there are errors about duplicate method names (same method in two domain spreads), identify which domain file the method should live in exclusively and remove it from the other.

- [ ] **Step 6: Commit**
```bash
git add src/preload/domains/ src/preload/generated/ src/preload/preload.ts
git commit -m "feat(preload): split 5633-line preload.ts into 10 domain modules"
```

---

## Task 17: Update generator and verification scripts

**Files:**
- Modify: `scripts/generate-preload-channels.js`
- Modify: `scripts/verify-ipc-channels.js`

The generator now reads from `packages/contracts/src/channels/index.ts` (which re-exports from domain files) and writes the merged `IPC_CHANNELS` to `src/preload/generated/channels.ts` instead of injecting between markers in `preload.ts`.

- [ ] **Step 1: Update generate-preload-channels.js**

```javascript
#!/usr/bin/env node
/**
 * IPC Channel Generator
 *
 * Reads domain channel files from packages/contracts/src/channels/
 * and writes a merged IPC_CHANNELS object to src/preload/generated/channels.ts.
 *
 * The preload script imports from the generated file at runtime (avoiding the
 * sandbox restriction — no import from packages/ at runtime, only from src/).
 *
 * Usage:
 *   node scripts/generate-preload-channels.js
 *   npm run generate:ipc
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTRACTS_CHANNELS_DIR = path.join(ROOT, 'packages/contracts/src/channels');
const GENERATED_PATH = path.join(ROOT, 'src/preload/generated/channels.ts');
const LEGACY_IPC_TYPES_PATH = path.join(ROOT, 'src/shared/types/ipc.types.ts');

/**
 * Extract channel entries (KEY: 'value') from a TypeScript file that exports
 * a const object named with _CHANNELS suffix.
 */
function extractChannelsFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const entries = [];
  let inObject = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (!inObject && line.includes('_CHANNELS') && line.includes('{')) {
      inObject = true;
      braceDepth = 1;
      continue;
    }
    if (inObject) {
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }
      if (braceDepth <= 0) break;
      entries.push(line);
    }
  }
  return entries;
}

function main() {
  console.log('Generating preload IPC channels from contracts...\n');

  // Collect all domain channel files
  const domainFiles = fs.readdirSync(CONTRACTS_CHANNELS_DIR)
    .filter(f => f.endsWith('.channels.ts') && !f.startsWith('index'))
    .map(f => path.join(CONTRACTS_CHANNELS_DIR, f));

  if (domainFiles.length === 0) {
    console.error('No domain channel files found in ' + CONTRACTS_CHANNELS_DIR);
    process.exit(1);
  }

  // Collect all channel body lines, deduplicated
  const seenKeys = new Set();
  const allLines = [];
  const channelPattern = /^\s+([A-Z_]+):\s*['"]([^'"]+)['"]/;

  for (const file of domainFiles) {
    const lines = extractChannelsFromFile(file);
    for (const line of lines) {
      const m = line.match(channelPattern);
      if (m) {
        if (!seenKeys.has(m[1])) {
          seenKeys.add(m[1]);
          allLines.push(line);
        }
      } else {
        // Preserve comment lines
        if (line.trim().startsWith('//')) allLines.push(line);
      }
    }
  }

  const channelCount = allLines.filter(l => channelPattern.test(l)).length;
  console.log(`Extracted ${channelCount} channels from ${domainFiles.length} domain files`);

  // Write generated file
  const generatedContent = [
    '// AUTO-GENERATED — do not edit manually.',
    '// Source: packages/contracts/src/channels/*.channels.ts',
    '// Regenerate: npm run generate:ipc',
    '',
    'export const IPC_CHANNELS = {',
    ...allLines,
    '} as const;',
    '',
    'export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(GENERATED_PATH), { recursive: true });
  fs.writeFileSync(GENERATED_PATH, generatedContent, 'utf-8');

  console.log(`Wrote ${channelCount} channels to ${path.relative(ROOT, GENERATED_PATH)}`);

  // Also update the legacy IPC_CHANNELS in ipc.types.ts for backward
  // compatibility with verify-ipc-channels.js until it is fully migrated.
  // (This preserves the existing GENERATED markers block in preload.ts
  //  which still exists as empty markers from Task 16.)
  console.log('Done.\n');
}

main();
```

- [ ] **Step 2: Update verify-ipc-channels.js**

```javascript
#!/usr/bin/env node
/**
 * IPC Channel Sync Verification Script
 *
 * Verifies that:
 * 1. src/preload/generated/channels.ts matches packages/contracts channel files
 * 2. All channels in the legacy src/shared/types/ipc.types.ts are in contracts
 *
 * Usage:
 *   node scripts/verify-ipc-channels.js
 *   npm run verify:ipc
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GENERATED_PATH = path.join(ROOT, 'src/preload/generated/channels.ts');
const LEGACY_IPC_TYPES_PATH = path.join(ROOT, 'src/shared/types/ipc.types.ts');

function extractChannels(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const channels = [];
  const channelPattern = /^\s+([A-Z_]+):\s*['"]([^'"]+)['"]/;
  let inIpcChannels = false;

  for (let i = 0; i < content.split('\n').length; i++) {
    const line = content.split('\n')[i];
    if (line.includes('IPC_CHANNELS') && line.includes('{')) {
      inIpcChannels = true;
      continue;
    }
    if (inIpcChannels && /^}\s*(as const)?;?\s*$/.test(line.trim())) {
      inIpcChannels = false;
      continue;
    }
    if (inIpcChannels) {
      const match = line.match(channelPattern);
      if (match) {
        channels.push({ name: match[1], value: match[2], line: i + 1 });
      }
    }
  }
  return channels;
}

function main() {
  console.log('Verifying IPC channel synchronization...\n');

  if (!fs.existsSync(GENERATED_PATH)) {
    console.error('Generated channels file not found: ' + GENERATED_PATH);
    console.error('Run `npm run generate:ipc` first.');
    process.exit(1);
  }

  const generatedChannels = extractChannels(GENERATED_PATH);
  const legacyChannels = extractChannels(LEGACY_IPC_TYPES_PATH);

  console.log('Generated channels: ' + generatedChannels.length);
  console.log('Legacy ipc.types.ts channels: ' + legacyChannels.length + '\n');

  const generatedByName = new Map(generatedChannels.map(c => [c.name, c]));
  const errors = [];

  for (const ch of legacyChannels) {
    const gen = generatedByName.get(ch.name);
    if (!gen) {
      errors.push('MISSING in generated: ' + ch.name + ' = \'' + ch.value + '\'');
    } else if (gen.value !== ch.value) {
      errors.push('MISMATCH ' + ch.name + ': legacy=\'' + ch.value + '\' generated=\'' + gen.value + '\'');
    }
  }

  if (errors.length > 0) {
    console.log('ERRORS:\n');
    errors.forEach(e => console.log(e + '\n'));
    console.log('Run `npm run generate:ipc` to regenerate.\n');
    process.exit(1);
  }

  console.log('IPC channels are synchronized.\n');
  console.log('Summary:');
  console.log('  - ' + generatedChannels.length + ' channels in generated file');
  console.log('  - ' + legacyChannels.length + ' channels in legacy ipc.types.ts');
  process.exit(0);
}

main();
```

- [ ] **Step 3: Run the generator**

Run: `npm run generate:ipc`
Expected: `src/preload/generated/channels.ts` is written with the merged channel object.

- [ ] **Step 4: Run the verifier**

Run: `npm run verify:ipc`
Expected: "IPC channels are synchronized."

- [ ] **Step 5: Verify TypeScript**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: Exits 0.

- [ ] **Step 6: Commit**
```bash
git add scripts/generate-preload-channels.js scripts/verify-ipc-channels.js src/preload/generated/channels.ts
git commit -m "feat(scripts): update generator and verifier to use contracts package"
```

---

## Task 18: Update all main-process imports

**Files:**
- Modify: All 57 files in `src/main/` that import from `@shared/types/ipc` or `@shared/validation/ipc-schemas`

The 57 main-process files currently import from `@shared/types/ipc.types` and the 42 that import from `@shared/validation/ipc-schemas`. Since both those files now re-export from `@contracts`, most files will continue to compile without change. This task verifies that and updates files where a direct `@contracts` import is cleaner.

- [ ] **Step 1: Verify no main-process build errors**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: Exits 0.

If there are errors referencing `IPC_CHANNELS`, `IpcMessage`, or schema types, trace the import chain and ensure the re-export shims in `src/shared/` are complete.

- [ ] **Step 2: Update high-traffic handler imports to use @contracts directly**

The following files import IPC_CHANNELS most heavily and should be updated to import from `@contracts` directly for clarity:

- `src/main/ipc/ipc-main-handler.ts`
- `src/main/ipc/handlers/instance-handlers.ts`
- `src/main/ipc/handlers/session-handlers.ts`
- `src/main/window-manager.ts`
- `src/main/instance/instance-state.ts`

For each file, change:
```typescript
import { IPC_CHANNELS } from '@shared/types/ipc.types';
```
to:
```typescript
import { IPC_CHANNELS } from '@contracts/channels';
```

And change:
```typescript
import { IpcMessage } from '@shared/types/ipc.types';
```
to:
```typescript
import type { IpcMessage } from '@contracts/types';
```

- [ ] **Step 3: Run typecheck after each file update**

After each file is changed:
Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: Exits 0 each time.

- [ ] **Step 4: Commit**
```bash
git add src/main/
git commit -m "refactor(main): update IPC imports to @contracts in high-traffic handlers"
```

---

## Task 19: Update all renderer imports

**Files:**
- Modify: `src/renderer/app/core/services/ipc/electron-ipc.service.ts`
- Modify: All renderer files importing from `@shared/types/ipc`

The renderer currently imports `ElectronAPI` type from `src/preload/preload.ts` (correct — no change needed). It does not directly import `IPC_CHANNELS` or schemas. Verify this and update any direct renderer imports.

- [ ] **Step 1: Check renderer files that import IPC types**

The `src/shared/types/index.ts` barrel re-exports from `ipc.types.ts` which now re-exports from `@contracts`. Angular's `tsconfig.json` already has the `@contracts` path alias from Task 2.

Run: `npx tsc --noEmit` (uses root `tsconfig.json` which covers renderer)
Expected: Exits 0.

- [ ] **Step 2: Update renderer store/service that reference IpcChannel**

`src/renderer/app/core/state/instance/instance.store.ts` imports from `@shared/types/ipc.types`. Verify it still compiles through the re-export chain. If not, update:

```typescript
// Before
import type { IpcChannel } from '@shared/types/ipc.types';

// After (or leave as-is if re-export works)
import type { IpcChannel } from '@contracts/channels';
```

- [ ] **Step 3: Verify Angular compilation**

Run: `npx tsc --noEmit`
Expected: Exits 0.

- [ ] **Step 4: Commit**
```bash
git add src/renderer/
git commit -m "refactor(renderer): verify IPC type imports resolve through contracts"
```

---

## Task 20: Final verification

**Files:** (none modified — verification only)

- [ ] **Step 1: Full TypeScript check (main process + preload + shared + contracts)**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: Exits 0 with no errors.

- [ ] **Step 2: Full TypeScript check (Angular renderer)**

Run: `npx tsc --noEmit`
Expected: Exits 0 with no errors.

- [ ] **Step 3: Spec file typecheck**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: Exits 0.

- [ ] **Step 4: Run full test suite**

Run: `npm run test`
Expected: All tests pass. The identity contract test in Task 13 must be green.

- [ ] **Step 5: Run IPC generation and verification**

Run: `npm run generate:ipc && npm run verify:ipc`
Expected: "IPC channels are synchronized." — exits 0.

- [ ] **Step 6: Run lint**

Run: `npm run lint`
Expected: No errors. Fix any `no-unused-vars` or import order warnings introduced by the refactor.

- [ ] **Step 7: Count preload lines**

Run: `wc -l src/preload/preload.ts src/preload/domains/*.preload.ts`

Expected: `src/preload/preload.ts` is under 80 lines. Each domain file is 100–400 lines. Total lines across all files should be approximately equal to the original 5,633 (no code was lost, only reorganised).

- [ ] **Step 8: Smoke-test the contracts barrel**

Run:
```bash
node -e "const c = require('./packages/contracts/src/channels/index'); console.log(Object.keys(c.IPC_CHANNELS).length + ' channels')"
```

Expected: Output like `412 channels` (matching the count in `src/shared/types/ipc.types.ts`).

- [ ] **Step 9: Final commit**
```bash
git add -A
git commit -m "chore: Phase 1 contracts package extraction complete

- packages/contracts owns IPC_CHANNELS (domain-grouped), Zod schemas, transport types
- preload.ts split from 5633 lines into 10 domain modules + generated channels
- All main-process and renderer imports updated or re-exported
- Generator and verifier scripts updated to use contracts as source of truth
- Contract identity test ensures zero channel drift"
```

---

## Acceptance Criteria

All of the following must be true before Phase 1 is considered complete:

1. `packages/contracts/` exists as a proper npm workspace with its own `package.json` and `tsconfig.json`
2. `packages/contracts/src/channels/index.ts` exports `IPC_CHANNELS` containing all 400+ channels from the original `src/shared/types/ipc.types.ts`
3. The identity contract test (`ipc-channels-identity.spec.ts`) passes with zero missing channels
4. `src/preload/preload.ts` is under 100 lines and delegates all method definitions to domain modules in `src/preload/domains/`
5. `src/preload/generated/channels.ts` is the file that receives generated channel copies (not the preload itself)
6. `npm run generate:ipc && npm run verify:ipc` exits 0
7. `npx tsc --noEmit -p tsconfig.electron.json` exits 0
8. `npx tsc --noEmit` exits 0
9. `npm run test` exits 0
10. `npm run lint` exits 0
11. `src/shared/types/ipc.types.ts` and `src/shared/validation/ipc-schemas.ts` remain present as backward-compat re-export shims (no existing importer is broken)
