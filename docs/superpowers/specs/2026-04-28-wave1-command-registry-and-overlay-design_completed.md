# Wave 1: Command Registry & Overlay Foundation — Design

**Date:** 2026-04-28
**Status:** Proposed
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design.md`](./2026-04-28-cross-repo-usability-upgrades-design.md) (Track A — Command, Palette, Overlay, And Navigation)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`](../plans/2026-04-28-cross-repo-usability-upgrades-plan.md) (Wave 1)
**Implementation plan (to follow):** `docs/superpowers/plans/2026-04-28-wave1-command-registry-and-overlay-plan.md`

## Doc taxonomy in this repo

This spec is one of several artifacts in a multi-wave program. To prevent confusion and doc sprawl:

| Artifact | Folder | Filename pattern | Purpose |
|---|---|---|---|
| **Design / spec** | `docs/superpowers/specs/` | `YYYY-MM-DD-<topic>-design.md` | What we're building, why, how it fits, types & contracts |
| **Plan** | `docs/superpowers/plans/` | `YYYY-MM-DD-<topic>.md` (or `…-plan.md`) | Wave/task breakdown, files to read, exit criteria |
| **Master / roadmap plan** | `docs/superpowers/plans/` | `YYYY-MM-DD-<name>-master-plan.md` | Multi-feature umbrella spanning many specs/plans |
| **Completed**  | either folder | `…_completed.md` suffix | Archived after the work shipped |

This document is a **per-wave child design** of the parent program design. The relationship is:

```
parent design (cross-repo-usability-upgrades-design.md)
  ├── Track A → this wave 1 spec (CHILD)
  ├── Track A → wave 2 spec (TBD)
  ├── Track B → wave 3 spec (TBD)
  ├── Track C → wave 5 spec (TBD)
  └── Track D → waves 4 & 6 specs (TBD)

parent plan (cross-repo-usability-upgrades-plan.md)
  └── Wave 1 task list  ←── implemented by this child spec
```

The parent design and plan remain authoritative for cross-track coupling, deferred ideas, and risks; this child design is authoritative for **everything required to implement Wave 1 end to end**.

---

## Goal

Give commands enough structured metadata to power richer discovery, actionable errors, and a reusable overlay shell that downstream waves can build on. Wave 1 ships:

1. Extended `CommandTemplate` metadata model (`aliases`, `category`, `usage`, `examples`, `applicability`, `disabledReason`, `rankHints`).
2. Markdown command frontmatter parsing for the new fields, with backwards-compatible defaults.
3. Structured `CommandResolutionResult` (`exact` | `alias` | `fuzzy` | `ambiguous` | `none`) returned by `CommandManager` and the IPC layer.
4. Actionable IPC errors with candidate suggestions instead of `COMMAND_NOT_FOUND`.
5. Alias / name collision diagnostics across builtin / store / markdown sources.
6. Reusable presentational overlay shell + per-mode controller services.
7. Command palette refactored onto the shell (no behavior regressions).
8. Slash composer dropdown upgrade: nearest matches, aliases, categories, usage, disabled reasons.
9. `/help` replaced with a categorized command browser built on the shell.
10. Hybrid frecency / usage tracker — main-process source of truth (`UsageTracker` + IPC), renderer keeps a write-through cache.

## Decisions locked from brainstorming

| # | Decision | Rationale |
|---|---|---|
| 1 | Full Wave 1 scope (all 10 plan tasks land here) | Wave 2 is blocked on the overlay shell; deferring applicability/frecency would split the metadata story across two PRs. |
| 2 | Overlay shell = **presentational component + per-mode controller services** | Matches the existing `*Store + presentational component` pattern (`CommandStore`, `SkillStore`, `InstanceStore`). Wave 2 adds new controllers without touching the shell. |
| 3 | Frecency = **hybrid: main is source of truth; renderer caches and writes through** | Will be shared by command, session, and resume pickers. Main owns persistence; renderer reads from a seeded cache so ranking is sync. |
| 4 | Skill commands participate in the metadata model with `category: 'skill'` | They already merge into `CommandStore` as `ExtendedCommand`; unifying the type avoids two parallel ranking paths. |
| 5 | Disabled (ineligible) commands appear grayed out by default; `applicability.hideWhenIneligible` is opt-in for sensitive surfaces | Discoverability beats hiding for most cases. Sensitive cases can opt in to hide. |
| 6 | Aliases share a **case-insensitive namespace with primary names** | Matches user expectation in CLIs; simpler resolver. |
| 7 | Fuzzy threshold = **Damerau-Levenshtein ≤ 2**, top **5 suggestions**, tie-broken by exact-prefix then frecency | Standard for short slash names; produces useful "did you mean?" output. |
| 8 | Diagnostics are **emitted in Wave 1 but not surfaced in UI until Wave 6** (Doctor) | The data shape ships now; the Doctor view is its own wave. |
| 9 | Command schemas extracted to a **new `@contracts/schemas/command`** subpath | Surface is large enough that bloating `instance.schemas.ts` would obscure both. Requires the 4-place alias sync (see § 11.3). |

## Validation method

The decisions and types in this spec were grounded by reading these files in full prior to drafting:

- Parent docs: `docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design.md`, `docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`
- Types: `src/shared/types/command.types.ts`, `src/shared/types/ipc.types.ts`, `src/shared/utils/markdown-frontmatter.ts`
- Main: `src/main/commands/command-manager.ts`, `src/main/commands/markdown-command-registry.ts`, `src/main/commands/__tests__/command-manager.spec.ts`, `src/main/ipc/handlers/command-handlers.ts`, `src/main/register-aliases.ts`
- Renderer: `src/renderer/app/core/state/command.store.ts`, `src/renderer/app/features/commands/command-palette.component.ts`, `src/renderer/app/features/instance-detail/input-panel.component.ts`, `src/renderer/app/features/instance-detail/input-panel.component.html`
- Schemas: `packages/contracts/src/schemas/instance.schemas.ts` (lines 161–196 — current command schemas), and the broader `packages/contracts/src/schemas/*.schemas.ts` directory layout

---

## 1. Type model

All new shared types live in `src/shared/types/command.types.ts` (existing file extended). Existing fields are unchanged and unprefixed; all new fields are optional.

### 1.1 Extended `CommandTemplate`

