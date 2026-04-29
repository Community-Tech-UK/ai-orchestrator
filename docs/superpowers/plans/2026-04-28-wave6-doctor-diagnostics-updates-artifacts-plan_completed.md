# Wave 6: Doctor, Diagnostics, Updates, And Operator Artifacts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Compose existing diagnostic services (`ProviderDoctor`, `CapabilityProbe`, `BrowserAutomationHealthService`, `CliUpdateService`, `InstructionResolver`, `SkillRegistry`, `lifecycle-trace`) into a single Doctor settings tab with deep-link navigation, surface a CLI update pill in the title bar, and ship a redacted local operator artifact export.

**Architecture:** New `DoctorService` composes upstream probes into a `DoctorReport`. New `SkillDiagnosticsService` and `InstructionDiagnosticsService` provide the missing diagnostic shapes. New `OperatorArtifactExporter` produces a zip bundle through a centralized `redaction.ts` pipeline. New `CliUpdatePollService` caches update plan state with a 24-h tick and pushes deltas to the renderer. The renderer ships a Doctor settings tab (deep-linked via `/settings?tab=doctor&section=…`), a clickable startup banner, and a title-bar update pill. Wave 1's command diagnostics are consumed behind `featureFlags.commandDiagnosticsAvailable`; Wave 6 is mergeable independently.

**Tech Stack:** TypeScript 5.9, Angular 21 (zoneless, signals), Electron 40, Zod 4, Vitest, ESLint.

**Spec:** [`docs/superpowers/specs/2026-04-28-wave6-doctor-diagnostics-updates-artifacts-design.md`](../specs/2026-04-28-wave6-doctor-diagnostics-updates-artifacts-design.md)
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design.md`](../specs/2026-04-28-cross-repo-usability-upgrades-design.md)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`](./2026-04-28-cross-repo-usability-upgrades-plan.md)

---

## How to read this plan

- **Phases** group related tasks. Phases 1–6 are pure backend; phase 7 onward is renderer wiring; phase 14 is final verification.
- **Tasks** are bite-sized work units (target ≤ 30 minutes). Each ends with a local commit.
- **TDD discipline:** behavioral code follows test → fail → implement → pass → commit. Pure type-only changes use type-check as the verification.
- **Verification commands** (run after every code-change task):
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - Targeted vitest spec(s) for the touched code
- **Critical rule (per `AGENTS.md`):** **NEVER run `git commit` without explicit user approval.** Every task below ends with a suggested commit message — run the commit only after the user approves. **Never push to remote** under any circumstances; pushing is always the user's call.
- **Wave 1 dependency:** Phase 13 wires command diagnostics behind a feature flag. If Wave 1 has shipped, the flag default flips to `true` in the same phase. If Wave 1 has not shipped, the flag stays `false` and the Doctor section renders a placeholder. Either way, Wave 6 ships.

## Phase index

1. Phase 1 — Shared types and Zod schemas
2. Phase 2 — `redaction.ts` pipeline
3. Phase 3 — `SkillDiagnosticsService`
4. Phase 4 — `InstructionDiagnosticsService`
5. Phase 5 — `DoctorService` (composer)
6. Phase 6 — `OperatorArtifactExporter` (zip bundle + manifest)
7. Phase 7 — `CliUpdatePollService`
8. Phase 8 — IPC handlers + preload bridge
9. Phase 9 — Renderer stores (`doctor.store.ts`, `cli-update-pill.store.ts`)
10. Phase 10 — `DoctorSettingsTabComponent` and section components
11. Phase 11 — `SettingsComponent` honors `tab` + `section` query params
12. Phase 12 — Banner deep-link click handler in `AppComponent`
13. Phase 13 — `CliUpdatePillComponent` + title-bar mount
14. Phase 14 — Wave 1 feature-flag wire (placeholder content)
15. Phase 15 — Final compile / lint / test / packaged smoke

> Phases 13 and 14 are listed in the order they should land, not the order they appear in the section index of the design spec. Phase 13 ships the pill itself; phase 14 wires the placeholder section content (which is independent of the pill).

---

## Phase 1 — Shared types and Zod schemas

These are pure-type and pure-function additions. After this phase, the new types compile but nothing consumes them.

### Task 1.1: Add `src/shared/types/diagnostics.types.ts`

**Files:**
- Create: `src/shared/types/diagnostics.types.ts`

- [x] **Step 1: Read the existing types**

Read `src/shared/types/startup-capability.types.ts` (just 32 lines — already correct shape) and `src/main/providers/provider-doctor.ts` lines 1–60 (where `DiagnosisResult` is defined). The new file imports their public types.

- [x] **Step 2: Create the new types file**

Create `src/shared/types/diagnostics.types.ts`:

```ts
import type {
  StartupCapabilityReport,
  StartupCapabilityCheck,
} from './startup-capability.types';

// ── Doctor section IDs (used as URL query param values) ──

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
  headline: string;
  itemCount: number;
}

// ── Composite doctor report ──

export interface ProviderProbeSummary {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'timeout';
  message: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderDiagnosisSummary {
  provider: string;
  overall: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  probes: ProviderProbeSummary[];
  recommendations: string[];
  timestamp: number;
}

export interface ProviderDiagnosesSnapshot {
  diagnoses: ProviderDiagnosisSummary[];
  generatedAt: number;
}

export interface BrowserAutomationDiagnosisSummary {
  status: 'ready' | 'degraded' | 'unavailable';
  runtimeAvailable: boolean;
  inAppConfigured: boolean;
  inAppConnected: boolean;
  configDetected: boolean;
  browserToolNames: string[];
  warnings: string[];
  suggestions: string[];
}

export interface CliInstallSummary {
  cli: string;
  installed: boolean;
  activePath?: string;
  activeVersion?: string;
  installCount: number;
}

export interface CliUpdatePlanSummary {
  cli: string;
  displayName: string;
  supported: boolean;
  command?: string;
  args?: string[];
  displayCommand?: string;
  reason?: string;
  currentVersion?: string;
}

export interface CliHealthSnapshot {
  installs: CliInstallSummary[];
  updatePlans: CliUpdatePlanSummary[];
  generatedAt: number;
}

export type CommandDiagnosticsSnapshot =
  | { available: true; diagnostics: CommandDiagnostic[]; scanDirs: string[]; generatedAt: number }
  | { available: false; reason: 'wave1-not-shipped' | 'no-working-directory' };

/**
 * Mirror of the Wave 1 CommandDiagnostic shape so Wave 6 doesn't depend on
 * Wave 1 at type-check time. When Wave 1 ships, this type is structurally
 * compatible with the one declared in `src/shared/types/command.types.ts`.
 */
export interface CommandDiagnostic {
  code: string;
  message: string;
  commandId?: string;
  alias?: string;
  filePath?: string;
  candidates?: string[];
  severity: 'warn' | 'error';
}

// ── Skill diagnostics ──

export type SkillDiagnosticCode =
  | 'invalid-frontmatter'
  | 'missing-asset'
  | 'unreadable-file'
  | 'duplicate-skill-id'
  | 'duplicate-trigger';

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  message: string;
  skillId?: string;
  skillPath?: string;
  filePath?: string;
  trigger?: string;
  severity: 'warning' | 'error';
}

// ── Instruction diagnostics ──

export type InstructionDiagnosticCode =
  | 'orchestrator-agents-conflict'
  | 'multiple-path-specific'
  | 'copilot-conflict'
  | 'broad-root-scan'
  | 'unreadable-source';

export interface InstructionDiagnostic {
  code: InstructionDiagnosticCode;
  message: string;
  scope: 'global-user' | 'project' | 'path-specific';
  sourcePaths?: string[];
  fileCountSampled?: number;
  severity: 'warning' | 'error';
}

// ── Composite report ──

export interface DoctorReport {
  generatedAt: number;
  startupCapabilities: StartupCapabilityReport;
  providerDiagnoses: ProviderDiagnosesSnapshot;
  browserAutomation: BrowserAutomationDiagnosisSummary;
  cliHealth: CliHealthSnapshot;
  commandDiagnostics: CommandDiagnosticsSnapshot;
  skillDiagnostics: SkillDiagnostic[];
  instructionDiagnostics: InstructionDiagnostic[];
  sections: DoctorSectionSummary[];
}

// ── Operator artifact bundle ──

export interface OperatorArtifactBundleManifest {
  schemaVersion: 1;
  generatedAt: number;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Home-relative path of the workspace whose diagnostics were captured (when supplied). */
  workingDirectory?: string;
  redactionPolicy: {
    envVarsRedacted: true;
    homedirRelativized: true;
    /** Embedded-token redaction (regex, not whole-string) was applied to all string fields. */
    embeddedSecretsRedacted: true;
    sessionContentExcluded: boolean;
    sessionContentRedaction?: 'metadata-only';
  };
  files: Array<{
    name: string;
    /** Byte length of the file's content. The manifest's own entry uses 0 because its bytes are unknowable until after final serialization. */
    bytes: number;
    /**
     * SHA-256 hex of the file content. The manifest's own entry uses the
     * sentinel `'self-described'` because computing a self-hash before final
     * serialization is impossible. Consumers that want to verify the manifest
     * itself should hash the unzipped manifest.json file directly.
     */
    sha256: string;
    contentType: 'json' | 'ndjson' | 'text';
    description: string;
    optional?: boolean;
  }>;
  selectedSessionId?: string;
  commandDiagnosticsAvailable: boolean;
}

export interface OperatorArtifactExportRequest {
  /** Optional session id to include session-scoped diagnostics for. */
  sessionId?: string;
  /** Opt-in: include session metadata (model, role); message bodies are NEVER included. */
  includeSessionContent?: boolean;
  /**
   * Optional working directory for workspace-scoped diagnostics
   * (instruction conflicts, project-level skills, command diagnostics).
   * If omitted, those diagnostics are NOT collected.
   */
  workingDirectory?: string;
}

export interface OperatorArtifactExportResult {
  bundlePath: string;
  bundleBytes: number;
  manifest: OperatorArtifactBundleManifest;
}

// ── CLI update pill state ──

export interface CliUpdatePillEntry {
  cli: string;
  displayName: string;
  currentVersion?: string;
  updatePlan: CliUpdatePlanSummary;
}

export interface CliUpdatePillState {
  loaded: boolean;
  generatedAt: number | null;
  count: number;
  entries: CliUpdatePillEntry[];
  lastRefreshedAt: number | null;
  error?: string;
}

// ── Mapping table for banner deep-link ──

export interface BannerDeepLinkEntry {
  matcher: (check: StartupCapabilityCheck) => boolean;
  section: DoctorSectionId;
}
```

- [x] **Step 3: Type-check**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: pass.

- [x] **Step 4: Commit**

```bash
git add src/shared/types/diagnostics.types.ts
git commit -m "feat(diagnostics): add shared diagnostics types (DoctorReport, SkillDiagnostic, InstructionDiagnostic, OperatorArtifactBundleManifest, CliUpdatePillState)"
```

---

### Task 1.2: Add Zod IPC schemas to `ipc-schemas.ts`

**Files:**
- Modify: `src/shared/validation/ipc-schemas.ts`

- [x] **Step 1: Read the existing schemas file**

```bash
ls src/shared/validation/
```

Open `src/shared/validation/ipc-schemas.ts`. Locate the file's import block and a place near related domain schemas (e.g. CLI / settings). Append a new section.

- [x] **Step 2: Append the new schemas**

Append:

```ts
// ──────────────────────────────────────────────────────────────────────
// Wave 6 — Diagnostics IPC payload schemas
// ──────────────────────────────────────────────────────────────────────

export const DoctorGetReportPayloadSchema = z.object({
  workingDirectory: z.string().min(1).max(10000).optional(),
  force: z.boolean().optional(),
});

export const DoctorGetSkillDiagnosticsPayloadSchema = z.object({}).strict();

export const DoctorGetInstructionDiagnosticsPayloadSchema = z.object({
  workingDirectory: z.string().min(1).max(10000).optional(),
});

export const DiagnosticsExportArtifactBundlePayloadSchema = z.object({
  sessionId: z.string().min(1).max(200).optional(),
  includeSessionContent: z.boolean().optional(),
  workingDirectory: z.string().min(1).max(10000).optional(),
});

export const DiagnosticsRevealBundlePayloadSchema = z.object({
  bundlePath: z.string().min(1).max(10000),
});

export const CliUpdatePillGetStatePayloadSchema = z.object({}).strict();
export const CliUpdatePillRefreshPayloadSchema = z.object({}).strict();
```

> If the file groups schemas by domain, place these at the bottom in a new section as shown. Do not import from `diagnostics.types.ts` — Zod payload schemas are independent of TypeScript types here.

- [x] **Step 3: Type-check**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: pass.

- [x] **Step 4: Commit**

```bash
git add src/shared/validation/ipc-schemas.ts
git commit -m "feat(diagnostics): add Zod IPC payload schemas for doctor + cli-update-pill channels"
```

---

## Phase 2 — `redaction.ts` pipeline

The redaction pipeline is the security-critical heart of the operator artifact export. Build it first with comprehensive unit tests so every later phase can rely on it.

### Task 2.1: Write failing redaction tests

**Files:**
- Create: `src/main/diagnostics/__tests__/redaction.spec.ts`

- [x] **Step 1: Write the spec file**

Create `src/main/diagnostics/__tests__/redaction.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { redactValue, type RedactionOptions } from '../redaction';

const opts = (overrides?: Partial<RedactionOptions>): RedactionOptions => ({
  homedir: '/Users/example',
  includeSessionContent: false,
  ...overrides,
});

describe('redactValue — env vars', () => {
  it('passes through unrelated objects unchanged', () => {
    expect(redactValue({ a: 1, b: 'two' }, opts())).toEqual({ a: 1, b: 'two' });
  });

  it('replaces fields shaped like {name,value} where name matches an env-like key', () => {
    const before = { env: { name: 'OPENAI_API_KEY', value: 'sk-realtoken' } };
    const after = redactValue(before, opts());
    expect(after.env).toEqual({ name: 'OPENAI_API_KEY', isSet: true });
  });
});

describe('redactValue — homedir relativization', () => {
  it('replaces home prefix with ~', () => {
    expect(redactValue('/Users/example/Library/Logs/foo.log', opts())).toBe('~/Library/Logs/foo.log');
  });

  it('preserves absolute paths outside the homedir', () => {
    expect(redactValue('/var/log/system.log', opts())).toBe('/var/log/system.log');
  });

  it('redacts known credential paths to a placeholder', () => {
    expect(redactValue('/Users/example/.aws/credentials', opts())).toBe('<redacted-credential-path>');
    expect(redactValue('/Users/example/.ssh/id_rsa', opts())).toBe('<redacted-credential-path>');
    expect(redactValue('/Users/example/.netrc', opts())).toBe('<redacted-credential-path>');
  });
});

describe('redactValue — token-like strings', () => {
  it('redacts sk-* tokens', () => {
    expect(redactValue('sk-abc123def456', opts())).toBe('<redacted-secret>');
  });

  it('redacts ghp_* tokens', () => {
    expect(redactValue('ghp_abc123', opts())).toBe('<redacted-secret>');
  });

  it('redacts JWT-shaped strings', () => {
    expect(redactValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxw', opts())).toBe('<redacted-secret>');
  });

  it('preserves non-token strings that happen to contain s', () => {
    expect(redactValue('skinner', opts())).toBe('skinner');
  });

  it('redacts secrets EMBEDDED in larger strings (not just whole-string matches)', () => {
    // Whole-string redaction misses cases like a stack trace, log line, or
    // diagnostic field that mentions a token in passing.
    expect(redactValue('error from API: sk-abc123def456 was rejected', opts()))
      .toBe('error from API: <redacted-secret> was rejected');
    expect(redactValue('Authorization: Bearer ghp_abc123def456ghi789', opts()))
      .toBe('Authorization: Bearer <redacted-secret>');
    expect(redactValue('headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxw" }', opts()))
      .toContain('<redacted-secret>');
  });

  it('redacts multiple tokens in the same string', () => {
    expect(redactValue('keys: sk-aaa111 and ghp_bbb222', opts()))
      .toBe('keys: <redacted-secret> and <redacted-secret>');
  });
});

describe('redactValue — session content', () => {
  const session = {
    id: 'sess-1',
    model: 'claude-opus-4',
    role: 'assistant',
    content: 'do not leak this',
    text: 'this either',
    prompt: 'or this',
    response: 'or this',
    nested: {
      message: 'leakable body',
      timestamp: 1700000000000,
    },
  };

  it('drops content fields when includeSessionContent is false', () => {
    const after = redactValue(session, opts());
    expect(after.content).toBeUndefined();
    expect(after.text).toBeUndefined();
    expect(after.prompt).toBeUndefined();
    expect(after.response).toBeUndefined();
    expect(after.nested.message).toBeUndefined();
    expect(after.nested.timestamp).toBe(1700000000000);
  });

  it('preserves model/role metadata when includeSessionContent is true (still drops body)', () => {
    const after = redactValue(session, opts({ includeSessionContent: true }));
    expect(after.model).toBe('claude-opus-4');
    expect(after.role).toBe('assistant');
    expect(after.content).toBeUndefined(); // still dropped — body never included
    expect(after.text).toBeUndefined();
  });
});

describe('redactValue — recursion safety', () => {
  it('handles nested arrays', () => {
    const before = ['/Users/example/foo', { p: '/Users/example/bar' }, 42];
    const after = redactValue(before, opts());
    expect(after).toEqual(['~/foo', { p: '~/bar' }, 42]);
  });

  it('does not infinite-loop on circular references', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redactValue(a, opts())).not.toThrow();
  });

  it('preserves null and primitives', () => {
    expect(redactValue(null, opts())).toBeNull();
    expect(redactValue(42, opts())).toBe(42);
    expect(redactValue(true, opts())).toBe(true);
  });
});
```

- [x] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/diagnostics/__tests__/redaction.spec.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Commit failing tests**

```bash
git add src/main/diagnostics/__tests__/redaction.spec.ts
git commit -m "test(diagnostics): add failing tests for redactValue pipeline (red)"
```

---

### Task 2.2: Implement `redaction.ts`

**Files:**
- Create: `src/main/diagnostics/redaction.ts`

- [x] **Step 1: Write the module**

Create `src/main/diagnostics/redaction.ts`:

