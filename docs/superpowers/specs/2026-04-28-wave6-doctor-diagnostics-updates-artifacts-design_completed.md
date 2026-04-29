# Wave 6: Doctor, Diagnostics, Updates, And Operator Artifacts — Design

**Date:** 2026-04-28
**Status:** Completed
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design.md`](./2026-04-28-cross-repo-usability-upgrades-design.md) (Track D — Operator Reliability And Local Tooling)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`](../plans/2026-04-28-cross-repo-usability-upgrades-plan.md) (Wave 6)
**Implementation plan (to follow):** `docs/superpowers/plans/2026-04-28-wave6-doctor-diagnostics-updates-artifacts-plan.md`

## Doc taxonomy in this repo

This spec is one of several artifacts in a multi-wave program. To prevent confusion and doc sprawl:

| Artifact | Folder | Filename pattern | Purpose |
|---|---|---|---|
| **Design / spec** | `docs/superpowers/specs/` | `YYYY-MM-DD-<topic>-design.md` | What we're building, why, how it fits, types & contracts |
| **Plan** | `docs/superpowers/plans/` | `YYYY-MM-DD-<topic>.md` (or `…-plan.md`) | Wave/task breakdown, files to read, exit criteria |
| **Master / roadmap plan** | `docs/superpowers/plans/` | `YYYY-MM-DD-<name>-master-plan.md` | Multi-feature umbrella spanning many specs/plans |
| **Completed** | either folder | `…_completed.md` suffix | Archived after the work shipped |

This document is a **per-wave child design** of the parent program design. The relationship is:

```
parent design (cross-repo-usability-upgrades-design.md)
  ├── Track A → wave 1 spec (CHILD — landed)
  ├── Track A → wave 2 spec (TBD)
  ├── Track B → wave 3 spec (TBD)
  ├── Track C → wave 5 spec (TBD)
  └── Track D → wave 4 spec (TBD)
                wave 6 spec (THIS DOC — child of Track D's diagnostics half)

parent plan (cross-repo-usability-upgrades-plan.md)
  └── Wave 6 task list  ←── implemented by this child spec
```

The parent design and plan remain authoritative for cross-track coupling, deferred ideas, and risks; this child design is authoritative for **everything required to implement Wave 6 end to end**. Wave 6 explicitly depends on Wave 1's `CommandRegistrySnapshot.diagnostics[]` for one of its sections; that dependency is gated behind a feature flag so Wave 6 is mergeable independently.

---

## Goal

Turn the existing diagnostic services (`ProviderDoctor`, `CapabilityProbe`, `BrowserAutomationHealthService`, `CliUpdateService`, `InstructionResolver`, `SkillRegistry`, `MarkdownCommandRegistry`, `lifecycle-trace`) into a single coherent operator surface that:

1. Surfaces a **Doctor settings tab** combining startup capability report + provider doctor + CLI Health + browser automation health.
2. Lets the **degraded startup banner deep-link** into the exact Doctor section that triggered the degradation.
3. Adds a **CLI update pill** to the title bar when installed CLIs have supported update plans, so updates are discoverable outside the settings tab.
4. Surfaces **command diagnostics** (Wave 1 emits the data — this wave renders it) behind a feature-flag fallback.
5. Adds **skill diagnostics** (invalid frontmatter, missing referenced assets, duplicate names, unreadable files).
6. Adds **instruction diagnostics** (conflicting AGENTS / orchestrator / Copilot, broad-root scan warnings).
7. Provides a **local operator artifact export** (zip bundle: startup report + provider diagnoses + command diagnostics + skill diagnostics + instruction diagnostics + lifecycle trace tail + selected-session diagnostics) with a strict redaction policy.

The wave does **not** introduce new probe semantics — every probe and every datum already exists somewhere in the main process. The work is composition + presentation + one new export path.

## Decisions locked from brainstorming

| # | Decision | Rationale |
|---|---|---|
| 1 | **Doctor is a settings tab, not a separate route.** Add a new `'doctor'` tab to the existing settings sidebar. Deep-link via `/settings?tab=doctor&section=<id>`. | Avoids competing with the existing settings UX; reuses the entire shell, sidebar, and back-button affordance from `settings.component.ts`. The banner deep-link contract becomes one URL pattern, not two. |
| 2 | **Sections inside the Doctor tab.** Startup Capabilities, Provider Health, CLI Health, Browser Automation, Commands & Skills, Instructions, Operator Artifacts. CLI Health is a thin wrapper that defers rendering to the existing tab content via a shared service (no duplicate logic). | Each section maps to one already-running probe. The CLI Health wrapper avoids a parallel implementation. |
| 3 | **Banner deep-link.** Click → `router.navigate(['/settings'], { queryParams: { tab: 'doctor', section: <first-failing-section-id> } })`. Each `StartupCapabilityCheck.id` maps to a Doctor section via a small lookup table. Highest-severity failing check wins ties. | Operators want one click from "things look wrong" to "the exact thing." Severity ranking comes from `StartupCapabilityCheckStatus`: `unavailable > degraded > disabled > ready`. |
| 4 | **Update pill placement.** Title bar, next to the existing `app-provider-quota-chip` in `app.component.html`. Compact: shows count of available updates + tooltip listing CLIs. Click navigates to `/settings?tab=cli-health`. | Title bar already has the only persistent pill (provider quota); placing the update pill alongside keeps cross-app discoverability without growing nav surface. |
| 5 | **Update pill data source.** Poll `cli:diagnose-all-clis` + `cli:get-update-plans` on app start and every 24 h (or after manual refresh). Cache result in main-process singleton; renderer reads via signal-based store. | Matches the design constraint that update checks are infrequent and that we already pay the IPC cost on the CLI Health tab. |
| 6 | **Command diagnostics** are surfaced behind a `featureFlags.commandDiagnosticsAvailable` gate. When the flag is `false`, the section renders a placeholder ("Pending Wave 1 implementation"). When `true`, the section consumes Wave 1's `CommandRegistrySnapshot.diagnostics[]`. The same gate is also visible in the Doctor section header for consistency. | Wave 1's snapshot type is defined but the runtime emission is not yet wired. Hard-coupling Wave 6 to Wave 1 would block Wave 6 indefinitely. |
| 7 | **Skill diagnostics** come from a new `SkillDiagnosticsService` that reads `SkillRegistry.skills` and computes: invalid frontmatter (already warned via `parseSkillFrontmatter`), missing referenced assets (file existence check), unreadable files (`fs.access` failure), duplicate skill IDs (build a Map). Output: `SkillDiagnostic[]` with `severity: 'error' \| 'warning'`. | Reuses the existing registry; the service is a pure consumer of registry state plus a few file-system checks. |
| 8 | **Instruction diagnostics** wrap `InstructionResolver.warnings[]` (already populated by `buildWarnings` in `instruction-resolver.ts`) and add a **"broad-root scan"** warning when a project-level `INSTRUCTIONS.md` lacks scope filters AND the repo has > 100 files. Threshold (`broadRootFileThreshold`) is configurable on `SettingsStore` with default `100`. | The existing warnings already cover orchestrator/agents/Copilot conflicts and multiple path-specific matches. The broad-root scan is the only net-new check. |
| 9 | **Operator artifact format = ZIP bundle**, not single JSONL. Bundle contains: `startup-report.json`, `provider-diagnoses.json`, `command-diagnostics.json` (when Wave 1 is available), `skill-diagnostics.json`, `instruction-diagnostics.json`, `lifecycle-tail.ndjson` (last 500 events), `selected-session-diagnostics.json` (only if a session is selected by the user), `manifest.json` (versions, timestamp, redaction policy). | A bundle keeps the export self-describing and lets us add files later without versioning the wire format. JSONL would force everything into one stream and complicate redaction review. |
| 10 | **Redaction.** Environment variables are reported as `{ name, isSet: boolean }` only — never plaintext. Absolute paths under `os.homedir()` transformed to `~/...`; absolute paths elsewhere kept verbatim except known credential paths (`.aws/credentials`, etc.) which are dropped. Session content excluded from default export; opt-in flag includes redacted content (model names, role labels) but **never** message text or prompts. | Operators routinely share these bundles. The redaction surface must be small enough to review and large enough to leak nothing sensitive. |
| 11 | **Export location.** `app.getPath('userData') + '/diagnostics-bundles/<timestamp>.zip'`. Renderer surfaces the path and offers an Electron native "Show in Finder/Explorer" affordance. No automatic upload. | Keeps the artifact local; users decide whether/how to send it. |
| 12 | **No new `@contracts/schemas/*` subpath.** Diagnostic types live in `src/shared/types/diagnostics.types.ts`; diagnostics IPC payloads are validated by local Zod schemas in `src/main/ipc/handlers/diagnostics-handlers.ts`. The only contracts package addition is a diagnostics channel group. | Avoids the four-place alias sync from packaging gotcha #1 while keeping IPC channel names in the contracts source of truth. |

