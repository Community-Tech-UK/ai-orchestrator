import { getLogger } from '../logging/logger';
import { getCliDetectionService } from '../cli/cli-detection';
import { getRemoteNodeConfig } from '../remote-node/remote-node-config';
import { getBrowserAutomationHealthService } from '../browser-automation/browser-automation-health';
import { getProviderDoctor } from '../providers/provider-doctor';
import { getRLMDatabase } from '../persistence/rlm-database';
import type {
  StartupCapabilityCheck,
  StartupCapabilityReport,
  StartupCapabilityOverallStatus,
} from '../../shared/types/startup-capability.types';

const logger = getLogger('CapabilityProbe');

function summarizeStatus(checks: StartupCapabilityCheck[]): StartupCapabilityOverallStatus {
  if (checks.some((check) => check.critical && check.status === 'unavailable')) {
    return 'failed';
  }

  if (checks.some((check) => check.status === 'degraded' || check.status === 'unavailable')) {
    return 'degraded';
  }

  return 'ready';
}

export class CapabilityProbe {
  private static instance: CapabilityProbe | null = null;
  private lastReport: StartupCapabilityReport | null = null;

  static getInstance(): CapabilityProbe {
    if (!this.instance) {
      this.instance = new CapabilityProbe();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async run(): Promise<StartupCapabilityReport> {
    const generatedAt = Date.now();
    const checks: StartupCapabilityCheck[] = [];

    checks.push(await this.probeNativeDatabase());
    checks.push(...await this.probeProviders());
    checks.push(await this.probeRemoteNodes());
    checks.push(await this.probeBrowserAutomation());

    const report: StartupCapabilityReport = {
      status: summarizeStatus(checks),
      generatedAt,
      checks,
    };

    this.lastReport = report;
    logger.info('Startup capability probe completed', {
      status: report.status,
      checks: report.checks.map((check) => ({
        id: check.id,
        status: check.status,
      })),
    });
    return report;
  }

  getLastReport(): StartupCapabilityReport | null {
    return this.lastReport;
  }

  private async probeNativeDatabase(): Promise<StartupCapabilityCheck> {
    try {
      const db = getRLMDatabase().getRawDb();
      db.prepare('SELECT 1').get();
      return {
        id: 'native.sqlite',
        label: 'SQLite runtime',
        category: 'native',
        status: 'ready',
        critical: true,
        summary: 'The native SQLite runtime is available.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: 'native.sqlite',
        label: 'SQLite runtime',
        category: 'native',
        status: 'unavailable',
        critical: true,
        summary: 'The native SQLite runtime failed to initialize.',
        details: { error: message },
      };
    }
  }

  private async probeProviders(): Promise<StartupCapabilityCheck[]> {
    const detection = await getCliDetectionService().detectAll();
    const available = new Set(detection.available.map((cli) => cli.name));
    const doctor = getProviderDoctor();

    const providerSpecs = [
      { id: 'claude', doctorKey: 'claude-cli', label: 'Claude Code CLI' },
      { id: 'codex', doctorKey: 'codex-cli', label: 'Codex CLI' },
      { id: 'gemini', doctorKey: 'gemini-cli', label: 'Gemini CLI' },
      { id: 'copilot', doctorKey: 'copilot', label: 'Copilot CLI' },
      { id: 'cursor', doctorKey: 'cursor', label: 'Cursor CLI' },
    ] as const;

    const diagnoses = await Promise.all(providerSpecs.map(async (provider) => {
      try {
        return {
          provider,
          diagnosis: await doctor.diagnose(provider.doctorKey),
        };
      } catch (error) {
        return {
          provider,
          diagnosis: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));

    const checks: StartupCapabilityCheck[] = diagnoses.map(({ provider, diagnosis, error }) => {
      const installed = available.has(provider.id);
      if (!installed) {
        return {
          id: `provider.${provider.id}`,
          label: provider.label,
          category: 'provider',
          status: 'degraded',
          critical: false,
          summary: `${provider.label} is not available on PATH.`,
          details: diagnosis ? { recommendations: diagnosis.recommendations } : error ? { error } : undefined,
        };
      }

      if (!diagnosis) {
        return {
          id: `provider.${provider.id}`,
          label: provider.label,
          category: 'provider',
          status: 'degraded',
          critical: false,
          summary: `${provider.label} is installed, but diagnostics failed.`,
          details: error ? { error } : undefined,
        };
      }

      return {
        id: `provider.${provider.id}`,
        label: provider.label,
        category: 'provider',
        status: diagnosis.overall === 'healthy' ? 'ready' : 'degraded',
        critical: false,
        summary: diagnosis.probes
          .find((probe) => probe.status === 'fail')?.message
          ?? `${provider.label} is available.`,
        details: {
          overall: diagnosis.overall,
          recommendations: diagnosis.recommendations,
        },
      };
    });

    const anyReady = checks.some((check) => check.status === 'ready');
    checks.unshift({
      id: 'provider.any',
      label: 'Provider availability',
      category: 'provider',
      status: anyReady ? 'ready' : 'unavailable',
      critical: true,
      summary: anyReady
        ? 'At least one supported provider CLI is available.'
        : 'No supported provider CLI is currently available.',
      details: {
        available: [...available],
      },
    });

    return checks;
  }

  private async probeRemoteNodes(): Promise<StartupCapabilityCheck> {
    const config = getRemoteNodeConfig();
    if (!config.enabled) {
      return {
        id: 'subsystem.remote-nodes',
        label: 'Remote node server',
        category: 'subsystem',
        status: 'disabled',
        critical: false,
        summary: 'Remote nodes are disabled.',
      };
    }

    return {
      id: 'subsystem.remote-nodes',
      label: 'Remote node server',
      category: 'subsystem',
      status: 'ready',
      critical: false,
      summary: `Remote nodes are enabled on ${config.serverHost}:${config.serverPort}.`,
      details: {
        namespace: config.namespace,
        requireTls: Boolean(config.tlsCertPath && config.tlsKeyPath),
      },
    };
  }

  private async probeBrowserAutomation(): Promise<StartupCapabilityCheck> {
    try {
      const health = await getBrowserAutomationHealthService().diagnose();
      return {
        id: 'subsystem.browser-automation',
        label: 'Browser automation',
        category: 'subsystem',
        status:
          health.status === 'ready'
            ? 'ready'
            : health.status === 'partial'
              ? 'degraded'
              : 'unavailable',
        critical: false,
        summary:
          health.warnings[0]
          ?? (health.status === 'ready'
            ? 'Browser automation tooling is ready.'
            : 'Browser automation is not configured.'),
        details: {
          runtimeAvailable: health.runtimeAvailable,
          inAppConfigured: health.inAppConfigured,
          inAppConnected: health.inAppConnected,
          browserToolNames: health.browserToolNames,
          suggestions: health.suggestions,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: 'subsystem.browser-automation',
        label: 'Browser automation',
        category: 'subsystem',
        status: 'degraded',
        critical: false,
        summary: 'Browser automation diagnostics failed.',
        details: { error: message },
      };
    }
  }
}

let capabilityProbe: CapabilityProbe | null = null;

export function getCapabilityProbe(): CapabilityProbe {
  if (!capabilityProbe) {
    capabilityProbe = CapabilityProbe.getInstance();
  }
  return capabilityProbe;
}