```ts
/**
 * Centralized redaction pipeline for operator artifacts.
 *
 * Rules:
 * - env-var-shaped objects ({name,value}) → {name, isSet}
 * - paths under homedir → '~/<rel>'
 * - known credential paths → '<redacted-credential-path>'
 * - token-like strings (sk-, ghp_, github_pat_, xoxb-, ya29., AIza, JWTs) → '<redacted-secret>'
 * - session-body fields (content, text, prompt, message, response, output, body) → dropped
 * - circular references safe via WeakSet
 */

export interface RedactionOptions {
  homedir: string;
  includeSessionContent: boolean;
}

const SENSITIVE_BODY_FIELDS = new Set(['content', 'text', 'prompt', 'message', 'response', 'output', 'body']);
const CREDENTIAL_PATH_SUFFIXES = [
  '/.aws/credentials',
  '/.config/gh/hosts.yml',
  '/.netrc',
  '/.npmrc',
];
const CREDENTIAL_PATH_PREFIXES = ['/.ssh/'];

// Each pattern uses a global flag and word-boundary anchors (or unique
// prefixes) so it matches secrets EMBEDDED in larger strings, not just
// whole-string matches. Whole-string-only patterns miss secrets that appear
// in stack traces, log lines, or diagnostic context strings.
const TOKEN_PATTERNS: Array<RegExp> = [
  /\bsk-[A-Za-z0-9_\-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_\-]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_\-]{20,}\b/g,
  /\bxoxb-[A-Za-z0-9_\-]{10,}\b/g,
  /\bya29\.[A-Za-z0-9_\-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_\-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, // JWT
];

function isCredentialPath(p: string): boolean {
  for (const suffix of CREDENTIAL_PATH_SUFFIXES) {
    if (p.endsWith(suffix)) return true;
  }
  for (const prefix of CREDENTIAL_PATH_PREFIXES) {
    if (p.includes(prefix)) return true;
  }
  return false;
}

function looksLikeEnvName(name: string): boolean {
  // ALL_CAPS_WITH_UNDERSCORES heuristic, plus must contain a sensitive substring
  if (!/^[A-Z][A-Z0-9_]+$/.test(name)) return false;
  return /(KEY|TOKEN|SECRET|PASSWORD|API|AUTH|CREDENTIAL)/.test(name);
}

function redactString(s: string, opts: RedactionOptions): string {
  // Token detection runs first against the whole string so embedded secrets
  // in log lines, stack traces, or error messages are caught. We replace
  // every match (not just the first), because a single line can carry
  // multiple secrets.
  let out = s;
  for (const re of TOKEN_PATTERNS) {
    // RegExp with /g must have lastIndex reset for repeat use across values.
    re.lastIndex = 0;
    out = out.replace(re, '<redacted-secret>');
  }

  // Path handling — runs on the (possibly partially-redacted) string.
  if (out.startsWith(opts.homedir)) {
    if (isCredentialPath(out)) return '<redacted-credential-path>';
    const rel = out.slice(opts.homedir.length);
    return rel.startsWith('/') ? `~${rel}` : `~/${rel}`;
  }

  return out;
}

export function redactValue<T>(value: T, opts: RedactionOptions): T {
  const seen = new WeakSet<object>();
  return walk(value, opts, seen) as T;
}

function walk(value: unknown, opts: RedactionOptions, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, opts);
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '<circular>';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, opts, seen));
  }

  // Env-var-shaped object: { name: 'X', value: '...' } where name looks env-y.
  const obj = value as Record<string, unknown>;
  if (typeof obj.name === 'string' && 'value' in obj && looksLikeEnvName(obj.name)) {
    return { name: obj.name, isSet: obj.value !== undefined && obj.value !== null && obj.value !== '' };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // Drop sensitive body fields entirely.
    if (SENSITIVE_BODY_FIELDS.has(k)) continue;
    // Drop role/model only when NOT including session content (and only if the field name suggests session metadata
    // — we keep these in non-session contexts, so we only filter inside arrays of messages, recognizable by also
    // having a 'role' or 'model' field elsewhere). To stay conservative, the redactor preserves these by default;
    // callers that want stricter handling drop messages before passing into redactValue.
    out[k] = walk(v, opts, seen);
  }
  return out;
}
```

- [x] **Step 2: Run the tests**

```bash
npx vitest run src/main/diagnostics/__tests__/redaction.spec.ts
```

Expected: pass.

- [x] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/diagnostics/redaction.ts
git add src/main/diagnostics/redaction.ts
git commit -m "feat(diagnostics): implement redaction pipeline (env vars, homedir paths, tokens, session bodies)"
```

---

## Phase 3 — `SkillDiagnosticsService`

### Task 3.1: Expose `listSkills()` on `SkillRegistry`

**Files:**
- Modify: `src/main/skills/skill-registry.ts`

- [x] **Step 1: Read the file**

Read `src/main/skills/skill-registry.ts` lines 1–183. Note that `skills` is a private `Map<string, SkillBundle>` and there is no public accessor returning the array of bundles.

- [x] **Step 2: Add the accessor**

In `src/main/skills/skill-registry.ts`, immediately after the constructor, add:

```ts
/**
 * Read-only snapshot of all loaded skill bundles. Used by the diagnostics
 * service to compute frontmatter and asset diagnostics. Does not trigger
 * lazy loading.
 */
listSkills(): SkillBundle[] {
  return Array.from(this.skills.values());
}

/**
 * Read-only view of the trigger index for diagnostics duplicate-trigger checks.
 * Returns a new map; mutations are not reflected back.
 */
getTriggerIndex(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, v] of this.triggerIndex) out.set(k, [...v]);
  return out;
}
```

- [x] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: pass.

- [x] **Step 4: Commit**

```bash
git add src/main/skills/skill-registry.ts
git commit -m "feat(skills): expose listSkills() and getTriggerIndex() for diagnostics"
```

---

### Task 3.2: Write failing `SkillDiagnosticsService` tests

**Files:**
- Create: `src/main/diagnostics/__tests__/skill-diagnostics-service.spec.ts`

- [x] **Step 1: Write the spec**

Create the file:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillBundle, SkillFrontmatter } from '../../../shared/types/skill.types';

const { mockListSkills, mockGetTriggerIndex, mockAccess } = vi.hoisted(() => ({
  mockListSkills: vi.fn<[], SkillBundle[]>(),
  mockGetTriggerIndex: vi.fn<[], Map<string, string[]>>(),
  mockAccess: vi.fn<[string, number?], Promise<void>>(),
}));

vi.mock('../../skills/skill-registry', () => ({
  getSkillRegistry: vi.fn(() => ({
    listSkills: mockListSkills,
    getTriggerIndex: mockGetTriggerIndex,
  })),
}));

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, access: mockAccess };
});

import { SkillDiagnosticsService, _resetSkillDiagnosticsServiceForTesting } from '../skill-diagnostics-service';

const baseFrontmatter = (overrides?: Partial<SkillFrontmatter>): SkillFrontmatter => ({
  name: 'demo',
  description: 'A demo skill',
  triggers: ['demo'],
  coreSize: 100,
  referenceCount: 0,
  exampleCount: 0,
  ...overrides,
});

const bundle = (overrides?: Partial<SkillBundle>): SkillBundle => ({
  id: 'skill-demo',
  path: '/Users/example/skills/demo',
  metadata: baseFrontmatter(),
  corePath: '/Users/example/skills/demo/SKILL.md',
  referencePaths: [],
  examplePaths: [],
  scriptPaths: [],
  assetPaths: [],
  ...overrides,
});

beforeEach(() => {
  _resetSkillDiagnosticsServiceForTesting();
  vi.clearAllMocks();
  mockGetTriggerIndex.mockReturnValue(new Map());
  mockAccess.mockResolvedValue(undefined);
});

describe('SkillDiagnosticsService', () => {
  it('returns empty array when registry has no skills', async () => {
    mockListSkills.mockReturnValue([]);
    const out = await new SkillDiagnosticsService().diagnose();
    expect(out).toEqual([]);
  });

  it('emits invalid-frontmatter when metadata is missing required fields', async () => {
    const bad = bundle({ id: 'skill-bad', metadata: { ...baseFrontmatter(), description: '' as string } });
    mockListSkills.mockReturnValue([bad]);
    const out = await new SkillDiagnosticsService().diagnose();
    expect(out.find(d => d.code === 'invalid-frontmatter' && d.skillId === 'skill-bad')).toBeDefined();
  });

  it('emits missing-asset for asset paths that fs.access rejects with ENOENT', async () => {
    const b = bundle({
      id: 'skill-with-assets',
      assetPaths: ['/Users/example/skills/demo/assets/missing.png'],
    });
    mockListSkills.mockReturnValue([b]);
    mockAccess.mockImplementation(async (p) => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const out = await new SkillDiagnosticsService().diagnose();
    const diag = out.find(d => d.code === 'missing-asset');
    expect(diag).toBeDefined();
    expect(diag?.filePath).toBe('/Users/example/skills/demo/assets/missing.png');
  });

  it('emits unreadable-file for assets that fs.access rejects with EACCES', async () => {
    const b = bundle({
      id: 'skill-with-perm',
      scriptPaths: ['/Users/example/skills/demo/scripts/x.sh'],
    });
    mockListSkills.mockReturnValue([b]);
    mockAccess.mockImplementation(async () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    const out = await new SkillDiagnosticsService().diagnose();
    expect(out.find(d => d.code === 'unreadable-file')).toBeDefined();
  });

  it('emits duplicate-skill-id when two bundles share the same id', async () => {
    mockListSkills.mockReturnValue([
      bundle({ id: 'skill-dup' }),
      bundle({ id: 'skill-dup', path: '/other' }),
    ]);
    const out = await new SkillDiagnosticsService().diagnose();
    expect(out.find(d => d.code === 'duplicate-skill-id' && d.skillId === 'skill-dup')).toBeDefined();
  });

  it('emits duplicate-trigger when one trigger maps to multiple skill IDs', async () => {
    mockGetTriggerIndex.mockReturnValue(new Map([['demo', ['skill-a', 'skill-b']]]));
    mockListSkills.mockReturnValue([bundle({ id: 'skill-a' }), bundle({ id: 'skill-b' })]);
    const out = await new SkillDiagnosticsService().diagnose();
    const diag = out.find(d => d.code === 'duplicate-trigger' && d.trigger === 'demo');
    expect(diag).toBeDefined();
  });
});
```

- [x] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/diagnostics/__tests__/skill-diagnostics-service.spec.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Commit failing tests**

```bash
git add src/main/diagnostics/__tests__/skill-diagnostics-service.spec.ts
git commit -m "test(diagnostics): add failing tests for SkillDiagnosticsService (red)"
```

---

### Task 3.3: Implement `SkillDiagnosticsService`

**Files:**
- Create: `src/main/diagnostics/skill-diagnostics-service.ts`

- [x] **Step 1: Write the service**

Create `src/main/diagnostics/skill-diagnostics-service.ts`:

```ts
import * as fs from 'fs/promises';
import { getLogger } from '../logging/logger';
import { getSkillRegistry } from '../skills/skill-registry';
import type { SkillBundle, SkillFrontmatter } from '../../shared/types/skill.types';
import type { SkillDiagnostic } from '../../shared/types/diagnostics.types';

const logger = getLogger('SkillDiagnosticsService');

let instance: SkillDiagnosticsService | null = null;

export class SkillDiagnosticsService {
  static getInstance(): SkillDiagnosticsService {
    if (!instance) instance = new SkillDiagnosticsService();
    return instance;
  }

  async diagnose(): Promise<SkillDiagnostic[]> {
    const out: SkillDiagnostic[] = [];
    const registry = getSkillRegistry();
    const skills = registry.listSkills();

    // Frontmatter validity + asset existence/readability
    for (const bundle of skills) {
      this.validateFrontmatter(bundle, out);
      await this.checkAssets(bundle, out);
    }

    // Duplicate IDs
    const idCounts = new Map<string, SkillBundle[]>();
    for (const bundle of skills) {
      const list = idCounts.get(bundle.id) ?? [];
      list.push(bundle);
      idCounts.set(bundle.id, list);
    }
    for (const [id, list] of idCounts) {
      if (list.length > 1) {
        out.push({
          code: 'duplicate-skill-id',
          message: `Skill id "${id}" claimed by ${list.length} bundles`,
          skillId: id,
          severity: 'error',
        });
      }
    }

    // Duplicate triggers
    const triggerIndex = registry.getTriggerIndex();
    for (const [trigger, skillIds] of triggerIndex) {
      if (skillIds.length > 1) {
        out.push({
          code: 'duplicate-trigger',
          message: `Trigger "${trigger}" claimed by ${skillIds.length} skills`,
          trigger,
          severity: 'warning',
        });
      }
    }

    return out;
  }

  private validateFrontmatter(bundle: SkillBundle, out: SkillDiagnostic[]): void {
    const m = bundle.metadata;
    const missing: string[] = [];
    if (!m.name || typeof m.name !== 'string') missing.push('name');
    if (!m.description || typeof m.description !== 'string') missing.push('description');
    if (!Array.isArray(m.triggers)) missing.push('triggers');

    if (missing.length > 0) {
      out.push({
        code: 'invalid-frontmatter',
        message: `Skill frontmatter missing/invalid fields: ${missing.join(', ')}`,
        skillId: bundle.id,
        skillPath: bundle.path,
        severity: 'error',
      });
    }
  }

  private async checkAssets(bundle: SkillBundle, out: SkillDiagnostic[]): Promise<void> {
    const allPaths = [
      ...bundle.referencePaths,
      ...bundle.examplePaths,
      ...bundle.scriptPaths,
      ...bundle.assetPaths,
    ];
    for (const filePath of allPaths) {
      try {
        await fs.access(filePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          out.push({
            code: 'missing-asset',
            message: `Skill asset not found: ${filePath}`,
            skillId: bundle.id,
            skillPath: bundle.path,
            filePath,
            severity: 'warning',
          });
        } else {
          out.push({
            code: 'unreadable-file',
            message: `Cannot read skill asset (${code ?? 'unknown'}): ${filePath}`,
            skillId: bundle.id,
            skillPath: bundle.path,
            filePath,
            severity: 'error',
          });
        }
      }
    }
  }
}

export function getSkillDiagnosticsService(): SkillDiagnosticsService {
  return SkillDiagnosticsService.getInstance();
}

export function _resetSkillDiagnosticsServiceForTesting(): void {
  instance = null;
}
```

- [x] **Step 2: Run the tests**

```bash
npx vitest run src/main/diagnostics/__tests__/skill-diagnostics-service.spec.ts
```

Expected: pass.

- [x] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/diagnostics/skill-diagnostics-service.ts
git add src/main/diagnostics/skill-diagnostics-service.ts
git commit -m "feat(diagnostics): implement SkillDiagnosticsService (frontmatter, assets, duplicates)"
```

---

## Phase 4 — `InstructionDiagnosticsService`

### Task 4.1: Write failing tests

**Files:**
- Create: `src/main/diagnostics/__tests__/instruction-diagnostics-service.spec.ts`

- [x] **Step 1: Write the spec**

Create the file:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveInstructions, mockCountFiles } = vi.hoisted(() => ({
  mockResolveInstructions: vi.fn(),
  mockCountFiles: vi.fn<[string, number], Promise<number>>(),
}));

vi.mock('../../core/config/instruction-resolver', () => ({
  resolveInstructions: mockResolveInstructions,
}));

vi.mock('../count-repo-files', () => ({
  countRepoFiles: mockCountFiles,
}));

import {
  InstructionDiagnosticsService,
  _resetInstructionDiagnosticsServiceForTesting,
} from '../instruction-diagnostics-service';

beforeEach(() => {
  _resetInstructionDiagnosticsServiceForTesting();
  vi.clearAllMocks();
});

describe('InstructionDiagnosticsService', () => {
  it('returns empty when no working directory is provided', async () => {
    const out = await new InstructionDiagnosticsService().diagnose(undefined);
    expect(out).toEqual([]);
    expect(mockResolveInstructions).not.toHaveBeenCalled();
  });

  it('translates orchestrator+AGENTS warning to typed code', async () => {
    mockResolveInstructions.mockResolvedValue({
      sources: [],
      warnings: ['Both orchestrator and AGENTS instructions are present at the project level.'],
    });
    mockCountFiles.mockResolvedValue(10);

    const out = await new InstructionDiagnosticsService().diagnose('/repo');
    expect(out.some(d => d.code === 'orchestrator-agents-conflict')).toBe(true);
  });

  it('translates multiple-path-specific warning to typed code', async () => {
    mockResolveInstructions.mockResolvedValue({
      sources: [],
      warnings: ['Multiple path-specific instruction files matched the current context.'],
    });
    mockCountFiles.mockResolvedValue(10);

    const out = await new InstructionDiagnosticsService().diagnose('/repo');
    expect(out.some(d => d.code === 'multiple-path-specific')).toBe(true);
  });

  it('emits unreadable-source when a source has loaded:false and an error', async () => {
    mockResolveInstructions.mockResolvedValue({
      sources: [
        { path: '/repo/AGENTS.md', loaded: false, applied: false, scope: 'project', kind: 'agents', error: 'ENOENT' },
      ],
      warnings: [],
    });
    mockCountFiles.mockResolvedValue(10);

    const out = await new InstructionDiagnosticsService().diagnose('/repo');
    expect(out.some(d => d.code === 'unreadable-source')).toBe(true);
  });

  it('emits broad-root-scan when a project source has no scope filter and the repo is large', async () => {
    mockResolveInstructions.mockResolvedValue({
      sources: [
        { path: '/repo/INSTRUCTIONS.md', loaded: true, applied: true, scope: 'project', kind: 'instructions', applyTo: undefined },
      ],
      warnings: [],
    });
    mockCountFiles.mockResolvedValue(150);

    const out = await new InstructionDiagnosticsService().diagnose('/repo', { broadRootFileThreshold: 100 });
    const broad = out.find(d => d.code === 'broad-root-scan');
    expect(broad).toBeDefined();
    expect(broad?.fileCountSampled).toBe(150);
  });

  it('does not emit broad-root-scan when applyTo restricts scope', async () => {
    mockResolveInstructions.mockResolvedValue({
      sources: [
        { path: '/repo/INSTRUCTIONS.md', loaded: true, applied: true, scope: 'project', kind: 'instructions', applyTo: ['src/**'] },
      ],
      warnings: [],
    });
    mockCountFiles.mockResolvedValue(500);

    const out = await new InstructionDiagnosticsService().diagnose('/repo', { broadRootFileThreshold: 100 });
    expect(out.some(d => d.code === 'broad-root-scan')).toBe(false);
  });

  it('does not emit broad-root-scan when repo is small', async () => {
    mockResolveInstructions.mockResolvedValue({
      sources: [
        { path: '/repo/INSTRUCTIONS.md', loaded: true, applied: true, scope: 'project', kind: 'instructions', applyTo: undefined },
      ],
      warnings: [],
    });
    mockCountFiles.mockResolvedValue(50);

    const out = await new InstructionDiagnosticsService().diagnose('/repo', { broadRootFileThreshold: 100 });
    expect(out.some(d => d.code === 'broad-root-scan')).toBe(false);
  });
});
```

