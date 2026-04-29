import { getBrowserAutomationHealthService } from '../browser-automation/browser-automation-health';
import { getCapabilityProbe } from '../bootstrap/capability-probe';
import {
  CLI_REGISTRY,
  SUPPORTED_CLIS,
  getCliDetectionService,
} from '../cli/cli-detection';
import { getCliUpdateService } from '../cli/cli-update-service';
import { getCommandManager } from '../commands/command-manager';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import { getProviderDoctor } from '../providers/provider-doctor';
import type {
  BrowserAutomationHealthSnapshot,
  CliHealthEntry,
  CliHealthSnapshot,
  CliUpdatePlanSummary,
  CommandDiagnosticsSnapshot,
  DoctorReport,
  DoctorSectionId,
  DoctorSectionSummary,
  ProviderDiagnosisSnapshot,
} from '../../shared/types/diagnostics.types';
import type { StartupCapabilityCheck } from '../../shared/types/startup-capability.types';
import { getInstructionDiagnosticsService } from './instruction-diagnostics-service';
import { getSkillDiagnosticsService } from './skill-diagnostics-service';

const logger = getLogger('DoctorService');

const CACHE_TTL_MS = 30_000;
const PROVIDERS: { id: string; doctorKey: string; label: string }[] = [
  { id: 'claude', doctorKey: 'claude-cli', label: 'Claude Code' },
  { id: 'codex', doctorKey: 'codex-cli', label: 'OpenAI Codex' },
  { id: 'gemini', doctorKey: 'gemini-cli', label: 'Google Gemini' },
  { id: 'copilot', doctorKey: 'copilot', label: 'GitHub Copilot' },
  { id: 'cursor', doctorKey: 'cursor', label: 'Cursor' },
];

const SECTION_LABELS: Record<DoctorSectionId, string> = {
  'startup-capabilities': 'Startup Capabilities',
  'provider-health': 'Provider Health',
  'cli-health': 'CLI Health',
  'browser-automation': 'Browser Automation',
  'commands-and-skills': 'Commands & Skills',
  'instructions': 'Instructions',
  'operator-artifacts': 'Operator Artifacts',
};

interface CachedDoctorReport {
  key: string;
  generatedAt: number;
  report: DoctorReport;
}

export interface DoctorReportOptions {
  workingDirectory?: string;
  force?: boolean;
}

export class DoctorService {
  private static instance: DoctorService | null = null;
  private cache: CachedDoctorReport | null = null;