## Validation method

The decisions and types in this spec were grounded by reading these files in full prior to drafting:

- Parent docs: `docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design.md`, `docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`
- Wave 1 dependency: `docs/superpowers/specs/2026-04-28-wave1-command-registry-and-overlay-design.md` (§ 1.7 diagnostics shape; § 9.1 `COMMAND_REGISTRY_SNAPSHOT` IPC)
- Probes: `src/main/providers/provider-doctor.ts` (lines 1–429), `src/main/bootstrap/capability-probe.ts` (lines 1–280), `src/main/browser-automation/browser-automation-health.ts` (referenced from `capability-probe.ts` lines 213–270)
- CLI: `src/main/cli/cli-update-service.ts` (lines 1–53 = `CLI_UPDATE_SPECS`), `src/renderer/app/features/settings/cli-health-settings-tab.component.ts` (lines 90–639)
- Settings shell: `src/renderer/app/features/settings/settings.component.ts` (tab list + signal-based selection), `src/renderer/app/app.routes.ts` (line 25 `/settings` route)
- Banner: `src/renderer/app/app.component.html` (lines 1–24), `src/renderer/app/app.component.ts` (lines 75–101 — `startupCapabilitySummary`)
- Skills: `src/main/skills/skill-registry.ts` (lines 1–183), `src/main/skills/skill-loader.ts`, `packages/contracts/src/schemas/plugin.schemas.ts` (`SkillFrontmatterSchema`)
- Instructions: `src/main/core/config/instruction-resolver.ts` (lines 1–562; `buildWarnings` at line 200)
- Commands: `src/main/commands/markdown-command-registry.ts` (Wave 1 will extend this)
- Lifecycle tracing: `src/main/observability/lifecycle-trace.ts` (lines 1–68), `src/main/observability/local-trace-exporter.ts` (line 18)
- Types: `src/shared/types/startup-capability.types.ts`

---

## 1. Type model

All new shared types live in **a new file** `src/shared/types/diagnostics.types.ts`. Existing types are imported, not duplicated.

### 1.1 `DoctorReport` — composite of all diagnostic sources

```ts
import type { StartupCapabilityReport } from './startup-capability.types';
import type { DiagnosisResult } from '../../main/providers/provider-doctor';   // re-exported via shared barrel
import type { BrowserAutomationDiagnosis } from '../../main/browser-automation/browser-automation-health';
import type { CliInfo, CliUpdatePlan } from '../../main/cli/cli-update-service';
import type { CommandDiagnostic } from './command.types';                       // Wave 1 type, may be undefined at runtime

export type DoctorSectionId =
  | 'startup-capabilities'
  | 'provider-health'
  | 'cli-health'
  | 'browser-automation'
  | 'commands-and-skills'
  | 'instructions'
  | 'operator-artifacts';

export type DoctorSeverity = 'ok' | 'info' | 'warning' | 'error';

export interface DoctorSectionSummary {
  id: DoctorSectionId;
  label: string;
  severity: DoctorSeverity;
  headline: string;          // short human summary, one line
  itemCount: number;         // number of issues if severity != 'ok'
}

export interface DoctorReport {
  generatedAt: number;
  startupCapabilities: StartupCapabilityReport;          // from CapabilityProbe.run()
  providerDiagnoses: ProviderDiagnosesSnapshot;          // from ProviderDoctor.diagnose() per provider
  browserAutomation: BrowserAutomationDiagnosis;         // from BrowserAutomationHealthService.diagnose()
  cliHealth: CliHealthSnapshot;
  commandDiagnostics: CommandDiagnosticsSnapshot;        // Wave 1 dependency; may be 'unavailable'
  skillDiagnostics: SkillDiagnostic[];
  instructionDiagnostics: InstructionDiagnostic[];
  sections: DoctorSectionSummary[];                       // pre-computed ordering for UI rendering
}

export interface ProviderDiagnosesSnapshot {
  diagnoses: Array<{ provider: string; diagnosis: DiagnosisResult }>;
  generatedAt: number;
}

export interface CliHealthSnapshot {
  installs: CliInfo[];
  updatePlans: CliUpdatePlan[];
  generatedAt: number;
}

export type CommandDiagnosticsSnapshot =
  | { available: true; diagnostics: CommandDiagnostic[]; scanDirs: string[]; generatedAt: number }
  | { available: false; reason: 'wave1-not-shipped' | 'no-working-directory' };
```