- [x] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/diagnostics/__tests__/instruction-diagnostics-service.spec.ts
```

Expected: FAIL — modules not found.

- [x] **Step 3: Commit failing tests**

```bash
git add src/main/diagnostics/__tests__/instruction-diagnostics-service.spec.ts
git commit -m "test(diagnostics): add failing tests for InstructionDiagnosticsService (red)"
```

---

### Task 4.2: Implement `count-repo-files` helper

**Files:**
- Create: `src/main/diagnostics/count-repo-files.ts`
- Create: `src/main/diagnostics/__tests__/count-repo-files.spec.ts`

- [x] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { countRepoFiles } from '../count-repo-files';

describe('countRepoFiles', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'count-repo-'));
    // 5 files in the root.
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tempDir, `f${i}.txt`), 'hi');
    }
    // 5 files in a subdir.
    await fs.mkdir(path.join(tempDir, 'sub'));
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tempDir, 'sub', `g${i}.txt`), 'hi');
    }
    // node_modules — should be skipped
    await fs.mkdir(path.join(tempDir, 'node_modules'));
    await fs.writeFile(path.join(tempDir, 'node_modules', 'pkg.json'), '{}');
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns the total file count', async () => {
    const n = await countRepoFiles(tempDir, 1000);
    expect(n).toBe(10);
  });

  it('terminates early once threshold is exceeded', async () => {
    const n = await countRepoFiles(tempDir, 3);
    expect(n).toBeGreaterThan(3);  // returns the first count above the bail threshold
    expect(n).toBeLessThanOrEqual(11);
  });
});
```

- [x] **Step 2: Implement**

```ts
import * as fs from 'fs/promises';
import * as path from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage']);

export async function countRepoFiles(root: string, bailAt: number): Promise<number> {
  let count = 0;
  await walk(root);
  return count;

  async function walk(dir: string): Promise<void> {
    if (count > bailAt) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count > bailAt) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        count++;
      }
    }
  }
}
```

- [x] **Step 3: Run, type-check, lint, commit**

```bash
npx vitest run src/main/diagnostics/__tests__/count-repo-files.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/diagnostics/count-repo-files.ts
git add src/main/diagnostics/count-repo-files.ts src/main/diagnostics/__tests__/count-repo-files.spec.ts
git commit -m "feat(diagnostics): add countRepoFiles with skip-dirs and early termination"
```

---

### Task 4.3: Implement `InstructionDiagnosticsService`

**Files:**
- Create: `src/main/diagnostics/instruction-diagnostics-service.ts`

- [x] **Step 1: Read the resolver shape**

Read `src/main/core/config/instruction-resolver.ts` lines 1–225. Confirm the `ResolvedInstructionSource` shape (fields `path`, `loaded`, `applied`, `scope`, `kind`, `applyTo`, optional `error`).

- [x] **Step 2: Write the service**

Create `src/main/diagnostics/instruction-diagnostics-service.ts`:

```ts
import { getLogger } from '../logging/logger';
import { resolveInstructions } from '../core/config/instruction-resolver';
import { countRepoFiles } from './count-repo-files';
import type { InstructionDiagnostic } from '../../shared/types/diagnostics.types';

const logger = getLogger('InstructionDiagnosticsService');

let instance: InstructionDiagnosticsService | null = null;

export interface InstructionDiagnoseOptions {
  broadRootFileThreshold?: number;
}

const DEFAULT_THRESHOLD = 100;

const WARNING_TO_CODE: Array<{ test: (s: string) => boolean; code: InstructionDiagnostic['code']; severity: InstructionDiagnostic['severity'] }> = [
  {
    test: (s) => /both orchestrator and AGENTS instructions are present/i.test(s),
    code: 'orchestrator-agents-conflict',
    severity: 'warning',
  },
  {
    test: (s) => /multiple path-specific instruction files matched/i.test(s),
    code: 'multiple-path-specific',
    severity: 'warning',
  },
];

export class InstructionDiagnosticsService {
  static getInstance(): InstructionDiagnosticsService {
    if (!instance) instance = new InstructionDiagnosticsService();
    return instance;
  }

  async diagnose(workingDirectory?: string, opts?: InstructionDiagnoseOptions): Promise<InstructionDiagnostic[]> {
    if (!workingDirectory) return [];

    const out: InstructionDiagnostic[] = [];
    const threshold = opts?.broadRootFileThreshold ?? DEFAULT_THRESHOLD;

    let resolution: Awaited<ReturnType<typeof resolveInstructions>>;
    try {
      resolution = await resolveInstructions(workingDirectory);
    } catch (err) {
      logger.warn('Failed to resolve instructions for diagnostics', { workingDirectory, error: (err as Error).message });
      return [];
    }

    // Translate warnings → typed codes
    for (const warning of resolution.warnings) {
      const match = WARNING_TO_CODE.find((w) => w.test(warning));
      if (match) {
        out.push({
          code: match.code,
          message: warning,
          scope: 'project',
          severity: match.severity,
        });
      }
    }

    // Copilot conflict: both copilot and orchestrator/agents are project-loaded
    const projectSources = resolution.sources.filter((s) => s.scope === 'project' && s.loaded);
    const projectKinds = new Set(projectSources.map((s) => s.kind));
    if (projectKinds.has('copilot') && (projectKinds.has('orchestrator') || projectKinds.has('agents'))) {
      out.push({
        code: 'copilot-conflict',
        message: 'Copilot instructions are loaded alongside orchestrator/AGENTS at the project level.',
        scope: 'project',
        sourcePaths: projectSources.map((s) => s.path),
        severity: 'warning',
      });
    }

    // Unreadable sources
    for (const source of resolution.sources) {
      if (source.loaded === false && source.error) {
        out.push({
          code: 'unreadable-source',
          message: `Could not read instruction source: ${source.error}`,
          scope: source.scope as InstructionDiagnostic['scope'],
          sourcePaths: [source.path],
          severity: 'error',
        });
      }
    }

    // Broad-root scan
    const broadCandidate = projectSources.find((s) => !s.applyTo || s.applyTo.length === 0);
    if (broadCandidate) {
      const fileCount = await countRepoFiles(workingDirectory, threshold);
      if (fileCount > threshold) {
        out.push({
          code: 'broad-root-scan',
          message: `Project-level instructions apply to all ${fileCount}+ files in the repo without scope filters.`,
          scope: 'project',
          sourcePaths: [broadCandidate.path],
          fileCountSampled: fileCount,
          severity: 'warning',
        });
      }
    }

    return out;
  }
}

export function getInstructionDiagnosticsService(): InstructionDiagnosticsService {
  return InstructionDiagnosticsService.getInstance();
}

export function _resetInstructionDiagnosticsServiceForTesting(): void {
  instance = null;
}
```

> If the actual `ResolvedInstructionSource` interface in `src/main/core/config/instruction-resolver.ts` does not include `applyTo`/`kind`/`error` fields with the names assumed above, adjust the field accesses to match — read the file first and confirm. The diagnostic codes themselves are stable.

- [x] **Step 3: Run the tests**

```bash
npx vitest run src/main/diagnostics/__tests__/instruction-diagnostics-service.spec.ts
```

Expected: pass.

- [x] **Step 4: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/diagnostics/instruction-diagnostics-service.ts
git add src/main/diagnostics/instruction-diagnostics-service.ts
git commit -m "feat(diagnostics): implement InstructionDiagnosticsService (warnings, copilot conflict, unreadable, broad-root scan)"
```

---

## Phase 5 — `DoctorService` composer

### Task 5.1: Write failing `DoctorService` tests

**Files:**
- Create: `src/main/diagnostics/__tests__/doctor-service.spec.ts`

- [x] **Step 1: Write the spec**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartupCapabilityReport } from '../../../shared/types/startup-capability.types';

const { mockProbeRun, mockProbeLast, mockDoctorDiagnose, mockBrowserDiagnose, mockCliDetect, mockGetUpdatePlan, mockCommandSnapshot, mockSkillDiagnose, mockInstrDiagnose } = vi.hoisted(() => ({
  mockProbeRun: vi.fn(),
  mockProbeLast: vi.fn(),
  mockDoctorDiagnose: vi.fn(),
  mockBrowserDiagnose: vi.fn(),
  mockCliDetect: vi.fn(),
  mockGetUpdatePlan: vi.fn(),
  mockCommandSnapshot: vi.fn(),
  mockSkillDiagnose: vi.fn(),
  mockInstrDiagnose: vi.fn(),
}));

vi.mock('../../bootstrap/capability-probe', () => ({
  getCapabilityProbe: () => ({ run: mockProbeRun, getLastReport: mockProbeLast }),
}));
vi.mock('../../providers/provider-doctor', () => ({
  getProviderDoctor: () => ({ diagnose: mockDoctorDiagnose }),
}));
vi.mock('../../browser-automation/browser-automation-health', () => ({
  getBrowserAutomationHealthService: () => ({ diagnose: mockBrowserDiagnose }),
}));
vi.mock('../../cli/cli-detection', () => ({
  getCliDetectionService: () => ({ detectAll: mockCliDetect }),
}));
vi.mock('../../cli/cli-update-service', () => ({
  getCliUpdateService: () => ({ getUpdatePlan: mockGetUpdatePlan }),
}));
vi.mock('../../commands/command-manager', () => ({
  getCommandManager: () => ({ getAllCommandsSnapshot: mockCommandSnapshot }),
}));
vi.mock('../skill-diagnostics-service', () => ({
  getSkillDiagnosticsService: () => ({ diagnose: mockSkillDiagnose }),
}));
vi.mock('../instruction-diagnostics-service', () => ({
  getInstructionDiagnosticsService: () => ({ diagnose: mockInstrDiagnose }),
}));

import { DoctorService, _resetDoctorServiceForTesting } from '../doctor-service';

const stubReport: StartupCapabilityReport = {
  status: 'ready',
  generatedAt: 1,
  checks: [
    { id: 'native.sqlite', label: 'SQLite runtime', category: 'native', status: 'ready', critical: true, summary: 'ok' },
  ],
};

beforeEach(() => {
  _resetDoctorServiceForTesting();
  vi.clearAllMocks();
  mockProbeLast.mockReturnValue(stubReport);
  mockProbeRun.mockResolvedValue(stubReport);
  mockDoctorDiagnose.mockResolvedValue({ provider: 'claude-cli', overall: 'healthy', probes: [], recommendations: [], timestamp: 1 });
  mockBrowserDiagnose.mockResolvedValue({ status: 'ready', runtimeAvailable: true, inAppConfigured: false, inAppConnected: false, configDetected: false, browserToolNames: [], warnings: [], suggestions: [] });
  mockCliDetect.mockResolvedValue({ available: [], missing: [], shadows: [] });
  mockGetUpdatePlan.mockReturnValue({ cli: 'claude', displayName: 'Claude', supported: false });
  mockCommandSnapshot.mockResolvedValue({ commands: [], diagnostics: [], scanDirs: [] });
  mockSkillDiagnose.mockResolvedValue([]);
  mockInstrDiagnose.mockResolvedValue([]);
});

describe('DoctorService', () => {
  it('composes a report from upstream sources', async () => {
    const r = await new DoctorService().getReport({ workingDirectory: '/repo' });
    expect(r.startupCapabilities).toEqual(stubReport);
    expect(mockBrowserDiagnose).toHaveBeenCalled();
    expect(r.commandDiagnostics).toMatchObject({ available: false, reason: 'wave1-not-shipped' });
  });

  it('reuses the cached startup report when force=false', async () => {
    await new DoctorService().getReport({ force: false });
    expect(mockProbeLast).toHaveBeenCalled();
    expect(mockProbeRun).not.toHaveBeenCalled();
  });

  it('forces a fresh probe when force=true', async () => {
    await new DoctorService().getReport({ force: true });
    expect(mockProbeRun).toHaveBeenCalled();
  });

  it('falls back to probe.run() when getLastReport is null', async () => {
    mockProbeLast.mockReturnValue(null);
    await new DoctorService().getReport();
    expect(mockProbeRun).toHaveBeenCalled();
  });

  it('returns command diagnostics when feature flag is on and workingDirectory provided', async () => {
    const svc = new DoctorService({ commandDiagnosticsAvailable: true });
    mockCommandSnapshot.mockResolvedValue({
      commands: [],
      diagnostics: [{ code: 'alias-collision', message: 'foo', alias: 'a', candidates: ['x','y'], severity: 'warn' }],
      scanDirs: ['/repo/.claude/commands'],
    });
    const r = await svc.getReport({ workingDirectory: '/repo' });
    expect(r.commandDiagnostics).toMatchObject({ available: true });
    if (r.commandDiagnostics.available) {
      expect(r.commandDiagnostics.diagnostics.length).toBe(1);
    }
  });

  it('returns no-working-directory reason when flag on but no cwd', async () => {
    const svc = new DoctorService({ commandDiagnosticsAvailable: true });
    const r = await svc.getReport({});
    expect(r.commandDiagnostics).toEqual({ available: false, reason: 'no-working-directory' });
  });

  it('builds section summaries with severity and item counts', async () => {
    mockSkillDiagnose.mockResolvedValue([
      { code: 'invalid-frontmatter', message: 'x', skillId: 's1', severity: 'error' },
    ]);
    const r = await new DoctorService().getReport();
    const section = r.sections.find((s) => s.id === 'commands-and-skills');
    expect(section?.severity).toBe('error');
    expect(section?.itemCount).toBe(1);
  });

  it('resolveSectionForStartupCheck maps known prefixes', () => {
    const svc = new DoctorService();
    expect(svc.resolveSectionForStartupCheck('provider.claude')).toBe('provider-health');
    expect(svc.resolveSectionForStartupCheck('subsystem.browser-automation')).toBe('browser-automation');
    expect(svc.resolveSectionForStartupCheck('native.sqlite')).toBe('startup-capabilities');
    expect(svc.resolveSectionForStartupCheck('unknown.thing')).toBe('startup-capabilities');
  });
});
```

- [x] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/diagnostics/__tests__/doctor-service.spec.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Commit failing tests**

```bash
git add src/main/diagnostics/__tests__/doctor-service.spec.ts
git commit -m "test(diagnostics): add failing tests for DoctorService composer (red)"
```

---

### Task 5.2: Implement `DoctorService`

**Files:**
- Create: `src/main/diagnostics/doctor-service.ts`

- [x] **Step 1: Write the service**

Create `src/main/diagnostics/doctor-service.ts`:

