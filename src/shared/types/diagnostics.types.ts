import type { CommandDiagnostic } from './command.types';
import type { StartupCapabilityReport } from './startup-capability.types';
import type { ProviderProbeErrorKind, RepairAction } from './provider-doctor.types';

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
  detail?: string;
}

export interface ProviderProbeSnapshot {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'timeout';
  message: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
  /** Present on failed probes; absent on pass/skip/timeout. */
  errorKind?: ProviderProbeErrorKind;
}

export interface ProviderDiagnosisSnapshot {
  provider: string;
  overall: string;
  probes: ProviderProbeSnapshot[];
  recommendations: string[];
  /** Structured repair actions derived from failed probe error kinds. */
  repairActions: RepairAction[];
  timestamp: number;
  error?: string;
}

export interface CliInstallSummary {
  path: string;
  version?: string;
  installed: boolean;
  error?: string;
}

/**
 * How a CLI update would be applied. Set at plan-build time. Drives the
 * auto-apply safety gate (npm/bun/pnpm/self-update are unattended-safe) and the
 * update concurrency lock.
 */
export type CliUpdateStrategy = 'npm' | 'bun' | 'pnpm' | 'self-update' | 'gh-extension' | 'homebrew' | 'install-script';

export interface CliUpdatePlanSummary {
  cli: string;
  displayName: string;
  supported: boolean;
  command?: string;
  args?: string[];
  displayCommand?: string;
  activePath?: string;
  currentVersion?: string;
  reason?: string;
  /** Present only on a supported plan; absent ⇒ not auto-apply-safe. */
  strategy?: CliUpdateStrategy;
}

export interface CliHealthEntry {
  cli: string;
  displayName: string;
  installed: boolean;
  activePath?: string;
  activeVersion?: string;
  installs: CliInstallSummary[];
  updatePlan: CliUpdatePlanSummary;
  error?: string;
}

export interface CliHealthSnapshot {
  installs: CliHealthEntry[];
  updatePlans: CliUpdatePlanSummary[];
  generatedAt: number;
}

export interface BrowserAutomationHealthSnapshot {
  status: 'ready' | 'degraded' | 'unavailable';
  rawStatus: 'ready' | 'partial' | 'missing';
  checkedAt: number;
  lastSuccessfulCheckAt?: number;
  runtimeAvailable: boolean;
  runtimeCommand?: string;
  nodeAvailable: boolean;
  inAppConfigured: boolean;
  inAppConnected: boolean;
  inAppToolCount: number;
  configDetected: boolean;
  browserToolNames: string[];
  warnings: string[];
  suggestions: string[];
}

export type CommandDiagnosticsSnapshot =
  | {
      available: true;
      diagnostics: CommandDiagnostic[];
      scanDirs: string[];
      generatedAt: number;
    }
  | {
      available: false;
      reason: string;
      diagnostics: [];
      scanDirs: [];
      generatedAt: number;
    };

export type SkillDiagnosticCode =
  | 'invalid-frontmatter'
  | 'unreadable-file'
  | 'missing-file'
  | 'duplicate-skill-name'
  | 'duplicate-trigger'
  /** The skill mandates a tool this build does not expose to agent sessions. */
  | 'tool-surface-mismatch'
  /** A phrase trigger so short/generic it will fire on unrelated messages. */
  | 'over-broad-trigger'
  /** Description too short to support semantic matching or human review. */
  | 'weak-description'
  /** Core body large enough to meaningfully tax the context budget. */
  | 'oversized-core';

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: 'warning' | 'error';
  message: string;
  skillId?: string;
  skillName?: string;
  trigger?: string;
  filePath?: string;
  candidates?: string[];
}

export type InstructionDiagnosticCode =
  | 'resolver-warning'
  | 'conflicting-instruction-sources'
  | 'multiple-path-specific-instructions'
  | 'broad-root-scan'
  | 'unreadable-source'
  | 'resolution-failed'
  | 'instruction-trust';

export interface InstructionDiagnostic {
  code: InstructionDiagnosticCode;
  severity: 'warning' | 'error';
  message: string;
  filePath?: string;
  sourceKind?: string;
  sourceScope?: string;
  candidates?: string[];
  /** WS12 instruction-trust rows: verdict + current hash (the approval anchor). */
  trust?: 'approved' | 'changed' | 'unknown';
  sha256?: string;
  /** WS12: highest scanner severity for the file, when scanned. */
  scanSeverity?: 'info' | 'warn' | 'critical';
}

export type LoopRecipeDiagnosticKind =
  | 'user-override'
  | 'malformed-pack'
  | 'missing-stage-file'
  | 'unknown-recipe-fallback';

/**
 * Fable WS6: a loop-recipe pack collision or fallback, surfaced in the Doctor
 * "Commands & Skills" section. `user-override` is informational (a user pack
 * intentionally shadows a built-in); the rest indicate a broken pack that fell
 * back to a built-in / default.
 */
export interface LoopRecipeDiagnostic {
  recipe: string;
  kind: LoopRecipeDiagnosticKind;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  generatedAt: number;
  startupCapabilities: StartupCapabilityReport | null;
  providerDiagnoses: ProviderDiagnosisSnapshot[];
  cliHealth: CliHealthSnapshot;
  browserAutomation: BrowserAutomationHealthSnapshot | null;
  commandDiagnostics: CommandDiagnosticsSnapshot;
  skillDiagnostics: SkillDiagnostic[];
  instructionDiagnostics: InstructionDiagnostic[];
  loopRecipeDiagnostics: LoopRecipeDiagnostic[];
  sections: DoctorSectionSummary[];
}

export interface OperatorArtifactManifestFile {
  name: string;
  bytes: number;
  sha256: string;
  source: string;
  redacted: boolean;
}

export interface OperatorArtifactBundleManifest {
  schemaVersion: 1;
  generatedAt: number;
  appVersion?: string;
  platform: string;
  selectedSessionId?: string;
  workingDirectory?: string;
  files: OperatorArtifactManifestFile[];
  redactionPolicy: {
    homePaths: 'home-relative';
    secrets: 'redacted';
    environmentVariables: 'presence-only';
    sessionMessageBodies: 'omitted';
  };
}

export interface OperatorArtifactExportRequest {
  sessionId?: string;
  workingDirectory?: string;
  force?: boolean;
}

export interface OperatorArtifactExportResult {
  bundlePath: string;
  bundleBytes: number;
  manifest: OperatorArtifactBundleManifest;
}

export interface CliUpdatePillEntry {
  cli: string;
  displayName: string;
  currentVersion?: string;
  /**
   * The latest version known to be available for this CLI, when we've been
   * able to query a registry. `undefined` means "not checked yet" — distinct
   * from "checked and current".
   */
  latestVersion?: string;
  /**
   * True only when we've confirmed an update is actually available
   * (latestVersion > currentVersion). The title-bar pill counts only entries
   * with this flag set, so it stays hidden when we merely *could* run an
   * updater but don't yet know whether one is needed.
   */
  updateAvailable?: boolean;
  updatePlan: CliUpdatePlanSummary;
}

export interface CliUpdatePillState {
  generatedAt: number;
  count: number;
  entries: CliUpdatePillEntry[];
  error?: string;
}