### 1.2 `SkillDiagnostic`

```ts
export type SkillDiagnosticCode =
  | 'invalid-frontmatter'        // SkillFrontmatterSchema.parse failed
  | 'missing-asset'              // bundle.assetPaths/scriptPaths/referencePaths includes a path that no longer exists
  | 'unreadable-file'            // fs.access threw EACCES / similar
  | 'duplicate-skill-id'         // two bundles share the same id (defensive — should not happen)
  | 'duplicate-trigger';         // multiple bundles claim the same trigger string

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  message: string;
  skillId?: string;
  skillPath?: string;
  filePath?: string;             // specific file inside the bundle, if applicable
  trigger?: string;
  severity: 'warning' | 'error';
}
```

### 1.3 `InstructionDiagnostic`

```ts
export type InstructionDiagnosticCode =
  | 'orchestrator-agents-conflict'   // both orchestrator and AGENTS at project level
  | 'multiple-path-specific'         // two path-specific files matched the current ctx
  | 'copilot-conflict'               // Copilot instructions present alongside orchestrator/AGENTS
  | 'broad-root-scan'                // INSTRUCTIONS.md without scope filters AND repo has > N files
  | 'unreadable-source';             // a configured source path could not be read

export interface InstructionDiagnostic {
  code: InstructionDiagnosticCode;
  message: string;
  scope: 'global-user' | 'project' | 'path-specific';
  sourcePaths?: string[];        // absolute paths involved
  fileCountSampled?: number;     // for broad-root-scan
  severity: 'warning' | 'error';
}
```

### 1.4 `OperatorArtifactBundleManifest`

```ts
export interface OperatorArtifactBundleManifest {
  schemaVersion: 1;
  generatedAt: number;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  workingDirectory?: string;     // home-relative; present iff caller passed workingDirectory
  redactionPolicy: {
    envVarsRedacted: true;
    homedirRelativized: true;
    embeddedSecretsRedacted: true;              // tokens redacted within larger strings, not just whole-string matches
    sessionContentExcluded: boolean;            // false ⇒ caller opted in
    sessionContentRedaction?: 'metadata-only';  // present iff session content included
  };
  files: Array<{
    name: string;                // basename inside the zip
    bytes: number;               // 0 for the manifest's own entry; recorded post-serialize is impossible.
    sha256: string;              // 'self-described' sentinel for the manifest's own entry; sha256 hex for all others.
    contentType: 'json' | 'ndjson' | 'text';
    description: string;
    optional?: boolean;          // true for files that are skipped when no source data
  }>;
  selectedSessionId?: string;    // present iff caller passed a sessionId
  commandDiagnosticsAvailable: boolean;
}
```

### 1.5 `CliUpdatePillState`

```ts
export interface CliUpdatePillEntry {
  cli: CliType;                  // from cli-detection.ts
  displayName: string;
  currentVersion?: string;
  updatePlan: CliUpdatePlan;
}

export interface CliUpdatePillState {
  loaded: boolean;
  generatedAt: number | null;
  count: number;                 // entries.length
  entries: CliUpdatePillEntry[];
  /** ms epoch of last successful refresh; renderer compares against now to decide if stale. */
  lastRefreshedAt: number | null;
  error?: string;
}
```

### 1.6 `OperatorArtifactExportRequest` and result

```ts
export interface OperatorArtifactExportRequest {
  /** When provided, the bundle includes session diagnostics for this session id (still redacted). */
  sessionId?: string;
  /** Default false. When true, bundle includes session content metadata (model names, role labels) but NEVER message text. */
  includeSessionContent?: boolean;
  /**
   * Optional working directory for workspace-scoped diagnostics
   * (instruction conflicts, project-level skills, command diagnostics).
   * Forwarded to `DoctorService.getReport({ workingDirectory })`. If
   * omitted, workspace-scoped diagnostics are NOT collected and the
   * resulting manifest's `workingDirectory` field is absent.
   */
  workingDirectory?: string;
}

export interface OperatorArtifactExportResult {
  bundlePath: string;            // absolute path to the .zip
  bundleBytes: number;
  manifest: OperatorArtifactBundleManifest;
}
```

---

## 2. Service signatures

All new singletons follow the project pattern: lazy `getInstance()`, exported `getXxx()` getter, `_resetForTesting()` reset, `getLogger('Name')` logger.

### 2.1 `DoctorService` (new)

**File:** `src/main/diagnostics/doctor-service.ts`

```ts
class DoctorService {
  static getInstance(): DoctorService;
  static _resetForTesting(): void;

  /** Compose a full DoctorReport from all sources. Reuses each upstream service's cached result when available. */
  async getReport(opts?: { workingDirectory?: string; force?: boolean }): Promise<DoctorReport>;

  /** Find the Doctor section that owns a given startup-check id (used by the banner deep-link). */
  resolveSectionForStartupCheck(checkId: string): DoctorSectionId;

  /** Pre-compute section summaries for the renderer. */
  buildSectionSummaries(report: Omit<DoctorReport, 'sections'>): DoctorSectionSummary[];
}

export function getDoctorService(): DoctorService;
```

Composition contract:

- `startupCapabilities` ← `getCapabilityProbe().getLastReport() ?? await getCapabilityProbe().run()`
- `providerDiagnoses` ← `Promise.all(['claude-cli','codex-cli','gemini-cli','copilot','cursor'].map(p => getProviderDoctor().diagnose(p)))`
- `browserAutomation` ← `await getBrowserAutomationHealthService().diagnose()`
- `cliHealth` ← `{ installs: await getCliDetectionService().detectAll(), updatePlans: ['claude','codex','gemini','copilot','cursor','ollama'].map(c => getCliUpdateService().getUpdatePlan(c)) }`
- `commandDiagnostics` ← if `featureFlags.commandDiagnosticsAvailable && workingDirectory`, call `getCommandManager().getAllCommandsSnapshot(workingDirectory)`; else `{ available: false, reason }`
- `skillDiagnostics` ← `await getSkillDiagnosticsService().diagnose()`
- `instructionDiagnostics` ← `await getInstructionDiagnosticsService().diagnose(workingDirectory)`