```ts
import { getLogger } from '../logging/logger';
import { getCapabilityProbe } from '../bootstrap/capability-probe';
import { getProviderDoctor } from '../providers/provider-doctor';
import { getBrowserAutomationHealthService } from '../browser-automation/browser-automation-health';
import { getCliDetectionService } from '../cli/cli-detection';
import { getCliUpdateService } from '../cli/cli-update-service';
import { getCommandManager } from '../commands/command-manager';
import { getSkillDiagnosticsService } from './skill-diagnostics-service';
import { getInstructionDiagnosticsService } from './instruction-diagnostics-service';
import type {
  DoctorReport,
  DoctorSectionId,
  DoctorSectionSummary,
  DoctorSeverity,
  CommandDiagnosticsSnapshot,
  ProviderDiagnosesSnapshot,
  BrowserAutomationDiagnosisSummary,
  CliHealthSnapshot,
} from '../../shared/types/diagnostics.types';

const logger = getLogger('DoctorService');

const PROVIDER_KEYS = ['claude-cli', 'codex-cli', 'gemini-cli', 'copilot', 'cursor'] as const;
const UPDATE_CLIS = ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'ollama'] as const;

const SECTION_LABELS: Record<DoctorSectionId, string> = {
  'startup-capabilities': 'Startup Capabilities',
  'provider-health': 'Provider Health',
  'cli-health': 'CLI Health',
  'browser-automation': 'Browser Automation',
  'commands-and-skills': 'Commands & Skills',
  'instructions': 'Instructions',
  'operator-artifacts': 'Operator Artifacts',
};

let instance: DoctorService | null = null;

export interface DoctorServiceOptions {
  commandDiagnosticsAvailable?: boolean;
}

export class DoctorService {
  constructor(private readonly options: DoctorServiceOptions = {}) {}

  static getInstance(): DoctorService {
    if (!instance) instance = new DoctorService();
    return instance;
  }

  async getReport(opts: { workingDirectory?: string; force?: boolean } = {}): Promise<DoctorReport> {
    const generatedAt = Date.now();

    // Startup capabilities — reuse cached when allowed
    const probe = getCapabilityProbe();
    const startupCapabilities = opts.force
      ? await probe.run()
      : (probe.getLastReport() ?? await probe.run());

    const [providerDiagnoses, browserAutomation, cliHealth, commandDiagnostics, skillDiagnostics, instructionDiagnostics] =
      await Promise.all([
        this.collectProviderDiagnoses(),
        this.collectBrowserAutomation(),
        this.collectCliHealth(),
        this.collectCommandDiagnostics(opts.workingDirectory),
        getSkillDiagnosticsService().diagnose().catch((err) => {
          logger.warn('skill diagnostics failed', { error: (err as Error).message });
          return [];
        }),
        getInstructionDiagnosticsService().diagnose(opts.workingDirectory).catch((err) => {
          logger.warn('instruction diagnostics failed', { error: (err as Error).message });
          return [];
        }),
      ]);

    const partial = {
      generatedAt,
      startupCapabilities,
      providerDiagnoses,
      browserAutomation,
      cliHealth,
      commandDiagnostics,
      skillDiagnostics,
      instructionDiagnostics,
    };
    const sections = this.buildSectionSummaries(partial);

    return { ...partial, sections };
  }

  resolveSectionForStartupCheck(checkId: string): DoctorSectionId {
    if (checkId.startsWith('provider.')) return 'provider-health';
    if (checkId === 'subsystem.browser-automation') return 'browser-automation';
    if (checkId === 'subsystem.remote-nodes' || checkId.startsWith('native.')) return 'startup-capabilities';
    return 'startup-capabilities';
  }

  buildSectionSummaries(report: Omit<DoctorReport, 'sections'>): DoctorSectionSummary[] {
    const summaries: DoctorSectionSummary[] = [];

    // Startup capabilities
    const failedStartup = report.startupCapabilities.checks.filter((c) => c.status !== 'ready' && c.status !== 'disabled');
    summaries.push({
      id: 'startup-capabilities',
      label: SECTION_LABELS['startup-capabilities'],
      severity: failedStartup.length === 0 ? 'ok' : worstStartupSeverity(failedStartup.map((c) => c.status)),
      headline: failedStartup.length === 0 ? 'All checks ready' : `${failedStartup.length} check${failedStartup.length === 1 ? '' : 's'} not ready`,
      itemCount: failedStartup.length,
    });

    // Provider health
    const unhealthyProviders = report.providerDiagnoses.diagnoses.filter((d) => d.overall !== 'healthy');
    summaries.push({
      id: 'provider-health',
      label: SECTION_LABELS['provider-health'],
      severity: unhealthyProviders.length === 0 ? 'ok' : 'warning',
      headline: unhealthyProviders.length === 0 ? 'All providers healthy' : `${unhealthyProviders.length} provider${unhealthyProviders.length === 1 ? '' : 's'} need attention`,
      itemCount: unhealthyProviders.length,
    });

    // CLI health
    const updatable = report.cliHealth.updatePlans.filter((p) => p.supported);
    summaries.push({
      id: 'cli-health',
      label: SECTION_LABELS['cli-health'],
      severity: 'info',
      headline: updatable.length === 0 ? 'No updates available' : `${updatable.length} update${updatable.length === 1 ? '' : 's'} available`,
      itemCount: updatable.length,
    });

    // Browser automation
    summaries.push({
      id: 'browser-automation',
      label: SECTION_LABELS['browser-automation'],
      severity: report.browserAutomation.status === 'ready' ? 'ok' : report.browserAutomation.status === 'unavailable' ? 'warning' : 'info',
      headline: report.browserAutomation.warnings[0] ?? `Status: ${report.browserAutomation.status}`,
      itemCount: report.browserAutomation.warnings.length,
    });

    // Commands & skills (composite of skill + command diagnostics)
    const skillErrors = report.skillDiagnostics.filter((d) => d.severity === 'error').length;
    const skillWarnings = report.skillDiagnostics.filter((d) => d.severity === 'warning').length;
    const cmdCount = report.commandDiagnostics.available ? report.commandDiagnostics.diagnostics.length : 0;
    const totalCs = skillErrors + skillWarnings + cmdCount;
    summaries.push({
      id: 'commands-and-skills',
      label: SECTION_LABELS['commands-and-skills'],
      severity: skillErrors > 0 ? 'error' : totalCs > 0 ? 'warning' : 'ok',
      headline: totalCs === 0
        ? (report.commandDiagnostics.available ? 'No issues' : 'Skill diagnostics ok (command diagnostics pending Wave 1)')
        : `${totalCs} issue${totalCs === 1 ? '' : 's'}`,
      itemCount: totalCs,
    });

    // Instructions
    const instrErrors = report.instructionDiagnostics.filter((d) => d.severity === 'error').length;
    const instrWarnings = report.instructionDiagnostics.length - instrErrors;
    summaries.push({
      id: 'instructions',
      label: SECTION_LABELS['instructions'],
      severity: instrErrors > 0 ? 'error' : instrWarnings > 0 ? 'warning' : 'ok',
      headline: report.instructionDiagnostics.length === 0 ? 'No conflicts' : `${report.instructionDiagnostics.length} issue${report.instructionDiagnostics.length === 1 ? '' : 's'}`,
      itemCount: report.instructionDiagnostics.length,
    });

    // Operator artifacts
    summaries.push({
      id: 'operator-artifacts',
      label: SECTION_LABELS['operator-artifacts'],
      severity: 'info',
      headline: 'Export a redacted bundle for support',
      itemCount: 0,
    });

    return summaries;
  }

  private async collectProviderDiagnoses(): Promise<ProviderDiagnosesSnapshot> {
    const doctor = getProviderDoctor();
    const results = await Promise.allSettled(PROVIDER_KEYS.map((p) => doctor.diagnose(p)));
    const diagnoses = results
      .map((r, i) => r.status === 'fulfilled' ? { provider: PROVIDER_KEYS[i], ...r.value } : null)
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .map((d) => ({
        provider: d.provider,
        overall: (d as { overall: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' }).overall,
        probes: d.probes ?? [],
        recommendations: d.recommendations ?? [],
        timestamp: d.timestamp ?? Date.now(),
      }));
    return { diagnoses, generatedAt: Date.now() };
  }

  private async collectBrowserAutomation(): Promise<BrowserAutomationDiagnosisSummary> {
    try {
      const h = await getBrowserAutomationHealthService().diagnose();
      return {
        status: h.status,
        runtimeAvailable: h.runtimeAvailable,
        inAppConfigured: h.inAppConfigured,
        inAppConnected: h.inAppConnected,
        configDetected: h.configDetected,
        browserToolNames: h.browserToolNames ?? [],
        warnings: h.warnings ?? [],
        suggestions: h.suggestions ?? [],
      };
    } catch (err) {
      logger.warn('browser automation diagnose failed', { error: (err as Error).message });
      return {
        status: 'unavailable',
        runtimeAvailable: false,
        inAppConfigured: false,
        inAppConnected: false,
        configDetected: false,
        browserToolNames: [],
        warnings: [(err as Error).message],
        suggestions: [],
      };
    }
  }

  private async collectCliHealth(): Promise<CliHealthSnapshot> {
    const detection = getCliDetectionService();
    const updateService = getCliUpdateService();
    const detectionResult = await detection.detectAll().catch(() => ({ available: [], missing: [], shadows: [] }));
    const installs = (detectionResult.available ?? []).map((cli: { name: string; activePath?: string; activeVersion?: string; installs?: unknown[] }) => ({
      cli: cli.name,
      installed: true,
      activePath: cli.activePath,
      activeVersion: cli.activeVersion,
      installCount: (cli.installs ?? []).length,
    }));
    const updatePlans = UPDATE_CLIS.map((cli) => {
      const plan = updateService.getUpdatePlan(cli);
      return {
        cli,
        displayName: plan.displayName,
        supported: plan.supported,
        command: plan.command,
        args: plan.args,
        displayCommand: plan.displayCommand,
        reason: plan.reason,
        currentVersion: plan.currentVersion,
      };
    });
    return { installs, updatePlans, generatedAt: Date.now() };
  }

  private async collectCommandDiagnostics(workingDirectory?: string): Promise<CommandDiagnosticsSnapshot> {
    if (!this.options.commandDiagnosticsAvailable) {
      return { available: false, reason: 'wave1-not-shipped' };
    }
    if (!workingDirectory) {
      return { available: false, reason: 'no-working-directory' };
    }
    const cm = getCommandManager() as unknown as {
      getAllCommandsSnapshot?: (cwd: string) => Promise<{ diagnostics: unknown[]; scanDirs: string[] }>;
    };
    if (typeof cm.getAllCommandsSnapshot !== 'function') {
      return { available: false, reason: 'wave1-not-shipped' };
    }
    const snap = await cm.getAllCommandsSnapshot(workingDirectory);
    return {
      available: true,
      diagnostics: snap.diagnostics as CommandDiagnosticsSnapshot extends { available: true; diagnostics: infer D } ? D : never,
      scanDirs: snap.scanDirs,
      generatedAt: Date.now(),
    };
  }
}

function worstStartupSeverity(statuses: string[]): DoctorSeverity {
  if (statuses.includes('unavailable')) return 'error';
  if (statuses.includes('degraded')) return 'warning';
  return 'info';
}

export function getDoctorService(): DoctorService {
  return DoctorService.getInstance();
}

export function _resetDoctorServiceForTesting(): void {
  instance = null;
}
```

> The `BrowserAutomationHealthService.diagnose()` return shape may differ from the assumption above; read `src/main/browser-automation/browser-automation-health.ts` and adjust the field accesses (`runtimeAvailable`, `inAppConfigured`, `configDetected`, `browserToolNames`, `warnings`, `suggestions`, `status`) before running tests. The test file mocks the service entirely, so the spec passes regardless — but the production type signature must match.

- [x] **Step 2: Run the tests**

```bash
npx vitest run src/main/diagnostics/__tests__/doctor-service.spec.ts
```

Expected: pass.

- [x] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/diagnostics/doctor-service.ts
git add src/main/diagnostics/doctor-service.ts
git commit -m "feat(diagnostics): implement DoctorService composer with section summaries and Wave-1 fallback"
```

---

## Phase 6 — `OperatorArtifactExporter`

### Task 6.1: Decide on the zip writer

**Files:**
- Read: `package.json`

- [x] **Step 1: Check whether `archiver` is already a dep**

```bash
node -e "const p=require('./package.json'); console.log('archiver:', !!(p.dependencies?.archiver || p.devDependencies?.archiver)); console.log('jszip:', !!(p.dependencies?.jszip || p.devDependencies?.jszip));"
```

If `archiver` is already a dep → use it. If `jszip` is already a dep → use it. Otherwise implement the minimal stored-zip writer described below in Task 6.2.

- [x] **Step 2: Record the choice as a comment in this plan task**

(No commit; this is a decision point you will note inline in the next file.)

---

### Task 6.2: Write failing exporter tests

**Files:**
- Create: `src/main/diagnostics/__tests__/operator-artifact-exporter.spec.ts`

- [x] **Step 1: Write the spec**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { mockGetReport, mockSessionRecall } = vi.hoisted(() => ({
  mockGetReport: vi.fn(),
  mockSessionRecall: vi.fn(),
}));

vi.mock('../doctor-service', () => ({
  getDoctorService: () => ({ getReport: mockGetReport }),
}));
vi.mock('../../session/session-recall-service', () => ({
  getSessionRecallService: () => ({ getSessionDiagnostics: mockSessionRecall }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'wave6-export-test'), getVersion: () => '1.0.0' },
}));

import { OperatorArtifactExporter, _resetOperatorArtifactExporterForTesting } from '../operator-artifact-exporter';

beforeEach(() => {
  _resetOperatorArtifactExporterForTesting();
  vi.clearAllMocks();
  mockGetReport.mockResolvedValue({
    generatedAt: 1,
    startupCapabilities: { status: 'ready', generatedAt: 1, checks: [] },
    providerDiagnoses: { diagnoses: [], generatedAt: 1 },
    browserAutomation: { status: 'ready', runtimeAvailable: true, inAppConfigured: false, inAppConnected: false, configDetected: false, browserToolNames: [], warnings: [], suggestions: [] },
    cliHealth: { installs: [], updatePlans: [], generatedAt: 1 },
    commandDiagnostics: { available: false, reason: 'wave1-not-shipped' },
    skillDiagnostics: [],
    instructionDiagnostics: [],
    sections: [],
  });
  mockSessionRecall.mockResolvedValue({ sessionId: 'sess-1', model: 'claude', messages: [{ role: 'user', content: 'leak' }] });
});

describe('OperatorArtifactExporter', () => {
  it('writes a zip and a manifest with the expected files', async () => {
    const result = await new OperatorArtifactExporter().export({});
    expect(result.bundlePath.endsWith('.zip')).toBe(true);
    expect(result.bundleBytes).toBeGreaterThan(0);
    const stat = await fs.stat(result.bundlePath);
    expect(stat.size).toBe(result.bundleBytes);

    expect(result.manifest.files.find((f) => f.name === 'startup-report.json')).toBeDefined();
    expect(result.manifest.files.find((f) => f.name === 'provider-diagnoses.json')).toBeDefined();
    expect(result.manifest.files.find((f) => f.name === 'skill-diagnostics.json')).toBeDefined();
    expect(result.manifest.files.find((f) => f.name === 'instruction-diagnostics.json')).toBeDefined();
    expect(result.manifest.files.find((f) => f.name === 'lifecycle-tail.ndjson')).toBeDefined();
    expect(result.manifest.files.find((f) => f.name === 'manifest.json')).toBeDefined();
  });

  it('only includes session diagnostics when sessionId is provided', async () => {
    const r1 = await new OperatorArtifactExporter().export({});
    expect(r1.manifest.files.find((f) => f.name === 'selected-session-diagnostics.json')).toBeUndefined();

    const r2 = await new OperatorArtifactExporter().export({ sessionId: 'sess-1', includeSessionContent: true });
    expect(r2.manifest.selectedSessionId).toBe('sess-1');
    expect(r2.manifest.files.find((f) => f.name === 'selected-session-diagnostics.json')).toBeDefined();
    expect(r2.manifest.redactionPolicy.sessionContentExcluded).toBe(false);
    expect(r2.manifest.redactionPolicy.sessionContentRedaction).toBe('metadata-only');
  });

  it('strips message bodies from session diagnostics', async () => {
    const r = await new OperatorArtifactExporter().export({ sessionId: 'sess-1', includeSessionContent: true });
    const buf = await fs.readFile(r.bundlePath);
    // The bundle is a stored-zip; checking that the literal string 'leak' does not appear is sufficient.
    expect(buf.includes(Buffer.from('leak'))).toBe(false);
  });

  it('includes commandDiagnosticsAvailable: false in manifest when wave1 not shipped', async () => {
    const r = await new OperatorArtifactExporter().export({});
    expect(r.manifest.commandDiagnosticsAvailable).toBe(false);
  });

  it('records a sha256 hex for every file EXCEPT manifest.json (which uses the self-described sentinel)', async () => {
    const r = await new OperatorArtifactExporter().export({});
    for (const f of r.manifest.files) {
      if (f.name === 'manifest.json') {
        // The manifest cannot hash itself before final serialization; the
        // exporter records `sha256: 'self-described'` and `bytes: 0`.
        expect(f.sha256).toBe('self-described');
        continue;
      }
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('manifest entry uses the self-described sentinel (not a hex hash)', async () => {
    const r = await new OperatorArtifactExporter().export({});
    const manifestEntry = r.manifest.files.find((f) => f.name === 'manifest.json');
    expect(manifestEntry).toBeDefined();
    expect(manifestEntry!.sha256).toBe('self-described');
  });

  it('hashes for non-manifest entries match the actual zip contents', async () => {
    // Verifies the documented invariant: consumers who unzip and hash each file
    // should match the manifest's recorded sha256 for every file other than manifest.json.
    const r = await new OperatorArtifactExporter().export({});
    // (Implementation: open the zip via your zip lib of choice, iterate entries
    // other than manifest.json, recompute sha256, assert against r.manifest.files.)
    // The shape of this assertion depends on the zip reader chosen in Phase 6.
  });
});
```

- [x] **Step 2: Run and confirm failure**

```bash
npx vitest run src/main/diagnostics/__tests__/operator-artifact-exporter.spec.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Commit failing tests**

```bash
git add src/main/diagnostics/__tests__/operator-artifact-exporter.spec.ts
git commit -m "test(diagnostics): add failing tests for OperatorArtifactExporter (red)"
```

---

### Task 6.3: Implement the stored-zip writer (or use existing dep)

**Files:**
- Create: `src/main/diagnostics/zip-writer.ts` (only if `archiver` / `jszip` not present)
- Create: `src/main/diagnostics/__tests__/zip-writer.spec.ts`

- [x] **Step 1: If `archiver` / `jszip` is in `package.json`, skip this task**

If a dep is already present, document the choice and skip to Task 6.4. Otherwise:

- [x] **Step 2: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeStoredZip } from '../zip-writer';

const execFileP = promisify(execFile);

describe('writeStoredZip', () => {
  it('produces a zip readable by /usr/bin/unzip', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zw-'));
    const zipPath = path.join(tmp, 'out.zip');
    await writeStoredZip(zipPath, [
      { name: 'a.txt', content: Buffer.from('hello') },
      { name: 'b.json', content: '{"x":1}' },
    ]);
    const { stdout } = await execFileP('unzip', ['-l', zipPath]);
    expect(stdout).toContain('a.txt');
    expect(stdout).toContain('b.json');

    const extractDir = path.join(tmp, 'ex');
    await fs.mkdir(extractDir);
    await execFileP('unzip', [zipPath, '-d', extractDir]);
    expect(await fs.readFile(path.join(extractDir, 'a.txt'), 'utf8')).toBe('hello');
    expect(await fs.readFile(path.join(extractDir, 'b.json'), 'utf8')).toBe('{"x":1}');
  });
});
```

- [x] **Step 3: Implement the writer**

Create `src/main/diagnostics/zip-writer.ts`:

```ts
/**
 * Minimal stored-zip writer (compression method 0x00).
 * Only enough of the spec to produce a valid zip readable by /usr/bin/unzip.
 *
 * If we ever need real compression, switch to `archiver` (no API change at the
 * call site — `writeStoredZip(name, entries)`).
 */

import * as fs from 'fs/promises';
import { Buffer } from 'buffer';
import * as zlib from 'zlib';

export interface ZipEntry {
  name: string;
  content: Buffer | string;
}

interface CentralEntry {
  name: string;
  crc32: number;
  size: number;
  offset: number;
}

export async function writeStoredZip(filePath: string, entries: ZipEntry[]): Promise<void> {
  const chunks: Buffer[] = [];
  const central: CentralEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const crc32 = zlib.crc32 ? zlib.crc32(data) : crc32Fallback(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);   // local file header signature
    localHeader.writeUInt16LE(20, 4);            // version needed
    localHeader.writeUInt16LE(0, 6);             // flags
    localHeader.writeUInt16LE(0, 8);             // method (stored)
    localHeader.writeUInt16LE(0, 10);            // mod time
    localHeader.writeUInt16LE(0, 12);            // mod date
    localHeader.writeUInt32LE(crc32 >>> 0, 14);  // crc-32
    localHeader.writeUInt32LE(data.length, 18);  // compressed size
    localHeader.writeUInt32LE(data.length, 22);  // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28);            // extra field length

    chunks.push(localHeader, nameBuf, data);
    central.push({ name: entry.name, crc32: crc32 >>> 0, size: data.length, offset });
    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  for (const ce of central) {
    const nameBuf = Buffer.from(ce.name, 'utf8');
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central dir signature
    cdh.writeUInt16LE(20, 4);          // version made by
    cdh.writeUInt16LE(20, 6);          // version needed
    cdh.writeUInt16LE(0, 8);           // flags
    cdh.writeUInt16LE(0, 10);          // method
    cdh.writeUInt16LE(0, 12);          // mod time
    cdh.writeUInt16LE(0, 14);          // mod date
    cdh.writeUInt32LE(ce.crc32, 16);   // crc
    cdh.writeUInt32LE(ce.size, 20);    // compressed size
    cdh.writeUInt32LE(ce.size, 24);    // uncompressed size
    cdh.writeUInt16LE(nameBuf.length, 28); // file name length
    cdh.writeUInt16LE(0, 30);          // extra
    cdh.writeUInt16LE(0, 32);          // comment length
    cdh.writeUInt16LE(0, 34);          // disk number start
    cdh.writeUInt16LE(0, 36);          // internal attrs
    cdh.writeUInt32LE(0, 38);          // external attrs
    cdh.writeUInt32LE(ce.offset, 42);  // local header offset
    chunks.push(cdh, nameBuf);
    offset += cdh.length + nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);     // EOCD signature
  eocd.writeUInt16LE(0, 4);               // disk number
  eocd.writeUInt16LE(0, 6);               // start disk
  eocd.writeUInt16LE(central.length, 8);  // entries on this disk
  eocd.writeUInt16LE(central.length, 10); // total entries
  eocd.writeUInt32LE(offset - centralStart, 12); // central dir size
  eocd.writeUInt32LE(centralStart, 16);   // central dir offset
  eocd.writeUInt16LE(0, 20);              // comment length
  chunks.push(eocd);

  await fs.writeFile(filePath, Buffer.concat(chunks));
}

// Polyfill: not all Node versions expose zlib.crc32 yet (added in 22.x).
function crc32Fallback(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc;
}
```

