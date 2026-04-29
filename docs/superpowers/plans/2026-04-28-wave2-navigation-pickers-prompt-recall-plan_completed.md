# Wave 2: Navigation, Pickers, & Prompt Recall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Cmd/Ctrl+1..9 numeric instance switching, persistent per-instance / per-project prompt history with safe Up/Down recall, session and model pickers on top of Wave 1's overlay shell, and a 250 ms debounce on the project-rail filter — without regressing any Wave 1 behaviour.

**Architecture:** Mirror Wave 1's hybrid storage pattern — `PromptHistoryService` is the main-process source of truth (electron-store), `PromptHistoryStore` is the renderer write-through cache. Add a renderer-only `VisibleInstanceResolver` that consumes `InstanceListComponent.projectGroups` to expose a flat ordered array of visible instance IDs. New session and model pickers are `OverlayController<T>` implementations that plug into Wave 1's `OverlayShellComponent` exactly the way `CommandPaletteController` does. Extract prompt-history schemas into `@contracts/schemas/prompt-history`, with the four-place alias sync (`tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, `vitest.config.ts`) called out per the project's packaging gotcha #1.

**Tech Stack:** TypeScript 5.9, Angular 21 (zoneless, signals), Electron 40, `electron-store`, Vitest, Zod 4, ESLint.

**Spec:** [`docs/superpowers/specs/2026-04-28-wave2-navigation-pickers-prompt-recall-design_completed.md`](../specs/2026-04-28-wave2-navigation-pickers-prompt-recall-design_completed.md)
**Wave 1 design (depended on):** [`docs/superpowers/specs/2026-04-28-wave1-command-registry-and-overlay-design_completed.md`](../specs/2026-04-28-wave1-command-registry-and-overlay-design_completed.md)
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md`](../specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md`](./2026-04-28-cross-repo-usability-upgrades-plan_completed.md)

---

## How to read this plan

- **Phases** group related tasks. Phases 1–4 are pure types / IPC plumbing with no UI dependency. Phases 5–8 add the renderer-side stores, services, and keybinding wiring. Phases 9–12 deliver UI (recall, session picker, model picker, optional reverse-search). Phase 13 is final integration and the packaged-DMG smoke test.
- **Tasks** are bite-sized work units (target ≤ 30 minutes). Each ends with a commit.
- **TDD discipline:** behavioral code follows test → fail → implement → pass → commit. Pure type-only changes use type-check as the verification.
- **Verification commands** (run after every code-change task):
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - Targeted vitest spec(s) for the touched code
- **Wave 1 is a prerequisite.** This plan assumes the Wave 1 contracts (`OverlayShellComponent`, `OverlayController<T>`, `UsageTracker`/`UsageStore`, `evaluateApplicability`) are landed and stable. If any are still in flight, complete them first.
- **Critical rule (per `AGENTS.md`):** **NEVER run `git commit` without explicit user approval.** Every task below ends with a suggested commit message — run the commit only after the user approves. If operating under subagent-driven-development, surface the suggested message to the user before committing. **Never push to remote** under any circumstances; pushing is always the user's call.

## Phase index

1. Phase 1 — Shared types and constants (`prompt-history.types.ts`, keybinding action additions)
2. Phase 2 — Zod schemas + `@contracts/schemas/prompt-history` extraction + 4-place alias sync
3. Phase 3 — Main-process `PromptHistoryService` (TDD: store wrapper → service singleton)
4. Phase 4 — IPC handlers + preload exposure
5. Phase 5 — Renderer `PromptHistoryStore` (write-through cache)
6. Phase 6 — `VisibleInstanceResolver` service (renderer)
7. Phase 7 — Keybinding action additions + `ActionDispatchService` wiring (numeric hotkeys, picker hotkeys)
8. Phase 8 — Instance-list filter debounce + resolver integration
9. Phase 9 — Input-panel Up/Down/Ctrl+R recall with stash/restore
10. Phase 10 — `SessionPickerController` + host
11. Phase 11 — `ModelPickerController` + host
12. Phase 12 — *Optional / gated:* `PromptHistorySearchController` + host (Ctrl+R modal)
13. Phase 13 — Final compile/lint/test gate, manual UI verification, packaged DMG smoke

---

## Phase 1 — Shared types and constants

These are pure-type and pure-constant additions. After this phase, the new types compile but nothing consumes them yet.

### Task 1.1: Add `prompt-history.types.ts` shared types

**Files:**
- Create: `src/shared/types/prompt-history.types.ts`
- Create: `src/shared/types/__tests__/prompt-history.types.spec.ts`

- [ ] **Step 1: Write the failing test (constants & helpers only — no behavior to test yet)**

Create `src/shared/types/__tests__/prompt-history.types.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  PROMPT_HISTORY_MAX,
  createPromptHistoryEntryId,
  type PromptHistoryEntry,
  type PromptHistoryRecord,
} from '../prompt-history.types';

describe('prompt-history.types', () => {
  it('caps at 100 entries by default', () => {
    expect(PROMPT_HISTORY_MAX).toBe(100);
  });

  it('createPromptHistoryEntryId returns unique non-empty ids', () => {
    const a = createPromptHistoryEntryId();
    const b = createPromptHistoryEntryId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('PromptHistoryEntry shape compiles', () => {
    const e: PromptHistoryEntry = {
      id: 'x', text: 'hi', createdAt: Date.now(),
    };
    expect(e.id).toBe('x');
  });

  it('PromptHistoryRecord shape compiles', () => {
    const r: PromptHistoryRecord = {
      instanceId: 'inst-1',
      entries: [],
      updatedAt: Date.now(),
    };
    expect(r.entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/shared/types/__tests__/prompt-history.types.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the types module**

Create `src/shared/types/prompt-history.types.ts`:

```ts
/**
 * Prompt History types — Wave 2.
 *
 * Per-instance prompt list with per-project alias index. Source of truth lives
 * in main process (electron-store via PromptHistoryService); renderer keeps a
 * write-through cache via PromptHistoryStore.
 */

/** Default cap on entries per instance. Pruned on app start and on every record(). */
export const PROMPT_HISTORY_MAX = 100;

/** Stash slot key prefix used by DraftService when recall begins. */
export const PROMPT_HISTORY_STASH_KEY_PREFIX = '__recall_stash__:';

export interface PromptHistoryEntry {
  /** Stable ID — UUIDv4 generated client-side. */
  id: string;
  /** The full prompt text the user sent. */
  text: string;
  /** ms epoch. */
  createdAt: number;
  /** Working directory at send time, if known. */
  projectPath?: string;
  /** Provider at send time. */
  provider?: string;
  /** Model at send time. */
  model?: string;
  /** True if the prompt began with `/`. */
  wasSlashCommand?: boolean;
}

export interface PromptHistoryRecord {
  instanceId: string;
  /** Most-recent first (LIFO). */
  entries: PromptHistoryEntry[];
  updatedAt: number;
}

export interface PromptHistoryProjectAlias {
  projectPath: string;
  /** Most-recent first; deduped on text. */
  entries: PromptHistoryEntry[];
  updatedAt: number;
}

export interface PromptHistoryStoreV1 {
  schemaVersion: 1;
  byInstance: Record<string, PromptHistoryRecord>;
  byProject: Record<string, PromptHistoryProjectAlias>;
  lastPrunedAt?: number;
}

export interface PromptHistoryDelta {
  instanceId: string;
  record: PromptHistoryRecord;
}

/**
 * Generate a unique entry id. crypto.randomUUID is available in modern Electron renderers
 * and Node — use it where possible; fall back to a timestamp+random string otherwise.
 */
export function createPromptHistoryEntryId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run src/shared/types/__tests__/prompt-history.types.spec.ts
```

Expected: all pass.

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/shared/types/prompt-history.types.ts
git add src/shared/types/prompt-history.types.ts src/shared/types/__tests__/prompt-history.types.spec.ts
git commit -m "feat(prompt-history): add shared types & PROMPT_HISTORY_MAX constant"
```

---

### Task 1.2: Extend `KeybindingAction` with Wave 2 actions

**Files:**
- Modify: `src/shared/types/keybinding.types.ts`
- Modify: `src/shared/types/keybinding.types.spec.ts`

- [ ] **Step 1: Read the existing keybinding types**

```bash
# Already read in design — confirm that KeybindingAction lives at lines 52–81
# and DEFAULT_KEYBINDINGS at lines 112–339.
```

- [ ] **Step 2: Add the new action members**

Open `src/shared/types/keybinding.types.ts`. Locate `export type KeybindingAction = …`. Append the new members **before** the trailing `| \`command:${string}\`` line (so the template literal stays last and tooling picks it up):

```ts
export type KeybindingAction =
  // Navigation
  | 'focus-input'
  | 'focus-output'
  | 'focus-instance-list'
  // Instance management
  | 'new-instance'
  | 'close-instance'
  | 'next-instance'
  | 'prev-instance'
  | 'restart-instance'
  // UI
  | 'toggle-command-palette'
  | 'toggle-sidebar'
  | 'toggle-history'
  | 'toggle-settings'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  // Session
  | 'send-message'
  | 'cancel-operation'
  | 'clear-input'
  | 'copy-last-response'
  // Agent
  | 'toggle-agent'
  | 'select-agent-build'
  | 'select-agent-plan'
  // Wave 2 — Navigation / Pickers / Recall
  | 'select-visible-instance-1'
  | 'select-visible-instance-2'
  | 'select-visible-instance-3'
  | 'select-visible-instance-4'
  | 'select-visible-instance-5'
  | 'select-visible-instance-6'
  | 'select-visible-instance-7'
  | 'select-visible-instance-8'
  | 'select-visible-instance-9'
  | 'open-session-picker'
  | 'open-model-picker'
  | 'open-prompt-history-search'
  // Custom command (must remain LAST so the template literal slot is captured by tooling)
  | `command:${string}`;
```

- [ ] **Step 3: Add default keybindings**

In the same file, locate `DEFAULT_KEYBINDINGS`. Append (before the closing `]`):

```ts
  // ── Wave 2 — numeric instance switching (1–9) ──
  ...Array.from({ length: 9 }, (_, i) => {
    const n = i + 1;
    return {
      id: `select-visible-instance-${n}`,
      name: `Select Visible Instance ${n}`,
      description: `Switch focus to the ${ordinal(n)} visible instance in the project rail`,
      keys: { key: String(n), modifiers: ['meta'] as KeyModifier[] },
      action: `select-visible-instance-${n}` as const,
      context: 'global' as const,
      when: ['multiple-instances'] as KeybindingWhen[],
      category: 'Navigation',
      customizable: true,
    } satisfies KeyBinding;
  }),
  // ── Wave 2 — picker hotkeys ──
  {
    id: 'open-session-picker',
    name: 'Open Session Picker',
    description: 'Open the session picker overlay',
    keys: { key: 'o', modifiers: ['meta'] },
    action: 'open-session-picker',
    context: 'global',
    category: 'Navigation',
    customizable: true,
  },
  {
    id: 'open-model-picker',
    name: 'Open Model Picker',
    description: 'Open the model / agent picker overlay',
    keys: { key: 'm', modifiers: ['meta', 'shift'] },
    action: 'open-model-picker',
    context: 'global',
    category: 'Session',
    customizable: true,
  },
  {
    id: 'open-prompt-history-search',
    name: 'Search Prompt History',
    description: 'Open reverse-search overlay for past prompts',
    keys: { key: 'r', modifiers: ['ctrl'] },
    action: 'open-prompt-history-search',
    context: 'input',
    category: 'Session',
    customizable: true,
  },
```

Add a small helper at the top of the file (right under the existing imports — there are none today; if the file has no imports, just add it before `DEFAULT_KEYBINDINGS`):

```ts
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
```

- [ ] **Step 4: Update the existing keybinding spec to assert the new members**

Open `src/shared/types/keybinding.types.spec.ts`. Append:

```ts
describe('Wave 2 keybinding additions', () => {
  it('includes all 9 select-visible-instance bindings', () => {
    for (let n = 1; n <= 9; n++) {
      const id = `select-visible-instance-${n}`;
      const binding = DEFAULT_KEYBINDINGS.find(b => b.id === id);
      expect(binding, `binding ${id}`).toBeDefined();
      expect((binding!.keys as KeyCombo).key).toBe(String(n));
      expect((binding!.keys as KeyCombo).modifiers).toEqual(['meta']);
      expect(binding!.action).toBe(id);
    }
  });

  it('includes open-session-picker / open-model-picker / open-prompt-history-search', () => {
    expect(DEFAULT_KEYBINDINGS.find(b => b.id === 'open-session-picker')).toBeDefined();
    expect(DEFAULT_KEYBINDINGS.find(b => b.id === 'open-model-picker')).toBeDefined();
    expect(DEFAULT_KEYBINDINGS.find(b => b.id === 'open-prompt-history-search')).toBeDefined();
  });
});
```

(The existing file already imports `DEFAULT_KEYBINDINGS`, `KeyCombo`, etc. If it does not, add the imports.)

- [ ] **Step 5: Run, type-check, lint, commit**

```bash
npx vitest run src/shared/types/keybinding.types.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/shared/types/keybinding.types.ts
git add src/shared/types/keybinding.types.ts src/shared/types/keybinding.types.spec.ts
git commit -m "feat(keybindings): add select-visible-instance-1..9 + picker hotkeys"
```

---

### Task 1.3: Add IPC channel constants

**Files:**
- Modify or create: `packages/contracts/src/channels/<domain>.channels.ts` (e.g., extend an existing domain like `session.channels.ts`, or create `prompt-history.channels.ts` and register it in `packages/contracts/src/channels/index.ts`)
- Run after editing: `npm run generate:ipc` (regenerates `src/preload/generated/channels.ts`) and `npm run verify:ipc`

> **IPC source-of-truth note (repo-specific):** `src/shared/types/ipc.types.ts` is now a deprecated re-export shim. New channel constants MUST live in `packages/contracts/src/channels/<domain>.channels.ts`. The generator (`scripts/generate-preload-channels.js`) builds `src/preload/generated/channels.ts` from those, which is what the runtime preload imports. Adding constants to `src/shared/types/ipc.types.ts` directly will not reach the runtime.

- [ ] **Step 1: Pick or create the channel file**

Prompt-history fits under `session.channels.ts` (instance lifecycle adjacent) or a new `prompt-history.channels.ts`. If creating new, also import + spread it in `packages/contracts/src/channels/index.ts` so the merged `IPC_CHANNELS` includes it.

- [ ] **Step 2: Add Wave 2 channels**

In the chosen channel file, add the constants:

```ts
PROMPT_HISTORY_GET_SNAPSHOT: 'promptHistory:getSnapshot',
PROMPT_HISTORY_RECORD:       'promptHistory:record',
PROMPT_HISTORY_CLEAR_INSTANCE: 'promptHistory:clearInstance',
PROMPT_HISTORY_DELTA:        'promptHistory:delta',
```

- [ ] **Step 3: Verify type-check and commit**

```bash
npm run generate:ipc
npm run verify:ipc
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add packages/contracts/src/channels/ src/preload/generated/channels.ts
# Suggested commit (run only after user approval per AGENTS.md):
# git commit -m "feat(ipc): add PROMPT_HISTORY_* channel constants"
```

---

## Phase 2 — Zod schemas + alias sync

After this phase, prompt-history schemas live in their own subpath and are reachable via `@contracts/schemas/prompt-history` from main, renderer, and vitest.

### Task 2.1: Create `prompt-history.schemas.ts`

**Files:**
- Create: `packages/contracts/src/schemas/prompt-history.schemas.ts`
- Create: `packages/contracts/src/schemas/__tests__/prompt-history.schemas.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/schemas/__tests__/prompt-history.schemas.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  PromptHistoryEntrySchema,
  PromptHistoryRecordPayloadSchema,
  PromptHistoryClearInstancePayloadSchema,
} from '../prompt-history.schemas';

describe('PromptHistoryEntrySchema', () => {
  it('accepts a minimal entry', () => {
    const r = PromptHistoryEntrySchema.safeParse({ id: 'x', text: 'hello', createdAt: 1 });
    expect(r.success).toBe(true);
  });

  it('rejects entry with text > 100k chars', () => {
    const r = PromptHistoryEntrySchema.safeParse({
      id: 'x', text: 'a'.repeat(100_001), createdAt: 1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects entry with negative createdAt', () => {
    const r = PromptHistoryEntrySchema.safeParse({ id: 'x', text: 'hi', createdAt: -1 });
    expect(r.success).toBe(false);
  });
});

describe('PromptHistoryRecordPayloadSchema', () => {
  it('accepts a record payload', () => {
    const r = PromptHistoryRecordPayloadSchema.safeParse({
      instanceId: 'instance-abc',
      entry: { id: 'x', text: 'hi', createdAt: 1 },
    });
    expect(r.success).toBe(true);
  });
});

describe('PromptHistoryClearInstancePayloadSchema', () => {
  it('rejects empty instanceId', () => {
    const r = PromptHistoryClearInstancePayloadSchema.safeParse({ instanceId: '' });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run packages/contracts/src/schemas/__tests__/prompt-history.schemas.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the schemas**

Create `packages/contracts/src/schemas/prompt-history.schemas.ts`:

```ts
import { z } from 'zod';
import { InstanceIdSchema } from './instance.schemas';

export const PromptHistoryEntrySchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().max(100_000),
  createdAt: z.number().int().nonnegative(),
  projectPath: z.string().min(1).max(10_000).optional(),
  provider: z.string().max(50).optional(),
  model: z.string().max(100).optional(),
  wasSlashCommand: z.boolean().optional(),
});

export const PromptHistoryRecordSchema = z.object({
  instanceId: InstanceIdSchema,
  entries: z.array(PromptHistoryEntrySchema).max(500),
  updatedAt: z.number().int().nonnegative(),
});

export const PromptHistoryProjectAliasSchema = z.object({
  projectPath: z.string().min(1).max(10_000),
  entries: z.array(PromptHistoryEntrySchema).max(500),
  updatedAt: z.number().int().nonnegative(),
});

export const PromptHistoryGetSnapshotPayloadSchema = z.object({}).strict();

export const PromptHistoryRecordPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  entry: PromptHistoryEntrySchema,
});

export const PromptHistoryClearInstancePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});
```

- [ ] **Step 4: Run, type-check, commit**

```bash
npx vitest run packages/contracts/src/schemas/__tests__/prompt-history.schemas.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add packages/contracts/src/schemas/prompt-history.schemas.ts packages/contracts/src/schemas/__tests__/prompt-history.schemas.spec.ts
git commit -m "feat(contracts): add prompt-history.schemas.ts (Zod IPC schemas)"
```

---

### Task 2.2: Add the four-place alias sync for `@contracts/schemas/prompt-history`

**Files:**
- Modify: `tsconfig.json`
- Modify: `tsconfig.electron.json`
- Modify: `src/main/register-aliases.ts`
- Modify: `vitest.config.ts`

> This is the AGENTS.md packaging gotcha #1 — miss any of the four sites and the packaged DMG crashes on startup with `Cannot find module '@contracts/schemas/prompt-history'`. Phase 13 includes a smoke test that catches this; this task aims to prevent it.

- [ ] **Step 1: Update `tsconfig.json`**

Open `tsconfig.json`. Locate `compilerOptions.paths`. Add (next to the existing `@contracts/schemas/instance` entry):

```jsonc
"@contracts/schemas/prompt-history": ["./packages/contracts/src/schemas/prompt-history.schemas.ts"]
```

- [ ] **Step 2: Update `tsconfig.electron.json`**

Open `tsconfig.electron.json`. Add the same entry under `compilerOptions.paths`.

- [ ] **Step 3: Update `src/main/register-aliases.ts`**

In `src/main/register-aliases.ts`, inside the `exactAliases` object (line ~22), add adjacent to the existing schema aliases:

```ts
'@contracts/schemas/prompt-history':           path.join(baseContracts, 'schemas', 'prompt-history.schemas'),
```

Place alphabetically between `'@contracts/schemas/plugin'` and `'@contracts/schemas/provider'` for readability.

- [ ] **Step 4: Update `vitest.config.ts`**

Open `vitest.config.ts`. If it has a `resolve.alias` block, add the corresponding entry. If aliases are computed from `tsconfig` via `vite-tsconfig-paths`, this step is a no-op — verify by reading the file. Either way, leave a comment in the commit explaining what you did.

- [ ] **Step 5: Sanity import test (throwaway)**

In `src/main/index.ts`, add a temporary import line near the top, **after** the `register-aliases` require:

```ts
// Temporary: remove in Step 7 once a real importer uses the alias
import type { PromptHistoryEntrySchema as _PromptHistoryEntrySchemaProbe } from '@contracts/schemas/prompt-history';
type _PromptHistoryAliasProbe = typeof _PromptHistoryEntrySchemaProbe;
```

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both pass.

- [ ] **Step 6: Verify the alias resolves at Node runtime**

Build the main process and run a tiny script that requires the alias from a context using `register-aliases`:

```bash
# Build the main process bundle
npx tsc -p tsconfig.electron.json
# Probe the alias resolution
node -e "require('./dist/main/register-aliases'); const m = require('@contracts/schemas/prompt-history'); console.log(Object.keys(m));"
```

Expected output: an array of exported schema names (`PromptHistoryEntrySchema`, etc.).

If the require fails with `Cannot find module`, recheck steps 1–4. The most common miss is forgetting the trailing `.schemas` in `register-aliases.ts`.

- [ ] **Step 7: Remove the throwaway import; commit the alias-sync changes**

Delete the two `Temporary:` lines from `src/main/index.ts`. Then:

```bash
npx tsc --noEmit
git add tsconfig.json tsconfig.electron.json src/main/register-aliases.ts vitest.config.ts src/main/index.ts
git commit -m "build(contracts): wire @contracts/schemas/prompt-history path alias in tsconfig/electron-tsconfig/register-aliases/vitest"
```

---

## Phase 3 — Main-process `PromptHistoryService`

After this phase, the main process owns prompt history persistence. No IPC wiring yet.

### Task 3.1: TDD — write failing tests for `PromptHistoryService`

**Files:**
- Create: `src/main/prompt-history/__tests__/prompt-history-service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/prompt-history/__tests__/prompt-history-service.spec.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storeMap } = vi.hoisted(() => ({ storeMap: new Map<string, unknown>() }));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation((opts: { name: string; defaults: unknown }) => {
    const key = opts.name;
    if (!storeMap.has(key)) storeMap.set(key, structuredClone(opts.defaults));
    return {
      get store() { return storeMap.get(key); },
      set store(v: unknown) { storeMap.set(key, v); },
      get: vi.fn((k: string) => (storeMap.get(key) as Record<string, unknown>)[k]),
      set: vi.fn((k: string, v: unknown) => { (storeMap.get(key) as Record<string, unknown>)[k] = v; }),
    };
  }),
}));