Section summaries are computed deterministically: highest individual severity wins per section, item counts come from `diagnoses[].probes.filter(p => p.status === 'fail').length` or equivalent.

### 2.2 `SkillDiagnosticsService` (new)

**File:** `src/main/diagnostics/skill-diagnostics-service.ts`

```ts
class SkillDiagnosticsService {
  static getInstance(): SkillDiagnosticsService;
  static _resetForTesting(): void;

  async diagnose(): Promise<SkillDiagnostic[]>;
}

export function getSkillDiagnosticsService(): SkillDiagnosticsService;
```

Algorithm:

1. Read `getSkillRegistry().listSkills()` (a small new accessor exposed on `SkillRegistry` returning `SkillBundle[]`; today only `triggerIndex` is keyed access).
2. For each bundle, validate `metadata` against `SkillFrontmatterSchema`. If `parse()` throws, emit `invalid-frontmatter`.
3. For each `assetPaths`/`scriptPaths`/`referencePaths`/`examplePaths` file, call `fs.access(p, fs.constants.F_OK)`. On `ENOENT` emit `missing-asset`. On `EACCES`/other errors emit `unreadable-file`.
4. Build `Map<id, SkillBundle[]>` keyed by `bundle.id` and `bundle.metadata.name` (lowercased). Anything with > 1 entry emits `duplicate-skill-id`.
5. Build `Map<trigger, SkillBundle[]>` from `triggerIndex`. Anything with > 1 entry emits `duplicate-trigger`.

### 2.3 `InstructionDiagnosticsService` (new)

**File:** `src/main/diagnostics/instruction-diagnostics-service.ts`

```ts
class InstructionDiagnosticsService {
  static getInstance(): InstructionDiagnosticsService;
  static _resetForTesting(): void;

  async diagnose(workingDirectory?: string): Promise<InstructionDiagnostic[]>;
}

export function getInstructionDiagnosticsService(): InstructionDiagnosticsService;
```

Algorithm:

1. If no `workingDirectory`, return `[]` (instructions are workspace-scoped).
2. Resolve via `await resolveInstructions(workingDirectory)` (existing function in `instruction-resolver.ts`).
3. Translate each `warnings[]` string to a typed `InstructionDiagnostic`:
   - `"Both orchestrator and AGENTS instructions are present at the project level."` → `orchestrator-agents-conflict`
   - `"Multiple path-specific instruction files matched the current context."` → `multiple-path-specific`
4. Walk `sources[]` for any source where `loaded === false && error` → `unreadable-source`.
5. **Broad-root scan**: if a project-level source has `applyTo: undefined || []` (no scope filter) AND `await countRepoFiles(workingDirectory) > settings.broadRootFileThreshold`, emit `broad-root-scan` with `fileCountSampled`.
6. **Copilot conflict**: if any project-level Copilot instructions are loaded alongside orchestrator/AGENTS, emit `copilot-conflict`.

`countRepoFiles` is a small private helper that uses `fs.opendir` and bails out at the threshold + 1 to avoid a full walk on giant repos (early termination).

### 2.4 `OperatorArtifactExporter` (new)

**File:** `src/main/diagnostics/operator-artifact-exporter.ts`

```ts
class OperatorArtifactExporter {
  static getInstance(): OperatorArtifactExporter;
  static _resetForTesting(): void;

  async export(req: OperatorArtifactExportRequest): Promise<OperatorArtifactExportResult>;
}

export function getOperatorArtifactExporter(): OperatorArtifactExporter;
```

Algorithm:

1. Build `DoctorReport` via `getDoctorService().getReport()`.
2. Read last 500 lines of `resolveLifecycleTraceFilePath()`. If file missing, write a one-line `lifecycle-tail.ndjson` with `{ note: 'no lifecycle trace recorded' }`.
3. If `req.sessionId` provided, capture session diagnostics from `getSessionRecallService()` (existing). Apply redaction:
   - drop message bodies
   - keep model names, role labels, timestamps, tool-call names (but not arguments) iff `includeSessionContent === true`
   - else drop everything except a `{ sessionId, redactionPolicy: 'metadata-only' }` stub.
4. Apply global redaction pass to every JSON payload before zipping (see § 6).
5. Build `manifest.json` with sha256 of every other file.
6. Write zip to `path.join(app.getPath('userData'), 'diagnostics-bundles', `${ts}.zip`)`.
7. Return `OperatorArtifactExportResult`.

ZIP construction uses Node's `zlib`-backed implementation in a small helper (`createZipFromEntries(entries: Array<{ name, content: Buffer | string }>)`). No new npm dependency — `archiver` would be cleaner but adds a transitive surface; for Wave 6 we ship a minimal stored-zip writer (no compression) given bundle sizes are small (< 1 MB typical). Plan task 5.x will reconsider if archiver is already in `package.json` (check before importing).

### 2.5 `CliUpdatePollService` (new, main process)

**File:** `src/main/cli/cli-update-poll-service.ts`

```ts
class CliUpdatePollService {
  static getInstance(): CliUpdatePollService;
  static _resetForTesting(): void;

  /** Subscribers fire whenever the cached state changes (initial load, manual refresh, 24-h tick). */
  onChange(listener: (state: CliUpdatePillState) => void): () => void;

  getState(): CliUpdatePillState;

  /** Force a refresh; no-op if a refresh is already in flight (same singleton). */
  async refresh(): Promise<CliUpdatePillState>;

  /** Start the 24-h interval. Idempotent. */
  start(): void;

  /** Cancel the interval. */
  stop(): void;
}

export function getCliUpdatePollService(): CliUpdatePollService;
```

Cache: `state` lives in memory only; on app restart we re-poll. `start()` is called once from `src/main/bootstrap/index.ts` after detection has finished.

---

## 3. UI flows

### 3.1 Banner → Doctor deep-link

Today: `src/renderer/app/app.component.html` lines 8–18 render a static banner. There is no click handler.

After Wave 6:

```html
@if (startupCapabilities() && startupCapabilities()!.status !== 'ready') {
  <button
    class="startup-banner"
    type="button"
    [class.failed]="startupCapabilities()!.status === 'failed'"
    (click)="openDoctorForBanner()"
  >
    <span class="startup-banner-title">Startup checks: {{ startupCapabilities()!.status }}</span>
    <span class="startup-banner-body">{{ startupCapabilitySummary() }}</span>
    <span class="startup-banner-cta">Open Doctor</span>
  </button>
}
```

`openDoctorForBanner()` (new method on `AppComponent`):

```ts
openDoctorForBanner(): void {
  const report = this.startupCapabilities();
  if (!report) return;
  const failing = this.pickHighestSeverityFailingCheck(report);
  const section = this.doctorSectionForCheck(failing);
  this.router.navigate(['/settings'], { queryParams: { tab: 'doctor', section } });
}
```

`doctorSectionForCheck` is a small synchronous lookup:

| Startup check id | Doctor section |
|---|---|
| `native.sqlite` | `startup-capabilities` |
| `provider.any`, `provider.<id>` | `provider-health` |
| `subsystem.remote-nodes` | `startup-capabilities` |
| `subsystem.browser-automation` | `browser-automation` |
| (default) | `startup-capabilities` |

`pickHighestSeverityFailingCheck` orders checks by `unavailable > degraded > disabled > ready` and picks the first.

### 3.2 Doctor tab navigation

`SettingsComponent` (existing) exposes a signal-based `activeTab`. After Wave 6, it also honours query params:

```ts
private route = inject(ActivatedRoute);

constructor() {
  effect(() => {
    const tab = this.route.snapshot.queryParamMap.get('tab') as TabId | null;
    if (tab && this.tabIds.includes(tab)) {
      this.activeTab.set(tab);
    }
    const section = this.route.snapshot.queryParamMap.get('section') as DoctorSectionId | null;
    if (section) {
      this.doctorStore.setActiveSection(section);
    }
  });
}
```

The new `'doctor'` tab is added to `SETTINGS_TABS` after `'cli-health'`:

```ts
{ id: 'doctor', label: 'Doctor', group: 'Advanced' },
```

The Doctor tab renders `DoctorSettingsTabComponent` which:

1. On init calls `doctorStore.loadReport(workingDirectory)`.
2. Renders an in-page sidebar of section summaries (`DoctorSectionSummary[]`) with severity badges, plus a main pane that scrolls to the active section. Active section is bound to `doctorStore.activeSection()`.
3. Each section is a small standalone component (`DoctorSectionComponent`) that takes section id + report and renders the appropriate fragment. The CLI Health section embeds the existing `<app-cli-health-settings-tab>` content via a shared service so we don't duplicate render logic.

### 3.3 Update pill click

The pill is a new component `<app-cli-update-pill>` mounted next to `<app-provider-quota-chip>` in `app.component.html`:

```html
<div class="title-bar-overlay" [class.macos]="isMacOS">
  <app-provider-quota-chip />
  <app-cli-update-pill />
</div>
```

Behavior:

- `cliUpdatePillStore.state()` — signal-derived from main-process push events.
- When `state.count === 0`: render nothing.
- When `state.count > 0`: render a small chip "{N} update{s}" with a tooltip listing CLIs and their currently installed → target version (or "self-update" when the plan has no version).
- Click → `router.navigate(['/settings'], { queryParams: { tab: 'cli-health' } })`.

Polling cadence:

- On app start, `CliUpdatePollService.start()` triggers `refresh()` immediately, then sets a `setInterval` for 24 h.
- The CLI Health tab's "Refresh" button calls `cliUpdatePollService.refresh()` (via IPC) so manual refreshes update both surfaces.

### 3.4 Artifact export

The Operator Artifacts section of the Doctor tab renders:

- A short description and the redaction policy summary.
- Two opt-in toggles: "Include selected session diagnostics" (only shown if a session is currently selected via `InstanceStore`), and "Include redacted session metadata (model names, role labels — never message text)" (only shown when the first toggle is on).
- An "Export Bundle" button that calls the flat preload method `window.electronAPI.diagnosticsExportArtifactBundle({ sessionId, workingDirectory })` through `DoctorStore`.
- After the export resolves, render the result path with a "Show in Finder/Explorer" button that calls a new `system:reveal-in-folder` IPC handler (or reuses an existing one — preflight check in plan task 5.x).

---

## 4. Wave 1 feature-flag fallback

Wave 1's `CommandRegistrySnapshot` and `CommandDiagnostic[]` are referenced in this spec but **not yet implemented in source**. Wave 6 ships behind `featureFlags.commandDiagnosticsAvailable: false`. Behavior matrix:

| Flag | `workingDirectory` | Section behavior |
|---|---|---|
| `false` | any | Section shows "Command diagnostics will become available after Wave 1 ships. Skill and instruction diagnostics are below." |
| `true` | undefined | Section shows "Open a project to see command diagnostics for that workspace." |
| `true` | provided | Section calls `getCommandManager().getAllCommandsSnapshot(workingDirectory)` and renders `diagnostics[]` grouped by `code` (alias-collision, alias-shadowed-by-name, unknown-category, …). |

Flag location: `SettingsStore.featureFlags()` computed (Wave 1 introduces this signal). For Wave 6, we read it the same way and add `commandDiagnosticsAvailable` to the whitelist. If Wave 1 hasn't shipped yet, the flag simply doesn't exist in `AppSettings` and the Wave 6 code defaults it to `false`.

The same gate is also surfaced in the CLI Health header so operators understand why command diagnostics aren't yet visible. After Wave 1 ships and registry-snapshot IPC is wired, flipping the flag to `true` (defaults true in `AppSettings`) reveals the section.

---

## 5. Redaction rules

Every JSON object written to the bundle passes through a single redaction pipeline before serialization. Rules:

