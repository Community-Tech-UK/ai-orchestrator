# Wave 1: Command Registry & Overlay Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation for richer slash-command discovery, alias-aware resolution, declarative applicability gating, hybrid frecency tracking, and a reusable overlay shell that downstream waves (sessions, models, resume) plug into without backend churn.

**Architecture:** Extend `CommandTemplate` with a typed metadata model. Add a structured `CommandResolutionResult` returned by `CommandManager`. Build a presentational `OverlayShellComponent` driven by per-mode controllers (palette, help). Add a hybrid `UsageTracker` (main, source of truth, persisted in `electron-store`) with a write-through `UsageStore` cache in the renderer. Extract command IPC schemas into a new `@contracts/schemas/command` subpath, with the four-place alias sync (`tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, `vitest.config.ts`) called out per the project's packaging gotcha.

**Tech Stack:** TypeScript 5.9, Angular 21 (zoneless, signals), Electron 40, `electron-store`, Vitest, Zod 4, ESLint.

**Spec:** [`docs/superpowers/specs/2026-04-28-wave1-command-registry-and-overlay-design.md`](../specs/2026-04-28-wave1-command-registry-and-overlay-design.md)
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design.md`](../specs/2026-04-28-cross-repo-usability-upgrades-design.md)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`](./2026-04-28-cross-repo-usability-upgrades-plan.md)

---

## How to read this plan

- **Phases** group related tasks. Phases 1–4 are pure backend foundation and have no UI dependency. Phases 5–10 add frecency, IPC, and renderer state. Phases 11–15 deliver UI. Phase 16 is final verification.
- **Tasks** are bite-sized work units (target ≤ 30 minutes). Each ends with a commit.
- **TDD discipline:** behavioral code follows test → fail → implement → pass → commit. Pure type-only changes use type-check as the verification.
- **Verification commands** (run after every code-change task):
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - Targeted vitest spec(s) for the touched code
- **Critical rule (per `AGENTS.md`):** **NEVER run `git commit` without explicit user approval.** Every task below ends with a suggested commit message — run the commit only after the user approves. If operating under subagent-driven-development, surface the suggested message to the user before committing. **Never push to remote** under any circumstances; pushing is always the user's call.

## Phase index

1. Phase 1 — Foundational shared types and utilities
2. Phase 2 — Markdown frontmatter extension
3. Phase 3 — Command resolver
4. Phase 4 — Schema package extraction (`@contracts/schemas/command`)
5. Phase 5 — `UsageTracker` (main process)
6. Phase 6 — `GitProbeService` and `WORKSPACE_IS_GIT_REPO`
7. Phase 7 — `SettingsStore.featureFlags`
8. Phase 8 — Command IPC handler upgrade
9. Phase 9 — `CommandStore` renderer extension
10. Phase 10 — `UsageStore` (renderer cache + write-through)
11. Phase 11 — `OverlayShellComponent` and `OverlayController` interface
12. Phase 12 — `CommandPaletteController`
13. Phase 13 — Palette host refactor
14. Phase 14 — `/help` browser (`CommandHelpController` + host)
15. Phase 15 — Slash composer dropdown via controller
16. Phase 16 — Final integration, manual verification, packaged smoke test

---

## Phase 1 — Foundational shared types and utilities

These are pure-type and pure-function additions. No behavior coupling yet. After this phase, the new types compile but nothing consumes them.

### Task 1.1: Extend `CommandTemplate` with new optional fields

**Files:**
- Modify: `src/shared/types/command.types.ts`

- [ ] **Step 1: Add new exported types and extend `CommandTemplate`**

Edit `src/shared/types/command.types.ts`. Append to the existing file (do not delete existing exports). Add at the top of the file (after the existing imports — or as the file's first content if it has no imports):

```ts
import type { InstanceProvider, InstanceStatus } from './instance/instance.types';
```

> If the import path above does not resolve in your build, search for the file that exports `InstanceProvider` and `InstanceStatus` (`grep -rn "export.*InstanceProvider" src/renderer/app/core/state/instance/`) and adjust the import to match. The shared types file lives in `src/shared/types/`, but `InstanceProvider`/`InstanceStatus` may currently live in renderer state types — if so, move the type-only declarations into a shared location (`src/shared/types/provider.types.ts` or similar) as part of this step. Confirm with `npx tsc --noEmit` after.

In the same file, extend the `CommandTemplate` interface to add the new optional fields:

```ts
export interface CommandTemplate {
  // ── existing fields unchanged ──
  id: string;
  name: string;
  description: string;
  template: string;
  hint?: string;
  shortcut?: string;
  builtIn: boolean;
  source?: 'builtin' | 'store' | 'file';
  filePath?: string;
  model?: string;
  agent?: string;
  subtask?: boolean;
  priority?: number;
  execution?: CommandExecution;
  createdAt: number;
  updatedAt: number;

  // ── new (Wave 1) ──
  aliases?: string[];
  category?: CommandCategory;
  usage?: string;
  examples?: string[];
  applicability?: CommandApplicability;
  disabledReason?: string;
  rankHints?: CommandRankHints;
}

export type CommandCategory =
  | 'review'
  | 'navigation'
  | 'workflow'
  | 'session'
  | 'orchestration'
  | 'diagnostics'
  | 'memory'
  | 'settings'
  | 'skill'
  | 'custom';

export const COMMAND_CATEGORIES: readonly CommandCategory[] = [
  'review', 'navigation', 'workflow', 'session', 'orchestration',
  'diagnostics', 'memory', 'settings', 'skill', 'custom',
] as const;

export interface CommandApplicability {
  provider?: InstanceProvider | InstanceProvider[];
  instanceStatus?: InstanceStatus | InstanceStatus[];
  requiresWorkingDirectory?: boolean;
  requiresGitRepo?: boolean;
  featureFlag?: string;
  hideWhenIneligible?: boolean;
}

export interface CommandRankHints {
  pinned?: boolean;
  providerAffinity?: InstanceProvider[];
  weight?: number;
}
```

- [ ] **Step 2: Add resolution result types and diagnostic types**

Append to the same file:

```ts
export type CommandResolutionResult =
  | { kind: 'exact';     command: CommandTemplate; args: string[]; matchedBy: 'name' }
  | { kind: 'alias';     command: CommandTemplate; args: string[]; matchedBy: 'alias'; alias: string }
  | { kind: 'ambiguous'; query: string; candidates: CommandTemplate[]; conflictingAlias?: string }
  | { kind: 'fuzzy';     query: string; suggestions: CommandTemplate[] }
  | { kind: 'none';      query: string };

export type CommandDiagnosticCode =
  | 'alias-collision'
  | 'alias-shadowed-by-name'
  | 'name-collision'
  | 'invalid-frontmatter-type'
  | 'unknown-category'
  | 'unknown-applicability-key'
  | 'invalid-rank-hints'
  | 'unknown-feature-flag';

export interface CommandDiagnostic {
  code: CommandDiagnosticCode;
  message: string;
  commandId?: string;
  alias?: string;
  filePath?: string;
  candidates?: string[];
  severity: 'warn' | 'error';
}

export interface CommandRegistrySnapshot {
  commands: CommandTemplate[];
  diagnostics: CommandDiagnostic[];
  scanDirs: string[];
}
```

- [ ] **Step 3: Verify type-check**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both pass with no errors. If you see errors about `InstanceProvider` / `InstanceStatus`, fix the import path before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/command.types.ts
# also stage any provider.types.ts move if step 1 required one
git commit -m "feat(commands): extend CommandTemplate with aliases/category/usage/examples/applicability/rankHints + add resolution & diagnostic types"
```

---

### Task 1.2: Add `evaluateApplicability` helper with tests

**Files:**
- Create: `src/shared/utils/command-applicability.ts`
- Create: `src/shared/utils/__tests__/command-applicability.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/utils/__tests__/command-applicability.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateApplicability } from '../command-applicability';
import type { CommandApplicability } from '../../types/command.types';

const baseCmd = (a?: CommandApplicability, disabledReason?: string) => ({ applicability: a, disabledReason });

describe('evaluateApplicability', () => {
  it('returns eligible when applicability is undefined', () => {
    expect(evaluateApplicability(baseCmd(), {})).toEqual({ eligible: true });
  });

  it('blocks on provider mismatch (single value)', () => {
    const r = evaluateApplicability(baseCmd({ provider: 'claude' }), { provider: 'gemini' });
    expect(r.eligible).toBe(false);
    expect(r.failedPredicate).toBe('provider');
    expect(r.reason).toContain('claude');
  });

  it('allows provider in array', () => {
    const r = evaluateApplicability(baseCmd({ provider: ['claude', 'gemini'] }), { provider: 'gemini' });
    expect(r.eligible).toBe(true);
  });

  it('blocks when instanceStatus does not match', () => {
    const r = evaluateApplicability(baseCmd({ instanceStatus: 'idle' }), { instanceStatus: 'busy' });
    expect(r.eligible).toBe(false);
    expect(r.failedPredicate).toBe('instanceStatus');
  });

  it('blocks when requiresWorkingDirectory is true and ctx is null', () => {
    const r = evaluateApplicability(baseCmd({ requiresWorkingDirectory: true }), { workingDirectory: null });
    expect(r.eligible).toBe(false);
    expect(r.failedPredicate).toBe('workingDirectory');
  });

  it('blocks when requiresGitRepo is true and ctx isGitRepo is false', () => {
    const r = evaluateApplicability(baseCmd({ requiresGitRepo: true }), { workingDirectory: '/x', isGitRepo: false });
    expect(r.eligible).toBe(false);
    expect(r.failedPredicate).toBe('gitRepo');
  });

  it('treats unknown isGitRepo (undefined) as eligible (optimistic)', () => {
    const r = evaluateApplicability(baseCmd({ requiresGitRepo: true }), { workingDirectory: '/x' });
    expect(r.eligible).toBe(true);
  });

  it('blocks when featureFlag is missing or false', () => {
    const r = evaluateApplicability(baseCmd({ featureFlag: 'showThinking' }), { featureFlags: { showThinking: false } });
    expect(r.eligible).toBe(false);
    expect(r.failedPredicate).toBe('featureFlag');
  });

  it('AND-combines multiple predicates', () => {
    const r = evaluateApplicability(
      baseCmd({ provider: 'claude', instanceStatus: 'idle' }),
      { provider: 'claude', instanceStatus: 'busy' },
    );
    expect(r.eligible).toBe(false);
    expect(r.failedPredicate).toBe('instanceStatus');
  });

  it('lets disabledReason override the auto-generated reason', () => {
    const r = evaluateApplicability(baseCmd({ requiresGitRepo: true }, 'custom: not in repo'), { isGitRepo: false });
    expect(r.reason).toBe('custom: not in repo');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx vitest run src/shared/utils/__tests__/command-applicability.spec.ts
```

Expected: FAIL — `Cannot find module '../command-applicability'`.

- [ ] **Step 3: Implement `evaluateApplicability`**

Create `src/shared/utils/command-applicability.ts`:

```ts
import type { CommandTemplate } from '../types/command.types';
import type { InstanceProvider, InstanceStatus } from '../types/instance/instance.types';

export interface CommandContext {
  provider?: InstanceProvider;
  instanceStatus?: InstanceStatus;
  workingDirectory?: string | null;
  isGitRepo?: boolean;
  featureFlags?: Record<string, boolean>;
}

export interface ApplicabilityResult {
  eligible: boolean;
  reason?: string;
  failedPredicate?: 'provider' | 'instanceStatus' | 'workingDirectory' | 'gitRepo' | 'featureFlag';
}

const asArray = <T>(v: T | T[] | undefined): T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

export function evaluateApplicability(
  cmd: Pick<CommandTemplate, 'applicability' | 'disabledReason'>,
  ctx: CommandContext,
): ApplicabilityResult {
  const a = cmd.applicability;
  if (!a) return { eligible: true };

  const fail = (
    predicate: NonNullable<ApplicabilityResult['failedPredicate']>,
    autoReason: string,
  ): ApplicabilityResult => ({
    eligible: false,
    failedPredicate: predicate,
    reason: cmd.disabledReason ?? autoReason,
  });

  const providers = asArray(a.provider);
  if (providers && (!ctx.provider || !providers.includes(ctx.provider))) {
    return fail('provider', `Only available with ${providers.join('/')} (current: ${ctx.provider ?? 'none'})`);
  }

  const statuses = asArray(a.instanceStatus);
  if (statuses && (!ctx.instanceStatus || !statuses.includes(ctx.instanceStatus))) {
    return fail('instanceStatus', `Only available while ${statuses.join('/')} (current: ${ctx.instanceStatus ?? 'none'})`);
  }

  if (a.requiresWorkingDirectory && !ctx.workingDirectory) {
    return fail('workingDirectory', 'Requires a working directory');
  }

  // requiresGitRepo: undefined isGitRepo is treated as optimistic-eligible
  if (a.requiresGitRepo === true && ctx.isGitRepo === false) {
    return fail('gitRepo', 'Requires a git repository');
  }

  if (a.featureFlag) {
    const flagValue = ctx.featureFlags?.[a.featureFlag];
    if (!flagValue) {
      return fail('featureFlag', `Requires the ${a.featureFlag} setting`);
    }
  }

  return { eligible: true };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run src/shared/utils/__tests__/command-applicability.spec.ts
```

Expected: all tests pass.

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/shared/utils/command-applicability.ts src/shared/utils/__tests__/command-applicability.spec.ts
git commit -m "feat(commands): add evaluateApplicability shared util + tests"
```

---

### Task 1.3: Add `parseArgsFromQuery` helper with tests

**Files:**
- Create: `src/renderer/app/features/commands/command-args.util.ts`
- Create: `src/renderer/app/features/commands/__tests__/command-args.util.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/features/commands/__tests__/command-args.util.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseArgsFromQuery } from '../command-args.util';