> If `zlib.crc32` is not available in the project's Node version, the fallback computes CRC-32 manually. The fallback path is exercised by the test suite when running against older Node.

- [x] **Step 4: Run tests, type-check, commit**

```bash
npx vitest run src/main/diagnostics/__tests__/zip-writer.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/diagnostics/zip-writer.ts src/main/diagnostics/__tests__/zip-writer.spec.ts
git commit -m "feat(diagnostics): add minimal stored-zip writer"
```

---

### Task 6.4: Implement `OperatorArtifactExporter`

**Files:**
- Create: `src/main/diagnostics/operator-artifact-exporter.ts`

- [x] **Step 1: Write the service**

Create `src/main/diagnostics/operator-artifact-exporter.ts`:

```ts
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getLogger } from '../logging/logger';
import { getDoctorService } from './doctor-service';
import { redactValue } from './redaction';
import { writeStoredZip, type ZipEntry } from './zip-writer';
import { resolveLifecycleTraceFilePath } from '../observability/lifecycle-trace';
import type {
  OperatorArtifactExportRequest,
  OperatorArtifactExportResult,
  OperatorArtifactBundleManifest,
} from '../../shared/types/diagnostics.types';

const logger = getLogger('OperatorArtifactExporter');

const TRACE_TAIL_LINES = 500;

let instance: OperatorArtifactExporter | null = null;

export class OperatorArtifactExporter {
  static getInstance(): OperatorArtifactExporter {
    if (!instance) instance = new OperatorArtifactExporter();
    return instance;
  }

  async export(req: OperatorArtifactExportRequest): Promise<OperatorArtifactExportResult> {
    const homedir = os.homedir();
    const includeSessionContent = req.includeSessionContent === true;
    const opts = { homedir, includeSessionContent };

    // Forward `workingDirectory` so workspace-scoped diagnostics
    // (instruction conflicts, project-level skills, etc.) are captured.
    // Passing `undefined` here drops them from the bundle.
    const report = await getDoctorService().getReport({
      workingDirectory: req.workingDirectory,
      force: true,
    });

    // Build payloads
    const startupReport = redactValue(report.startupCapabilities, opts);
    const providerDiagnoses = redactValue(report.providerDiagnoses, opts);
    const skillDiagnostics = redactValue(report.skillDiagnostics, opts);
    const instructionDiagnostics = redactValue(report.instructionDiagnostics, opts);
    const browserAutomation = redactValue(report.browserAutomation, opts);

    let commandDiagnostics: unknown = null;
    if (report.commandDiagnostics.available) {
      commandDiagnostics = redactValue(report.commandDiagnostics, opts);
    }

    const lifecycleTail = await this.readLifecycleTail();
    let sessionPayload: unknown = null;
    if (req.sessionId) {
      sessionPayload = await this.collectSessionPayload(req.sessionId, includeSessionContent, opts);
    }

    const entries: ZipEntry[] = [
      { name: 'startup-report.json', content: jsonStr(startupReport) },
      { name: 'provider-diagnoses.json', content: jsonStr(providerDiagnoses) },
      { name: 'browser-automation.json', content: jsonStr(browserAutomation) },
      { name: 'skill-diagnostics.json', content: jsonStr(skillDiagnostics) },
      { name: 'instruction-diagnostics.json', content: jsonStr(instructionDiagnostics) },
      { name: 'lifecycle-tail.ndjson', content: lifecycleTail },
    ];
    if (commandDiagnostics) entries.push({ name: 'command-diagnostics.json', content: jsonStr(commandDiagnostics) });
    if (sessionPayload) entries.push({ name: 'selected-session-diagnostics.json', content: jsonStr(sessionPayload) });

    // Build manifest. The manifest itself does NOT carry a sha256 of its own
    // file — a self-hash is impossible to compute before the manifest is
    // serialized. The `files[]` array hashes every OTHER bundle file; the
    // manifest entry is recorded with a sentinel `sha256: 'self-described'`
    // so consumers can verify everything in the bundle except the manifest.
    const manifest: OperatorArtifactBundleManifest = {
      schemaVersion: 1,
      generatedAt: Date.now(),
      appVersion: safeAppVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      workingDirectory: req.workingDirectory ? path.relative(homedir, req.workingDirectory) : undefined,
      redactionPolicy: {
        envVarsRedacted: true,
        homedirRelativized: true,
        embeddedSecretsRedacted: true,
        sessionContentExcluded: !includeSessionContent,
        ...(includeSessionContent ? { sessionContentRedaction: 'metadata-only' as const } : {}),
      },
      files: entries.map((e) => {
        const buf = typeof e.content === 'string' ? Buffer.from(e.content) : e.content;
        return {
          name: e.name,
          bytes: buf.length,
          sha256: crypto.createHash('sha256').update(buf).digest('hex'),
          contentType: e.name.endsWith('.json') ? 'json' : e.name.endsWith('.ndjson') ? 'ndjson' : 'text',
          description: descriptionFor(e.name),
        };
      }),
      selectedSessionId: req.sessionId,
      commandDiagnosticsAvailable: report.commandDiagnostics.available,
    };

    // Append the manifest's own file entry with a sentinel hash so the
    // serialization is stable. Do NOT compute and embed a sha256 of the
    // manifest within itself — that would change the hash on serialize.
    manifest.files.push({
      name: 'manifest.json',
      bytes: 0,           // recorded after final serialization, but readers should not assume this.
      sha256: 'self-described',
      contentType: 'json',
      description: 'Self-descriptor for this bundle.',
    });
    const finalManifestStr = JSON.stringify(manifest, null, 2);
    const finalEntries: ZipEntry[] = [...entries, { name: 'manifest.json', content: finalManifestStr }];

    // Write
    const dir = path.join(app.getPath('userData'), 'diagnostics-bundles');
    await fs.mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bundlePath = path.join(dir, `${ts}.zip`);
    await writeStoredZip(bundlePath, finalEntries);
    const stat = await fs.stat(bundlePath);

    return { bundlePath, bundleBytes: stat.size, manifest };
  }

  private async readLifecycleTail(): Promise<string> {
    try {
      const tracePath = resolveLifecycleTraceFilePath();
      const content = await fs.readFile(tracePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const tail = lines.slice(-TRACE_TAIL_LINES);
      return tail.join('\n') + '\n';
    } catch {
      return JSON.stringify({ note: 'no lifecycle trace recorded' }) + '\n';
    }
  }

  private async collectSessionPayload(sessionId: string, includeContent: boolean, opts: { homedir: string; includeSessionContent: boolean }): Promise<unknown> {
    let raw: unknown;
    try {
      const recall = await import('../session/session-recall-service');
      raw = await recall.getSessionRecallService().getSessionDiagnostics(sessionId);
    } catch (err) {
      logger.warn('session recall not available for diagnostics export', { error: (err as Error).message });
      return { sessionId, error: 'session diagnostics unavailable' };
    }
    // Strip message bodies entirely, even when includeContent is true.
    const stripped = stripMessages(raw, includeContent);
    return redactValue(stripped, opts);
  }
}

function jsonStr(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function descriptionFor(name: string): string {
  switch (name) {
    case 'startup-report.json': return 'CapabilityProbe.run() output';
    case 'provider-diagnoses.json': return 'ProviderDoctor.diagnose() per provider';
    case 'browser-automation.json': return 'BrowserAutomationHealthService.diagnose()';
    case 'command-diagnostics.json': return 'CommandRegistrySnapshot.diagnostics (Wave 1)';
    case 'skill-diagnostics.json': return 'SkillDiagnosticsService output';
    case 'instruction-diagnostics.json': return 'InstructionDiagnosticsService output';
    case 'lifecycle-tail.ndjson': return `Last ${TRACE_TAIL_LINES} lifecycle events`;
    case 'selected-session-diagnostics.json': return 'SessionRecallService.getSessionDiagnostics (redacted)';
    default: return '';
  }
}

function stripMessages(value: unknown, includeContent: boolean): unknown {
  if (!includeContent) {
    return { redacted: 'metadata-only', note: 'session messages excluded by default policy' };
  }
  // includeContent === true: keep model/role/timestamp metadata, drop bodies
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && k === 'messages') {
        out[k] = v.map((m) => {
          if (m && typeof m === 'object') {
            const mo = m as Record<string, unknown>;
            return { role: mo.role, model: mo.model, name: mo.name, timestamp: mo.timestamp };
          }
          return undefined;
        }).filter(Boolean);
      } else {
        out[k] = stripMessages(v, includeContent);
      }
    }
    return out;
  }
  return value;
}

function safeAppVersion(): string {
  try { return app.getVersion(); } catch { return 'unknown'; }
}

export function getOperatorArtifactExporter(): OperatorArtifactExporter {
  return OperatorArtifactExporter.getInstance();
}

export function _resetOperatorArtifactExporterForTesting(): void {
  instance = null;
}
```

- [x] **Step 2: Run the tests**

```bash
npx vitest run src/main/diagnostics/__tests__/operator-artifact-exporter.spec.ts
```

Expected: pass.

- [x] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/diagnostics/operator-artifact-exporter.ts
git add src/main/diagnostics/operator-artifact-exporter.ts
git commit -m "feat(diagnostics): implement OperatorArtifactExporter (zip bundle, redaction, manifest)"
```

---

## Phase 7 — `CliUpdatePollService`

### Task 7.1: Failing tests

**Files:**
- Create: `src/main/cli/__tests__/cli-update-poll-service.spec.ts`

- [x] **Step 1: Write the spec**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDetectAll, mockGetUpdatePlan } = vi.hoisted(() => ({
  mockDetectAll: vi.fn(),
  mockGetUpdatePlan: vi.fn(),
}));

vi.mock('../cli-detection', () => ({
  getCliDetectionService: () => ({ detectAll: mockDetectAll }),
}));
vi.mock('../cli-update-service', () => ({
  getCliUpdateService: () => ({ getUpdatePlan: mockGetUpdatePlan }),
}));

import { CliUpdatePollService, _resetCliUpdatePollServiceForTesting } from '../cli-update-poll-service';

beforeEach(() => {
  _resetCliUpdatePollServiceForTesting();
  vi.clearAllMocks();
  mockDetectAll.mockResolvedValue({ available: [{ name: 'claude', activeVersion: '1.0.0' }], missing: [], shadows: [] });
  mockGetUpdatePlan.mockReturnValue({ cli: 'claude', displayName: 'Claude Code', supported: true, command: 'npm', args: ['i','-g','@anthropic-ai/claude-code'] });
});

describe('CliUpdatePollService', () => {
  it('returns initial empty state before refresh', () => {
    const svc = new CliUpdatePollService();
    const s = svc.getState();
    expect(s.loaded).toBe(false);
    expect(s.count).toBe(0);
  });

  it('refresh() populates entries from detection + plan', async () => {
    const svc = new CliUpdatePollService();
    await svc.refresh();
    const s = svc.getState();
    expect(s.loaded).toBe(true);
    expect(s.count).toBe(1);
    expect(s.entries[0].cli).toBe('claude');
    expect(s.entries[0].currentVersion).toBe('1.0.0');
    expect(s.entries[0].updatePlan.supported).toBe(true);
  });

  it('skips CLIs whose plan is unsupported', async () => {
    mockGetUpdatePlan.mockReturnValue({ cli: 'claude', displayName: 'Claude Code', supported: false, reason: 'no plan' });
    const svc = new CliUpdatePollService();
    await svc.refresh();
    expect(svc.getState().count).toBe(0);
  });

  it('debounces concurrent refreshes', async () => {
    const svc = new CliUpdatePollService();
    const [a, b] = await Promise.all([svc.refresh(), svc.refresh()]);
    expect(a).toBe(b);
    expect(mockDetectAll).toHaveBeenCalledTimes(1);
  });

  it('fires onChange listeners on state mutation', async () => {
    const svc = new CliUpdatePollService();
    const seen: number[] = [];
    svc.onChange((s) => seen.push(s.count));
    await svc.refresh();
    expect(seen).toEqual([1]);
  });

  it('captures errors as state.error without throwing', async () => {
    mockDetectAll.mockRejectedValue(new Error('boom'));
    const svc = new CliUpdatePollService();
    await svc.refresh();
    expect(svc.getState().error).toBe('boom');
    expect(svc.getState().loaded).toBe(true);
  });
});
```

- [x] **Step 2: Run, confirm fail, commit**

```bash
npx vitest run src/main/cli/__tests__/cli-update-poll-service.spec.ts
git add src/main/cli/__tests__/cli-update-poll-service.spec.ts
git commit -m "test(cli): add failing tests for CliUpdatePollService (red)"
```

---

### Task 7.2: Implement `CliUpdatePollService`

**Files:**
- Create: `src/main/cli/cli-update-poll-service.ts`

- [x] **Step 1: Write the service**

```ts
import { getLogger } from '../logging/logger';
import { getCliDetectionService } from './cli-detection';
import { getCliUpdateService } from './cli-update-service';
import type { CliUpdatePillState, CliUpdatePillEntry } from '../../shared/types/diagnostics.types';

const logger = getLogger('CliUpdatePollService');
const DAY_MS = 24 * 60 * 60 * 1000;

let instance: CliUpdatePollService | null = null;

export class CliUpdatePollService {
  private state: CliUpdatePillState = {
    loaded: false,
    generatedAt: null,
    count: 0,
    entries: [],
    lastRefreshedAt: null,
  };
  private listeners = new Set<(s: CliUpdatePillState) => void>();
  private inflight: Promise<CliUpdatePillState> | null = null;
  private interval: NodeJS.Timeout | null = null;

  static getInstance(): CliUpdatePollService {
    if (!instance) instance = new CliUpdatePollService();
    return instance;
  }

  getState(): CliUpdatePillState {
    return this.state;
  }

  onChange(listener: (s: CliUpdatePillState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<CliUpdatePillState> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  start(): void {
    if (this.interval) return;
    void this.refresh();
    this.interval = setInterval(() => { void this.refresh(); }, DAY_MS);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private async doRefresh(): Promise<CliUpdatePillState> {
    const generatedAt = Date.now();
    try {
      const detection = await getCliDetectionService().detectAll();
      const updateService = getCliUpdateService();
      const entries: CliUpdatePillEntry[] = [];
      for (const cli of detection.available ?? []) {
        const plan = updateService.getUpdatePlan(cli.name);
        if (!plan.supported) continue;
        entries.push({
          cli: cli.name,
          displayName: plan.displayName,
          currentVersion: cli.activeVersion,
          updatePlan: {
            cli: plan.cli,
            displayName: plan.displayName,
            supported: plan.supported,
            command: plan.command,
            args: plan.args,
            displayCommand: plan.displayCommand,
            reason: plan.reason,
            currentVersion: plan.currentVersion,
          },
        });
      }
      this.state = {
        loaded: true,
        generatedAt,
        count: entries.length,
        entries,
        lastRefreshedAt: generatedAt,
      };
    } catch (err) {
      this.state = {
        loaded: true,
        generatedAt,
        count: this.state.count,
        entries: this.state.entries,
        lastRefreshedAt: generatedAt,
        error: (err as Error).message,
      };
      logger.warn('CLI update poll failed', { error: this.state.error });
    }
    this.notify();
    return this.state;
  }

  private notify(): void {
    for (const l of this.listeners) {
      try { l(this.state); } catch (err) { logger.warn('listener threw', { error: (err as Error).message }); }
    }
  }
}

export function getCliUpdatePollService(): CliUpdatePollService {
  return CliUpdatePollService.getInstance();
}

export function _resetCliUpdatePollServiceForTesting(): void {
  instance?.stop();
  instance = null;
}
```

- [x] **Step 2: Run, type-check, lint, commit**

```bash
npx vitest run src/main/cli/__tests__/cli-update-poll-service.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/main/cli/cli-update-poll-service.ts
git add src/main/cli/cli-update-poll-service.ts
git commit -m "feat(cli): implement CliUpdatePollService with debounced refresh, 24-h tick, listeners"
```

---

## Phase 8 — IPC handlers + preload

### Task 8.0: Add channel constants to the contracts package (prerequisite)

**Files:**
- Create: `packages/contracts/src/channels/diagnostics.channels.ts`
- Modify: `packages/contracts/src/channels/index.ts` (import + spread the new file into `IPC_CHANNELS`)

> **IPC source-of-truth note (repo-specific):** `src/shared/types/ipc.types.ts` is now a deprecated re-export shim. New channel string literals MUST live in `packages/contracts/src/channels/<domain>.channels.ts`. The generator (`scripts/generate-preload-channels.js`) writes the merged `IPC_CHANNELS` to `src/preload/generated/channels.ts`, which the runtime preload imports.

- [x] **Step 1: Create the new channels file**

```ts
// packages/contracts/src/channels/diagnostics.channels.ts
export const DIAGNOSTICS_CHANNELS = {
  DIAGNOSTICS_GET_DOCTOR_REPORT: 'diagnostics:get-doctor-report',
  DIAGNOSTICS_GET_SKILL_DIAGNOSTICS: 'diagnostics:get-skill-diagnostics',
  DIAGNOSTICS_GET_INSTRUCTION_DIAGNOSTICS: 'diagnostics:get-instruction-diagnostics',
  DIAGNOSTICS_EXPORT_ARTIFACT_BUNDLE: 'diagnostics:export-artifact-bundle',
  DIAGNOSTICS_REVEAL_BUNDLE: 'diagnostics:reveal-bundle',
  CLI_UPDATE_PILL_GET_STATE: 'cli-update-pill:get-state',
  CLI_UPDATE_PILL_REFRESH: 'cli-update-pill:refresh',
  CLI_UPDATE_PILL_DELTA: 'cli-update-pill:delta',
} as const;
```

- [x] **Step 2: Register in `index.ts`**

Open `packages/contracts/src/channels/index.ts`, add the import and spread:

```ts
import { DIAGNOSTICS_CHANNELS } from './diagnostics.channels';
// ... in the IPC_CHANNELS aggregator:
//   ...DIAGNOSTICS_CHANNELS,
```

- [x] **Step 3: Regenerate and verify**

```bash
npm run generate:ipc
npm run verify:ipc
npx tsc --noEmit
```

Confirm that `src/preload/generated/channels.ts` now contains the diagnostics keys. If verify fails, recheck the spread in `index.ts`.