import {
  PromptHistoryService,
  _resetPromptHistoryServiceForTesting,
} from '../prompt-history-service';
import { PROMPT_HISTORY_MAX } from '../../../shared/types/prompt-history.types';

describe('PromptHistoryService', () => {
  beforeEach(() => {
    storeMap.clear();
    _resetPromptHistoryServiceForTesting();
  });

  it('starts with empty per-instance and per-project maps', () => {
    const svc = new PromptHistoryService();
    expect(svc.getForInstance('inst-1').entries).toEqual([]);
    expect(svc.getForProject('/x').entries).toEqual([]);
  });

  it('records and retrieves entries (most-recent first)', () => {
    const svc = new PromptHistoryService();
    svc.record({ instanceId: 'inst-1', id: 'a', text: 'first', createdAt: 1 });
    svc.record({ instanceId: 'inst-1', id: 'b', text: 'second', createdAt: 2 });
    const r = svc.getForInstance('inst-1');
    expect(r.entries.map(e => e.id)).toEqual(['b', 'a']);
  });

  it('caps entries to PROMPT_HISTORY_MAX', () => {
    const svc = new PromptHistoryService();
    for (let i = 0; i < PROMPT_HISTORY_MAX + 50; i++) {
      svc.record({ instanceId: 'inst-1', id: `e${i}`, text: `t${i}`, createdAt: i });
    }
    expect(svc.getForInstance('inst-1').entries.length).toBe(PROMPT_HISTORY_MAX);
    expect(svc.getForInstance('inst-1').entries[0].id).toBe(`e${PROMPT_HISTORY_MAX + 49}`);
  });

  it('dedupes consecutive duplicates by refreshing createdAt', () => {
    const svc = new PromptHistoryService();
    svc.record({ instanceId: 'inst-1', id: 'a', text: 'same', createdAt: 100 });
    svc.record({ instanceId: 'inst-1', id: 'b', text: 'same', createdAt: 200 });
    const r = svc.getForInstance('inst-1');
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].createdAt).toBe(200);
  });

  it('builds per-project alias deduped on text across instances', () => {
    const svc = new PromptHistoryService();
    svc.record({ instanceId: 'inst-1', id: 'a', text: 'shared', createdAt: 1, projectPath: '/p' });
    svc.record({ instanceId: 'inst-2', id: 'b', text: 'shared', createdAt: 2, projectPath: '/p' });
    svc.record({ instanceId: 'inst-2', id: 'c', text: 'unique', createdAt: 3, projectPath: '/p' });
    const alias = svc.getForProject('/p');
    expect(alias.entries.length).toBe(2);
    expect(alias.entries.map(e => e.text)).toEqual(['unique', 'shared']);
  });

  it('emits change events on record', () => {
    const svc = new PromptHistoryService();
    const seen: { instanceId: string; len: number }[] = [];
    const off = svc.onChange(d => seen.push({ instanceId: d.instanceId, len: d.record.entries.length }));
    svc.record({ instanceId: 'inst-1', id: 'a', text: 'hi', createdAt: 1 });
    expect(seen).toEqual([{ instanceId: 'inst-1', len: 1 }]);
    off();
    svc.record({ instanceId: 'inst-1', id: 'b', text: 'hi2', createdAt: 2 });
    expect(seen.length).toBe(1);
  });

  it('clearForInstance removes the record', () => {
    const svc = new PromptHistoryService();
    svc.record({ instanceId: 'inst-1', id: 'a', text: 'hi', createdAt: 1 });
    svc.clearForInstance('inst-1');
    expect(svc.getForInstance('inst-1').entries).toEqual([]);
  });

  it('pruneOnStart truncates oversized records and rebuilds project alias', () => {
    // Pre-seed the store with > MAX entries (simulates loading a corrupt or stale store).
    storeMap.set('prompt-history', {
      schemaVersion: 1,
      byInstance: {
        'inst-1': {
          instanceId: 'inst-1',
          entries: Array.from({ length: PROMPT_HISTORY_MAX + 50 }, (_, i) => ({
            id: `e${i}`, text: `t${i}`, createdAt: i, projectPath: '/p',
          })),
          updatedAt: Date.now(),
        },
      },
      byProject: {},
    });
    const svc = new PromptHistoryService();
    svc.pruneOnStart();
    expect(svc.getForInstance('inst-1').entries.length).toBe(PROMPT_HISTORY_MAX);
    expect(svc.getForProject('/p').entries.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/prompt-history/__tests__/prompt-history-service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Commit failing test (TDD red)**

```bash
git add src/main/prompt-history/__tests__/prompt-history-service.spec.ts
git commit -m "test(prompt-history): add failing PromptHistoryService spec (red)"
```

---

### Task 3.2: Implement `PromptHistoryService`

**Files:**
- Create: `src/main/prompt-history/prompt-history-store.ts`
- Create: `src/main/prompt-history/prompt-history-service.ts`

- [ ] **Step 1: Implement the electron-store wrapper**

Create `src/main/prompt-history/prompt-history-store.ts`:

```ts
import ElectronStore from 'electron-store';
import type { PromptHistoryStoreV1 } from '../../shared/types/prompt-history.types';

const DEFAULTS: PromptHistoryStoreV1 = {
  schemaVersion: 1,
  byInstance: {},
  byProject: {},
};

interface Store<T> {
  store: T;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
}

export function createPromptHistoryElectronStore(): Store<PromptHistoryStoreV1> {
  return new ElectronStore<PromptHistoryStoreV1>({
    name: 'prompt-history', // distinct namespace from Wave 1's 'usage-tracker' store; both coexist (design § 4)
    defaults: DEFAULTS,
  }) as unknown as Store<PromptHistoryStoreV1>;
}
```

> The `name: 'prompt-history'` value is load-bearing — it pins the on-disk JSON filename and isolates this store from Wave 1's `'usage-tracker'` namespace. Do not change it without a migration plan.

- [ ] **Step 2: Implement the service**

Create `src/main/prompt-history/prompt-history-service.ts`:

```ts
import {
  PROMPT_HISTORY_MAX,
  type PromptHistoryEntry,
  type PromptHistoryRecord,
  type PromptHistoryProjectAlias,
  type PromptHistoryStoreV1,
} from '../../shared/types/prompt-history.types';
import { createPromptHistoryElectronStore } from './prompt-history-store';
import { getLogger } from '../logging/logger';

const logger = getLogger('PromptHistoryService');

interface Store<T> {
  store: T;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
}

export class PromptHistoryService {
  private store: Store<PromptHistoryStoreV1>;
  private listeners = new Set<(delta: { instanceId: string; record: PromptHistoryRecord }) => void>();

  constructor(store?: Store<PromptHistoryStoreV1>) {
    this.store = store ?? createPromptHistoryElectronStore();
  }

  getForInstance(instanceId: string): PromptHistoryRecord {
    const all = this.store.get('byInstance') ?? {};
    return all[instanceId] ?? { instanceId, entries: [], updatedAt: 0 };
  }

  getForProject(projectPath: string): PromptHistoryProjectAlias {
    const all = this.store.get('byProject') ?? {};
    return all[projectPath] ?? { projectPath, entries: [], updatedAt: 0 };
  }

  getSnapshot(): { byInstance: Record<string, PromptHistoryRecord>; byProject: Record<string, PromptHistoryProjectAlias> } {
    return {
      byInstance: this.store.get('byInstance') ?? {},
      byProject: this.store.get('byProject') ?? {},
    };
  }

  record(entry: PromptHistoryEntry & { instanceId: string }): void {
    const { instanceId, ...rest } = entry;
    const all = { ...(this.store.get('byInstance') ?? {}) };
    const existing: PromptHistoryRecord = all[instanceId] ?? { instanceId, entries: [], updatedAt: 0 };
    const head = existing.entries[0];

    // PROMPT_HISTORY_DEDUPE_HEAD is a global constant per design § 4.7; see migration path note for future per-store override.
    let nextEntries: PromptHistoryEntry[];
    if (head && head.text === rest.text) {
      // Refresh head's createdAt instead of pushing.
      nextEntries = [{ ...head, createdAt: rest.createdAt }, ...existing.entries.slice(1)];
    } else {
      nextEntries = [rest, ...existing.entries];
    }
    if (nextEntries.length > PROMPT_HISTORY_MAX) {
      nextEntries = nextEntries.slice(0, PROMPT_HISTORY_MAX);
    }

    const nextRecord: PromptHistoryRecord = {
      instanceId,
      entries: nextEntries,
      updatedAt: Date.now(),
    };
    all[instanceId] = nextRecord;
    this.store.set('byInstance', all);
    this.rebuildProjectAlias(rest.projectPath, all);

    if (rest.text.length > 10_000) {
      logger.debug(`Recorded large prompt entry (${rest.text.length} chars) for ${instanceId}`);
    }
    for (const listener of this.listeners) listener({ instanceId, record: nextRecord });
  }

  clearForInstance(instanceId: string): void {
    const all = { ...(this.store.get('byInstance') ?? {}) };
    if (!(instanceId in all)) return;
    delete all[instanceId];
    this.store.set('byInstance', all);
    this.rebuildAllProjectAliases(all);
    const empty: PromptHistoryRecord = { instanceId, entries: [], updatedAt: Date.now() };
    for (const listener of this.listeners) listener({ instanceId, record: empty });
  }

  onChange(listener: (delta: { instanceId: string; record: PromptHistoryRecord }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pruneOnStart(): void {
    const byInstance = { ...(this.store.get('byInstance') ?? {}) };
    let dropped = 0;
    let touched = 0;
    for (const [id, record] of Object.entries(byInstance)) {
      if (!record || !Array.isArray(record.entries)) {
        delete byInstance[id];
        continue;
      }
      if (record.entries.length > PROMPT_HISTORY_MAX) {
        dropped += record.entries.length - PROMPT_HISTORY_MAX;
        record.entries = record.entries.slice(0, PROMPT_HISTORY_MAX);
        touched += 1;
      }
      if (record.entries.length === 0) delete byInstance[id];
    }
    this.store.set('byInstance', byInstance);
    this.rebuildAllProjectAliases(byInstance);
    logger.info(`Pruned prompt history: dropped ${dropped} entries across ${touched} instances`);
  }

  // ── private helpers ──

  private rebuildProjectAlias(
    projectPath: string | undefined,
    byInstance: Record<string, PromptHistoryRecord>,
  ): void {
    if (!projectPath) return;
    const aliases = { ...(this.store.get('byProject') ?? {}) };
    aliases[projectPath] = this.computeProjectAlias(projectPath, byInstance);
    this.store.set('byProject', aliases);
  }

  private rebuildAllProjectAliases(byInstance: Record<string, PromptHistoryRecord>): void {
    const projects = new Set<string>();
    for (const r of Object.values(byInstance)) {
      for (const e of r.entries) {
        if (e.projectPath) projects.add(e.projectPath);
      }
    }
    const aliases: Record<string, PromptHistoryProjectAlias> = {};
    for (const p of projects) {
      aliases[p] = this.computeProjectAlias(p, byInstance);
    }
    this.store.set('byProject', aliases);
  }

  private computeProjectAlias(
    projectPath: string,
    byInstance: Record<string, PromptHistoryRecord>,
  ): PromptHistoryProjectAlias {
    const seenText = new Set<string>();
    const collected: PromptHistoryEntry[] = [];
    const flat = Object.values(byInstance)
      .flatMap(r => r.entries.filter(e => e.projectPath === projectPath))
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const e of flat) {
      if (seenText.has(e.text)) continue;
      seenText.add(e.text);
      collected.push(e);
      if (collected.length >= PROMPT_HISTORY_MAX) break;
    }
    return {
      projectPath,
      entries: collected,
      updatedAt: Date.now(),
    };
  }
}

let instance: PromptHistoryService | null = null;

export function getPromptHistoryService(): PromptHistoryService {
  if (!instance) instance = new PromptHistoryService();
  return instance;
}

export function _resetPromptHistoryServiceForTesting(): void {
  instance = null;
}
```

- [ ] **Step 3: Run the tests and confirm they pass**

```bash
npx vitest run src/main/prompt-history/__tests__/prompt-history-service.spec.ts
```

Expected: all pass. If `pruneOnStart` test fails because the project alias rebuild logic doesn't pick up entries from the seeded store, double-check that `rebuildAllProjectAliases` reads from the passed-in `byInstance` and not the store cache.

- [ ] **Step 4: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/prompt-history/prompt-history-service.ts src/main/prompt-history/prompt-history-store.ts
git add src/main/prompt-history/prompt-history-service.ts src/main/prompt-history/prompt-history-store.ts
git commit -m "feat(prompt-history): implement PromptHistoryService with electron-store persistence + dedupe + cap"
```

---

## Phase 4 — IPC handlers + preload exposure

After this phase, the renderer can speak to `PromptHistoryService` over IPC.

### Task 4.1: Implement IPC handlers

**Files:**
- Create: `src/main/ipc/handlers/prompt-history-handlers.ts`
- Create: `src/main/ipc/handlers/__tests__/prompt-history-handlers.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/ipc/handlers/__tests__/prompt-history-handlers.spec.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlerMap, sentChannels } = vi.hoisted(() => ({
  handlerMap: new Map<string, (e: unknown, p: unknown) => Promise<unknown> | unknown>(),
  sentChannels: [] as { channel: string; payload: unknown }[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (e: unknown, p: unknown) => Promise<unknown> | unknown) => {
      handlerMap.set(channel, handler);
    },
  },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sentChannels.push({ channel, payload }) } }] },
}));