describe('parseArgsFromQuery', () => {
  it('returns empty array when query is empty', () => {
    expect(parseArgsFromQuery('', 'review')).toEqual([]);
  });

  it('strips leading slash and command name', () => {
    expect(parseArgsFromQuery('/review focus errors', 'review')).toEqual(['focus', 'errors']);
  });

  it('handles query without leading slash', () => {
    expect(parseArgsFromQuery('review focus errors', 'review')).toEqual(['focus', 'errors']);
  });

  it('returns empty when query only contains the command name', () => {
    expect(parseArgsFromQuery('review', 'review')).toEqual([]);
  });

  it('returns empty when query is only a partial of the command name', () => {
    expect(parseArgsFromQuery('rev', 'review')).toEqual([]);
  });

  it('is case-insensitive on the command name', () => {
    expect(parseArgsFromQuery('REVIEW focus', 'review')).toEqual(['focus']);
  });

  it('collapses multiple whitespace runs', () => {
    expect(parseArgsFromQuery('review   focus    errors', 'review')).toEqual(['focus', 'errors']);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx vitest run src/renderer/app/features/commands/__tests__/command-args.util.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parseArgsFromQuery`**

Create `src/renderer/app/features/commands/command-args.util.ts`:

```ts
/**
 * Parse arg tokens from a search/composer query, given the resolved command name.
 *
 *   parseArgsFromQuery('/review focus errors', 'review') → ['focus', 'errors']
 *   parseArgsFromQuery('review focus errors',  'review') → ['focus', 'errors']
 *   parseArgsFromQuery('rev', 'review')                  → []
 *   parseArgsFromQuery('',    'review')                  → []
 */
export function parseArgsFromQuery(query: string, commandName: string): string[] {
  const trimmed = (query ?? '').trim();
  if (!trimmed) return [];

  const stripped = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const afterCommand = stripped.replace(new RegExp(`^${escapeRegExp(commandName)}(\\s+|$)`, 'i'), '');

  if (!afterCommand) return [];
  return afterCommand.split(/\s+/).filter(Boolean);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run src/renderer/app/features/commands/__tests__/command-args.util.spec.ts
```

Expected: all tests pass.

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/renderer/app/features/commands/command-args.util.ts src/renderer/app/features/commands/__tests__/command-args.util.spec.ts
git commit -m "feat(commands): add parseArgsFromQuery util + tests"
```

---

## Phase 2 — Markdown frontmatter extension

After this phase, markdown commands can declare new metadata, and unrecognized fields produce diagnostics rather than crashes. No UI consumes the new data yet.

### Task 2.1: Test new frontmatter fields are parsed

**Files:**
- Modify: `src/main/commands/__tests__/markdown-command-registry.spec.ts`

- [ ] **Step 1: Read the existing spec**

```bash
cat src/main/commands/__tests__/markdown-command-registry.spec.ts | head -80
```

Note the helper utilities used (e.g. how the spec mocks `fs.promises` and creates a temporary directory). Write new tests that follow the same conventions.

- [ ] **Step 2: Append a new describe block**

Append to `src/main/commands/__tests__/markdown-command-registry.spec.ts`:

```ts
describe('frontmatter — extended fields (Wave 1)', () => {
  it('parses aliases as array', async () => {
    const dir = await makeTempCommandsDir({
      'r.md': `---
name: review
aliases: ["r","rev"]
category: review
usage: "/review [focus...]"
examples:
  - "/review focus error handling"
---
Review the changes.
`,
    });
    const reg = MarkdownCommandRegistry.getInstance();
    const { commands } = await reg.listCommands(dir);
    const cmd = commands.find(c => c.name === 'review')!;
    expect(cmd.aliases).toEqual(['r', 'rev']);
    expect(cmd.category).toBe('review');
    expect(cmd.usage).toBe('/review [focus...]');
    expect(cmd.examples).toEqual(['/review focus error handling']);
  });

  it('parses comma-separated aliases string', async () => {
    const dir = await makeTempCommandsDir({
      'r.md': `---
name: review
aliases: "r, rev"
---
Body.
`,
    });
    const reg = MarkdownCommandRegistry.getInstance();
    const { commands } = await reg.listCommands(dir);
    expect(commands.find(c => c.name === 'review')!.aliases).toEqual(['r', 'rev']);
  });

  it('parses applicability nested object', async () => {
    const dir = await makeTempCommandsDir({
      'commit.md': `---
name: commit
applicability:
  provider: claude
  requiresGitRepo: true
disabledReason: "Requires a git repository"
---
Body.
`,
    });
    const { commands } = await MarkdownCommandRegistry.getInstance().listCommands(dir);
    const cmd = commands.find(c => c.name === 'commit')!;
    expect(cmd.applicability).toEqual({ provider: ['claude'], requiresGitRepo: true });
    expect(cmd.disabledReason).toBe('Requires a git repository');
  });

  it('parses rankHints', async () => {
    const dir = await makeTempCommandsDir({
      'pin.md': `---
name: pin
rankHints:
  pinned: true
  providerAffinity: ["claude"]
  weight: 1.5
---
Body.
`,
    });
    const { commands } = await MarkdownCommandRegistry.getInstance().listCommands(dir);
    expect(commands.find(c => c.name === 'pin')!.rankHints).toEqual({
      pinned: true,
      providerAffinity: ['claude'],
      weight: 1.5,
    });
  });
});
```

> The helper `makeTempCommandsDir` may not exist. If not, add it to the same file or a sibling helper module. Prefer `fs.mkdtemp` + `path.join` to write files into a real temporary directory, and call `_resetMarkdownCommandRegistryForTesting()` in `beforeEach`. Do not mock `fs` for these tests — exercise the real walker.

- [ ] **Step 3: Run the test and confirm it fails**

```bash
npx vitest run src/main/commands/__tests__/markdown-command-registry.spec.ts -t "extended fields"
```

Expected: FAIL — fields are undefined on the parsed command.

- [ ] **Step 4: Commit failing test (TDD red phase)**

```bash
git add src/main/commands/__tests__/markdown-command-registry.spec.ts
git commit -m "test(commands): add failing tests for extended markdown frontmatter (red)"
```

---

### Task 2.2: Implement frontmatter extension (happy path)

**Files:**
- Modify: `src/main/commands/markdown-command-registry.ts`

- [ ] **Step 1: Extend the `CommandFrontmatter` type**

In `src/main/commands/markdown-command-registry.ts`, replace the existing `type CommandFrontmatter = …` block with:

```ts
type CommandFrontmatter = {
  name?: string;
  description?: string;
  'argument-hint'?: string;
  argumentHint?: string;
  hint?: string;
  model?: string;
  agent?: string;
  subtask?: boolean;

  aliases?: string | string[];
  category?: string;
  usage?: string;
  examples?: string | string[];
  applicability?: {
    provider?: string | string[];
    instanceStatus?: string | string[];
    requiresWorkingDirectory?: boolean;
    requiresGitRepo?: boolean;
    featureFlag?: string;
    hideWhenIneligible?: boolean;
  };
  disabledReason?: string;
  rankHints?: {
    pinned?: boolean;
    providerAffinity?: string | string[];
    weight?: number;
  };
};
```

- [ ] **Step 2: Add coercion helpers (private at top of file)**

Add inside the file (above the class):

```ts
import { COMMAND_CATEGORIES, type CommandCategory, type CommandApplicability, type CommandRankHints } from '../../shared/types/command.types';
import type { CommandDiagnostic } from '../../shared/types/command.types';

function toStringArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return undefined;
}
```

- [ ] **Step 3: Map new fields onto the `CommandTemplate`**

Inside `loadCommandsForWorkingDirectory`, in the per-file loop, after the existing `model`, `agent`, `subtask` extraction, add:

```ts
const aliases = toStringArray(parsed.data.aliases);

const rawCategory = typeof parsed.data.category === 'string' ? parsed.data.category.trim() : undefined;
const category: CommandCategory | undefined =
  rawCategory && (COMMAND_CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as CommandCategory)
    : undefined;

const usage = typeof parsed.data.usage === 'string' ? parsed.data.usage : undefined;
const examples = toStringArray(parsed.data.examples);

const applicabilityRaw = parsed.data.applicability;
let applicability: CommandApplicability | undefined;
if (applicabilityRaw && typeof applicabilityRaw === 'object' && !Array.isArray(applicabilityRaw)) {
  applicability = {};
  const prov = toStringArray(applicabilityRaw.provider);
  if (prov) applicability.provider = prov as CommandApplicability['provider'];
  const status = toStringArray(applicabilityRaw.instanceStatus);
  if (status) applicability.instanceStatus = status as CommandApplicability['instanceStatus'];
  if (typeof applicabilityRaw.requiresWorkingDirectory === 'boolean') applicability.requiresWorkingDirectory = applicabilityRaw.requiresWorkingDirectory;
  if (typeof applicabilityRaw.requiresGitRepo === 'boolean') applicability.requiresGitRepo = applicabilityRaw.requiresGitRepo;
  if (typeof applicabilityRaw.featureFlag === 'string') applicability.featureFlag = applicabilityRaw.featureFlag;
  if (typeof applicabilityRaw.hideWhenIneligible === 'boolean') applicability.hideWhenIneligible = applicabilityRaw.hideWhenIneligible;
  if (Object.keys(applicability).length === 0) applicability = undefined;
}

const disabledReason = typeof parsed.data.disabledReason === 'string' ? parsed.data.disabledReason : undefined;

const rankHintsRaw = parsed.data.rankHints;
let rankHints: CommandRankHints | undefined;
if (rankHintsRaw && typeof rankHintsRaw === 'object' && !Array.isArray(rankHintsRaw)) {
  rankHints = {};
  if (typeof rankHintsRaw.pinned === 'boolean') rankHints.pinned = rankHintsRaw.pinned;
  const aff = toStringArray(rankHintsRaw.providerAffinity);
  if (aff) rankHints.providerAffinity = aff as CommandRankHints['providerAffinity'];
  if (typeof rankHintsRaw.weight === 'number') rankHints.weight = Math.max(0, Math.min(3, rankHintsRaw.weight));
  if (Object.keys(rankHints).length === 0) rankHints = undefined;
}
```

Then update the call to `this.toCommandTemplate({...})` and the helper signature itself to thread these new fields:

```ts
const cmd = this.toCommandTemplate({
  name, template, description, hint, filePath, model, agent, subtask, priority: sourcePriority,
  aliases, category, usage, examples, applicability, disabledReason, rankHints,
});
```

And update `toCommandTemplate` to accept and forward them:

```ts
private toCommandTemplate(params: {
  name: string;
  template: string;
  description: string;
  hint?: string;
  filePath: string;
  model?: string;
  agent?: string;
  subtask?: boolean;
  priority?: number;
  aliases?: string[];
  category?: CommandCategory;
  usage?: string;
  examples?: string[];
  applicability?: CommandApplicability;
  disabledReason?: string;
  rankHints?: CommandRankHints;
}): CommandTemplate {
  const now = Date.now();
  return {
    id: createMarkdownCommandId(params.name),
    name: params.name,
    description: params.description,
    template: params.template,
    hint: params.hint,
    builtIn: false,
    createdAt: now,
    updatedAt: now,
    source: 'file',
    filePath: params.filePath,
    model: params.model,
    agent: params.agent,
    subtask: params.subtask,
    priority: params.priority,
    aliases: params.aliases,
    category: params.category,
    usage: params.usage,
    examples: params.examples,
    applicability: params.applicability,
    disabledReason: params.disabledReason,
    rankHints: params.rankHints,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run src/main/commands/__tests__/markdown-command-registry.spec.ts
```

Expected: the new tests pass; existing tests continue to pass.

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/commands/markdown-command-registry.ts
git add src/main/commands/markdown-command-registry.ts
git commit -m "feat(commands): parse extended frontmatter fields (aliases, category, usage, examples, applicability, rankHints)"
```

---

### Task 2.3: Test backwards-compat & diagnostics emission

**Files:**
- Modify: `src/main/commands/__tests__/markdown-command-registry.spec.ts`

- [ ] **Step 1: Add the failing diagnostic-emission tests**

Append:

```ts
describe('frontmatter — diagnostics (Wave 1)', () => {
  it('emits unknown-category diagnostic and defaults to undefined category', async () => {
    const dir = await makeTempCommandsDir({
      'x.md': `---
name: x
category: bogus
---
Body.
`,
    });
    const { commands, diagnostics } = await MarkdownCommandRegistry.getInstance().listCommands(dir);
    const cmd = commands.find(c => c.name === 'x')!;
    expect(cmd.category).toBeUndefined();
    expect(diagnostics.find(d => d.code === 'unknown-category' && d.commandId === cmd.id)).toBeDefined();
  });

  it('drops invalid aliases and emits invalid-frontmatter-type', async () => {
    const dir = await makeTempCommandsDir({
      'y.md': `---
name: y
aliases: 5
---
Body.
`,
    });
    const { commands, diagnostics } = await MarkdownCommandRegistry.getInstance().listCommands(dir);
    const cmd = commands.find(c => c.name === 'y')!;
    expect(cmd.aliases).toBeUndefined();
    expect(diagnostics.find(d => d.code === 'invalid-frontmatter-type' && d.commandId === cmd.id)).toBeDefined();
  });

  it('drops alias that shadows a primary command name and emits alias-shadowed-by-name', async () => {
    const dir = await makeTempCommandsDir({
      'a.md': `---
name: review
aliases: ["commit"]
---
Body.
`,
      'b.md': `---
name: commit
---
Body.
`,
    });
    const { commands, diagnostics } = await MarkdownCommandRegistry.getInstance().listCommands(dir);
    const review = commands.find(c => c.name === 'review')!;
    expect(review.aliases ?? []).not.toContain('commit');
    expect(diagnostics.find(d => d.code === 'alias-shadowed-by-name' && d.alias === 'commit')).toBeDefined();
  });

  it('emits alias-collision when two commands declare the same alias', async () => {
    const dir = await makeTempCommandsDir({
      'a.md': `---
name: alpha
aliases: ["a"]
---
Body.
`,
      'b.md': `---
name: beta
aliases: ["a"]
---
Body.
`,
    });
    const { diagnostics } = await MarkdownCommandRegistry.getInstance().listCommands(dir);
    expect(diagnostics.find(d => d.code === 'alias-collision' && d.alias === 'a')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/commands/__tests__/markdown-command-registry.spec.ts -t "diagnostics"
```

Expected: FAIL — `listCommands` does not currently return `diagnostics`.

- [ ] **Step 3: Commit failing tests**

```bash
git add src/main/commands/__tests__/markdown-command-registry.spec.ts
git commit -m "test(commands): add failing tests for frontmatter diagnostics (red)"
```

---

### Task 2.4: Implement diagnostics emission

**Files:**
- Modify: `src/main/commands/markdown-command-registry.ts`

- [ ] **Step 1: Extend `CacheEntry` to track diagnostics**

In `src/main/commands/markdown-command-registry.ts`, find the `interface CacheEntry { ... }` block and add:

```ts
interface CacheEntry {
  loadedAt: number;
  commandsByName: Map<string, CommandTemplate>;
  candidatesByName: Map<string, CommandTemplate[]>;
  scanDirs: string[];
  diagnostics: CommandDiagnostic[];
}
```

- [ ] **Step 2: Build a diagnostics collector during load**

In `loadCommandsForWorkingDirectory`, declare at the top:

```ts
const diagnostics: CommandDiagnostic[] = [];
```

Whenever the per-file mapping detects an invalid frontmatter type, emit a diagnostic. For example, replace the existing `aliases = toStringArray(...)` line with:

```ts
let aliases: string[] | undefined;
if (parsed.data.aliases !== undefined) {
  aliases = toStringArray(parsed.data.aliases);
  if (aliases === undefined) {
    diagnostics.push({
      code: 'invalid-frontmatter-type',
      message: `Field "aliases" must be a string or string[]`,
      commandId: createMarkdownCommandId(name),
      filePath,
      severity: 'warn',
    });
  }
}
```

Apply the same pattern (emit `invalid-frontmatter-type` when a field is present but not the expected type) for: `category` (when present but non-string → diagnostic; when present-string but not in `COMMAND_CATEGORIES` → emit `unknown-category` and leave category undefined), `usage`, `examples`, `applicability`, `disabledReason`, `rankHints`.

For `unknown-category` specifically, emit:

```ts
if (rawCategory && !(COMMAND_CATEGORIES as readonly string[]).includes(rawCategory)) {
  diagnostics.push({
    code: 'unknown-category',
    message: `Unknown category "${rawCategory}"; falling back to undefined`,
    commandId: createMarkdownCommandId(name),
    filePath,
    severity: 'warn',
  });
}
```

For unknown applicability keys:

```ts
if (applicabilityRaw && typeof applicabilityRaw === 'object' && !Array.isArray(applicabilityRaw)) {
  const knownKeys = ['provider','instanceStatus','requiresWorkingDirectory','requiresGitRepo','featureFlag','hideWhenIneligible'];
  for (const k of Object.keys(applicabilityRaw)) {
    if (!knownKeys.includes(k)) {
      diagnostics.push({
        code: 'unknown-applicability-key',
        message: `Unknown applicability key "${k}"`,
        commandId: createMarkdownCommandId(name),
        filePath,
        severity: 'warn',
      });
    }
  }
}
```

- [ ] **Step 3: Compute alias / name collisions across the loaded set**

After the per-file loop completes (still inside `loadCommandsForWorkingDirectory`), add:

```ts
// alias-shadowed-by-name and alias-collision
const primaryNames = new Set<string>();
for (const cmd of commandsByName.values()) primaryNames.add(cmd.name.toLowerCase());

const aliasOwners = new Map<string, CommandTemplate[]>();
for (const cmd of commandsByName.values()) {
  if (!cmd.aliases) continue;
  const cleaned: string[] = [];
  for (const alias of cmd.aliases) {
    const lower = alias.toLowerCase();
    if (primaryNames.has(lower)) {
      diagnostics.push({
        code: 'alias-shadowed-by-name',
        message: `Alias "${alias}" shadowed by primary command name`,
        commandId: cmd.id,
        alias,
        filePath: cmd.filePath,
        severity: 'warn',
      });
      continue; // drop alias
    }
    cleaned.push(alias);
    const owners = aliasOwners.get(lower) ?? [];
    owners.push(cmd);
    aliasOwners.set(lower, owners);
  }
  cmd.aliases = cleaned.length > 0 ? cleaned : undefined;
}

for (const [lower, owners] of aliasOwners) {
  if (owners.length > 1) {
    diagnostics.push({
      code: 'alias-collision',
      message: `Alias "${lower}" claimed by ${owners.length} commands`,
      alias: lower,
      candidates: owners.map(o => o.name),
      severity: 'warn',
    });
    // drop the alias from each owner
    for (const o of owners) {
      o.aliases = (o.aliases ?? []).filter(a => a.toLowerCase() !== lower);
      if (o.aliases.length === 0) o.aliases = undefined;
    }
  }
}

// name-collision (already handled by precedence; emit informational)
const namesByLower = new Map<string, string[]>();
for (const cmd of commandsByName.values()) {
  const lower = cmd.name.toLowerCase();
  const arr = namesByLower.get(lower) ?? [];
  arr.push(cmd.name);
  namesByLower.set(lower, arr);
}
for (const [, arr] of namesByLower) {
  if (arr.length > 1) {
    diagnostics.push({
      code: 'name-collision',
      message: `Multiple commands share name "${arr[0]}"; lower-priority entries shadowed`,
      candidates: arr,
      severity: 'warn',
    });
  }
}
```

> Note: the `commandsByName` map already keeps only the highest-priority command per name (existing precedence). The `name-collision` diagnostic is emitted for visibility only.

- [ ] **Step 4: Save diagnostics to the cache entry and surface them**

Update the cache write at the end of `loadCommandsForWorkingDirectory`:

```ts
this.cacheByWorkingDir.set(workingDirectory, {
  loadedAt: Date.now(),
  commandsByName,
  candidatesByName,
  scanDirs,
  diagnostics,
});
```

Update `listCommands` to return `diagnostics`:

```ts
async listCommands(workingDirectory: string): Promise<{
  commands: CommandTemplate[];
  candidatesByName: Record<string, CommandTemplate[]>;
  scanDirs: string[];
  diagnostics: CommandDiagnostic[];
}> {
  // ... existing body ...
  return {
    commands,
    candidatesByName,
    scanDirs: entry.scanDirs.slice(),
    diagnostics: entry.diagnostics.slice(),
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npx vitest run src/main/commands/__tests__/markdown-command-registry.spec.ts
```

Expected: all pass (existing + new).

- [ ] **Step 6: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/commands/markdown-command-registry.ts
git add src/main/commands/markdown-command-registry.ts src/main/commands/__tests__/markdown-command-registry.spec.ts
git commit -m "feat(commands): emit registry diagnostics (alias-collision, alias-shadowed-by-name, unknown-category, invalid-frontmatter-type, unknown-applicability-key, name-collision)"
```

---

## Phase 3 — Command resolver

### Task 3.1: `getAllCommandsSnapshot` on `CommandManager`

**Files:**
- Modify: `src/main/commands/command-manager.ts`

- [ ] **Step 1: Write the failing test**

Open `src/main/commands/__tests__/command-manager.spec.ts` and append:

```ts
describe('getAllCommandsSnapshot', () => {
  it('returns commands plus diagnostics from markdown registry', async () => {
    mockListCommands.mockResolvedValue({
      commands: [],
      candidatesByName: {},
      scanDirs: ['/tmp/p/.claude/commands'],
      diagnostics: [
        { code: 'alias-collision', message: 'foo', alias: 'a', candidates: ['x','y'], severity: 'warn' },
      ],
    });

    const manager = new CommandManager();
    const snap = await manager.getAllCommandsSnapshot('/tmp/p');
    expect(snap.commands.length).toBeGreaterThanOrEqual(BUILT_IN_COMMANDS.length);
    expect(snap.diagnostics.find(d => d.code === 'alias-collision')).toBeDefined();
    expect(snap.scanDirs).toEqual(['/tmp/p/.claude/commands']);
  });

  it('returns empty diagnostics when no working directory is provided', async () => {
    const manager = new CommandManager();
    const snap = await manager.getAllCommandsSnapshot();
    expect(snap.diagnostics).toEqual([]);
  });
});
```

(`BUILT_IN_COMMANDS` is already imported via `command.types`.)

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/commands/__tests__/command-manager.spec.ts -t "getAllCommandsSnapshot"
```

Expected: FAIL — method not defined.

- [ ] **Step 3: Implement the method**

In `src/main/commands/command-manager.ts`, add:

```ts
import type { CommandRegistrySnapshot, CommandDiagnostic } from '../../shared/types/command.types';

// inside the class:
async getAllCommandsSnapshot(workingDirectory?: string): Promise<CommandRegistrySnapshot> {
  const localCommands = this.getLocalCommands();
  if (!workingDirectory) {
    return { commands: localCommands, diagnostics: [], scanDirs: [] };
  }
  const reg = await getMarkdownCommandRegistry().listCommands(workingDirectory);
  const localNames = new Set(localCommands.map(c => c.name));
  const merged = [
    ...localCommands,
    ...reg.commands.filter(c => !localNames.has(c.name)),
  ];
  return {
    commands: merged,
    diagnostics: reg.diagnostics.slice(),
    scanDirs: reg.scanDirs.slice(),
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run src/main/commands/__tests__/command-manager.spec.ts
```

Expected: all pass.

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/commands/command-manager.ts src/main/commands/__tests__/command-manager.spec.ts
git commit -m "feat(commands): add CommandManager.getAllCommandsSnapshot returning commands + diagnostics"
```

---

### Task 3.2: Add `resolveCommand` — exact and alias matching

**Files:**
- Modify: `src/main/commands/command-manager.ts`
- Create: `src/main/commands/__tests__/command-resolver.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/commands/__tests__/command-resolver.spec.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandTemplate } from '../../../shared/types/command.types';

const { customCommands, mockListCommands } = vi.hoisted(() => ({
  customCommands: [] as CommandTemplate[],
  mockListCommands: vi.fn(),
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    store: { customCommands },
    get: vi.fn(() => customCommands),
    set: vi.fn((_k, v: CommandTemplate[]) => { customCommands.splice(0, customCommands.length, ...v); }),
  })),
}));

vi.mock('../markdown-command-registry', () => ({
  getMarkdownCommandRegistry: vi.fn(() => ({
    listCommands: mockListCommands,
    getCommand: vi.fn(),
  })),
}));

import { CommandManager } from '../command-manager';

beforeEach(() => {
  customCommands.splice(0, customCommands.length);
  vi.clearAllMocks();
  mockListCommands.mockResolvedValue({ commands: [], candidatesByName: {}, scanDirs: [], diagnostics: [] });
});

describe('resolveCommand — exact and alias', () => {
  it('returns kind=none when input is not a slash command', async () => {
    const m = new CommandManager();
    const r = await m.resolveCommand('hello');
    expect(r.kind).toBe('none');
  });

  it('returns kind=exact for exact name match', async () => {
    const m = new CommandManager();
    const r = await m.resolveCommand('/review focus');
    expect(r.kind).toBe('exact');
    if (r.kind === 'exact') {
      expect(r.command.name).toBe('review');
      expect(r.args).toEqual(['focus']);
      expect(r.matchedBy).toBe('name');
    }
  });

  it('returns kind=alias for alias match', async () => {
    customCommands.push({
      id: 'custom-1', name: 'foo', description: 'd', template: 't', builtIn: false,
      createdAt: 0, updatedAt: 0, source: 'store', aliases: ['f','foo2'],
    } as CommandTemplate);

    const m = new CommandManager();
    const r = await m.resolveCommand('/f bar');
    expect(r.kind).toBe('alias');
    if (r.kind === 'alias') {
      expect(r.command.name).toBe('foo');
      expect(r.alias).toBe('f');
      expect(r.args).toEqual(['bar']);
    }
  });

  it('drops aliases that shadow a primary name when resolving', async () => {
    customCommands.push({
      id: 'custom-1', name: 'foo', description: 'd', template: 't', builtIn: false,
      createdAt: 0, updatedAt: 0, source: 'store', aliases: ['review'],
    } as CommandTemplate);

    const m = new CommandManager();
    const r = await m.resolveCommand('/review');
    expect(r.kind).toBe('exact');
    if (r.kind === 'exact') expect(r.command.name).toBe('review');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/commands/__tests__/command-resolver.spec.ts
```

Expected: FAIL — `resolveCommand` not defined.

- [ ] **Step 3: Implement `resolveCommand` (exact + alias only)**

In `src/main/commands/command-manager.ts`, extend the existing top-level import block from `'../../shared/types/command.types'` to include `CommandResolutionResult` (the file already imports `parseCommandString` and `CommandTemplate`):

```ts
import {
  CommandTemplate,
  ParsedCommand,
  BUILT_IN_COMMANDS,
  getCommandExecution,
  getMarkdownCommandNameFromId,
  isMarkdownCommandId,
  resolveTemplate,
  parseCommandString,
  type CommandResolutionResult,
} from '../../shared/types/command.types';
```

Then add the new method inside the class:

```ts
// inside the class:
async resolveCommand(input: string, workingDirectory?: string): Promise<CommandResolutionResult> {
  const parsed = parseCommandString(input);
  if (!parsed) return { kind: 'none', query: input };

  const snap = await this.getAllCommandsSnapshot(workingDirectory);
  const visible = snap.commands;
  const queryLower = parsed.name.toLowerCase();

  // 1. Exact name match (case-insensitive)
  const exact = visible.find(c => c.name.toLowerCase() === queryLower);
  if (exact) {
    return { kind: 'exact', command: exact, args: parsed.args, matchedBy: 'name' };
  }

  // 2. Alias index — alias loses to primary names
  const primaryNamesLower = new Set(visible.map(c => c.name.toLowerCase()));
  const aliasIndex = new Map<string, CommandTemplate[]>();
  for (const c of visible) {
    if (!c.aliases) continue;
    for (const alias of c.aliases) {
      const lower = alias.toLowerCase();
      if (primaryNamesLower.has(lower)) continue; // shadowed
      const owners = aliasIndex.get(lower) ?? [];
      owners.push(c);
      aliasIndex.set(lower, owners);
    }
  }

  const aliasOwners = aliasIndex.get(queryLower);
  if (aliasOwners) {
    if (aliasOwners.length === 1) {
      return { kind: 'alias', command: aliasOwners[0], args: parsed.args, matchedBy: 'alias', alias: queryLower };
    }
    return { kind: 'ambiguous', query: parsed.name, candidates: aliasOwners.slice(), conflictingAlias: queryLower };
  }

  // 3. Fuzzy match (placeholder — see Task 3.3)
  return { kind: 'none', query: parsed.name };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run src/main/commands/__tests__/command-resolver.spec.ts
```

Expected: all pass.

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit
git add src/main/commands/command-manager.ts src/main/commands/__tests__/command-resolver.spec.ts
git commit -m "feat(commands): add resolveCommand — exact and alias matching"
```

---

### Task 3.3: Add fuzzy matching to `resolveCommand`

**Files:**
- Create: `src/main/commands/fuzzy-match.ts`
- Create: `src/main/commands/__tests__/fuzzy-match.spec.ts`
- Modify: `src/main/commands/command-manager.ts`
- Modify: `src/main/commands/__tests__/command-resolver.spec.ts`

- [ ] **Step 1: Write fuzzy-match tests**

Create `src/main/commands/__tests__/fuzzy-match.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { damerauLevenshtein, fuzzyRank } from '../fuzzy-match';

describe('damerauLevenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(damerauLevenshtein('a', 'a')).toBe(0);
  });

  it('counts a single substitution as 1', () => {
    expect(damerauLevenshtein('cat', 'bat')).toBe(1);
  });

  it('counts a single transposition as 1', () => {
    expect(damerauLevenshtein('ab', 'ba')).toBe(1);
  });

  it('counts a single deletion as 1', () => {
    // 'review' → 'rview' removes the leading 'e' (1 deletion)
    expect(damerauLevenshtein('review', 'rview')).toBe(1);
  });

  it('counts a single insertion as 1', () => {
    expect(damerauLevenshtein('rview', 'review')).toBe(1);
  });

  it('handles longer mixed edits', () => {
    // 'kitten' → 'sitting': substitute k→s, e→i, insert g  ⇒ 3
    expect(damerauLevenshtein('kitten', 'sitting')).toBe(3);
  });
});

describe('fuzzyRank', () => {
  it('returns matching candidates ordered by ascending distance', () => {
    // 'reveiw' vs:
    //   'review'  → 1 (transposition ei↔ie)
    //   'replay'  → 4
    //   'restore' → 5
    const out = fuzzyRank('reveiw', ['review', 'replay', 'restore'], { threshold: 2, max: 5 });
    expect(out).toEqual(['review']);
  });

  it('caps results at max', () => {
    const out = fuzzyRank('a', ['a', 'b', 'c', 'd', 'e'], { threshold: 1, max: 2 });
    expect(out.length).toBe(2);
  });

  it('returns empty when no candidates within threshold', () => {
    expect(fuzzyRank('zzzz', ['review'], { threshold: 1, max: 5 })).toEqual([]);
  });

  it('breaks ties at equal distance by prefix match, then alphabetical', () => {
    // distances from 'aar' to:
    //   'aardvark' → 5  (out of threshold 2 — excluded)
    //   'aab'      → 1  (prefix match: 'aar' starts with 'aar' → 'aab' does not start with 'aar' → prefix=1)
    //   'aas'      → 1  (also no prefix match)
    //   'aar'      → 0  (exact)
    // 'aar' itself wins on distance 0.
    const out = fuzzyRank('aar', ['aardvark', 'aab', 'aas', 'aar'], { threshold: 2, max: 5 });
    expect(out[0]).toBe('aar');
    // The remaining two are at the same distance (1); neither is a prefix of 'aar', so alphabetical wins.
    expect(out.slice(1)).toEqual(['aab', 'aas']);
  });

  it('prefers prefix-matching candidate at the same distance over a non-prefix one', () => {
    // 'comm' vs:
    //   'commit'  → 2 (insert 'i','t'); prefix-of-'comm' starts with 'comm' → prefix=0
    //   'common'  → 2 (insert 'o','n'); prefix=0 (also starts with 'comm')
    //   'comb'    → 1 (substitute m→b at end? actually 'comm'→'comb' is 1 substitution); prefix=1
    // Sort: 'comb'(1), then 'commit'(2,prefix=0) and 'common'(2,prefix=0) tie-broken alphabetically → 'commit' before 'common'.
    const out = fuzzyRank('comm', ['commit', 'common', 'comb'], { threshold: 2, max: 5 });
    expect(out).toEqual(['comb', 'commit', 'common']);
  });
});
```

> Confirm each distance assertion above by hand-walking the DP table once. If a number is off, fix the input strings — **not** the threshold — so the tests stay precise about behavior, not lenient.

- [ ] **Step 2: Implement `damerauLevenshtein` and `fuzzyRank`**

Create `src/main/commands/fuzzy-match.ts`:

```ts
/**
 * Compute Damerau-Levenshtein distance with adjacent transpositions counted as 1.
 * Standard DP, O(n*m) time and space — fine for short slash names.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const dp: number[][] = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[al][bl];
}

export interface FuzzyRankOptions {
  threshold: number;
  max: number;
}

export function fuzzyRank(query: string, candidates: string[], opts: FuzzyRankOptions): string[] {
  const q = query.toLowerCase();
  const scored = candidates
    .map(c => ({ c, d: damerauLevenshtein(q, c.toLowerCase()), prefix: c.toLowerCase().startsWith(q) ? 0 : 1 }))
    .filter(x => x.d <= opts.threshold)
    .sort((a, b) => a.d - b.d || a.prefix - b.prefix || a.c.localeCompare(b.c));

  return scored.slice(0, opts.max).map(x => x.c);
}
```

- [ ] **Step 3: Run fuzzy-match tests**

```bash
npx vitest run src/main/commands/__tests__/fuzzy-match.spec.ts
```

Expected: pass.

- [ ] **Step 4: Wire fuzzy match into `resolveCommand`**

In `src/main/commands/command-manager.ts`, replace the placeholder `// 3. Fuzzy match` comment block with:

```ts
import { fuzzyRank } from './fuzzy-match';

// (inside resolveCommand, replacing the trailing `return { kind: 'none', ... }`)
const allNames: string[] = [];
const nameToCmd = new Map<string, CommandTemplate>();
for (const c of visible) {
  allNames.push(c.name);
  nameToCmd.set(c.name.toLowerCase(), c);
  if (c.aliases) {
    for (const alias of c.aliases) {
      if (primaryNamesLower.has(alias.toLowerCase())) continue;
      allNames.push(alias);
      // alias may map to a command different from name; preserve the first owner
      if (!nameToCmd.has(alias.toLowerCase())) {
        nameToCmd.set(alias.toLowerCase(), c);
      }
    }
  }
}

const fuzzy = fuzzyRank(parsed.name, allNames, { threshold: 2, max: 5 });
if (fuzzy.length > 0) {
  const seen = new Set<string>();
  const suggestions: CommandTemplate[] = [];
  for (const name of fuzzy) {
    const owner = nameToCmd.get(name.toLowerCase());
    if (owner && !seen.has(owner.id)) {
      seen.add(owner.id);
      suggestions.push(owner);
    }
  }
  return { kind: 'fuzzy', query: parsed.name, suggestions };
}

return { kind: 'none', query: parsed.name };
```

- [ ] **Step 5: Add a fuzzy-path test in resolver spec**

Append to `src/main/commands/__tests__/command-resolver.spec.ts`:

```ts
describe('resolveCommand — fuzzy', () => {
  it('returns kind=fuzzy with nearby builtin suggestions on typo', async () => {
    const m = new CommandManager();
    const r = await m.resolveCommand('/reveiw');
    expect(r.kind).toBe('fuzzy');
    if (r.kind === 'fuzzy') expect(r.suggestions.find(c => c.name === 'review')).toBeDefined();
  });

  it('returns kind=none when nothing close', async () => {
    const m = new CommandManager();
    const r = await m.resolveCommand('/zzzzzqq');
    expect(r.kind).toBe('none');
  });
});
```

- [ ] **Step 6: Run all resolver tests**

```bash
npx vitest run src/main/commands/__tests__/command-resolver.spec.ts src/main/commands/__tests__/fuzzy-match.spec.ts
```

Expected: pass.

- [ ] **Step 7: Type-check and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/commands/fuzzy-match.ts src/main/commands/command-manager.ts src/main/commands/__tests__/fuzzy-match.spec.ts src/main/commands/__tests__/command-resolver.spec.ts
git commit -m "feat(commands): add Damerau-Levenshtein fuzzy match path to resolveCommand"
```

---

## Phase 4 — Schema package extraction

After this phase, command schemas live in their own `command.schemas.ts` and are reachable via `@contracts/schemas/command` from main, renderer, and vitest. The four-place alias sync is verified by `npx tsc --noEmit` from each context AND by running the full test suite.

### Task 4.1: Move command schemas into `command.schemas.ts`

**Files:**
- Create: `packages/contracts/src/schemas/command.schemas.ts`
- Modify: `packages/contracts/src/schemas/instance.schemas.ts`

- [ ] **Step 1: Create the new schemas file with the moved + new definitions**

Create `packages/contracts/src/schemas/command.schemas.ts`:

```ts
import { z } from 'zod';
import { InstanceIdSchema } from './instance.schemas';

const CommandIdSchema = z.string().min(1).max(100);

export const CommandListPayloadSchema = z.object({
  workingDirectory: z.string().min(1).max(10000).optional(),
});

export const CommandRegistrySnapshotPayloadSchema = z.object({
  workingDirectory: z.string().min(1).max(10000).optional(),
});

export const CommandResolvePayloadSchema = z.object({
  input: z.string().min(1).max(10000),
  instanceId: InstanceIdSchema.optional(),
});

export const CommandExecutePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  commandId: CommandIdSchema,
  args: z.array(z.string().max(10000)).max(50).optional(),
});

export const CommandCreatePayloadSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  template: z.string().min(1).max(100000),
  hint: z.string().max(1000).optional(),
  shortcut: z.string().max(50).optional(),
});

export const CommandUpdatePayloadSchema = z.object({
  commandId: CommandIdSchema,
  updates: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(1000).optional(),
    template: z.string().min(1).max(100000).optional(),
    hint: z.string().max(1000).optional(),
    shortcut: z.string().max(50).optional(),
  }),
});

export const CommandDeletePayloadSchema = z.object({
  commandId: CommandIdSchema,
});

export const UsageGetSnapshotPayloadSchema = z.object({}).strict();

// Category-aware payload (Wave 1 ships this; Waves 2/3 add their own
// categories without changing the wire protocol). The previous
// `{ commandId }` shape is intentionally not preserved — Wave 1 is the
// foundation, so callers must use the new envelope from day one.
export const UsageRecordPayloadSchema = z.object({
  category: z.string().min(1).max(64),
  id: z.string().min(1).max(200),
  projectPath: z.string().min(1).max(10000).optional(),
});

export const WorkspaceIsGitRepoPayloadSchema = z.object({
  workingDirectory: z.string().min(1).max(10000),
});
```

- [ ] **Step 2: Add a deprecation re-export shim in `instance.schemas.ts`**

In `packages/contracts/src/schemas/instance.schemas.ts`, find the existing `CommandListPayloadSchema`, `CommandExecutePayloadSchema`, `CommandCreatePayloadSchema`, `CommandUpdatePayloadSchema`, `CommandDeletePayloadSchema` exports (lines ~161–196 per the spec) and replace them with re-exports:

```ts
// Deprecated: command schemas have moved to ./command.schemas.ts. These
// re-exports exist for one wave to avoid breaking unmigrated importers.
// Remove after Wave 2.
export {
  CommandListPayloadSchema,
  CommandExecutePayloadSchema,
  CommandCreatePayloadSchema,
  CommandUpdatePayloadSchema,
  CommandDeletePayloadSchema,
} from './command.schemas';
```

- [ ] **Step 3: Verify type-check from a renderer/main perspective**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: pass. (We have not yet added the path alias for `@contracts/schemas/command`, but no consumer imports it yet — the shim keeps `instance.schemas`-based imports working.)

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/schemas/command.schemas.ts packages/contracts/src/schemas/instance.schemas.ts
git commit -m "refactor(contracts): split command schemas into command.schemas.ts with re-export shim"
```

---

### Task 4.2: Add the four-place alias sync for `@contracts/schemas/command`

**Files:**
- Modify: `tsconfig.json`
- Modify: `tsconfig.electron.json`
- Modify: `src/main/register-aliases.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Update `tsconfig.json`**

Open `tsconfig.json`. Locate `compilerOptions.paths`. Add:

```jsonc
"@contracts/schemas/command": ["./packages/contracts/src/schemas/command.schemas.ts"]
```

(insert next to the existing `@contracts/schemas/instance` entry).

- [ ] **Step 2: Update `tsconfig.electron.json`**

Open `tsconfig.electron.json`. Add the same entry under `compilerOptions.paths`.

- [ ] **Step 3: Update `src/main/register-aliases.ts`**

In `src/main/register-aliases.ts`, inside the `exactAliases` object, add:

```ts
'@contracts/schemas/command': path.join(baseContracts, 'schemas', 'command.schemas'),
```

(adjacent to the existing `'@contracts/schemas/instance'` line).

- [ ] **Step 4: Update `vitest.config.ts`**

Open `vitest.config.ts`. If it has a `resolve.alias` block, add a corresponding entry mapping `@contracts/schemas/command` to the file. If aliases are computed from `tsconfig`, this step is a no-op — verify by reading the file.

- [ ] **Step 5: Sanity import test**

Add a tiny throwaway import inside `src/main/commands/command-manager.ts` to verify the alias resolves at type-check time:

```ts
// Temporary: remove in Task 4.3 once a real importer uses the alias
import type { CommandResolvePayloadSchema as _CommandResolvePayloadSchema } from '@contracts/schemas/command';
type _UnusedAliasProbe = typeof _CommandResolvePayloadSchema;
```

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both pass.

- [ ] **Step 6: Remove the throwaway import; commit the alias-sync changes**

Delete the two `Temporary:` lines above. Then:

```bash
npx tsc --noEmit
git add tsconfig.json tsconfig.electron.json src/main/register-aliases.ts vitest.config.ts src/main/commands/command-manager.ts
git commit -m "build(contracts): wire @contracts/schemas/command path alias in tsconfig/electron-tsconfig/register-aliases/vitest"
```

---

## Phase 5 — `UsageTracker` (main process)

### Task 5.1: Test `UsageTracker` basics

**Files:**
- Create: `src/main/observability/__tests__/usage-tracker.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/observability/__tests__/usage-tracker.spec.ts`:

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

import { UsageTracker, _resetUsageTrackerForTesting } from '../usage-tracker';

describe('UsageTracker', () => {
  beforeEach(() => {
    storeMap.clear();
    _resetUsageTrackerForTesting();
  });

  it('starts empty', () => {
    const t = new UsageTracker();
    expect(t.getCommandSnapshot()).toEqual({});
  });

  it('records and retrieves', () => {
    const t = new UsageTracker();
    t.recordCommand('cmd1');
    const snap = t.getCommandSnapshot();
    expect(snap.cmd1.count).toBe(1);
    expect(typeof snap.cmd1.lastUsedAt).toBe('number');
  });

  it('increments count on repeat record', () => {
    const t = new UsageTracker();
    t.recordCommand('cmd1');
    t.recordCommand('cmd1');
    expect(t.getCommandSnapshot().cmd1.count).toBe(2);
  });

  it('records per-project overlay alongside global', () => {
    const t = new UsageTracker();
    t.recordCommand('cmd1', '/project/a');
    const rec = t.getCommandSnapshot().cmd1;
    expect(rec.count).toBe(1);
    expect(rec.byProject?.['/project/a']?.count).toBe(1);
  });

  it('emits change events to listeners', () => {
    const t = new UsageTracker();
    const seen: unknown[] = [];
    const off = t.onChange(d => seen.push(d));
    t.recordCommand('x');
    expect(seen).toHaveLength(1);
    off();
    t.recordCommand('x');
    expect(seen).toHaveLength(1);
  });

  it('frecency decays over time', () => {
    const t = new UsageTracker();
    t.recordCommand('hot');
    const fresh = t.getCommandFrecency('hot', undefined, Date.now());
    const stale = t.getCommandFrecency('hot', undefined, Date.now() + 60 * 86400 * 1000);
    expect(fresh).toBeGreaterThan(stale);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/observability/__tests__/usage-tracker.spec.ts
```

Expected: FAIL — module not found.

---

### Task 5.2: Implement `UsageTracker`

**Files:**
- Create: `src/main/observability/usage-tracker.ts`

- [ ] **Step 1: Implement the singleton**

Create `src/main/observability/usage-tracker.ts`:

```ts
import ElectronStore from 'electron-store';

/**
 * Category-aware usage record. Wave 1 ships category 'commands'; Waves 2/3 add
 * 'sessions' and 'resumes' (and possibly 'models'). Categories are open-ended
 * strings to avoid coupling Wave 1's schema to downstream waves.
 */
export type UsageCategory = string; // domain-defined: 'commands' | 'sessions' | 'resumes' | 'models' | ...

export interface UsageRecord {
  count: number;
  lastUsedAt: number;
  byProject?: Record<string, { count: number; lastUsedAt: number }>;
}

/** Backwards-compatible alias kept for existing call sites. */
export type CommandUsageRecord = UsageRecord;

interface UsageStoreV1 {
  schemaVersion: 1;
  /** Map of category -> map of id -> record. Wave 1 seeds 'commands'. */
  byCategory: Record<UsageCategory, Record<string, UsageRecord>>;
}

interface Store<T> {
  store: T;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
}

const DEFAULTS: UsageStoreV1 = { schemaVersion: 1, byCategory: { commands: {} } };

export class UsageTracker {
  private store: Store<UsageStoreV1>;
  private listeners = new Set<(delta: { category: UsageCategory; id: string; record: UsageRecord }) => void>();

  constructor() {
    this.store = new ElectronStore<UsageStoreV1>({
      name: 'usage-tracker',
      defaults: DEFAULTS,
    }) as unknown as Store<UsageStoreV1>;
  }

  /** Get the full per-category map. */
  getSnapshot(category: UsageCategory): Record<string, UsageRecord> {
    return this.store.get('byCategory')?.[category] ?? {};
  }

  /** Return every category-keyed bucket — used by the IPC `getSnapshot` handler so the renderer can hydrate every category in one round trip. */
  getAllCategories(): Record<UsageCategory, Record<string, UsageRecord>> {
    return { ...(this.store.get('byCategory') ?? {}) };
  }

  /** Wave 1 convenience for the 'commands' category. */
  getCommandSnapshot(): Record<string, UsageRecord> {
    return this.getSnapshot('commands');
  }

  record(category: UsageCategory, id: string, projectPath?: string): void {
    const byCategory = { ...(this.store.get('byCategory') ?? {}) };
    const all = { ...(byCategory[category] ?? {}) };
    const now = Date.now();
    const prev: UsageRecord = all[id] ?? { count: 0, lastUsedAt: 0 };
    const next: UsageRecord = {
      count: prev.count + 1,
      lastUsedAt: now,
      byProject: prev.byProject ? { ...prev.byProject } : undefined,
    };
    if (projectPath) {
      const prevP = next.byProject?.[projectPath] ?? { count: 0, lastUsedAt: 0 };
      next.byProject = {
        ...(next.byProject ?? {}),
        [projectPath]: { count: prevP.count + 1, lastUsedAt: now },
      };
    }
    all[id] = next;
    byCategory[category] = all;
    this.store.set('byCategory', byCategory);
    for (const listener of this.listeners) listener({ category, id, record: next });
  }

  /** Wave 1 convenience for the 'commands' category. */
  recordCommand(commandId: string, projectPath?: string): void {
    this.record('commands', commandId, projectPath);
  }

  getFrecency(category: UsageCategory, id: string, projectPath?: string, now: number = Date.now()): number {
    const rec = this.store.get('byCategory')?.[category]?.[id];
    if (!rec) return 0;

    let count = rec.count;
    let lastUsedAt = rec.lastUsedAt;
    if (projectPath && rec.byProject?.[projectPath]) {
      count = rec.byProject[projectPath].count;
      lastUsedAt = rec.byProject[projectPath].lastUsedAt;
    }
    const ageMs = Math.max(0, now - lastUsedAt);
    const decay = ageMs <= 86400_000 ? 1.0
      : ageMs <= 7 * 86400_000 ? 0.6
      : ageMs <= 30 * 86400_000 ? 0.3
      : 0.1;
    return Math.log2(count + 1) * decay;
  }

  /** Wave 1 convenience for the 'commands' category. */
  getCommandFrecency(commandId: string, projectPath?: string, now: number = Date.now()): number {
    return this.getFrecency('commands', commandId, projectPath, now);
  }

  reset(category: UsageCategory, id: string): void {
    const byCategory = { ...(this.store.get('byCategory') ?? {}) };
    const all = { ...(byCategory[category] ?? {}) };
    delete all[id];
    byCategory[category] = all;
    this.store.set('byCategory', byCategory);
  }

  resetCommand(commandId: string): void { this.reset('commands', commandId); }

  onChange(
    listener: (delta: { category: UsageCategory; id: string; record: UsageRecord }) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// Note: category-keyed schema is shipped from Wave 1 specifically so that
// Waves 2 (sessions, models pickers) and 3 (resume picker) can call
// `record('sessions', sessionId, projectPath)` and `getFrecency('sessions', ...)`
// without a Wave 2 migration. The 'commands' category is the only one populated
// in Wave 1; downstream waves add their own categories on first use (the
// nested map is created lazily inside `record`).

let instance: UsageTracker | null = null;

export function getUsageTracker(): UsageTracker {
  if (!instance) instance = new UsageTracker();
  return instance;
}

export function _resetUsageTrackerForTesting(): void {
  instance = null;
}
```

- [ ] **Step 2: Run the tests and confirm they pass**

```bash
npx vitest run src/main/observability/__tests__/usage-tracker.spec.ts
```

Expected: pass.

- [ ] **Step 3: Type-check and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/observability/usage-tracker.ts src/main/observability/__tests__/usage-tracker.spec.ts
git commit -m "feat(usage): add UsageTracker singleton with frecency scoring + per-project overlay"
```

---

### Task 5.3: Add `USAGE_*` IPC handlers

**Files:**
- Create: `src/main/ipc/handlers/usage-handlers.ts`
- Create or modify: `packages/contracts/src/channels/infrastructure.channels.ts` (add new channel constants there — this is the single source of truth for IPC channel names)
- Run after editing channels: `npm run generate:ipc` (regenerates `src/preload/generated/channels.ts`) and `npm run verify:ipc` (sanity check)

> **IPC source-of-truth note (repo-specific):** `src/shared/types/ipc.types.ts` is now a deprecated re-export shim — see its file header. New channel string literals MUST go in `packages/contracts/src/channels/<domain>.channels.ts`, where they are merged into `IPC_CHANNELS` by `packages/contracts/src/channels/index.ts`. The generator script (`scripts/generate-preload-channels.js`) writes the merged object to `src/preload/generated/channels.ts`, which the preload script imports at runtime. Do NOT add channels to `src/shared/types/ipc.types.ts` directly — the change won't reach the runtime preload bundle.

- [ ] **Step 1: Add IPC channel constants to the contracts channel file**

Pick the appropriate domain file. Usage / command / workspace channels fit either under `infrastructure.channels.ts` (existing) or a new `command.channels.ts` if you prefer narrower domains. The example below extends `infrastructure.channels.ts`; if you create a new file, register it in `packages/contracts/src/channels/index.ts` so the generator picks it up.

Open `packages/contracts/src/channels/infrastructure.channels.ts` and append:

```ts
export const COMMAND_REGISTRY_CHANNELS = {
  COMMAND_RESOLVE: 'command:resolve',
  COMMAND_REGISTRY_SNAPSHOT: 'command:registrySnapshot',
  USAGE_GET_SNAPSHOT: 'usage:getSnapshot',
  USAGE_RECORD: 'usage:record',
  USAGE_DELTA: 'usage:delta',
  WORKSPACE_IS_GIT_REPO: 'workspace:isGitRepo',
} as const;
```

Then merge `COMMAND_REGISTRY_CHANNELS` into `INFRASTRUCTURE_CHANNELS` (or include it in `index.ts`'s aggregator) so it shows up in `IPC_CHANNELS`. After editing, run:

```bash
npm run generate:ipc
npm run verify:ipc
```

The generator updates `src/preload/generated/channels.ts`. Commit the regenerated file with the channel changes.

- [ ] **Step 2: Implement the handler module**

Create `src/main/ipc/handlers/usage-handlers.ts`:

```ts
import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import { UsageGetSnapshotPayloadSchema, UsageRecordPayloadSchema } from '@contracts/schemas/command';
import { getUsageTracker } from '../../observability/usage-tracker';

export function registerUsageHandlers(): void {
  const tracker = getUsageTracker();

  ipcMain.handle(IPC_CHANNELS.USAGE_GET_SNAPSHOT, async (_e: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
    try {
      validateIpcPayload(UsageGetSnapshotPayloadSchema, payload ?? {}, 'USAGE_GET_SNAPSHOT');
      // Send the full category-keyed map so the renderer's `UsageStore` can
      // populate every category (commands, sessions, resumes, …) in one round trip.
      return { success: true, data: { byCategory: tracker.getAllCategories() } };
    } catch (err) {
      return { success: false, error: { code: 'USAGE_GET_FAILED', message: (err as Error).message, timestamp: Date.now() } };
    }
  });

  ipcMain.handle(IPC_CHANNELS.USAGE_RECORD, async (_e: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
    try {
      const v = validateIpcPayload(UsageRecordPayloadSchema, payload, 'USAGE_RECORD');
      tracker.record(v.category, v.id, v.projectPath);
      return { success: true, data: { ok: true } };
    } catch (err) {
      return { success: false, error: { code: 'USAGE_RECORD_FAILED', message: (err as Error).message, timestamp: Date.now() } };
    }
  });

  // Push deltas to all renderer windows
  tracker.onChange(delta => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.USAGE_DELTA, delta);
    }
  });
}
```

- [ ] **Step 3: Register the handler in `src/main/index.ts`**

Open `src/main/index.ts`. Find the section where existing IPC handlers are registered (search for `registerCommandHandlers` or similar). Add:

```ts
import { registerUsageHandlers } from './ipc/handlers/usage-handlers';

// adjacent to other register* calls during app bootstrap:
registerUsageHandlers();
```

- [ ] **Step 4: Type-check, lint, commit**

```bash
npm run generate:ipc
npm run verify:ipc
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/ipc/handlers/usage-handlers.ts
git add packages/contracts/src/channels/ src/preload/generated/channels.ts src/main/ipc/handlers/usage-handlers.ts src/main/index.ts
# Suggested commit (run only after user approval per AGENTS.md):
# git commit -m "feat(usage): wire USAGE_GET_SNAPSHOT / USAGE_RECORD / USAGE_DELTA IPC channels"
```

---

## Phase 6 — `GitProbeService` and `WORKSPACE_IS_GIT_REPO`

### Task 6.1: Main-process `WORKSPACE_IS_GIT_REPO` handler

**Files:**
- Create: `src/main/workspace/git-probe-handler.ts`
- Create: `src/main/workspace/__tests__/git-probe-handler.spec.ts`

- [ ] **Step 1: Write a failing unit test for the path-walking helper**

Create `src/main/workspace/__tests__/git-probe-handler.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { isGitRepoSync } from '../git-probe-handler';

describe('isGitRepoSync', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'gitprobe-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns false when no .git directory anywhere up the tree', () => {
    const sub = path.join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(isGitRepoSync(sub)).toBe(false);
  });

  it('returns true when .git exists at the working dir', () => {
    mkdirSync(path.join(root, '.git'));
    expect(isGitRepoSync(root)).toBe(true);
  });

  it('returns true when .git exists in a parent dir', () => {
    mkdirSync(path.join(root, '.git'));
    const sub = path.join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(isGitRepoSync(sub)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/workspace/__tests__/git-probe-handler.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handler module**

Create `src/main/workspace/git-probe-handler.ts`:

```ts
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC_CHANNELS, type IpcResponse } from '../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import { WorkspaceIsGitRepoPayloadSchema } from '@contracts/schemas/command';

export function isGitRepoSync(workingDirectory: string): boolean {
  let dir = path.resolve(workingDirectory);
  for (;;) {
    try {
      const s = fs.statSync(path.join(dir, '.git'));
      if (s.isDirectory() || s.isFile()) return true;
    } catch { /* fall through */ }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function registerWorkspaceGitProbeHandler(): void {
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_IS_GIT_REPO, async (_e: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
    try {
      const v = validateIpcPayload(WorkspaceIsGitRepoPayloadSchema, payload, 'WORKSPACE_IS_GIT_REPO');
      return { success: true, data: { isGitRepo: isGitRepoSync(v.workingDirectory) } };
    } catch (err) {
      return { success: false, error: { code: 'GIT_PROBE_FAILED', message: (err as Error).message, timestamp: Date.now() } };
    }
  });
}
```

- [ ] **Step 4: Register the handler in `src/main/index.ts`**

```ts
import { registerWorkspaceGitProbeHandler } from './workspace/git-probe-handler';

// ...
registerWorkspaceGitProbeHandler();
```

- [ ] **Step 5: Run tests, type-check, commit**

```bash
npx vitest run src/main/workspace/__tests__/git-probe-handler.spec.ts
npx tsc --noEmit
npm run lint -- src/main/workspace/git-probe-handler.ts
git add src/main/workspace/git-probe-handler.ts src/main/workspace/__tests__/git-probe-handler.spec.ts src/main/index.ts
git commit -m "feat(workspace): add WORKSPACE_IS_GIT_REPO IPC handler with parent-dir walking"
```

---

### Task 6.2: Renderer `GitProbeService`

**Files:**
- Create: `src/renderer/app/core/services/git-probe.service.ts`
- Create: `src/renderer/app/core/services/__tests__/git-probe.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/core/services/__tests__/git-probe.service.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { GitProbeService } from '../git-probe.service';

const mockInvoke = vi.fn();
vi.stubGlobal('window', {
  electronAPI: { invoke: mockInvoke },
});

describe('GitProbeService', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    TestBed.configureTestingModule({});
  });

  it('returns undefined for never-probed working directory', () => {
    const svc = TestBed.inject(GitProbeService);
    expect(svc.isGitRepo('/x')).toBeUndefined();
  });

  it('caches result after probe', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, data: { isGitRepo: true } });
    const svc = TestBed.inject(GitProbeService);
    await svc.probe('/x');
    expect(svc.isGitRepo('/x')).toBe(true);
  });

  it('returns false when probe says false', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, data: { isGitRepo: false } });
    const svc = TestBed.inject(GitProbeService);
    await svc.probe('/y');
    expect(svc.isGitRepo('/y')).toBe(false);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
npx vitest run src/renderer/app/core/services/__tests__/git-probe.service.spec.ts
```

Expected: FAIL — service not defined.

- [ ] **Step 3: Implement the service**

Create `src/renderer/app/core/services/git-probe.service.ts`:

```ts
import { Injectable } from '@angular/core';

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry { value: boolean; expiresAt: number }

@Injectable({ providedIn: 'root' })
export class GitProbeService {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<boolean>>();

  isGitRepo(workingDirectory: string | null): boolean | undefined {
    if (!workingDirectory) return undefined;
    const entry = this.cache.get(workingDirectory);
    if (!entry || entry.expiresAt < Date.now()) return undefined;
    return entry.value;
  }

  async probe(workingDirectory: string): Promise<boolean> {
    const cached = this.cache.get(workingDirectory);
    if (cached && cached.expiresAt >= Date.now()) return cached.value;
    const existing = this.inflight.get(workingDirectory);
    if (existing) return existing;

    const p = this.invokeProbe(workingDirectory).finally(() => this.inflight.delete(workingDirectory));
    this.inflight.set(workingDirectory, p);
    return p;
  }

  private async invokeProbe(workingDirectory: string): Promise<boolean> {
    const electronAPI = (window as { electronAPI?: { invoke: (channel: string, payload: unknown) => Promise<{ success: boolean; data?: { isGitRepo: boolean }; error?: { message: string } }> } }).electronAPI;
    if (!electronAPI) return false;
    const res = await electronAPI.invoke('workspace:isGitRepo', { workingDirectory });
    const value = res.success && !!res.data?.isGitRepo;
    this.cache.set(workingDirectory, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  }

  invalidate(workingDirectory?: string): void {
    if (!workingDirectory) this.cache.clear();
    else this.cache.delete(workingDirectory);
  }
}
```

> The exact `electronAPI.invoke` shape varies; if the project uses a generated typed client (e.g. `CommandIpcService` in `src/renderer/app/core/services/ipc/`), use that instead of raw `window.electronAPI`. Replace this method body with a call through the typed service. Confirm by reading `src/renderer/app/core/services/ipc/electron-ipc.service.ts`.

- [ ] **Step 4: Run tests, type-check, commit**

```bash
npx vitest run src/renderer/app/core/services/__tests__/git-probe.service.spec.ts
npx tsc --noEmit
git add src/renderer/app/core/services/git-probe.service.ts src/renderer/app/core/services/__tests__/git-probe.service.spec.ts
git commit -m "feat(workspace): add renderer GitProbeService with 5-minute TTL cache"
```

---

## Phase 7 — `SettingsStore.featureFlags`

### Task 7.1: Add `featureFlags` computed to `SettingsStore`

**Files:**
- Modify: `src/renderer/app/core/state/settings.store.ts`
- Create: `src/renderer/app/core/state/__tests__/settings.store.featureFlags.spec.ts` (or extend the existing settings spec if present)

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/core/state/__tests__/settings.store.featureFlags.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SettingsStore } from '../settings.store';

describe('SettingsStore.featureFlags', () => {
  beforeEach(() => TestBed.configureTestingModule({}));

  it('returns a record with the boolean settings keys', () => {
    const store = TestBed.inject(SettingsStore);
    const flags = store.featureFlags();
    expect(typeof flags.showThinking).toBe('boolean');
    expect(typeof flags.showToolMessages).toBe('boolean');
    expect(typeof flags.defaultYoloMode).toBe('boolean');
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
npx vitest run src/renderer/app/core/state/__tests__/settings.store.featureFlags.spec.ts
```

Expected: FAIL — `featureFlags` is not a property of `SettingsStore`.

- [ ] **Step 3: Implement**

In `src/renderer/app/core/state/settings.store.ts`, add right after the existing `readonly remoteNodesRequireTls` computed (or any logical location alongside other computed signals):

```ts
readonly featureFlags = computed<Record<string, boolean>>(() => {
  const s = this._settings();
  return {
    showToolMessages: s.showToolMessages,
    showThinking: s.showThinking,
    thinkingDefaultExpanded: s.thinkingDefaultExpanded,
    defaultYoloMode: s.defaultYoloMode,
    remoteNodesEnabled: s.remoteNodesEnabled,
    remoteNodesAutoOffloadBrowser: s.remoteNodesAutoOffloadBrowser,
    remoteNodesAutoOffloadGpu: s.remoteNodesAutoOffloadGpu,
    remoteNodesRequireTls: s.remoteNodesRequireTls,
  };
});
```

- [ ] **Step 4: Tests, type-check, commit**

```bash
npx vitest run src/renderer/app/core/state/__tests__/settings.store.featureFlags.spec.ts
npx tsc --noEmit
git add src/renderer/app/core/state/settings.store.ts src/renderer/app/core/state/__tests__/settings.store.featureFlags.spec.ts
git commit -m "feat(settings): expose featureFlags computed for command applicability evaluation"
```

---

## Phase 8 — Command IPC handler upgrade

### Task 8.1: Upgrade `COMMAND_LIST` to return `CommandRegistrySnapshot` (atomic with renderer adapter)

**Files (atomic — both edited together; the commit only happens after BOTH typecheck and lint pass):**
- Modify: `src/main/ipc/handlers/command-handlers.ts`
- Modify: `src/renderer/app/core/state/command.store.ts` (the `loadCommands()` consumer that calls the IPC)

> **Why atomic:** A previous draft of this plan permitted a deliberately-broken intermediate typecheck and commit ("intentional WIP"). That violates the project's completion standard ("After making code changes, always verify your changes compile and lint correctly" — `AGENTS.md`). Either ship both halves of the migration in one task, or split into a sequence where each step compiles green. We choose atomic.

- [ ] **Step 1: Update the main-side handler**

In `src/main/ipc/handlers/command-handlers.ts`, replace the `COMMAND_LIST` handler body with:

```ts
ipcMain.handle(
  IPC_CHANNELS.COMMAND_LIST,
  async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(CommandListPayloadSchema, payload ?? {}, 'COMMAND_LIST');
      const snap = await commands.getAllCommandsSnapshot(validated.workingDirectory);
      return { success: true, data: snap };
    } catch (error) {
      return { success: false, error: { code: 'COMMAND_LIST_FAILED', message: (error as Error).message, timestamp: Date.now() } };
    }
  },
);
```

The IPC response now carries a `CommandRegistrySnapshot` (commands + diagnostics + scanDirs).

- [ ] **Step 2: Update the renderer consumer in the same patch**

Find the `commandStore.loadCommands()` (or equivalent IPC consumer) call site in `src/renderer/app/core/state/command.store.ts`. It currently receives `CommandTemplate[]`; switch it to consume `CommandRegistrySnapshot`. At minimum:

```ts
const snap = await ipc.invoke<CommandRegistrySnapshot>(IPC_CHANNELS.COMMAND_LIST, { workingDirectory });
this.commands.set(snap.commands);
this.diagnostics.set(snap.diagnostics);  // new signal — wire it; consumed in Phase 9 / Wave 6
this.scanDirs.set(snap.scanDirs);
```

(Field names may differ — match the signal/store conventions already present.)

- [ ] **Step 3: Both halves green or no commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

ALL THREE must pass. If any fail, finish the patch — DO NOT commit a knowingly-broken state.

- [ ] **Step 4: Suggested commit (run only after user approval per AGENTS.md)**

```bash
git add src/main/ipc/handlers/command-handlers.ts src/renderer/app/core/state/command.store.ts
# Suggested: git commit -m "refactor(commands): COMMAND_LIST returns CommandRegistrySnapshot (main + renderer)"
```

---

### Task 8.2: Add `COMMAND_RESOLVE` handler

**Files:**
- Modify: `src/main/ipc/handlers/command-handlers.ts`

- [ ] **Step 1: Add the handler**

In the same file, after the `COMMAND_LIST` handler, add:

```ts
import { CommandResolvePayloadSchema } from '@contracts/schemas/command';

// ...

ipcMain.handle(
  IPC_CHANNELS.COMMAND_RESOLVE,
  async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
    try {
      const v = validateIpcPayload(CommandResolvePayloadSchema, payload, 'COMMAND_RESOLVE');
      const wd = v.instanceId
        ? instanceManager.getInstance(v.instanceId)?.workingDirectory
        : undefined;
      const result = await commands.resolveCommand(v.input, wd);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: { code: 'COMMAND_RESOLVE_FAILED', message: (error as Error).message, timestamp: Date.now() } };
    }
  },
);
```

- [ ] **Step 2: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/main/ipc/handlers/command-handlers.ts
git add src/main/ipc/handlers/command-handlers.ts
git commit -m "feat(commands): add COMMAND_RESOLVE IPC handler returning CommandResolutionResult"
```

---

### Task 8.3: Enrich `COMMAND_EXECUTE` errors and applicability check

**Files:**
- Modify: `src/main/ipc/handlers/command-handlers.ts`

- [ ] **Step 0: Add the static imports the new handler needs**

At the top of `src/main/ipc/handlers/command-handlers.ts`, add (next to the existing imports):

```ts
import { evaluateApplicability } from '../../../shared/utils/command-applicability';
import { getUsageTracker } from '../../observability/usage-tracker';
import { isGitRepoSync } from '../../workspace/git-probe-handler';
```

- [ ] **Step 1: Update the handler**

Replace the body of `COMMAND_EXECUTE` with the version below (preserves existing compact / ui execution branches):

```ts
ipcMain.handle(
  IPC_CHANNELS.COMMAND_EXECUTE,
  async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(CommandExecutePayloadSchema, payload, 'COMMAND_EXECUTE');
      const inst = instanceManager.getInstance(validated.instanceId);
      const wd = inst?.workingDirectory;

      const command = await commands.getCommand(validated.commandId, wd);
      if (!command) {
        // Nearest-match suggestions are produced by COMMAND_RESOLVE when a user
        // types a slash command; here we already have a stable id, so a not-found
        // is the result of either a stale UI cache or an explicit bad call.
        return {
          success: false,
          error: {
            code: 'COMMAND_NOT_FOUND',
            message: `Command ${validated.commandId} not found`,
            timestamp: Date.now(),
          },
        };
      }

      // applicability gate — load-bearing: main MUST enforce, not just trust the renderer.
      // A direct ipcMain.handle invocation can bypass any UI-side disabled state, so the
      // applicability check is the only authoritative gate before we mutate state.
      // Wave 1 Task 6.1 ships `isGitRepoSync(wd)` for cheap sync gating; use it here so
      // `requiresGitRepo` is strictly enforced on main, not optimistically eligible.
      // (`isGitRepoSync` walks at most a few parent dirs and never blocks on I/O for long;
      // it is safe to call inline in an IPC handler.)
      const isGitRepo = wd ? isGitRepoSync(wd) : false;

      const ctx = {
        provider: inst?.provider as undefined,
        instanceStatus: inst?.status as undefined,
        workingDirectory: wd ?? null,
        isGitRepo,
      };
      const eligibility = evaluateApplicability(command, ctx);
      if (!eligibility.eligible) {
        return {
          success: false,
          error: {
            code: 'COMMAND_DISABLED',
            message: eligibility.reason ?? 'Command unavailable in current context',
            timestamp: Date.now(),
            failedPredicate: eligibility.failedPredicate,
          },
        };
      }

      const executed = await commands.executeCommand(validated.commandId, validated.args || [], wd);
      if (!executed) {
        return { success: false, error: { code: 'COMMAND_NOT_FOUND', message: `Command ${validated.commandId} not found`, timestamp: Date.now() } };
      }

      if (executed.execution.type === 'compact') {
        const result = await getCompactionCoordinator().compactInstance(validated.instanceId);
        return {
          success: result.success,
          data: result,
          error: result.success ? undefined : { code: 'COMPACT_FAILED', message: result.error || 'Compaction failed', timestamp: Date.now() },
        };
      }

      if (executed.execution.type === 'ui') {
        return { success: true, data: executed };
      }

      await instanceManager.sendInput(validated.instanceId, executed.resolvedPrompt);

      // record usage on success (advisory — never block the response)
      try {
        getUsageTracker().recordCommand(executed.command.id, wd);
      } catch { /* recording failure is advisory, do not fail the request */ }

      return { success: true, data: executed };
    } catch (error) {
      return { success: false, error: { code: 'COMMAND_EXECUTE_FAILED', message: (error as Error).message, timestamp: Date.now() } };
    }
  },
);
```

- [ ] **Step 2: Type-check, lint**

```bash
npx tsc --noEmit
npm run lint -- src/main/ipc/handlers/command-handlers.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/handlers/command-handlers.ts
git commit -m "feat(commands): COMMAND_EXECUTE returns COMMAND_DISABLED on applicability fail; records usage on success"
```

---

### Task 8.4: Expose new IPC channels in preload

**Files:**
- Modify: `src/preload/preload.ts`

- [ ] **Step 1: Add channel literals to the renderer-facing API**

Open `src/preload/preload.ts`. Locate the existing whitelist of channels exposed to the renderer (varies by project; search for `COMMAND_LIST` or for the `contextBridge.exposeInMainWorld` block).

For each new channel — `COMMAND_RESOLVE`, `COMMAND_REGISTRY_SNAPSHOT`, `USAGE_GET_SNAPSHOT`, `USAGE_RECORD`, `USAGE_DELTA`, `WORKSPACE_IS_GIT_REPO` — add it to the appropriate allowlist:

```ts
// invoke channels
'command:resolve',
'command:registrySnapshot',
'usage:getSnapshot',
'usage:record',
'workspace:isGitRepo',

// event channels (main → renderer)
'usage:delta',
```

If preload validates channels against `IPC_CHANNELS`, just import the new constants — no manual list to maintain.

- [ ] **Step 2: Type-check and commit**

```bash
npx tsc --noEmit
git add src/preload/preload.ts
git commit -m "feat(preload): expose command:resolve / command:registrySnapshot / usage:* / workspace:isGitRepo channels"
```

---

## Phase 9 — `CommandStore` renderer extension

### Task 9.1: Migrate `CommandStore` to load snapshot + diagnostics

**Files:**
- Modify: `src/renderer/app/core/state/command.store.ts`

- [ ] **Step 1: Add diagnostics signal and snapshot loader**

In `src/renderer/app/core/state/command.store.ts`:

1. Import the new types: `import type { CommandTemplate, CommandDiagnostic, CommandRegistrySnapshot } from '../../../../shared/types/command.types';`
2. Add a new signal beside `_commands`:

```ts
private _diagnostics = signal<CommandDiagnostic[]>([]);
diagnostics = this._diagnostics.asReadonly();
```

3. Replace the body of `loadCommands` so it reads the snapshot:

```ts
async loadCommands(
  workingDirectory: string | null = this.instanceStore.selectedInstance()?.workingDirectory ?? null,
): Promise<void> {
  const normalized = workingDirectory ?? null;
  if (this.lastLoadedWorkingDirectory === normalized && this._commands().length > 0) return;

  const requestId = ++this.loadSequence;
  this._loading.set(true);
  this._error.set(null);

  try {
    const pendingWork: [Promise<IpcResponse>, Promise<unknown>] = [
      this.ipcService.listCommands(normalized ?? undefined),
      this.skillsLoaded ? Promise.resolve() : this.skillStore.discoverSkills(),
    ];
    const [commandResponse] = await Promise.all(pendingWork);

    if (requestId !== this.loadSequence) return;

    if (commandResponse.success && 'data' in commandResponse && commandResponse.data) {
      const snap = commandResponse.data as CommandRegistrySnapshot;
      this._commands.set(snap.commands);
      this._diagnostics.set(snap.diagnostics);
      this.lastLoadedWorkingDirectory = normalized;
      this.skillsLoaded = true;
    } else {
      const errorMsg = 'error' in commandResponse ? commandResponse.error?.message : 'Failed to load commands';
      this._error.set(errorMsg || 'Failed to load commands');
    }
  } catch (err) {
    this._error.set((err as Error).message);
  } finally {
    this._loading.set(false);
  }
}
```

- [ ] **Step 2: Update `CommandIpcService.listCommands` typing if needed**

Search for the existing typing in `src/renderer/app/core/services/ipc/`. If the service narrows the response data to `CommandTemplate[]`, change it to return the response unchanged (or to type as `CommandRegistrySnapshot`). The exact change depends on the project's IPC service shape — keep the change minimal.

- [ ] **Step 3: Verify all type-check passes (including spec files)**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

If a downstream consumer was relying on `commandStore.commands()` returning a particular shape, fix the consumer here (e.g. `command-palette.component.ts` already calls `.commands()` — that will still work because we keep `_commands` of type `CommandTemplate[]`).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/core/state/command.store.ts
# also add IPC service typing changes if you adjusted them
git commit -m "feat(commands): CommandStore consumes registry snapshot (commands + diagnostics)"
```

---

## Phase 10 — `UsageStore` (renderer cache + write-through)

### Task 10.1: Implement `UsageStore` with seed + optimistic update

**Files:**
- Create: `src/renderer/app/core/state/usage.store.ts`
- Create: `src/renderer/app/core/state/__tests__/usage.store.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/core/state/__tests__/usage.store.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UsageStore } from '../usage.store';

const mockInvoke = vi.fn();
vi.stubGlobal('window', {
  electronAPI: {
    invoke: mockInvoke,
    on: vi.fn(),
  },
});

describe('UsageStore', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    TestBed.configureTestingModule({});
  });

  it('starts empty before init', () => {
    const s = TestBed.inject(UsageStore);
    expect(s.snapshot('commands')).toEqual({});
  });

  it('seeds from main on init', async () => {
    mockInvoke.mockResolvedValueOnce({
      success: true,
      data: { byCategory: { commands: { x: { count: 3, lastUsedAt: 1 } } } },
    });
    const s = TestBed.inject(UsageStore);
    await s.init();
    expect(s.snapshot('commands').x.count).toBe(3);
  });

  it('optimistically increments on record and fires IPC (category-aware)', () => {
    const s = TestBed.inject(UsageStore);
    s.record('commands', 'y');
    expect(s.snapshot('commands').y.count).toBe(1);
    expect(mockInvoke).toHaveBeenCalledWith('usage:record', {
      category: 'commands', id: 'y', projectPath: undefined,
    });
  });

  it('records under a non-command category (e.g. sessions for Wave 2)', () => {
    const s = TestBed.inject(UsageStore);
    s.record('sessions', 'sess-1', '/tmp/proj');
    expect(s.snapshot('sessions')['sess-1'].count).toBe(1);
    expect(mockInvoke).toHaveBeenCalledWith('usage:record', {
      category: 'sessions', id: 'sess-1', projectPath: '/tmp/proj',
    });
  });

  it('frecency falls back to 0 for unknown id (any category)', () => {
    const s = TestBed.inject(UsageStore);
    expect(s.frecency('commands', 'unknown')).toBe(0);
    expect(s.frecency('sessions', 'unknown')).toBe(0);
  });

  it('exposes Wave 1 convenience aliases for the commands category', () => {
    const s = TestBed.inject(UsageStore);
    s.recordCommand('z');
    expect(s.frecency('commands', 'z')).toBeGreaterThan(0);
    expect(s.getCommandSnapshot().z.count).toBe(1);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
npx vitest run src/renderer/app/core/state/__tests__/usage.store.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/renderer/app/core/state/usage.store.ts`:

```ts
import { Injectable, signal } from '@angular/core';

export type UsageCategory = string; // 'commands' | 'sessions' | 'resumes' | 'models' | ...

export interface UsageRecord {
  count: number;
  lastUsedAt: number;
  byProject?: Record<string, { count: number; lastUsedAt: number }>;
}

/** Backwards-compatible alias for existing call sites. */
export type CommandUsageRecord = UsageRecord;

interface UsageSnapshotV1 {
  byCategory: Record<UsageCategory, Record<string, UsageRecord>>;
}

interface UsageDelta {
  category: UsageCategory;
  id: string;
  record: UsageRecord;
}

interface ElectronAPI {
  invoke: (channel: string, payload: unknown) => Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
  on?: (channel: string, listener: (payload: unknown) => void) => () => void;
}

const decay = (ageMs: number): number =>
  ageMs <= 86400_000 ? 1.0 :
  ageMs <= 7 * 86400_000 ? 0.6 :
  ageMs <= 30 * 86400_000 ? 0.3 : 0.1;

@Injectable({ providedIn: 'root' })
export class UsageStore {
  // Single signal keyed by category. Wave 2 (`'sessions'`), Wave 3 (`'resumes'`),
  // and any future categories add their own buckets without a schema migration.
  private _byCategory = signal<Record<UsageCategory, Record<string, UsageRecord>>>({ commands: {} });
  readonly byCategory = this._byCategory.asReadonly();
  private initialised = false;

  private get api(): ElectronAPI | undefined {
    return (window as { electronAPI?: ElectronAPI }).electronAPI;
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;
    const api = this.api;
    if (!api) return;
    const res = await api.invoke('usage:getSnapshot', {});
    if (res.success && res.data) {
      const data = res.data as UsageSnapshotV1;
      if (data.byCategory) this._byCategory.set({ ...data.byCategory });
    }
    api.on?.('usage:delta', (payload: unknown) => {
      const d = payload as UsageDelta;
      this._byCategory.update((prev) => {
        const bucket = { ...(prev[d.category] ?? {}) };
        bucket[d.id] = d.record;
        return { ...prev, [d.category]: bucket };
      });
    });
  }

  /** Read the per-category map. Returns an empty object for unknown categories. */
  snapshot(category: UsageCategory): Record<string, UsageRecord> {
    return this._byCategory()[category] ?? {};
  }

  /** Wave 1 convenience for the 'commands' category. */
  getCommandSnapshot(): Record<string, UsageRecord> {
    return this.snapshot('commands');
  }

  /** Optimistic local insert + fire-and-forget IPC. The new `usage:record` IPC contract takes `{ category, id, projectPath? }`. */
  record(category: UsageCategory, id: string, projectPath?: string): void {
    const now = Date.now();
    this._byCategory.update((prev) => {
      const bucket = { ...(prev[category] ?? {}) };
      const existing = bucket[id] ?? { count: 0, lastUsedAt: 0 };
      const next: UsageRecord = {
        count: existing.count + 1,
        lastUsedAt: now,
        byProject: existing.byProject ? { ...existing.byProject } : undefined,
      };
      if (projectPath) {
        const prevP = next.byProject?.[projectPath] ?? { count: 0, lastUsedAt: 0 };
        next.byProject = { ...(next.byProject ?? {}), [projectPath]: { count: prevP.count + 1, lastUsedAt: now } };
      }
      bucket[id] = next;
      return { ...prev, [category]: bucket };
    });
    void this.api?.invoke('usage:record', { category, id, projectPath });
  }

  /** Wave 1 convenience for the 'commands' category. */
  recordCommand(commandId: string, projectPath?: string): void {
    this.record('commands', commandId, projectPath);
  }

  frecency(category: UsageCategory, id: string, projectPath?: string, now: number = Date.now()): number {
    const rec = this._byCategory()[category]?.[id];
    if (!rec) return 0;
    let count = rec.count;
    let lastUsedAt = rec.lastUsedAt;
    if (projectPath && rec.byProject?.[projectPath]) {
      count = rec.byProject[projectPath].count;
      lastUsedAt = rec.byProject[projectPath].lastUsedAt;
    }
    return Math.log2(count + 1) * decay(Math.max(0, now - lastUsedAt));
  }

  /** Wave 1 convenience for the 'commands' category. */
  getCommandFrecency(commandId: string, projectPath?: string, now: number = Date.now()): number {
    return this.frecency('commands', commandId, projectPath, now);
  }
}
```

> Note: the matching main-process IPC handler (Task 5.3) accepts the `{ category, id, projectPath }` envelope. Wave 1's `usage:record` payload Zod schema must include `category: z.string().min(1)` and `id: z.string().min(1)` (rename `commandId` → `id` in the payload — backwards-compat is preserved at the API surface via the `recordCommand` convenience method, but the wire protocol is category-aware from Wave 1 onwards).

> Replace the raw `window.electronAPI` calls with the project's typed IPC service if one exists (search `src/renderer/app/core/services/ipc/electron-ipc.service.ts`).

- [ ] **Step 4: Tests, type-check, commit**

```bash
npx vitest run src/renderer/app/core/state/__tests__/usage.store.spec.ts
npx tsc --noEmit
git add src/renderer/app/core/state/usage.store.ts src/renderer/app/core/state/__tests__/usage.store.spec.ts
git commit -m "feat(usage): add UsageStore with seed + optimistic write-through + delta subscription"
```

---

### Task 10.2: Bootstrap `UsageStore.init()` from `AppComponent`

**Files:**
- Modify: `src/renderer/app/app.component.ts`

- [ ] **Step 1: Inject and init**

In `src/renderer/app/app.component.ts`, in the constructor or `ngOnInit`, add:

```ts
import { UsageStore } from './core/state/usage.store';

// in constructor:
private usageStore = inject(UsageStore);

// in ngOnInit (or constructor body if appropriate):
void this.usageStore.init();
```

- [ ] **Step 2: Type-check and commit**

```bash
npx tsc --noEmit
git add src/renderer/app/app.component.ts
git commit -m "chore(usage): bootstrap UsageStore from AppComponent"
```

---

## Phase 11 — `OverlayShellComponent` and `OverlayController` interface

### Task 11.1: Define the `OverlayController` interface and item types

**Files:**
- Create: `src/renderer/app/shared/overlay-shell/overlay-controller.ts`

- [ ] **Step 1: Add the file**

Create `src/renderer/app/shared/overlay-shell/overlay-controller.ts`:

```ts
import type { Signal } from '@angular/core';

export interface OverlayItem<T = unknown> {
  id: string;
  primary: string;
  secondary?: string;
  rightHint?: string;
  badges?: OverlayBadge[];
  disabled?: boolean;
  disabledReason?: string;
  data: T;
}

export interface OverlayGroup<T = unknown> {
  id: string;
  label: string;
  items: OverlayItem<T>[];
}

export interface OverlayBadge {
  label: string;
  tone?: 'default' | 'info' | 'warning' | 'skill' | 'builtin';
}

export interface FooterHint {
  keys: string[];
  label: string;
}

export interface OverlayControllerError {
  message: string;
  kind: 'disabled' | 'no-instance' | 'execute-failed' | 'unknown';
  reason?: string;
}

export interface OverlayController<T = unknown> {
  readonly id: string;
  readonly modeLabel: string;
  readonly placeholder: string;
  readonly footerHints: Signal<FooterHint[]>;
  readonly groups: Signal<OverlayGroup<T>[]>;
  readonly query: Signal<string>;
  readonly loading: Signal<boolean>;
  readonly emptyMessage?: Signal<string>;
  readonly selectedKey: Signal<string | null>;
  readonly lastError: Signal<OverlayControllerError | null>;

  setQuery(q: string): void;
  setSelectedKey(id: string | null): void;
  clearError(): void;

  run(item: OverlayItem<T>): Promise<boolean> | boolean;

  open?(): void;
  close?(): void;
}
```

- [ ] **Step 2: Type-check and commit**

```bash
npx tsc --noEmit
git add src/renderer/app/shared/overlay-shell/overlay-controller.ts
git commit -m "feat(overlay): define OverlayController interface and item/group/footer types"
```

---

### Task 11.2: Implement `OverlayShellComponent`

**Files:**
- Create: `src/renderer/app/shared/overlay-shell/overlay-shell.component.ts`
- Create: `src/renderer/app/shared/overlay-shell/__tests__/overlay-shell.component.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/shared/overlay-shell/__tests__/overlay-shell.component.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { OverlayShellComponent } from '../overlay-shell.component';
import type { OverlayGroup } from '../overlay-controller';

function makeGroup(): OverlayGroup<{ tag: string }> {
  return {
    id: 'g1', label: 'Group 1',
    items: [
      { id: 'a', primary: '/a', data: { tag: 'a' } },
      { id: 'b', primary: '/b', data: { tag: 'b' }, disabled: true, disabledReason: 'nope' },
      { id: 'c', primary: '/c', data: { tag: 'c' } },
    ],
  };
}

describe('OverlayShellComponent', () => {
  let fixture: ComponentFixture<OverlayShellComponent>;
  let comp: OverlayShellComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OverlayShellComponent] });
    fixture = TestBed.createComponent(OverlayShellComponent);
    comp = fixture.componentInstance;
    fixture.componentRef.setInput('groups', [makeGroup()]);
    fixture.detectChanges();
  });

  it('emits select on Enter for the selected item', async () => {
    const events: string[] = [];
    comp.select.subscribe(item => events.push(item.id));
    fixture.componentRef.setInput('selectedKey', 'a');
    fixture.detectChanges();
    comp.handleKey({ key: 'Enter', preventDefault() {} } as KeyboardEvent);
    expect(events).toEqual(['a']);
  });

  it('skips disabled items on ArrowDown navigation', () => {
    const events: (string | null)[] = [];
    comp.selectedKeyChange.subscribe(k => events.push(k));
    fixture.componentRef.setInput('selectedKey', 'a');
    fixture.detectChanges();
    comp.handleKey({ key: 'ArrowDown', preventDefault() {} } as KeyboardEvent);
    expect(events.at(-1)).toBe('c'); // skipped 'b' (disabled)
  });

  it('emits close on Escape', () => {
    const events: number[] = [];
    comp.close.subscribe(() => events.push(1));
    comp.handleKey({ key: 'Escape', preventDefault() {} } as KeyboardEvent);
    expect(events).toEqual([1]);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
npx vitest run src/renderer/app/shared/overlay-shell/__tests__/overlay-shell.component.spec.ts
```

Expected: FAIL — component not defined.

- [ ] **Step 3: Implement the component**

Create `src/renderer/app/shared/overlay-shell/overlay-shell.component.ts`:

```ts
import { Component, ChangeDetectionStrategy, computed, input, output } from '@angular/core';
import type { OverlayGroup, OverlayItem, FooterHint } from './overlay-controller';

@Component({
  selector: 'app-overlay-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="overlay-shell" role="dialog" aria-modal="true" (keydown)="handleKey($event)">
      <header class="overlay-header">
        @if (modeLabel(); as label) { <span class="overlay-mode">{{ label }}</span> }
        <span class="overlay-icon">/</span>
        <input
          class="overlay-search"
          type="text"
          [placeholder]="placeholder()"
          [value]="query()"
          (input)="onSearch($event)"
        />
        <span class="overlay-esc">Esc</span>
      </header>

      <ng-content select="[bannerSlot]"></ng-content>

      <div class="overlay-list" role="listbox">
        @if (loading()) {
          <div class="overlay-loading">Loading…</div>
        } @else if (flatItems().length === 0) {
          <div class="overlay-empty">{{ emptyMessage() }}</div>
        } @else {
          @for (group of groups(); track group.id) {
            <div class="overlay-group" role="group" [attr.aria-label]="group.label">
              <div class="overlay-group-label">{{ group.label }}</div>
              @for (item of group.items; track item.id) {
                <button
                  type="button"
                  class="overlay-item"
                  role="option"
                  [class.selected]="item.id === selectedKey()"
                  [class.disabled]="item.disabled"
                  [attr.aria-disabled]="item.disabled || null"
                  [attr.aria-describedby]="item.disabled && item.disabledReason ? ('desc-' + item.id) : null"
                  [title]="item.disabled ? (item.disabledReason ?? '') : ''"
                  (mouseenter)="selectedKeyChange.emit(item.id)"
                  (click)="onClick(item)"
                >
                  <span class="primary">{{ item.primary }}</span>
                  @if (item.secondary) { <span class="secondary">{{ item.secondary }}</span> }
                  @if (item.rightHint) { <span class="right-hint">{{ item.rightHint }}</span> }
                  @if (item.badges?.length) {
                    <span class="badges">
                      @for (b of item.badges; track b.label) {
                        <span class="badge" [attr.data-tone]="b.tone || 'default'">{{ b.label }}</span>
                      }
                    </span>
                  }
                  @if (item.disabled && item.disabledReason) {
                    <span class="sr-only" [id]="'desc-' + item.id">{{ item.disabledReason }}</span>
                  }
                </button>
              }
            </div>
          }
        }
      </div>

      <footer class="overlay-footer">
        @for (hint of footerHints(); track hint.label) {
          <span class="hint">
            @for (k of hint.keys; track k) { <kbd>{{ k }}</kbd> }
            <span>{{ hint.label }}</span>
          </span>
        }
      </footer>
    </div>
  `,
  styles: [`
    .overlay-shell { position: fixed; inset: 0; z-index: 9999; display: flex; flex-direction: column;
      background: var(--bg-primary); border-radius: var(--radius-lg); padding: var(--spacing-md); }
    .overlay-header { display: flex; align-items: center; gap: var(--spacing-sm); }
    .overlay-search { flex: 1; background: transparent; border: none; outline: none; color: var(--text-primary); font-size: 16px; }
    .overlay-mode { padding: 2px 8px; border-radius: var(--radius-sm); background: var(--bg-tertiary); font-size: 11px; text-transform: uppercase; }
    .overlay-list { flex: 1; overflow-y: auto; }
    .overlay-group-label { font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 8px; }
    .overlay-item { width: 100%; display: flex; align-items: center; gap: var(--spacing-md); padding: 6px 10px;
      background: transparent; border: none; border-radius: var(--radius-md); cursor: pointer; text-align: left; }
    .overlay-item.selected { background: var(--bg-secondary); outline: 2px solid var(--primary-color); outline-offset: -2px; }
    .overlay-item.disabled { opacity: 0.55; cursor: not-allowed; }
    .primary { font-family: var(--font-mono); color: var(--primary-color); font-weight: 600; }
    .secondary { color: var(--text-secondary); font-size: 13px; flex: 1; }
    .right-hint { color: var(--text-muted); font-size: 12px; font-family: var(--font-mono); }
    .badge { padding: 1px 6px; border-radius: var(--radius-sm); background: var(--bg-tertiary); font-size: 10px; text-transform: uppercase; }
    .badge[data-tone="skill"] { background: linear-gradient(135deg,#6366f1,#8b5cf6); color: white; }
    .badge[data-tone="warning"] { background: var(--warning-color, #f59e0b); color: white; }
    .overlay-footer { display: flex; gap: var(--spacing-lg); padding: 6px 10px; border-top: 1px solid var(--border-color); }
    .hint kbd { padding: 1px 5px; background: var(--bg-tertiary); border-radius: 3px; font-size: 11px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  `],
})
export class OverlayShellComponent<T = unknown> {
  groups = input.required<OverlayGroup<T>[]>();
  query = input<string>('');
  placeholder = input<string>('Search…');
  selectedKey = input<string | null>(null);
  footerHints = input<FooterHint[]>([]);
  loading = input<boolean>(false);
  emptyMessage = input<string>('No results');
  modeLabel = input<string | null>(null);

  queryChange = output<string>();
  selectedKeyChange = output<string | null>();
  select = output<OverlayItem<T>>();
  close = output<void>();

  flatItems = computed<OverlayItem<T>[]>(() => this.groups().flatMap(g => g.items));

  onSearch(e: Event): void {
    this.queryChange.emit((e.target as HTMLInputElement).value);
  }

  onClick(item: OverlayItem<T>): void {
    if (!item.disabled) this.select.emit(item);
  }

  handleKey(e: KeyboardEvent): void {
    const items = this.flatItems();
    if (items.length === 0) return;
    const currentId = this.selectedKey();
    const idx = items.findIndex(i => i.id === currentId);

    if (e.key === 'Escape') {
      e.preventDefault();
      this.close.emit();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[idx];
      if (item) this.select.emit(item);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = nextEnabled(items, idx, +1);
      if (next) this.selectedKeyChange.emit(next.id);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = nextEnabled(items, idx, -1);
      if (next) this.selectedKeyChange.emit(next.id);
      return;
    }
  }
}

function nextEnabled<T>(items: OverlayItem<T>[], from: number, dir: 1 | -1): OverlayItem<T> | undefined {
  if (items.length === 0) return undefined;
  let i = from;
  for (let n = 0; n < items.length; n++) {
    i = (i + dir + items.length) % items.length;
    if (!items[i].disabled) return items[i];
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests, type-check, commit**

```bash
npx vitest run src/renderer/app/shared/overlay-shell/__tests__/overlay-shell.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/shared/overlay-shell/overlay-shell.component.ts src/renderer/app/shared/overlay-shell/__tests__/overlay-shell.component.spec.ts
git commit -m "feat(overlay): add presentational OverlayShellComponent with grouped/disabled-aware keyboard nav"
```

---

## Phase 12 — `CommandPaletteController`

### Task 12.1: Implement `CommandPaletteController`

**Files:**
- Create: `src/renderer/app/features/commands/command-palette.controller.ts`
- Create: `src/renderer/app/features/commands/__tests__/command-palette.controller.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/features/commands/__tests__/command-palette.controller.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { CommandPaletteController } from '../command-palette.controller';
import { CommandStore } from '../../../core/state/command.store';
import { UsageStore } from '../../../core/state/usage.store';
import { InstanceStore } from '../../../core/state/instance.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { ProviderStateService } from '../../../core/services/provider-state.service';
import { GitProbeService } from '../../../core/services/git-probe.service';
import type { CommandTemplate } from '../../../../../shared/types/command.types';

describe('CommandPaletteController', () => {
  let cmds: ReturnType<typeof signal<CommandTemplate[]>>;

  beforeEach(() => {
    cmds = signal<CommandTemplate[]>([
      { id: 'b1', name: 'review', description: 'r', template: '', builtIn: true, source: 'builtin', createdAt: 0, updatedAt: 0, category: 'review' },
      { id: 'b2', name: 'commit', description: 'c', template: '', builtIn: true, source: 'builtin', createdAt: 0, updatedAt: 0, category: 'workflow', applicability: { requiresGitRepo: true } },
    ] as CommandTemplate[]);

    TestBed.configureTestingModule({
      providers: [
        CommandPaletteController,
        { provide: CommandStore, useValue: { commands: () => cmds(), loading: () => false } },
        { provide: UsageStore, useValue: { frecency: () => 0, recordCommand: vi.fn() } },
        { provide: InstanceStore, useValue: { selectedInstance: () => ({ id: 'i1', status: 'idle', workingDirectory: '/x' }) } },
        { provide: SettingsStore, useValue: { featureFlags: () => ({}) } },
        { provide: ProviderStateService, useValue: { selectedProvider: () => 'claude' } },
        { provide: GitProbeService, useValue: { isGitRepo: () => false } },
      ],
    });
  });

  it('groups commands by category', () => {
    const c = TestBed.inject(CommandPaletteController);
    const groups = c.groups();
    const labels = groups.map(g => g.label.toLowerCase());
    expect(labels).toEqual(expect.arrayContaining(['review', 'workflow']));
  });

  it('marks commit disabled when not a git repo', () => {
    const c = TestBed.inject(CommandPaletteController);
    const item = c.groups().flatMap(g => g.items).find(i => i.primary.includes('commit'))!;
    expect(item.disabled).toBe(true);
    expect(item.disabledReason).toContain('git');
  });

  it('filters items by query (substring on name + description)', () => {
    const c = TestBed.inject(CommandPaletteController);
    c.setQuery('rev');
    const items = c.groups().flatMap(g => g.items);
    expect(items.find(i => i.primary.includes('review'))).toBeDefined();
    expect(items.find(i => i.primary.includes('commit'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
npx vitest run src/renderer/app/features/commands/__tests__/command-palette.controller.spec.ts
```

Expected: FAIL — controller not defined.

- [ ] **Step 3: Implement the controller**

Create `src/renderer/app/features/commands/command-palette.controller.ts`:

```ts
import { Injectable, computed, inject, signal } from '@angular/core';
import { CommandStore } from '../../core/state/command.store';
import { UsageStore } from '../../core/state/usage.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { GitProbeService } from '../../core/services/git-probe.service';
import { evaluateApplicability } from '../../../../shared/utils/command-applicability';
import type {
  OverlayController, OverlayGroup, OverlayItem, FooterHint, OverlayControllerError,
} from '../../shared/overlay-shell/overlay-controller';
import type { CommandTemplate, CommandCategory } from '../../../../shared/types/command.types';
import { parseArgsFromQuery } from './command-args.util';

const CATEGORY_ORDER: (CommandCategory | undefined)[] = [
  'review', 'navigation', 'workflow', 'session', 'orchestration',
  'diagnostics', 'memory', 'settings', 'skill', 'custom', undefined,
];

@Injectable({ providedIn: 'root' })
export class CommandPaletteController implements OverlayController<CommandTemplate> {
  private commandStore = inject(CommandStore);
  private usageStore = inject(UsageStore);
  private instanceStore = inject(InstanceStore);
  private settingsStore = inject(SettingsStore);
  private providerState = inject(ProviderStateService);
  private gitProbe = inject(GitProbeService);

  readonly id = 'command-palette';
  readonly modeLabel = 'Commands';
  readonly placeholder = 'Search commands…';

  private _query = signal('');
  private _selectedKey = signal<string | null>(null);
  private _lastError = signal<OverlayControllerError | null>(null);

  readonly query = this._query.asReadonly();
  readonly selectedKey = this._selectedKey.asReadonly();
  readonly lastError = this._lastError.asReadonly();
  readonly loading = computed(() => this.commandStore.loading());

  readonly footerHints = computed<FooterHint[]>(() => [
    { keys: ['↑','↓'], label: 'Navigate' },
    { keys: ['⏎'], label: 'Run' },
    { keys: ['Esc'], label: 'Close' },
  ]);

  private context = computed(() => {
    const inst = this.instanceStore.selectedInstance();
    return {
      provider: this.providerState.selectedProvider(),
      instanceStatus: inst?.status,
      workingDirectory: inst?.workingDirectory ?? null,
      isGitRepo: this.gitProbe.isGitRepo(inst?.workingDirectory ?? null),
      featureFlags: this.settingsStore.featureFlags(),
    };
  });

  readonly groups = computed<OverlayGroup<CommandTemplate>[]>(() => {
    const q = this._query().trim().toLowerCase();
    const ctx = this.context();
    const all = this.commandStore.commands();

    const filtered = q
      ? all.filter(c =>
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          (c.aliases ?? []).some(a => a.toLowerCase().includes(q)),
        )
      : all;

    const items: OverlayItem<CommandTemplate>[] = filtered.map(c => {
      const app = evaluateApplicability(c, ctx);
      const hidden = !app.eligible && c.applicability?.hideWhenIneligible;
      if (hidden) return null;

      const badges = [];
      if (c.builtIn) badges.push({ label: 'Built-in', tone: 'builtin' as const });
      if (c.source === 'file') badges.push({ label: 'File', tone: 'info' as const });
      if (c.category === 'skill') badges.push({ label: 'Skill', tone: 'skill' as const });

      return {
        id: c.id,
        primary: `/${c.name}`,
        secondary: c.description,
        rightHint: c.usage ?? c.shortcut,
        badges,
        disabled: !app.eligible,
        disabledReason: !app.eligible ? app.reason : undefined,
        data: c,
      };
    }).filter((x): x is OverlayItem<CommandTemplate> => x !== null);

    // group by category
    const byCategory = new Map<CommandCategory | undefined, OverlayItem<CommandTemplate>[]>();
    for (const it of items) {
      const cat = it.data.category;
      const arr = byCategory.get(cat) ?? [];
      arr.push(it);
      byCategory.set(cat, arr);
    }

    // sort within group: pinned > frecency > name
    const project = ctx.workingDirectory ?? undefined;
    for (const arr of byCategory.values()) {
      arr.sort((a, b) => {
        const ap = a.data.rankHints?.pinned ? 1 : 0;
        const bp = b.data.rankHints?.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        const af = this.usageStore.frecency(a.data.id, project);
        const bf = this.usageStore.frecency(b.data.id, project);
        if (af !== bf) return bf - af;
        return a.data.name.localeCompare(b.data.name);
      });
    }

    const groups: OverlayGroup<CommandTemplate>[] = [];
    for (const cat of CATEGORY_ORDER) {
      const arr = byCategory.get(cat);
      if (!arr || arr.length === 0) continue;
      groups.push({
        id: cat ?? 'uncategorized',
        label: labelForCategory(cat),
        items: arr,
      });
    }
    return groups;
  });

  setQuery(q: string): void {
    this._query.set(q);
    this._selectedKey.set(null);
  }

  setSelectedKey(id: string | null): void {
    this._selectedKey.set(id);
  }

  clearError(): void {
    this._lastError.set(null);
  }

  async run(item: OverlayItem<CommandTemplate>): Promise<boolean> {
    const cmd = item.data;
    const ctx = this.context();

    const app = evaluateApplicability(cmd, ctx);
    if (!app.eligible) {
      this._lastError.set({ kind: 'disabled', message: app.reason ?? 'Command unavailable', reason: app.reason });
      return false;
    }
    const inst = this.instanceStore.selectedInstance();
    if (!inst) {
      this._lastError.set({ kind: 'no-instance', message: 'No instance selected' });
      return false;
    }
    const args = parseArgsFromQuery(this._query(), cmd.name);
    const result = await this.commandStore.executeCommand(cmd.id, inst.id, args);
    if (result.success) {
      this.usageStore.recordCommand(cmd.id, ctx.workingDirectory ?? undefined);
      this._lastError.set(null);
      return true;
    }
    this._lastError.set({ kind: 'execute-failed', message: result.error ?? 'Command failed' });
    return false;
  }
}

function labelForCategory(c: CommandCategory | undefined): string {
  if (!c) return 'Other';
  return c.charAt(0).toUpperCase() + c.slice(1);
}
```

- [ ] **Step 4: Tests, type-check, commit**

```bash
npx vitest run src/renderer/app/features/commands/__tests__/command-palette.controller.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/commands/command-palette.controller.ts src/renderer/app/features/commands/__tests__/command-palette.controller.spec.ts
git commit -m "feat(commands): add CommandPaletteController (group/rank/applicability/run)"
```

---

## Phase 13 — Palette host refactor

### Task 13.1: Replace `CommandPaletteComponent` body with the shell

**Files:**
- Modify: `src/renderer/app/features/commands/command-palette.component.ts`

- [ ] **Step 1: Replace the template, styles, and class body**

Replace the entire file contents with:

```ts
import { Component, ChangeDetectionStrategy, OnInit, OnDestroy, output, input, inject } from '@angular/core';
import { CommandPaletteController } from './command-palette.controller';
import { OverlayShellComponent } from '../../shared/overlay-shell/overlay-shell.component';
import type { OverlayItem } from '../../shared/overlay-shell/overlay-controller';
import type { CommandTemplate } from '../../../../shared/types/command.types';

@Component({
  selector: 'app-command-palette',
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
      [modeLabel]="controller.modeLabel"
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
  styles: [`
    .overlay-banner { padding: 6px 10px; border-radius: var(--radius-sm); margin: 6px 10px;
      background: var(--warning-color, #f59e0b); color: white; display: flex; justify-content: space-between; align-items: center; }
    .overlay-banner button { background: transparent; border: none; color: inherit; cursor: pointer; }
  `],
})
export class CommandPaletteComponent implements OnInit, OnDestroy {
  controller = inject(CommandPaletteController);
  closeRequested = output<void>();
  commandExecuted = output<{ commandId: string; args: string[] }>();
  instanceId = input<string | null>(null);

  ngOnInit(): void { this.controller.open?.(); }
  ngOnDestroy(): void { this.controller.close?.(); }

  async onSelect(item: OverlayItem<CommandTemplate>): Promise<void> {
    const ok = await this.controller.run(item);
    if (ok) {
      this.commandExecuted.emit({ commandId: item.data.id, args: [] });
      this.closeRequested.emit();
    }
  }
}
```

- [ ] **Step 2: Type-check, lint**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/commands/command-palette.component.ts
```

If `commandExecuted` listeners require non-empty `args`, parse them via `parseArgsFromQuery(controller.query(), item.data.name)` here too.

- [ ] **Step 3: Run dev, manually verify**

```bash
npm run dev
```

In the running app:
1. Press `Cmd/Ctrl+K` to open the palette.
2. Confirm rows are grouped by category (Review, Workflow, …).
3. Confirm `/commit` appears disabled (gray) with a tooltip when the current instance is in a non-git directory; verify by hovering and pressing Enter (banner shows reason).
4. Type `rev` — only review-related commands remain.
5. Press Esc — palette closes.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/features/commands/command-palette.component.ts
git commit -m "refactor(commands): rebuild CommandPaletteComponent on top of OverlayShell + CommandPaletteController"
```

---

## Phase 14 — `/help` browser

### Task 14.1: Add `CommandHelpController`

**Files:**
- Create: `src/renderer/app/features/commands/command-help.controller.ts`

- [ ] **Step 1: Implement (tests deferred — controller is structurally similar to the palette one)**

Create `src/renderer/app/features/commands/command-help.controller.ts`:

```ts
import { Injectable, computed, inject, signal } from '@angular/core';
import { CommandStore } from '../../core/state/command.store';
import type {
  OverlayController, OverlayGroup, OverlayItem, FooterHint, OverlayControllerError,
} from '../../shared/overlay-shell/overlay-controller';
import type { CommandTemplate, CommandCategory } from '../../../../shared/types/command.types';

const CATEGORY_ORDER: (CommandCategory | undefined)[] = [
  'review', 'navigation', 'workflow', 'session', 'orchestration',
  'diagnostics', 'memory', 'settings', 'skill', 'custom', undefined,
];

@Injectable({ providedIn: 'root' })
export class CommandHelpController implements OverlayController<CommandTemplate> {
  private commandStore = inject(CommandStore);

  readonly id = 'command-help';
  readonly modeLabel = 'Help';
  readonly placeholder = 'Browse commands…';

  private _query = signal('');
  private _selectedKey = signal<string | null>(null);
  private _lastError = signal<OverlayControllerError | null>(null);

  readonly query = this._query.asReadonly();
  readonly selectedKey = this._selectedKey.asReadonly();
  readonly lastError = this._lastError.asReadonly();
  readonly loading = computed(() => this.commandStore.loading());

  readonly footerHints = computed<FooterHint[]>(() => [
    { keys: ['↑','↓'], label: 'Navigate' },
    { keys: ['⏎'], label: 'Show details' },
    { keys: ['Esc'], label: 'Close' },
  ]);

  readonly groups = computed<OverlayGroup<CommandTemplate>[]>(() => {
    const q = this._query().trim().toLowerCase();
    const all = this.commandStore.commands();
    const filtered = q
      ? all.filter(c => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      : all;
    const byCat = new Map<CommandCategory | undefined, OverlayItem<CommandTemplate>[]>();
    for (const c of filtered) {
      const item: OverlayItem<CommandTemplate> = {
        id: c.id,
        primary: `/${c.name}`,
        secondary: c.description,
        rightHint: c.usage,
        data: c,
      };
      const arr = byCat.get(c.category) ?? [];
      arr.push(item);
      byCat.set(c.category, arr);
    }
    const groups: OverlayGroup<CommandTemplate>[] = [];
    for (const cat of CATEGORY_ORDER) {
      const arr = byCat.get(cat);
      if (!arr || arr.length === 0) continue;
      arr.sort((a, b) => a.data.name.localeCompare(b.data.name));
      groups.push({ id: cat ?? 'uncategorized', label: labelForCategory(cat), items: arr });
    }
    return groups;
  });

  setQuery(q: string): void { this._query.set(q); this._selectedKey.set(null); }
  setSelectedKey(id: string | null): void { this._selectedKey.set(id); }
  clearError(): void { this._lastError.set(null); }
  run(item: OverlayItem<CommandTemplate>): boolean {
    // Help controller does not execute — selection is handled by the host (detail pane).
    this._selectedKey.set(item.id);
    return false;
  }
}

function labelForCategory(c: CommandCategory | undefined): string {
  if (!c) return 'Other';
  return c.charAt(0).toUpperCase() + c.slice(1);
}
```

- [ ] **Step 2: Type-check and commit**

```bash
npx tsc --noEmit
git add src/renderer/app/features/commands/command-help.controller.ts
git commit -m "feat(commands): add CommandHelpController for /help browser"
```

---

### Task 14.2: Add the help-host component and wire `/help` action

**Files:**
- Create: `src/renderer/app/features/commands/command-help-host.component.ts`
- Modify: `src/shared/types/command.types.ts` (built-in `/help` execution)
- Modify: wherever the renderer dispatches `execution.type === 'ui'` actions (search for `actionId: 'app.open-rlm'` to find the dispatcher).

- [ ] **Step 1: Implement the host**

Create `src/renderer/app/features/commands/command-help-host.component.ts`:

```ts
import { Component, ChangeDetectionStrategy, output, computed, inject } from '@angular/core';
import { CommandHelpController } from './command-help.controller';
import { OverlayShellComponent } from '../../shared/overlay-shell/overlay-shell.component';
import type { OverlayItem } from '../../shared/overlay-shell/overlay-controller';
import type { CommandTemplate } from '../../../../shared/types/command.types';

@Component({
  selector: 'app-command-help-host',
  standalone: true,
  imports: [OverlayShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="help-layout">
      <app-overlay-shell class="help-list"
        [groups]="controller.groups()"
        [query]="controller.query()"
        [placeholder]="controller.placeholder"
        [selectedKey]="controller.selectedKey()"
        [footerHints]="controller.footerHints()"
        [modeLabel]="controller.modeLabel"
        (queryChange)="controller.setQuery($event)"
        (selectedKeyChange)="controller.setSelectedKey($event)"
        (select)="onSelect($event)"
        (close)="closeRequested.emit()"
      ></app-overlay-shell>

      <aside class="help-detail">
        @if (selected(); as cmd) {
          <h2>/{{ cmd.name }}</h2>
          @if (cmd.aliases?.length) { <p><strong>Aliases:</strong> {{ aliasList(cmd) }}</p> }
          <p>{{ cmd.description }}</p>
          @if (cmd.usage) { <pre><code>{{ cmd.usage }}</code></pre> }
          @if (cmd.examples?.length) {
            <h3>Examples</h3>
            <ul>@for (ex of cmd.examples; track ex) { <li><code>{{ ex }}</code></li> }</ul>
          }
          @if (cmd.applicability) {
            <p><em>Available when: {{ summarizeApplicability(cmd) }}</em></p>
          }
          <p class="muted">Source: {{ cmd.source }} <code>{{ cmd.filePath ?? '' }}</code></p>
        } @else {
          <p class="muted">Select a command to see details.</p>
        }
      </aside>
    </div>
  `,
  styles: [`
    .help-layout { display: grid; grid-template-columns: 360px 1fr; gap: var(--spacing-md); height: 70vh; }
    .help-detail { padding: var(--spacing-md); background: var(--bg-secondary); border-radius: var(--radius-md); overflow-y: auto; }
    .muted { color: var(--text-muted); }
    pre { background: var(--bg-tertiary); padding: 8px; border-radius: var(--radius-sm); }
  `],
})
export class CommandHelpHostComponent {
  controller = inject(CommandHelpController);
  closeRequested = output<void>();

  selected = computed(() => {
    const id = this.controller.selectedKey();
    if (!id) return null;
    return this.controller.groups().flatMap(g => g.items).find(i => i.id === id)?.data ?? null;
  });

  onSelect(item: OverlayItem<CommandTemplate>): void {
    this.controller.run(item);
  }

  aliasList(cmd: CommandTemplate): string { return (cmd.aliases ?? []).map(a => `/${a}`).join(', '); }

  summarizeApplicability(cmd: CommandTemplate): string {
    const a = cmd.applicability;
    if (!a) return 'always';
    const parts: string[] = [];
    if (a.provider) parts.push(`provider=${Array.isArray(a.provider) ? a.provider.join('/') : a.provider}`);
    if (a.instanceStatus) parts.push(`status=${Array.isArray(a.instanceStatus) ? a.instanceStatus.join('/') : a.instanceStatus}`);
    if (a.requiresWorkingDirectory) parts.push('working dir');
    if (a.requiresGitRepo) parts.push('git repo');
    if (a.featureFlag) parts.push(`flag:${a.featureFlag}`);
    return parts.join(', ') || 'always';
  }
}
```

- [ ] **Step 2: Change `/help` builtin to a UI execution**

In `src/shared/types/command.types.ts`, find the `/help` entry in `BUILT_IN_COMMANDS` and change its `execution`:

```ts
{
  name: 'help',
  description: 'Show all available commands',
  template: '',
  hint: 'Show available commands',
  execution: { type: 'ui', actionId: 'app.open-command-help' },
  builtIn: true,
  category: 'diagnostics',
  usage: '/help',
},
```

- [ ] **Step 3: Wire the dispatcher**

Search for the existing handler of `actionId: 'app.open-rlm'`:

```bash
grep -rn "app.open-rlm" src/renderer
```

Add a sibling case for `'app.open-command-help'` that mounts `CommandHelpHostComponent` (probably as a CDK overlay or as a top-level dialog component matching the palette). Keep symmetry with the palette mount point.

- [ ] **Step 4: Manual verify**

```bash
npm run dev
```

Type `/help` in the composer and press Enter. The help overlay should open and group commands by category. Esc closes.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/commands/command-help-host.component.ts src/shared/types/command.types.ts
# add the dispatcher file you modified
git commit -m "feat(commands): add /help browser overlay (CommandHelpHostComponent + UI action wiring)"
```

---

## Phase 15 — Slash composer dropdown via controller

### Task 15.1: Create `CommandSuggestionsListComponent`

**Files:**
- Create: `src/renderer/app/features/commands/command-suggestions-list.component.ts`

- [ ] **Step 1: Implement**

Create `src/renderer/app/features/commands/command-suggestions-list.component.ts`:

```ts
import { Component, ChangeDetectionStrategy, computed, input, output } from '@angular/core';
import type { OverlayGroup, OverlayItem } from '../../shared/overlay-shell/overlay-controller';
import type { CommandTemplate } from '../../../../shared/types/command.types';

@Component({
  selector: 'app-command-suggestions-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (groups().length > 0) {
      <div class="suggestions" role="listbox">
        @for (group of groups(); track group.id) {
          <div class="group">
            <div class="group-label">{{ group.label }}</div>
            @for (item of group.items; track item.id) {
              <button type="button"
                class="suggestion"
                role="option"
                [class.selected]="item.id === selectedKey()"
                [class.disabled]="item.disabled"
                [title]="item.disabled ? (item.disabledReason ?? '') : ''"
                (mouseenter)="selectedKeyChange.emit(item.id)"
                (click)="onClick(item)"
              >
                <span class="primary">{{ item.primary }}</span>
                <span class="secondary">{{ item.secondary }}</span>
                @if (item.rightHint) { <span class="right-hint">{{ item.rightHint }}</span> }
              </button>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .suggestions { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 4px; max-height: 320px; overflow-y: auto; }
    .group-label { font-size: 10px; text-transform: uppercase; color: var(--text-muted); padding: 4px 8px; }
    .suggestion { display: flex; gap: var(--spacing-sm); align-items: center; padding: 4px 8px; width: 100%;
      background: transparent; border: none; cursor: pointer; text-align: left; border-radius: var(--radius-sm); }
    .suggestion.selected { background: var(--bg-secondary); }
    .suggestion.disabled { opacity: 0.55; cursor: not-allowed; }
    .primary { font-family: var(--font-mono); color: var(--primary-color); font-weight: 600; }
    .secondary { color: var(--text-secondary); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .right-hint { color: var(--text-muted); font-size: 11px; font-family: var(--font-mono); }
  `],
})
export class CommandSuggestionsListComponent {
  groups = input.required<OverlayGroup<CommandTemplate>[]>();
  selectedKey = input<string | null>(null);
  selectedKeyChange = output<string>();
  select = output<OverlayItem<CommandTemplate>>();

  flat = computed<OverlayItem<CommandTemplate>[]>(() => this.groups().flatMap(g => g.items));

  onClick(item: OverlayItem<CommandTemplate>): void {
    if (!item.disabled) this.select.emit(item);
  }
}
```

- [ ] **Step 2: Type-check and commit**

```bash
npx tsc --noEmit
git add src/renderer/app/features/commands/command-suggestions-list.component.ts
git commit -m "feat(commands): add CommandSuggestionsListComponent for inline composer dropdown"
```

---

### Task 15.2: Switch the composer's slash dropdown to the controller

**Files:**
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.html`

- [ ] **Step 1: Update the component**

In `input-panel.component.ts`:

1. Replace `private commandStore = inject(CommandStore);` (or keep it but) and add:

```ts
import { CommandPaletteController } from '../commands/command-palette.controller';
import { CommandSuggestionsListComponent } from '../commands/command-suggestions-list.component';
// ...
private paletteController = inject(CommandPaletteController);
```

2. Add `CommandSuggestionsListComponent` to the component's `imports` array.

3. Replace the existing `filteredCommands` computed and the `onSelectCommand` flow with:

```ts
// Remove `filteredCommands` — controller owns the result list.

paletteGroups = computed(() => this.paletteController.groups());
paletteSelectedKey = computed(() => this.paletteController.selectedKey());

protected onCommandSelect(item: OverlayItem<CommandTemplate>): void {
  this.commandStore.executeCommand(item.data.id, this.instanceId(), parseArgsFromQuery(this.message(), item.data.name));
  this.executeCommand.emit({ commandId: item.data.id, args: parseArgsFromQuery(this.message(), item.data.name) });
  this.message.set('');
  this.showCommandSuggestions.set(false);
  if (!this.isDraftComposer()) this.clearComposerDraft();
}
```

4. In `onInput`, replace the suggestion-show logic with:

```ts
if (value.startsWith('/') && !value.includes('\n')) {
  this.paletteController.setQuery(value.slice(1));
  this.showCommandSuggestions.set(true);
} else {
  this.paletteController.setQuery('');
  this.showCommandSuggestions.set(false);
}
```

5. In `onKeyDown`, replace the existing arrow / enter / tab / escape handling for the suggestions block to drive the controller:

```ts
if (this.showCommandSuggestions() && this.paletteGroups().length > 0) {
  const flat = this.paletteGroups().flatMap(g => g.items);
  const idx = flat.findIndex(i => i.id === this.paletteController.selectedKey());

  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault();
      const next = nextEnabled(flat, idx, +1);
      if (next) this.paletteController.setSelectedKey(next.id);
      return;
    }
    case 'ArrowUp': {
      event.preventDefault();
      const next = nextEnabled(flat, idx, -1);
      if (next) this.paletteController.setSelectedKey(next.id);
      return;
    }
    case 'Tab':
    case 'Enter': {
      event.preventDefault();
      const item = flat[idx];
      if (item) this.onCommandSelect(item);
      return;
    }
    case 'Escape':
      event.preventDefault();
      this.showCommandSuggestions.set(false);
      return;
  }
}
```

Add the helper at the bottom of the file (or import from a util):

```ts
function nextEnabled<T>(items: { id: string; disabled?: boolean }[], from: number, dir: 1 | -1): { id: string } | undefined {
  if (items.length === 0) return undefined;
  let i = from < 0 ? (dir === 1 ? -1 : 0) : from;
  for (let n = 0; n < items.length; n++) {
    i = (i + dir + items.length) % items.length;
    if (!items[i].disabled) return items[i];
  }
  return undefined;
}
```

- [ ] **Step 2: Update the template**

In `input-panel.component.html`, replace the existing `@if (showCommandSuggestions() && filteredCommands().length > 0)` block with:

```html
@if (showCommandSuggestions() && paletteGroups().length > 0) {
  <app-command-suggestions-list
    [groups]="paletteGroups()"
    [selectedKey]="paletteSelectedKey()"
    (selectedKeyChange)="paletteController.setSelectedKey($event)"
    (select)="onCommandSelect($event)"
  />
}
```

- [ ] **Step 3: Manual verify**

```bash
npm run dev
```

In the composer:
1. Type `/` — categorized list of commands appears.
2. Type `/rev` — only review commands shown.
3. Type `/reveiw` (typo) — fuzzy suggestions header (optional in this iteration; controller currently filters by substring, not fuzzy — see Task 15.3 for the upgrade).
4. Type `/commit` outside a git repo — `commit` row shows disabled.

- [ ] **Step 4: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/instance-detail/input-panel.component.ts
git add src/renderer/app/features/instance-detail/input-panel.component.ts src/renderer/app/features/instance-detail/input-panel.component.html
git commit -m "refactor(composer): drive slash dropdown via CommandPaletteController + suggestions list"
```

---

### Task 15.3: Surface fuzzy/ambiguous resolution headers in the slash dropdown

**Files:**
- Modify: `src/renderer/app/features/commands/command-palette.controller.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`

- [ ] **Step 1: Add a derived signal: when no substring match, request fuzzy resolution from main**

Inside `CommandPaletteController`, add a new optional `fuzzyMode` signal that, when set, provides the `/help`-style suggestions group for unknown queries:

```ts
private _fuzzy = signal<{ kind: 'none' | 'fuzzy' | 'ambiguous'; suggestions: CommandTemplate[]; conflictingAlias?: string } | null>(null);
readonly fuzzy = this._fuzzy.asReadonly();

async resolveFromMain(input: string): Promise<void> {
  const electronAPI = (window as { electronAPI?: { invoke: (c: string, p: unknown) => Promise<{ success: boolean; data?: unknown }> } }).electronAPI;
  if (!electronAPI) { this._fuzzy.set(null); return; }
  const inst = this.instanceStore.selectedInstance();
  const res = await electronAPI.invoke('command:resolve', { input, instanceId: inst?.id });
  if (!res.success || !res.data) { this._fuzzy.set(null); return; }
  const data = res.data as { kind: string; suggestions?: CommandTemplate[]; candidates?: CommandTemplate[]; conflictingAlias?: string };
  if (data.kind === 'fuzzy' && data.suggestions) {
    this._fuzzy.set({ kind: 'fuzzy', suggestions: data.suggestions });
  } else if (data.kind === 'ambiguous' && data.candidates) {
    this._fuzzy.set({ kind: 'ambiguous', suggestions: data.candidates, conflictingAlias: data.conflictingAlias });
  } else {
    this._fuzzy.set(null);
  }
}
```

Update `setQuery` to call `resolveFromMain` (debounced) when the local groups are empty and the query starts non-empty:

```ts
setQuery(q: string): void {
  this._query.set(q);
  this._selectedKey.set(null);
  // when the local filter would yield nothing, ask main for nearest matches
  if (q.length > 0 && this.localCount() === 0) {
    void this.resolveFromMain(`/${q}`);
  } else {
    this._fuzzy.set(null);
  }
}

private localCount = computed(() => this.groups().reduce((n, g) => n + g.items.length, 0));
```

> Pulling `resolveFromMain` into a debounce (e.g. trailing 100 ms) is left as a refinement — current call rate is bounded by user keystrokes and main resolves in low ms.

Then mix the fuzzy result into `groups()`:

```ts
readonly groups = computed<OverlayGroup<CommandTemplate>[]>(() => {
  // … existing local groups computation …

  if (groups.length === 0) {
    const fz = this._fuzzy();
    if (fz?.kind === 'fuzzy' && fz.suggestions.length > 0) {
      return [{
        id: '__fuzzy__',
        label: `Did you mean…`,
        items: fz.suggestions.map(c => ({ id: c.id, primary: `/${c.name}`, secondary: c.description, data: c })),
      }];
    }
    if (fz?.kind === 'ambiguous' && fz.suggestions.length > 0) {
      return [{
        id: '__ambiguous__',
        label: `Ambiguous alias "${fz.conflictingAlias ?? ''}"`,
        items: fz.suggestions.map(c => ({ id: c.id, primary: `/${c.name}`, secondary: c.description, data: c })),
      }];
    }
  }
  return groups;
});
```

- [ ] **Step 2: Manually verify**

```bash
npm run dev
```

1. Type `/reveiw` (typo) — dropdown shows "Did you mean…" with `/review` suggested.
2. Add a deliberately conflicting alias in two markdown commands (or simulate via the test fixture); type the alias — header reads "Ambiguous alias …".

- [ ] **Step 3: Type-check, commit**

```bash
npx tsc --noEmit
git add src/renderer/app/features/commands/command-palette.controller.ts
git commit -m "feat(commands): surface fuzzy/ambiguous suggestions in CommandPaletteController via main resolve"
```

---

## Phase 16 — Final integration, verification, packaged smoke test

### Task 16.1: Full type-check and lint pass

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

Expected: all tests pass. If any pre-existing tests break because they relied on `commandStore.commands()` returning a particular shape, update them; do **not** revert plan changes.

- [ ] **Step 3: Commit any test fixes (if needed)**

```bash
git add -u
git commit -m "test: align existing specs with snapshot-shaped command IPC"
```

---

### Task 16.2: Manual UI verification

Run `npm run dev` and walk through every item below, in order. Capture issues as TODOs in this file (not in the spec).

- [ ] Press `Cmd/Ctrl+K`. Palette opens, rows grouped by category.
- [ ] Type a partial → list filters live.
- [ ] Type a typo (e.g. `reveiw`) → "Did you mean…" group appears.
- [ ] Define a markdown command with `aliases: ["r"]` in `~/.orchestrator/commands/r.md` (or the test fixture path) → `/r` resolves and runs.
- [ ] Define two markdown commands declaring the same alias → palette shows "Ambiguous alias …".
- [ ] Place the cursor in a non-git working directory and try `/commit` → row disabled, tooltip shows "Requires a git repository", banner appears on Enter.
- [ ] Type `/help` and press Enter → categorized help browser opens with detail pane.
- [ ] Run a few commands. Restart the app. Re-open the palette. Recently used commands should now sort to the top of their category.
- [ ] Disable the renderer dev tools while you observe console output: confirm no warnings/errors emitted on first paint.

---

### Task 16.3: Packaged DMG smoke test (alias-sync verification)

- [ ] **Step 1: Build the packaged DMG**

In this repo, `npm run build` only compiles the renderer/main bundles — it does NOT produce a DMG. To produce a real macOS package, run either:

```bash
# Option A — convenience script that rebuilds native modules + builds + packages:
npm run localbuild

# Option B — manual sequence (matches README.md):
npm run build && npm run electron:build -- --mac --config.mac.identity=null
```

Expected: clean build. Pay attention to any `Cannot find module '@contracts/schemas/command'` errors — those mean the alias sync was incomplete.

- [ ] **Step 2: Launch the packaged binary**

Open the produced `.dmg` from `dist/` (or run the packaged Electron app inside `dist/mac/` or `dist/mac-arm64/`). The app should start, the palette and `/help` should work end-to-end.

- [ ] **Step 3: Quick functional check**

In the packaged app:
1. Open palette → categorized list appears.
2. Run a command → succeeds, no console errors.
3. Type `/help` → browser opens.

If startup crashes with `Cannot find module …schemas/command…`, recheck the four-place alias sync (Task 4.2). The packaged Node runtime uses `register-aliases.ts`, which is the one most often forgotten when a new subpath is added.

---

### Task 16.4: Final commit and docs touch-up

- [ ] **Step 1: Update parent plan to mark Wave 1 tasks done**

Edit `docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`. In the Wave 1 task list, replace each `- [ ]` with `- [x]` for the items that are now landed.

- [ ] **Step 2: Self-review the spec for any drift**

Re-read `docs/superpowers/specs/2026-04-28-wave1-command-registry-and-overlay-design.md`. If you discovered any architectural decisions during implementation that diverge from the spec, update the spec to match what shipped.

- [ ] **Step 3: Final commit**

```bash
git add docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md docs/superpowers/specs/2026-04-28-wave1-command-registry-and-overlay-design.md
git commit -m "docs: mark Wave 1 tasks complete in parent plan; spec touch-ups"
```

- [ ] **Step 4: Surface follow-ups**

Open issues / TODOs (or notes for the next wave) for any remaining items found during implementation: especially anything noticed about the notification surface that Wave 4 will replace.

---

## Spec coverage check (self-review)

| Spec section | Implemented in tasks |
|---|---|
| § 1.1 extended `CommandTemplate` | 1.1 |
| § 1.2 `CommandCategory` | 1.1 |
| § 1.3 `CommandApplicability` | 1.1 |
| § 1.4 `CommandRankHints` | 1.1 |
| § 1.5 `CommandResolutionResult` | 1.1, 3.2, 3.3 |
| § 1.6 `CommandContext` & evaluator | 1.2 |
| § 1.7 diagnostic shape | 1.1, 2.4 |
| § 2 markdown frontmatter & backwards-compat | 2.1–2.4 |
| § 3 resolver algorithm | 3.1–3.3 |
| § 3.2 applicability-at-execution | 8.3 |
| § 4 frecency tracker (main + renderer) | 5.1–5.3, 10.1–10.2 |
| § 5.1 OverlayShellComponent | 11.2 |
| § 5.2 OverlayController interface | 11.1 |
| § 5.5 CommandPaletteController | 12.1 |
| § 5.5 CommandHelpController | 14.1 |
| § 5.6 parseArgsFromQuery | 1.3 |
| § 6.1 palette behavior | 13.1 |
| § 6.2 slash dropdown | 15.1–15.3 |
| § 6.3 /help browser | 14.2 |
| § 6.4 disabled visual contract | 11.2 (component CSS) |
| § 6.5 accessibility | 11.2 |
| § 7.1 GitProbeService | 6.1, 6.2 |
| § 7.2 SettingsStore.featureFlags | 7.1 |
| § 7.3 lastError signal contract | 11.1, 12.1, 13.1 |
| § 8 telemetry & logging | spread across handlers; no dedicated task — verify via `npm run dev` console |
| § 9 IPC channels (new + modified) | 5.3, 6.1, 8.1–8.4 |
| § 9.3 schema package extraction | 4.1, 4.2 |
| § 10 renderer integration points | 9.1, 10.1, 13.1, 14.2, 15.1, 15.2 |
| § 11 test plan | tests embedded in each task; full suite run in 16.1 |
| § 12 file-by-file inventory | matches Created/Modified columns across phases |
| § 13 acceptance criteria | 16.1 (1–3), 16.2 (UI), 16.3 (DMG smoke) |

If any cell above ever flips to "missing", add a task in the closest phase before continuing.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-28-wave1-command-registry-and-overlay-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
