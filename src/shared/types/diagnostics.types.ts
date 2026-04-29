import type { CommandDiagnostic } from './command.types';
import type { StartupCapabilityReport } from './startup-capability.types';

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
}

export interface ProviderDiagnosisSnapshot {
  provider: string;
  overall: string;
  probes: ProviderProbeSnapshot[];
  recommendations: string[];
  timestamp: number;
  error?: string;
}

export interface CliInstallSummary {
  path: string;
  version?: string;
  installed: boolean;
  error?: string;
}

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
  | 'duplicate-trigger';

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
  | 'resolution-failed';

export interface InstructionDiagnostic {
  code: InstructionDiagnosticCode;
  severity: 'warning' | 'error';
  message: string;
  filePath?: string;
  sourceKind?: string;
  sourceScope?: string;
  candidates?: string[];
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
  updatePlan: CliUpdatePlanSummary;
}

export interface CliUpdatePillState {
  generatedAt: number;
  count: number;
  entries: CliUpdatePillEntry[];
  error?: string;
}