import { registerPromptHistoryHandlers } from '../prompt-history-handlers';
import {
  PromptHistoryService,
  _resetPromptHistoryServiceForTesting,
} from '../../../prompt-history/prompt-history-service';

const { storeMap } = vi.hoisted(() => ({ storeMap: new Map<string, unknown>() }));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation((opts: { name: string; defaults: unknown }) => {
    const key = opts.name;
    if (!storeMap.has(key)) storeMap.set(key, structuredClone(opts.defaults));
    return {
      get store() { return storeMap.get(key); },
      set store(v: unknown) { storeMap.set(key, v); },
      get: vi.fn((k: string) => (storeMap.get(key) as Record<string, unknown>)[k]),
      set: vi.fn((k: string, v: unknown) => { (storeMap.get(key) as Record<string, unknown>)[k] = v; }),
    };
  }),
}));

describe('prompt-history-handlers', () => {
  beforeEach(() => {
    handlerMap.clear();
    sentChannels.length = 0;
    storeMap.clear();
    _resetPromptHistoryServiceForTesting();
    registerPromptHistoryHandlers();
  });

  it('PROMPT_HISTORY_GET_SNAPSHOT returns empty maps initially', async () => {
    const handler = handlerMap.get('promptHistory:getSnapshot');
    expect(handler).toBeDefined();
    const res = await handler!({}, {}) as { success: boolean; data: { byInstance: object; byProject: object } };
    expect(res.success).toBe(true);
    expect(res.data.byInstance).toEqual({});
    expect(res.data.byProject).toEqual({});
  });

  it('PROMPT_HISTORY_RECORD validates and records', async () => {
    const handler = handlerMap.get('promptHistory:record');
    const res = await handler!({}, {
      instanceId: 'inst-1',
      entry: { id: 'a', text: 'hi', createdAt: 1 },
    }) as { success: boolean };
    expect(res.success).toBe(true);
    const get = handlerMap.get('promptHistory:getSnapshot');
    const snap = await get!({}, {}) as { data: { byInstance: Record<string, { entries: { id: string }[] }> } };
    expect(snap.data.byInstance['inst-1'].entries[0].id).toBe('a');
  });

  it('PROMPT_HISTORY_RECORD rejects invalid payload', async () => {
    const handler = handlerMap.get('promptHistory:record');
    const res = await handler!({}, { instanceId: '', entry: {} }) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('emits PROMPT_HISTORY_DELTA after record', async () => {
    const handler = handlerMap.get('promptHistory:record');
    await handler!({}, {
      instanceId: 'inst-1',
      entry: { id: 'a', text: 'hi', createdAt: 1 },
    });
    expect(sentChannels.find(c => c.channel === 'promptHistory:delta')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/ipc/handlers/__tests__/prompt-history-handlers.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handler module**

Create `src/main/ipc/handlers/prompt-history-handlers.ts`:

```ts
import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  PromptHistoryGetSnapshotPayloadSchema,
  PromptHistoryRecordPayloadSchema,
  PromptHistoryClearInstancePayloadSchema,
} from '@contracts/schemas/prompt-history';
import { getPromptHistoryService } from '../../prompt-history/prompt-history-service';

export function registerPromptHistoryHandlers(): void {
  const svc = getPromptHistoryService();

  ipcMain.handle(
    IPC_CHANNELS.PROMPT_HISTORY_GET_SNAPSHOT,
    async (_e: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        validateIpcPayload(PromptHistoryGetSnapshotPayloadSchema, payload ?? {}, 'PROMPT_HISTORY_GET_SNAPSHOT');
        return { success: true, data: svc.getSnapshot() };
      } catch (err) {
        return {
          success: false,
          error: { code: 'PROMPT_HISTORY_GET_FAILED', message: (err as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROMPT_HISTORY_RECORD,
    async (_e: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const v = validateIpcPayload(PromptHistoryRecordPayloadSchema, payload, 'PROMPT_HISTORY_RECORD');
        svc.record({ instanceId: v.instanceId, ...v.entry });
        return { success: true, data: { ok: true } };
      } catch (err) {
        return {
          success: false,
          error: { code: 'PROMPT_HISTORY_RECORD_FAILED', message: (err as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROMPT_HISTORY_CLEAR_INSTANCE,
    async (_e: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const v = validateIpcPayload(PromptHistoryClearInstancePayloadSchema, payload, 'PROMPT_HISTORY_CLEAR_INSTANCE');
        svc.clearForInstance(v.instanceId);
        return { success: true, data: { ok: true } };
      } catch (err) {
        return {
          success: false,
          error: { code: 'PROMPT_HISTORY_CLEAR_FAILED', message: (err as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  // Push deltas to all renderer windows.
  svc.onChange((delta) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.PROMPT_HISTORY_DELTA, delta);
    }
  });
}
```

- [ ] **Step 4: Run, type-check, lint, commit**

```bash
npx vitest run src/main/ipc/handlers/__tests__/prompt-history-handlers.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/ipc/handlers/prompt-history-handlers.ts
git add src/main/ipc/handlers/prompt-history-handlers.ts src/main/ipc/handlers/__tests__/prompt-history-handlers.spec.ts
git commit -m "feat(prompt-history): wire PROMPT_HISTORY_* IPC handlers"
```

---

### Task 4.2: Register the handler and prune-on-start in `src/main/index.ts`

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Find where Wave 1 registers `registerUsageHandlers`**

```bash
# Already known from Wave 1 plan; if Wave 1 has not landed yet, locate any
# existing registerCommandHandlers() call and place this nearby.
```

- [ ] **Step 2: Register**

Near the other IPC handler registrations, add:

```ts
import { registerPromptHistoryHandlers } from './ipc/handlers/prompt-history-handlers';
import { getPromptHistoryService } from './prompt-history/prompt-history-service';

// inside the bootstrap step where IPC is wired:
registerPromptHistoryHandlers();
getPromptHistoryService().pruneOnStart();
```

> The `pruneOnStart` call must run **after** `electron-store` is available (i.e. after `app.whenReady()`) but **before** the renderer can ask for a snapshot. Placing it adjacent to `registerPromptHistoryHandlers()` is correct because handlers are registered in the same bootstrap step.

- [ ] **Step 3: Verify, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/index.ts
git commit -m "feat(prompt-history): register handler + pruneOnStart in main bootstrap"
```

---

### Task 4.3: Expose IPC in preload (factory + composition)

**Files:**
- Create: `src/preload/domains/prompt-history.preload.ts` (new domain factory)
- Modify: `src/preload/preload.ts` (compose factory into `electronAPI`)

> **Repo-specific preload pattern:** Electron's sandboxed preload cannot import from `packages/` at runtime. Each domain is a factory `createXxxDomain(ipcRenderer, IPC_CHANNELS)` whose returned object is **flat-spread** into the single `electronAPI` exposed via `contextBridge.exposeInMainWorld('electronAPI', electronAPI)`. There is NO separate `window.promptHistory` global — the renderer always accesses methods at `window.electronAPI.<method>` (typically through `ElectronIpcService`'s typed `api` field).

- [ ] **Step 1: Create the domain factory**

Create `src/preload/domains/prompt-history.preload.ts` mirroring the existing `session.preload.ts` shape:

```ts
import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type {
  PromptHistoryEntry,
  PromptHistoryDelta,
} from '../../shared/types/prompt-history.types';

export function createPromptHistoryDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    promptHistoryGetSnapshot: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROMPT_HISTORY_GET_SNAPSHOT, {}),

    promptHistoryRecord: (payload: { instanceId: string; entry: PromptHistoryEntry }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROMPT_HISTORY_RECORD, payload),

    promptHistoryClearInstance: (payload: { instanceId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROMPT_HISTORY_CLEAR_INSTANCE, payload),

    onPromptHistoryDelta: (cb: (delta: PromptHistoryDelta) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, d: PromptHistoryDelta) => cb(d);
      ipcRenderer.on(ch.PROMPT_HISTORY_DELTA, listener);
      return () => ipcRenderer.removeListener(ch.PROMPT_HISTORY_DELTA, listener);
    },
  };
}
```

- [ ] **Step 2: Compose into `electronAPI`**

Open `src/preload/preload.ts`. Add the factory import alongside existing ones, and spread its return value into `electronAPI`:

```ts
import { createPromptHistoryDomain } from './domains/prompt-history.preload';

const electronAPI = {
  ...createInstanceDomain(ipcRenderer, IPC_CHANNELS),
  // ... existing factories ...
  ...createPromptHistoryDomain(ipcRenderer, IPC_CHANNELS),
  platform: process.platform,
};
```

- [ ] **Step 3: Update `ElectronAPI` type if it's manually maintained**

Some IPC client typings are inferred from the composed `electronAPI` const; if so, no change needed. If `ElectronAPI` is hand-maintained (check `src/renderer/app/core/services/ipc/electron-ipc.service.ts`), add the four new method signatures.

- [ ] **Step 4: Type-check, lint, suggested commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
git add src/preload/domains/prompt-history.preload.ts src/preload/preload.ts
# Suggested (run only after user approval per AGENTS.md):
# git commit -m "feat(prompt-history): expose preload domain via electronAPI"
```

---

## Phase 5 — Renderer `PromptHistoryStore`

After this phase, the renderer has a signal-based cache that survives across components and hosts the recall navigator.

### Task 5.1: TDD — write failing tests for `PromptHistoryStore`

**Files:**
- Create: `src/renderer/app/core/state/__tests__/prompt-history.store.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/core/state/__tests__/prompt-history.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PromptHistoryStore } from '../prompt-history.store';

const mockInvoke = vi.fn();
const onDeltaListeners: ((d: unknown) => void)[] = [];

// The Wave 2 preload domain factory exposes flat methods on `window.electronAPI`
// (e.g. `promptHistoryGetSnapshot`, `promptHistoryRecord`, `promptHistoryClearInstance`,
// `onPromptHistoryDelta`). Mock that flat surface — NOT a nested
// `window.electronAPI.promptHistory.*` object, which is not produced by the
// `createPromptHistoryDomain(ipcRenderer, IPC_CHANNELS)` factory.
vi.stubGlobal('window', {
  electronAPI: {
    promptHistoryGetSnapshot: () => mockInvoke('promptHistory:getSnapshot'),
    promptHistoryRecord: (payload: { instanceId: string; entry: unknown }) =>
      mockInvoke('promptHistory:record', payload),
    promptHistoryClearInstance: (payload: { instanceId: string }) =>
      mockInvoke('promptHistory:clearInstance', payload),
    onPromptHistoryDelta: (cb: (d: unknown) => void) => {
      onDeltaListeners.push(cb);
      return () => {
        const i = onDeltaListeners.indexOf(cb);
        if (i >= 0) onDeltaListeners.splice(i, 1);
      };
    },
  },
});

describe('PromptHistoryStore', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    onDeltaListeners.length = 0;
    TestBed.configureTestingModule({});
  });

  it('init seeds from main and subscribes to deltas', async () => {
    mockInvoke.mockResolvedValueOnce({
      success: true,
      data: {
        byInstance: { 'inst-1': { instanceId: 'inst-1', entries: [{ id: 'a', text: 'hi', createdAt: 1 }], updatedAt: 1 } },
        byProject: {},
      },
    });
    const store = TestBed.inject(PromptHistoryStore);
    await store.init();
    expect(store.getEntriesForInstance('inst-1')[0].id).toBe('a');
    expect(onDeltaListeners.length).toBe(1);
  });

  it('record optimistically inserts and fires IPC', () => {
    mockInvoke.mockResolvedValue({ success: true, data: { ok: true } });
    const store = TestBed.inject(PromptHistoryStore);
    store.record({ instanceId: 'inst-1', id: 'b', text: 'hi2', createdAt: 2 });
    expect(store.getEntriesForInstance('inst-1')[0].id).toBe('b');
    expect(mockInvoke).toHaveBeenCalledWith('promptHistory:record', expect.objectContaining({ instanceId: 'inst-1', entry: expect.objectContaining({ id: 'b' }) }));
  });

  it('delta replaces optimistic insert by id', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, data: { byInstance: {}, byProject: {} } });
    const store = TestBed.inject(PromptHistoryStore);
    await store.init();
    store.record({ instanceId: 'inst-1', id: 'b', text: 'hi2', createdAt: 2 });
    onDeltaListeners[0]({
      instanceId: 'inst-1',
      record: { instanceId: 'inst-1', entries: [{ id: 'b', text: 'hi2', createdAt: 2 }], updatedAt: 3 },
    });
    expect(store.getEntriesForInstance('inst-1').length).toBe(1);
  });

  it('clearForInstance empties local state and calls IPC', () => {
    mockInvoke.mockResolvedValue({ success: true, data: { ok: true } });
    const store = TestBed.inject(PromptHistoryStore);
    store.record({ instanceId: 'inst-1', id: 'b', text: 'hi2', createdAt: 2 });
    store.clearForInstance('inst-1');
    expect(store.getEntriesForInstance('inst-1')).toEqual([]);
    expect(mockInvoke).toHaveBeenCalledWith('promptHistory:clearInstance', { instanceId: 'inst-1' });
    // (Note: the second arg is the full payload object, matching the flat preload contract.)
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/renderer/app/core/state/__tests__/prompt-history.store.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Commit failing test**

```bash
git add src/renderer/app/core/state/__tests__/prompt-history.store.spec.ts
git commit -m "test(prompt-history): add failing PromptHistoryStore spec (red)"
```

---

### Task 5.2: Implement `PromptHistoryStore`

**Files:**
- Create: `src/renderer/app/core/state/prompt-history.store.ts`

- [ ] **Step 1: Implement**

Create `src/renderer/app/core/state/prompt-history.store.ts`:

```ts
import { Injectable, inject, signal } from '@angular/core';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import type {
  PromptHistoryEntry,
  PromptHistoryRecord,
  PromptHistoryProjectAlias,
  PromptHistoryDelta,
} from '../../../../shared/types/prompt-history.types';

// IPC consumption: Wave 2 follows the repo's existing preload pattern.
// All IPC methods are flat-spread onto `window.electronAPI` from a domain
// factory in `src/preload/domains/prompt-history.preload.ts` (Task 4.3).
// Renderer code consumes them via `inject(ElectronIpcService)` and reads
// the underlying `ElectronAPI` via `getApi()` (the field is private; do NOT
// read `this.ipc.api` directly). There is no separate `window.promptHistory`
// global.

@Injectable({ providedIn: 'root' })
export class PromptHistoryStore {
  private ipc = inject(ElectronIpcService);
  private _byInstance = signal<Record<string, PromptHistoryRecord>>({});
  private _byProject = signal<Record<string, PromptHistoryProjectAlias>>({});
  readonly records = this._byInstance.asReadonly();
  readonly projectAliases = this._byProject.asReadonly();

  private unsubscribeDelta: (() => void) | null = null;

  async init(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.promptHistoryGetSnapshot) return;
    const res = await api.promptHistoryGetSnapshot();
    if (res.success && res.data) {
      this._byInstance.set(res.data.byInstance ?? {});
      this._byProject.set(res.data.byProject ?? {});
    }
    this.unsubscribeDelta = api.onPromptHistoryDelta((delta: PromptHistoryDelta) => this.applyDelta(delta));
  }

  record(entry: PromptHistoryEntry & { instanceId: string }): void {
    const { instanceId, ...rest } = entry;
    // Optimistic local insert
    this._byInstance.update((cur) => {
      const next = { ...cur };
      const existing = next[instanceId] ?? { instanceId, entries: [], updatedAt: 0 };
      const head = existing.entries[0];
      const entries = head?.text === rest.text
        ? [{ ...head, createdAt: rest.createdAt }, ...existing.entries.slice(1)]
        : [rest, ...existing.entries];
      next[instanceId] = { instanceId, entries, updatedAt: Date.now() };
      return next;
    });
    // Fire IPC via the typed electronAPI surface
    const api = this.ipc.getApi();
    if (api?.promptHistoryRecord) void api.promptHistoryRecord({ instanceId, entry: rest });
  }

  clearForInstance(instanceId: string): void {
    this._byInstance.update((cur) => {
      if (!(instanceId in cur)) return cur;
      const next = { ...cur };
      delete next[instanceId];
      return next;
    });
    const api = this.ipc.getApi();
    if (api?.promptHistoryClearInstance) void api.promptHistoryClearInstance({ instanceId });
  }

  getEntriesForInstance(instanceId: string): readonly PromptHistoryEntry[] {
    return this._byInstance()[instanceId]?.entries ?? [];
  }

  getEntriesForProject(projectPath: string): readonly PromptHistoryEntry[] {
    return this._byProject()[projectPath]?.entries ?? [];
  }

  // ── private ──

  private applyDelta(delta: PromptHistoryDelta): void {
    this._byInstance.update((cur) => ({ ...cur, [delta.instanceId]: delta.record }));
    // Project alias is rebuilt on the main side; the next snapshot fetch on
    // a fresh app session will repopulate it. For now, optimistically rebuild
    // any project alias that contained the previous head text.
    // (Defer cross-project rebuild; recall reads project alias only inside the
    // optional Ctrl+R path, which can survive a one-frame delay.)
  }

  destroy(): void {
    if (this.unsubscribeDelta) this.unsubscribeDelta();
    this.unsubscribeDelta = null;
  }
}
```

- [ ] **Step 2: Run, type-check, commit**

```bash
npx vitest run src/renderer/app/core/state/__tests__/prompt-history.store.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/renderer/app/core/state/prompt-history.store.ts
git commit -m "feat(prompt-history): add renderer PromptHistoryStore (signal write-through cache)"
```

---

### Task 5.3: Seed `PromptHistoryStore` on bootstrap

**Files:**
- Modify: `src/renderer/app/app.component.ts`

- [ ] **Step 1: Add init call**

Open `src/renderer/app/app.component.ts`. Locate the `ngOnInit` (or equivalent root bootstrap method). Inject `PromptHistoryStore` and call `init`:

```ts
import { PromptHistoryStore } from './core/state/prompt-history.store';

// in the constructor / ngOnInit:
private promptHistoryStore = inject(PromptHistoryStore);

async ngOnInit() {
  // existing init calls (UsageStore.init, etc.) ...
  await this.promptHistoryStore.init();
}
```

- [ ] **Step 2: Type-check, commit**

```bash
npx tsc --noEmit
git add src/renderer/app/app.component.ts
git commit -m "feat(prompt-history): seed PromptHistoryStore on app bootstrap"
```

---

## Phase 6 — `VisibleInstanceResolver` service

### Task 6.1: TDD — write failing tests for `VisibleInstanceResolver`

**Files:**
- Create: `src/renderer/app/core/services/__tests__/visible-instance-resolver.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/core/services/__tests__/visible-instance-resolver.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';
import { VisibleInstanceResolver } from '../visible-instance-resolver.service';

// Minimal local types matching the project rail's ProjectGroup / HierarchicalInstance shapes.
interface FakeLiveItem { instance: { id: string }; }
interface FakeProjectGroup {
  key: string;
  isExpanded: boolean;
  liveItems: FakeLiveItem[];
}

describe('VisibleInstanceResolver', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  it('returns empty order before a source is wired', () => {
    const r = TestBed.inject(VisibleInstanceResolver);
    expect(r.order().instanceIds).toEqual([]);
  });

  it('flattens visible items in render order across expanded groups', () => {
    const r = TestBed.inject(VisibleInstanceResolver);
    const source = signal<FakeProjectGroup[]>([
      { key: 'p1', isExpanded: true, liveItems: [{ instance: { id: 'a' } }, { instance: { id: 'b' } }] },
      { key: 'p2', isExpanded: true, liveItems: [{ instance: { id: 'c' } }] },
    ]);
    r.setProjectGroupsSource(source as never);
    expect(r.order().instanceIds).toEqual(['a', 'b', 'c']);
  });

  it('skips items inside collapsed groups', () => {
    const r = TestBed.inject(VisibleInstanceResolver);
    const source = signal<FakeProjectGroup[]>([
      { key: 'p1', isExpanded: false, liveItems: [{ instance: { id: 'a' } }] },
      { key: 'p2', isExpanded: true, liveItems: [{ instance: { id: 'b' } }] },
    ]);
    r.setProjectGroupsSource(source as never);
    expect(r.order().instanceIds).toEqual(['b']);
  });

  it('1-indexed lookup matches the keybinding name', () => {
    const r = TestBed.inject(VisibleInstanceResolver);
    const source = signal<FakeProjectGroup[]>([
      { key: 'p1', isExpanded: true, liveItems: [{ instance: { id: 'a' } }, { instance: { id: 'b' } }] },
    ]);
    r.setProjectGroupsSource(source as never);
    expect(r.getInstanceIdAt(1)).toBe('a');
    expect(r.getInstanceIdAt(2)).toBe('b');
    expect(r.getInstanceIdAt(3)).toBeNull();
    expect(r.getInstanceIdAt(0)).toBeNull();
  });

  it('updates reactively when the source signal changes', () => {
    const r = TestBed.inject(VisibleInstanceResolver);
    const source = signal<FakeProjectGroup[]>([
      { key: 'p1', isExpanded: true, liveItems: [{ instance: { id: 'a' } }] },
    ]);
    r.setProjectGroupsSource(source as never);
    expect(r.order().instanceIds).toEqual(['a']);
    source.set([
      { key: 'p1', isExpanded: true, liveItems: [{ instance: { id: 'a' } }, { instance: { id: 'z' } }] },
    ]);
    expect(r.order().instanceIds).toEqual(['a', 'z']);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/renderer/app/core/services/__tests__/visible-instance-resolver.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Commit failing test**

```bash
git add src/renderer/app/core/services/__tests__/visible-instance-resolver.service.spec.ts
git commit -m "test(navigation): add failing VisibleInstanceResolver spec (red)"
```

---

### Task 6.2: Implement `VisibleInstanceResolver`

**Files:**
- Create: `src/renderer/app/core/services/visible-instance-resolver.service.ts`

- [ ] **Step 1: Implement**

Create `src/renderer/app/core/services/visible-instance-resolver.service.ts`:

```ts
import { Injectable, Signal, computed, signal } from '@angular/core';
import type { VisibleInstanceOrder } from '../../../../shared/types/prompt-history.types';

/**
 * Minimal structural types — we don't import the full ProjectGroup here to
 * avoid a circular dep on the instance-list feature module. The fields
 * referenced match what InstanceListComponent.projectGroups produces.
 */
interface RailLiveItem { instance: { id: string }; }
interface RailProjectGroup {
  key: string;
  isExpanded: boolean;
  liveItems: RailLiveItem[];
}

const EMPTY_ORDER: VisibleInstanceOrder = { computedAt: 0, instanceIds: [], projectKeys: [] };

@Injectable({ providedIn: 'root' })
export class VisibleInstanceResolver {
  private fallback = signal<RailProjectGroup[]>([]);
  private currentSource: Signal<RailProjectGroup[]> = this.fallback.asReadonly();

  readonly order = computed<VisibleInstanceOrder>(() => {
    const groups = this.currentSource();
    const ids: string[] = [];
    const projectKeys: string[] = [];
    for (const g of groups) {
      if (!g.isExpanded) continue;
      for (const item of g.liveItems) {
        ids.push(item.instance.id);
        projectKeys.push(g.key);
      }
    }
    return { computedAt: Date.now(), instanceIds: ids, projectKeys };
  });

  setProjectGroupsSource(source: Signal<RailProjectGroup[]>): void {
    this.currentSource = source;
  }

  getOrder(): VisibleInstanceOrder {
    return this.order();
  }

  getInstanceIdAt(slot1Indexed: number): string | null {
    if (slot1Indexed < 1) return null;
    const ids = this.order().instanceIds;
    return ids[slot1Indexed - 1] ?? null;
  }
}
```

> Note: `VisibleInstanceOrder` is declared in `prompt-history.types.ts`'s § 1.3 of the spec; if that file does not yet export it, add it now (the spec section is canonical):

```ts
// add to src/shared/types/prompt-history.types.ts
export interface VisibleInstanceOrder {
  computedAt: number;
  instanceIds: string[];
  projectKeys?: string[];
}
```

- [ ] **Step 2: Run, type-check, commit**

```bash
npx vitest run src/renderer/app/core/services/__tests__/visible-instance-resolver.service.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/renderer/app/core/services/visible-instance-resolver.service.ts src/shared/types/prompt-history.types.ts
git commit -m "feat(navigation): add VisibleInstanceResolver service"
```

---

### Task 6.4: Test the lifecycle contract

- [ ] Add specs that:
  - Verify default state when no source is set
  - Verify the resolver picks up changes after `setProjectGroupsSource()` is called
  - Verify destroy/recreate of the source still produces correct order
  - Verify a second `setProjectGroupsSource()` call throws (single-source guard)
- Files:
  - `src/renderer/app/core/services/__tests__/visible-instance-resolver.service.spec.ts`
- Verification: `npx vitest run src/renderer/app/core/services/__tests__/visible-instance-resolver.service.spec.ts`
- Commit: `test(resolver): visible-instance lifecycle contract`

---

## Phase 7 — Keybinding action additions + dispatcher wiring

### Task 7.1: Register numeric and picker actions

**Files:**
- Create: `src/renderer/app/core/services/__tests__/action-dispatch.navigation.spec.ts`
- Modify: `src/renderer/app/core/services/action-dispatch.service.ts` (no behavior change — only adding registration helpers; choose between modifying the service or adding a new bootstrap service that registers into it)

- [ ] **Step 1: Write the failing test for the integration**

Create `src/renderer/app/core/services/__tests__/action-dispatch.navigation.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';
import { ActionDispatchService } from '../action-dispatch.service';
import { VisibleInstanceResolver } from '../visible-instance-resolver.service';
import { InstanceStore } from '../../state/instance.store';
import { registerNavigationActions } from '../navigation-actions';

describe('navigation actions registered against ActionDispatchService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  it('select-visible-instance-N selects the Nth visible instance', () => {
    const dispatch = TestBed.inject(ActionDispatchService);
    const resolver = TestBed.inject(VisibleInstanceResolver);
    const store = TestBed.inject(InstanceStore);

    resolver.setProjectGroupsSource(signal([
      { key: 'p', isExpanded: true, liveItems: [{ instance: { id: 'a' } }, { instance: { id: 'b' } }] },
    ]) as never);
    dispatch.setState({ multipleInstances: true, instanceSelected: false } as never);

    let selected: string | null = null;
    const origSetSelected = store.setSelected.bind(store);
    store.setSelected = ((id: string) => { selected = id; origSetSelected(id); }) as never;

    registerNavigationActions();
    void dispatch.dispatch('select-visible-instance-2');
    expect(selected).toBe('b');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/renderer/app/core/services/__tests__/action-dispatch.navigation.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `registerNavigationActions`**

Create `src/renderer/app/core/services/navigation-actions.ts`:

```ts
import { inject } from '@angular/core';
import { ActionDispatchService } from './action-dispatch.service';
import { VisibleInstanceResolver } from './visible-instance-resolver.service';
import { InstanceStore } from '../state/instance.store';

/**
 * Wave 2 — register select-visible-instance-1..9 and picker actions against
 * the global ActionDispatchService. Called once during app bootstrap (app.component
 * ngOnInit, after PromptHistoryStore.init()).
 */
export function registerNavigationActions(): void {
  const dispatch = inject(ActionDispatchService);
  const resolver = inject(VisibleInstanceResolver);
  const instanceStore = inject(InstanceStore);

  for (let n = 1; n <= 9; n++) {
    dispatch.register({
      id: `select-visible-instance-${n}`,
      when: ['multiple-instances'],
      run: () => {
        const id = resolver.getInstanceIdAt(n);
        if (id) instanceStore.setSelected(id);
      },
    });
  }
}
```

> Picker actions (`open-session-picker`, `open-model-picker`, `open-prompt-history-search`) are registered by their respective host components in Phases 10–12; we only register the navigation actions here.

- [ ] **Step 4: Wire the call from `app.component.ts`**

Open `src/renderer/app/app.component.ts`. After the `PromptHistoryStore.init()` call:

```ts
import { registerNavigationActions } from './core/services/navigation-actions';

// inside ngOnInit, after promptHistoryStore.init():
registerNavigationActions();
```

> `registerNavigationActions` calls `inject()` from inside a function, which works because Angular's DI is in scope when `app.component.ts` invokes it during `ngOnInit`. If you prefer, refactor to a service that does the work in its constructor.

- [ ] **Step 5: Run, type-check, lint, commit**

```bash
npx vitest run src/renderer/app/core/services/__tests__/action-dispatch.navigation.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/renderer/app/core/services/navigation-actions.ts
git add src/renderer/app/core/services/navigation-actions.ts src/renderer/app/core/services/__tests__/action-dispatch.navigation.spec.ts src/renderer/app/app.component.ts
git commit -m "feat(navigation): register select-visible-instance-1..9 actions"
```

---

### Task 7.2: Add a focused test for the keybinding service's input-context gate

**Files:**
- Create: `src/renderer/app/core/services/__tests__/keybinding.service.spec.ts`

> `keybinding.service.ts` does not currently have a unit spec. Wave 2's numeric hotkeys depend on the existing input-context safeguard (lines 130–135) to allow modifier-bearing combos to fire even with the textarea focused. Pin that behaviour with a test.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/core/services/__tests__/keybinding.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NgZone } from '@angular/core';
import { KeyBindingService } from '../keybinding.service';
import { ActionDispatchService } from '../action-dispatch.service';

describe('KeyBindingService — input-context gate (modifier-bearing keys)', () => {
  let svc: KeyBindingService;
  let dispatch: ActionDispatchService;
  let dispatched: string[] = [];

  beforeEach(() => {
    dispatched = [];
    TestBed.configureTestingModule({
      providers: [
        KeyBindingService,
        { provide: NgZone, useValue: { run: (fn: () => unknown) => fn() } },
      ],
    });
    svc = TestBed.inject(KeyBindingService);
    dispatch = TestBed.inject(ActionDispatchService);
    dispatch.setState({ multipleInstances: true });
    vi.spyOn(dispatch, 'dispatch').mockImplementation(async (action) => { dispatched.push(action); return true; });
  });

  it('dispatches Cmd+3 even with textarea focus (modifier present)', () => {
    const target = document.createElement('textarea');
    document.body.appendChild(target);
    target.focus();

    const event = new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true });
    Object.defineProperty(event, 'target', { value: target });
    target.dispatchEvent(event);

    // After the bubble, the global handler should have fired.
    expect(dispatched).toContain('select-visible-instance-3');
    target.remove();
  });

  it('does NOT dispatch plain "3" with textarea focus (no modifier)', () => {
    const target = document.createElement('textarea');
    document.body.appendChild(target);
    target.focus();

    const event = new KeyboardEvent('keydown', { key: '3', bubbles: true });
    Object.defineProperty(event, 'target', { value: target });
    target.dispatchEvent(event);

    expect(dispatched).not.toContain('select-visible-instance-3');
    target.remove();
  });
});
```

> The test relies on `KeyBindingService` listening on the document. If the service registers the listener in its constructor or in an `init()` method called by the app, ensure that path runs in the test (`TestBed.inject(KeyBindingService)` triggers the constructor). If `init()` is required, call it explicitly.

- [ ] **Step 2: Run and confirm pass (this is a regression-pin, not a feature)**

```bash
npx vitest run src/renderer/app/core/services/__tests__/keybinding.service.spec.ts
```

Expected: pass. The behaviour already exists — we are pinning it so a future change doesn't accidentally regress numeric-hotkey behaviour.

If the test fails because the service does not auto-listen on `document` in the test environment, add an `init()`-style call in the test setup that mirrors what the app does at bootstrap.

- [ ] **Step 3: Commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/renderer/app/core/services/__tests__/keybinding.service.spec.ts
git commit -m "test(keybindings): pin input-context gate for modifier-bearing hotkeys"
```

---

## Phase 8 — Instance-list debounce + resolver integration

### Task 8.1: TDD — write failing test for filter debounce

**Files:**
- Create: `src/renderer/app/features/instance-list/__tests__/instance-list.debounce.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/features/instance-list/__tests__/instance-list.debounce.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InstanceListComponent } from '../instance-list.component';

describe('InstanceListComponent.setFilterText debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [InstanceListComponent] });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('debounces filterText updates by 250 ms', () => {
    const fixture = TestBed.createComponent(InstanceListComponent);
    const cmp = fixture.componentInstance;

    cmp.setFilterText('a');
    cmp.setFilterText('ab');
    cmp.setFilterText('abc');
    expect(cmp.filterText()).toBe('');

    vi.advanceTimersByTime(249);
    expect(cmp.filterText()).toBe('');

    vi.advanceTimersByTime(2);
    expect(cmp.filterText()).toBe('abc');
  });

  it('updates raw signal immediately for input binding', () => {
    const fixture = TestBed.createComponent(InstanceListComponent);
    const cmp = fixture.componentInstance;
    cmp.setFilterText('hello');
    expect(cmp.rawFilterText()).toBe('hello');
  });
});
```

> The component pulls in many services. If the test fails because of missing providers (e.g. `InstanceStore`), set them up via `TestBed.configureTestingModule({ providers: [...] })` with mocks. Use the existing `instance-list.store.spec.ts` pattern as a reference.

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/renderer/app/features/instance-list/__tests__/instance-list.debounce.spec.ts
```

Expected: FAIL — `setFilterText` / `rawFilterText` not defined.

- [ ] **Step 3: Commit failing test**

```bash
git add src/renderer/app/features/instance-list/__tests__/instance-list.debounce.spec.ts
git commit -m "test(instance-list): add failing filter-debounce spec (red)"
```

---

### Task 8.2: Implement debounce + resolver wiring

**Files:**
- Modify: `src/renderer/app/features/instance-list/instance-list.component.ts`
- Modify: `src/renderer/app/features/instance-list/instance-list.component.html`

- [ ] **Step 1: Replace the raw `filterText` signal with debounce-friendly versions**

Open `src/renderer/app/features/instance-list/instance-list.component.ts`. Currently `filterText = signal<string>('')` is bound directly to the input. Change it to:

```ts
private _rawFilterText = signal<string>('');
private filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
filterText = signal<string>('');
rawFilterText = this._rawFilterText.asReadonly();

setFilterText(value: string): void {
  this._rawFilterText.set(value);
  if (this.filterDebounceTimer !== null) {
    clearTimeout(this.filterDebounceTimer);
  }
  this.filterDebounceTimer = setTimeout(() => {
    this.filterText.set(this._rawFilterText());
    this.filterDebounceTimer = null;
  }, 250);
}

ngOnDestroy(): void {
  if (this.filterDebounceTimer !== null) {
    clearTimeout(this.filterDebounceTimer);
    this.filterDebounceTimer = null;
  }
}
```

> If `InstanceListComponent` already implements `OnDestroy`, merge the cleanup into the existing method instead of replacing.

Inside the constructor (or after the existing `effect()` block), wire the resolver:

```ts
import { VisibleInstanceResolver } from '../../core/services/visible-instance-resolver.service';

private resolver = inject(VisibleInstanceResolver);

constructor() {
  // existing constructor body...
  this.resolver.setProjectGroupsSource(this.projectGroups);
}
```

- [ ] **Step 2: Update the template**

Open `src/renderer/app/features/instance-list/instance-list.component.html`. Find the filter input element. Change its bindings from:

```html
<input ... [value]="filterText()" (input)="filterText.set($any($event.target).value)" />
```

to:

```html
<input ... [value]="rawFilterText()" (input)="setFilterText($any($event.target).value)" />
```

> The exact attribute syntax may differ in the existing template; preserve any other bindings (placeholder, classes, aria, etc.).

- [ ] **Step 3: Run the tests and confirm they pass**

```bash
npx vitest run src/renderer/app/features/instance-list/__tests__/instance-list.debounce.spec.ts
```

Expected: pass. If the resolver wiring causes a circular dep error, ensure `VisibleInstanceResolver` is `providedIn: 'root'` (it is — `Injectable({ providedIn: 'root' })`).

- [ ] **Step 4: Manual smoke**

```bash
npm run dev
```

Type fast in the rail filter input. Observe the rail does not jank. (Open the browser dev-tools profiler if needed.)

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/renderer/app/features/instance-list/instance-list.component.ts
git add src/renderer/app/features/instance-list/instance-list.component.ts src/renderer/app/features/instance-list/instance-list.component.html
git commit -m "feat(instance-list): debounce filter (250ms) + wire VisibleInstanceResolver"
```

---

## Phase 9 — Input-panel Up/Down/Ctrl+R recall with stash/restore

### Task 9.1: Implement the caret-position utility

**Files:**
- Create: `src/renderer/app/core/services/textarea-caret-position.util.ts`
- Create: `src/renderer/app/core/services/__tests__/textarea-caret-position.util.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/core/services/__tests__/textarea-caret-position.util.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isCaretOnFirstVisualLine, isCaretOnLastVisualLine } from '../textarea-caret-position.util';

describe('textarea caret position utility', () => {
  let textarea: HTMLTextAreaElement;
  beforeEach(() => {
    textarea = document.createElement('textarea');
    Object.assign(textarea.style, { width: '200px', fontFamily: 'monospace', fontSize: '14px', lineHeight: '20px', padding: '4px', boxSizing: 'border-box' });
    document.body.appendChild(textarea);
  });
  afterEach(() => { textarea.remove(); });

  it('returns true for empty textarea (caret at 0)', () => {
    textarea.value = '';
    textarea.selectionStart = textarea.selectionEnd = 0;
    expect(isCaretOnFirstVisualLine(textarea)).toBe(true);
    expect(isCaretOnLastVisualLine(textarea)).toBe(true);
  });

  it('returns true at start of first line of multi-line text', () => {
    textarea.value = 'first\nsecond';
    textarea.selectionStart = textarea.selectionEnd = 0;
    expect(isCaretOnFirstVisualLine(textarea)).toBe(true);
  });

  it('returns false on second logical line', () => {
    textarea.value = 'first\nsecond';
    textarea.selectionStart = textarea.selectionEnd = 6; // cursor on "second"
    expect(isCaretOnFirstVisualLine(textarea)).toBe(false);
  });

  it('returns true at end of last line', () => {
    textarea.value = 'first\nsecond';
    textarea.selectionStart = textarea.selectionEnd = 12; // end of "second"
    expect(isCaretOnLastVisualLine(textarea)).toBe(true);
  });
});
```

> jsdom does not implement layout, so wrap-detection cannot be tested fully in the unit env. The tests above only exercise newline-based logical-line behaviour. The visual-wrap path is exercised manually in Phase 13.

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/renderer/app/core/services/__tests__/textarea-caret-position.util.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the utility**

Create `src/renderer/app/core/services/textarea-caret-position.util.ts`:

```ts
/**
 * Caret-position helpers for textarea recall semantics. Only triggers on
 * the *visual* boundary line — the topmost wrapped row of the first logical
 * line for "first", and the bottommost wrapped row of the last logical line
 * for "last".
 *
 * Strategy: a hidden mirror div with the same font/padding/width renders the
 * substring up to (or after) the caret, and its measured height is compared
 * to one line-height. This works for both wrapped and unwrapped lines.
 */

let mirror: HTMLDivElement | null = null;

function getMirror(): HTMLDivElement {
  if (mirror) return mirror;
  mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position: 'absolute',
    top: '-9999px',
    left: '-9999px',
    visibility: 'hidden',
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    overflow: 'hidden',
  });
  document.body.appendChild(mirror);
  return mirror;
}