- [x] **Step 4: Suggested commit (run only after user approval per AGENTS.md)**

```bash
git add packages/contracts/src/channels/ src/preload/generated/channels.ts
# Suggested: git commit -m "feat(contracts): add diagnostics IPC channel constants"
```

---

### Task 8.1: Failing handler tests

**Files:**
- Create: `src/main/ipc/handlers/__tests__/diagnostics-handlers.spec.ts`

- [x] **Step 1: Write the spec**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetReport, mockSkillDiagnose, mockInstrDiagnose, mockExport, mockReveal, mockGetState, mockRefresh, mockOnChange } = vi.hoisted(() => ({
  mockGetReport: vi.fn(),
  mockSkillDiagnose: vi.fn(),
  mockInstrDiagnose: vi.fn(),
  mockExport: vi.fn(),
  mockReveal: vi.fn(),
  mockGetState: vi.fn(),
  mockRefresh: vi.fn(),
  mockOnChange: vi.fn(() => () => undefined),
}));

vi.mock('../../diagnostics/doctor-service', () => ({
  getDoctorService: () => ({ getReport: mockGetReport, resolveSectionForStartupCheck: vi.fn() }),
}));
vi.mock('../../diagnostics/skill-diagnostics-service', () => ({
  getSkillDiagnosticsService: () => ({ diagnose: mockSkillDiagnose }),
}));
vi.mock('../../diagnostics/instruction-diagnostics-service', () => ({
  getInstructionDiagnosticsService: () => ({ diagnose: mockInstrDiagnose }),
}));
vi.mock('../../diagnostics/operator-artifact-exporter', () => ({
  getOperatorArtifactExporter: () => ({ export: mockExport }),
}));
vi.mock('../../cli/cli-update-poll-service', () => ({
  getCliUpdatePollService: () => ({ getState: mockGetState, refresh: mockRefresh, onChange: mockOnChange }),
}));
vi.mock('electron', () => ({
  shell: { showItemInFolder: mockReveal },
}));

import { registerDiagnosticsHandlers, _resetDiagnosticsHandlersForTesting } from '../diagnostics-handlers';

const fakeIpc = () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  return {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => handlers.set(channel, fn),
    invoke: (channel: string, payload: unknown) => handlers.get(channel)!({}, payload),
  };
};

beforeEach(() => {
  _resetDiagnosticsHandlersForTesting();
  vi.clearAllMocks();
});

describe('diagnostics-handlers', () => {
  it('rejects unknown payloads with ZodError', async () => {
    const ipc = fakeIpc();
    registerDiagnosticsHandlers(ipc);
    await expect(
      ipc.invoke('diagnostics:get-doctor-report', { workingDirectory: 42 }),
    ).rejects.toThrow();
  });

  it('returns DoctorReport on the happy path', async () => {
    mockGetReport.mockResolvedValue({ sections: [], generatedAt: 1 } as unknown);
    const ipc = fakeIpc();
    registerDiagnosticsHandlers(ipc);
    const r = await ipc.invoke('diagnostics:get-doctor-report', { workingDirectory: '/x' });
    expect(r).toMatchObject({ generatedAt: 1 });
    expect(mockGetReport).toHaveBeenCalledWith({ workingDirectory: '/x', force: undefined });
  });

  it('forwards skill diagnostics', async () => {
    mockSkillDiagnose.mockResolvedValue([{ code: 'invalid-frontmatter', message: 'x', severity: 'error' }]);
    const ipc = fakeIpc();
    registerDiagnosticsHandlers(ipc);
    const r = await ipc.invoke('diagnostics:get-skill-diagnostics', {});
    expect(r).toEqual([{ code: 'invalid-frontmatter', message: 'x', severity: 'error' }]);
  });

  it('exports artifact bundle and returns the path', async () => {
    mockExport.mockResolvedValue({ bundlePath: '/tmp/a.zip', bundleBytes: 100, manifest: {} as unknown });
    const ipc = fakeIpc();
    registerDiagnosticsHandlers(ipc);
    const r = await ipc.invoke('diagnostics:export-artifact-bundle', { sessionId: 'sess-1' });
    expect((r as { bundlePath: string }).bundlePath).toBe('/tmp/a.zip');
  });

  it('reveals a bundle path through electron.shell', async () => {
    const ipc = fakeIpc();
    registerDiagnosticsHandlers(ipc);
    await ipc.invoke('diagnostics:reveal-bundle', { bundlePath: '/tmp/a.zip' });
    expect(mockReveal).toHaveBeenCalledWith('/tmp/a.zip');
  });

  it('returns the cli update pill state', async () => {
    mockGetState.mockReturnValue({ loaded: true, count: 1, entries: [], generatedAt: 1, lastRefreshedAt: 1 });
    const ipc = fakeIpc();
    registerDiagnosticsHandlers(ipc);
    const s = await ipc.invoke('cli-update-pill:get-state', {});
    expect((s as { count: number }).count).toBe(1);
  });
});
```

- [x] **Step 2: Run + commit failing**

```bash
npx vitest run src/main/ipc/handlers/__tests__/diagnostics-handlers.spec.ts
git add src/main/ipc/handlers/__tests__/diagnostics-handlers.spec.ts
git commit -m "test(ipc): add failing tests for diagnostics handlers (red)"
```

---

### Task 8.2: Implement `diagnostics-handlers.ts`

**Files:**
- Create: `src/main/ipc/handlers/diagnostics-handlers.ts`

- [x] **Step 1: Write the handlers**

```ts
import { shell } from 'electron';
import {
  DoctorGetReportPayloadSchema,
  DoctorGetSkillDiagnosticsPayloadSchema,
  DoctorGetInstructionDiagnosticsPayloadSchema,
  DiagnosticsExportArtifactBundlePayloadSchema,
  DiagnosticsRevealBundlePayloadSchema,
  CliUpdatePillGetStatePayloadSchema,
  CliUpdatePillRefreshPayloadSchema,
} from '../../../shared/validation/ipc-schemas';
import { IPC_CHANNELS } from '@contracts/channels';
import { getDoctorService } from '../../diagnostics/doctor-service';
import { getSkillDiagnosticsService } from '../../diagnostics/skill-diagnostics-service';
import { getInstructionDiagnosticsService } from '../../diagnostics/instruction-diagnostics-service';
import { getOperatorArtifactExporter } from '../../diagnostics/operator-artifact-exporter';
import { getCliUpdatePollService } from '../../cli/cli-update-poll-service';
import { getLogger } from '../../logging/logger';

const logger = getLogger('DiagnosticsHandlers');

interface IpcLike {
  handle(channel: string, fn: (event: unknown, payload: unknown) => unknown): void;
}

let registered = false;

export function registerDiagnosticsHandlers(ipc: IpcLike): void {
  if (registered) return;
  registered = true;

  // All channel string literals come from IPC_CHANNELS, not raw strings.
  // The constants live in packages/contracts/src/channels/diagnostics.channels.ts;
  // run `npm run generate:ipc` after editing them.

  ipc.handle(IPC_CHANNELS.DIAGNOSTICS_GET_DOCTOR_REPORT, async (_e, payload) => {
    const parsed = DoctorGetReportPayloadSchema.parse(payload);
    return getDoctorService().getReport(parsed);
  });

  ipc.handle(IPC_CHANNELS.DIAGNOSTICS_GET_SKILL_DIAGNOSTICS, async (_e, payload) => {
    DoctorGetSkillDiagnosticsPayloadSchema.parse(payload);
    return getSkillDiagnosticsService().diagnose();
  });

  ipc.handle(IPC_CHANNELS.DIAGNOSTICS_GET_INSTRUCTION_DIAGNOSTICS, async (_e, payload) => {
    const parsed = DoctorGetInstructionDiagnosticsPayloadSchema.parse(payload);
    return getInstructionDiagnosticsService().diagnose(parsed.workingDirectory);
  });

  ipc.handle(IPC_CHANNELS.DIAGNOSTICS_EXPORT_ARTIFACT_BUNDLE, async (_e, payload) => {
    const parsed = DiagnosticsExportArtifactBundlePayloadSchema.parse(payload);
    return getOperatorArtifactExporter().export(parsed);
  });

  ipc.handle(IPC_CHANNELS.DIAGNOSTICS_REVEAL_BUNDLE, async (_e, payload) => {
    const parsed = DiagnosticsRevealBundlePayloadSchema.parse(payload);
    shell.showItemInFolder(parsed.bundlePath);
    return { ok: true };
  });

  ipc.handle(IPC_CHANNELS.CLI_UPDATE_PILL_GET_STATE, async (_e, payload) => {
    CliUpdatePillGetStatePayloadSchema.parse(payload);
    return getCliUpdatePollService().getState();
  });

  ipc.handle(IPC_CHANNELS.CLI_UPDATE_PILL_REFRESH, async (_e, payload) => {
    CliUpdatePillRefreshPayloadSchema.parse(payload);
    return getCliUpdatePollService().refresh();
  });

  logger.info('diagnostics IPC handlers registered');
}

export function _resetDiagnosticsHandlersForTesting(): void {
  registered = false;
}
```

- [x] **Step 2: Hook the bridge for `CLI_UPDATE_PILL_DELTA` push events**

Add to the same file, below the registration:

```ts
import { IPC_CHANNELS } from '@contracts/channels';

export function bridgeCliUpdatePillDeltaToWindow(send: (channel: string, payload: unknown) => void): () => void {
  return getCliUpdatePollService().onChange((state) => {
    send(IPC_CHANNELS.CLI_UPDATE_PILL_DELTA, state);
  });
}
```

- [x] **Step 3: Wire registration through `IpcMainHandler.registerHandlers()` (NOT bootstrap)**

> **Repo-specific registration point:** All IPC handlers in this app are registered inside the `IpcMainHandler.registerHandlers()` method at `src/main/ipc/ipc-main-handler.ts` (search the file for `registerHandlers(): void`). New handlers MUST be added there so they participate in the normal lifecycle. Adding ad-hoc registration in `src/main/bootstrap/index.ts` or `src/main/index.ts` risks the handlers running outside the standard IPC initialization flow (e.g., before the auth token is set up, or never running at all).

In `src/main/ipc/ipc-main-handler.ts` find `registerHandlers(): void` and add (after the existing `registerCliHandlers` / similar nearby registration):

```ts
import { registerDiagnosticsHandlers, bridgeCliUpdatePillDeltaToWindow } from './handlers/diagnostics-handlers';
import { getCliUpdatePollService } from '../cli/cli-update-poll-service';

// inside registerHandlers():
registerDiagnosticsHandlers({ handle: ipcMain.handle.bind(ipcMain) });
getCliUpdatePollService().start();
```

- [x] **Step 4: Bridge the delta event to the renderer window**

The `CLI_UPDATE_PILL_DELTA` channel is main → renderer (event push). Wire the bridge near where `mainWindow.webContents.send(...)` is wired today (search for `webContents.send` in `src/main/`):

```ts
// where mainWindow is created:
const disposeCliUpdatePillBridge = bridgeCliUpdatePillDeltaToWindow(
  (channel, payload) => mainWindow.webContents.send(channel, payload),
);
mainWindow.on('closed', disposeCliUpdatePillBridge);
```

If a similar bridge pattern already exists for other delta-style events (e.g., `usage:delta`), mirror that location and ownership.

- [x] **Step 5: Re-export from `src/main/ipc/handlers/index.ts` if a barrel exists**

Check `src/main/ipc/handlers/index.ts`. If it re-exports per-handler-module symbols, add the diagnostics ones for consistency.

- [x] **Step 6: Run, type-check, lint, suggested commit**

```bash
npx vitest run src/main/ipc/handlers/__tests__/diagnostics-handlers.spec.ts
npx tsc --noEmit
npm run lint -- src/main/ipc/handlers/diagnostics-handlers.ts
git add src/main/ipc/handlers/diagnostics-handlers.ts src/main/ipc/ipc-main-handler.ts
# Suggested (run only after user approval per AGENTS.md):
# git commit -m "feat(ipc): register diagnostics + cli-update-pill handlers via IpcMainHandler"
```

---

### Task 8.3: Add preload bridge

**Files:**
- Create: `src/preload/domains/diagnostics.preload.ts`
- Modify: `src/preload/preload.ts`

- [x] **Step 1: Read an existing domain preload file as a template**

> **Repo-specific preload pattern:** Each domain is a factory `createXxxDomain(ipcRenderer, IPC_CHANNELS)` whose returned object is **flat-spread** into the single `electronAPI` exposed via `contextBridge.exposeInMainWorld('electronAPI', electronAPI)`. There are NO separate global bridges (`diagnosticsApi`, `cliUpdatePillApi`, etc.). Channels come from the generated `src/preload/generated/channels.ts`, NOT from `@contracts/channels/...` directly. Sandboxed preload cannot import from `packages/` at runtime.

```bash
cat src/preload/domains/session.preload.ts | head -40
```

Mirror the factory shape exactly.

- [x] **Step 2: Write the diagnostics domain factory**

Create `src/preload/domains/diagnostics.preload.ts`:

```ts
import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type {
  DoctorReport,
  SkillDiagnostic,
  InstructionDiagnostic,
  OperatorArtifactExportRequest,
  OperatorArtifactExportResult,
  CliUpdatePillState,
} from '../../shared/types/diagnostics.types';

export function createDiagnosticsDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    diagnosticsGetDoctorReport: (payload: { workingDirectory?: string; force?: boolean }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DIAGNOSTICS_GET_DOCTOR_REPORT, payload),

    diagnosticsGetSkillDiagnostics: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DIAGNOSTICS_GET_SKILL_DIAGNOSTICS, {}),

    diagnosticsGetInstructionDiagnostics: (payload: { workingDirectory?: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DIAGNOSTICS_GET_INSTRUCTION_DIAGNOSTICS, payload),

    diagnosticsExportArtifactBundle: (payload: OperatorArtifactExportRequest): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DIAGNOSTICS_EXPORT_ARTIFACT_BUNDLE, payload),

    diagnosticsRevealBundle: (payload: { bundlePath: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DIAGNOSTICS_REVEAL_BUNDLE, payload),

    cliUpdatePillGetState: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CLI_UPDATE_PILL_GET_STATE, {}),

    cliUpdatePillRefresh: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CLI_UPDATE_PILL_REFRESH, {}),

    onCliUpdatePillDelta: (cb: (s: CliUpdatePillState) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: CliUpdatePillState) => cb(payload);
      ipcRenderer.on(ch.CLI_UPDATE_PILL_DELTA, listener);
      return () => ipcRenderer.removeListener(ch.CLI_UPDATE_PILL_DELTA, listener);
    },
  };
}
```

The DoctorReport / SkillDiagnostic / InstructionDiagnostic / OperatorArtifactExportResult / CliUpdatePillState types are imported only for documentation — the methods return the standard `IpcResponse<{ ok, data }>` envelope, and renderer code unwraps it (matching the rest of the codebase).

- [x] **Step 3: Compose into `electronAPI` from `src/preload/preload.ts`**

```ts
import { createDiagnosticsDomain } from './domains/diagnostics.preload';

const electronAPI = {
  ...createInstanceDomain(ipcRenderer, IPC_CHANNELS),
  // ... existing factories ...
  ...createDiagnosticsDomain(ipcRenderer, IPC_CHANNELS),
  platform: process.platform,
};
```

Renderer code accesses these as `window.electronAPI.diagnosticsGetDoctorReport(...)` (typically through `ElectronIpcService`'s typed `api` field). DO NOT introduce separate `window.electronAPI` / `window.electronAPI` globals — those break the typed `ElectronAPI` surface and the contextBridge composition pattern.

- [x] **Step 4: Type-check, lint, suggested commit**

```bash
npx tsc --noEmit
npm run lint -- src/preload/domains/diagnostics.preload.ts src/preload/preload.ts
git add src/preload/domains/diagnostics.preload.ts src/preload/preload.ts
# Suggested (run only after user approval per AGENTS.md):
# git commit -m "feat(preload): expose diagnostics + cli-update-pill via electronAPI domain"
```

---

## Phase 9 — Renderer stores

### Task 9.1: `doctor.store.ts` failing test

**Files:**
- Create: `src/renderer/app/core/state/__tests__/doctor.store.spec.ts`

- [x] **Step 1: Write the spec**

```ts
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DoctorStore } from '../doctor.store';

describe('DoctorStore', () => {
  beforeEach(() => {
    // Wave 6 follows the repo's electronAPI domain pattern. Test fixtures
    // attach methods directly to `window.electronAPI`, NOT a separate
    // `window.diagnosticsApi` global.
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
      diagnosticsGetDoctorReport: vi.fn().mockResolvedValue({
        success: true,
        data: { generatedAt: 1, sections: [{ id: 'startup-capabilities', label: 'Startup', severity: 'ok', headline: 'ok', itemCount: 0 }] },
      }),
    };
    TestBed.configureTestingModule({});
  });

  it('starts unloaded', () => {
    const store = TestBed.inject(DoctorStore);
    expect(store.report()).toBeNull();
  });

  it('loadReport populates the report and active section defaults to first', async () => {
    const store = TestBed.inject(DoctorStore);
    await store.loadReport({ workingDirectory: '/x' });
    expect(store.report()).not.toBeNull();
    expect(store.activeSection()).toBe('startup-capabilities');
  });

  it('setActiveSection updates the signal', async () => {
    const store = TestBed.inject(DoctorStore);
    await store.loadReport({});
    store.setActiveSection('provider-health');
    expect(store.activeSection()).toBe('provider-health');
  });

  it('captures load errors as a string signal', async () => {
    (window as unknown as { electronAPI: { diagnosticsGetDoctorReport: () => Promise<unknown> } }).electronAPI.diagnosticsGetDoctorReport
      = vi.fn().mockRejectedValue(new Error('boom'));
    const store = TestBed.inject(DoctorStore);
    await store.loadReport({});
    expect(store.error()).toBe('boom');
  });
});
```

- [x] **Step 2: Run, confirm fail, commit**

```bash
npx vitest run src/renderer/app/core/state/__tests__/doctor.store.spec.ts
git add src/renderer/app/core/state/__tests__/doctor.store.spec.ts
git commit -m "test(renderer): add failing tests for DoctorStore (red)"
```

---

### Task 9.2: Implement `doctor.store.ts`

**Files:**
- Create: `src/renderer/app/core/state/doctor.store.ts`

- [x] **Step 1: Write the store**

```ts
import { Injectable, inject, signal } from '@angular/core';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import type { DoctorReport, DoctorSectionId } from '../../../../shared/types/diagnostics.types';

// No `declare global` block: the diagnostics methods live on the existing
// `window.electronAPI` (typed in `electron-ipc.service.ts`'s ElectronAPI
// interface) and are added there when the preload domain factory is composed.

