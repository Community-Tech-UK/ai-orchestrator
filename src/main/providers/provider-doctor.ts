/**
 * Provider Doctor - Diagnostic probes and auto-repair for AI providers
 *
 * Inspired by CodePilot's provider-doctor.ts. Runs diagnostic probes for each
 * provider and generates actionable recommendations.
 */

import { execFile } from 'child_process';
import { getLogger } from '../logging/logger';
import type { HealthStatus } from '../core/system/health-checker';
import { buildCliSpawnOptions } from '../cli/cli-environment';
import { resolveCopilotCliLaunch } from '../cli/copilot-cli-launch';
import {
  buildCopilotAccountDoctorReport,
  summarizeCopilotAccountReport,
} from './copilot/copilot-account-doctor';
import {
  buildProviderAccountDoctorReport,
  summarizeProviderAccountReport,
} from './account-pool/provider-account-doctor';
import { checkClaudeCliAuthentication } from './claude-cli-auth';
import { checkCodexCliAuthentication } from './codex-cli-auth';
import { checkGeminiCliAuthentication } from './gemini-cli-auth';
import { CliDetectionService, type CliType } from '../cli/cli-detection';
import {
  independentInstalls,
  knownInstallVersions,
  type CliShadowReport,
} from '../cli/cli-install-mirrors';
import type { ProviderProbeErrorKind, RepairAction, RuntimeLogBundle } from '../../shared/types/provider-doctor.types';
import { getProviderRuntimeRegistry } from './provider-runtime-registry';
import { getProviderInstanceManager } from './provider-instance-manager';
import {
  buildRepairActions,
  classifyAuthKind,
  buildShadowRecommendation,
  INSTALL_COMMANDS,
} from './provider-doctor-repair';
import {
  buildClaudeProfileLoginCommand,
  lookupClaudeLoginEmail,
} from './provider-login-launcher';
import { buildRuntimeLogBundle } from './provider-doctor-log-bundle';
import { redactValue } from '../diagnostics/redaction';

const logger = getLogger('ProviderDoctor');

export type ProbeStatus = 'pass' | 'fail' | 'skip' | 'timeout';

/**
 * Provider-level health. Extends the generic {@link HealthStatus} with a
 * neutral `not-installed` state: a provider whose CLI simply isn't on PATH is
 * not a fault that needs resolving (the user may have no subscription for it,
 * or may just not use it), so it must never be reported as `unhealthy`.
 */
export type ProviderHealthStatus = HealthStatus | 'not-installed';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  message: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
  /** Present on failed probes; absent on pass/skip/timeout. */
  errorKind?: ProviderProbeErrorKind;
}

export interface ProbeDefinition {
  name: string;
  description: string;
  critical: boolean;
  appliesTo: string[];
  run: (provider: string) => Promise<ProbeResult>;
}

export interface DiagnosisResult {
  provider: string;
  probes: ProbeResult[];
  overall: ProviderHealthStatus;
  recommendations: string[];
  /** Structured repair actions derived from failed probe error kinds. */
  repairActions: RepairAction[];
  /**
   * Redacted runtime-log bundle: sanitized messages from failed probes,
   * stripped of secret patterns (API keys, tokens, passwords). Safe to
   * surface in the Doctor UI and include in operator-artifact bundles.
   */
  logBundle?: RuntimeLogBundle;
  timestamp: number;
}

export type { ProviderProbeErrorKind, RepairAction, RuntimeLogBundle };
export { buildRepairActions, classifyProbeFailure } from './provider-doctor-repair';
export { buildRuntimeLogBundle } from './provider-doctor-log-bundle';

const CRITICAL_PROBES = new Set(['cli_installed', 'sdk_available', 'plugin_provider_status']);

function isPluginProviderId(provider: string): boolean {
  return provider.startsWith('plugin:') && provider.length > 'plugin:'.length;
}