```ts
export interface CommandTemplate {
  // ── existing fields (unchanged) ──
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

  // ── new fields (Wave 1) ──

  /** Short alternative names (e.g. "r" for "review"). Resolved case-insensitively.
   *  Aliases share a namespace with primary names; collisions are recorded as
   *  diagnostics and the colliding aliases are dropped from the resolution path. */
  aliases?: string[];

  /** Closed taxonomy used for grouping in palette, /help, slash dropdown. */
  category?: CommandCategory;

  /** Canonical syntax string, e.g. "/review [focus-area...]". */
  usage?: string;

  /** 1–3 concrete invocations rendered in /help and as ghost-text examples. */
  examples?: string[];

  /** Declarative gating; evaluated by evaluateApplicability(cmd, ctx). */
  applicability?: CommandApplicability;

  /** Pre-baked reason shown when applicability evaluates to ineligible.
   *  When absent, the evaluator generates one from the failed predicate. */
  disabledReason?: string;

  /** Ranking boosts. Combined with frecency, exact/alias-match, and category match
   *  in the renderer scorer. Never used for filtering, only for sort order. */
  rankHints?: CommandRankHints;
}
```

### 1.2 `CommandCategory` (closed union)

```ts
export type CommandCategory =
  | 'review'
  | 'navigation'
  | 'workflow'
  | 'session'
  | 'orchestration'
  | 'diagnostics'
  | 'memory'
  | 'settings'
  | 'skill'    // skill-as-command bridge
  | 'custom';  // default for user-authored markdown without explicit category

export const COMMAND_CATEGORIES: readonly CommandCategory[] = [
  'review', 'navigation', 'workflow', 'session', 'orchestration',
  'diagnostics', 'memory', 'settings', 'skill', 'custom',
] as const;
```

### 1.3 `CommandApplicability`

```ts
export interface CommandApplicability {
  /** Restrict to a specific provider or providers. */
  provider?: InstanceProvider | InstanceProvider[];

  /** Restrict to specific instance lifecycle states (e.g. only when 'idle'). */
  instanceStatus?: InstanceStatus | InstanceStatus[];

  /** Require the active instance to have a workingDirectory set. */
  requiresWorkingDirectory?: boolean;

  /** Require the working directory to be inside a git repository.
   *  Renderer caches this per-CWD via a small probe; not on every keystroke. */
  requiresGitRepo?: boolean;

  /** Require a settings flag to be true (looked up via SettingsStore). */
  featureFlag?: string;

  /** If true, the command is hidden when ineligible. Default false → show as disabled. */
  hideWhenIneligible?: boolean;
}
```

### 1.4 `CommandRankHints`

```ts
export interface CommandRankHints {
  /** Pinned commands appear above frecency boosts within their category. */
  pinned?: boolean;

  /** Boost when one of these providers is currently selected. */
  providerAffinity?: InstanceProvider[];

  /** Numeric multiplier applied on top of frecency (default 1.0, clamped 0–3). */
  weight?: number;
}
```

### 1.5 `CommandResolutionResult` (discriminated union)

```ts
export type CommandResolutionResult =
  | { kind: 'exact';     command: CommandTemplate; args: string[]; matchedBy: 'name' }
  | { kind: 'alias';     command: CommandTemplate; args: string[]; matchedBy: 'alias'; alias: string }
  | { kind: 'ambiguous'; query: string; candidates: CommandTemplate[]; conflictingAlias?: string }
  | { kind: 'fuzzy';     query: string; suggestions: CommandTemplate[] }   // ≥1 close matches, no exact/alias hit
  | { kind: 'none';      query: string };                                  // no exact, no alias, no close fuzzy
```

### 1.6 `CommandContext` and applicability evaluator

Pure synchronous function in **new file** `src/shared/utils/command-applicability.ts`. No IPC, no async; both main and renderer call it directly.

```ts
export interface CommandContext {
  provider?: InstanceProvider;
  instanceStatus?: InstanceStatus;
  workingDirectory?: string | null;
  isGitRepo?: boolean;            // pre-computed by caller
  /** Map of boolean settings keys → values. Renderer feeds this via a small
   *  computed signal on SettingsStore (see § 7.2) that proxies AppSettings'
   *  boolean fields; main feeds it from the persisted settings store. */
  featureFlags?: Record<string, boolean>;
}

export interface ApplicabilityResult {
  eligible: boolean;
  reason?: string;
  failedPredicate?:
    | 'provider' | 'instanceStatus' | 'workingDirectory' | 'gitRepo' | 'featureFlag';
}

export function evaluateApplicability(
  cmd: Pick<CommandTemplate, 'applicability' | 'disabledReason'>,
  ctx: CommandContext,
): ApplicabilityResult;
```

Rules:
- `applicability` undefined → `{ eligible: true }`.
- Multiple predicates → all must pass (logical AND).
- On failure: `cmd.disabledReason` (if set) overrides the auto-generated reason.
- Auto-generated reason templates (default):
  - `provider`: `"Only available with {expected} (current: {actual})"`
  - `instanceStatus`: `"Only available while {expected} (current: {actual})"`
  - `workingDirectory`: `"Requires a working directory"`
  - `gitRepo`: `"Requires a git repository"`
  - `featureFlag`: `"Requires the {flagName} setting"`

### 1.7 Diagnostic shape

```ts
export type CommandDiagnosticCode =
  | 'alias-collision'              // alias resolves to multiple commands across sources
  | 'alias-shadowed-by-name'       // alias has same string as a primary command name
  | 'name-collision'               // two commands share a primary name across sources
  | 'invalid-frontmatter-type'     // known field has wrong type in markdown frontmatter
  | 'unknown-category'             // category not in COMMAND_CATEGORIES
  | 'unknown-applicability-key'    // unknown key inside applicability block
  | 'invalid-rank-hints';          // rankHints malformed

export interface CommandDiagnostic {
  code: CommandDiagnosticCode;
  message: string;
  commandId?: string;
  alias?: string;
  filePath?: string;
  candidates?: string[];   // command names involved
  severity: 'warn' | 'error';
}

export interface CommandRegistrySnapshot {
  commands: CommandTemplate[];
  diagnostics: CommandDiagnostic[];
  scanDirs: string[];
}
```