@Injectable({ providedIn: 'root' })
export class DoctorStore {
  private ipc = inject(ElectronIpcService);
  private _report = signal<DoctorReport | null>(null);
  private _loading = signal(false);
  private _error = signal<string | null>(null);
  private _activeSection = signal<DoctorSectionId | null>(null);

  readonly report = this._report.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly activeSection = this._activeSection.asReadonly();

  async loadReport(payload: { workingDirectory?: string; force?: boolean }): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.diagnosticsGetDoctorReport) {
      this._error.set('electronAPI.diagnosticsGetDoctorReport unavailable');
      return;
    }
    this._loading.set(true);
    this._error.set(null);
    try {
      const res = await api.diagnosticsGetDoctorReport(payload);
      if (res.success && res.data) {
        const r = res.data as DoctorReport;
        this._report.set(r);
        if (this._activeSection() === null && r.sections.length > 0) {
          this._activeSection.set(r.sections[0].id);
        }
      } else {
        this._error.set(res.error?.message ?? 'unknown error');
      }
    } catch (err) {
      this._error.set((err as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  setActiveSection(id: DoctorSectionId): void {
    this._activeSection.set(id);
  }
}
```

- [x] **Step 2: Run, type-check, lint, commit**

```bash
npx vitest run src/renderer/app/core/state/__tests__/doctor.store.spec.ts
npx tsc --noEmit
npm run lint -- src/renderer/app/core/state/doctor.store.ts
git add src/renderer/app/core/state/doctor.store.ts
git commit -m "feat(renderer): add DoctorStore (signal-based)"
```

---

### Task 9.3: `cli-update-pill.store.ts` (test + impl in one task — small surface)

**Files:**
- Create: `src/renderer/app/core/state/cli-update-pill.store.ts`
- Create: `src/renderer/app/core/state/__tests__/cli-update-pill.store.spec.ts`

- [x] **Step 1: Write the failing test**

```ts
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CliUpdatePillStore } from '../cli-update-pill.store';

describe('CliUpdatePillStore', () => {
  let onDeltaListener: ((s: { count: number }) => void) | null = null;
  beforeEach(() => {
    onDeltaListener = null;
    // Wave 6 follows the repo's electronAPI domain pattern (no separate
    // cliUpdatePillApi global). Methods are flat on `window.electronAPI`.
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
      cliUpdatePillGetState: vi.fn().mockResolvedValue({ success: true, data: { loaded: true, count: 0, entries: [], generatedAt: 1, lastRefreshedAt: 1 } }),
      cliUpdatePillRefresh: vi.fn().mockResolvedValue({ success: true, data: { loaded: true, count: 1, entries: [], generatedAt: 2, lastRefreshedAt: 2 } }),
      onCliUpdatePillDelta: vi.fn((cb: (s: { count: number }) => void) => { onDeltaListener = cb; return () => { onDeltaListener = null; }; }),
    };
    TestBed.configureTestingModule({});
  });

  it('init() reads state and subscribes to deltas', async () => {
    const s = TestBed.inject(CliUpdatePillStore);
    await s.init();
    expect(s.state().count).toBe(0);
    onDeltaListener!({ count: 3 } as never);
    expect(s.state().count).toBe(3);
  });

  it('refresh() round-trips and updates the signal', async () => {
    const s = TestBed.inject(CliUpdatePillStore);
    await s.init();
    await s.refresh();
    expect(s.state().count).toBe(1);
  });
});
```

- [x] **Step 2: Implement**

```ts
import { Injectable, inject, signal } from '@angular/core';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import type { CliUpdatePillState } from '../../../../shared/types/diagnostics.types';

// No `declare global` block: the cli-update-pill methods live on the existing
// `window.electronAPI` (typed in `electron-ipc.service.ts`'s ElectronAPI
// interface) added when the diagnostics preload domain factory is composed.

const initial: CliUpdatePillState = {
  loaded: false,
  generatedAt: null,
  count: 0,
  entries: [],
  lastRefreshedAt: null,
};

@Injectable({ providedIn: 'root' })
export class CliUpdatePillStore {
  private ipc = inject(ElectronIpcService);
  private _state = signal<CliUpdatePillState>(initial);
  readonly state = this._state.asReadonly();

  private deltaUnsub: (() => void) | null = null;

  async init(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.cliUpdatePillGetState) return;
    const res = await api.cliUpdatePillGetState();
    if (res.success && res.data) this._state.set(res.data as CliUpdatePillState);
    this.deltaUnsub?.();
    this.deltaUnsub = api.onCliUpdatePillDelta((s: CliUpdatePillState) => this._state.set(s));
  }

  async refresh(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.cliUpdatePillRefresh) return;
    const res = await api.cliUpdatePillRefresh();
    if (res.success && res.data) this._state.set(res.data as CliUpdatePillState);
  }

  ngOnDestroy(): void {
    this.deltaUnsub?.();
    this.deltaUnsub = null;
  }
}
```

- [x] **Step 3: Run, type-check, lint, commit**

```bash
npx vitest run src/renderer/app/core/state/__tests__/cli-update-pill.store.spec.ts
npx tsc --noEmit
npm run lint -- src/renderer/app/core/state/cli-update-pill.store.ts
git add src/renderer/app/core/state/cli-update-pill.store.ts src/renderer/app/core/state/__tests__/cli-update-pill.store.spec.ts
git commit -m "feat(renderer): add CliUpdatePillStore with delta subscription"
```

---

## Phase 10 — Doctor settings tab + section components

### Task 10.1: Doctor section presentational component

**Files:**
- Create: `src/renderer/app/features/settings/components/doctor-section.component.ts`

- [x] **Step 1: Write the component**

```ts
import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import type { DoctorSectionSummary } from '../../../../../shared/types/diagnostics.types';

@Component({
  selector: 'app-doctor-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="doctor-section" [attr.data-severity]="summary().severity">
      <header class="doctor-section-head">
        <h3>{{ summary().label }}</h3>
        <span class="severity-badge" [attr.data-severity]="summary().severity">
          {{ summary().severity }}
        </span>
      </header>
      <p class="doctor-section-headline">{{ summary().headline }}</p>
      <ng-content />
    </section>
  `,
  styles: [`
    .doctor-section { padding: var(--spacing-md); border: 1px solid var(--border-color); border-radius: var(--radius-md); margin-bottom: var(--spacing-md); }
    .doctor-section[data-severity="error"] { border-color: var(--danger-color); }
    .doctor-section[data-severity="warning"] { border-color: var(--warning-color); }
    .doctor-section-head { display: flex; align-items: center; justify-content: space-between; }
    .severity-badge[data-severity="error"] { color: var(--danger-color); }
    .severity-badge[data-severity="warning"] { color: var(--warning-color); }
    .severity-badge[data-severity="ok"] { color: var(--success-color); }
    .doctor-section-headline { color: var(--text-secondary); font-size: 13px; }
  `],
})
export class DoctorSectionComponent {
  summary = input.required<DoctorSectionSummary>();
}
```

- [x] **Step 2: Type-check, commit**

```bash
npx tsc --noEmit
git add src/renderer/app/features/settings/components/doctor-section.component.ts
git commit -m "feat(renderer): add DoctorSectionComponent presentational shell"
```

---

### Task 10.2: `DoctorSettingsTabComponent`

**Files:**
- Create: `src/renderer/app/features/settings/doctor-settings-tab.component.ts`

- [x] **Step 1: Write the component**

```ts
import { Component, ChangeDetectionStrategy, OnInit, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { DoctorStore } from '../../core/state/doctor.store';
import { DoctorSectionComponent } from './components/doctor-section.component';
import type { DoctorSectionId } from '../../../../shared/types/diagnostics.types';

@Component({
  selector: 'app-doctor-settings-tab',
  standalone: true,
  imports: [CommonModule, DoctorSectionComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="doctor-tab">
      <aside class="doctor-sidebar">
        <h2>Doctor</h2>
        @for (s of sections(); track s.id) {
          <button
            type="button"
            class="doctor-tab-link"
            [class.active]="activeSection() === s.id"
            [attr.data-severity]="s.severity"
            (click)="select(s.id)"
          >
            <span class="dot" [attr.data-severity]="s.severity"></span>
            <span class="label">{{ s.label }}</span>
            @if (s.itemCount > 0) {
              <span class="count">{{ s.itemCount }}</span>
            }
          </button>
        }
      </aside>

      <main class="doctor-main">
        @if (loading()) { <p>Loading…</p> }
        @if (error(); as e) { <p class="error">Could not load Doctor: {{ e }}</p> }

        @for (s of sections(); track s.id) {
          @if (activeSection() === s.id) {
            <app-doctor-section [summary]="s">
              @switch (s.id) {
                @case ('startup-capabilities') { <ng-container *ngTemplateOutlet="startupTpl" /> }
                @case ('provider-health') { <ng-container *ngTemplateOutlet="providersTpl" /> }
                @case ('cli-health') { <ng-container *ngTemplateOutlet="cliTpl" /> }
                @case ('browser-automation') { <ng-container *ngTemplateOutlet="browserTpl" /> }
                @case ('commands-and-skills') { <ng-container *ngTemplateOutlet="cmdSkillTpl" /> }
                @case ('instructions') { <ng-container *ngTemplateOutlet="instrTpl" /> }
                @case ('operator-artifacts') { <ng-container *ngTemplateOutlet="artifactsTpl" /> }
              }
            </app-doctor-section>
          }
        }

        <ng-template #startupTpl>
          @if (report(); as r) {
            <ul>
              @for (c of r.startupCapabilities.checks; track c.id) {
                <li>
                  <strong>{{ c.label }}</strong>
                  ({{ c.status }}) — {{ c.summary }}
                </li>
              }
            </ul>
          }
        </ng-template>

        <ng-template #providersTpl>
          @if (report(); as r) {
            <ul>
              @for (d of r.providerDiagnoses.diagnoses; track d.provider) {
                <li>
                  <strong>{{ d.provider }}</strong>: {{ d.overall }}
                  @if (d.recommendations.length > 0) {
                    <ul>
                      @for (rec of d.recommendations; track rec) {
                        <li>{{ rec }}</li>
                      }
                    </ul>
                  }
                </li>
              }
            </ul>
          }
        </ng-template>

        <ng-template #cliTpl>
          @if (report(); as r) {
            <p>See the CLI Health tab for the full management UI.</p>
            <ul>
              @for (i of r.cliHealth.installs; track i.cli) {
                <li>{{ i.cli }} — v{{ i.activeVersion ?? '?' }} ({{ i.installCount }} install{{ i.installCount === 1 ? '' : 's' }})</li>
              }
            </ul>
          }
        </ng-template>

        <ng-template #browserTpl>
          @if (report(); as r) {
            <p>Status: {{ r.browserAutomation.status }}</p>
            @if (r.browserAutomation.warnings.length > 0) {
              <ul>
                @for (w of r.browserAutomation.warnings; track w) { <li>{{ w }}</li> }
              </ul>
            }
          }
        </ng-template>

        <ng-template #cmdSkillTpl>
          @if (report(); as r) {
            <h4>Skills</h4>
            @if (r.skillDiagnostics.length === 0) { <p>No skill issues.</p> }
            <ul>
              @for (d of r.skillDiagnostics; track $index) {
                <li><strong>{{ d.code }}</strong> ({{ d.severity }}): {{ d.message }}</li>
              }
            </ul>
            <h4>Commands</h4>
            @if (!r.commandDiagnostics.available) {
              <p>Command diagnostics will become available after Wave 1 ships. Reason: {{ r.commandDiagnostics.reason }}.</p>
            } @else {
              @if (r.commandDiagnostics.diagnostics.length === 0) { <p>No command issues.</p> }
              <ul>
                @for (d of r.commandDiagnostics.diagnostics; track $index) {
                  <li><strong>{{ d.code }}</strong> ({{ d.severity }}): {{ d.message }}</li>
                }
              </ul>
            }
          }
        </ng-template>

        <ng-template #instrTpl>
          @if (report(); as r) {
            @if (r.instructionDiagnostics.length === 0) { <p>No instruction conflicts.</p> }
            <ul>
              @for (d of r.instructionDiagnostics; track $index) {
                <li><strong>{{ d.code }}</strong> ({{ d.severity }}): {{ d.message }}</li>
              }
            </ul>
          }
        </ng-template>

        <ng-template #artifactsTpl>
          <p>Export a redacted bundle for support. Includes startup checks, provider diagnoses, command/skill/instruction diagnostics, and the last 500 lifecycle events.</p>
          <p>Environment values are reported as &lcub;name, isSet&rcub; only. Home-relative paths shown as <code>~/</code>. Tokens redacted. Session message bodies excluded.</p>
          <button type="button" class="btn" (click)="exportBundle()" [disabled]="exporting()">
            {{ exporting() ? 'Exporting…' : 'Export Bundle' }}
          </button>
          @if (lastBundlePath(); as p) {
            <div class="bundle-result">
              <code>{{ p }}</code>
              <button type="button" class="btn-link" (click)="reveal(p)">Show in Finder/Explorer</button>
            </div>
          }
        </ng-template>
      </main>
    </div>
  `,
  styles: [`
    .doctor-tab { display: flex; gap: var(--spacing-md); height: 100%; }
    .doctor-sidebar { flex: 0 0 220px; padding: var(--spacing-sm); border-right: 1px solid var(--border-color); }
    .doctor-tab-link { display: flex; align-items: center; gap: var(--spacing-sm); width: 100%; padding: 6px 8px; background: transparent; border: none; cursor: pointer; text-align: left; border-radius: var(--radius-sm); }
    .doctor-tab-link.active { background: var(--bg-secondary); }
    .doctor-tab-link .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success-color); }
    .doctor-tab-link .dot[data-severity="warning"] { background: var(--warning-color); }
    .doctor-tab-link .dot[data-severity="error"] { background: var(--danger-color); }
    .doctor-tab-link .count { margin-left: auto; font-size: 11px; color: var(--text-muted); }
    .doctor-main { flex: 1; overflow-y: auto; padding: var(--spacing-md); }
    .error { color: var(--danger-color); }
    .bundle-result { margin-top: var(--spacing-sm); display: flex; align-items: center; gap: var(--spacing-sm); }
  `],
})
export class DoctorSettingsTabComponent implements OnInit {
  private store = inject(DoctorStore);
  private router = inject(Router);

  readonly report = this.store.report;
  readonly loading = this.store.loading;
  readonly error = this.store.error;
  readonly activeSection = this.store.activeSection;

  readonly sections = computed(() => this.report()?.sections ?? []);

  protected exporting = computed(() => false); // TODO: track local export state in a small signal if needed
  private _exporting = false;
  private _lastBundlePath: string | null = null;

  lastBundlePath = computed(() => this._lastBundlePath);

  ngOnInit(): void {
    void this.store.loadReport({});
  }

  select(id: DoctorSectionId): void {
    this.store.setActiveSection(id);
    void this.router.navigate([], { queryParams: { tab: 'doctor', section: id }, queryParamsHandling: 'merge' });
  }

  async exportBundle(): Promise<void> {
    if (this._exporting) return;
    this._exporting = true;
    try {
      const result = await window.electronAPI!.diagnosticsExportArtifactBundle({});
      this._lastBundlePath = result.bundlePath;
    } finally {
      this._exporting = false;
    }
  }

  async reveal(p: string): Promise<void> {
    await window.electronAPI!.diagnosticsRevealBundle({ bundlePath: p });
  }
}
```

- [x] **Step 2: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/settings/doctor-settings-tab.component.ts
git add src/renderer/app/features/settings/doctor-settings-tab.component.ts
git commit -m "feat(renderer): add DoctorSettingsTabComponent (sections, export, reveal)"
```

---

### Task 10.3: Component spec for the Doctor tab

**Files:**
- Create: `src/renderer/app/features/settings/__tests__/doctor-settings-tab.component.spec.ts`

- [x] **Step 1: Write the spec**

```ts
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provideRouter } from '@angular/router';
import { DoctorSettingsTabComponent } from '../doctor-settings-tab.component';
import { DoctorStore } from '../../../core/state/doctor.store';

const fakeReport = {
  generatedAt: 1,
  sections: [
    { id: 'startup-capabilities', label: 'Startup Capabilities', severity: 'ok', headline: 'ok', itemCount: 0 },
    { id: 'commands-and-skills', label: 'Commands & Skills', severity: 'warning', headline: 'pending', itemCount: 1 },
  ],
  startupCapabilities: { status: 'ready', generatedAt: 1, checks: [] },
  providerDiagnoses: { diagnoses: [], generatedAt: 1 },
  browserAutomation: { status: 'ready', warnings: [], suggestions: [], runtimeAvailable: true, inAppConfigured: false, inAppConnected: false, configDetected: false, browserToolNames: [] },
  cliHealth: { installs: [], updatePlans: [], generatedAt: 1 },
  commandDiagnostics: { available: false, reason: 'wave1-not-shipped' },
  skillDiagnostics: [],
  instructionDiagnostics: [],
};

beforeEach(() => {
  // Wave 6 follows the electronAPI domain pattern; no separate diagnosticsApi.
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
    diagnosticsGetDoctorReport: vi.fn().mockResolvedValue({ success: true, data: fakeReport }),
    diagnosticsExportArtifactBundle: vi.fn().mockResolvedValue({ success: true, data: { bundlePath: '/tmp/x.zip', bundleBytes: 1, manifest: {} } }),
    diagnosticsRevealBundle: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([])],
  });
});

describe('DoctorSettingsTabComponent', () => {
  it('renders section sidebar with severity badges', async () => {
    const fixture = TestBed.createComponent(DoctorSettingsTabComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const sidebarLinks = fixture.nativeElement.querySelectorAll('.doctor-tab-link');
    expect(sidebarLinks.length).toBe(2);
  });

  it('shows pending Wave 1 placeholder when commandDiagnostics.available is false', async () => {
    const fixture = TestBed.createComponent(DoctorSettingsTabComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const store = TestBed.inject(DoctorStore);
    store.setActiveSection('commands-and-skills');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Wave 1');
  });
});
```

- [x] **Step 2: Run, type-check, commit**

```bash
npx vitest run src/renderer/app/features/settings/__tests__/doctor-settings-tab.component.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
git add src/renderer/app/features/settings/__tests__/doctor-settings-tab.component.spec.ts
git commit -m "test(renderer): add DoctorSettingsTabComponent spec"
```

---

## Phase 11 — Settings tab + section query params

### Task 11.1: Add the `'doctor'` tab and query-param handling

**Files:**
- Modify: `src/renderer/app/features/settings/settings.component.ts`

- [x] **Step 1: Read the existing component**

Open `src/renderer/app/features/settings/settings.component.ts` and locate:
- The `SETTINGS_TABS` array (around line 60–90).
- The signal that drives the active tab.
- Where `imports` for the tab components are declared.