function redactProbeMessage(message: string): string {
  return redactValue(message, {});
}

/**
 * Trailing clause naming the copies a CLI's own installer keeps (see
 * `CliInstall.installerCopy`), so every shadow-check message accounts for
 * exactly the rows CLI Health lists.
 */
function installerCopyNote(count: number): string {
  if (count < 1) return '';
  return ` (+${count} installer-maintained ${count === 1 ? 'copy' : 'copies'}`
    + ' of the same install)';
}

// ---------------------------------------------------------------------------
// ProviderDoctor
// ---------------------------------------------------------------------------

export class ProviderDoctor {
  private static instance: ProviderDoctor | null = null;
  private probes: ProbeDefinition[] = [];
  private lastDiagnosis = new Map<string, DiagnosisResult>();

  private constructor() {
    this.registerDefaultProbes();
  }

  static getInstance(): ProviderDoctor {
    if (!this.instance) {
      this.instance = new ProviderDoctor();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private async execFileAsync(
    file: string,
    args: string[],
    timeout = 5000
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(file, args, {
        timeout,
        ...buildCliSpawnOptions(process.env),
      }, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }

        resolve({ stdout, stderr });
      });
    });
  }

  private registerDefaultProbes(): void {
    this.probes = [
      {
        name: 'cli_installed',
        description: 'Check if the CLI binary is installed and accessible',
        critical: true,
        appliesTo: ['claude-cli', 'codex-cli', 'gemini-cli', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode'],
        run: async (provider) => {
          if (provider === 'copilot') {
            const start = Date.now();
            const launch = resolveCopilotCliLaunch();
            const status = launch ? 'pass' as const : 'fail' as const;
            return {
              name: 'cli_installed',
              status,
              message: launch
                ? `${launch.displayCommand} found in PATH`
                : 'Neither `copilot` nor `gh copilot` was found in PATH',
              latencyMs: Date.now() - start,
              ...(status === 'fail' ? { errorKind: 'cli_not_found' as const } : {}),
            };
          }

          const cliMap: Record<string, string> = {
            'claude-cli': 'claude',
            'codex-cli': 'codex',
            'gemini-cli': 'gemini',
            'antigravity': 'agy',
            'cursor': 'cursor-agent',
            'grok': 'grok',
            'opencode': 'opencode',
          };
          const cmd = cliMap[provider];
          if (!cmd) {
            return {
              name: 'cli_installed',
              status: 'skip' as const,
              message: 'Not a CLI provider',
              latencyMs: 0,
            };
          }

          const start = Date.now();
          const pathResolver = process.platform === 'win32' ? 'where' : 'which';
          try {
            await this.execFileAsync(pathResolver, [cmd]);
            return {
              name: 'cli_installed',
              status: 'pass' as const,
              message: `${cmd} found in PATH`,
              latencyMs: Date.now() - start,
            };
          } catch {
            return {
              name: 'cli_installed',
              status: 'fail' as const,
              message: `${cmd} not found in PATH`,
              latencyMs: Date.now() - start,
              errorKind: 'cli_not_found' as const,
            };
          }
        },
      },
      {
        name: 'cli_shadow_check',
        description: 'Check for stale or shadow CLI installs at multiple PATH locations',
        critical: false,
        appliesTo: ['claude-cli', 'codex-cli', 'gemini-cli', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode'],
        run: async (provider) => {
          const cliTypeMap: Record<string, CliType | undefined> = {
            'claude-cli': 'claude',
            'codex-cli': 'codex',
            'gemini-cli': 'gemini',
            'antigravity': 'antigravity',
            'copilot': 'copilot',
            'cursor': 'cursor',
            'grok': 'grok',
            'opencode': 'opencode',
          };
          const cliType = cliTypeMap[provider];
          if (!cliType) {
            return {
              name: 'cli_shadow_check',
              status: 'skip' as const,
              message: 'Not a scannable CLI provider',
              latencyMs: 0,
            };
          }

          const start = Date.now();
          const { installs, shadow: report } = await CliDetectionService
            .getInstance()
            .inspectCliInstalls(cliType);
          const latencyMs = Date.now() - start;

          if (!report) {
            // Say what was actually found. Claiming "single active install"
            // while CLI Health listed several copies beside it (same version,
            // so nothing can silently win) read as a self-contradiction.
            // Installer-maintained duplicates (`installerCopy`, e.g. grok's
            // own postinstall copy in ~/.grok/bin) are named separately rather
            // than counted as rival installs.
            const separate = independentInstalls(installs);
            const mirrors = installs.length - separate.length;
            const versions = knownInstallVersions(separate);
            const unreadable = separate.length - separate.filter((i) => i.version).length;
            const summary = separate.length < 2
              ? 'Single active install (no shadows detected)'
              : versions.length === 0
                ? `${separate.length} copies on PATH, none reporting a readable version`
                : unreadable > 0
                  ? `${separate.length} copies on PATH, v${versions[0]} where readable ` +
                    '(no conflict among the versions that could be read)'
                  : `${separate.length} copies on PATH, all reporting ` +
                    `v${versions[0]} (no version conflict)`;
            return {
              name: 'cli_shadow_check',
              status: 'pass' as const,
              message: `${summary}${installerCopyNote(mirrors)}`,
              latencyMs,
            };
          }

          const versionList = report.installs
            .map((i) => `${i.path} (v${i.version ?? '?'})`)
            .join('\n  ');

          // A report is only built for separate copies whose versions were
          // read and disagree (`buildShadowReport`), so the kind is never the
          // vaguer 'cli_shadow_install' here — that one is left for a shadow
          // failure that arrives without a usable report.
          const errorKind: ProviderProbeErrorKind = 'cli_version_mismatch';

          return {
            name: 'cli_shadow_check',
            status: 'fail' as const,
            // The installer-copy clause belongs here too: without it the
            // message accounts for fewer copies than CLI Health lists beside
            // it, which is the contradiction this whole check exists to avoid.
            message: `Multiple ${cliType} installs with different versions`
              + `${installerCopyNote(installs.length - report.installs.length)}:`
              + `\n  ${versionList}`,
            latencyMs,
            metadata: { report: report as unknown as Record<string, unknown> },
            errorKind,
          };
        },
      },
      {
        name: 'authenticated',
        description: 'Check if the provider has valid credentials',
        critical: false,
        appliesTo: ['claude-cli', 'codex-cli', 'gemini-cli', 'anthropic-api', 'copilot'],
        run: async (provider) => {
          if (provider === 'claude-cli') {
            const start = Date.now();
            const authStatus = await checkClaudeCliAuthentication();
            const status = authStatus.authenticated ? 'pass' as const : 'fail' as const;
            return {
              name: 'authenticated',
              status,
              message: authStatus.message,
              latencyMs: Date.now() - start,
              metadata: authStatus.metadata,
              ...(status === 'fail'
                ? { errorKind: classifyAuthKind(authStatus.message) }
                : {}),
            };
          }

          if (provider === 'codex-cli') {
            const start = Date.now();
            const authStatus = await checkCodexCliAuthentication();
            const status = authStatus.authenticated ? 'pass' as const : 'fail' as const;
            return {
              name: 'authenticated',
              status,
              message: authStatus.message,
              latencyMs: Date.now() - start,
              metadata: authStatus.metadata,
              ...(status === 'fail'
                ? { errorKind: classifyAuthKind(authStatus.message) }
                : {}),
            };
          }

          if (provider === 'gemini-cli') {
            const start = Date.now();
            const authStatus = await checkGeminiCliAuthentication();
            const status = authStatus.authenticated ? 'pass' as const : 'fail' as const;
            return {
              name: 'authenticated',
              status,
              message: authStatus.message,
              latencyMs: Date.now() - start,
              metadata: authStatus.metadata,
              ...(status === 'fail'
                ? { errorKind: classifyAuthKind(authStatus.message) }
                : {}),
            };
          }

          if (provider === 'copilot') {
            // Aggregate presentation only (spec §14.1). Session admission uses
            // the RESOLVED PROFILE's status, not this — "some account is
            // signed in" is not permission to run a given workspace's request
            // through it.
            const start = Date.now();
            const report = await buildCopilotAccountDoctorReport();
            // `ProbeStatus` has no `warn`, and a partially-configured install
            // IS usable — the unhealthy accounts are named in the message and
            // the full per-profile report rides in `metadata` for the UI.
            // Only "no account is signed in at all" is a failure.
            const status = report.aggregate === 'auth-required'
              ? ('fail' as const)
              : ('pass' as const);
            return {
              name: 'authenticated',
              status,
              message: summarizeCopilotAccountReport(report),
              latencyMs: Date.now() - start,
              metadata: report as unknown as Record<string, unknown>,
              ...(status === 'fail' ? { errorKind: 'auth_missing' as const } : {}),
            };
          }

          if (provider === 'anthropic-api') {
            const hasKey = !!process.env['ANTHROPIC_API_KEY'];
            return {
              name: 'authenticated',
              status: hasKey ? 'pass' as const : 'fail' as const,
              message: hasKey ? 'ANTHROPIC_API_KEY is set' : 'ANTHROPIC_API_KEY not found in environment',
              latencyMs: 0,
              ...(hasKey ? {} : { errorKind: 'auth_missing' as const }),
            };
          }

          return {
            name: 'authenticated',
            status: 'skip' as const,
            message: 'No auth probe for this provider',
            latencyMs: 0,
          };
        },
      },
      {
        name: 'account_pool',
        description: 'Check Claude/Codex account-pool profiles (sign-in, identity, pool policy)',
        critical: false,
        appliesTo: ['claude-cli', 'codex-cli'],
        run: async (provider) => {
          const start = Date.now();
          let report: Awaited<ReturnType<typeof buildProviderAccountDoctorReport>>;
          try {
            report = await buildProviderAccountDoctorReport(provider === 'claude-cli' ? 'claude' : 'codex');
          } catch {
            return { name: 'account_pool', status: 'skip' as const, message: 'Account pools are not available in this context.', latencyMs: Date.now() - start };
          }
          if (!report.poolActive) {
            return { name: 'account_pool', status: 'skip' as const, message: summarizeProviderAccountReport(report), latencyMs: Date.now() - start };
          }
          const status = report.usableProfileIds.length === 0 ? ('fail' as const) : ('pass' as const);
          return {
            name: 'account_pool',
            status,
            message: summarizeProviderAccountReport(report),
            latencyMs: Date.now() - start,
            metadata: report as unknown as Record<string, unknown>,
            ...(status === 'fail' ? { errorKind: 'auth_missing' as const } : {}),
          };
        },
      },
      {
        name: 'reachable',
        description: 'Check if the provider API endpoint is reachable',
        critical: false,
        appliesTo: ['anthropic-api'],
        run: async () => {
          const start = Date.now();
          try {
            const response = await fetch('https://api.anthropic.com/', {
              method: 'HEAD',
              signal: AbortSignal.timeout(5000),
            });
            return {
              name: 'reachable',
              status: 'pass' as const,
              message: `API endpoint reachable (${response.status})`,
              latencyMs: Date.now() - start,
            };
          } catch {
            return {
              name: 'reachable',
              status: 'fail' as const,
              message: 'API endpoint unreachable',
              latencyMs: Date.now() - start,
              errorKind: 'endpoint_unreachable' as const,
            };
          }
        },
      },
    ];
  }

  getProbesForProvider(provider: string): ProbeDefinition[] {
    if (isPluginProviderId(provider)) {
      return [this.createPluginProviderStatusProbe()];
    }
    return this.probes.filter(p => p.appliesTo.includes(provider));
  }

  async diagnose(provider: string): Promise<DiagnosisResult> {
    if (isPluginProviderId(provider)) {
      return this.diagnosePluginProvider(provider);
    }

    const applicableProbes = this.getProbesForProvider(provider);
    const results: ProbeResult[] = [];

    for (const probe of applicableProbes) {
      try {
        const result = await probe.run(provider);
        results.push(result);
        if (result.status === 'fail' && probe.critical) {
          const probeIndex = applicableProbes.indexOf(probe);
          for (const remaining of applicableProbes.slice(probeIndex + 1)) {
            results.push({
              name: remaining.name,
              status: 'skip',
              message: `Skipped (${probe.name} failed)`,
              latencyMs: 0,
            });
          }
          break;
        }
      } catch (error) {
        results.push({
          name: probe.name,
          status: 'fail',
          message: error instanceof Error ? error.message : 'Probe threw',
          latencyMs: 0,
          errorKind: 'unknown',
        });
      }
    }

    return this.finalizeDiagnosis(provider, results);
  }

  aggregateProbeResults(probes: ProbeResult[]): ProviderHealthStatus {
    // A provider whose CLI simply isn't installed is not a failure that needs
    // resolving — the user may have no subscription for it, or may not use it
    // at all. Report it as a neutral "not installed" state rather than
    // "unhealthy", but only when the *missing CLI* is the sole problem (any
    // other failure, e.g. a shadow-install conflict, still warrants attention).
    const cliNotInstalled = probes.some(
      (p) => p.name === 'cli_installed' && p.status === 'fail' && p.errorKind === 'cli_not_found',
    );
    const hasOtherFailure = probes.some(
      (p) => p.status === 'fail' && p.name !== 'cli_installed',
    );
    if (cliNotInstalled && !hasOtherFailure) {
      return 'not-installed';
    }
    if (probes.some(p => p.status === 'fail' && CRITICAL_PROBES.has(p.name))) {
      return 'unhealthy';
    }
    if (probes.some(p => p.status === 'fail')) {
      return 'degraded';
    }
    return probes.every(p => p.status === 'pass' || p.status === 'skip') ? 'healthy' : 'unknown';
  }

  generateRecommendations(provider: string, probes: ProbeResult[]): string[] {
    const recs: string[] = [];
    for (const probe of probes) {
      if (probe.status !== 'fail') continue;
      switch (probe.name) {
        case 'cli_installed': {
          // One table, shared with the repair actions. Keeping a second copy
          // here drifted: grok ended up recommending the download page while
          // its repair action said npm, and copilot/cursor differed in wording.
          const installCmd = INSTALL_COMMANDS[provider] ?? 'check the provider docs';
          recs.push(
            `Optional: the ${provider} CLI is not installed. The orchestrator works fine without it — install it only if you want to use this provider: ${installCmd}`,
          );
          break;
        }
        case 'cli_shadow_check': {
          const report = probe.metadata?.['report'] as CliShadowReport | undefined;
          if (report && report.installs.length >= 2) {
            recs.push(buildShadowRecommendation(provider, report));
          } else {
            recs.push(`Shadow check failed: ${probe.message}`);
          }
          break;
        }
        case 'authenticated':
          if (provider === 'claude-cli') {
            const login = buildClaudeProfileLoginCommand(
              'legacy',
              process.platform,
              'shared-store',
              lookupClaudeLoginEmail('legacy'),
            );
            recs.push(
              `Authentication missing. Run \`${login.command}\` to sign in, then retry diagnostics. If the CLI still looks unhealthy, run \`claude doctor\` in a trusted terminal.`,
            );
          } else if (provider === 'codex-cli') {
            recs.push(
              'Authentication missing. Run `codex login` to sign in with ChatGPT or configure an API key, then retry diagnostics.'
            );
          } else if (provider === 'gemini-cli') {
            recs.push(
              'Authentication missing. Start `gemini` and choose an authentication method, or configure Gemini API / Vertex AI credentials, then retry diagnostics.'
            );
          } else {
            recs.push(
              'Authentication missing. Set the required environment variable or run the CLI login command.'
            );
          }
          break;
        case 'reachable':
          recs.push('API endpoint unreachable. Check network connectivity and proxy settings.');
          break;
        default:
          recs.push(`Probe "${probe.name}" failed: ${probe.message}`);
      }
    }
    return recs;
  }

  getLastDiagnosis(provider: string): DiagnosisResult | undefined {
    return this.lastDiagnosis.get(provider);
  }

  private async diagnosePluginProvider(provider: string): Promise<DiagnosisResult> {
    const statusProbe = await this.createPluginProviderStatusProbe().run(provider);
    const results: ProbeResult[] = [statusProbe];

    if (statusProbe.status === 'pass') {
      const authenticated = statusProbe.metadata?.['authenticated'] === true;
      results.push({
        name: 'authenticated',
        status: authenticated ? 'pass' : 'fail',
        message: authenticated
          ? 'Plugin provider reported authenticated'
          : 'Plugin provider reported unauthenticated',
        latencyMs: 0,
        ...(authenticated ? {} : { errorKind: 'auth_missing' as const }),
      });
    }

    return this.finalizeDiagnosis(provider, results);
  }

  private createPluginProviderStatusProbe(): ProbeDefinition {
    return {
      name: 'plugin_provider_status',
      description: 'Check if the worker-isolated plugin provider adapter is invokable',
      critical: true,
      appliesTo: ['plugin:*'],
      run: async (provider) => {
        const start = Date.now();
        try {
          const status = await getProviderInstanceManager().checkProviderStatus(provider, true);
          const latencyMs = Date.now() - start;
          if (status.available) {
            return {
              name: 'plugin_provider_status',
              status: 'pass' as const,
              message: 'Plugin provider adapter is available',
              latencyMs,
              metadata: {
                authenticated: status.authenticated,
                modelCount: status.models?.length ?? 0,
              },
            };
          }

          return {
            name: 'plugin_provider_status',
            status: 'fail' as const,
            message: redactProbeMessage(status.error ?? 'Plugin provider adapter is unavailable'),
            latencyMs,
            metadata: {
              authenticated: status.authenticated,
            },
            errorKind: 'unknown' as const,
          };
        } catch (error) {
          return {
            name: 'plugin_provider_status',
            status: 'fail' as const,
            message: redactProbeMessage(error instanceof Error ? error.message : String(error)),
            latencyMs: Date.now() - start,
            errorKind: 'unknown' as const,
          };
        }
      },
    };
  }

  private finalizeDiagnosis(provider: string, results: ProbeResult[]): DiagnosisResult {
    const diagnosis: DiagnosisResult = {
      provider,
      probes: results,
      overall: this.aggregateProbeResults(results),
      recommendations: this.generateRecommendations(provider, results),
      repairActions: [],
      timestamp: Date.now(),
    };
    // Populate repairActions after the base object is created so
    // buildRepairActions can read diagnosis.provider.
    diagnosis.repairActions = buildRepairActions(diagnosis);
    // Attach redacted runtime-log bundle from failed probes (B4).
    const logBundle = buildRuntimeLogBundle(results);
    if (logBundle) diagnosis.logBundle = logBundle;

    this.lastDiagnosis.set(provider, diagnosis);
    getProviderRuntimeRegistry().applyDiagnosis(diagnosis);
    logger.info('Provider diagnosis complete', { provider, overall: diagnosis.overall });
    return diagnosis;
  }
}

export function getProviderDoctor(): ProviderDoctor {
  return ProviderDoctor.getInstance();
}