function copyStyles(src: HTMLTextAreaElement, dst: HTMLDivElement): void {
  const cs = window.getComputedStyle(src);
  const props: (keyof CSSStyleDeclaration)[] = [
    'font', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'letterSpacing', 'wordSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'lineHeight', 'tabSize', 'textTransform',
    'boxSizing',
  ];
  for (const p of props) {
    (dst.style as unknown as Record<string, string>)[p as string] = cs[p] as string;
  }
  dst.style.width = cs.width;
}

function singleLineHeight(el: HTMLTextAreaElement): number {
  const cs = window.getComputedStyle(el);
  const lh = cs.lineHeight;
  if (lh && lh !== 'normal' && lh.endsWith('px')) return parseFloat(lh);
  // Fallback: 1.2 × fontSize.
  const fs = parseFloat(cs.fontSize) || 16;
  return Math.round(fs * 1.2);
}

export function isCaretOnFirstVisualLine(el: HTMLTextAreaElement): boolean {
  const caret = el.selectionStart ?? 0;
  const before = el.value.slice(0, caret);
  if (!before.includes('\n') && !needsWrapMeasure(el)) return true;

  const m = getMirror();
  copyStyles(el, m);
  m.textContent = before || '​';
  const lh = singleLineHeight(el);
  return m.clientHeight <= lh + 1;
}