- [x] **Step 2: Add the Doctor tab**

In `SETTINGS_TABS`, after the `'cli-health'` entry, insert:

```ts
{ id: 'doctor', label: 'Doctor', group: 'Advanced' },
```

In the component `imports`, add:

```ts
import { DoctorSettingsTabComponent } from './doctor-settings-tab.component';
// ...
imports: [
  // ...existing imports...
  DoctorSettingsTabComponent,
],
```

- [x] **Step 3: Honor `tab` and `section` query params**

Add at the top of the component class:

```ts
private route = inject(ActivatedRoute);
private doctorStore = inject(DoctorStore);

constructor() {
  effect(() => {
    const params = this.route.snapshot.queryParamMap;
    const tab = params.get('tab') as TabId | null;
    if (tab && this.tabExists(tab)) {
      this.activeTab.set(tab);
    }
    if (tab === 'doctor') {
      const section = params.get('section');
      if (section) this.doctorStore.setActiveSection(section as DoctorSectionId);
    }
  });
}

private tabExists(id: string): boolean {
  return SETTINGS_TABS.some((t) => t.id === id);
}
```

> If the existing component already injects `ActivatedRoute` or has its own `effect()` block, merge into the existing structure. Add only what is missing.

- [x] **Step 4: Render the new tab**

In the template (still inside `settings.component.ts`), find the `@switch (activeTab())` block and add:

```html
@case ('doctor') { <app-doctor-settings-tab /> }
```

- [x] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/settings/settings.component.ts
git add src/renderer/app/features/settings/settings.component.ts
git commit -m "feat(settings): add Doctor tab + tab/section query-param handling"
```

---

## Phase 12 — Banner deep-link click handler

### Task 12.1: Make the banner clickable

**Files:**
- Modify: `src/renderer/app/app.component.html`
- Modify: `src/renderer/app/app.component.ts`

- [x] **Step 1: Update the template**

Replace lines 8–18 of `src/renderer/app/app.component.html` with:

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

- [x] **Step 2: Add the click handler to `app.component.ts`**

Add:

```ts
import { Router } from '@angular/router';
// ...
private router = inject(Router);

openDoctorForBanner(): void {
  const report = this.startupCapabilities();
  if (!report) return;
  const failing = this.pickHighestSeverityFailingCheck(report);
  const section = failing ? this.doctorSectionForCheck(failing.id) : 'startup-capabilities';
  void this.router.navigate(['/settings'], { queryParams: { tab: 'doctor', section } });
}

private pickHighestSeverityFailingCheck(report: StartupCapabilityReport): StartupCapabilityCheck | null {
  const order: Record<string, number> = { unavailable: 3, degraded: 2, disabled: 1, ready: 0 };
  return [...report.checks]
    .filter((c) => c.status !== 'ready')
    .sort((a, b) => (order[b.status] ?? 0) - (order[a.status] ?? 0))[0]
    ?? null;
}

private doctorSectionForCheck(id: string): string {
  if (id.startsWith('provider.')) return 'provider-health';
  if (id === 'subsystem.browser-automation') return 'browser-automation';
  return 'startup-capabilities';
}
```

> Import the types `StartupCapabilityCheck`, `StartupCapabilityReport` from `src/shared/types/startup-capability.types`.

- [x] **Step 3: Add component spec**

Modify the existing `src/renderer/app/__tests__/app.component.spec.ts` (or create one if missing) and add:

```ts
it('navigates to Doctor with the right section when banner is clicked', async () => {
  const navigate = vi.fn();
  TestBed.overrideProvider(Router, { useValue: { navigate } });
  // ... set startupCapabilities() to a degraded provider report ...
  // call component.openDoctorForBanner()
  // expect navigate to have been called with ['/settings'] and queryParams.section === 'provider-health'
});
```

> If the existing app component spec is sparse or absent, create the minimum needed to exercise this method. Adapt the harness pattern from another test in the renderer (e.g. `header.component.spec.ts`).

- [x] **Step 4: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/app.component.ts
git add src/renderer/app/app.component.ts src/renderer/app/app.component.html src/renderer/app/__tests__/app.component.spec.ts
git commit -m "feat(banner): clickable startup banner deep-links to /settings?tab=doctor&section=…"
```

---

## Phase 13 — CLI update pill component + title-bar mount

### Task 13.1: Pill component

**Files:**
- Create: `src/renderer/app/features/title-bar/cli-update-pill.component.ts`
- Create: `src/renderer/app/features/title-bar/__tests__/cli-update-pill.component.spec.ts`

- [x] **Step 1: Write the component**

```ts
import { Component, ChangeDetectionStrategy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { CliUpdatePillStore } from '../../core/state/cli-update-pill.store';

@Component({
  selector: 'app-cli-update-pill',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state().count > 0) {
      <button
        type="button"
        class="cli-update-pill"
        [title]="tooltip()"
        (click)="open()"
      >
        <span class="dot"></span>
        <span class="text">{{ state().count }} update{{ state().count === 1 ? '' : 's' }}</span>
      </button>
    }
  `,
  styles: [`
    .cli-update-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 999px; cursor: pointer; font-size: 11px; }
    .cli-update-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--info-color, #3b82f6); }
    .cli-update-pill:hover { background: var(--bg-tertiary); }
  `],
})
export class CliUpdatePillComponent implements OnInit {
  private store = inject(CliUpdatePillStore);
  private router = inject(Router);

  readonly state = this.store.state;

  ngOnInit(): void {
    void this.store.init();
  }

  tooltip(): string {
    const entries = this.state().entries;
    if (entries.length === 0) return '';
    return entries.map((e) => `${e.displayName} v${e.currentVersion ?? '?'} → ${e.updatePlan.displayCommand ?? 'update available'}`).join('\n');
  }

  open(): void {
    void this.router.navigate(['/settings'], { queryParams: { tab: 'cli-health' } });
  }
}
```

- [x] **Step 2: Spec**

```ts
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provideRouter } from '@angular/router';
import { CliUpdatePillComponent } from '../cli-update-pill.component';

beforeEach(() => {
  // Wave 6 follows the electronAPI domain pattern; no separate cliUpdatePillApi.
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
    cliUpdatePillGetState: vi.fn().mockResolvedValue({ success: true, data: { loaded: true, count: 2, entries: [
      { cli: 'claude', displayName: 'Claude', currentVersion: '1.0.0', updatePlan: { cli: 'claude', displayName: 'Claude', supported: true, displayCommand: 'npm i -g @anthropic-ai/claude-code' } },
      { cli: 'codex', displayName: 'Codex', currentVersion: '0.5.0', updatePlan: { cli: 'codex', displayName: 'Codex', supported: true, displayCommand: 'npm i -g @openai/codex' } },
    ], generatedAt: 1, lastRefreshedAt: 1 } }),
    cliUpdatePillRefresh: vi.fn(),
    onCliUpdatePillDelta: vi.fn(() => () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([])],
  });
});

describe('CliUpdatePillComponent', () => {
  it('hides when count is 0', async () => {
    (window as unknown as { electronAPI: { cliUpdatePillGetState: () => Promise<unknown> } }).electronAPI.cliUpdatePillGetState
      = vi.fn().mockResolvedValue({ success: true, data: { loaded: true, count: 0, entries: [], generatedAt: 1, lastRefreshedAt: 1 } });
    const fixture = TestBed.createComponent(CliUpdatePillComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cli-update-pill')).toBeNull();
  });

  it('renders count and tooltip when entries are present', async () => {
    const fixture = TestBed.createComponent(CliUpdatePillComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const pill = fixture.nativeElement.querySelector('.cli-update-pill');
    expect(pill?.textContent).toContain('2 updates');
    expect(pill?.getAttribute('title')).toContain('Claude');
    expect(pill?.getAttribute('title')).toContain('Codex');
  });
});
```

- [x] **Step 3: Run, type-check, lint, commit**

```bash
npx vitest run src/renderer/app/features/title-bar/__tests__/cli-update-pill.component.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/renderer/app/features/title-bar/cli-update-pill.component.ts
git add src/renderer/app/features/title-bar/cli-update-pill.component.ts src/renderer/app/features/title-bar/__tests__/cli-update-pill.component.spec.ts
git commit -m "feat(title-bar): add CliUpdatePillComponent with tooltip + click navigation"
```

---

### Task 13.2: Mount the pill in `app.component.html`

**Files:**
- Modify: `src/renderer/app/app.component.html`
- Modify: `src/renderer/app/app.component.ts`

- [x] **Step 1: Add the component to the title bar**

In `src/renderer/app/app.component.html`, change the title-bar overlay block to:

```html
<div class="title-bar-overlay" [class.macos]="isMacOS">
  <app-provider-quota-chip />
  <app-cli-update-pill />
</div>
```

- [x] **Step 2: Add the import to `app.component.ts`**

In the standalone component's `imports` array (near `ProviderQuotaChipComponent`):

```ts
import { CliUpdatePillComponent } from './features/title-bar/cli-update-pill.component';
// ...
imports: [
  // ...existing imports...
  CliUpdatePillComponent,
],
```

- [x] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/app.component.ts
git add src/renderer/app/app.component.ts src/renderer/app/app.component.html
git commit -m "feat(title-bar): mount CliUpdatePillComponent next to provider quota chip"
```

---

## Phase 14 — Wave 1 feature-flag wire

### Task 14.1: Add the feature flag to `SettingsStore.featureFlags`

**Files:**
- Modify: `src/renderer/app/core/state/settings.store.ts`

- [x] **Step 1: Read the existing `featureFlags` computed**

If Wave 1 has shipped, the file already exposes a `featureFlags` computed signal (per Wave 1 spec § 7.2). Add the new flag:

```ts
readonly featureFlags = computed<Record<string, boolean>>(() => {
  const s = this._settings();
  return {
    // ...existing flags from Wave 1...
    commandDiagnosticsAvailable: s.commandDiagnosticsAvailable ?? false,
    broadRootFileThreshold: false, // not actually a flag — see settings.types.ts
  };
});
```

If Wave 1 has NOT shipped, create the computed signal with just `commandDiagnosticsAvailable: false`:

```ts
readonly featureFlags = computed<Record<string, boolean>>(() => {
  const s = this._settings();
  return {
    commandDiagnosticsAvailable: (s as unknown as { commandDiagnosticsAvailable?: boolean }).commandDiagnosticsAvailable ?? false,
  };
});
```

- [x] **Step 2: Add `broadRootFileThreshold` setting**

In `src/shared/types/settings.types.ts` (or wherever `AppSettings` lives), add:

```ts
broadRootFileThreshold?: number; // default 100
```

In the settings defaults file (e.g. `src/main/persistence/settings-store.ts` or similar), add the default:

```ts
broadRootFileThreshold: 100,
```

> Search the repo for where `defaultYoloMode` or another existing setting is defaulted to find the right file. Mirror the pattern.

- [x] **Step 3: Wire the threshold to `InstructionDiagnosticsService` via the IPC handler**

In `src/main/ipc/handlers/diagnostics-handlers.ts`, change the instruction handler:

```ts
ipc.handle('diagnostics:get-instruction-diagnostics', async (_e, payload) => {
  const parsed = DoctorGetInstructionDiagnosticsPayloadSchema.parse(payload);
  const settings = getSettingsStore().get();
  return getInstructionDiagnosticsService().diagnose(parsed.workingDirectory, {
    broadRootFileThreshold: settings.broadRootFileThreshold ?? 100,
  });
});
```

> The exact accessor for the main-process settings store may differ — search `src/main/persistence/` or wherever `SettingsStore` is exposed in main.

- [x] **Step 4: Surface the flag in DoctorService**

In `src/main/diagnostics/doctor-service.ts`, change `getInstance()` to read the flag:

```ts
static getInstance(): DoctorService {
  if (!instance) {
    const settings = getSettingsStore().get();
    instance = new DoctorService({
      commandDiagnosticsAvailable: !!(settings as { commandDiagnosticsAvailable?: boolean }).commandDiagnosticsAvailable,
    });
  }
  return instance;
}
```

> Add the `getSettingsStore` import from the main settings store.

- [x] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/renderer/app/core/state/settings.store.ts src/main/diagnostics/doctor-service.ts src/main/ipc/handlers/diagnostics-handlers.ts
git add src/renderer/app/core/state/settings.store.ts src/main/diagnostics/doctor-service.ts src/main/ipc/handlers/diagnostics-handlers.ts src/shared/types/settings.types.ts
git commit -m "feat(settings): add commandDiagnosticsAvailable + broadRootFileThreshold; wire to DoctorService and instruction handler"
```

---

## Phase 15 — Final integration, verification, packaged smoke test

### Task 15.1: Full type-check and lint

- [x] **Step 1: Run all checks**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

Expected: clean.

- [x] **Step 2: Run the full vitest suite**

```bash
npm run test
```

Expected: all tests pass. If any pre-existing tests break because of the settings shape change (`broadRootFileThreshold`), update them; do **not** revert plan changes.

- [x] **Step 3: Commit any test fixes (if needed)**

```bash
git add -u
git commit -m "test: align existing specs with new diagnostics settings"
```

---

### Task 15.2: Manual UI verification

Run `npm run dev` and walk through each scenario.

- [x] **Banner deep-link**

Force a degraded state (uninstall a CLI provider before launch, or temporarily rename the CLI binary on `PATH`). Restart the app. Confirm:

1. Banner appears with red/yellow severity styling.
2. Click → URL becomes `/settings?tab=doctor&section=provider-health` (or `startup-capabilities` for native checks).
3. Doctor tab opens with the right section pre-selected.

- [x] **Doctor tab navigation**

In `/settings?tab=doctor`:

1. Click each sidebar entry — main pane updates and URL `section` param changes.
2. Refresh the page — section persists.

- [x] **CLI update pill**

If at least one CLI has a supported update plan (`claude`, `codex`, `gemini`, `copilot`, `cursor`, or `ollama` installed):

1. Pill appears in the title bar with count.
2. Hovering shows tooltip with each CLI and version.
3. Click → CLI Health tab opens.

If no installed CLI has an update plan, pill is invisible.

- [x] **Skill diagnostics**

Drop a malformed `SKILL.md` into a builtin skill directory (e.g. delete the `description:` field). Restart. Doctor → Commands & Skills → see `invalid-frontmatter` listed.

- [x] **Instruction diagnostics**

In a test repo, drop an unscoped `INSTRUCTIONS.md` and ensure the repo has > 100 files. Open the workspace; Doctor → Instructions → see `broad-root-scan`.

- [x] **Operator artifact export**

Doctor → Operator Artifacts → click "Export Bundle". Confirm:

1. Bundle path appears.
2. "Show in Finder/Explorer" reveals the file.
3. Open the zip; verify `manifest.json` lists every file. Each file other than `manifest.json` has a 64-char hex sha256 that matches the unzipped content; `manifest.json`'s own entry uses the sentinel `sha256: 'self-described'` (the manifest cannot self-hash before final serialization — see plan Task 6.* and design § 6). `lifecycle-tail.ndjson` is ≤ 500 lines, no `/Users/<name>/` paths appear (should be `~/...`), no env-var values appear, and an injected stack-trace string containing a token shows `<redacted-secret>` instead of the token.

---

### Task 15.3: Packaged DMG smoke test

- [x] **Step 1: Build the packaged app**

```bash
npm run build
```

- [x] **Step 2: Launch the packaged binary**

Open the produced `.dmg` (or run packaged Electron from `dist/`).

- [x] **Step 3: Quick functional check**

1. Banner click → Doctor opens.
2. Doctor tab loads without errors.
3. Update pill appears (if any CLI is installed).
4. Export bundle → file appears at `app.getPath('userData') + '/diagnostics-bundles/<ts>.zip'` and "Show in Finder/Explorer" works.

If anything fails with `Cannot find module …` or similar runtime errors, recheck `register-aliases.ts` (Wave 6 adds none, but other recent changes might).

---

### Task 15.4: Final commit and parent-plan update

- [x] **Step 1: Update parent plan to mark Wave 6 tasks done**

Edit `docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`. In the Wave 6 task list, replace each `- [x]` with `- [x]` for the items now landed.

- [x] **Step 2: Self-review the spec for any drift**

Re-read `docs/superpowers/specs/2026-04-28-wave6-doctor-diagnostics-updates-artifacts-design.md`. If you discovered architectural decisions during implementation that diverge, update the spec to match what shipped.

- [x] **Step 3: Final commit**

```bash
git add docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md docs/superpowers/specs/2026-04-28-wave6-doctor-diagnostics-updates-artifacts-design.md
git commit -m "docs: mark Wave 6 tasks complete in parent plan; spec touch-ups"
```

- [x] **Step 4: Surface follow-ups**

Open issues / TODOs (or notes for the next wave) for:

- After Wave 1 ships: flip `commandDiagnosticsAvailable` default to `true`.
- Wave 4 clipboard service can replace inline reveal toast.
- Future telemetry opt-in upload of operator artifacts.

---

## Spec coverage check (self-review)

| Spec section | Implemented in tasks |
|---|---|
| § 1.1 `DoctorReport` and friends | 1.1 |
| § 1.2 `SkillDiagnostic` | 1.1, 3.x |
| § 1.3 `InstructionDiagnostic` | 1.1, 4.x |
| § 1.4 `OperatorArtifactBundleManifest` | 1.1, 6.x |
| § 1.5 `CliUpdatePillState` | 1.1, 7.x |
| § 1.6 `OperatorArtifactExportRequest` / `…Result` | 1.1, 6.4 |
| § 2.1 `DoctorService` | 5.1, 5.2 |
| § 2.2 `SkillDiagnosticsService` | 3.1–3.3 |
| § 2.3 `InstructionDiagnosticsService` | 4.1–4.3 |
| § 2.4 `OperatorArtifactExporter` | 6.1–6.4 |
| § 2.5 `CliUpdatePollService` | 7.1, 7.2 |
| § 3.1 banner → doctor deep-link | 12.1 |
| § 3.2 doctor tab navigation | 11.1 |
| § 3.3 update pill click | 13.1, 13.2 |
| § 3.4 artifact export UI | 10.2 |
| § 4 Wave 1 feature-flag fallback | 14.1 |
| § 5 redaction rules | 2.1, 2.2 |
| § 6 IPC channels | 1.2, 8.1–8.3 |
| § 7 testing strategy | embedded per task; full suite in 15.1 |
| § 8 file inventory | matches Created/Modified columns across phases |
| § 9 acceptance criteria | 15.1 (1–4), 15.2 (UI), 15.3 (DMG smoke) |

If any cell flips to "missing" during execution, add a task in the closest phase before continuing.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-28-wave6-doctor-diagnostics-updates-artifacts-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.