`CommandManager.getAllCommandsSnapshot(workingDirectory?)` returns the full snapshot. The legacy `getAllCommands` becomes a thin wrapper that returns just the array (for backwards compat with any consumer that hasn't been migrated yet).

---

## 2. Markdown frontmatter — new fields & backwards compatibility

`src/main/commands/markdown-command-registry.ts` extends `CommandFrontmatter`:

```ts
type CommandFrontmatter = {
  // ── existing ──
  name?: string;
  description?: string;
  'argument-hint'?: string;
  argumentHint?: string;
  hint?: string;
  model?: string;
  agent?: string;
  subtask?: boolean;

  // ── new ──
  aliases?: string | string[];           // string is split on comma
  category?: string;                     // validated against COMMAND_CATEGORIES
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

### 2.1 Backwards-compatibility rules

- **Missing fields**: behave as today. No errors.
- **Unknown `category`**: default to `'custom'`, emit `unknown-category` diagnostic (severity `warn`).
- **Unknown `applicability` keys**: ignored, emit `unknown-applicability-key` (warn).
- **Type mismatches** (e.g. `aliases: 5`): field dropped, emit `invalid-frontmatter-type` (warn).
- **Alias collides with a primary command name**: alias dropped, emit `alias-shadowed-by-name` (warn).
- **Two commands share a primary name across sources**: lower-priority one wins (existing precedence), emit `name-collision` (warn).
- **Two commands share an alias across sources**: alias dropped from both, emit `alias-collision` (warn) listing all candidates.
- **Coerced types**: `aliases: "r,re"` → `["r", "re"]`. `examples: "..."` → `["..."]`. `provider: "claude"` → `["claude"]`.

### 2.2 Persistence

Diagnostics are stored on the in-memory `CacheEntry` for the working directory, alongside the existing `commandsByName` and `candidatesByName` maps. They are recomputed whenever the cache is invalidated. They are **not** persisted to `electron-store`.

---

## 3. Resolver algorithm

`CommandManager.resolveCommand(input: string, ctx: CommandContext, workingDirectory?: string): Promise<CommandResolutionResult>` is the new authoritative resolver. The legacy `executeCommandString` becomes a thin wrapper that calls this and unpacks the result for callers still using the simpler return shape.

### 3.1 Steps

1. Parse `input` with `parseCommandString` (existing). If not a slash command → `{ kind: 'none', query: input }`.
2. Build the visible command set via `getAllCommandsSnapshot(workingDirectory)` (builtin → store → markdown precedence; existing logic).
3. **Exact name match** (case-insensitive on `name`) → `{ kind: 'exact', ... }`.
4. **Alias index lookup**:
   - Build `aliasIndex: Map<string, CommandTemplate[]>` once per resolve. Aliases lose to primary names: any alias whose lowercase form matches a primary name is dropped (and recorded in diagnostics). Aliases with multiple owners are recorded as `alias-collision` and dropped from the index.
   - Lookup the parsed name (lowercased) in the index:
     - 1 entry → `{ kind: 'alias', ..., alias: <key> }`.
     - 2+ entries (defensive — should not happen post-collision filter) → `{ kind: 'ambiguous', ..., conflictingAlias: <key>, candidates: [...] }`.
5. **Fuzzy match** (Damerau-Levenshtein, threshold ≤ 2) against names + aliases:
   - Score each candidate: distance ascending, then exact-prefix bonus, then frecency.
   - Return up to 5 → `{ kind: 'fuzzy', suggestions: [...] }`.
6. Else → `{ kind: 'none', query: <name> }`.

### 3.2 Applicability is enforced at execution, not resolution

Resolver returns the command even if disabled. The IPC handler (`COMMAND_EXECUTE`) and the renderer controllers check `evaluateApplicability` before executing:

- **Renderer** (`CommandPaletteController.run`): if disabled, show the disabled reason as a toast and do not emit `commandExecuted`.
- **Main** (`COMMAND_EXECUTE`): if disabled, return a `COMMAND_DISABLED` error with `code`, `message`, `failedPredicate`. The renderer surfaces this as a toast.

### 3.3 Performance

- Markdown registry already caches per-working-directory with TTL 10 s + per-directory mtime check. Resolver does not bypass that cache.
- Fuzzy matching is O(n × m) over the visible set per resolve, where m is small (avg name length ≈ 8). Visible set is in the hundreds at most. Acceptable for keystroke-rate use; if profiling shows hotspot, memoize the normalized name list per snapshot.

---

## 4. Frecency / usage tracker

Hybrid: main is the source of truth, renderer keeps a write-through cache for sync ranking.

### 4.1 Main — `UsageTracker`

**New file:** `src/main/observability/usage-tracker.ts` (singleton — `getUsageTracker()`, `_resetForTesting()` per the project pattern).

Persistence: `electron-store` with name `usage-tracker`, schema versioned to allow Wave 2 (sessions) and Wave 3 (resume) to extend without migration pain.

```ts
// stored shape
interface UsageStoreV1 {
  schemaVersion: 1;
  commands: Record<string, CommandUsageRecord>;     // keyed by commandId
  // future: sessions?: Record<...>, resumes?: Record<...>
}

export interface CommandUsageRecord {
  count: number;          // monotonic
  lastUsedAt: number;     // ms epoch
  byProject?: Record<string, { count: number; lastUsedAt: number }>; // optional per-project overlay
}
```

API:

```ts
class UsageTracker {
  getCommandSnapshot(): Record<string, CommandUsageRecord>;
  recordCommand(commandId: string, projectPath?: string): void;
  getCommandFrecency(commandId: string, projectPath?: string, now?: number): number; // see scoring below
  resetCommand(commandId: string): void;
  // event emitter for renderer subscriptions
  onChange(listener: (delta: { commandId: string; record: CommandUsageRecord }) => void): () => void;
}
```

Frecency scoring (initial; tunable):

```
score(record, now)
  = log2(count + 1) * decay(now - lastUsedAt)

decay(ageMs)
  if age <= 1 day:   1.0
  if age <= 7 days:  0.6
  if age <= 30 days: 0.3
  else:              0.1
```

Per-project records, when present, override global ones for ranking inside that project; otherwise fall back to global.

### 4.2 Renderer — `UsageStore`

**New file:** `src/renderer/app/core/state/usage.store.ts` (`@Injectable({ providedIn: 'root' })`).

```ts
@Injectable({ providedIn: 'root' })
export class UsageStore {
  private _records = signal<Record<string, CommandUsageRecord>>({});
  records = this._records.asReadonly();

  // signal-derived getter for sync use in controllers
  frecency = (commandId: string, projectPath?: string): number => { /* computed from cache */ };

  async init(): Promise<void> { /* IPC: USAGE_GET_SNAPSHOT, then subscribe */ }
  recordCommand(commandId: string, projectPath?: string): void {
    // optimistic local update + fire-and-forget IPC: USAGE_RECORD
  }
}
```

Initialization:
- Called once from `AppComponent.ngOnInit` (or wherever similar bootstrap stores are seeded).
- Subscribes to delta events via existing IPC event-bridge pattern (channel `USAGE_DELTA`).
- Optimistic updates: renderer increments locally, then sends; if main rejects, restore.

### 4.3 IPC channels

- `USAGE_GET_SNAPSHOT` → `Record<string, CommandUsageRecord>`
- `USAGE_RECORD` (payload: `{ commandId: string; projectPath?: string }`) → `{ ok: true } | error`
- `USAGE_DELTA` (event, push from main) → `{ commandId: string; record: CommandUsageRecord }`

### 4.4 Integration with the resolver and ranking

- Renderer **controllers** call `UsageStore.frecency(commandId, projectPath)` synchronously during ranking. No IPC per keystroke.
- Main **resolver** uses `UsageTracker.getCommandFrecency` to break ties in fuzzy match suggestion order. This avoids the renderer needing to re-rank fuzzy results from main.
- On successful `commandExecuted` the renderer calls `UsageStore.recordCommand`. Main calls `UsageTracker.recordCommand` from `COMMAND_EXECUTE` handler too (idempotency: optimistic renderer call is fine since main will record on success regardless; double-counting is mitigated by main being the source of truth — renderer calls are advisory only and dropped if duplicate within ≤ 1 s).

### 4.5 Eviction

Out of scope for Wave 1. Command set is small (low hundreds). Add LRU only if profiling shows the store growing unbounded due to ephemeral markdown commands.

---

## 5. Overlay shell architecture

### 5.1 Shape

**New file:** `src/renderer/app/shared/overlay-shell/overlay-shell.component.ts` — presentational, standalone, `OnPush`. **No state of its own beyond UI ephemera** (focus, scroll position).

```ts
// public API surface

export interface OverlayItem<T = unknown> {
  id: string;
  primary: string;          // main label (rendered with an optional leading slash for commands)
  secondary?: string;       // description
  rightHint?: string;       // small text on the right (usage, alias, shortcut)
  badges?: OverlayBadge[];  // category, builtin, skill, disabled
  disabled?: boolean;
  disabledReason?: string;
  data: T;                  // passthrough for select handler
}

export interface OverlayGroup<T = unknown> {
  id: string;
  label: string;            // heading rendered above this group (e.g. "Review", "Navigation")
  items: OverlayItem<T>[];
}

export interface OverlayBadge {
  label: string;
  tone?: 'default' | 'info' | 'warning' | 'skill' | 'builtin';
}

export interface FooterHint {
  keys: string[];   // e.g. ["⏎"]
  label: string;    // e.g. "Select"
}

@Component({ selector: 'app-overlay-shell', standalone: true, ... })
export class OverlayShellComponent {
  // inputs
  groups = input.required<OverlayGroup[]>();
  query = input<string>('');
  placeholder = input<string>('Search...');
  selectedKey = input<string | null>(null); // selected item id; component does not own selection state
  footerHints = input<FooterHint[]>([]);
  loading = input<boolean>(false);
  emptyMessage = input<string>('No results');
  modeLabel = input<string | null>(null);   // for the chip in the header (e.g. "Commands", "Help")

  // outputs
  queryChange = output<string>();
  selectedKeyChange = output<string | null>();
  select = output<OverlayItem>();
  close = output<void>();
}
```

The shell renders:
- A header with the mode chip, an icon (`/` for commands, `?` for help, etc.), the search input, and an `Esc` shortcut label.
- The grouped result list with sticky group headings, item rows showing primary/secondary/right-hint/badges, disabled state styled with reduced opacity + tooltip from `disabledReason`.
- A footer that renders `footerHints` (keyboard cheatsheet).
- Keyboard handling: ↑/↓ navigate (skipping disabled items by default — configurable via input later), Enter emits `select`, Esc emits `close`. Mouse hover updates `selectedKey`.

### 5.2 Controller pattern

**New base interface:** `src/renderer/app/shared/overlay-shell/overlay-controller.ts`

```ts
export interface OverlayController<T = unknown> {
  /** Stable id for telemetry / debugging. */
  readonly id: string;

  /** Mode label rendered in the shell chip. */
  readonly modeLabel: string;

  /** Placeholder text for the shell input. */
  readonly placeholder: string;

  /** Footer hint cheatsheet. */
  readonly footerHints: Signal<FooterHint[]>;

  /** Grouped, ranked, ready-to-render items. */
  readonly groups: Signal<OverlayGroup<T>[]>;

  /** Current query (read-only signal; mutate via setQuery). */
  readonly query: Signal<string>;

  /** Loading state (e.g. while command snapshot loads). */
  readonly loading: Signal<boolean>;

  /** Optional empty-state message override. */
  readonly emptyMessage?: Signal<string>;

  /** Caller-driven query updates. */
  setQuery(q: string): void;

  /** Caller-driven selection updates. */
  setSelectedKey(id: string | null): void;
  readonly selectedKey: Signal<string | null>;

  /** Last user-facing error from a run() attempt; null when no error pending.
   *  Hosts render this; the shell exposes a `[bannerSlot]` projection slot. */
  readonly lastError: Signal<OverlayControllerError | null>;
  clearError(): void;

  /** Activation: selects the item. Returns true if the action was performed
   *  (so the host knows whether to close). */
  run(item: OverlayItem<T>): Promise<boolean> | boolean;

  /** Lifecycle hooks; safe no-ops by default. */
  open?(): void;
  close?(): void;
}
```

The shell does not know about controllers; a thin **host component** binds the shell's inputs/outputs to a controller's signals/methods.

### 5.3 Hosts

Wave 1 ships two hosts:

- `CommandPaletteHostComponent` (replaces `CommandPaletteComponent` body) — opens on `Cmd/Ctrl+K`, drives a `CommandPaletteController`.
- `CommandHelpHostComponent` (new — `/help` invocation opens this) — drives a `CommandHelpController` (similar to palette but with usage/examples expansion in the right pane).

A host's responsibility:
1. Inject the appropriate controller.
2. Render `<app-overlay-shell>` with controller-bound signals.
3. Translate shell's `(close)` into routing/dialog dismissal.
4. Translate shell's `(select)` → `controller.run(item)` and only close when `run` returns true.

### 5.4 Slash composer dropdown

The composer dropdown in `input-panel.component.html` is **inline, not an overlay**. It will not use the `<app-overlay-shell>` component, but will share the same `CommandPaletteController` for filtering, ranking, and applicability evaluation:

- A new presentational component `<app-command-suggestions-list>` renders `OverlayGroup<CommandTemplate>[]` exactly the way the shell does, but as a small inline dropdown (no overlay scrim, fixed height, narrower).
- `InputPanelComponent` injects `CommandPaletteController`, calls `controller.setQuery(value.slice(1))` on input, binds `controller.groups()` to the suggestions list.
- On Enter / Tab, calls `controller.run(currentSelectedItem)` and falls back to "send as message" only when the resolution result is `none` AND the user explicitly confirmed (existing behavior preserved).
- When result is `fuzzy`, the dropdown shows a "Did you mean…" header above the suggestions group.
- When result is `ambiguous`, the dropdown shows an "Ambiguous alias" warning with the conflicting alias and lists all candidates as a single group.

### 5.5 Controllers shipped in Wave 1

#### `CommandPaletteController`

**New file:** `src/renderer/app/features/commands/command-palette.controller.ts`

```ts
@Injectable({ providedIn: 'root' })
export class CommandPaletteController implements OverlayController<CommandTemplate> {
  private commandStore = inject(CommandStore);
  private usageStore = inject(UsageStore);
  private instanceStore = inject(InstanceStore);
  private settingsStore = inject(SettingsStore);
  private providerState = inject(ProviderStateService);
  private gitProbeService = inject(GitProbeService); // new — see § 7

  readonly id = 'command-palette';
  readonly modeLabel = 'Commands';
  readonly placeholder = 'Search commands…';

  private _query = signal('');
  private _selectedKey = signal<string | null>(null);
  readonly selectedKey = this._selectedKey.asReadonly();

  readonly footerHints = computed<FooterHint[]>(() => [
    { keys: ['↑','↓'], label: 'Navigate' },
    { keys: ['⏎'], label: 'Run' },
    { keys: ['Esc'], label: 'Close' },
  ]);

  readonly loading = computed(() => this.commandStore.loading());

  /** Context for applicability evaluation. Recomputes when underlying signals change. */
  private context = computed<CommandContext>(() => ({
    provider: this.providerState.selectedProvider(),
    instanceStatus: this.instanceStore.selectedInstance()?.status,
    workingDirectory: this.instanceStore.selectedInstance()?.workingDirectory ?? null,
    isGitRepo: this.gitProbeService.isGitRepo(this.instanceStore.selectedInstance()?.workingDirectory ?? null),
    featureFlags: this.settingsStore.featureFlags(),
  }));

  /** Score and rank a single command. Tie-break: alias > exact-prefix > frecency > category-affinity > pinned. */
  private score(cmd: CommandTemplate, q: string): { include: boolean; rank: number };

  readonly groups = computed<OverlayGroup<CommandTemplate>[]>(() => {
    /* filter, score, group by category, sort within groups, push pinned to top */
  });

  setQuery(q: string): void { this._query.set(q); this._selectedKey.set(null); }
  setSelectedKey(id: string | null): void { this._selectedKey.set(id); }

  async run(item: OverlayItem<CommandTemplate>): Promise<boolean> {
    const cmd = item.data;
    const applicability = evaluateApplicability(cmd, this.context());
    if (!applicability.eligible) {
      this.setError({ kind: 'disabled', message: applicability.reason ?? 'Command unavailable', reason: applicability.reason });
      return false;
    }
    const instanceId = this.instanceStore.selectedInstance()?.id;
    if (!instanceId) {
      this.setError({ kind: 'no-instance', message: 'No instance selected' });
      return false;
    }

    const args = parseArgsFromQuery(this._query(), cmd.name); // see § 5.6
    const result = await this.commandStore.executeCommand(cmd.id, instanceId, args);
    if (result.success) {
      this.usageStore.recordCommand(cmd.id, this.context().workingDirectory ?? undefined);
      return true;
    }
    this.setError({ kind: 'execute-failed', message: result.error ?? 'Command failed' });
    return false;
  }
}
```

### 5.6 Args parsing helper

The current `command-palette.component.ts` (lines ~393–406) inlines a small "parse args from search query after the command name" helper. Extract it to a shared util so both `CommandPaletteController` and `CommandSuggestionsList` consume the same logic.

**New file:** `src/renderer/app/features/commands/command-args.util.ts`

```ts
/**
 * Parse arg tokens from a search/composer query, given the resolved command name.
 * Examples:
 *   parseArgsFromQuery("review focus errors", "review") → ["focus","errors"]
 *   parseArgsFromQuery("/review focus errors", "review") → ["focus","errors"]
 *   parseArgsFromQuery("rev", "review") → []
 */
export function parseArgsFromQuery(query: string, commandName: string): string[];
```

Behavior matches today's inline logic; tests pin the existing examples.

#### `CommandHelpController`

Same shape as `CommandPaletteController`, but:
- `modeLabel = 'Help'`
- `placeholder = 'Browse commands…'`
- `groups` always groups by category (ignores the type-ahead reranking that the palette does — Help is a browser, not a launcher).
- `run(item)` opens an inline detail view rather than executing. Detail view shows:
  - Full description
  - Usage line
  - Examples list
  - Applicability summary if disabled in current context
  - Source (builtin / store / markdown file path)
  - Aliases

The `/help` builtin command's `execution` becomes `{ type: 'ui', actionId: 'app.open-command-help' }` (matches the existing `rlm` pattern). The renderer wires that action to open the help host.

---

## 6. UI surfaces — detailed behavior

### 6.1 Command palette (`Cmd/Ctrl+K`)

- Opens `CommandPaletteHostComponent` — replaces the `CommandPaletteComponent` body. Shell rendering replaces all the bespoke palette HTML/CSS in the existing component.
- Groups by category, with the active category's group expanded. Default group order: pinned commands first (synthetic group), then the user's most-used category, then alphabetical.
- Each row shows: primary `/{name}`, secondary description, right-hint usage (or shortcut if defined), badges for `Built-in`, `Skill`, `Disabled`, `File: <basename>` for markdown.
- Disabled rows: opacity 0.55, tooltip from `disabledReason`. Selectable but `run` short-circuits with the reason.
- Skill rows: keep the existing gradient skill badge from `command-palette.component.ts`. They go through `CommandPaletteController.run` like any other command, but the controller delegates to `SkillStore.loadSkill` (existing behavior, just routed).

### 6.2 Slash composer dropdown (in `input-panel.component.ts`)

- Replaces today's "filter by `cmd.name.toLowerCase().startsWith(query)`, max 8" with the controller-driven groups.
- When the user types a slash command and resolution yields:
  - **exact**: dropdown shows just that command at the top with usage on the right. Enter executes.
  - **alias**: same as exact, but with a small "alias for `/{name}`" hint underneath.
  - **fuzzy**: a "Did you mean…" header followed by up to 5 suggestions.
  - **ambiguous**: a warning header naming the conflicting alias, listing all candidates.
  - **none**: dropdown closes (existing behavior). Pressing Enter sends as a normal message (existing behavior preserved).
- Disabled items in the dropdown are still listed, but Enter on a disabled item shows the reason inline at the top of the dropdown for ~2 s instead of executing.
- The dropdown renders a max of 8 rows; scrollable beyond that. Up/Down wraps.

### 6.3 `/help` command browser

- `/help` no longer expands a static markdown blob into the chat. It opens `CommandHelpHostComponent` as an overlay.
- Browser groups commands by category, supports type-ahead filtering, and shows a detail pane on the right of the selected row (description, usage, examples, applicability summary, source path, aliases).
- Closes on Esc or click outside.
- The previous `/help` text stays as a backup: if the help UI fails to mount, the IPC handler falls back to the old text-template behavior with a console warning.

### 6.4 Disabled command visual contract

```scss
.overlay-item.disabled {
  opacity: 0.55;
  cursor: not-allowed;
  .badges-disabled { display: inline-flex; }
}
.overlay-item.disabled:hover {
  // tooltip mounted on hover; aria-describedby for screen readers
}
```

### 6.5 Accessibility

- Shell uses `role="dialog"`, `aria-modal="true"`, focus trap (existing palette behavior preserved).
- Group headings use `role="group"` with labels.
- Items are `<button>`s with `aria-disabled` on disabled rows.
- Disabled reason is exposed via `aria-describedby` so screen readers announce it.

---

## 7. New supporting services

### 7.1 `GitProbeService`

**New file:** `src/renderer/app/core/services/git-probe.service.ts`.

Reason: `applicability.requiresGitRepo` needs a sync answer in the renderer. Calling main on every keystroke is wasteful. The probe service:

- Keeps a cache `Map<string, boolean>` keyed by working directory.
- Public `isGitRepo(workingDirectory: string | null): boolean | undefined` (undefined = unknown, treated as eligible until probed; renderer renders optimistically and then re-evaluates when the probe resolves).
- On unknown working directory, fires a one-shot IPC call to a new `WORKSPACE_IS_GIT_REPO` channel (main checks for `.git` directory upward from the working directory). Result is cached.
- Cache TTL: 5 minutes. Invalidate when the user changes working directory for an instance.

This is small enough to live in Wave 1; Wave 6's Doctor can later expose probe results in diagnostics.

### 7.2 `featureFlags` computed on `SettingsStore`

**Modified file:** `src/renderer/app/core/state/settings.store.ts`.

`SettingsStore` does not currently expose feature flags as a `Record<string, boolean>`. We add a small computed:

```ts
readonly featureFlags = computed<Record<string, boolean>>(() => {
  const s = this._settings();
  // Return only boolean-typed AppSettings fields; whitelisted to keep the
  // surface stable for applicability checks.
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

A markdown command authoring `applicability.featureFlag: "showThinking"` is then evaluated against this map. Unknown keys are treated as `false` (with a warning diagnostic on registry load if a markdown command references an unknown flag).

### 7.3 Notification surface (no new service)

The renderer codebase **does not currently have** a centralized toast / snackbar / notification service — surveyed surfaces use ad-hoc `console.warn`, inline banners (e.g. `edit-mode-bar` in the composer), and `window.confirm` for confirmations. Introducing a notification primitive is out of scope for Wave 1 (the parent design plans a "shared copy success/error UI contract" in Wave 4 that will likely subsume this).

Controllers therefore expose errors via a signal rather than calling a non-existent service:

```ts
interface OverlayController<T> {
  // ...existing fields...

  /** Last user-facing error from a run() attempt. Hosts render this however
   *  they want (inline banner inside the shell, console.warn fallback). */
  readonly lastError: Signal<OverlayControllerError | null>;
  clearError(): void;
}

export interface OverlayControllerError {
  message: string;
  kind: 'disabled' | 'no-instance' | 'execute-failed' | 'unknown';
  reason?: string;        // applicability reason if kind === 'disabled'
}
```

Hosts in Wave 1 render `lastError` as a small inline banner inside `<app-overlay-shell>` (a new optional `<ng-content select="[bannerSlot]">` projection slot), and the slash composer dropdown renders it inline at the top of the suggestions list. The shell additionally logs the error via `getLogger('OverlayShell').warn(...)` to keep parity with existing console-warn usage.

Wave 4's notification service can later replace the inline banner with a toast without changing the controller interface.

---

## 8. Telemetry & logging

- `UsageTracker` calls produce no console output unless in dev mode.
- Resolver logs `kind` per resolve at `debug` level (gated by `getLogger('CommandManager')`).
- Diagnostics emitted on registry load are logged at `warn` level (one summary line per `(kind, count)` per scan).
- All shell host components emit lifecycle markers via `PerfInstrumentationService` if present (open/close, first-render time) — Wave 1 wires these only if the service already exists; otherwise no-op.

---

## 9. IPC contract changes

### 9.1 New channels

| Channel | Direction | Payload | Response |
|---|---|---|---|
| `COMMAND_RESOLVE` | renderer → main | `{ input: string; instanceId: string }` | `CommandResolutionResult` |
| `COMMAND_REGISTRY_SNAPSHOT` | renderer → main | `{ workingDirectory?: string }` | `CommandRegistrySnapshot` |
| `USAGE_GET_SNAPSHOT` | renderer → main | `{}` | `Record<string, CommandUsageRecord>` |
| `USAGE_RECORD` | renderer → main | `{ commandId: string; projectPath?: string }` | `{ ok: true }` |
| `USAGE_DELTA` | main → renderer (event) | `{ commandId: string; record: CommandUsageRecord }` | — |
| `WORKSPACE_IS_GIT_REPO` | renderer → main | `{ workingDirectory: string }` | `{ isGitRepo: boolean }` |

### 9.2 Modified channels

`COMMAND_EXECUTE` response shape gains a richer error code on disabled/unknown:

```ts
type CommandExecuteError =
  | { code: 'COMMAND_NOT_FOUND'; message: string; suggestions?: CommandTemplate[]; query?: string }
  | { code: 'COMMAND_DISABLED'; message: string; failedPredicate: ApplicabilityResult['failedPredicate'] }
  | { code: 'COMMAND_AMBIGUOUS'; message: string; candidates: CommandTemplate[]; conflictingAlias?: string }
  | { code: 'COMMAND_EXECUTE_FAILED'; message: string };
```

### 9.3 Schema package layout (new subpath)

Command schemas extracted to a new file:

- **New file:** `packages/contracts/src/schemas/command.schemas.ts` — `CommandResolvePayloadSchema`, `CommandRegistrySnapshotSchema`, `UsageRecordPayloadSchema`, `WorkspaceIsGitRepoPayloadSchema`, plus the existing command-related schemas migrated out of `instance.schemas.ts`.
- **Move:** the existing `CommandListPayloadSchema`, `CommandExecutePayloadSchema`, `CommandCreatePayloadSchema`, `CommandUpdatePayloadSchema`, `CommandDeletePayloadSchema` from `instance.schemas.ts` to `command.schemas.ts` (with a deprecation re-export shim in the old file for one wave).

**Required alias-sync edits (4 places, per project's packaging gotcha #1):**

1. `tsconfig.json` → add `"@contracts/schemas/command": ["./packages/contracts/src/schemas/command.schemas.ts"]`
2. `tsconfig.electron.json` → same path entry
3. `src/main/register-aliases.ts` → add `'@contracts/schemas/command': path.join(baseContracts, 'schemas', 'command.schemas')`
4. `vitest.config.ts` → add the alias if test imports use it

Verification: the project ships a `prebuild` check (`scripts/verify-native-abi.js` and similar). This particular sync isn't auto-checked, so the plan must include a manual verification step that types resolve from each context.

---

## 10. Renderer integration points

### 10.1 `CommandStore` — additions

```ts
// new signal
private _diagnostics = signal<CommandDiagnostic[]>([]);
diagnostics = this._diagnostics.asReadonly();

// new method
async loadCommandsSnapshot(workingDirectory?: string): Promise<void>;
```

`loadCommands` is kept as a thin wrapper that calls `loadCommandsSnapshot` and discards diagnostics for backwards compat.

### 10.2 `InputPanelComponent` — minimal diff

- Stop computing `filteredCommands` locally.
- Inject `CommandPaletteController`. Bind its `groups()` and `selectedKey()` signals to a new `<app-command-suggestions-list>` component.
- On `onInput`, call `controller.setQuery(value.startsWith('/') ? value.slice(1) : '')`.
- On `onKeyDown`, route arrow / enter / tab to `controller.setSelectedKey` / `controller.run`.
- On unknown command (`run` returns false because resolution was `none`), fall through to existing send-as-message logic.

### 10.3 `CommandPaletteComponent` → `CommandPaletteHostComponent`

The existing `command-palette.component.ts` is renamed to `command-palette-host.component.ts`. The body becomes:

```html
<app-overlay-shell
  [groups]="controller.groups()"
  [query]="controller.query()"
  [placeholder]="controller.placeholder"
  [selectedKey]="controller.selectedKey()"
  [footerHints]="controller.footerHints()"
  [loading]="controller.loading()"
  modeLabel="Commands"
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
```

The bespoke palette CSS (~170 lines) is deleted; the shell ships its own styles.

---

## 11. Test plan

### 11.1 New test files

- `src/main/commands/__tests__/command-resolver.spec.ts`
  - exact/alias/fuzzy/ambiguous/none paths
  - alias collision across builtin/store/markdown
  - alias-shadowed-by-name
  - fuzzy threshold and ranking tie-breaks
- `src/main/commands/__tests__/command-applicability.spec.ts`
  - each predicate alone; multiple predicates AND'd
  - `disabledReason` overrides auto-generated reason
  - missing context fields treated correctly
- `src/main/commands/__tests__/command-frontmatter.spec.ts`
  - new fields parsed correctly (string + array forms)
  - unknown category → 'custom' + diagnostic
  - invalid type → field dropped + diagnostic
  - alias shadowed by name + diagnostic
- `src/main/observability/__tests__/usage-tracker.spec.ts`
  - record / get / frecency scoring
  - per-project overlay falls back to global
  - schema versioning placeholder
- `src/renderer/app/features/commands/__tests__/command-palette.controller.spec.ts`
  - filtering, grouping, ranking
  - applicability gates `run`
  - usage recorded on success
- `src/renderer/app/shared/overlay-shell/__tests__/overlay-shell.component.spec.ts`
  - keyboard nav
  - disabled-skip behavior
  - emit contract for select/close/queryChange
- `src/renderer/app/core/state/__tests__/usage.store.spec.ts`
  - seeding, optimistic update, delta consumption

### 11.2 Tests to update

- `src/main/commands/__tests__/command-manager.spec.ts` — add cases for snapshot-shape return; keep legacy method tests.
- `src/main/commands/__tests__/markdown-command-registry.spec.ts` — new fields, diagnostics emission.

### 11.3 Manual verification (UI)

- Open palette, type partial command name → fuzzy suggestions appear with "Did you mean…" header.
- Type unknown alias that collides → "Ambiguous alias" warning.
- Enter `/` in composer with idle instance → categorized list with usage hints on the right.
- Hover a disabled command (e.g. `/commit` outside a git repo) → tooltip shows reason, Enter shows reason inline.
- `/help` opens overlay browser, not chat blob.
- After running 5 commands, palette opens with most-recent commands at the top of their category.
- Restart app; frecency persists.

---

## 12. File-by-file change inventory

### Created

| Path | Purpose |
|---|---|
| `src/shared/utils/command-applicability.ts` | `evaluateApplicability` |
| `src/main/observability/usage-tracker.ts` | `UsageTracker` singleton |
| `src/main/ipc/handlers/usage-handlers.ts` | `USAGE_*` IPC handlers |
| `src/main/workspace/git-probe-handler.ts` | `WORKSPACE_IS_GIT_REPO` IPC handler |
| `src/renderer/app/core/state/usage.store.ts` | `UsageStore` |
| `src/renderer/app/core/services/git-probe.service.ts` | `GitProbeService` |
| `src/renderer/app/shared/overlay-shell/overlay-shell.component.ts` | shell |
| `src/renderer/app/shared/overlay-shell/overlay-controller.ts` | controller interface |
| `src/renderer/app/features/commands/command-palette.controller.ts` | palette controller |
| `src/renderer/app/features/commands/command-help.controller.ts` | help controller |
| `src/renderer/app/features/commands/command-help-host.component.ts` | help overlay host |
| `src/renderer/app/features/commands/command-suggestions-list.component.ts` | inline composer dropdown |
| `src/renderer/app/features/commands/command-args.util.ts` | `parseArgsFromQuery` (extracted from existing inline logic) |
| `packages/contracts/src/schemas/command.schemas.ts` | command IPC schemas |
| Test files in § 11.1 | |

### Modified

| Path | Change |
|---|---|
| `src/shared/types/command.types.ts` | Add new fields, types, helpers |
| `src/main/commands/command-manager.ts` | Add `resolveCommand`, `getAllCommandsSnapshot`; keep legacy methods |
| `src/main/commands/markdown-command-registry.ts` | Parse new frontmatter fields, emit diagnostics |
| `src/main/ipc/handlers/command-handlers.ts` | Wire new resolve/snapshot endpoints; richer error codes |
| `src/preload/preload.ts` | Expose new IPC channels |
| `src/main/index.ts` | Register `UsageTracker`, `git-probe-handler`, `usage-handlers` |
| `src/renderer/app/core/state/command.store.ts` | Add diagnostics signal, snapshot loader |
| `src/renderer/app/core/state/settings.store.ts` | Add `featureFlags` computed signal (§ 7.2) |
| `src/renderer/app/features/commands/command-palette.component.ts` | Rename to `command-palette-host.component.ts`; replace body with `<app-overlay-shell>` (delete bespoke palette CSS) |
| `src/renderer/app/features/instance-detail/input-panel.component.ts` | Drive dropdown via `CommandPaletteController` |
| `src/renderer/app/features/instance-detail/input-panel.component.html` | Use `<app-command-suggestions-list>` |
| `src/renderer/app/app.component.ts` | Seed `UsageStore.init()` on bootstrap |
| `tsconfig.json` | Add `@contracts/schemas/command` alias |
| `tsconfig.electron.json` | Same |
| `src/main/register-aliases.ts` | Same |
| `vitest.config.ts` | Same (if tests import the new subpath) |
| `packages/contracts/src/schemas/instance.schemas.ts` | Re-export old command schemas from new file (one-wave deprecation shim) |

### Removed

None. Backwards compat preserved everywhere; deletions deferred to a follow-up cleanup pass after Wave 2 has migrated.

---

## 13. Acceptance criteria

The wave is shippable when **all** of the following hold:

1. `npx tsc --noEmit` passes.
2. `npx tsc --noEmit -p tsconfig.spec.json` passes.
3. `npm run lint` passes with no new warnings.
4. New unit specs (§ 11.1) pass; existing command/markdown specs still pass.
5. Unknown slash command in palette and composer surfaces nearest matches.
6. Alias execution works in both palette and composer; aliases are reflected in `/help` and slash dropdown.
7. Ambiguous alias collisions show a clear warning and list all candidates.
8. `/help` opens the categorized command browser (not the legacy text blob).
9. Disabled commands are visible in the UI, gray, with the disabled reason in a tooltip and inline on Enter.
10. Frecency persists across app restarts (record three commands, restart, observe ranking).
11. The packaged DMG starts (smoke run) — confirms the alias-sync edits are correct.

---

## 14. Non-goals

- No session, model, agent, or resume picker controllers (Wave 2 / Wave 3).
- No Doctor UI surfacing diagnostics (Wave 6). Wave 1 only emits diagnostics; they're observable via console/logs and the new `COMMAND_REGISTRY_SNAPSHOT` IPC.
- No editing of new metadata via the custom-command UI. Custom commands keep their existing creation surface; new fields are markdown-only for Wave 1 (custom-command UI extension is a follow-up).
- No grand renaming or restructure of `CommandManager`'s internal storage.
- No new provider-runtime contract changes.

---

## 15. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Alias-sync edits forgotten → packaged app crashes on startup | Med | High | Plan includes explicit DMG smoke-test step; spec § 9.3 lists all 4 sites. |
| Fuzzy ranking surprises users (returns wrong "did you mean") | Med | Med | Threshold ≤ 2 + tests pinning the ranking order; iterate based on feedback. |
| `UsageTracker` `electron-store` schema diverges from Wave 2's session store | Low | Med | Schema-versioned now (`schemaVersion: 1`), explicit room for additional top-level keys. |
| Disabled commands clutter the dropdown | Med | Low | `applicability.hideWhenIneligible` opt-in for surfaces that need it. |
| Controller pattern leaks into too many features (over-engineering) | Low | Low | Wave 1 ships exactly 2 controllers; pattern proven before Wave 2 adds more. |
| Renderer cache for frecency drifts from main on rapid concurrent execution | Low | Low | Optimistic local + main delta event = eventual consistency; ranking is advisory not security-critical. |
| Fuzzy match cost grows with command volume | Low | Low | Bounded by visible set (~hundreds); memoize normalized-name list per snapshot if profiling shows hotspot. |
| `/help` browser overlay blocks chat scrolling unexpectedly | Low | Low | Same focus-trap pattern as the existing palette; reuse styles. |

---

## 16. Follow-ups for downstream waves

These are flagged here so subsequent specs can reuse the foundation cleanly:

- **Wave 2**: build `SessionPickerController`, `ModelPickerController`, `AgentPickerController` against the same `OverlayController` interface. Add `select-visible-instance-1..9` keybindings (out of scope here).
- **Wave 3**: build `ResumePickerController` against the same interface. Reuse `UsageStore` for resume frecency; extend `usage-tracker` schema to v2 (`sessions`, `resumes` keys) at that time.
- **Wave 6**: surface `CommandDiagnostic[]` from `COMMAND_REGISTRY_SNAPSHOT` in the Doctor UI. Add a custom-command authoring UI for the new metadata fields.
- **Cleanup pass after Wave 2**: remove the deprecation shim in `instance.schemas.ts` (re-export of moved command schemas) once all importers point at `@contracts/schemas/command`.

---

## Appendix A — Cross-link with parent design

This child design implements the following items from the parent design's **Track A — Command, Palette, Overlay, And Navigation** section:

- "Add a typed command metadata model" → § 1
- "Command resolution should return a structured result" → § 1.5, § 3
- "Build a reusable overlay shell" → § 5
- "Add command usage/frecency tracking" → § 4

It does **not** implement:

- Numeric hotkeys for visible instance switching → Wave 2
- Prompt history recall → Wave 2
- Session/model/agent pickers → Wave 2

## Appendix B — Cross-link with parent plan

This child design provides the architectural detail for **Wave 1** of the parent plan. Each task in the parent plan's Wave 1 section maps to:

| Parent plan task | This spec § |
|---|---|
| Extend `CommandTemplate` with new fields | § 1.1–1.4 |
| Extend markdown frontmatter parsing | § 2 |
| Add structured command resolution result types | § 1.5, § 3 |
| Update `CommandManager.executeCommand` and IPC for actionable errors | § 3, § 9.2 |
| Add alias collision diagnostics | § 1.7, § 2.1 |
| Build reusable overlay shell | § 5.1 |
| Refactor command palette onto the shell | § 5.3, § 10.3 |
| Replace `/help` with categorized help | § 5.5, § 6.3 |
| Update slash suggestions | § 5.4, § 6.2 |
| Add command usage/frecency tracking | § 4 |