| Rule | Input | Output |
|---|---|---|
| **Env-vars** | any value containing `process.env.X` (caller-provided, e.g. `ProviderDoctor` recommendations sometimes mention env names) | replaced with `{ name: 'X', isSet: process.env.X != null }` |
| **Home-relative paths** | any string matching `^${os.homedir()}` | replaced with `~` + the trailing portion |
| **Absolute path under known credential dirs** | `~/.aws/credentials`, `~/.config/gh/hosts.yml`, `~/.netrc`, `~/.npmrc`, `~/.ssh/*` | replaced with `<redacted-credential-path>` |
| **API tokens / known secret prefixes (embedded match)** | tokens matching `\bsk-[A-Za-z0-9_\-]{8,}\b`, `\bghp_[A-Za-z0-9_\-]{20,}\b`, `\bgithub_pat_[A-Za-z0-9_\-]{20,}\b`, `\bxoxb-[A-Za-z0-9_\-]{10,}\b`, `\bya29\.[A-Za-z0-9_\-]{10,}\b`, `\bAIza[A-Za-z0-9_\-]{20,}\b`, or `\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b` (JWT) — anywhere in the string, not just whole-string matches | matched substring(s) replaced with `<redacted-secret>` (multiple matches per string supported) |
| **Email addresses** | RFC 5322 match | preserved (operators need to see them in instruction conflicts) |
| **Session message text** | any field named `content`, `text`, `prompt`, `message`, `response`, `output`, `body` inside session diagnostics | dropped from object |
| **Session role/model metadata** | fields `role`, `model`, `provider`, `name`, `id`, timestamps | preserved iff `includeSessionContent === true`; otherwise dropped |
| **Stack traces** | any string containing 3+ lines of `^\s*at .+:\d+:\d+` | preserved as-is, but the embedded-secret rule above still applies inside each line (so a token mentioned in a stack trace gets redacted) |

> **Why embedded match, not whole-string:** stack traces, log lines, and error messages frequently include a token in the middle of a longer string (e.g., `"Authorization: Bearer ghp_..."` or `"error from API: sk-... was rejected"`). A whole-string anchor (`^…$`) misses these. Each pattern is global (`/g`) and word-bounded so the matched run is replaced wherever it appears, and a single value can carry multiple matches.

The pipeline lives in `src/main/diagnostics/redaction.ts` with one entry point `redactValue<T>(value: T, opts: RedactionOptions): T` that recursively walks objects/arrays. It has its own unit-test file with a fixture-driven test suite (§ 7.1) including dedicated cases for embedded secrets and multi-match strings.

---

## 6. IPC contract changes

### 6.1 New channels

Channel string literals MUST be added to `packages/contracts/src/channels/<domain>.channels.ts` (the single source of truth) and merged into `IPC_CHANNELS` via `packages/contracts/src/channels/index.ts`. After editing, run `npm run generate:ipc` and `npm run verify:ipc`. Adding constants to `src/shared/types/ipc.types.ts` is wrong — that file is now a deprecated re-export shim.

Wave 6 adds (or extends) `packages/contracts/src/channels/diagnostics.channels.ts` (NEW file; register it in `channels/index.ts`):

| Channel | Direction | Payload | Response |
|---|---|---|---|
| `DIAGNOSTICS_GET_DOCTOR_REPORT` | renderer → main | `{ workingDirectory?: string; force?: boolean }` | `DoctorReport` |
| `DIAGNOSTICS_GET_SKILL_DIAGNOSTICS` | renderer → main | `{}` | `SkillDiagnostic[]` |
| `DIAGNOSTICS_GET_INSTRUCTION_DIAGNOSTICS` | renderer → main | `{ workingDirectory?: string }` | `InstructionDiagnostic[]` |
| `DIAGNOSTICS_EXPORT_ARTIFACT_BUNDLE` | renderer → main | `OperatorArtifactExportRequest` | `OperatorArtifactExportResult` |
| `DIAGNOSTICS_REVEAL_BUNDLE` | renderer → main | `{ bundlePath: string }` | `{ ok: true }` |
| `CLI_UPDATE_PILL_GET_STATE` | renderer → main | `{}` | `CliUpdatePillState` |
| `CLI_UPDATE_PILL_REFRESH` | renderer → main | `{}` | `CliUpdatePillState` |
| `CLI_UPDATE_PILL_DELTA` | main → renderer (event) | `CliUpdatePillState` | — |

### 6.2 Schema location

Payload schemas are local to `src/main/ipc/handlers/diagnostics-handlers.ts`. The repo no longer has `src/shared/validation/ipc-schemas.ts`; Wave 6 intentionally avoids adding a new `@contracts/schemas/*` subpath per locked decision #12.

### 6.3 Preload exposure

`src/preload/preload.ts` exposes its API on `window.electronAPI` (see `src/preload/preload.ts` line ~75: `contextBridge.exposeInMainWorld('electronAPI', electronAPI)`). The renderer accesses it via the existing typed `IpcService` shim that wraps `window.electronAPI`. There is no `window.api` global in this app — references in early drafts to `window.api` are corrections to `window.electronAPI`.

A new domain-style chunk lives at `src/preload/domains/diagnostics.preload.ts` and is composed into the main `electronAPI` object:

```ts
window.electronAPI.diagnosticsGetDoctorReport(payload)
window.electronAPI.diagnosticsGetSkillDiagnostics()
window.electronAPI.diagnosticsGetInstructionDiagnostics(payload)
window.electronAPI.diagnosticsExportArtifactBundle(payload)
window.electronAPI.diagnosticsRevealBundle(payload)

window.electronAPI.cliUpdatePillGetState()
window.electronAPI.cliUpdatePillRefresh()
window.electronAPI.onCliUpdatePillDelta(listener)
```

These follow the existing `domains/*.preload.ts` pattern. The renderer typically goes through `IpcService` rather than touching `window.electronAPI` directly.

---

## 7. Testing strategy

### 7.1 New unit specs (TDD)

