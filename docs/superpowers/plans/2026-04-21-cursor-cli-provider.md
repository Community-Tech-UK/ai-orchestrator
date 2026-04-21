# Cursor CLI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cursor's `cursor-agent` CLI as a fifth first-class CLI provider alongside Claude, Codex, Gemini, and GitHub Copilot — with full parity for streaming output, session resume, tool-use surfacing, cross-model review, UI integration, and detection registry.

**Architecture:** Mirror the Copilot provider pattern (exec-per-message + `--resume` for multi-turn). Implement `CursorCliAdapter` (parses `--output-format stream-json` NDJSON, handles Cursor's tool-call key-naming convention, feature-detects `--stream-partial-output`) and `CursorCliProvider` (bridges the adapter EventEmitter events to the normalized `events$` Observable via the `push*` helpers on `BaseProvider`). Add `'cursor'` literals to four contract unions, four shared type unions, several main-process wiring sites, and all renderer enumeration files. Follow spec §11's 14-phase implementation order, consolidated here into 33 bite-sized TDD tasks across 8 phases.

**Tech Stack:** TypeScript 5.9, Electron 40, Angular 21 (zoneless, signals), Vitest, Zod 4, RxJS, better-sqlite3. Spec reference: `docs/superpowers/specs/2026-04-21-cursor-cli-provider-design.md`.

---

## File Structure

### New files

- `src/main/cli/adapters/cursor-cli-adapter.ts` — spawns `cursor-agent -p`, parses NDJSON, emits `OutputMessage` + lifecycle events. Mirrors `copilot-cli-adapter.ts`.
- `src/main/cli/adapters/__tests__/cursor-cli-adapter.spec.ts` — 23 adapter unit tests.
- `src/main/providers/cursor-cli-provider.ts` — wraps the adapter for `BaseProvider`, forwards events to `events$` via `push*`. Mirrors `copilot-cli-provider.ts`.
- `src/main/providers/__tests__/cursor-cli-provider.spec.ts` — 6 provider unit tests.

### Modified files — summary

Contract layer (4 files): `provider-runtime-events.ts|schemas.ts`, `instance.schemas.ts`, `orchestration.schemas.ts`. Shared types (3 files): `provider.types.ts`, `settings.types.ts`, `id-generator.ts`. Main process (~10 files): `cli-detection.ts`, `adapter-factory.ts`, `provider-instance-manager.ts`, `register-built-in-providers.ts`, `instance-manager.ts`, `session-handlers.ts`, `hot-model-switcher.ts`, `env-filter.ts`, `consensus.types.ts`, `orchestration-protocol.ts`, `capability-reporter.ts`. Renderer (~15 files): `instance.types.ts` (renderer copy), `provider-state.service.ts`, `provider-selector.component.ts`, and ~12 enumeration files (header, detail, list, services, stores).

Each task below lists its exact file paths and line references where known. When a line reference is shown, it is accurate as of the spec's verification pass — confirm with Grep before editing if the line has drifted.

---

## Phase 1 — Contract schema + type updates

These changes are load-bearing: without them the IPC Zod layer rejects any `provider: 'cursor'` payload and the normalized runtime event envelope refuses to validate. Must land first.

### Task 1: Add `'cursor'` to `ProviderName` type + `ProviderNameSchema`

**Files:**
- Modify: `packages/contracts/src/types/provider-runtime-events.ts:20`
- Modify: `packages/contracts/src/schemas/provider-runtime-events.schemas.ts:3`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/__tests__/provider-name.spec.ts` (or extend an existing contract spec):

```ts
import { describe, it, expect } from 'vitest';
import { ProviderNameSchema } from '../schemas/provider-runtime-events.schemas';

describe('ProviderNameSchema', () => {
  it('accepts cursor', () => {
    expect(ProviderNameSchema.safeParse('cursor').success).toBe(true);
  });
  it('still accepts all pre-existing names', () => {
    for (const p of ['claude', 'codex', 'gemini', 'copilot', 'anthropic-api']) {
      expect(ProviderNameSchema.safeParse(p).success).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/contracts/src/__tests__/provider-name.spec.ts`
Expected: FAIL — `'cursor'` not in enum.

- [ ] **Step 3: Update `ProviderNameSchema` in `provider-runtime-events.schemas.ts:3`**

```ts
export const ProviderNameSchema = z.enum(['claude', 'codex', 'gemini', 'copilot', 'anthropic-api', 'cursor']);
```

- [ ] **Step 4: Update `ProviderName` type in `provider-runtime-events.ts:20`**

```ts
export type ProviderName = 'claude' | 'codex' | 'gemini' | 'copilot' | 'anthropic-api' | 'cursor';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/contracts/src/__tests__/provider-name.spec.ts`
Expected: PASS.

- [ ] **Step 6: Run contract-level typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/types/provider-runtime-events.ts \
        packages/contracts/src/schemas/provider-runtime-events.schemas.ts \
        packages/contracts/src/__tests__/provider-name.spec.ts
git commit -m "feat(contracts): add 'cursor' to ProviderName type + schema"
```

### Task 2: Add `'cursor'` to `InstanceCreatePayloadSchema` + `InstanceCreateWithMessagePayloadSchema`

**Files:**
- Modify: `packages/contracts/src/schemas/instance.schemas.ts` (lines 21 and 32 per spec §3 — verify with Grep before editing)

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/__tests__/` (create new spec or extend):

```ts
import { describe, it, expect } from 'vitest';
import {
  InstanceCreatePayloadSchema,
  InstanceCreateWithMessagePayloadSchema,
} from '../schemas/instance.schemas';

describe('Instance payload schemas — cursor', () => {
  it('InstanceCreatePayloadSchema accepts provider: cursor', () => {
    const result = InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/tmp',
      provider: 'cursor',
    });
    expect(result.success).toBe(true);
  });
  it('InstanceCreateWithMessagePayloadSchema accepts provider: cursor', () => {
    const result = InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/tmp',
      provider: 'cursor',
      message: 'hi',
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/contracts/src/__tests__/instance-payload-cursor.spec.ts`
Expected: FAIL — `'cursor'` not in the provider enum.

- [ ] **Step 3: Grep for the exact enum in `instance.schemas.ts`**

Run: `grep -n "provider: z.enum" packages/contracts/src/schemas/instance.schemas.ts`
Expected output: two lines with `z.enum(['auto', 'claude', 'codex', 'gemini', 'copilot'])`.

- [ ] **Step 4: Update both enums to include `'cursor'`**

Replace both occurrences:

```ts
provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor']).optional(),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/contracts/src/__tests__/instance-payload-cursor.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/schemas/instance.schemas.ts \
        packages/contracts/src/__tests__/instance-payload-cursor.spec.ts
git commit -m "feat(contracts): accept 'cursor' in Instance create payloads"
```

### Task 3: Add `'cursor'` to `SpawnChildPayloadSchema`

**Files:**
- Modify: `packages/contracts/src/schemas/orchestration.schemas.ts:18` (SpawnChildPayloadSchema — verify line before editing)

- [ ] **Step 1: Grep for the schema**

Run: `grep -n "SpawnChildPayloadSchema" packages/contracts/src/schemas/orchestration.schemas.ts`

- [ ] **Step 2: Write the failing test**

Append to a new `packages/contracts/src/__tests__/orchestration-cursor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SpawnChildPayloadSchema } from '../schemas/orchestration.schemas';

describe('SpawnChildPayloadSchema — cursor', () => {
  it('accepts provider: cursor', () => {
    const result = SpawnChildPayloadSchema.safeParse({
      parentInstanceId: 'i-abc',
      prompt: 'hi',
      provider: 'cursor',
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/contracts/src/__tests__/orchestration-cursor.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Update the `provider` field's enum in `SpawnChildPayloadSchema`**

Add `'cursor'` to the existing enum literal list.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/contracts/src/__tests__/orchestration-cursor.spec.ts`
Expected: PASS.

### Task 4: Add `'cursor'` to `ConsensusProviderSpecSchema`

**Discovered during implementation review — not in spec §3 text, but present in the schema file. Blocks consensus endpoints that reference `provider: 'cursor'`.**

**Files:**
- Modify: `packages/contracts/src/schemas/orchestration.schemas.ts:523-527` (ConsensusProviderSpecSchema — verify)

- [ ] **Step 1: Grep to locate and confirm shape**

Run: `grep -n "ConsensusProviderSpecSchema" packages/contracts/src/schemas/orchestration.schemas.ts`

Current shape (from spec-validation read):

```ts
export const ConsensusProviderSpecSchema = z.object({
  provider: z.enum(['claude', 'codex', 'gemini', 'copilot']),
  model: z.string().optional(),
  weight: z.number().optional(),
});
```

- [ ] **Step 2: Extend the test from Task 3**

Append to `packages/contracts/src/__tests__/orchestration-cursor.spec.ts`:

```ts
import { ConsensusProviderSpecSchema } from '../schemas/orchestration.schemas';

describe('ConsensusProviderSpecSchema — cursor', () => {
  it('accepts provider: cursor', () => {
    expect(ConsensusProviderSpecSchema.safeParse({ provider: 'cursor' }).success).toBe(true);
  });
});
```

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run packages/contracts/src/__tests__/orchestration-cursor.spec.ts`
Expected: the consensus test FAILs.

- [ ] **Step 4: Update the enum**

```ts
provider: z.enum(['claude', 'codex', 'gemini', 'copilot', 'cursor']),
```

- [ ] **Step 5: Run all contract tests and verify pass**

Run: `npx vitest run packages/contracts/src/__tests__/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/schemas/orchestration.schemas.ts \
        packages/contracts/src/__tests__/orchestration-cursor.spec.ts
git commit -m "feat(contracts): accept 'cursor' in orchestration schemas"
```

### Task 5: Verify contract updates with full typecheck

- [ ] **Step 1: Run all typechecks**

Run:
```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npx tsc --noEmit -p tsconfig.electron.json
```

Expected: three passes. If any `ProviderName` / `InstanceProvider` / `SpawnChildCommand` consumer surfaces a type mismatch, note it — Phase 2 and later resolve them. Do NOT fix them here unless they are contract-layer errors.

- [ ] **Step 2: Run contract-level unit tests**

Run: `npx vitest run packages/contracts/`
Expected: PASS.

---

## Phase 2 — Shared type foundations

### Task 6: Add `'cursor'` to `ProviderType` union + introduce `CURSOR_MODELS`

**Files:**
- Modify: `src/shared/types/provider.types.ts` (ProviderType union ~line 8-17; add CURSOR_MODELS near ~line 175)

- [ ] **Step 1: Grep to locate exact line for ProviderType**

Run: `grep -n "^export type ProviderType" src/shared/types/provider.types.ts`

- [ ] **Step 2: Write the failing test**

Create `src/shared/types/__tests__/provider-types-cursor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ProviderType } from '../provider.types';
import { CURSOR_MODELS } from '../provider.types';

describe('ProviderType — cursor', () => {
  it('exports CURSOR_MODELS.AUTO sentinel', () => {
    expect(CURSOR_MODELS.AUTO).toBe('auto');
  });
  it('allows cursor as a ProviderType literal', () => {
    const p: ProviderType = 'cursor';
    expect(p).toBe('cursor');
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `npx vitest run src/shared/types/__tests__/provider-types-cursor.spec.ts`
Expected: FAIL — `CURSOR_MODELS` not exported, `'cursor'` not in union.

- [ ] **Step 4: Add `'cursor'` to the `ProviderType` union**

Append `| 'cursor'` to the existing union.

- [ ] **Step 5: Add the `CURSOR_MODELS` constant**

Insert near the existing `*_MODELS` constants (around line 175):

```ts
/**
 * Cursor model identifiers.
 *
 * Cursor rotates its first-class model list frequently. The adapter treats
 * `cliConfig.model` as opaque — this constant is only a minimal set of
 * well-known aliases for UI tiering and pricing fallback. The real list is
 * fetched dynamically at runtime (follow-up).
 */
export const CURSOR_MODELS = {
  /** Sentinel: omit --model flag entirely so the CLI picks from subscription. */
  AUTO: 'auto',
} as const;
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `npx vitest run src/shared/types/__tests__/provider-types-cursor.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/provider.types.ts src/shared/types/__tests__/provider-types-cursor.spec.ts
git commit -m "feat(types): add 'cursor' ProviderType + CURSOR_MODELS sentinel"
```

### Task 7: Extend `DEFAULT_MODELS`, `PROVIDER_MODEL_LIST`, `CLI_TO_PROVIDER_TYPE`

**Files:**
- Modify: `src/shared/types/provider.types.ts` (DEFAULT_MODELS ~line 196, PROVIDER_MODEL_LIST ~line 266, CLI_TO_PROVIDER_TYPE ~line 434)

- [ ] **Step 1: Grep for the three record names**

Run: `grep -n "DEFAULT_MODELS\|PROVIDER_MODEL_LIST\|CLI_TO_PROVIDER_TYPE" src/shared/types/provider.types.ts`

- [ ] **Step 2: Write the failing test**

Append to `src/shared/types/__tests__/provider-types-cursor.spec.ts`:

```ts
import {
  DEFAULT_MODELS,
  PROVIDER_MODEL_LIST,
  CURSOR_MODELS,
} from '../provider.types';

describe('Cursor model tables', () => {
  it('DEFAULT_MODELS has cursor entry = auto sentinel', () => {
    expect(DEFAULT_MODELS.cursor).toBe(CURSOR_MODELS.AUTO);
  });
  it('PROVIDER_MODEL_LIST.cursor contains the Auto fallback entry', () => {
    expect(Array.isArray(PROVIDER_MODEL_LIST.cursor)).toBe(true);
    expect(PROVIDER_MODEL_LIST.cursor).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: CURSOR_MODELS.AUTO }),
    ]));
  });
});
```

- [ ] **Step 3: Run and verify fail**

Expected: the tests fail with "cursor entry missing" / key undefined.

- [ ] **Step 4: Add the three entries**

In the `DEFAULT_MODELS` record, add:

```ts
cursor: CURSOR_MODELS.AUTO,
```

In the `PROVIDER_MODEL_LIST` record, add (use the tier/label convention of the adjacent entries — verify with Read before writing):

```ts
cursor: [
  { id: CURSOR_MODELS.AUTO, name: 'Auto (let Cursor pick)', tier: 'balanced' },
  // NO hardcoded per-model entries. Dynamic list populates UI after a
  // future live-fetch probe (see spec §10).
],
```

In the `CLI_TO_PROVIDER_TYPE` record (scoped local), add:

```ts
cursor: 'cursor',
```

- [ ] **Step 5: Run the tests + typecheck**

Run:
```
npx vitest run src/shared/types/__tests__/provider-types-cursor.spec.ts
npx tsc --noEmit
```
Expected: both PASS. If `DEFAULT_MODELS` is typed `Record<ProviderType, string>` you will now see TypeScript errors anywhere the record is built with literal object keys missing `cursor` — fix each call site. Follow the grep to find them: `grep -rn "DEFAULT_MODELS" src/`.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/provider.types.ts src/shared/types/__tests__/provider-types-cursor.spec.ts
git commit -m "feat(types): extend DEFAULT_MODELS/PROVIDER_MODEL_LIST/CLI_TO_PROVIDER_TYPE for cursor"
```

### Task 8: Add `'cursor'` to `CanonicalCliType` + settings options

**Files:**
- Modify: `src/shared/types/settings.types.ts` (CanonicalCliType ~line 11, defaultCli options ~lines 195-205, crossModelReviewProviders options ~lines 452-463)

- [ ] **Step 1: Write the failing test**

Create `src/shared/types/__tests__/settings-types-cursor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { CanonicalCliType } from '../settings.types';

describe('CanonicalCliType — cursor', () => {
  it('allows cursor literal', () => {
    const t: CanonicalCliType = 'cursor';
    expect(t).toBe('cursor');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/shared/types/__tests__/settings-types-cursor.spec.ts`
Expected: FAIL — type error.

- [ ] **Step 3: Update `CanonicalCliType` union**

Append `| 'cursor'` to the existing union.

- [ ] **Step 4: Update `defaultCli` options array (~line 195-205)**

Read the file first to get the shape. Add an object like:

```ts
{ value: 'cursor', label: 'Cursor CLI' },
```

- [ ] **Step 5: Update `crossModelReviewProviders` options array (~line 452-463)**

Same — add `{ value: 'cursor', label: 'Cursor CLI' }` to the existing array.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/settings.types.ts src/shared/types/__tests__/settings-types-cursor.spec.ts
git commit -m "feat(settings): add 'cursor' to CanonicalCliType + option lists"
```

### Task 9: Add `INSTANCE_ID_PREFIXES.cursor = 'u'`

**Files:**
- Modify: `src/shared/utils/id-generator.ts:86-95`

- [ ] **Step 1: Read current `INSTANCE_ID_PREFIXES` to confirm `u` is unused**

Run: `grep -n "INSTANCE_ID_PREFIXES" src/shared/utils/id-generator.ts`

Expected prefixes used: `c`, `g`, `x`, `p`, `a`, `i` (per spec §3). `u` (think "cUrsor") is unused.

- [ ] **Step 2: Write the failing test**

Create `src/shared/utils/__tests__/id-generator-cursor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { INSTANCE_ID_PREFIXES, generateInstanceId, getProviderFromInstanceId } from '../id-generator';

describe('INSTANCE_ID_PREFIXES — cursor', () => {
  it('assigns u to cursor', () => {
    expect(INSTANCE_ID_PREFIXES.cursor).toBe('u');
  });
  it('round-trips via generateInstanceId/getProviderFromInstanceId', () => {
    const id = generateInstanceId('cursor');
    expect(id.startsWith('u-')).toBe(true);
    expect(getProviderFromInstanceId(id)).toBe('cursor');
  });
});
```

(If `generateInstanceId` / `getProviderFromInstanceId` have different names, adjust — verify with a quick Read of `id-generator.ts` before writing the test.)

- [ ] **Step 3: Run, verify fail**

Expected: FAIL.

- [ ] **Step 4: Add the prefix**

In `INSTANCE_ID_PREFIXES`:

```ts
cursor: 'u',
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/shared/utils/__tests__/id-generator-cursor.spec.ts && npx tsc --noEmit`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/utils/id-generator.ts src/shared/utils/__tests__/id-generator-cursor.spec.ts
git commit -m "feat(id-generator): assign 'u' prefix to cursor instances"
```

### Task 10: Extend `SpawnChildCommand` + `ConsensusProviderSpec` + renderer `InstanceProvider` unions

**Files:**
- Modify: `src/main/orchestration/orchestration-protocol.ts` (SpawnChildCommand.provider)
- Modify: `src/main/orchestration/consensus.types.ts:7-11` (ConsensusProviderSpec.provider)
- Modify: `src/renderer/app/core/state/instance/instance.types.ts:73,149`
- Modify: `src/renderer/app/core/services/provider-state.service.ts` (ProviderType + normalizeProvider)

- [ ] **Step 1: Grep to locate each union**

Run:
```
grep -n "SpawnChildCommand" src/main/orchestration/orchestration-protocol.ts
grep -n "ConsensusProviderSpec" src/main/orchestration/consensus.types.ts
grep -n "type InstanceProvider" src/renderer/app/core/state/instance/instance.types.ts
grep -n "ProviderType\|normalizeProvider" src/renderer/app/core/services/provider-state.service.ts
```

- [ ] **Step 2: Update each union — append `| 'cursor'`**

Edit all four locations. In `provider-state.service.ts`, also add `'cursor'` to the `normalizeProvider()` accept list (the switch or `includes` check).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/orchestration/orchestration-protocol.ts \
        src/main/orchestration/consensus.types.ts \
        src/renderer/app/core/state/instance/instance.types.ts \
        src/renderer/app/core/services/provider-state.service.ts
git commit -m "feat(types): extend orchestration + renderer InstanceProvider unions for cursor"
```

### Task 11: Full typecheck pass after shared-type updates

- [ ] **Step 1: Run full typecheck matrix**

Run:
```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npx tsc --noEmit -p tsconfig.electron.json
npm run lint
```

Expected: all PASS. If a renderer switch / array literal is missing `cursor` anywhere, note the file — Phase 7 will cover them. For now only fix files whose compile errors prevent later phases from proceeding.

---

## Phase 3 — CLI detection + adapter factory skeleton

### Task 12: Add `cursor` to `CliType`, `SUPPORTED_CLIS`, and `CLI_REGISTRY`

**Files:**
- Modify: `src/main/cli/cli-detection.ts:41,46,66-165,278`

- [ ] **Step 1: Read `cli-detection.ts` in full**

Run: `cat src/main/cli/cli-detection.ts` (via Read tool) — confirm the exact shape of `CLI_REGISTRY` entries (e.g. Copilot's entry near line 140).

- [ ] **Step 2: Write the failing test**

Create `src/main/cli/__tests__/cli-detection-cursor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SUPPORTED_CLIS, CLI_REGISTRY } from '../cli-detection';

describe('CLI registry — cursor', () => {
  it('SUPPORTED_CLIS includes cursor', () => {
    expect(SUPPORTED_CLIS).toContain('cursor');
  });
  it('CLI_REGISTRY.cursor has expected command metadata', () => {
    expect(CLI_REGISTRY.cursor).toMatchObject({
      name: 'cursor',
      command: 'cursor-agent',
    });
    expect(CLI_REGISTRY.cursor.versionFlag).toBeDefined();
  });
  it('getDefaultCli priority still returns a valid CliType', () => {
    // Sanity check that insertion didn't break the priority resolver
    const { getDefaultCli } = require('../cli-detection');
    expect(typeof getDefaultCli({})).toBe('string');
  });
});
```

- [ ] **Step 3: Run and verify fail**

Run: `npx vitest run src/main/cli/__tests__/cli-detection-cursor.spec.ts`
Expected: FAIL — `'cursor'` not in registry.

- [ ] **Step 4: Update `CliType` union (~line 41)**

Append `| 'cursor'`.

- [ ] **Step 5: Update `SUPPORTED_CLIS` (~line 46)**

Append `'cursor'`.

- [ ] **Step 6: Add `CLI_REGISTRY.cursor` entry (~line 66-165, alongside Copilot's)**

Use Copilot's registry entry as a template, substituting:

```ts
cursor: {
  name: 'cursor',
  command: 'cursor-agent',
  versionFlag: '--version',
  alternativePaths: [
    '/opt/homebrew/bin/cursor-agent',
    '/usr/local/bin/cursor-agent',
    `${process.env['HOME'] ?? ''}/.local/bin/cursor-agent`,
    `${process.env['HOME'] ?? ''}/.cursor/bin/cursor-agent`,
  ],
  detectionPriority: 50, // Match or follow Copilot's ordering — verify against existing priorities
  displayName: 'Cursor CLI',
  description: 'Cursor agent CLI (cursor-agent)',
},
```

Verify the exact `CliRegistryEntry` field names by reading the adjacent Copilot entry before writing.

- [ ] **Step 7: Update `getDefaultCli()` priority (~line 278)**

If `getDefaultCli()` uses an explicit priority array, append `'cursor'` in a reasonable slot (after Copilot is fine). Reference the spec §3 note that priority is flexible — do not promote Cursor above pre-existing first-class CLIs.

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run src/main/cli/__tests__/cli-detection-cursor.spec.ts && npx tsc --noEmit -p tsconfig.electron.json`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/cli/cli-detection.ts src/main/cli/__tests__/cli-detection-cursor.spec.ts
git commit -m "feat(cli-detection): register cursor-agent in CLI_REGISTRY"
```

### Task 13: Stub `createCursorAdapter` + factory wiring (placeholder that throws)

**Files:**
- Modify: `src/main/cli/adapters/adapter-factory.ts:11-17,65,70-87,131,213-224,241-262,280-295`

- [ ] **Step 1: Read `adapter-factory.ts` in full**

Read the file. Confirm the shape of `CliAdapter` union (~line 11-17), `mapSettingsToDetectionType` (~line 65), priority array (~line 70-87), `createCopilotAdapter` (~line 131 — template), factory `createCliAdapter()` switch (~line 213-224), and `getCliDisplayName` (~line 280-295).

- [ ] **Step 2: Write a failing test**

Create `src/main/cli/adapters/__tests__/adapter-factory-cursor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';

describe('adapter factory — cursor', () => {
  it('getCliDisplayName returns Cursor CLI', () => {
    expect(getCliDisplayName('cursor')).toBe('Cursor CLI');
  });
  it('mapSettingsToDetectionType accepts cursor', () => {
    expect(mapSettingsToDetectionType('cursor')).toBe('cursor');
  });
  it('createCliAdapter(cursor, ...) instantiates CursorCliAdapter', () => {
    const adapter = createCliAdapter('cursor', { workingDir: '/tmp' });
    expect(adapter.constructor.name).toBe('CursorCliAdapter');
  });
});
```

- [ ] **Step 3: Run, verify fail**

Run: `npx vitest run src/main/cli/adapters/__tests__/adapter-factory-cursor.spec.ts`
Expected: FAIL — `cursor` case missing in switch.

- [ ] **Step 4: Add a placeholder `CursorCliAdapter` stub**

Create `src/main/cli/adapters/cursor-cli-adapter.ts` with a minimal `BaseCliAdapter` subclass that throws on any real operation. Full implementation comes in Phase 4 — this stub only unblocks the factory typecheck:

```ts
import { BaseCliAdapter, CliAdapterConfig, CliCapabilities, CliMessage, CliResponse, CliStatus } from './base-cli-adapter';

export interface CursorCliConfig {
  model?: string;
  workingDir?: string;
  systemPrompt?: string;
  yoloMode?: boolean;
  timeout?: number;
}

export class CursorCliAdapter extends BaseCliAdapter {
  private cliConfig: CursorCliConfig;

  constructor(config: CursorCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'cursor-agent',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout ?? 300_000,
      sessionPersistence: true,
    };
    super(adapterConfig);
    this.cliConfig = { ...config };
    this.sessionId = `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getName(): string { return 'cursor-cli'; }
  getCapabilities(): CliCapabilities {
    return {
      streaming: true, toolUse: true, fileAccess: true, shellExecution: true,
      multiTurn: true, vision: false, codeExecution: true, contextWindow: 200_000,
      outputFormats: ['text', 'json', 'stream-json'],
    };
  }
  async checkStatus(): Promise<CliStatus> {
    return { available: false, error: 'stub: implement in Phase 4' };
  }
  async sendMessage(_message: CliMessage): Promise<CliResponse> {
    throw new Error('CursorCliAdapter: stub — not yet implemented');
  }
}
```

- [ ] **Step 5: Wire the factory**

In `adapter-factory.ts`:

1. Add import: `import { CursorCliAdapter, CursorCliConfig } from './cursor-cli-adapter';`
2. Extend `CliAdapter` union: `| CursorCliAdapter`
3. Add `createCursorAdapter` factory fn, mirroring `createCopilotAdapter`:
   ```ts
   export function createCursorAdapter(config: CursorCliConfig = {}): CursorCliAdapter {
     return new CursorCliAdapter(config);
   }
   ```
4. Update `createCliAdapter()` switch: `case 'cursor': return createCursorAdapter(config as CursorCliConfig);`
5. Update `mapSettingsToDetectionType`: `case 'cursor': return 'cursor';`
6. Update priority array: append `'cursor'`.
7. Update `getCliDisplayName`: `case 'cursor': return 'Cursor CLI';`

- [ ] **Step 6: Run tests + typecheck**

Run:
```
npx vitest run src/main/cli/adapters/__tests__/adapter-factory-cursor.spec.ts
npx tsc --noEmit -p tsconfig.electron.json
```
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/cli/adapters/cursor-cli-adapter.ts \
        src/main/cli/adapters/adapter-factory.ts \
        src/main/cli/adapters/__tests__/adapter-factory-cursor.spec.ts
git commit -m "feat(adapter-factory): wire cursor-cli-adapter stub into factory"
```

---

## Phase 4 — `CursorCliAdapter` full implementation (TDD)

This phase grows the Phase-3 stub into the complete adapter. Each task writes failing tests first, then implements the specific feature to make them pass. Implementation file: `src/main/cli/adapters/cursor-cli-adapter.ts`. Test file: `src/main/cli/adapters/__tests__/cursor-cli-adapter.spec.ts`.

**Test harness template** (reused across tasks — establishes the mock process):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// Fake process: stdout/stderr are readable streams we push data into;
// stdin is a writable stream that discards.
class FakeProcess extends EventEmitter {
  stdout = new Readable({ read() { /* push manually */ } });
  stderr = new Readable({ read() { /* push manually */ } });
  stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  pid = 12345;
  kill = vi.fn();
  unref = vi.fn();
}

// The mocked spawner — adapter's spawnProcess() is intercepted via the spawn
// mock. We intercept the low-level spawner the same way copilot-cli-adapter.spec
// does; see that file for reference.
vi.mock('child_process', () => ({
  spawn: vi.fn(() => new FakeProcess()),
}));
```

### Task 14: Adapter identity + `getName()` + `getCapabilities()` tests

- [ ] **Step 1: Write failing tests for adapter identity**

In `cursor-cli-adapter.spec.ts`:

```ts
import { CursorCliAdapter } from '../cursor-cli-adapter';

describe('CursorCliAdapter — identity', () => {
  it('getName returns cursor-cli', () => {
    expect(new CursorCliAdapter({}).getName()).toBe('cursor-cli');
  });
  it('getCapabilities declares streaming + multiTurn + sandbox-appropriate caps', () => {
    const caps = new CursorCliAdapter({}).getCapabilities();
    expect(caps).toMatchObject({
      streaming: true, toolUse: true, multiTurn: true,
      codeExecution: true, vision: false,
      outputFormats: ['text', 'json', 'stream-json'],
    });
  });
  it('getRuntimeCapabilities declares supportsResume: true', () => {
    const caps = new CursorCliAdapter({}).getRuntimeCapabilities();
    expect(caps.supportsResume).toBe(true);
    expect(caps.supportsPermissionPrompts).toBe(false);
  });
});
```

- [ ] **Step 2: Run and verify**

Run: `npx vitest run src/main/cli/adapters/__tests__/cursor-cli-adapter.spec.ts -t identity`
Expected: the Phase-3 stub already passes the first two; the third FAILs until we override `getRuntimeCapabilities`.

- [ ] **Step 3: Override `getRuntimeCapabilities()` on the adapter**

```ts
override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
  return {
    supportsResume: true,
    supportsForkSession: false,
    supportsNativeCompaction: false,
    supportsPermissionPrompts: false,
    supportsDeferPermission: false,
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Expected: all three identity tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/cli/adapters/cursor-cli-adapter.ts \
        src/main/cli/adapters/__tests__/cursor-cli-adapter.spec.ts
git commit -m "feat(cursor-adapter): declare identity + runtime capabilities"
```

### Task 15: `buildArgs()` baseline flags

- [ ] **Step 1: Write the failing test**

Append to `cursor-cli-adapter.spec.ts`:

```ts
describe('CursorCliAdapter — buildArgs baseline', () => {
  it('includes -p, --output-format stream-json, --force, --sandbox disabled', () => {
    const adapter = new CursorCliAdapter({});
    // buildArgs is private; test via sendMessage path or expose as protected for
    // testing. We reach in via (adapter as any).buildArgs({...}) to keep
    // production surface minimal.
    const args = (adapter as unknown as { buildArgs: (m: { content: string }) => string[] })
      .buildArgs({ content: 'hi' });
    expect(args).toEqual(expect.arrayContaining([
      '-p', '--output-format', 'stream-json',
      '--force', '--sandbox', 'disabled',
    ]));
  });

  it('positional prompt appears at the end', () => {
    const adapter = new CursorCliAdapter({});
    const args = (adapter as unknown as { buildArgs: (m: { content: string }) => string[] })
      .buildArgs({ content: 'hello' });
    expect(args[args.length - 1]).toBe('hello');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Expected: FAIL — `buildArgs` not defined.

- [ ] **Step 3: Implement `buildArgs`**

Add private helper. At this point the adapter always includes `--stream-partial-output`; Task 16 adds the feature-detect fallback.

```ts
private buildArgs(message: { content: string }): string[] {
  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--force',
    '--sandbox', 'disabled',
  ];

  if (this.partialOutputSupported) {
    args.push('--stream-partial-output');
  }

  const model = this.cliConfig.model;
  const isAutoSentinel = !model || model.toLowerCase() === 'auto';
  if (!isAutoSentinel) {
    args.push('--model', model);
  }

  if (this.cursorSessionId) {
    args.push('--resume', this.cursorSessionId);
  }

  const prompt = this.cliConfig.systemPrompt
    ? `${this.cliConfig.systemPrompt}\n\n${message.content}`
    : message.content;
  args.push(prompt);

  return args;
}
```

Add member state declarations near the top of the class:

```ts
/** Cursor's own session_id, captured from terminal `result` events for --resume. */
private cursorSessionId: string | null = null;

/** Feature flag: becomes false after unknown-flag fallback (see Task 16). */
private partialOutputSupported = true;

/** Ready gate — exec-per-message model has no persistent process. */
private isSpawned = false;
```

- [ ] **Step 4: Run, verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cursor-adapter): implement buildArgs baseline flags + positional prompt"
```

### Task 16: `buildArgs()` — `--model`, `--resume`, system prompt prepend, `'auto'` normalization

- [ ] **Step 1: Write the failing tests**

```ts
describe('CursorCliAdapter — buildArgs per-flag rules', () => {
  it('omits --model when cliConfig.model is undefined', () => {
    const adapter = new CursorCliAdapter({});
    const args = (adapter as any).buildArgs({ content: 'x' });
    expect(args).not.toContain('--model');
  });
  it("omits --model when cliConfig.model === 'auto'", () => {
    const adapter = new CursorCliAdapter({ model: 'auto' });
    const args = (adapter as any).buildArgs({ content: 'x' });
    expect(args).not.toContain('--model');
  });
  it("omits --model when cliConfig.model === 'AUTO' (case-insensitive)", () => {
    const adapter = new CursorCliAdapter({ model: 'AUTO' });
    const args = (adapter as any).buildArgs({ content: 'x' });
    expect(args).not.toContain('--model');
  });
  it('includes --model when concrete value set', () => {
    const adapter = new CursorCliAdapter({ model: 'claude-sonnet-4-6' });
    const args = (adapter as any).buildArgs({ content: 'x' });
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-6');
  });
  it('prepends systemPrompt with blank-line separator', () => {
    const adapter = new CursorCliAdapter({ systemPrompt: 'SYS' });
    const args = (adapter as any).buildArgs({ content: 'user' });
    expect(args[args.length - 1]).toBe('SYS\n\nuser');
  });
  it('includes --resume <id> when cursorSessionId is set', () => {
    const adapter = new CursorCliAdapter({});
    (adapter as any).cursorSessionId = 'sess-123';
    const args = (adapter as any).buildArgs({ content: 'x' });
    const resumeIdx = args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args[resumeIdx + 1]).toBe('sess-123');
  });
  it('omits --stream-partial-output when feature flag cleared', () => {
    const adapter = new CursorCliAdapter({});
    (adapter as any).partialOutputSupported = false;
    const args = (adapter as any).buildArgs({ content: 'x' });
    expect(args).not.toContain('--stream-partial-output');
  });
});
```

- [ ] **Step 2: Run, verify pass**

The implementation from Task 15 should already pass all of these. If any fail, tweak the `buildArgs` branching to match.

- [ ] **Step 3: Commit (no code change if all pass — this is a behavioral lock-down)**

```bash
git add src/main/cli/adapters/__tests__/cursor-cli-adapter.spec.ts
git commit -m "test(cursor-adapter): lock buildArgs model/resume/system prompt rules"
```

### Task 17: NDJSON parser — system/init event captures `session_id`

- [ ] **Step 1: Write the failing test**

```ts
import { Readable } from 'stream';

// Helper to drive NDJSON through the mocked process
async function drive(adapter: CursorCliAdapter, ndjson: string[]): Promise<void> {
  // Access the private spawnProcess -> FakeProcess; push ndjson lines to stdout
  // then emit close. The exact wiring mirrors copilot-cli-adapter.spec — see
  // that file for the pattern.
  // ... (omitted — copy pattern verbatim from copilot-cli-adapter.spec's driver)
}

describe('CursorCliAdapter — system/init parsing', () => {
  it('captures session_id from system.init event', async () => {
    const adapter = new CursorCliAdapter({});
    const emitted: unknown[] = [];
    adapter.on('output', (m) => emitted.push(m));
    adapter.on('status', (s) => emitted.push({ status: s }));

    const sendPromise = adapter.sendMessage({ content: 'hi' });
    // Push init then result
    // ... drive with:
    //   '{"type":"system","subtype":"init","session_id":"sess-1","model":"auto"}'
    //   '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1"}'
    await sendPromise;

    expect((adapter as any).cursorSessionId).toBe('sess-1');
    expect(emitted).toContainEqual({ status: 'busy' });
  });
});
```

- [ ] **Step 2: Run, verify fail**

Expected: FAIL — no NDJSON parser yet.

- [ ] **Step 3: Implement the `sendMessage()` + NDJSON line parser**

Model the full implementation on `copilot-cli-adapter.ts:236-400` (the `sendMessage` method with line-buffered JSON parsing). Key structure:

```ts
override async sendMessage(message: CliMessage): Promise<CliResponse> {
  if (message.attachments?.length) {
    throw new Error('Cursor adapter does not support attachments in orchestrator mode.');
  }
  if (!this.isSpawned) {
    throw new Error('Cursor adapter not spawned; call spawn() before sendMessage.');
  }

  const startTime = Date.now();
  this.outputBuffer = '';

  return new Promise<CliResponse>((resolve, reject) => {
    const args = this.buildArgs(message);
    logger.debug('Spawning cursor-agent', {
      args: this.redactPromptForLog(args),
      hasResumeId: !!this.cursorSessionId,
    });
    this.process = this.spawnProcess(args);

    this.process.on('error', (err) => {
      this.process = null;
      reject(new Error(`Failed to spawn cursor-agent: ${err.message}`));
    });

    if (this.process.stdin) this.process.stdin.end();

    let lineBuffer = '';
    let streamingMessageId: string | null = null;
    let streamingContent = '';
    let hasReceivedDeltas = false;

    this.process.stdout?.on('data', (data) => {
      const chunk = data.toString();
      this.outputBuffer += chunk;
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: CursorEvent;
        try { event = JSON.parse(trimmed) as CursorEvent; } catch { continue; }
        this.handleCursorEvent(event, {
          streamingMessageId: () => streamingMessageId,
          setStreamingMessageId: (id) => { streamingMessageId = id; },
          appendStreamingContent: (c) => { streamingContent += c; },
          getStreamingContent: () => streamingContent,
          markDeltaSeen: () => { hasReceivedDeltas = true; },
          hasDeltaSeen: () => hasReceivedDeltas,
        });
      }
    });

    // ... stderr handling (Task 23), process close, error handling
    // Full body matches copilot-cli-adapter.sendMessage's structure.
  });
}

private handleCursorEvent(event: CursorEvent, ctx: StreamContext): void {
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        if (event.session_id) this.cursorSessionId = event.session_id;
        this.emit('status', 'busy');
      }
      break;
    case 'user':
      // Ignore — our own prompt echoed back.
      break;
    case 'assistant':
      this.handleAssistantEvent(event, ctx); // Task 18
      break;
    case 'tool_call':
      this.handleToolCallEvent(event);       // Task 19
      break;
    case 'result':
      this.handleResultEvent(event);         // Task 20
      break;
  }
}
```

Declare the `CursorEvent` union + `StreamContext` interface at the top of the file (types only — see spec §2 stream-JSON event schema). Ship them in a non-exported section:

```ts
type CursorSystemInitEvent = { type: 'system'; subtype: 'init'; session_id?: string; model?: string; cwd?: string; apiKeySource?: string; permissionMode?: string };
type CursorUserEvent = { type: 'user'; message: { role: 'user'; content: unknown[] }; session_id?: string };
type CursorAssistantEvent = { type: 'assistant'; message: { role: 'assistant'; content: Array<{ type: 'text'; text: string }> }; session_id?: string; timestamp_ms?: number; model_call_id?: string };
type CursorToolCallEvent = { type: 'tool_call'; subtype: 'started' | 'completed'; call_id: string; tool_call: Record<string, unknown>; session_id?: string; is_error?: boolean };
type CursorResultEvent = { type: 'result'; subtype: 'success' | 'error'; is_error: boolean; duration_ms?: number; duration_api_ms?: number; result?: string; session_id?: string; request_id?: string };
type CursorEvent = CursorSystemInitEvent | CursorUserEvent | CursorAssistantEvent | CursorToolCallEvent | CursorResultEvent;

interface StreamContext {
  streamingMessageId(): string | null;
  setStreamingMessageId(id: string): void;
  appendStreamingContent(chunk: string): void;
  getStreamingContent(): string;
  markDeltaSeen(): void;
  hasDeltaSeen(): boolean;
}
```

- [ ] **Step 4: Run the test, verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cursor-adapter): NDJSON parser + system.init captures session_id"
```

### Task 18: Assistant event — streaming + final-message dedupe

- [ ] **Step 1: Write the failing tests (Test #5, #6, #7 from spec §7)**

```ts
describe('CursorCliAdapter — assistant event', () => {
  it('emits streaming output messages with a stable per-turn messageId', async () => {
    // drive:
    //   system.init
    //   assistant text="Hello wo"  (delta #1 under --stream-partial-output)
    //   assistant text="rld"        (delta #2)
    //   result subtype=success
    // Expect: 2 streaming:true output events + 1 flush (streaming:false).
    // streamingMessageId consistent across all three emissions.
  });

  it('dedupe — final ⊆ streaming: final "Hello world" after deltas "Hello wo" + "rld" → terminal flush only, accumulated length 11', async () => {
    // Deltas produce streamingContent = "Hello world" (length 11).
    // Final assistant arrives with text = "Hello world".
    // Expect: one final flush with streaming:false, accumulatedContent.length === 11.
    // No duplicate text emitted.
  });

  it('dedupe — final extends streaming: deltas produce "Hello"; final="Hello world" → emits " world" suffix delta + flush', async () => {
    // accumulatedContent.length === 11 after the suffix delta.
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement `handleAssistantEvent`**

```ts
private handleAssistantEvent(event: CursorAssistantEvent, ctx: StreamContext): void {
  const text = event.message?.content?.[0]?.text ?? '';
  if (!text) return;

  let messageId = ctx.streamingMessageId();
  if (!messageId) {
    messageId = generateId();
    ctx.setStreamingMessageId(messageId);
  }

  const isDelta = !!event.timestamp_ms || !!event.model_call_id;
  if (isDelta) {
    ctx.markDeltaSeen();
    ctx.appendStreamingContent(text);
    const current = ctx.getStreamingContent();
    const extracted = extractThinkingContent(current);
    this.emit('output', {
      id: messageId,
      timestamp: Date.now(),
      type: 'assistant',
      content: text,
      metadata: { streaming: true, accumulatedContent: extracted.response },
      thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined,
    });
    return;
  }

  // Final (non-delta) assistant event — apply dedupe rule.
  const streamed = ctx.getStreamingContent();
  if (ctx.hasDeltaSeen() && streamed.length > 0) {
    if (text === streamed || streamed.startsWith(text)) {
      // final ⊆ streamed — emit terminal flush only, no new text.
      this.emitAssistantFlush(messageId, streamed);
      return;
    }
    if (text.startsWith(streamed)) {
      // final extends streamed — emit suffix delta, then flush.
      const suffix = text.slice(streamed.length);
      if (suffix) {
        ctx.appendStreamingContent(suffix);
        this.emit('output', {
          id: messageId,
          timestamp: Date.now(),
          type: 'assistant',
          content: suffix,
          metadata: { streaming: true, accumulatedContent: ctx.getStreamingContent() },
        });
      }
      this.emitAssistantFlush(messageId, ctx.getStreamingContent());
      return;
    }
    // Unexpected — concat safely (defensive; don't lose text).
    logger.warn('Cursor assistant final does not extend or equal streamed content; concatenating');
    ctx.appendStreamingContent(text);
    this.emitAssistantFlush(messageId, ctx.getStreamingContent());
    return;
  }

  // No deltas seen — final is the only emission.
  ctx.appendStreamingContent(text);
  this.emitAssistantFlush(messageId, text);
}

private emitAssistantFlush(messageId: string, fullContent: string): void {
  const extracted = extractThinkingContent(fullContent);
  this.emit('output', {
    id: messageId,
    timestamp: Date.now(),
    type: 'assistant',
    content: '',
    metadata: { streaming: false, accumulatedContent: extracted.response },
    thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined,
  });
}
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cursor-adapter): assistant delta streaming + final-message dedupe"
```

### Task 19: `tool_call` event — key-name extraction + failure detection

- [ ] **Step 1: Write the failing tests (Test #8, #9, #10, #11 from spec §7)**

```ts
describe('CursorCliAdapter — tool_call event', () => {
  it('started with {readToolCall: {...}} → tool_use OutputMessage with toolName=read + call_id', async () => {
    // drive with:
    //   { type:'tool_call', subtype:'started', call_id:'t1',
    //     tool_call:{ readToolCall:{ path:'foo' } } }
    // Expect: emit('output', { type:'tool_use', metadata:{ toolName:'read', callId:'t1', input:{ path:'foo' } } })
  });
  it('started with {bashToolCall: {...}} → toolName=bash', async () => { /* ... */ });
  it('unexpected payload shape → toolName=unknown_tool, no throw', async () => {
    // tool_call:{}  with no keys
  });
  it('completed with inner error → emits both tool_result AND error OutputMessage', async () => {
    // tool_call:{ readToolCall:{ error:'ENOENT' } }  or success:false
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement `handleToolCallEvent` + extraction**

```ts
private extractToolName(toolCall: Record<string, unknown>): { name: string; input: unknown } {
  const keys = Object.keys(toolCall);
  if (keys.length === 0) return { name: 'unknown_tool', input: null };
  const firstKey = keys[0];
  const stripped = firstKey.replace(/ToolCall$/, '');
  // Normalize to lowercase-first (Cursor uses camelCase keys; we want 'read' not 'Read')
  const name = stripped.length === 0 ? 'unknown_tool' : stripped.charAt(0).toLowerCase() + stripped.slice(1);
  return { name: name || 'unknown_tool', input: toolCall[firstKey] };
}

private handleToolCallEvent(event: CursorToolCallEvent): void {
  const { name, input } = this.extractToolName(event.tool_call ?? {});
  const callId = event.call_id;

  if (event.subtype === 'started') {
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_use',
      content: `Using tool: ${name}`,
      metadata: { toolName: name, callId, input },
    });
    return;
  }

  // subtype === 'completed'
  const innerValue = (input ?? {}) as Record<string, unknown>;
  const innerError = typeof innerValue === 'object' && innerValue
    ? (innerValue['error'] as unknown) || (innerValue['success'] === false ? 'failed' : undefined)
    : undefined;
  const failed = event.is_error === true || innerError !== undefined;

  this.emit('output', {
    id: generateId(),
    timestamp: Date.now(),
    type: 'tool_result',
    content: failed
      ? `Tool ${name} failed${innerError ? `: ${String(innerError)}` : ''}`
      : `Tool ${name} completed`,
    metadata: { toolName: name, callId, success: !failed, output: innerValue, error: innerError },
  });

  if (failed) {
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'error',
      content: `Tool ${name} failed: ${String(innerError ?? 'unknown error')}`,
      metadata: { toolName: name, callId },
    });
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cursor-adapter): tool_call key-name extraction + failure surfacing"
```

### Task 20: `result` event — terminal handling, usage emission, complete

- [ ] **Step 1: Write the failing test (Test #12 + #13 from spec §7)**

```ts
describe('CursorCliAdapter — result event', () => {
  it('success: captures session_id, emits context usage, emits complete', async () => {
    // drive with result subtype=success, is_error=false, session_id=sess-2,
    // duration_ms=1000, duration_api_ms=800, result='done'
    // Expect: cursorSessionId === 'sess-2'; a 'context' event emitted;
    // sendMessage resolves with { content:'done', success:true, duration ... }.
  });
  it('is_error:true: emits error OutputMessage and rejects sendMessage', async () => {
    // drive with result subtype=error, is_error=true, result='something went wrong'
    // Expect: adapter emits error OutputMessage; sendMessage rejects.
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Declare the `ResultState` interface at the top of the adapter file**

This interface is grown by later tasks — explicitly defining it now keeps later additions mechanical.

```ts
interface ResultState {
  /** The original CliMessage — captured so retry paths (Task 21, 22) can replay it. */
  message: CliMessage;
  /** Promise resolve handle from sendMessage's Promise constructor. */
  resolver: (r: CliResponse) => void;
  /** Promise reject handle from sendMessage's Promise constructor. */
  rejecter: (e: Error) => void;
  /** Set true after the first terminal event (result or error) is consumed. */
  completed: boolean;
  /** Set true by Task 21 once the adapter has retried without --resume. Prevents retry loops. */
  retriedWithoutResume: boolean;
  /** Set true by Task 22 once the adapter has retried without --stream-partial-output. */
  retriedWithoutPartial: boolean;
}
```

- [ ] **Step 4: Implement `handleResultEvent`**

The handler needs access to the promise resolver from the enclosing `sendMessage`. Thread them via a closure-captured `ResultState`:

```ts
// Inside sendMessage's Promise constructor, before the stdout listener:
const resultState: ResultState = {
  message,
  resolver: resolve,
  rejecter: reject,
  completed: false,
  retriedWithoutResume: false,
  retriedWithoutPartial: false,
};
// Stash on `this` for the close/error handlers; or pass via `ctx`.

// handleResultEvent signature matches handleAssistantEvent etc.; adapt.
private handleResultEvent(event: CursorResultEvent, resultState: ResultState, startTime: number): void {
  if (resultState.completed) return;
  resultState.completed = true;

  // 1. Always capture session_id for subsequent --resume (even on error —
  //    the error might be unrelated to session; harmless to keep).
  if (event.session_id) this.cursorSessionId = event.session_id;

  // 2. Emit directional usage via 'context'.
  const durationMs = event.duration_ms ?? (Date.now() - startTime);
  // Token counts not exposed by Cursor; estimate directionally from duration
  // and prompt length. Provider layer will translate via MODEL_PRICING.
  this.emit('context', {
    used: 0,  // unknown; directional — provider's updateUsageFromContext handles fallback
    total: 200_000,
    percentage: 0,
  });

  if (event.is_error) {
    // Resume-failure fallback handled in Task 21 — keep this path linear here.
    const errMsg = event.result ?? 'Cursor returned is_error without a result message';
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'error',
      content: errMsg,
      metadata: { sessionId: event.session_id, requestId: event.request_id },
    });
    resultState.rejecter(new Error(errMsg));
    return;
  }

  // Success — emit 'complete' + resolve.
  resultState.resolver({
    content: event.result ?? '',
    success: true,
    duration: durationMs,
    sessionId: event.session_id,
  });
}
```

- [ ] **Step 5: Run tests, verify pass**

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(cursor-adapter): result event — session_id capture + usage + reject on is_error"
```

### Task 21: Resume-failure fallback retry (Test #14, #15 from spec §7)

- [ ] **Step 1: Write the failing tests**

```ts
describe('CursorCliAdapter — resume-failure fallback', () => {
  it("clears cursorSessionId and retries once without --resume on /invalid session id/i", async () => {
    // Set adapter.cursorSessionId = 'stale';
    // First spawn result subtype=error, is_error=true, result='invalid session id: stale'
    // Second spawn (retry) result subtype=success, is_error=false, result='done'
    // Expect: final resolution is success; cursorSessionId is the new one from
    // the retry's result; only two spawn invocations occurred.
  });

  it('does NOT retry on non-resume errors', async () => {
    // cursorSessionId = 'sess-ok'; result is_error=true, result='unrelated error'
    // Expect: rejects on first failure; no retry; cursorSessionId preserved.
  });

  it('retry also fails → rejects with last error', async () => {
    // cursorSessionId = 'stale'; first is_error with 'session expired';
    // retry also is_error with 'authentication failed'
    // Expect: reject with 'authentication failed'.
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Refactor `handleResultEvent` to cooperate with retry**

Introduce a `maybeRetryForResumeFailure()` helper that's called before rejecting:

```ts
private readonly RESUME_FAILURE_PATTERN = /invalid session id|session not found|session expired/i;

// In handleResultEvent's is_error branch — before the reject:
if (this.cursorSessionId && !resultState.retriedWithoutResume) {
  const errMsg = event.result ?? '';
  if (this.RESUME_FAILURE_PATTERN.test(errMsg)) {
    logger.info('Cursor session expired; clearing and retrying once without --resume', {
      prevSessionId: this.cursorSessionId,
    });
    this.cursorSessionId = null;
    resultState.retriedWithoutResume = true;
    // Emit user-visible notice
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'error',
      content: 'Previous Cursor session expired; starting fresh.',
      metadata: { recoverable: true, retryKind: 'resume-fallback' },
    });
    // Re-dispatch sendMessage on the same resultState
    this.retryCurrentMessage(resultState);
    return;
  }
}
```

Add `retryCurrentMessage(resultState)` — a private helper that re-runs the `sendMessage` child-process spawn with the message captured on `resultState.message` (the `ResultState.message` field declared in Task 20) and threads the same `resolver`/`rejecter` through:

```ts
private retryCurrentMessage(resultState: ResultState): void {
  // Re-enter the spawn flow with the same closure-captured resolver/rejecter.
  // Conceptually this is sendMessage's body minus the outer Promise ctor — pull
  // it into a private `dispatchTurn(message, resultState)` helper and have both
  // sendMessage and retryCurrentMessage call it. This keeps retry behavior
  // consistent across the resume-fallback (Task 21) and unknown-flag fallback
  // (Task 22) paths.
  this.dispatchTurn(resultState.message, resultState);
}
```

`dispatchTurn` is the extracted body of `sendMessage`'s Promise constructor (the spawn + stdout/stderr/close/error listeners). `sendMessage` then becomes:

```ts
override async sendMessage(message: CliMessage): Promise<CliResponse> {
  if (message.attachments?.length) throw new Error('Cursor adapter does not support attachments in orchestrator mode.');
  if (!this.isSpawned) throw new Error('Cursor adapter not spawned; call spawn() before sendMessage.');
  return new Promise<CliResponse>((resolve, reject) => {
    const resultState: ResultState = {
      message,
      resolver: resolve,
      rejecter: reject,
      completed: false,
      retriedWithoutResume: false,
      retriedWithoutPartial: false,
    };
    this.dispatchTurn(message, resultState);
  });
}
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cursor-adapter): resume-failure fallback — clear session_id + retry once"
```

### Task 22: `--stream-partial-output` feature detect + unknown-flag fallback (Test #23 from spec §7)

- [ ] **Step 1: Write the failing test**

```ts
describe('CursorCliAdapter — unknown-flag fallback for --stream-partial-output', () => {
  it('first spawn exits non-zero with stderr mentioning --stream-partial-output → second invocation omits it and partialOutputSupported is cached false', async () => {
    // First spawn: exit code 1; stderr = 'unknown flag: --stream-partial-output'
    // Expect: adapter emits a retry notice, partialOutputSupported=false,
    // retries the same message without --stream-partial-output.
    // Third invocation (distinct message) also omits the flag.
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Wire the fallback into process `close` handler**

```ts
this.process.on('close', (code, signal) => {
  this.emit('exit', code, signal);
  if (resultState.completed) return;

  // Feature-detect fallback for --stream-partial-output
  if (
    this.partialOutputSupported &&
    !resultState.retriedWithoutPartial &&
    code !== 0 &&
    /unknown flag.*--stream-partial-output|--stream-partial-output.*unknown/i.test(stderrBuffer)
  ) {
    logger.info('cursor-agent rejected --stream-partial-output; disabling and retrying');
    this.partialOutputSupported = false;
    resultState.retriedWithoutPartial = true;
    this.retryCurrentMessage(resultState);
    return;
  }

  if (code !== 0) {
    resultState.completed = true;
    resultState.rejecter(new Error(`Cursor exited with code ${code}: ${stderrBuffer.trim() || 'no stderr'}`));
    return;
  }
});
```

Declare `stderrBuffer` as a local string accumulated in the stderr listener. Add `retriedWithoutPartial` to `ResultState`.

- [ ] **Step 4: Run the test, verify pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cursor-adapter): feature-detect fallback for --stream-partial-output"
```

### Task 23: `checkStatus()`, spawn/terminate lifecycle, stderr edge cases

- [ ] **Step 1: Write failing tests (Tests #16-#22 from spec §7)**

```ts
describe('CursorCliAdapter — lifecycle + status + stderr', () => {
  it('checkStatus happy path returns available:true with version parsed', async () => {
    // mock spawn: stdout emits '0.9.2\n'; exit code 0
    const adapter = new CursorCliAdapter({});
    const status = await adapter.checkStatus();
    expect(status).toMatchObject({ available: true });
    expect(status.version).toMatch(/\d+\.\d+\.\d+/);
  });
  it('checkStatus timeout → available:false', async () => { /* fake proc never exits */ });
  it('sendMessage on ENOENT rejects with install hint', async () => {
    // process emits 'error' { code:'ENOENT' } before any stdout
    // Expect reject message mentions 'https://cursor.com/cli' install guide.
  });
  it('spawn() validates isSpawned false + checkStatus succeeds', async () => {});
  it('terminate(true) clears isSpawned + cursorSessionId + current message reasoning', async () => {});
  it('multi-turn: first sendMessage captures session_id; second includes --resume', async () => {});
  it('stderr matching /error|fatal|failed/i emits error OutputMessage', async () => {});
  it('stderr matching /SecItemCopyMatching|keychain|login item/i emits keychain-remediation error OutputMessage', async () => {
    // Verify error content mentions 'cursor-agent login' and CURSOR_API_KEY
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement `checkStatus`**

Mirror Copilot's `checkStatus` verbatim with `cursor-agent --version`:

```ts
async checkStatus(): Promise<CliStatus> {
  return new Promise((resolve) => {
    const proc = this.spawnProcess(['--version']);
    let output = '';
    let errorOutput = '';
    proc.stdout?.on('data', (d) => { output += d.toString(); });
    proc.stderr?.on('data', (d) => { errorOutput += d.toString(); });
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      resolve({ available: false, error: 'Timeout checking Cursor CLI' });
    }, 5000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      const combined = `${output}\n${errorOutput}`;
      const versionMatch = combined.match(/(\d+\.\d+\.\d+)/);
      if (code === 0 || versionMatch) {
        resolve({
          available: true,
          version: versionMatch?.[1] ?? 'unknown',
          path: 'cursor-agent',
          authenticated: true,
        });
      } else {
        resolve({
          available: false,
          error: `Cursor CLI not found or failed (exit ${code}): ${combined.trim() || 'no output'}`,
        });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ available: false, error: `Failed to launch cursor-agent: ${err.message}` });
    });
  });
}
```

- [ ] **Step 4: Implement `spawn()` + `terminate()`**

```ts
override async spawn(): Promise<void> {
  const status = await this.checkStatus();
  if (!status.available) {
    throw new Error(`cursor-agent unavailable: ${status.error ?? 'unknown'}. Install: curl https://cursor.com/install -fsSL | bash`);
  }
  this.isSpawned = true;
  if (process.pid) this.emit('spawned', process.pid);
  this.emit('status', 'idle');
}

override async terminate(graceful: boolean = true): Promise<void> {
  if (this.process) {
    try {
      if (graceful) this.process.kill('SIGTERM');
      else this.process.kill('SIGKILL');
    } catch { /* ignore */ }
    this.process = null;
  }
  this.isSpawned = false;
  this.cursorSessionId = null;
  this.partialOutputSupported = true; // reset for next spawn
  this.emit('status', 'terminated');
}
```

- [ ] **Step 5: Add stderr handler with keychain pattern matching**

In `sendMessage`'s Promise constructor, after setting up stdout:

```ts
let stderrBuffer = '';
this.process.stderr?.on('data', (data) => {
  const chunk = data.toString();
  stderrBuffer += chunk;
  if (/SecItemCopyMatching|keychain|login item/i.test(chunk)) {
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'error',
      content:
        "Cursor CLI couldn't read its credentials from Keychain. " +
        "Try re-running `cursor-agent login`, grant Keychain access when prompted, " +
        "or set `CURSOR_API_KEY` in your environment.",
      metadata: { recoverable: false, kind: 'keychain' },
    });
    return;
  }
  if (/error|fatal|failed/i.test(chunk)) {
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'error',
      content: chunk.trim(),
      metadata: { recoverable: false, kind: 'stderr' },
    });
  }
});
```

- [ ] **Step 6: Handle ENOENT with install hint**

In the `error` handler on the child:

```ts
this.process.on('error', (err: NodeJS.ErrnoException) => {
  this.process = null;
  if (err.code === 'ENOENT') {
    resultState.completed = true;
    resultState.rejecter(new Error(
      'cursor-agent not found on PATH. Install from https://cursor.com/cli ' +
      '(curl https://cursor.com/install -fsSL | bash).'
    ));
    return;
  }
  resultState.completed = true;
  resultState.rejecter(new Error(`cursor-agent launch error: ${err.message}`));
});
```

- [ ] **Step 7: Run all adapter tests, verify pass**

Run: `npx vitest run src/main/cli/adapters/__tests__/cursor-cli-adapter.spec.ts`
Expected: all 23 tests PASS.

- [ ] **Step 8: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.electron.json && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

```bash
git add src/main/cli/adapters/cursor-cli-adapter.ts \
        src/main/cli/adapters/__tests__/cursor-cli-adapter.spec.ts
git commit -m "feat(cursor-adapter): checkStatus + spawn/terminate + stderr handling + ENOENT"
```

---

## Phase 5 — `CursorCliProvider` (TDD)

### Task 24: `CursorCliProvider` scaffold + identity tests

**Files:**
- Create: `src/main/providers/cursor-cli-provider.ts`
- Create: `src/main/providers/__tests__/cursor-cli-provider.spec.ts`

- [ ] **Step 1: Read `copilot-cli-provider.ts` in full** (template reference)

Run: `cat src/main/providers/copilot-cli-provider.ts | head -250`

- [ ] **Step 2: Write failing identity tests**

Mirror `copilot-cli-provider.spec.ts` structure (read that file's first describe block):

```ts
import { describe, it, expect } from 'vitest';
import { CursorCliProvider } from '../cursor-cli-provider';
import type { ProviderConfig } from '@shared/types/provider.types';

const makeConfig = (): ProviderConfig => ({
  type: 'cursor',
  name: 'Cursor CLI',
  enabled: true,
});

describe('CursorCliProvider identity', () => {
  it('reports provider = cursor', () => {
    const p = new CursorCliProvider(makeConfig());
    expect(p.provider).toBe('cursor');
  });
  it('declares Wave 2 adapter capabilities', () => {
    const p = new CursorCliProvider(makeConfig());
    expect(p.capabilities).toEqual({
      interruption: true,
      permissionPrompts: false,
      sessionResume: true,
      streamingOutput: true,
      usageReporting: true,
      subAgents: false,
    });
  });
  it('getType returns cursor', () => {
    expect(new CursorCliProvider(makeConfig()).getType()).toBe('cursor');
  });
  it('reports inactive/null accessors before initialize', () => {
    const p = new CursorCliProvider(makeConfig());
    expect(p.isRunning()).toBe(false);
    expect(p.getPid()).toBeNull();
    expect(p.getUsage()).toBeNull();
  });
  it('populates currentUsage when a context event is processed', () => {
    const p = new CursorCliProvider(makeConfig());
    (p as unknown as { updateUsageFromContext: (c: { used: number; total: number; percentage: number }) => void })
      .updateUsageFromContext({ used: 1000, total: 200000, percentage: 0.5 });
    const usage = p.getUsage();
    expect(usage).not.toBeNull();
    expect(usage!.totalTokens).toBe(1000);
    expect(usage!.inputTokens).toBe(700);
    expect(usage!.outputTokens).toBe(300);
    expect(usage!.estimatedCost).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run, verify fail**

Expected: FAIL — `CursorCliProvider` module does not exist.

- [ ] **Step 4: Implement `cursor-cli-provider.ts` — full scaffold**

Copy `copilot-cli-provider.ts` structure wholesale, substituting names. Key differences from the Copilot provider:
- `provider: ProviderName = 'cursor'`
- `capabilities` block matches the Task 24 test (sessionResume:true, streamingOutput:true, usageReporting:true)
- Default model fallback uses `CURSOR_MODELS.AUTO`
- `updateUsageFromContext` uses the same 70/30 split; looks up `MODEL_PRICING[cliConfig.model]` first, falls back to Sonnet rates (`input: 3.0, output: 15.0`) — rationale in spec §5
- No `COPILOT_DEFAULT_MODELS` equivalent — Cursor keeps it minimal (see Task 7's `PROVIDER_MODEL_LIST.cursor`)

Skeleton:

```ts
/**
 * Cursor CLI Provider — wraps CursorCliAdapter for BaseProvider.
 *
 * Cursor is a multi-model router CLI: underlying model (Claude/GPT/Gemini)
 * chosen via --model, transport is the `cursor-agent` binary against the
 * user's Cursor subscription. Execution model mirrors Copilot (exec-per-
 * message + --resume for multi-turn).
 */

import { BaseProvider } from './provider-interface';
import type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  ProviderSessionOptions,
  ProviderAttachment,
  ProviderUsage,
} from '../../shared/types/provider.types';
import { CURSOR_MODELS, MODEL_PRICING } from '../../shared/types/provider.types';
import { CursorCliAdapter, type CursorCliConfig } from '../cli/adapters/cursor-cli-adapter';
import { getLogger } from '../logging/logger';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderName } from '@contracts/types/provider-runtime-events';
import type { ContextUsage, OutputMessage } from '../../shared/types/instance.types';

const logger = getLogger('CursorCliProvider');

const CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  permissionPrompts: false,
  sessionResume: true,
  streamingOutput: true,
  usageReporting: true,
  subAgents: false,
};

export const DEFAULT_CURSOR_CONFIG: ProviderConfig = {
  type: 'cursor',
  name: 'Cursor CLI',
  enabled: false,
  defaultModel: CURSOR_MODELS.AUTO,
};

export const CURSOR_DESCRIPTOR = {
  providerName: 'cursor' as ProviderName,
  displayName: 'Cursor CLI',
  capabilities: CAPABILITIES,
} as const;

export class CursorCliProvider extends BaseProvider {
  readonly provider: ProviderName = 'cursor';
  readonly capabilities: ProviderAdapterCapabilities = CAPABILITIES;

  private adapter: CursorCliAdapter | null = null;
  private currentUsage: ProviderUsage | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getType(): ProviderType { return 'cursor'; }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      sessionResume: true,
      interruption: true,
      multimodal: false,
      vision: false,
      codeExecution: true,
      contextWindow: 200_000,
    };
  }

  async checkStatus(): Promise<ProviderStatus> {
    const a = new CursorCliAdapter({ workingDir: '/' });
    const st = await a.checkStatus();
    return { available: st.available, authenticated: st.authenticated ?? false, error: st.error };
  }

  async initialize(options: ProviderSessionOptions): Promise<void> {
    if (this.adapter) return; // idempotent
    this.instanceId = options.instanceId;
    this.sessionId = options.instanceId; // provider-scoped session id

    const cfg: CursorCliConfig = {
      model: options.model ?? this.config.defaultModel ?? CURSOR_MODELS.AUTO,
      workingDir: options.workingDirectory,
      systemPrompt: options.systemPrompt,
      yoloMode: true,
      timeout: options.timeoutMs ?? 300_000,
    };
    this.adapter = new CursorCliAdapter(cfg);

    this.adapter.on('output', (m: OutputMessage) => this.pushOutput(m));
    this.adapter.on('status', (s: string) => this.pushStatus(s));
    this.adapter.on('context', (u: ContextUsage) => {
      this.updateUsageFromContext(u);
      this.pushContext(u.used, u.total, u.percentage);
    });
    this.adapter.on('error', (err: Error | string) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.pushError(msg, false);
    });
    this.adapter.on('exit', (code: number | null, signal: string | null) => {
      this.isActive = false;
      this.pushExit(code, signal);
    });
    this.adapter.on('spawned', (pid: number) => {
      this.isActive = true;
      this.pushSpawned(pid);
    });

    await this.adapter.spawn();
  }

  async sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void> {
    if (!this.adapter) throw new Error('CursorCliProvider not initialized');
    await this.adapter.sendInput({ content: message, attachments });
  }

  async terminate(graceful: boolean = true): Promise<void> {
    if (this.adapter) {
      await this.adapter.terminate(graceful);
      this.adapter = null;
    }
    this.isActive = false;
    this.completeEvents();
  }

  override getUsage(): ProviderUsage | null { return this.currentUsage; }
  override getPid(): number | null { return this.adapter?.getPid() ?? null; }

  private updateUsageFromContext(usage: ContextUsage): void {
    const totalTokens = usage.used;
    const inputTokens = Math.round(totalTokens * 0.7);
    const outputTokens = totalTokens - inputTokens;

    const modelKey = (this.adapter as unknown as { cliConfig?: { model?: string } })?.cliConfig?.model
      ?? this.config.defaultModel
      ?? CURSOR_MODELS.AUTO;
    const pricing = MODEL_PRICING[modelKey] ?? { input: 3.0, output: 15.0 };
    const estimatedCost =
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output;

    this.currentUsage = { totalTokens, inputTokens, outputTokens, estimatedCost };
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

Expected: all 5 identity tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/providers/cursor-cli-provider.ts \
        src/main/providers/__tests__/cursor-cli-provider.spec.ts
git commit -m "feat(cursor-provider): scaffold + identity + updateUsageFromContext"
```

### Task 25: Provider inline-translation tests (event bridging)

- [ ] **Step 1: Write the failing tests**

Mirror the `copilot-cli-provider.spec.ts` second describe block. Append:

```ts
import { EventEmitter } from 'events';
import { vi, beforeEach } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

class FakeAdapter extends EventEmitter {
  async spawn(): Promise<void> { /* no-op */ }
  getSessionId(): string { return 'sess-1'; }
  getPid(): number | null { return null; }
  async terminate(): Promise<void> { /* no-op */ }
  async sendInput(): Promise<void> { /* no-op */ }
  async checkStatus(): Promise<{ available: boolean }> { return { available: true }; }
}

vi.mock('../../cli/adapters/cursor-cli-adapter', () => ({
  CursorCliAdapter: vi.fn().mockImplementation(() => new FakeAdapter()),
}));

describe('CursorCliProvider inline translation', () => {
  let provider: CursorCliProvider;
  let adapter: FakeAdapter;
  let envelopes: ProviderRuntimeEventEnvelope[];

  beforeEach(async () => {
    provider = new CursorCliProvider(makeConfig());
    envelopes = [];
    provider.events$.subscribe(e => envelopes.push(e));
    await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-1' });
    adapter = (provider as unknown as { adapter: FakeAdapter }).adapter;
  });

  it('output (OutputMessage) becomes output envelope', () => {
    const ts = 1713340800000;
    adapter.emit('output', { id: 'm1', type: 'assistant', content: 'hi', timestamp: ts, metadata: { foo: 1 } });
    const last = envelopes.at(-1)!;
    expect(last.provider).toBe('cursor');
    expect(last.instanceId).toBe('i-1');
    expect(last.event).toEqual({
      kind: 'output', content: 'hi', messageType: 'assistant',
      messageId: 'm1', timestamp: ts, metadata: { foo: 1 },
    });
  });

  it('status string becomes status envelope', () => {
    adapter.emit('status', 'busy');
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'status', status: 'busy' });
  });

  it('context becomes context envelope AND updates getUsage', () => {
    adapter.emit('context', { used: 500, total: 128000, percentage: 0.39 });
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'context', used: 500, total: 128000, percentage: 0.39 });
    const usage = provider.getUsage();
    expect(usage).not.toBeNull();
    expect(usage!.totalTokens).toBe(500);
  });

  it('error Error → error envelope', () => {
    adapter.emit('error', new Error('boom'));
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'error', message: 'boom', recoverable: false });
  });

  it('error string → error envelope', () => {
    adapter.emit('error', 'str');
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'error', message: 'str', recoverable: false });
  });

  it('exit → exit envelope + clears isActive', () => {
    adapter.emit('exit', 0, null);
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'exit', code: 0, signal: null });
    expect(provider.isRunning()).toBe(false);
  });

  it('spawned → spawned envelope + sets isActive', () => {
    adapter.emit('spawned', 9999);
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'spawned', pid: 9999 });
    expect(provider.isRunning()).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify pass**

Run: `npx vitest run src/main/providers/__tests__/cursor-cli-provider.spec.ts`
Expected: PASS (the implementation from Task 24 already wires the events).

- [ ] **Step 3: Commit**

```bash
git commit -am "test(cursor-provider): inline translation — all 6 adapter→envelope paths"
```

---

## Phase 6 — Main-process wiring

### Task 26: Register `CursorCliProvider` in `provider-instance-manager.ts`

**Files:**
- Modify: `src/main/providers/provider-instance-manager.ts:23,35,94,308`

- [ ] **Step 1: Grep all four wiring sites**

Run: `grep -n "DEFAULT_PROVIDER_CONFIGS\|registerBuiltinProviders\|mapCliToProviderType\|CursorCliProvider\|CopilotCliProvider" src/main/providers/provider-instance-manager.ts`

- [ ] **Step 2: Write a failing test**

Append to (or create) `src/main/providers/__tests__/provider-instance-manager-cursor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ProviderInstanceManager, DEFAULT_PROVIDER_CONFIGS } from '../provider-instance-manager';

describe('ProviderInstanceManager — cursor', () => {
  it('DEFAULT_PROVIDER_CONFIGS includes cursor entry', () => {
    expect(DEFAULT_PROVIDER_CONFIGS.cursor).toMatchObject({
      type: 'cursor',
      name: 'Cursor CLI',
    });
  });

  it('mapCliToProviderType maps cursor → cursor', () => {
    const m = new ProviderInstanceManager();
    expect((m as unknown as { mapCliToProviderType: Record<string, string> })
      .mapCliToProviderType.cursor).toBe('cursor');
  });
});
```

- [ ] **Step 3: Run, verify fail**

- [ ] **Step 4: Add `DEFAULT_CURSOR_CONFIG` import + registry entry (~line 23 + 35)**

At the top of the file, import:

```ts
import { CursorCliProvider, DEFAULT_CURSOR_CONFIG } from './cursor-cli-provider';
```

In `DEFAULT_PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig>`:

```ts
cursor: DEFAULT_CURSOR_CONFIG,
```

- [ ] **Step 5: Register the factory in `registerBuiltinProviders()` (~line 94)**

Add alongside the Copilot line:

```ts
this.register('cursor', (cfg) => new CursorCliProvider(cfg));
```

- [ ] **Step 6: Extend `mapCliToProviderType` (~line 308)**

```ts
'cursor': 'cursor',
```

- [ ] **Step 7: Run tests + typecheck**

Run:
```
npx vitest run src/main/providers/__tests__/provider-instance-manager-cursor.spec.ts
npx tsc --noEmit -p tsconfig.electron.json
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/providers/provider-instance-manager.ts \
        src/main/providers/__tests__/provider-instance-manager-cursor.spec.ts
git commit -m "feat(provider-manager): register CursorCliProvider + default config"
```

### Task 27: Register `CURSOR_DESCRIPTOR` in `register-built-in-providers.ts`

**Files:**
- Modify: `src/main/providers/register-built-in-providers.ts`

- [ ] **Step 1: Grep for existing descriptor list**

Run: `grep -n "COPILOT_DESCRIPTOR\|CLAUDE_DESCRIPTOR\|GEMINI_DESCRIPTOR" src/main/providers/register-built-in-providers.ts`

- [ ] **Step 2: Write failing test**

Update or create `src/main/providers/__tests__/register-built-in-providers.spec.ts`:

```ts
it('registers cursor descriptor', () => {
  const registered = getRegisteredProviderDescriptors();
  expect(registered.map(d => d.providerName)).toContain('cursor');
});
```

- [ ] **Step 3: Run, verify fail**

- [ ] **Step 4: Add the import + registration**

```ts
import { CURSOR_DESCRIPTOR } from './cursor-cli-provider';
// ... in the registration function:
registry.registerDescriptor(CURSOR_DESCRIPTOR);
```

- [ ] **Step 5: Run, verify pass; commit**

```bash
git commit -am "feat(registry): register CURSOR_DESCRIPTOR"
```

### Task 28: Extend `instance-manager.ts:resolveProviderName()` — BLOCKER fix

**Files:**
- Modify: `src/main/instance/instance-manager.ts:772-798`

- [ ] **Step 1: Grep for the exact switch**

Run: `grep -n "resolveProviderName\|case 'claude'" src/main/instance/instance-manager.ts`

- [ ] **Step 2: Write a failing test**

Create `src/main/instance/__tests__/instance-manager-resolve-provider-cursor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InstanceManager } from '../instance-manager';

describe('InstanceManager.resolveProviderName — cursor', () => {
  it('returns cursor for instanceProvider=cursor', () => {
    const m = InstanceManager.getInstance();
    const fn = (m as unknown as { resolveProviderName: (p: string) => string }).resolveProviderName;
    expect(fn.call(m, 'cursor')).toBe('cursor');
  });
});
```

- [ ] **Step 3: Run, verify fail**

Expected: the switch's default branch returns `'claude'` or undefined — fails.

- [ ] **Step 4: Extend the switch**

```ts
switch (instanceProvider) {
  case 'claude':
  case 'codex':
  case 'gemini':
  case 'copilot':
  case 'cursor':
    return instanceProvider;
  // ... existing default
}
```

- [ ] **Step 5: Run, verify pass; commit**

```bash
git commit -am "fix(instance-manager): route cursor events through resolveProviderName"
```

### Task 29: `session-handlers`, `hot-model-switcher`, `capability-reporter` updates

**Files:**
- Modify: `src/main/ipc/handlers/session-handlers.ts` (getProviderDisplayName)
- Modify: `src/main/routing/hot-model-switcher.ts` (getProviderType + any prompt-adaptation switch)
- Modify: `src/worker-agent/capability-reporter.ts` (substring match)

- [ ] **Step 1: Grep all three**

Run:
```
grep -n "getProviderDisplayName" src/main/ipc/handlers/session-handlers.ts
grep -n "getProviderType\|prompt-adaptation\|adaptPromptFor" src/main/routing/hot-model-switcher.ts
grep -n "cursor\|copilot\|gemini" src/worker-agent/capability-reporter.ts
```

- [ ] **Step 2: Add `case 'cursor': return 'Cursor'` to `getProviderDisplayName`**

- [ ] **Step 3: Add substring match in `hot-model-switcher.ts:getProviderType`**

```ts
if (name.includes('cursor')) return 'cursor';
```

Review any prompt-adaptation switch for whether Cursor needs provider-specific prompt munging — the spec says **no** (§3 notes "if Cursor needs any provider-specific prompt munging" as a verify). Default: leave alone.

- [ ] **Step 4: Add substring match in `capability-reporter.ts`**

Mirror existing Copilot pattern.

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/main/ipc/handlers/session-handlers.ts \
        src/main/routing/hot-model-switcher.ts \
        src/worker-agent/capability-reporter.ts
git commit -m "feat(main): wire cursor provider name into session handlers + hot-model + capability reporter"
```

### Task 30: Allowlist `CURSOR_API_KEY` in `env-filter.ts`

**Files:**
- Modify: `src/main/security/env-filter.ts`

- [ ] **Step 1: Read the file — verify pattern**

Run: `cat src/main/security/env-filter.ts | head -100`

Identify how other provider keys (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) are handled. Two possible patterns per spec §8:
- Named allowlist — add `CURSOR_API_KEY` to it.
- Unconditional strip + per-adapter re-inject — replicate for the Cursor adapter (which would mean pulling `CURSOR_API_KEY` from parent env in the adapter's spawn config).

- [ ] **Step 2: Write the failing test**

Create `src/main/security/__tests__/env-filter-cursor.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSafeEnvForTrustedProcess } from '../env-filter';

describe('env-filter — cursor', () => {
  const original = process.env['CURSOR_API_KEY'];
  beforeEach(() => { process.env['CURSOR_API_KEY'] = 'sk-test'; });
  afterEach(() => {
    if (original === undefined) delete process.env['CURSOR_API_KEY'];
    else process.env['CURSOR_API_KEY'] = original;
  });

  it('CURSOR_API_KEY survives filter to reach the Cursor child process', () => {
    const env = getSafeEnvForTrustedProcess();
    expect(env['CURSOR_API_KEY']).toBe('sk-test');
  });
});
```

- [ ] **Step 3: Run, verify fail**

- [ ] **Step 4: Update `env-filter.ts` per the pattern discovered in Step 1**

- [ ] **Step 5: Run, verify pass; commit**

```bash
git commit -am "feat(env-filter): allowlist CURSOR_API_KEY"
```

---

## Phase 7 — Renderer touch-ups

Each renderer file switches on, enumerates, or literal-lists provider names. Add `'cursor'` everywhere it's missing. Test-driven for the core files; manual for the long-tail.

### Task 31: Core renderer unions + switches

**Files (verified during spec exploration):**
- `src/renderer/app/core/state/instance/instance-list.store.ts:116,467,499,509`
- `src/renderer/app/features/instance-detail/instance-header.component.ts:1102-1134` (display-name + color switches)
- `src/renderer/app/features/instance-detail/instance-detail.component.ts:421-436` (display-name switch)
- `src/renderer/app/features/instance-detail/message-format.service.ts:76-91` (display-name switch)

- [ ] **Step 1: Write a failing test for one representative switch**

Use `instance-header.component`'s `getProviderDisplayName` as the template test:

```ts
// src/renderer/app/features/instance-detail/__tests__/instance-header-cursor.spec.ts
import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InstanceHeaderComponent } from '../instance-header.component';

describe('InstanceHeaderComponent — cursor provider', () => {
  it('getProviderDisplayName returns Cursor for cursor', () => {
    const c = TestBed.createComponent(InstanceHeaderComponent).componentInstance;
    expect(c.getProviderDisplayName('cursor')).toBe('Cursor');
  });
  it('getProviderColor returns a non-empty color string for cursor', () => {
    const c = TestBed.createComponent(InstanceHeaderComponent).componentInstance;
    expect(c.getProviderColor('cursor')).toMatch(/^#|rgb|hsl|var\(/);
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Add `case 'cursor'` to all four files**

For each of the four files above:
- Add `case 'cursor': return 'Cursor';` to display-name switches.
- Add `case 'cursor': return '<color>';` to color switches (use a visually distinct color — spec doesn't mandate; see `instance-header.component.ts:1130ish` for the existing palette and pick an unused hue).

In `instance-list.store.ts`, the four touch-points are: param union (`116`), `inferProviderFromModelName` (`467`), `inferProviderFromIdentifier` (`499`), and the `isInstanceProvider` type guard (`509`).

For `inferProviderFromModelName` — Cursor model names are user-supplied and often echo Claude/GPT/Gemini — no reliable substring match. Skip adding; rely on explicit provider metadata.

For `inferProviderFromIdentifier` — the id prefix `'u-'` from Task 9 dispatches to cursor. Add:

```ts
if (id.startsWith('u-')) return 'cursor';
```

For `isInstanceProvider` — add `'cursor'` to the accept list.

- [ ] **Step 4: Run tests + typecheck**

Run:
```
npx vitest run src/renderer/app/features/instance-detail/__tests__/instance-header-cursor.spec.ts
npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 5: Sweep the remaining renderer files from spec §3 (manual grep+add)**

Run:
```
grep -rn "'claude'\s*|\s*'codex'\|'claude', 'codex'\|case 'copilot'" src/renderer src/shared src/main
```

For each match without a Cursor sibling, add the literal. Target files from spec §3:
- `src/renderer/app/features/instance-list/instance-row.component.ts`
- `src/renderer/app/features/instance-list/history-rail.service.ts`
- `src/renderer/app/features/models/models-page.component.ts`
- `src/renderer/app/core/state/instance/instance.store.ts`
- `src/renderer/app/core/state/cli.store.ts`
- `src/renderer/app/core/services/new-session-draft.service.ts`
- `src/renderer/app/core/services/ipc/instance-ipc.service.ts`
- `src/preload/domains/instance.preload.ts`
- `src/shared/types/history.types.ts`
- `src/main/instance/tool-output-parser.ts`
- `src/main/orchestration/cross-model-review-service.ts`
- `src/main/orchestration/consensus-coordinator.ts`
- `src/main/orchestration/reviewer-pool.ts`
- `src/main/providers/__tests__/parity/provider-parity.spec.ts` (add cursor to parity fixture)
- `src/main/providers/__tests__/adapter-descriptors.spec.ts` (add cursor)
- `src/shared/validation/ipc-schemas.spec.ts` (fixture update if needed)

- [ ] **Step 6: Run full verification**

Run:
```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npx tsc --noEmit -p tsconfig.electron.json
npm run lint
npm test
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(renderer): add cursor to all provider-enumeration switches"
```

### Task 32: `ProviderSelectorComponent` — add Cursor dropdown option

**Files:**
- Modify: `src/renderer/app/features/providers/provider-selector.component.ts:21,297,300-333`

- [ ] **Step 1: Write a failing test**

Create `src/renderer/app/features/providers/__tests__/provider-selector-cursor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ProviderSelectorComponent } from '../provider-selector.component';

describe('ProviderSelectorComponent — cursor', () => {
  it('allProviders includes a cursor option', () => {
    const c = TestBed.createComponent(ProviderSelectorComponent).componentInstance;
    expect(c.allProviders.map(p => p.value)).toContain('cursor');
  });
  it('cursor option has label Cursor CLI and a color + icon', () => {
    const c = TestBed.createComponent(ProviderSelectorComponent).componentInstance;
    const opt = c.allProviders.find(p => p.value === 'cursor');
    expect(opt?.label).toBe('Cursor CLI');
    expect(opt?.color).toBeDefined();
    expect(opt?.iconSvg).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Update `ProviderType` union in the component (~line 21)**

Append `| 'cursor'`.

- [ ] **Step 4: Add the Cursor entry to `allProviders` (~line 300-333)**

Insert after the Copilot entry:

```ts
{
  value: 'cursor',
  label: 'Cursor CLI',
  color: '#000000', // confirm-and-adjust; pick a Cursor-brand-appropriate color
  iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M3 12l9-9 9 9-9 9-9-9z"/></svg>', // placeholder diamond; replace with Cursor brand icon if available
  available: () => this.isProviderAvailable('cursor'),
},
```

Remove the `isCopilot` computed if a generalized `isProviderAvailable(type)` already exists; otherwise add a parallel `isCursor` computed for consistency.

- [ ] **Step 5: Run, verify pass; commit**

```bash
git commit -am "feat(provider-selector): add Cursor CLI dropdown option"
```

---

## Phase 8 — Full verification + integration audit

### Task 33: Final verification matrix + manual smoke test

- [ ] **Step 1: Run full typecheck + lint + unit tests**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npx tsc --noEmit -p tsconfig.electron.json
npm run lint
npm test
```

Expected: all PASS, no warnings about unused imports or missing cursor literals.

- [ ] **Step 2: Verify `register-aliases.ts` unchanged**

Spec §8 notes no new `@contracts/...` subpaths introduced. Confirm with:

```
git diff --stat src/main/register-aliases.ts
```

Expected: no changes. If it was touched, either revert or add the corresponding alias to `tsconfig.json`, `tsconfig.electron.json`, `vitest.config.ts` per AGENTS.md "Packaging Gotcha #1."

- [ ] **Step 3: Integration audit (from spec §9)**

Check each:
- [ ] `CURSOR_DESCRIPTOR` registered in `register-built-in-providers.ts` (Task 27).
- [ ] `cursor` in `CLI_REGISTRY` + `SUPPORTED_CLIS` (Task 12).
- [ ] `createCliAdapter('cursor', ...)` returns `CursorCliAdapter` (Task 13 + 23).
- [ ] Provider selector dropdown shows Cursor CLI when available (Task 32).
- [ ] Settings "Default CLI" dropdown includes Cursor (Task 8).
- [ ] Cross-model review multi-select includes Cursor (Task 8).
- [ ] `CURSOR_API_KEY` reaches child process (Task 30 + test confirmation).

- [ ] **Step 4: Manual dev-mode smoke test**

With `cursor-agent` installed locally and `CURSOR_API_KEY` set (or `cursor-agent login` already run):

```bash
CURSOR_API_KEY=sk-... npm run dev
```

Walk through:
1. Open Settings → Default CLI dropdown shows Cursor CLI.
2. Create New Instance → Provider dropdown shows Cursor CLI.
3. Pick Cursor CLI + model "Auto", enter working dir, send a trivial prompt ("say hi").
4. Observe streaming text output; confirm tool_use events appear in the transcript if the agent invokes a tool.
5. Send a second message in the same instance — confirm it continues the conversation (verify by asking something that depends on the prior turn, e.g. "what did I just say?").
6. Close the instance and create a fresh one — confirm it starts a new session.
7. Confirm no errors in the Electron main-process log related to provider routing, schema validation, or IPC rejection.

- [ ] **Step 5: Commit any fixups**

If any audit item above failed, create targeted fix commits. Reference the task # that should have covered it.

- [ ] **Step 6: Final commit and push**

```bash
git status      # verify clean working tree
git log --oneline -20  # sanity-check commit history tells the phase-by-phase story
```

No push — the repo's rule is "never commit or push without explicit user instruction." Inform the user the plan is fully executed and ready for review.

---

## Coverage checklist — spec sections to tasks

| Spec section | Covered by |
|---|---|
| §3 Contract changes (4 files) | Tasks 1–4 |
| §3 Shared types (3 files) | Tasks 6–9 |
| §3 Main-process integration (10 files) | Tasks 12, 13, 26–30 |
| §3 Renderer core (3 files) | Tasks 10, 31, 32 |
| §3 Renderer enumeration (16 long-tail files) | Task 31 Step 5 |
| §3 Already-handled plumbing (no changes) | Noted; no task |
| §4 Binary detection | Task 12 (`alternativePaths`) |
| §4 Non-interactive invocation | Task 15 |
| §4 Prompt delivery + systemPrompt | Task 16 |
| §4 Authentication | Task 30 (env allowlist) + Task 23 (keychain stderr) |
| §4 Event-to-OutputMessage mapping | Tasks 17–20 |
| §4 Multi-turn resume | Task 21 |
| §4 Thinking extraction | Inherited in Task 18 via `extractThinkingContent` |
| §4 Error surfacing | Task 22 (unknown flag), 23 (stderr, ENOENT), 20 (is_error), 21 (resume retry) |
| §4 Lifecycle | Task 23 |
| §4 Capabilities | Tasks 14 + 24 |
| §5 `CURSOR_MODELS`, `DEFAULT_MODELS`, `PROVIDER_MODEL_LIST`, `CLI_TO_PROVIDER_TYPE` | Tasks 6, 7 |
| §5 `MODEL_PRICING` fallback | Task 24 `updateUsageFromContext` |
| §5 `ProviderAdapterCapabilities` descriptor | Task 24 (`CAPABILITIES` const) |
| §5 `DEFAULT_CURSOR_CONFIG` | Task 24 |
| §5 Settings UI additions | Task 8 |
| §6 Error handling (all paths) | Tasks 20–23 |
| §7 Testing strategy (23 adapter + 6 provider tests) | Tasks 14–25 map 1:1 to test IDs |
| §8 Env allowlist | Task 30 |
| §8 No alias changes | Task 33 Step 2 |
| §9 Verification + integration audit | Task 33 |
| §10 Known limitations | Not implementation — documented in provider class-doc comments (added during Task 24) |
| §11 Implementation order | Tasks 1–33 follow spec's 14 phases, consolidated |

---

## Blocker tracking (from spec §3 + discovered during plan drafting)

| Blocker | Addressed by |
|---|---|
| `InstanceCreatePayloadSchema.provider` zod rejects `'cursor'` | Task 2 |
| `InstanceCreateWithMessagePayloadSchema.provider` zod rejects `'cursor'` | Task 2 |
| `SpawnChildPayloadSchema.provider` zod rejects `'cursor'` | Task 3 |
| `ConsensusProviderSpecSchema.provider` zod rejects `'cursor'` (newly discovered — not in §3 text) | Task 4 |
| `DEFAULT_PROVIDER_CONFIGS` type-error without `cursor` key | Task 26 |
| `resolveProviderName()` switch silently drops Cursor runtime events | Task 28 |