export function isCaretOnLastVisualLine(el: HTMLTextAreaElement): boolean {
  const caret = el.selectionEnd ?? el.value.length;
  const after = el.value.slice(caret);
  if (!after.includes('\n') && !needsWrapMeasure(el)) return true;

  const m = getMirror();
  copyStyles(el, m);
  m.textContent = after || '​';
  const lh = singleLineHeight(el);
  return m.clientHeight <= lh + 1;
}

function needsWrapMeasure(el: HTMLTextAreaElement): boolean {
  // Quick out for short, unwrapped values.
  return el.value.length > 100 || /\n/.test(el.value);
}
```

- [ ] **Step 4: Run, type-check, commit**

```bash
npx vitest run src/renderer/app/core/services/__tests__/textarea-caret-position.util.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/renderer/app/core/services/textarea-caret-position.util.ts src/renderer/app/core/services/__tests__/textarea-caret-position.util.spec.ts
git commit -m "feat(input): add textarea caret-position utility for first/last visual line detection"
```

---

### Task 9.2: TDD — write failing tests for input-panel recall

**Files:**
- Create: `src/renderer/app/features/instance-detail/__tests__/input-panel-recall.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/features/instance-detail/__tests__/input-panel-recall.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InputPanelComponent } from '../input-panel.component';
import { PromptHistoryStore } from '../../../core/state/prompt-history.store';
import { DraftService } from '../../../core/services/draft.service';