| File | Coverage |
|---|---|
| `src/main/diagnostics/__tests__/redaction.spec.ts` | Each rule in § 5 with positive and negative fixtures; nested objects/arrays; circular reference safety. |
| `src/main/diagnostics/__tests__/skill-diagnostics-service.spec.ts` | Invalid frontmatter; missing-asset emits with the offending file path; duplicate-skill-id; duplicate-trigger; happy path returns `[]`. |
| `src/main/diagnostics/__tests__/instruction-diagnostics-service.spec.ts` | Each warning in `instruction-resolver.buildWarnings` mapped to a typed code; `broad-root-scan` triggers above threshold and skips below; `unreadable-source` from a deliberately bad path. |
| `src/main/diagnostics/__tests__/doctor-service.spec.ts` | Composes upstream services (each mocked to return canned data); section summaries computed deterministically; `resolveSectionForStartupCheck` table; reuses cached report when `force: false`. |
| `src/main/diagnostics/__tests__/operator-artifact-exporter.spec.ts` | Bundle layout matches manifest; non-manifest sha256s match the unzipped file content (recompute and compare); manifest's own entry uses the `'self-described'` sentinel (not a hex hash) — see § 6 self-hash note; redaction applied to every JSON file (assert e.g. that an env-var placeholder appears, that a session message body does NOT appear, that an embedded secret in a stack-trace string is replaced with `<redacted-secret>`); `lifecycle-tail.ndjson` truncated to ≤ 500 lines; `selectedSessionId` only present when caller opted in; `workingDirectory` propagated to `DoctorService.getReport` when supplied. |
| `src/main/cli/__tests__/cli-update-poll-service.spec.ts` | `refresh()` is debounced when called concurrently; 24-h interval scheduled by `start()`; `onChange` fires once per state change; `stop()` clears the interval. |
| `src/main/ipc/handlers/__tests__/diagnostics-handlers.spec.ts` | Each new IPC channel rejects unknown payloads (Zod), returns the typed result on the happy path, and surfaces sane errors. |
| `src/renderer/app/core/state/__tests__/doctor.store.spec.ts` | `loadReport` populates report + sections; `setActiveSection` updates signal; error path surfaces a renderer-side error string. |
| `src/renderer/app/core/state/__tests__/cli-update-pill.store.spec.ts` | Initial load via IPC; `onDelta` updates signal; `refresh()` round-trips. |
| `src/renderer/app/features/settings/__tests__/doctor-settings-tab.component.spec.ts` | Renders section summaries; switching sections updates the route param mock; "Pending Wave 1 implementation" copy appears when flag is false. |
| `src/renderer/app/features/title-bar/__tests__/cli-update-pill.component.spec.ts` | Hidden when count=0; tooltip lists CLIs; click navigates. |

### 7.2 Tests to update

- `src/renderer/app/__tests__/app.component.spec.ts` (or equivalent): banner click handler navigates to `/settings?tab=doctor&section=...`.
- `src/renderer/app/features/settings/__tests__/settings.component.spec.ts`: query-param-driven tab + section selection.

### 7.3 Manual verification (UI)

- Force a degraded startup (e.g. uninstall codex CLI before launch) → banner appears → click → Doctor tab opens at `provider-health` section.
- Install a CLI update plan that has a newer npm version → restart → update pill shows "1 update" → click → CLI Health tab opens.
- Drop a malformed `SKILL.md` into a builtin skill directory → reload → Doctor "Commands & Skills" section lists `invalid-frontmatter`.
- Run an export bundle → open the resulting zip → verify `manifest.json` lists every file with a hex sha256 (and `'self-described'` for its own entry), that `lifecycle-tail.ndjson` is ≤ 500 lines, that no env-var values appear, and that an injected stack-trace fragment containing a token has the token replaced with `<redacted-secret>`.

---

## 8. File-by-file change inventory

### Created (main)

| Path | Purpose |
|---|---|
| `src/main/diagnostics/doctor-service.ts` | `DoctorService` singleton |
| `src/main/diagnostics/skill-diagnostics-service.ts` | Skill diagnostic computation |
| `src/main/diagnostics/instruction-diagnostics-service.ts` | Instruction diagnostic computation |
| `src/main/diagnostics/operator-artifact-exporter.ts` | Bundle assembly + zip writer |
| `src/main/diagnostics/redaction.ts` | Redaction pipeline |
| `src/main/diagnostics/__tests__/*.spec.ts` | One spec per service |
| `src/main/cli/cli-update-poll-service.ts` | Cached pill state + 24-h tick |
| `src/main/cli/__tests__/cli-update-poll-service.spec.ts` | Tests |
| `src/main/ipc/handlers/diagnostics-handlers.ts` | IPC handlers for the channels in § 6.1 |
| `src/main/ipc/handlers/__tests__/diagnostics-handlers.spec.ts` | Tests |

### Created (renderer / shared)

| Path | Purpose |
|---|---|
| `src/shared/types/diagnostics.types.ts` | All new diagnostic types |
| `src/preload/domains/diagnostics.preload.ts` | Diagnostics preload bridge |
| `src/renderer/app/core/state/doctor.store.ts` | Doctor signal-based store |
| `src/renderer/app/core/state/cli-update-pill.store.ts` | Update pill signal-based store |
| `src/renderer/app/features/settings/doctor-settings-tab.component.ts` (+ html, spec) | Doctor tab body |
| `src/renderer/app/features/settings/components/doctor-section.component.ts` | Single-section presentational shell |
| `src/renderer/app/features/title-bar/cli-update-pill.component.ts` (+ spec) | Title-bar pill |
| `src/renderer/app/core/state/__tests__/*.spec.ts` | Store tests |

### Modified

| Path | Change |
|---|---|
| `src/main/bootstrap/index.ts` (or wherever singletons initialize) | Initialize `CliUpdatePollService.start()`, register the new IPC handlers |
| `src/main/skills/skill-registry.ts` | Add `listSkills(): SkillBundle[]` accessor (read-only view) |
| `src/main/commands/markdown-command-registry.ts` | When the Wave 1 feature ships, this file already exposes diagnostics; Wave 6 leaves it untouched and only consumes via `CommandManager.getAllCommandsSnapshot` |
| `src/preload/preload.ts` | Wire `domains/diagnostics.preload.ts` and the cli-update-pill bridge |
| `src/main/ipc/handlers/diagnostics-handlers.ts` | Add local Zod schemas for the channels in § 6.1 |
| `src/renderer/app/app.component.html` | Banner becomes `<button>`, mount `<app-cli-update-pill />` |
| `src/renderer/app/app.component.ts` | `openDoctorForBanner()`, `pickHighestSeverityFailingCheck`, `doctorSectionForCheck` lookup |
| `src/renderer/app/features/settings/settings.component.ts` | Add `'doctor'` tab; honour `tab` + `section` query params |
| `src/renderer/app/core/state/settings.store.ts` | Add `commandDiagnosticsAvailable` to the `featureFlags` whitelist; add `broadRootFileThreshold` setting (default 100) |

### Removed

None. Wave 6 is purely additive.

---

## 9. Acceptance criteria

The wave is shippable when **all** of the following hold:

1. `npx tsc --noEmit` passes.
2. `npx tsc --noEmit -p tsconfig.spec.json` passes.
3. `npm run lint` passes with no new warnings.
4. New unit specs (§ 7.1) pass; existing settings/banner specs still pass.
5. Degraded startup banner is clickable and navigates to `/settings?tab=doctor&section=<correct-section>`.
6. Doctor tab renders a sidebar of section summaries with severity badges; switching sections is reflected in the URL.
7. Update pill appears when at least one CLI has an available update plan; click opens CLI Health tab.
8. Skill diagnostics surface invalid frontmatter, missing assets, and duplicate triggers.
9. Instruction diagnostics surface orchestrator/agents/Copilot conflicts and broad-root scan warnings.
10. Command diagnostics section shows a clear "Pending Wave 1" placeholder when the flag is false; renders Wave 1 diagnostics when true.
11. Operator artifact export produces a valid zip with a manifest; the recorded sha256 of every non-manifest file matches the unzipped content; the manifest's own entry uses the documented `'self-described'` sentinel (see § 6 self-hash note); redaction is applied (env-var values absent; embedded secrets in stack traces and log lines replaced with `<redacted-secret>`; paths home-relative); and "Show in Finder/Explorer" reveals the file.
12. The packaged DMG starts (smoke run) — confirms no runtime alias regressions even though Wave 6 adds no new alias.

---

## 10. Non-goals

- No new probe semantics; every check reuses an existing service.
- No automatic upload of operator artifacts.
- No new `@contracts/schemas/*` subpath.
- No CLI auto-update execution from the pill (the existing CLI Health tab handles that).
- No multi-language localization of Doctor copy (English only for Wave 6).
- No Doctor route at `/doctor` — Doctor is a settings tab (locked decision #1).

---

## 11. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Wave 1 dependency for command diagnostics blocks Wave 6 | Med | Med | Feature flag `commandDiagnosticsAvailable` defaults to `false`; section renders a placeholder. Wave 6 ships without Wave 1. |
| Secret leak in operator artifact (env-var or token) | Low | High | Centralized `redaction.ts` pipeline with explicit unit-test fixtures for each rule. Manifest records redaction policy applied. Plan task 5.x has a manual review step before any external sharing. |
| Path privacy leak (absolute home paths in artifact) | Med | Med | Home-relativization rule in § 5 + unit tests asserting no `^/Users/`/`^/home/` substrings appear. |
| Banner deep-link picks the wrong section when multiple checks fail | Med | Low | Severity ranking `unavailable > degraded > disabled > ready`; ties broken by the order the checks were emitted (deterministic per `CapabilityProbe.run`). Tests pin the order. |
| Update pill polling cost (every 24 h × N CLIs) | Low | Low | Cached state in main; `start()` is idempotent; manual refresh is debounced. |
| Settings tab signal model breaks when adding a new tab | Low | Med | Add `'doctor'` to the existing `SETTINGS_TABS` constant only — no other change to the tab-selection signal mechanism. Existing tests still cover navigation behavior. |
| Zip writer correctness without `archiver` dep | Med | Low | If `archiver` is already present in `package.json`, use it. Otherwise stored-zip writer with one happy-path test plus a real-world unzip in CI smoke. Plan task 5.x preflights this. |
| `countRepoFiles` walks a giant repo | Low | Low | Early-termination at threshold + 1; respect `.gitignore`-style heuristics by skipping common bulky dirs (`node_modules`, `.git`, `dist`, `build`). |
| Doctor report composition timeout (slow upstream service) | Med | Low | Each upstream call is `Promise.allSettled`'d and the section degrades to "could not load" rather than blocking the whole report. Section summary records `severity: 'warning'` with the failure message. |
| Operator opens artifact reveal handler on a packaged build that lacks the IPC handler | Low | Low | Plan task includes registering the handler in `bootstrap/index.ts` and the spec lists it under "Modified". |

---

## 12. Follow-ups for downstream waves

- **After Wave 1 lands**: flip `commandDiagnosticsAvailable` to `true` in `AppSettings` defaults; remove the placeholder copy from the Commands & Skills section.
- **Wave 7 integration**: Doctor section summaries can become the authoritative input for a future "health badge" in the dashboard sidebar.
- **Wave 4 clipboard service**: when it lands, the artifact-reveal toast can use the shared notification surface instead of an inline banner.
- **Future telemetry opt-in**: nothing in Wave 6 leaves the device. A later wave could add an opt-in upload-to-issue-tracker flow that reuses the bundle as-is.

---

## Appendix A — Cross-link with parent design

This child design implements the following items from the parent design's **Track D — Operator Reliability And Local Tooling** section:

- "Doctor entrypoint from startup banner and command palette." (banner part — palette part rolls in via Wave 1's `/help` browser, no extra work in Wave 6) → § 3.1, § 3.2
- "CLI update pill in the title bar or settings nav when update plans exist for installed CLIs." → § 3.3
- "Config/command/skill diagnostics report that validates markdown command frontmatter, skill frontmatter/assets, instruction stack conflicts, and alias collisions." → § 1.2, § 1.3, § 4
- "Local operator artifact: a JSONL or bundle export containing startup report, provider doctor results, command diagnostics, recent lifecycle trace, and selected session diagnostics." → § 1.4, § 2.4, § 5

It does **not** implement (still parent-Track D, deferred to Wave 4):

- Shared renderer clipboard service.
- Live system theme listener.
- Terminal drawer.
- Shared link detection utility.

## Appendix B — Cross-link with parent plan

This child design provides the architectural detail for **Wave 6** of the parent plan. Each task in the parent plan's Wave 6 section maps to:

| Parent plan task | This spec § |
|---|---|
| Add a Doctor route or overlay that combines startup capability report, provider doctor results, CLI Health, and browser automation health | § 1.1, § 2.1, § 3.2 (resolved as a settings tab per locked decision #1) |
| Deep-link degraded startup banner checks to the exact Doctor section | § 3.1 |
| Add a CLI update pill when installed CLIs have supported update plans | § 1.5, § 2.5, § 3.3 |
| Add command diagnostics: invalid frontmatter, alias collision, missing usage, duplicate names | § 4 (consumed from Wave 1) |
| Add skill diagnostics: invalid frontmatter, missing assets/references/scripts, unreadable files | § 1.2, § 2.2 |
| Add instruction diagnostics: conflicting project AGENTS/orchestrator/Copilot instructions and broad-root scan warnings | § 1.3, § 2.3 |
| Add a local operator artifact export with startup checks, provider diagnoses, command/skill diagnostics, lifecycle trace excerpt, and selected session diagnostics | § 1.4, § 2.4, § 5 |
| Provider scaffold checklist / docs inventory | Out of scope; parent plan flagged as conditional |