  static getInstance(): DoctorService {
    if (!this.instance) {
      this.instance = new DoctorService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async getReport(options: DoctorReportOptions = {}): Promise<DoctorReport> {
    const cacheKey = JSON.stringify({ workingDirectory: options.workingDirectory ?? '' });
    if (
      !options.force &&
      this.cache &&
      this.cache.key === cacheKey &&
      Date.now() - this.cache.generatedAt < CACHE_TTL_MS
    ) {
      return this.cache.report;
    }

    const settings = getSettingsManager().getAll();
    const generatedAt = Date.now();
    const [
      startupCapabilities,
      providerDiagnoses,
      cliHealth,
      browserAutomation,
      skillDiagnostics,
      instructionDiagnostics,
      commandDiagnostics,
    ] = await Promise.all([
      this.getStartupCapabilities(),
      this.getProviderDiagnoses(),
      this.getCliHealth(Boolean(options.force)),
      this.getBrowserAutomationHealth(),
      getSkillDiagnosticsService().collect().catch((error) => {
        logger.warn('Skill diagnostics failed', { error: String(error) });
        return [];
      }),
      options.workingDirectory
        ? getInstructionDiagnosticsService().collect({
            workingDirectory: options.workingDirectory,
            broadRootFileThreshold: settings.broadRootFileThreshold,
          }).catch((error) => {
            logger.warn('Instruction diagnostics failed', { error: String(error) });
            return [];
          })
        : Promise.resolve([]),
      this.getCommandDiagnostics(options.workingDirectory, settings.commandDiagnosticsAvailable),
    ]);

    const reportWithoutSections = {
      schemaVersion: 1 as const,
      generatedAt,
      startupCapabilities,
      providerDiagnoses,
      cliHealth,
      browserAutomation,
      commandDiagnostics,
      skillDiagnostics,
      instructionDiagnostics,
    };
    const report: DoctorReport = {
      ...reportWithoutSections,
      sections: this.buildSectionSummaries(reportWithoutSections),
    };

    this.cache = {
      key: cacheKey,
      generatedAt,
      report,
    };
    return report;
  }

  resolveSectionForStartupCheck(checkId: string): DoctorSectionId {
    if (checkId.startsWith('provider.')) return 'provider-health';
    if (checkId === 'subsystem.browser-automation') return 'browser-automation';
    if (checkId.startsWith('native.')) return 'startup-capabilities';
    if (checkId.startsWith('subsystem.')) return 'startup-capabilities';
    return 'startup-capabilities';
  }

  buildSectionSummaries(
    report: Omit<DoctorReport, 'sections'>,
  ): DoctorSectionSummary[] {
    const startupFailures = report.startupCapabilities?.checks.filter(
      (check) => check.status === 'degraded' || check.status === 'unavailable',
    ) ?? [];
    const providerFailures = report.providerDiagnoses.filter(
      (diagnosis) => diagnosis.error || diagnosis.overall === 'unhealthy' || diagnosis.overall === 'degraded',
    );
    const updaters = report.cliHealth.updatePlans.filter((plan) => plan.supported);
    const browserWarnings = report.browserAutomation?.warnings.length ?? 0;
    const commandCount = report.commandDiagnostics.available
      ? report.commandDiagnostics.diagnostics.length
      : 0;
    const skillErrors = report.skillDiagnostics.filter((item) => item.severity === 'error').length;
    const instructionErrors = report.instructionDiagnostics.filter((item) => item.severity === 'error').length;
    const instructionWarnings = report.instructionDiagnostics.filter((item) => item.severity === 'warning').length;

    return [
      {
        id: 'startup-capabilities',
        label: SECTION_LABELS['startup-capabilities'],
        severity: report.startupCapabilities?.status === 'failed'
          ? 'error'
          : startupFailures.length > 0 ? 'warning' : 'ok',
        headline: startupFailures.length === 0
          ? 'Startup checks ready'
          : `${startupFailures.length} startup check${startupFailures.length === 1 ? '' : 's'} need attention`,
      },
      {
        id: 'provider-health',
        label: SECTION_LABELS['provider-health'],
        severity: providerFailures.length > 0 ? 'warning' : 'ok',
        headline: providerFailures.length === 0
          ? 'Provider probes ready'
          : `${providerFailures.length} provider${providerFailures.length === 1 ? '' : 's'} degraded`,
      },
      {
        id: 'cli-health',
        label: SECTION_LABELS['cli-health'],
        severity: updaters.length > 0 ? 'info' : 'ok',
        headline: updaters.length === 0
          ? 'CLI updater status ready'
          : `${updaters.length} automatic CLI updater${updaters.length === 1 ? '' : 's'} configured`,
      },
      {
        id: 'browser-automation',
        label: SECTION_LABELS['browser-automation'],
        severity: report.browserAutomation?.status === 'unavailable'
          ? 'error'
          : report.browserAutomation?.status === 'degraded' ? 'warning' : 'ok',
        headline: browserWarnings === 0
          ? 'Browser automation ready or intentionally disabled'
          : `${browserWarnings} browser automation warning${browserWarnings === 1 ? '' : 's'}`,
      },
      {
        id: 'commands-and-skills',
        label: SECTION_LABELS['commands-and-skills'],
        severity: skillErrors > 0 ? 'error' : commandCount > 0 || report.skillDiagnostics.length > 0 ? 'warning' : 'ok',
        headline: commandCount + report.skillDiagnostics.length === 0
          ? report.commandDiagnostics.available ? 'No command or skill issues' : 'Command diagnostics unavailable'
          : `${commandCount + report.skillDiagnostics.length} command or skill diagnostic${commandCount + report.skillDiagnostics.length === 1 ? '' : 's'}`,
      },
      {
        id: 'instructions',
        label: SECTION_LABELS.instructions,
        severity: instructionErrors > 0 ? 'error' : instructionWarnings > 0 ? 'warning' : 'ok',
        headline: report.instructionDiagnostics.length === 0
          ? 'No instruction conflicts detected'
          : `${report.instructionDiagnostics.length} instruction diagnostic${report.instructionDiagnostics.length === 1 ? '' : 's'}`,
      },
      {
        id: 'operator-artifacts',
        label: SECTION_LABELS['operator-artifacts'],
        severity: 'info',
        headline: 'Redacted local support bundle available',
      },
    ];
  }

  private async getStartupCapabilities(): Promise<DoctorReport['startupCapabilities']> {
    try {
      return getCapabilityProbe().getLastReport() ?? await getCapabilityProbe().run();
    } catch (error) {
      logger.warn('Startup capability diagnostics failed', { error: String(error) });
      return null;
    }
  }

  private async getProviderDiagnoses(): Promise<ProviderDiagnosisSnapshot[]> {
    const doctor = getProviderDoctor();
    const results = await Promise.all(PROVIDERS.map(async (provider) => {
      try {
        const diagnosis = await doctor.diagnose(provider.doctorKey);
        return {
          provider: provider.id,
          overall: diagnosis.overall,
          probes: diagnosis.probes,
          recommendations: diagnosis.recommendations,
          timestamp: diagnosis.timestamp,
        };
      } catch (error) {
        return {
          provider: provider.id,
          overall: 'unknown',
          probes: [],
          recommendations: [],
          timestamp: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    return results;
  }

  private async getCliHealth(forceRefresh: boolean): Promise<CliHealthSnapshot> {
    const detectionService = getCliDetectionService();
    const updateService = getCliUpdateService();
    const detection = await detectionService.detectAll(forceRefresh);
    const detectedByName = new Map(detection.detected.map((cli) => [cli.name, cli]));

    const entries: CliHealthEntry[] = [];
    const updatePlans: CliUpdatePlanSummary[] = [];

    for (const cli of SUPPORTED_CLIS) {
      const detected = detectedByName.get(cli);
      const [installs, plan] = await Promise.all([
        detectionService.scanAllCliInstalls(cli).catch(() => []),
        updateService.getUpdatePlan(cli).catch((error) => ({
          cli,
          displayName: CLI_REGISTRY[cli]?.displayName ?? cli,
          supported: false,
          reason: error instanceof Error ? error.message : String(error),
        })),
      ]);
      const activeInstall = installs[0];
      const updatePlan = toUpdatePlanSummary(plan);
      updatePlans.push(updatePlan);
      entries.push({
        cli,
        displayName: CLI_REGISTRY[cli]?.displayName ?? cli,
        installed: Boolean(detected?.installed),
        activePath: activeInstall?.path ?? detected?.path,
        activeVersion: activeInstall?.version ?? detected?.version,
        installs: installs.map((install) => ({
          path: install.path,
          version: install.version,
          installed: install.installed,
          error: install.error,
        })),
        updatePlan,
        error: detected?.error,
      });
    }

    return {
      installs: entries,
      updatePlans,
      generatedAt: Date.now(),
    };
  }

  private async getBrowserAutomationHealth(): Promise<BrowserAutomationHealthSnapshot | null> {
    try {
      const health = await getBrowserAutomationHealthService().diagnose();
      return {
        status: health.status === 'ready'
          ? 'ready'
          : health.status === 'partial' ? 'degraded' : 'unavailable',
        rawStatus: health.status,
        checkedAt: health.checkedAt,
        lastSuccessfulCheckAt: health.lastSuccessfulCheckAt,
        runtimeAvailable: health.runtimeAvailable,
        runtimeCommand: health.runtimeCommand,
        nodeAvailable: health.nodeAvailable,
        inAppConfigured: health.inAppConfigured,
        inAppConnected: health.inAppConnected,
        inAppToolCount: health.inAppToolCount,
        configDetected: health.configDetected,
        browserToolNames: health.browserToolNames,
        warnings: health.warnings,
        suggestions: health.suggestions,
      };
    } catch (error) {
      logger.warn('Browser automation diagnostics failed', { error: String(error) });
      return null;
    }
  }

  private async getCommandDiagnostics(
    workingDirectory: string | undefined,
    available: boolean,
  ): Promise<CommandDiagnosticsSnapshot> {
    const generatedAt = Date.now();
    if (!available) {
      return {
        available: false,
        reason: 'Command diagnostics are disabled by settings.',
        diagnostics: [],
        scanDirs: [],
        generatedAt,
      };
    }

    if (!workingDirectory) {
      return {
        available: false,
        reason: 'Open a project to collect command diagnostics for that workspace.',
        diagnostics: [],
        scanDirs: [],
        generatedAt,
      };
    }

    try {
      const snapshot = await getCommandManager().getAllCommandsSnapshot(workingDirectory);
      return {
        available: true,
        diagnostics: snapshot.diagnostics,
        scanDirs: snapshot.scanDirs,
        generatedAt,
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        diagnostics: [],
        scanDirs: [],
        generatedAt,
      };
    }
  }

  pickHighestSeverityFailingStartupCheck(
    checks: StartupCapabilityCheck[],
  ): StartupCapabilityCheck | null {
    const rank: Record<StartupCapabilityCheck['status'], number> = {
      unavailable: 4,
      degraded: 3,
      disabled: 2,
      ready: 1,
    };
    return checks
      .filter((check) => check.status !== 'ready' && check.status !== 'disabled')
      .sort((a, b) => rank[b.status] - rank[a.status] || Number(b.critical) - Number(a.critical))[0] ?? null;
  }
}

function toUpdatePlanSummary(plan: CliUpdatePlanSummary): CliUpdatePlanSummary {
  return {
    cli: plan.cli,
    displayName: plan.displayName,
    supported: plan.supported,
    command: plan.command,
    args: plan.args,
    displayCommand: plan.displayCommand,
    activePath: plan.activePath,
    currentVersion: plan.currentVersion,
    reason: plan.reason,
  };
}

export function getDoctorService(): DoctorService {
  return DoctorService.getInstance();
}

export function _resetDoctorServiceForTesting(): void {
  DoctorService._resetForTesting();
}