describe('InputPanelComponent — recall', () => {
  let cmp: InputPanelComponent;
  let store: PromptHistoryStore;
  let drafts: DraftService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [InputPanelComponent],
      providers: [PromptHistoryStore, DraftService],
    });
    const fixture = TestBed.createComponent(InputPanelComponent);
    cmp = fixture.componentInstance;
    store = TestBed.inject(PromptHistoryStore);
    drafts = TestBed.inject(DraftService);
    fixture.componentRef.setInput('instanceId', 'inst-1');
    // Seed history.
    store.record({ instanceId: 'inst-1', id: '1', text: 'first', createdAt: 1 });
    store.record({ instanceId: 'inst-1', id: '2', text: 'second', createdAt: 2 });
  });

  it('Up on first visual line replaces text with most-recent entry and stashes draft', () => {
    cmp.message.set('WIP draft');
    const ok = cmp.tryRecallPrev({ caretAtFirstVisualLine: true });
    expect(ok).toBe(true);
    expect(cmp.message()).toBe('second');
    expect(drafts.getDraft('__recall_stash__:inst-1')).toBe('WIP draft');
  });

  it('Up steps further back through history', () => {
    cmp.message.set('WIP draft');
    cmp.tryRecallPrev({ caretAtFirstVisualLine: true });
    cmp.tryRecallPrev({ caretAtFirstVisualLine: true });
    expect(cmp.message()).toBe('first');
  });

  it('Esc restores stash and exits recall', () => {
    cmp.message.set('WIP draft');
    cmp.tryRecallPrev({ caretAtFirstVisualLine: true });
    cmp.cancelRecall();
    expect(cmp.message()).toBe('WIP draft');
    expect(drafts.getDraft('__recall_stash__:inst-1')).toBe('');
  });

  it('Up does NOT trigger when caret not on first visual line', () => {
    cmp.message.set('WIP draft');
    const ok = cmp.tryRecallPrev({ caretAtFirstVisualLine: false });
    expect(ok).toBe(false);
    expect(cmp.message()).toBe('WIP draft');
  });

  it('Send clears stash and exits recall', () => {
    cmp.message.set('');
    cmp.tryRecallPrev({ caretAtFirstVisualLine: true });
    cmp.commitRecallToActiveDraft();
    expect(drafts.getDraft('__recall_stash__:inst-1')).toBe('');
    expect(cmp['recallState']()).toBeNull();
  });
});
```

> The component spec will require many providers; mock-out non-essential ones via `TestBed.overrideComponent` if needed. Helpers `tryRecallPrev`, `cancelRecall`, `commitRecallToActiveDraft` are testing seams — see Step 3.

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/renderer/app/features/instance-detail/__tests__/input-panel-recall.spec.ts
```

Expected: FAIL — methods not defined.

- [ ] **Step 3: Commit failing test**

```bash
git add src/renderer/app/features/instance-detail/__tests__/input-panel-recall.spec.ts
git commit -m "test(input-panel): add failing recall spec (red)"
```

---

### Task 9.3: Implement recall in `InputPanelComponent`

**Files:**
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.html` (only if keydown wiring isn't already present — likely a no-op for HTML)

- [ ] **Step 1: Add the recall state, store, and helpers**

Open `src/renderer/app/features/instance-detail/input-panel.component.ts`. Add the imports:

```ts
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import {
  isCaretOnFirstVisualLine,
  isCaretOnLastVisualLine,
} from '../../core/services/textarea-caret-position.util';
import {
  PROMPT_HISTORY_STASH_KEY_PREFIX,
  type PromptHistoryEntry,
  createPromptHistoryEntryId,
} from '../../../../shared/types/prompt-history.types';
```

Inject the store:

```ts
private promptHistoryStore = inject(PromptHistoryStore);
```

Add the recall-state signal and helpers near the other signals (around `editMode`, `stashedDraft`):

```ts
private recallState = signal<{
  active: boolean;
  index: number;
  stashedDraft: string;
} | null>(null);

private stashKey(): string {
  return `${PROMPT_HISTORY_STASH_KEY_PREFIX}${this.instanceId()}`;
}

/** Seam for tests — caller asserts caret position outside (jsdom can't measure layout). */
tryRecallPrev(opts?: { caretAtFirstVisualLine?: boolean }): boolean {
  const at = opts?.caretAtFirstVisualLine
    ?? (this.textareaRef()?.nativeElement
        ? isCaretOnFirstVisualLine(this.textareaRef()!.nativeElement)
        : true);
  if (!at) return false;

  const entries = this.promptHistoryStore.getEntriesForInstance(this.instanceId());
  if (entries.length === 0) return false;

  const state = this.recallState();
  if (!state || !state.active) {
    const stashed = this.message();
    this.draftService.setDraft(this.stashKey(), stashed);
    this.recallState.set({ active: true, index: 0, stashedDraft: stashed });
    this.message.set(entries[0].text);
    return true;
  }

  const next = Math.min(state.index + 1, entries.length - 1);
  this.recallState.set({ ...state, index: next });
  this.message.set(entries[next].text);
  return true;
}

tryRecallNext(opts?: { caretAtLastVisualLine?: boolean }): boolean {
  const state = this.recallState();
  if (!state || !state.active) return false;
  const at = opts?.caretAtLastVisualLine
    ?? (this.textareaRef()?.nativeElement
        ? isCaretOnLastVisualLine(this.textareaRef()!.nativeElement)
        : true);
  if (!at) return false;

  const entries = this.promptHistoryStore.getEntriesForInstance(this.instanceId());
  const next = state.index - 1;
  if (next < 0) {
    // restore stash
    this.message.set(state.stashedDraft);
    this.recallState.set(null);
    this.draftService.clearDraft(this.stashKey());
    return true;
  }
  this.recallState.set({ ...state, index: next });
  this.message.set(entries[next].text);
  return true;
}

cancelRecall(): void {
  const state = this.recallState();
  if (!state || !state.active) return;
  this.message.set(state.stashedDraft);
  this.recallState.set(null);
  this.draftService.clearDraft(this.stashKey());
}

commitRecallToActiveDraft(): void {
  const state = this.recallState();
  if (!state || !state.active) return;
  this.recallState.set(null);
  this.draftService.clearDraft(this.stashKey());
}

/** Called by the parent's successful-send flow to record the prompt. */
recordSentPrompt(text: string): void {
  this.promptHistoryStore.record({
    instanceId: this.instanceId(),
    id: createPromptHistoryEntryId(),
    text,
    createdAt: Date.now(),
    projectPath: this.workingDirectory?.() ?? undefined,
    provider: this.provider(),
    model: this.currentModel(),
    wasSlashCommand: text.trim().startsWith('/'),
  });
}
```

- [ ] **Step 2: Wire keydown handlers**

In the existing `onKeyDown` (or wherever the textarea's keydown is handled), add early branches:

```ts
// Top of onKeyDown, before existing slash-suggestion logic:

if (event.key === 'Escape' && this.recallState()?.active) {
  event.preventDefault();
  this.cancelRecall();
  return;
}

if (event.key === 'ArrowUp' && !event.shiftKey && !event.metaKey && !event.altKey) {
  if (this.tryRecallPrev()) {
    event.preventDefault();
    return;
  }
}

if (event.key === 'ArrowDown' && !event.shiftKey && !event.metaKey && !event.altKey) {
  if (this.tryRecallNext()) {
    event.preventDefault();
    return;
  }
}
```

> Place this **above** any existing arrow-key handling for slash suggestions. `tryRecallPrev`/`tryRecallNext` short-circuit (return `false`) when not in recall mode AND not on the boundary line, so they don't interfere with normal arrow-key navigation.

- [ ] **Step 3: Wire `recordSentPrompt` to the existing send flow**

Find where `sendMessage.emit(text)` is invoked (or the equivalent confirmation path that the parent uses). After a successful send (and before clearing the textarea), call:

```ts
this.recordSentPrompt(textToSend);
this.commitRecallToActiveDraft();
```

> The exact placement depends on the existing flow. Trace the existing `sendMessage` emit and add the call at the moment the parent has accepted the message (typically right before `this.message.set('')`).

- [ ] **Step 4: Wire instance-switch effect**

Add an effect inside the constructor:

```ts
constructor() {
  // existing constructor body...
  effect(() => {
    const id = this.instanceId();
    untracked(() => {
      // On any instance switch, exit recall and clear the stash for the LEAVING instance.
      // (We can't know the previous id directly, so only restore-and-exit if active.)
      if (this.recallState()?.active) {
        this.cancelRecall();
      }
    });
    return () => { /* nothing additional */ };
  });
}
```

> Angular's `effect()` cleanup is not literal-callback shape; use `effect()` plus a tracked-vs-untracked split as above.

- [ ] **Step 5: Run, type-check, lint, commit**

```bash
npx vitest run src/renderer/app/features/instance-detail/__tests__/input-panel-recall.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/renderer/app/features/instance-detail/input-panel.component.ts
git add src/renderer/app/features/instance-detail/input-panel.component.ts src/renderer/app/features/instance-detail/input-panel.component.html
git commit -m "feat(input-panel): cursor-aware Up/Down recall with stash/restore"
```

---

## Phase 10 — `SessionPickerController` + host

### Task 10.1: TDD — write failing tests for `SessionPickerController`

**Files:**
- Create: `src/renderer/app/features/overlay-modes/__tests__/session-picker.controller.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/features/overlay-modes/__tests__/session-picker.controller.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { SessionPickerController } from '../session-picker.controller';
import { InstanceStore } from '../../../core/state/instance.store';
import { HistoryStore } from '../../../core/state/history.store';
import { UsageStore } from '../../../core/state/usage.store';

describe('SessionPickerController', () => {
  let ctrl: SessionPickerController;
  let usage: UsageStore;
  let instances: InstanceStore;
  let history: HistoryStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [SessionPickerController, InstanceStore, HistoryStore, UsageStore],
    });
    ctrl = TestBed.inject(SessionPickerController);
    usage = TestBed.inject(UsageStore);
    instances = TestBed.inject(InstanceStore);
    history = TestBed.inject(HistoryStore);

    vi.spyOn(instances, 'instances').mockReturnValue([
      { id: 'i-1', displayName: 'Alpha', provider: 'claude', status: 'idle', lastActivity: 100 } as never,
      { id: 'i-2', displayName: 'Beta', provider: 'gemini', status: 'busy', lastActivity: 200 } as never,
    ]);
    vi.spyOn(history, 'entries').mockReturnValue(signal([
      { id: 'h-1', title: 'past', endedAt: 50, workingDirectory: '/p' } as never,
    ])() as never);
    vi.spyOn(usage, 'frecency').mockImplementation((id: string) => id === 'i-1' ? 5 : 0);
  });

  it('lists live instances and history entries grouped by kind', () => {
    const groups = ctrl.groups();
    const ids = groups.flatMap(g => g.items).map(i => i.id);
    expect(ids).toEqual(expect.arrayContaining(['i-1', 'i-2', 'h-1']));
  });

  it('ranks higher-frecency live items above lower', () => {
    const liveGroup = ctrl.groups().find(g => g.label === 'Active');
    expect(liveGroup).toBeDefined();
    expect(liveGroup!.items[0].id).toBe('i-1'); // higher frecency wins
  });

  it('filters by query (substring on title/subtitle)', () => {
    ctrl.setQuery('alpha');
    const ids = ctrl.groups().flatMap(g => g.items).map(i => i.id);
    expect(ids).toEqual(['i-1']);
  });

  it('run() on a live item selects it', async () => {
    const setSelected = vi.spyOn(instances, 'setSelected').mockImplementation(() => {});
    const item = ctrl.groups().flatMap(g => g.items).find(i => i.id === 'i-1')!;
    const ok = await ctrl.run(item);
    expect(ok).toBe(true);
    expect(setSelected).toHaveBeenCalledWith('i-1');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/renderer/app/features/overlay-modes/__tests__/session-picker.controller.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Commit failing test**

```bash
git add src/renderer/app/features/overlay-modes/__tests__/session-picker.controller.spec.ts
git commit -m "test(session-picker): add failing controller spec (red)"
```

---

### Task 10.2: Implement `SessionPickerController`

**Files:**
- Create: `src/renderer/app/features/overlay-modes/session-picker.controller.ts`

- [ ] **Step 1: Implement**

Create `src/renderer/app/features/overlay-modes/session-picker.controller.ts`:

```ts
import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import type {
  OverlayController,
  OverlayGroup,
  OverlayItem,
  FooterHint,
  OverlayControllerError,
} from '../../shared/overlay-shell/overlay-controller';
import type { SessionPickerItem } from '../../../../shared/types/prompt-history.types';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';
import { UsageStore } from '../../core/state/usage.store';

@Injectable({ providedIn: 'root' })
export class SessionPickerController implements OverlayController<SessionPickerItem> {
  private instanceStore = inject(InstanceStore);
  private historyStore = inject(HistoryStore);
  private usageStore = inject(UsageStore);

  readonly id = 'session-picker';
  readonly modeLabel = 'Sessions';
  readonly placeholder = 'Switch session...';

  private _query = signal('');
  private _selectedKey = signal<string | null>(null);
  readonly query = this._query.asReadonly();
  readonly selectedKey = this._selectedKey.asReadonly();
  readonly loading = computed(() => false);

  private _lastError = signal<OverlayControllerError | null>(null);
  readonly lastError = this._lastError.asReadonly();
  clearError(): void { this._lastError.set(null); }

  readonly footerHints = computed<FooterHint[]>(() => [
    { keys: ['↑', '↓'], label: 'Navigate' },
    { keys: ['⏎'], label: 'Open' },
    { keys: ['Esc'], label: 'Close' },
  ]);

  private items = computed<SessionPickerItem[]>(() => {
    const live: SessionPickerItem[] = (this.instanceStore.instances() ?? []).map(inst => ({
      id: inst.id,
      title: inst.displayName,
      subtitle: `${inst.provider ?? 'unknown'} — ${inst.status ?? ''}`.trim(),
      projectPath: inst.workingDirectory ?? undefined,
      provider: inst.provider,
      kind: 'live',
      lastActivity: inst.lastActivity,
      frecencyScore: this.usageStore.frecency(inst.id, inst.workingDirectory ?? undefined),
    }));
    const history: SessionPickerItem[] = (this.historyStore.entries()() ?? []).map(h => ({
      id: h.id,
      title: h.title ?? 'History entry',
      subtitle: h.workingDirectory,
      projectPath: h.workingDirectory ?? undefined,
      kind: 'history',
      lastActivity: h.endedAt,
      frecencyScore: this.usageStore.frecency(h.id, h.workingDirectory ?? undefined),
    }));
    return [...live, ...history];
  });

  readonly groups = computed<OverlayGroup<SessionPickerItem>[]>(() => {
    const q = this._query().trim().toLowerCase();
    const filter = (item: SessionPickerItem) =>
      !q || item.title.toLowerCase().includes(q) || (item.subtitle ?? '').toLowerCase().includes(q);
    const sorted = (arr: SessionPickerItem[]) =>
      arr.sort((a, b) =>
        (b.frecencyScore - a.frecencyScore) ||
        ((b.lastActivity ?? 0) - (a.lastActivity ?? 0)) ||
        a.title.localeCompare(b.title),
      );

    const live = sorted(this.items().filter(i => i.kind === 'live').filter(filter));
    const history = sorted(this.items().filter(i => i.kind === 'history').filter(filter));

    const toItem = (i: SessionPickerItem): OverlayItem<SessionPickerItem> => ({
      id: i.id,
      primary: i.title,
      secondary: i.subtitle,
      rightHint: i.provider,
      data: i,
    });

    const groups: OverlayGroup<SessionPickerItem>[] = [];
    if (live.length > 0) groups.push({ id: 'live', label: 'Active', items: live.map(toItem) });
    if (history.length > 0) groups.push({ id: 'history', label: 'History', items: history.map(toItem) });
    return groups;
  });

  setQuery(q: string): void { this._query.set(q); this._selectedKey.set(null); }
  setSelectedKey(id: string | null): void { this._selectedKey.set(id); }

  async run(item: OverlayItem<SessionPickerItem>): Promise<boolean> {
    const data = item.data;
    if (data.kind === 'live') {
      this.instanceStore.setSelected(data.id);
      this.usageStore.record('sessions', data.id, data.projectPath);
      return true;
    }
    if (data.kind === 'history') {
      // Resume action — delegate to HistoryStore (the existing pattern).
      const ok = await this.historyStore.resumeEntry(data.id);
      if (ok) {
        this.usageStore.record('sessions', data.id, data.projectPath);
        return true;
      }
      this._lastError.set({ kind: 'execute-failed', message: 'Failed to resume history entry.' });
      return false;
    }
    return false;
  }
}
```

> Wave 1's `UsageTracker` ships category-aware (`record(category, id, projectPath?)`, `getFrecency(category, id, ...)`). The renderer-side `UsageStore` mirrors that API. Use `record('sessions', ...)` here and `getFrecency('sessions', ...)` for ranking — no Wave 2 migration is needed. If you ever need to introduce a brand-new category mid-Wave-2, just call `record('newCategory', ...)` — the underlying store creates the bucket lazily.

- [ ] **Step 2: Run, type-check, commit**

```bash
npx vitest run src/renderer/app/features/overlay-modes/__tests__/session-picker.controller.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/renderer/app/features/overlay-modes/session-picker.controller.ts
git commit -m "feat(session-picker): implement SessionPickerController on overlay shell"
```

---

### Task 10.3: Implement `SessionPickerHostComponent`

**Files:**
- Create: `src/renderer/app/features/overlay-modes/session-picker.host.component.ts`

- [ ] **Step 1: Implement**

Create `src/renderer/app/features/overlay-modes/session-picker.host.component.ts`:

```ts
import { Component, ChangeDetectionStrategy, computed, inject, output } from '@angular/core';
import { OverlayShellComponent } from '../../shared/overlay-shell/overlay-shell.component';
import { SessionPickerController } from './session-picker.controller';
import type { OverlayItem } from '../../shared/overlay-shell/overlay-controller';
import type { SessionPickerItem } from '../../../../shared/types/prompt-history.types';

@Component({
  selector: 'app-session-picker-host',
  standalone: true,
  imports: [OverlayShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-overlay-shell
      [groups]="controller.groups()"
      [query]="controller.query()"
      [placeholder]="controller.placeholder"
      [selectedKey]="controller.selectedKey()"
      [footerHints]="controller.footerHints()"
      [loading]="controller.loading()"
      modeLabel="Sessions"
      (queryChange)="controller.setQuery($event)"
      (selectedKeyChange)="controller.setSelectedKey($event)"
      (select)="onSelect($event)"
      (close)="closeRequested.emit()"
    >
      @if (controller.lastError(); as err) {
        <div bannerSlot class="overlay-banner overlay-banner--{{ err.kind }}">
          {{ err.message }}
          <button (click)="controller.clearError()">×</button>
        </div>
      }
    </app-overlay-shell>
  `,
})
export class SessionPickerHostComponent {
  controller = inject(SessionPickerController);
  closeRequested = output<void>();

  async onSelect(item: OverlayItem<SessionPickerItem>): Promise<void> {
    const ok = await this.controller.run(item);
    if (ok) this.closeRequested.emit();
  }
}
```

- [ ] **Step 2: Wire the dispatcher action**

The `open-session-picker` keybinding must mount this host. Mirror Wave 1's pattern for `app.open-command-help` — locate that registration in the codebase (search for `app.open-command-help` after Wave 1 lands), and add a sibling case for `open-session-picker` that mounts `SessionPickerHostComponent`.

- [ ] **Step 3: Manual verify**

```bash
npm run dev
```

Press `Cmd/Ctrl+O`. Picker opens. Type a substring. Pick a live item. Picker closes; instance is selected.

- [ ] **Step 4: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/overlay-modes/session-picker.host.component.ts
git add src/renderer/app/features/overlay-modes/session-picker.host.component.ts
# include the dispatcher file you modified
git commit -m "feat(session-picker): add SessionPickerHostComponent + Cmd/Ctrl+O wiring"
```

---

## Phase 11 — `ModelPickerController` + host

> Phase 11 follows Phase 10 because session-picker validates the controller pattern first. Phase 11 is **not** gated — it is mandatory Wave 2 scope. The parent plan's "only after overlay shell ranking is proven by command/session pickers" wording is a temporal sequencing note (run Phase 10 before Phase 11), not a scope-cut gate (it does NOT mean "skip if scope tight"). Per design § 0 decision #10 and § 6.6, both pickers ship in Wave 2; only the Phase 12 Ctrl+R reverse-search modal remains gated.

### Task 11.1: TDD — write failing tests for `ModelPickerController`

**Files:**
- Create: `src/renderer/app/features/overlay-modes/__tests__/model-picker.controller.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/features/overlay-modes/__tests__/model-picker.controller.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelPickerController } from '../model-picker.controller';
import { ProviderStateService } from '../../../core/services/provider-state.service';
import { InstanceStore } from '../../../core/state/instance.store';

describe('ModelPickerController', () => {
  let ctrl: ModelPickerController;
  let providerState: ProviderStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ModelPickerController, ProviderStateService, InstanceStore],
    });
    ctrl = TestBed.inject(ModelPickerController);
    providerState = TestBed.inject(ProviderStateService);

    vi.spyOn(providerState, 'selectedProvider').mockReturnValue('claude' as never);
    vi.spyOn(providerState as never, 'allModels' as never).mockImplementation(() => ([
      { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', group: 'claude', kind: 'model', available: true },
      { id: 'gemini-pro',         label: 'Gemini Pro',        group: 'gemini', kind: 'model', available: false, disabledReason: 'Requires gemini provider' },
    ]) as never);
  });

  it('groups by provider/group field', () => {
    const groups = ctrl.groups();
    expect(groups.find(g => g.label === 'claude')).toBeDefined();
    expect(groups.find(g => g.label === 'gemini')).toBeDefined();
  });

  it('marks incompatible items as disabled with reason', () => {
    const all = ctrl.groups().flatMap(g => g.items);
    const gemini = all.find(i => i.id === 'gemini-pro');
    expect(gemini?.disabled).toBe(true);
    expect(gemini?.disabledReason).toContain('gemini');
  });

  it('run() on a disabled item refuses with error', async () => {
    const item = ctrl.groups().flatMap(g => g.items).find(i => i.id === 'gemini-pro')!;
    const ok = await ctrl.run(item);
    expect(ok).toBe(false);
    expect(ctrl.lastError()?.kind).toBe('disabled');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/renderer/app/features/overlay-modes/__tests__/model-picker.controller.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Commit failing test**

```bash
git add src/renderer/app/features/overlay-modes/__tests__/model-picker.controller.spec.ts
git commit -m "test(model-picker): add failing controller spec (red)"
```

---

### Task 11.2: Implement `ModelPickerController` and host

**Files:**
- Create: `src/renderer/app/features/overlay-modes/model-picker.controller.ts`
- Create: `src/renderer/app/features/overlay-modes/model-picker.host.component.ts`

- [ ] **Step 1: Implement the controller**

Create `src/renderer/app/features/overlay-modes/model-picker.controller.ts`:

```ts
import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  OverlayController, OverlayGroup, OverlayItem, FooterHint, OverlayControllerError,
} from '../../shared/overlay-shell/overlay-controller';
import type { ModelPickerItem } from '../../../../shared/types/prompt-history.types';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { InstanceStore } from '../../core/state/instance.store';

@Injectable({ providedIn: 'root' })
export class ModelPickerController implements OverlayController<ModelPickerItem> {
  private providerState = inject(ProviderStateService);
  private instanceStore = inject(InstanceStore);

  readonly id = 'model-picker';
  readonly modeLabel = 'Models';
  readonly placeholder = 'Switch model...';

  private _query = signal('');
  private _selectedKey = signal<string | null>(null);
  readonly query = this._query.asReadonly();
  readonly selectedKey = this._selectedKey.asReadonly();
  readonly loading = computed(() => false);

  private _lastError = signal<OverlayControllerError | null>(null);
  readonly lastError = this._lastError.asReadonly();
  clearError(): void { this._lastError.set(null); }

  readonly footerHints = computed<FooterHint[]>(() => [
    { keys: ['↑', '↓'], label: 'Navigate' },
    { keys: ['⏎'], label: 'Apply' },
    { keys: ['Esc'], label: 'Close' },
  ]);

  /**
   * Source of items: every model and agent the provider state service knows about.
   * `available` is set by ProviderStateService based on the active provider; if
   * Wave 1's ProviderStateService doesn't expose `allModels()` yet, add the small
   * adapter inside this controller (TODO marker — defer to a follow-up wave if needed).
   */
  private items = computed<ModelPickerItem[]>(() => {
    const allModels = (this.providerState as unknown as { allModels?: () => ModelPickerItem[] }).allModels?.() ?? [];
    return allModels;
  });

  readonly groups = computed<OverlayGroup<ModelPickerItem>[]>(() => {
    const q = this._query().trim().toLowerCase();
    const filter = (i: ModelPickerItem) =>
      !q || i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q);

    const grouped = new Map<string, ModelPickerItem[]>();
    for (const i of this.items()) {
      if (!filter(i)) continue;
      const arr = grouped.get(i.group) ?? [];
      arr.push(i);
      grouped.set(i.group, arr);
    }

    const toItem = (i: ModelPickerItem): OverlayItem<ModelPickerItem> => ({
      id: i.id,
      primary: i.label,
      secondary: i.tags?.join(' · '),
      rightHint: i.kind === 'agent' ? 'agent' : undefined,
      disabled: !i.available,
      disabledReason: i.disabledReason,
      data: i,
    });

    const groups: OverlayGroup<ModelPickerItem>[] = [];
    for (const [group, items] of grouped) {
      groups.push({
        id: group,
        label: group,
        items: items.map(toItem),
      });
    }
    return groups;
  });

  setQuery(q: string): void { this._query.set(q); this._selectedKey.set(null); }
  setSelectedKey(id: string | null): void { this._selectedKey.set(id); }

  async run(item: OverlayItem<ModelPickerItem>): Promise<boolean> {
    if (item.disabled) {
      this._lastError.set({
        kind: 'disabled',
        message: item.disabledReason ?? 'Model unavailable',
        reason: item.disabledReason,
      });
      return false;
    }
    const inst = this.instanceStore.selectedInstance();
    if (!inst) {
      this._lastError.set({ kind: 'no-instance', message: 'No instance selected' });
      return false;
    }
    if (item.data.kind === 'model') {
      this.instanceStore.setModel(inst.id, item.data.id);
    } else {
      this.instanceStore.setAgent(inst.id, item.data.id);
    }
    return true;
  }
}
```

> If `ProviderStateService.allModels()` does not exist, add it as part of Phase 11 (small additive method). The existing `ProviderStateService` already tracks per-provider compatibility — wrap that data into the `ModelPickerItem` shape.

- [ ] **Step 2: Implement the host**

Create `src/renderer/app/features/overlay-modes/model-picker.host.component.ts`:

```ts
import { Component, ChangeDetectionStrategy, inject, output } from '@angular/core';
import { OverlayShellComponent } from '../../shared/overlay-shell/overlay-shell.component';
import { ModelPickerController } from './model-picker.controller';
import type { OverlayItem } from '../../shared/overlay-shell/overlay-controller';
import type { ModelPickerItem } from '../../../../shared/types/prompt-history.types';

@Component({
  selector: 'app-model-picker-host',
  standalone: true,
  imports: [OverlayShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-overlay-shell
      [groups]="controller.groups()"
      [query]="controller.query()"
      [placeholder]="controller.placeholder"
      [selectedKey]="controller.selectedKey()"
      [footerHints]="controller.footerHints()"
      [loading]="controller.loading()"
      modeLabel="Models"
      (queryChange)="controller.setQuery($event)"
      (selectedKeyChange)="controller.setSelectedKey($event)"
      (select)="onSelect($event)"
      (close)="closeRequested.emit()"
    >
      @if (controller.lastError(); as err) {
        <div bannerSlot class="overlay-banner overlay-banner--{{ err.kind }}">
          {{ err.message }}
          <button (click)="controller.clearError()">×</button>
        </div>
      }
    </app-overlay-shell>
  `,
})
export class ModelPickerHostComponent {
  controller = inject(ModelPickerController);
  closeRequested = output<void>();

  async onSelect(item: OverlayItem<ModelPickerItem>): Promise<void> {
    const ok = await this.controller.run(item);
    if (ok) this.closeRequested.emit();
  }
}
```

- [ ] **Step 3: Wire the dispatcher**

Mirror Wave 1's pattern for command-help host mounting. Add a case for `open-model-picker` that mounts `ModelPickerHostComponent`.

- [ ] **Step 4: Manual verify**

```bash
npm run dev
```

Press `Cmd/Ctrl+Shift+M`. Picker opens. Verify incompatible models appear grayed-out with tooltip.

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx vitest run src/renderer/app/features/overlay-modes/__tests__/model-picker.controller.spec.ts
npx tsc --noEmit
npm run lint -- src/renderer/app/features/overlay-modes/model-picker.controller.ts
git add src/renderer/app/features/overlay-modes/model-picker.controller.ts src/renderer/app/features/overlay-modes/model-picker.host.component.ts
# include the dispatcher file you modified
git commit -m "feat(model-picker): implement ModelPickerController + host wired to Cmd/Ctrl+Shift+M"
```

---

## Phase 12 — *Optional / gated:* `PromptHistorySearchController` + host

> This phase is **gated**. If Phases 1–11 ran long, defer Phase 12 to a follow-up. The `open-prompt-history-search` keybinding remains registered (Phase 1.2) but no action handler is registered, which is a no-op. Land Phase 12 only when remaining budget is comfortable.

### Task 12.1: TDD — write failing tests

**Files:**
- Create: `src/renderer/app/features/overlay-modes/__tests__/prompt-history-search.controller.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/features/overlay-modes/__tests__/prompt-history-search.controller.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { PromptHistorySearchController } from '../prompt-history-search.controller';
import { PromptHistoryStore } from '../../../core/state/prompt-history.store';
import { InstanceStore } from '../../../core/state/instance.store';

describe('PromptHistorySearchController', () => {
  let ctrl: PromptHistorySearchController;
  let store: PromptHistoryStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [PromptHistorySearchController, PromptHistoryStore, InstanceStore],
    });
    ctrl = TestBed.inject(PromptHistorySearchController);
    store = TestBed.inject(PromptHistoryStore);
    store.record({ instanceId: 'inst-1', id: 'a', text: 'review the diff', createdAt: 1, projectPath: '/p' });
    store.record({ instanceId: 'inst-1', id: 'b', text: 'check tests', createdAt: 2, projectPath: '/p' });
    ctrl.attachInstance('inst-1', '/p');
  });

  it('lists all entries unfiltered', () => {
    const items = ctrl.groups().flatMap(g => g.items);
    expect(items.length).toBe(2);
  });

  it('filters by substring', () => {
    ctrl.setQuery('review');
    const items = ctrl.groups().flatMap(g => g.items);
    expect(items.map(i => i.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
npx vitest run src/renderer/app/features/overlay-modes/__tests__/prompt-history-search.controller.spec.ts
```

Expected: FAIL.

- [ ] **Step 3: Commit failing test**

```bash
git add src/renderer/app/features/overlay-modes/__tests__/prompt-history-search.controller.spec.ts
git commit -m "test(prompt-history-search): add failing controller spec (red)"
```

---

### Task 12.2: Implement controller and host

**Files:**
- Create: `src/renderer/app/features/overlay-modes/prompt-history-search.controller.ts`
- Create: `src/renderer/app/features/overlay-modes/prompt-history-search.host.component.ts`

- [ ] **Step 1: Implement the controller**

Create `src/renderer/app/features/overlay-modes/prompt-history-search.controller.ts`:

```ts
import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  OverlayController, OverlayGroup, OverlayItem, FooterHint, OverlayControllerError,
} from '../../shared/overlay-shell/overlay-controller';
import type { PromptHistoryEntry } from '../../../../shared/types/prompt-history.types';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';

@Injectable({ providedIn: 'root' })
export class PromptHistorySearchController implements OverlayController<PromptHistoryEntry> {
  private store = inject(PromptHistoryStore);

  readonly id = 'prompt-history-search';
  readonly modeLabel = 'Recall prompt';
  readonly placeholder = 'Reverse-search prompts...';

  private _query = signal('');
  private _selectedKey = signal<string | null>(null);
  private _instanceId = signal<string | null>(null);
  private _projectPath = signal<string | null>(null);
  readonly query = this._query.asReadonly();
  readonly selectedKey = this._selectedKey.asReadonly();
  readonly loading = computed(() => false);

  private _lastError = signal<OverlayControllerError | null>(null);
  readonly lastError = this._lastError.asReadonly();
  clearError(): void { this._lastError.set(null); }

  readonly footerHints = computed<FooterHint[]>(() => [
    { keys: ['↑', '↓'], label: 'Navigate' },
    { keys: ['⏎'], label: 'Pick' },
    { keys: ['Esc'], label: 'Cancel' },
  ]);

  attachInstance(instanceId: string | null, projectPath: string | null): void {
    this._instanceId.set(instanceId);
    this._projectPath.set(projectPath);
    this.setQuery('');
  }

  private items = computed<PromptHistoryEntry[]>(() => {
    const inst = this._instanceId();
    const proj = this._projectPath();
    if (proj) return Array.from(this.store.getEntriesForProject(proj));
    if (inst) return Array.from(this.store.getEntriesForInstance(inst));
    return [];
  });

  readonly groups = computed<OverlayGroup<PromptHistoryEntry>[]>(() => {
    const q = this._query().trim().toLowerCase();
    const items = this.items().filter(e => !q || e.text.toLowerCase().includes(q));
    const overlayItems: OverlayItem<PromptHistoryEntry>[] = items.map(e => ({
      id: e.id,
      primary: e.text.length > 80 ? e.text.slice(0, 80) + '…' : e.text,
      secondary: new Date(e.createdAt).toLocaleString(),
      rightHint: e.wasSlashCommand ? '/' : undefined,
      data: e,
    }));
    return overlayItems.length === 0
      ? []
      : [{ id: 'history', label: 'Prompts', items: overlayItems }];
  });

  setQuery(q: string): void { this._query.set(q); this._selectedKey.set(null); }
  setSelectedKey(id: string | null): void { this._selectedKey.set(id); }

  /** Caller (host) takes the selected entry and replaces the textarea (with stash). */
  async run(_item: OverlayItem<PromptHistoryEntry>): Promise<boolean> {
    return true;
  }
}
```

- [ ] **Step 2: Implement the host**

Create `src/renderer/app/features/overlay-modes/prompt-history-search.host.component.ts`:

```ts
import { Component, ChangeDetectionStrategy, inject, output } from '@angular/core';
import { OverlayShellComponent } from '../../shared/overlay-shell/overlay-shell.component';
import { PromptHistorySearchController } from './prompt-history-search.controller';
import type { OverlayItem } from '../../shared/overlay-shell/overlay-controller';
import type { PromptHistoryEntry } from '../../../../shared/types/prompt-history.types';

@Component({
  selector: 'app-prompt-history-search-host',
  standalone: true,
  imports: [OverlayShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-overlay-shell
      [groups]="controller.groups()"
      [query]="controller.query()"
      [placeholder]="controller.placeholder"
      [selectedKey]="controller.selectedKey()"
      [footerHints]="controller.footerHints()"
      [loading]="controller.loading()"
      modeLabel="Recall"
      (queryChange)="controller.setQuery($event)"
      (selectedKeyChange)="controller.setSelectedKey($event)"
      (select)="onSelect($event)"
      (close)="closeRequested.emit()"
    />
  `,
})
export class PromptHistorySearchHostComponent {
  controller = inject(PromptHistorySearchController);
  closeRequested = output<void>();
  pickEntry = output<PromptHistoryEntry>();

  async onSelect(item: OverlayItem<PromptHistoryEntry>): Promise<void> {
    this.pickEntry.emit(item.data);
    this.closeRequested.emit();
  }
}
```

The dispatcher mounts the host in response to `open-prompt-history-search`; before mount, it calls `controller.attachInstance(instanceId, projectPath)`. On `pickEntry`, it calls a new `InputPanelComponent.applyRecalledEntry(entry)` (which uses the same stash mechanism).

- [ ] **Step 3: Add `applyRecalledEntry` to `InputPanelComponent`**

In `input-panel.component.ts`:

```ts
applyRecalledEntry(entry: PromptHistoryEntry): void {
  // Stash the current draft if not already stashed.
  const state = this.recallState();
  if (!state || !state.active) {
    const stashed = this.message();
    this.draftService.setDraft(this.stashKey(), stashed);
    this.recallState.set({ active: true, index: -1, stashedDraft: stashed });
  }
  this.message.set(entry.text);
}
```

- [ ] **Step 4: Manual verify**

```bash
npm run dev
```

Focus the textarea. Press `Ctrl+R`. Modal opens. Type a substring. Pick an entry — textarea is replaced; Esc on the modal cancels.

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx vitest run src/renderer/app/features/overlay-modes/__tests__/prompt-history-search.controller.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/overlay-modes/prompt-history-search.controller.ts src/renderer/app/features/overlay-modes/prompt-history-search.host.component.ts src/renderer/app/features/instance-detail/input-panel.component.ts
git commit -m "feat(prompt-history): optional Ctrl+R reverse-search overlay (gated)"
```

---

## Phase 13 — Final integration, manual verification, packaged smoke

### Task 13.1: Full type-check, lint, test

- [ ] **Step 1: Run all checks**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

Expected: clean.

- [ ] **Step 2: Run the full vitest suite**

```bash
npm run test
```

Expected: all tests pass. If any pre-existing test breaks because it relied on the old `filterText` signal shape, update the test to use `setFilterText` / `rawFilterText`.

- [ ] **Step 3: Commit any test fixes (if needed)**

```bash
git add -u
git commit -m "test: align existing specs with debounced filterText / new resolver wiring"
```

---

### Task 13.2: Manual UI verification

Run `npm run dev` and walk through every item below, in order. Capture issues as TODOs in the spec (not in this plan).

- [ ] Open the app with > 9 instances. Press `Cmd/Ctrl+1` through `Cmd/Ctrl+9`. Each selects the corresponding visible row.
- [ ] Focus the composer textarea. Press plain `1` — `1` is typed. Press `Cmd/Ctrl+1` — instance switches.
- [ ] Collapse a parent in the rail. Confirm the children disappear from the numeric-hotkey targeting (the next visible row gets that slot number).
- [ ] Type fast in the rail filter input. Verify the rail does not jank (browser dev-tools profiler).
- [ ] In a fresh instance, send 5 prompts. Press Up — each previous prompt reappears. Press Down — newer ones reappear. Press Esc with a recalled value showing — original draft returns.
- [ ] Type a partial draft, recall an old prompt with Up, press Down to come back to draft — the partial draft is fully restored.
- [ ] Send a prompt. Restart the app. Open the same instance. Press Up — the prompt is still recallable (persistence verified).
- [ ] Send `/help` as a prompt. Press Up — the recalled value retains the leading `/`.
- [ ] Press `Cmd/Ctrl+O`. Session picker opens. Select a live instance — switch happens. Select a history entry — it resumes.
- [ ] Press `Cmd/Ctrl+Shift+M` on a Claude instance. Verify Gemini models appear grayed-out with the tooltip "Requires gemini provider".
- [ ] (If Phase 12 landed) Focus the textarea and press `Ctrl+R`. Reverse-search modal opens. Pick an entry — textarea is replaced. Esc — closes without changing.
- [ ] Open dev tools. Verify no warnings/errors emitted on first paint.

---

### Task 13.3: Packaged DMG smoke test (alias-sync verification)

- [ ] **Step 1: Build the packaged app**

```bash
npm run build
```

Expected: clean build. Pay attention to `Cannot find module '@contracts/schemas/prompt-history'` errors — those mean the alias sync was incomplete.

- [ ] **Step 2: Launch the packaged binary**

Open the produced `.dmg` (or run the packaged Electron from `dist/`). The app must start. The session picker (`Cmd/Ctrl+O`) and prompt recall (Up arrow in input) must work end-to-end.

- [ ] **Step 3: Quick functional check**

In the packaged app:
1. Send a prompt. Restart. Reopen the same instance. Up should recall the prompt.
2. Open the session picker. Pick a live instance.
3. Open the model picker. Confirm at least one row.

If startup crashes with `Cannot find module …schemas/prompt-history…`, recheck the four-place alias sync (Task 2.2). The packaged Node runtime uses `register-aliases.ts`, which is the one most often forgotten when a new subpath is added.

---

### Task 13.4: Final commit and docs touch-up

- [ ] **Step 1: Update parent plan to mark Wave 2 tasks done**

Edit `docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md`. In the Wave 2 task list, replace each `- [ ]` with `- [x]` for the items that are now landed.

- [ ] **Step 2: Self-review the spec for any drift**

Re-read `docs/superpowers/specs/2026-04-28-wave2-navigation-pickers-prompt-recall-design_completed.md`. If you discovered any architectural decisions during implementation that diverge from the spec, update the spec to match what shipped.

- [ ] **Step 3: Final commit**

```bash
git add docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md docs/superpowers/specs/2026-04-28-wave2-navigation-pickers-prompt-recall-design_completed.md
git commit -m "docs: mark Wave 2 tasks complete in parent plan; spec touch-ups"
```

- [ ] **Step 4: Surface follow-ups**

Open issues / TODOs (or notes for the next wave) for any remaining items found during implementation. Specifically flag:
- The notification primitive (recall toast lives as a console.warn + inline DOM banner today; Wave 4 should subsume).
- A settings UI for `promptHistoryMaxEntries` (currently hardcoded at 100 — Wave 6 Doctor / settings).
- Any cross-window prompt-history race scenarios you encountered, for a future hardening pass.

---

## Spec coverage check (self-review)

| Spec section | Implemented in tasks |
|---|---|
| § 1.1 `PromptHistoryEntry` | 1.1 |
| § 1.2 `PromptHistoryRecord` / `PromptHistoryProjectAlias` / `PromptHistoryStoreV1` | 1.1 |
| § 1.3 `VisibleInstanceOrder` | 1.1 (or 6.2 if added late) |
| § 1.4 `SessionPickerItem` | 10.2 |
| § 1.5 `ModelPickerItem` | 11.2 |
| § 1.6 keybinding action additions + DEFAULT_KEYBINDINGS | 1.2 |
| § 1.7 service signatures | 3.1, 5.1, 6.2, 10.2, 11.2, 12.2 |
| § 2 visible-instance order | 6.1, 6.2, 8.2 |
| § 3 numeric hotkeys | 1.2, 7.1, 7.2 |
| § 4 prompt history (data flow, recall, stash, capacity, slash) | 3.1–3.2, 4.1–4.3, 5.1–5.3, 9.1–9.3 |
| § 4.8 Ctrl+R reverse-search (gated) | 12.1, 12.2 |
| § 5 schema package extraction (4-place alias sync) | 2.1, 2.2 |
| § 6.1–6.3 numeric hotkey UI flows | 7.1, 7.2, 13.2 |
| § 6.4 prompt history recall UI flow | 9.2, 9.3, 13.2 |
| § 6.5 session picker UI flow | 10.2, 10.3, 13.2 |
| § 6.6 model picker UI flow | 11.2, 13.2 |
| § 7.1 InstanceListComponent debounce | 8.1, 8.2 |
| § 7.2 InputPanelComponent diff | 9.3 |
| § 7.3 ActionDispatchService diff | 7.1, 10.3, 11.2, 12.2 |
| § 7.4 picker host components | 10.3, 11.2, 12.2 |
| § 8 testing strategy | tests embedded in each task; full suite run in 13.1 |
| § 9 telemetry & logging | spread across tasks; verified in 13.2 dev-tools console |
| § 10 IPC contract additions | 1.3, 4.1–4.3 |
| § 11 file-by-file inventory | matches Created/Modified columns across phases |
| § 12 acceptance criteria | 13.1 (1–4), 13.2 (UI), 13.3 (DMG smoke) |

If any cell above ever flips to "missing", add a task in the closest phase before continuing.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-28-wave2-navigation-pickers-prompt-recall-plan_completed.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
